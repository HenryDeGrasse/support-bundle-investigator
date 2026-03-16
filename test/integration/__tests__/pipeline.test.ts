import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { analyzeBundlePipeline, cleanupPipelineResult } from '../../../src/pipeline/analyze.js';
import { writePipelineResult, writeTraceFile } from '../../../src/cli/output.js';
import { createTestBundle, getFixturePath } from '../../helpers/create-test-bundle.js';

// ---------------------------------------------------------------------------
// Setup — build .tar.gz archives for each scenario once
// ---------------------------------------------------------------------------

let tmpDir: string;
let wrongDbBundlePath: string;
let missingSecretBundlePath: string;
let badImageTagBundlePath: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbi-integration-'));

  wrongDbBundlePath = await createTestBundle(
    getFixturePath('wrong-db-endpoint'),
    path.join(tmpDir, 'wrong-db-endpoint.tar.gz'),
  );

  missingSecretBundlePath = await createTestBundle(
    getFixturePath('missing-secret-crashloop'),
    path.join(tmpDir, 'missing-secret-crashloop.tar.gz'),
  );

  badImageTagBundlePath = await createTestBundle(
    getFixturePath('bad-image-tag'),
    path.join(tmpDir, 'bad-image-tag.tar.gz'),
  );
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helper to run pipeline and auto-cleanup
// ---------------------------------------------------------------------------

