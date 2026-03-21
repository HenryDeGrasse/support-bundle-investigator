import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as tar from 'tar';
import { extractBundle, profileBundle } from '../../../src/ingestion/index.js';
import { analyzeBundlePipeline, cleanupPipelineResult } from '../../../src/pipeline/analyze.js';

const cleanupPaths = new Set<string>();

function makeTempPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sbi-${name}-`));
  cleanupPaths.add(dir);
  return dir;
}

async function writeBundleFiles(
  rootDir: string,
  files: Record<string, string | Buffer>,
): Promise<void> {
  await Promise.all(
    Object.entries(files).map(async ([relativePath, content]) => {
      const absolutePath = path.join(rootDir, relativePath);
      await fsp.mkdir(path.dirname(absolutePath), { recursive: true });
      await fsp.writeFile(absolutePath, content);
    }),
  );
}

async function createTarGzArchive(
  archivePath: string,
  files: Record<string, string | Buffer>,
): Promise<string> {
  const sourceDir = makeTempPath('robustness-src');
  await writeBundleFiles(sourceDir, files);

  await tar.c(
    {
      gzip: true,
      file: archivePath,
      cwd: sourceDir,
    },
    Object.keys(files),
  );

  return archivePath;
}

async function createBundle(
  files: Record<string, string | Buffer>,
  filename = 'bundle.tar.gz',
): Promise<string> {
  const tempDir = makeTempPath('robustness-bundle');
  const archivePath = path.join(tempDir, filename);
  return createTarGzArchive(archivePath, files);
}

async function createEmptyArchive(filename = 'bundle.tar.gz'): Promise<string> {
  const tempDir = makeTempPath('robustness-empty');
  const sourceDir = makeTempPath('robustness-empty-src');
  const archivePath = path.join(tempDir, filename);
  const emptyDirName = 'empty-root';

  await fsp.mkdir(path.join(sourceDir, emptyDirName), { recursive: true });
  await tar.c(
    {
      gzip: true,
      file: archivePath,
      cwd: sourceDir,
    },
    [emptyDirName],
  );

  return archivePath;
}

async function captureError(task: Promise<unknown>): Promise<Error> {
  try {
    await task;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message.trim().length).toBeGreaterThan(0);
    return error as Error;
  }

  throw new Error('Expected task to reject');
}

async function withPipelineResult<T>(
  bundlePath: string,
  assertion: Awaited<ReturnType<typeof analyzeBundlePipeline>> extends infer R
    ? (result: R) => Promise<T> | T
    : never,
): Promise<T> {
  const result = await analyzeBundlePipeline(bundlePath, { noAi: true });
  try {
    return await assertion(result);
  } finally {
    await cleanupPipelineResult(result);
  }
}

function makeAnalyzerJson(
  severity: 'fail' | 'warn' | 'pass' = 'fail',
  primary = 'Database connectivity check failed',
  detail = 'The application could not resolve the database hostname.',
): string {
  return JSON.stringify([
    {
      name: 'database-connectivity',
      insight: {
        primary,
        detail,
        severity,
      },
    },
  ]);
}

const VALID_SERVICE_YAML = `apiVersion: v1
kind: Service
metadata:
  name: api
  namespace: default
spec:
  selector:
    app: api
  ports:
    - port: 80
      targetPort: 8080
`;

const MALFORMED_POD_YAML = `apiVersion: v1
kind: Pod
metadata:
  name: broken-pod
  namespace: default
