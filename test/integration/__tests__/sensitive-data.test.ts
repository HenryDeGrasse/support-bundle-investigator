import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as tar from 'tar';
import type { Finding } from '../../../src/types/index.js';
import type { IndexedChunk } from '../../../src/ai/chunk-indexer.js';
import type { InvestigationSeed } from '../../../src/investigators/types.js';
import { analyzeBundlePipeline, cleanupPipelineResult } from '../../../src/pipeline/analyze.js';
import { buildInvestigationPrompt } from '../../../src/ai/prompts.js';
import {
  buildReport,
  generateHtmlReport,
  generateJsonReport,
  generateMarkdownReport,
} from '../../../src/reporters/index.js';

const SECRET_CANARY = 'SUPER_SECRET_TOKEN_12345';
const PASSWORD_CANARY = 'hunter2';
const API_KEY_CANARY = 'APIKEY_CANARY_98765';
const ALL_CANARIES = [SECRET_CANARY, PASSWORD_CANARY, API_KEY_CANARY];

const cleanupPaths = new Set<string>();

function makeTempPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sbi-sensitive-${name}-`));
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

async function createBundle(
  files: Record<string, string | Buffer>,
  filename = 'sensitive-bundle.tar.gz',
): Promise<string> {
  const sourceDir = makeTempPath('src');
  const bundleDir = makeTempPath('bundle');
  const bundlePath = path.join(bundleDir, filename);

  await writeBundleFiles(sourceDir, files);
  await tar.c(
    {
      gzip: true,
      file: bundlePath,
      cwd: sourceDir,
    },
    Object.keys(files),
  );

  return bundlePath;
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

function assertNoCanaries(text: string): void {
  for (const canary of ALL_CANARIES) {
    expect(text).not.toContain(canary);
  }
}

function collectFindingText(findings: Finding[]): string {
  return findings
    .flatMap((finding) => [
      finding.title,
      finding.reasoningSummary,
      finding.recommendedAction,
      ...finding.contradictionsChecked,
      ...finding.missingEvidence,
      ...finding.evidence.map((evidence) => evidence.note),
    ])
    .join('\n');
}

function sensitiveBundleFiles(): Record<string, string> {
  return {
    'analysis.json': JSON.stringify([
      {
        name: 'application-connectivity',
        insight: {
          primary: 'Application cannot reach dependency',
          detail: 'The application reports repeated connection failures.',
          severity: 'fail',
        },
      },
    ]),
    'cluster-resources/pods/default/app-pod.yaml': `apiVersion: v1
kind: Pod
metadata:
  name: app-pod
  namespace: default
spec:
  containers:
    - name: app
      image: ghcr.io/example/app:v1
      env:
        - name: APP_TOKEN
          valueFrom:
            secretKeyRef:
              name: app-secret
              key: token
        - name: API_KEY
          valueFrom:
            configMapKeyRef:
              name: app-config
              key: api-key
`,
    'cluster-resources/secrets/default/app-secret.yaml': `apiVersion: v1
kind: Secret
metadata:
  name: app-secret
  namespace: default
type: Opaque
stringData:
  token: ${SECRET_CANARY}
`,
    'cluster-resources/configmaps/default/app-config.yaml': `apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config
  namespace: default
data:
  api-key: ${API_KEY_CANARY}
  endpoint: https://api.default.svc.cluster.local
`,
    'cluster-resources/pods/logs/default/app-pod/app.log': `2026-03-21T10:00:00Z ERROR Connecting with password=${PASSWORD_CANARY}: connection refused\n`,
  };
}

function makeSensitiveChunk(): IndexedChunk {
  return {
    id: 'chunk:sensitive:0',
    artifactId: 'cluster-resources/configmaps/default/app-config.yaml',
    content: `api-key: ${SECRET_CANARY}\npassword=${PASSWORD_CANARY}`,
    startLine: 1,
    endLine: 2,
    summary: `ConfigMap includes api-key: ${API_KEY_CANARY}`,
    identifiers: ['app-config'],
    artifactCategory: 'kubernetes-resource',
  };
}

function makeSensitiveSeed(): InvestigationSeed {
  return {
    id: 'seed:test:sensitive',
    hypothesis: `Investigate failures related to api-key: ${API_KEY_CANARY}`,
    source: 'test:sensitive',
    category: 'configuration',
    priority: 80,
  };
}

afterEach(() => {
  for (const target of cleanupPaths) {
    fs.rmSync(target, { recursive: true, force: true });
  }
  cleanupPaths.clear();
});

describe('Sensitive data leakage protection', () => {
  it('does not leak secret canary values from secret-backed pod env references into findings', async () => {
    const bundlePath = await createBundle(sensitiveBundleFiles(), 'secret-env.tar.gz');

    await withPipelineResult(bundlePath, (result) => {
      assertNoCanaries(collectFindingText(result.findings));
    });
  });

  it('does not leak passwords from logs into findings', async () => {
    const bundlePath = await createBundle(sensitiveBundleFiles(), 'password-log.tar.gz');

    await withPipelineResult(bundlePath, (result) => {
      expect(result.findings.length).toBeGreaterThan(0);
      assertNoCanaries(collectFindingText(result.findings));
    });
  });

  it('does not leak API key values from ConfigMaps into findings', async () => {
    const bundlePath = await createBundle(sensitiveBundleFiles(), 'configmap-api-key.tar.gz');

    await withPipelineResult(bundlePath, (result) => {
      assertNoCanaries(collectFindingText(result.findings));
    });
  });

  it('redacts sensitive values from investigation prompts while preserving grounding structure', () => {
    const { user } = buildInvestigationPrompt(makeSensitiveSeed(), [makeSensitiveChunk()]);

    assertNoCanaries(user);
    expect(user).toContain('cluster-resources/configmaps/default/app-config.yaml');
    expect(user).toContain('[REDACTED]');
    expect(user).toContain('Only cite paths');
  });

  it('does not leak canary values into markdown, html, or json reports', async () => {
    const bundlePath = await createBundle(sensitiveBundleFiles(), 'sensitive-reports.tar.gz');

    await withPipelineResult(bundlePath, (result) => {
      const report = buildReport(result);
      const markdown = generateMarkdownReport(report);
      const html = generateHtmlReport(report);
      const json = generateJsonReport(report);

      assertNoCanaries(markdown);
      assertNoCanaries(html);
      assertNoCanaries(json);
    });
  });
});
