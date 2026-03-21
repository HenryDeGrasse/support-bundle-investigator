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
      expect(stepNames).toContain('investigate');
    });

    it('trace steps record artifacts processed', async () => {
      const result = await runPipeline(wrongDbBundlePath);
      for (const step of result.trace.steps) {
        expect(step.startedAt).toBeTruthy();
        expect(step.completedAt).toBeTruthy();
        expect(typeof step.artifactsProcessed).toBe('number');
      }
    });

    it('trace includes aiSummary with backend and aggregate call counters', async () => {
      const result = await runPipeline(wrongDbBundlePath);

      expect(result.trace.aiSummary).toBeDefined();
      expect(result.trace.aiSummary).toMatchObject({
        model: expect.any(String),
        backend: expect.stringMatching(/^(cloud|local|off)$/),
        totalCalls: expect.any(Number),
        successfulCalls: expect.any(Number),
        failedCalls: expect.any(Number),
        totalLatencyMs: expect.any(Number),
        avgLatencyMs: expect.any(Number),
      });
    });
  });

  describe('investigation graph', () => {
    it('graph contains nodes for all parsed artifacts plus investigation findings', async () => {
      const result = await runPipeline(wrongDbBundlePath);
      const { graph, analyzerResults, resources, events, logs, findings } = result;

      expect(graph.nodes.size).toBeGreaterThan(0);
      // Base artifact nodes (analyzer, resource, event, log) + finding nodes must exist.
      const minimumExpectedNodeCount =
        analyzerResults.length + resources.length + events.length + logs.length + findings.length;
      expect(graph.nodes.size).toBeGreaterThanOrEqual(minimumExpectedNodeCount);
    });

    it('graph nodes have valid types', async () => {
      const result = await runPipeline(wrongDbBundlePath);
      const validTypes = new Set(['finding', 'evidence', 'artifact', 'hypothesis', 'symptom']);
      for (const node of result.graph.nodes.values()) {
        expect(validTypes.has(node.type)).toBe(true);
      }
    });

    it('all graph edges reference nodes present in the graph', async () => {
      const result = await runPipeline(wrongDbBundlePath);

      for (const edge of result.graph.edges) {
        expect(result.graph.getNode(edge.source)).toBeDefined();
        expect(result.graph.getNode(edge.target)).toBeDefined();
      }
    });
  });

  describe('findings quality', () => {
    it('pipeline result exposes a findings array', async () => {
      const result = await runPipeline(wrongDbBundlePath);
      expect(Array.isArray(result.findings)).toBe(true);
    });

    it('wrong-db pipeline produces at least one finding', async () => {
      const result = await runPipeline(wrongDbBundlePath);
      expect(result.findings.length).toBeGreaterThan(0);
    });

    it('missing-secret pipeline produces at least one finding', async () => {
      const result = await runPipeline(missingSecretBundlePath);
      expect(result.findings.length).toBeGreaterThan(0);
    });

    it('bad-image-tag pipeline produces at least one finding', async () => {
      const result = await runPipeline(badImageTagBundlePath);
      expect(result.findings.length).toBeGreaterThan(0);
    });

    it('every finding has at least one evidence entry', async () => {
      const result = await runPipeline(wrongDbBundlePath);
      for (const finding of result.findings) {
        expect(finding.evidence.length).toBeGreaterThan(0);
      }
    });

    it('every finding has at least one contradictionsChecked entry', async () => {
      const result = await runPipeline(wrongDbBundlePath);
      for (const finding of result.findings) {
        expect(finding.contradictionsChecked.length).toBeGreaterThan(0);
      }
    });

    it('every finding has a non-empty recommendedAction', async () => {
      const result = await runPipeline(wrongDbBundlePath);
      for (const finding of result.findings) {
        expect(finding.recommendedAction.trim().length).toBeGreaterThan(0);
      }
    });

    it('top finding confidence is >= 0.7 for all three scenarios', async () => {
      const wrongDb = await runPipeline(wrongDbBundlePath);
      const missingSecret = await runPipeline(missingSecretBundlePath);
      const badImage = await runPipeline(badImageTagBundlePath);

      expect(wrongDb.findings[0]!.confidence).toBeGreaterThanOrEqual(0.7);
      expect(missingSecret.findings[0]!.confidence).toBeGreaterThanOrEqual(0.7);
      expect(badImage.findings[0]!.confidence).toBeGreaterThanOrEqual(0.7);
    });

    it('findings are sorted by severity — critical/high appear before low/info', async () => {
      const result = await runPipeline(missingSecretBundlePath);
      const severityOrder: Record<string, number> = {
        critical: 4, high: 3, medium: 2, low: 1, info: 0,
      };
      for (let i = 0; i < result.findings.length - 1; i++) {
        const current = severityOrder[result.findings[i]!.severity] ?? 0;
        const next = severityOrder[result.findings[i + 1]!.severity] ?? 0;
        // Confidence descending within same severity
        if (current === next) {
          expect(result.findings[i]!.confidence).toBeGreaterThanOrEqual(
            result.findings[i + 1]!.confidence,
          );
        } else {
          expect(current).toBeGreaterThanOrEqual(next);
        }
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
        expect(fs.existsSync(path.join(outputDir, 'findings.json'))).toBe(true);
        expect(fs.existsSync(path.join(outputDir, 'report.md'))).toBe(true);
        expect(fs.existsSync(path.join(outputDir, 'report.html'))).toBe(true);
        expect(fs.existsSync(path.join(outputDir, 'trace.json'))).toBe(true);
      } finally {
        fs.rmSync(outputDir, { recursive: true, force: true });
      }
    });

    it('findings.json written to outputDir contains valid JSON with findings array', async () => {
      const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbi-output-json-'));

      try {
        const result = await analyzeBundlePipeline(wrongDbBundlePath, {
          outputDir,
          format: 'json',
        });

        await writePipelineResult(result, { format: 'json', outputDir });
        await cleanupPipelineResult(result);

        const findingsJson = fs.readFileSync(path.join(outputDir, 'findings.json'), 'utf-8');
        const parsed = JSON.parse(findingsJson) as Record<string, unknown>;
        expect(Array.isArray(parsed['findings'])).toBe(true);
        expect(typeof parsed['executiveSummary']).toBe('string');
        expect(parsed['schemaVersion']).toBeDefined();
        expect(parsed['aiSummary']).toBeDefined();
      } finally {
        fs.rmSync(outputDir, { recursive: true, force: true });
      }
    });

    it('findings.json omits provenance by default', async () => {
      const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbi-output-json-default-'));

      try {
        const result = await analyzeBundlePipeline(wrongDbBundlePath, {
          outputDir,
          format: 'json',
        });

        await writePipelineResult(result, { format: 'json', outputDir });
        await cleanupPipelineResult(result);

        const findingsJson = fs.readFileSync(path.join(outputDir, 'findings.json'), 'utf-8');
        const parsed = JSON.parse(findingsJson) as { findings: Array<Record<string, unknown>> };
        expect(parsed.findings[0]?.['provenance']).toBeUndefined();
      } finally {
        fs.rmSync(outputDir, { recursive: true, force: true });
      }
    });

    it('findings.json includes provenance when pipeline debug mode is enabled', async () => {
      const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbi-output-json-debug-'));

      try {
        const result = await analyzeBundlePipeline(wrongDbBundlePath, {
          outputDir,
          format: 'json',
          debug: true,
        });

        await writePipelineResult(result, { format: 'json', outputDir });
        await cleanupPipelineResult(result);

        const findingsJson = fs.readFileSync(path.join(outputDir, 'findings.json'), 'utf-8');
        const parsed = JSON.parse(findingsJson) as { findings: Array<Record<string, unknown>> };
        expect(parsed.findings[0]?.['provenance']).toBeDefined();
      } finally {
        fs.rmSync(outputDir, { recursive: true, force: true });
      }
    });

    it('report.md written to outputDir contains expected Markdown sections', async () => {
      const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbi-output-md-'));

      try {
        const result = await analyzeBundlePipeline(wrongDbBundlePath, {
          outputDir,
          format: 'markdown',
        });

        await writePipelineResult(result, { format: 'markdown', outputDir });
        await cleanupPipelineResult(result);

        const mdContent = fs.readFileSync(path.join(outputDir, 'report.md'), 'utf-8');
        expect(mdContent).toContain('# Investigation Report');
        expect(mdContent).toContain('## Executive Summary');
        expect(mdContent).toContain('## Findings');
      } finally {
        fs.rmSync(outputDir, { recursive: true, force: true });
      }
    });

    it('report.html written to outputDir contains valid HTML', async () => {
      const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbi-output-html-'));

      try {
        const result = await analyzeBundlePipeline(wrongDbBundlePath, {
          outputDir,
          format: 'html',
        });

        await writePipelineResult(result, { format: 'html', outputDir });
        await cleanupPipelineResult(result);

        const htmlContent = fs.readFileSync(path.join(outputDir, 'report.html'), 'utf-8');
        expect(htmlContent).toContain('<!DOCTYPE html>');
        expect(htmlContent).toContain('<html');
        expect(htmlContent).toContain('Investigation Report');
      } finally {
        fs.rmSync(outputDir, { recursive: true, force: true });
      }
    });
  });
});