spec:
  containers:
    - name: app
      image: nginx
      env: [unterminated
`;

afterEach(() => {
  for (const target of cleanupPaths) {
    fs.rmSync(target, { recursive: true, force: true });
  }
  cleanupPaths.clear();
});

describe('Robustness integration coverage', () => {
  it('corrupt archive: extractBundle throws a clear error for non-gzip bytes', async () => {
    const tempDir = makeTempPath('robustness-corrupt');
    const bundlePath = path.join(tempDir, 'corrupt.tar.gz');
    await fsp.writeFile(bundlePath, Buffer.from('this is not a valid gzip archive'));

    const error = await captureError(extractBundle(bundlePath));
    expect(error.message).toMatch(/gzip|header|archive|invalid|tar/i);
  });

  it('truncated archive: extraction fails gracefully for a cut-off tar.gz stream', async () => {
    const tempDir = makeTempPath('robustness-truncated');
    const validArchivePath = path.join(tempDir, 'valid.tar.gz');
    const truncatedArchivePath = path.join(tempDir, 'truncated.tar.gz');

    await createTarGzArchive(validArchivePath, {
      'analysis.json': makeAnalyzerJson(),
      'cluster-resources/services/default/api.yaml': VALID_SERVICE_YAML,
    });

    const fullArchive = await fsp.readFile(validArchivePath);
    await fsp.writeFile(truncatedArchivePath, fullArchive.subarray(0, Math.max(32, Math.floor(fullArchive.length / 3))));

    const error = await captureError(extractBundle(truncatedArchivePath));
    expect(error.message).toMatch(/unexpected end|unexpected eof|zlib|gzip|invalid/i);
  });

  it('empty archive: pipeline completes with zero findings and no crash', async () => {
    const bundlePath = await createEmptyArchive('empty.tar.gz');

    await withPipelineResult(bundlePath, (result) => {
      expect(result.profile.manifest.files).toHaveLength(0);
      expect(result.profile.analyzerCount).toBe(0);
      expect(result.profile.resourceCount).toBe(0);
      expect(result.profile.eventCount).toBe(0);
      expect(result.profile.logFileCount).toBe(0);
      expect(result.findings).toEqual([]);
    });
  });

  it('missing expected files: pipeline completes with analyzer-only partial results', async () => {
    const bundlePath = await createBundle({
      'analysis.json': makeAnalyzerJson('fail', 'Missing secret', 'Deployment references a missing secret.'),
    }, 'partial.tar.gz');

    await withPipelineResult(bundlePath, (result) => {
      expect(result.analyzerResults).toHaveLength(1);
      expect(result.profile.analyzerCount).toBe(1);
      expect(result.resources).toEqual([]);
      expect(result.events).toEqual([]);
      expect(result.logs).toEqual([]);
      expect(result.profile.resourceCount).toBe(0);
      expect(result.profile.eventCount).toBe(0);
      expect(result.profile.logFileCount).toBe(0);
      expect(Array.isArray(result.findings)).toBe(true);
    });
  });

  it('malformed YAML/JSON: parser skips a bad resource file and continues', async () => {
    const bundlePath = await createBundle({
      'analysis.json': makeAnalyzerJson(),
      'cluster-resources/pods/default/broken-pod.yaml': MALFORMED_POD_YAML,
      'cluster-resources/services/default/api.yaml': VALID_SERVICE_YAML,
    }, 'malformed-resource.tar.gz');

    await withPipelineResult(bundlePath, (result) => {
      expect(result.profile.resourceCount).toBe(2);
      expect(result.resources).toHaveLength(1);
      expect(result.resources[0]?.kind).toBe('Service');
      expect(result.events).toEqual([]);
      expect(result.logs).toEqual([]);
    });
  });

  it('binary file in bundle: profiler classifies it as unknown and parsers skip it', async () => {
    const bundlePath = await createBundle({
      'analysis.json': makeAnalyzerJson(),
      'attachments/screenshot.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]),
    }, 'binary-file.tar.gz');
    const extractDir = makeTempPath('robustness-extract');
    const manifest = await extractBundle(bundlePath, { outputDir: extractDir });
    const profile = await profileBundle(manifest);

    const pngEntry = profile.manifest.files.find((file) => file.relativePath === 'attachments/screenshot.png');
    expect(pngEntry?.category).toBe('unknown');
    expect(profile.artifactsByCategory.unknown).toBe(1);

    await withPipelineResult(bundlePath, (result) => {
      expect(result.analyzerResults).toHaveLength(1);
      expect(result.resources).toEqual([]);
      expect(result.events).toEqual([]);
      expect(result.logs).toEqual([]);
    });
  });
});