async function runPipeline(bundlePath: string, verbose = false) {
  const result = await analyzeBundlePipeline(bundlePath, { verbose });
  afterAll(() => cleanupPipelineResult(result));
  return result;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Pipeline Integration', () => {
  describe('wrong-db-endpoint scenario', () => {
    it('produces a profile with expected artifact counts', async () => {
      const result = await runPipeline(wrongDbBundlePath);

      expect(result.profile.analyzerCount).toBeGreaterThan(0);
      expect(result.profile.resourceCount).toBeGreaterThan(0);
      expect(result.profile.eventCount).toBeGreaterThan(0);
      expect(result.profile.logFileCount).toBeGreaterThan(0);
    });

    it('includes the default namespace', async () => {
      const result = await runPipeline(wrongDbBundlePath);
      expect(result.profile.namespaces).toContain('default');
    });

    it('parses analyzer results with at least one warn entry', async () => {
      const result = await runPipeline(wrongDbBundlePath);
      const warns = result.analyzerResults.filter((r) => r.isWarn);
      expect(warns.length).toBeGreaterThan(0);
    });

    it('parses K8s resources including at least one Pod', async () => {
      const result = await runPipeline(wrongDbBundlePath);
      const pods = result.resources.filter((r) => r.kind === 'Pod');
      expect(pods.length).toBeGreaterThan(0);
    });

    it('parses events with at least one Warning', async () => {
      const result = await runPipeline(wrongDbBundlePath);
      const warnings = result.events.filter((e) => e.type === 'Warning');
      expect(warnings.length).toBeGreaterThan(0);
    });

    it('parses log files', async () => {
      const result = await runPipeline(wrongDbBundlePath);
      expect(result.logs.length).toBeGreaterThan(0);
    });
  });

  describe('missing-secret-crashloop scenario', () => {
    it('identifies CrashLoopBackOff pod in resources', async () => {
      const result = await runPipeline(missingSecretBundlePath);
      const pods = result.resources.filter((r) => r.kind === 'Pod');
      const crashLoopPod = pods.find((p) =>
        JSON.stringify(p.status).includes('CrashLoopBackOff'),
      );
      expect(crashLoopPod).toBeDefined();
    });

    it('produces analyzer error results for missing secret', async () => {
      const result = await runPipeline(missingSecretBundlePath);
      const errors = result.analyzerResults.filter((r) => r.isFail);
      expect(errors.length).toBeGreaterThan(0);
    });

    it('includes FailedMount or BackOff events', async () => {
      const result = await runPipeline(missingSecretBundlePath);
      const reasons = result.events.map((e) => e.reason);
      const hasFailedMount = reasons.includes('FailedMount');
      const hasBackOff = reasons.includes('BackOff');
      expect(hasFailedMount || hasBackOff).toBe(true);
    });
  });

  describe('bad-image-tag scenario', () => {
    it('identifies ImagePullBackOff pod in resources', async () => {
      const result = await runPipeline(badImageTagBundlePath);
      const pods = result.resources.filter((r) => r.kind === 'Pod');
      const imagePullPod = pods.find((p) =>
        JSON.stringify(p.status).includes('ImagePullBackOff'),
      );
      expect(imagePullPod).toBeDefined();
    });

    it('produces analyzer error results for bad image', async () => {
      const result = await runPipeline(badImageTagBundlePath);
      const errors = result.analyzerResults.filter((r) => r.isFail);
      expect(errors.length).toBeGreaterThan(0);
    });

    it('includes ErrImagePull events', async () => {
      const result = await runPipeline(badImageTagBundlePath);
      const reasons = result.events.map((e) => e.reason);
      expect(reasons).toContain('ErrImagePull');
    });
  });

  describe('investigation trace', () => {
    it('pipeline produces investigation trace JSON', async () => {
      const result = await runPipeline(wrongDbBundlePath);
      const { trace } = result;

      expect(trace).toBeDefined();
      expect(trace.bundlePath).toBeTruthy();
      expect(trace.startedAt).toBeTruthy();
      expect(trace.completedAt).toBeTruthy();
      expect(Array.isArray(trace.steps)).toBe(true);
      expect(trace.steps.length).toBeGreaterThan(0);
    });

    it('trace contains all expected pipeline steps', async () => {
      const result = await runPipeline(wrongDbBundlePath);
      const stepNames = result.trace.steps.map((s) => s.name);

      expect(stepNames).toContain('extract');
      expect(stepNames).toContain('profile');
      expect(stepNames).toContain('parse-analyzers');
      expect(stepNames).toContain('parse-resources');
      expect(stepNames).toContain('parse-events');
      expect(stepNames).toContain('parse-logs');
      expect(stepNames).toContain('build-graph');
    });

    it('trace steps record artifacts processed', async () => {
      const result = await runPipeline(wrongDbBundlePath);
      for (const step of result.trace.steps) {
        expect(step.startedAt).toBeTruthy();
        expect(step.completedAt).toBeTruthy();
        expect(typeof step.artifactsProcessed).toBe('number');
      }
    });
  });

  describe('investigation graph', () => {
    it('graph contains nodes for all parsed artifacts', async () => {
      const result = await runPipeline(wrongDbBundlePath);
      const { graph, analyzerResults, resources, events, logs } = result;

      expect(graph.nodes.size).toBeGreaterThan(0);
      const expectedNodeCount =
        analyzerResults.length + resources.length + events.length + logs.length;
      expect(graph.nodes.size).toBe(expectedNodeCount);
    });

    it('graph nodes have valid types', async () => {
      const result = await runPipeline(wrongDbBundlePath);
      const validTypes = new Set(['finding', 'evidence', 'artifact', 'hypothesis', 'symptom']);
      for (const node of result.graph.nodes.values()) {
        expect(validTypes.has(node.type)).toBe(true);
      }
    });
  });

  describe('error handling', () => {
    it('pipeline handles non-existent bundle path gracefully', async () => {
      const fakePath = path.join(tmpDir, 'does-not-exist.tar.gz');
      await expect(analyzeBundlePipeline(fakePath)).rejects.toThrow();
    });
  });

  describe('output directory handling', () => {
    it('preserves output artifacts when outputDir is provided', async () => {
      const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbi-output-'));

      try {
        const result = await analyzeBundlePipeline(wrongDbBundlePath, {
          outputDir,
          format: 'json',
          trace: true,
        });

        const extractedPath = result.profile.manifest.extractedPath;

        expect(path.resolve(extractedPath)).not.toBe(path.resolve(outputDir));

        await writePipelineResult(result, {
          format: 'json',
          outputDir,
        });
        await writeTraceFile(result.trace, outputDir);
        await cleanupPipelineResult(result);

        expect(fs.existsSync(extractedPath)).toBe(false);
        expect(fs.existsSync(path.join(outputDir, 'result.json'))).toBe(true);
        expect(fs.existsSync(path.join(outputDir, 'trace.json'))).toBe(true);
      } finally {
        fs.rmSync(outputDir, { recursive: true, force: true });
      }
    });
  });
});
