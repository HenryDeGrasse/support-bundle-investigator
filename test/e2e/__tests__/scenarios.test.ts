/**
 * End-to-End Integration Tests — All 3 Seeded Failure Scenarios
 *
 * Each describe block runs the full analysis pipeline once in beforeAll and
 * shares the result across all assertions in that group.  This avoids
 * spinning up multiple temp-extraction directories concurrently (which would
 * race against the extractor unit test's temp-dir count assertions).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { analyzeBundlePipeline, cleanupPipelineResult } from '../../../src/pipeline/analyze.js';
import type { PipelineResult } from '../../../src/pipeline/analyze.js';
import {
  isPodHealthy,
  getRestartCount,
  getContainerErrors,
} from '../../../src/parsers/k8s-helpers.js';
import { classifyLogs, rankLogsByImportance } from '../../../src/parsers/log-classifier.js';
import {
  InvestigationGraphImpl,
  buildFindingTree,
  findingTreeToJSON,
  chunkLogFile,
  chunkResource,
  chunkAnalyzer,
} from '../../../src/graph/index.js';
import { createTestBundle, getFixturePath } from '../../helpers/create-test-bundle.js';
import type { Finding } from '../../../src/types/index.js';

// ---------------------------------------------------------------------------
// Global setup — build .tar.gz bundles once for all tests
// ---------------------------------------------------------------------------

let tmpDir: string;
let wrongDbBundlePath: string;
let missingSecretBundlePath: string;
let badImageTagBundlePath: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbi-e2e-'));

  [wrongDbBundlePath, missingSecretBundlePath, badImageTagBundlePath] = await Promise.all([
    createTestBundle(
      getFixturePath('wrong-db-endpoint'),
      path.join(tmpDir, 'wrong-db-endpoint.tar.gz'),
    ),
    createTestBundle(
      getFixturePath('missing-secret-crashloop'),
      path.join(tmpDir, 'missing-secret-crashloop.tar.gz'),
    ),
    createTestBundle(
      getFixturePath('bad-image-tag'),
      path.join(tmpDir, 'bad-image-tag.tar.gz'),
    ),
  ]);
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ===========================================================================
// Scenario 1: Wrong DB Endpoint
// ===========================================================================

describe('E2E — Scenario 1: Wrong DB Endpoint', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await analyzeBundlePipeline(wrongDbBundlePath);
  });

  afterAll(async () => {
    await cleanupPipelineResult(result);
  });

  // ── Bundle extraction ────────────────────────────────────────────────────

  it('bundle extracts successfully and produces a non-empty manifest', () => {
    expect(result.profile.manifest.files.length).toBeGreaterThan(0);
  });

  // ── Profile: artifact counts ─────────────────────────────────────────────

  it('profile shows at least 1 analyzer artifact', () => {
    expect(result.profile.analyzerCount).toBeGreaterThanOrEqual(1);
  });

  it('profile shows at least 1 kubernetes-resource artifact', () => {
    expect(result.profile.resourceCount).toBeGreaterThanOrEqual(1);
  });

  it('profile shows at least 1 event artifact', () => {
    expect(result.profile.eventCount).toBeGreaterThanOrEqual(1);
  });

  it('profile shows at least 1 log file', () => {
    expect(result.profile.logFileCount).toBeGreaterThanOrEqual(1);
  });

  // ── Analyzer parser ──────────────────────────────────────────────────────

  it('analyzer parser finds the database connection warning', () => {
    const dbWarning = result.analyzerResults.find(
      (r) => r.isWarn && r.message.toLowerCase().includes('db.internal'),
    );
    expect(dbWarning).toBeDefined();
  });

  it('analyzer results include at least one warn-severity entry', () => {
    const warns = result.analyzerResults.filter((r) => r.isWarn);
    expect(warns.length).toBeGreaterThan(0);
  });

  // ── K8s resource parser: pod health ─────────────────────────────────────

  it('K8s resource parser finds the app-pod', () => {
    const pod = result.resources.find(
      (r) => r.kind === 'Pod' && r.metadata.name === 'app-pod',
    );
    expect(pod).toBeDefined();
  });

  it('isPodHealthy() returns false for app-pod (Running but not Ready)', () => {
    const pod = result.resources.find(
      (r) => r.kind === 'Pod' && r.metadata.name === 'app-pod',
    );
    expect(pod).toBeDefined();
    expect(isPodHealthy(pod!)).toBe(false);
  });

  // ── Event parser ─────────────────────────────────────────────────────────

  it('event parser finds Warning events about connection issues', () => {
    const warningEvents = result.events.filter((e) => e.type === 'Warning');
    expect(warningEvents.length).toBeGreaterThan(0);
  });

  it('events include connection-related reason (Unhealthy or BackOff)', () => {
    const reasons = result.events.map((e) => e.reason);
    const hasConnectionIssue =
      reasons.includes('Unhealthy') || reasons.includes('BackOff');
    expect(hasConnectionIssue).toBe(true);
  });

  // ── Log parser ───────────────────────────────────────────────────────────

  it('log parser identifies error lines containing "no such host"', () => {
    const allErrorLines = result.logs.flatMap((l) =>
      l.lines.filter((line) => line.level === 'error'),
    );
    const dnsError = allErrorLines.find((line) =>
      line.content.includes('no such host'),
    );
    expect(dnsError).toBeDefined();
  });

  it('log parser finds at least 1 error-level line in the app log', () => {
    const totalErrors = result.logs.reduce((sum, l) => sum + l.errorCount, 0);
    expect(totalErrors).toBeGreaterThan(0);
  });

  // ── Log classifier ───────────────────────────────────────────────────────

  it('log classifier ranks the app log as high importance (>= 0.5)', () => {
    const classifications = classifyLogs(result.logs);
    const ranked = rankLogsByImportance(classifications);
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0]!.importance).toBeGreaterThanOrEqual(0.5);
  });

  it('log classifier assigns a meaningful category to the app log', () => {
    const classifications = classifyLogs(result.logs);
    const ranked = rankLogsByImportance(classifications);
    expect(ranked.length).toBeGreaterThan(0);
    // The top log has DB-related content AND path with "db" in scenario name →
    // classifier may return 'database', 'networking', or 'application' depending
    // on path patterns; all are valid evidence of a real problem.
    const topCategory = ranked[0]!.category;
    expect(['networking', 'application', 'database']).toContain(topCategory);
  });

  // ── Investigation graph ──────────────────────────────────────────────────

  it('investigation graph has nodes for all artifact types', () => {
    const nodeTypes = new Set(
      Array.from(result.graph.nodes.values()).map(
        (n) => n.metadata?.['category'] as string,
      ),
    );

    expect(nodeTypes.has('analyzer')).toBe(true);
    expect(nodeTypes.has('kubernetes-resource')).toBe(true);
    expect(nodeTypes.has('event')).toBe(true);
    expect(nodeTypes.has('log')).toBe(true);
  });

  it('graph node count equals sum of all parsed artifacts', () => {
    const { graph, analyzerResults, resources, events, logs } = result;
    const expectedCount =
      analyzerResults.length + resources.length + events.length + logs.length;
    expect(graph.nodes.size).toBe(expectedCount);
  });
});

// ===========================================================================
// Scenario 2: Missing Secret CrashLoop
// ===========================================================================

describe('E2E — Scenario 2: Missing Secret CrashLoop', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await analyzeBundlePipeline(missingSecretBundlePath);
  });

  afterAll(async () => {
    await cleanupPipelineResult(result);
  });

  // ── Profile: CrashLoopBackOff pod ────────────────────────────────────────

  it('profile identifies at least 1 pod resource', () => {
    const pods = result.resources.filter((r) => r.kind === 'Pod');
    expect(pods.length).toBeGreaterThan(0);
  });

  it('profile finds pod with CrashLoopBackOff in status', () => {
    const pods = result.resources.filter((r) => r.kind === 'Pod');
    const crashLoopPod = pods.find((p) =>
      JSON.stringify(p.status).includes('CrashLoopBackOff'),
    );
    expect(crashLoopPod).toBeDefined();
  });

  // ── isPodHealthy() ───────────────────────────────────────────────────────

  it('isPodHealthy() returns false for the crashing pod', () => {
    const pod = result.resources.find(
      (r) => r.kind === 'Pod' && r.metadata.name === 'app-pod',
    );
    expect(pod).toBeDefined();
    expect(isPodHealthy(pod!)).toBe(false);
  });

  // ── getRestartCount() ────────────────────────────────────────────────────

  it('getRestartCount() returns 8 for the crashing pod', () => {
    const pod = result.resources.find(
      (r) => r.kind === 'Pod' && r.metadata.name === 'app-pod',
    );
    expect(pod).toBeDefined();
    expect(getRestartCount(pod!)).toBe(8);
  });

  // ── getContainerErrors() ─────────────────────────────────────────────────

  it('getContainerErrors() shows CrashLoopBackOff as the waiting reason', () => {
    const pod = result.resources.find(
      (r) => r.kind === 'Pod' && r.metadata.name === 'app-pod',
    );
    expect(pod).toBeDefined();
    const errors = getContainerErrors(pod!);
    expect(errors.length).toBeGreaterThan(0);
    const crashLoopError = errors.find((e) => e.reason === 'CrashLoopBackOff');
    expect(crashLoopError).toBeDefined();
  });

  // ── Events ───────────────────────────────────────────────────────────────

  it('events include a FailedMount event', () => {
    const reasons = result.events.map((e) => e.reason);
    expect(reasons).toContain('FailedMount');
  });

  it('events include a BackOff event', () => {
    const reasons = result.events.map((e) => e.reason);
    expect(reasons).toContain('BackOff');
  });

  it('FailedMount event message mentions app-credentials secret', () => {
    const failedMount = result.events.find((e) => e.reason === 'FailedMount');
    expect(failedMount).toBeDefined();
    expect(failedMount!.message).toContain('app-credentials');
  });

  // ── Logs ─────────────────────────────────────────────────────────────────

  it('log contains "secret app-credentials not found" error line', () => {
    const allLines = result.logs.flatMap((l) => l.lines);
    const secretError = allLines.find((line) =>
      line.content.includes('secret app-credentials not found'),
    );
    expect(secretError).toBeDefined();
  });

  it('log error lines include a secret-not-found error', () => {
    const errorLines = result.logs.flatMap((l) =>
      l.lines.filter((line) => line.level === 'error'),
    );
    expect(errorLines.length).toBeGreaterThan(0);
    const secretError = errorLines.find((line) =>
      line.content.toLowerCase().includes('secret'),
    );
    expect(secretError).toBeDefined();
  });
});

// ===========================================================================
// Scenario 3: Bad Image Tag
// ===========================================================================

describe('E2E — Scenario 3: Bad Image Tag', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await analyzeBundlePipeline(badImageTagBundlePath);
  });

  afterAll(async () => {
    await cleanupPipelineResult(result);
  });

  // ── Profile: ImagePullBackOff pod ────────────────────────────────────────

  it('profile identifies pod with ImagePullBackOff in status', () => {
    const pods = result.resources.filter((r) => r.kind === 'Pod');
    const imagePullPod = pods.find((p) =>
      JSON.stringify(p.status).includes('ImagePullBackOff'),
    );
    expect(imagePullPod).toBeDefined();
  });

  // ── isPodHealthy() ───────────────────────────────────────────────────────

  it('isPodHealthy() returns false for the ImagePullBackOff pod', () => {
    const pod = result.resources.find(
      (r) => r.kind === 'Pod' && r.metadata.name === 'app-pod',
    );
    expect(pod).toBeDefined();
    expect(isPodHealthy(pod!)).toBe(false);
  });

  // ── getContainerErrors() ─────────────────────────────────────────────────

  it('getContainerErrors() shows ImagePullBackOff as the waiting reason', () => {
    const pod = result.resources.find(
      (r) => r.kind === 'Pod' && r.metadata.name === 'app-pod',
    );
    expect(pod).toBeDefined();
    const errors = getContainerErrors(pod!);
    expect(errors.length).toBeGreaterThan(0);
    const imagePullError = errors.find((e) => e.reason === 'ImagePullBackOff');
    expect(imagePullError).toBeDefined();
  });

  // ── Events ───────────────────────────────────────────────────────────────

  it('events include an ErrImagePull event', () => {
    const reasons = result.events.map((e) => e.reason);
    expect(reasons).toContain('ErrImagePull');
  });

  it('events include a Failed event for the image pull', () => {
    const reasons = result.events.map((e) => e.reason);
    expect(reasons).toContain('Failed');
  });

  it('ErrImagePull event message references the bad image or not-found error', () => {
    const errEvent = result.events.find((e) => e.reason === 'ErrImagePull');
    expect(errEvent).toBeDefined();
    expect(errEvent!.message).toMatch(/myapp:v999\.99\.99|not found/i);
  });

  // ── Logs: pod never successfully bootstrapped ────────────────────────────

  it('logs directory exists — pipeline handles scenario without throwing', () => {
    expect(Array.isArray(result.logs)).toBe(true);
  });

  it('log content is minimal — no successful DB connection messages', () => {
    const allLines = result.logs.flatMap((l) => l.lines);
    const hasDbConnectLine = allLines.some((line) =>
      line.content.toLowerCase().includes('connected to database'),
    );
    expect(hasDbConnectLine).toBe(false);
  });

  // ── Coverage gap detection ───────────────────────────────────────────────

  it('profile has analyzers, resources, and events (all > 0)', () => {
    expect(result.profile.analyzerCount).toBeGreaterThan(0);
    expect(result.profile.resourceCount).toBeGreaterThan(0);
    expect(result.profile.eventCount).toBeGreaterThan(0);
  });
});

// ===========================================================================
// Pipeline Trace — Complete & Serializable
// ===========================================================================

describe('E2E — Pipeline Trace', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await analyzeBundlePipeline(wrongDbBundlePath);
  });

  afterAll(async () => {
    await cleanupPipelineResult(result);
  });

  it('trace is complete with startedAt, completedAt, and bundlePath', () => {
    const { trace } = result;
    expect(trace.bundlePath).toBeTruthy();
    expect(trace.startedAt).toBeTruthy();
    expect(trace.completedAt).toBeTruthy();
  });

  it('trace contains all 7 expected pipeline steps', () => {
    const stepNames = result.trace.steps.map((s) => s.name);

    expect(stepNames).toContain('extract');
    expect(stepNames).toContain('profile');
    expect(stepNames).toContain('parse-analyzers');
    expect(stepNames).toContain('parse-resources');
    expect(stepNames).toContain('parse-events');
    expect(stepNames).toContain('parse-logs');
    expect(stepNames).toContain('build-graph');
  });

  it('every trace step records artifactsProcessed as a non-negative number', () => {
    for (const step of result.trace.steps) {
      expect(typeof step.artifactsProcessed).toBe('number');
      expect(step.artifactsProcessed).toBeGreaterThanOrEqual(0);
    }
  });

  it('trace serializes to JSON and deserializes without data loss', () => {
    const { trace } = result;

    const serialized = JSON.stringify(trace);
    expect(() => JSON.parse(serialized)).not.toThrow();

    const parsed = JSON.parse(serialized) as typeof trace;
    expect(parsed.bundlePath).toBe(trace.bundlePath);
    expect(parsed.steps).toHaveLength(trace.steps.length);
  });
});

// ===========================================================================
// Investigation Graph — Serialization & Node Validation
// ===========================================================================

describe('E2E — Investigation Graph', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await analyzeBundlePipeline(wrongDbBundlePath);
  });

  afterAll(async () => {
    await cleanupPipelineResult(result);
  });

  it('graph serializes to JSON and contains expected nodes', () => {
    const serialized = result.graph.toJSON();
    const jsonStr = JSON.stringify(serialized);
    expect(() => JSON.parse(jsonStr)).not.toThrow();

    const parsed = JSON.parse(jsonStr) as typeof serialized;
    expect(Array.isArray(parsed.nodes)).toBe(true);
    expect(Array.isArray(parsed.edges)).toBe(true);
    expect(parsed.nodes.length).toBeGreaterThan(0);
  });

  it('graph can be reconstructed from its JSON representation', () => {
    const serialized = result.graph.toJSON();
    const restored = InvestigationGraphImpl.fromJSON(serialized);

    expect(restored.nodes.size).toBe(result.graph.nodes.size);
    expect(restored.edges.length).toBe(result.graph.edges.length);
  });

  it('graph JSON contains one node per analyzer result', () => {
    const serialized = result.graph.toJSON();
    const analyzerNodes = serialized.nodes.filter(
      (n) => (n.metadata?.['category'] as string) === 'analyzer',
    );
    expect(analyzerNodes.length).toBe(result.analyzerResults.length);
  });

  it('graph node ids follow the expected naming convention', () => {
    const nodeIds = Array.from(result.graph.nodes.keys());

    expect(nodeIds.some((id) => id.startsWith('analyzer:'))).toBe(true);
    expect(nodeIds.some((id) => id.startsWith('resource:'))).toBe(true);
    expect(nodeIds.some((id) => id.startsWith('event:'))).toBe(true);
    expect(nodeIds.some((id) => id.startsWith('log:'))).toBe(true);
  });
});

// ===========================================================================
// Chunker — Produces Chunks from Parsed Artifacts
// ===========================================================================

describe('E2E — Chunker', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await analyzeBundlePipeline(wrongDbBundlePath);
  });

  afterAll(async () => {
    await cleanupPipelineResult(result);
  });

  it('chunkLogFile produces chunks from a non-empty log file', () => {
    const logFile = result.logs.find((l) => l.lines.length > 0);
    expect(logFile).toBeDefined();

    const chunks = chunkLogFile(logFile!, 10, 2);
    expect(chunks.length).toBeGreaterThan(0);

    for (const chunk of chunks) {
      expect(chunk.id).toContain(logFile!.path);
      expect(chunk.content.length).toBeGreaterThan(0);
      expect(chunk.startLine).toBeGreaterThanOrEqual(1);
      expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine);
    }
  });

  it('chunkResource produces a single chunk for a K8s resource', () => {
    const pod = result.resources.find((r) => r.kind === 'Pod');
    expect(pod).toBeDefined();

    const chunk = chunkResource(pod!, 'test/path/pod.yaml');
    expect(chunk.content).toContain('"kind": "Pod"');
    expect(chunk.metadata?.['kind']).toBe('Pod');
    expect(chunk.metadata?.['name']).toBe(pod!.metadata.name);
  });

  it('chunkAnalyzer produces a single chunk for an analyzer result', () => {
    const analyzerResult = result.analyzerResults[0];
    expect(analyzerResult).toBeDefined();

    const chunk = chunkAnalyzer(analyzerResult!);
    expect(chunk.content).toContain(analyzerResult!.title);
    expect(chunk.metadata?.['category']).toBe('analyzer');
    expect(chunk.metadata?.['severity']).toBe(analyzerResult!.severity);
  });

  it('chunker covers all lines of a log file (last chunk ends at last line)', () => {
    const logFile = result.logs.find((l) => l.lines.length >= 5);
    expect(logFile).toBeDefined();

    const chunks = chunkLogFile(logFile!, 5, 0);
    const lastChunk = chunks[chunks.length - 1]!;
    expect(lastChunk.endLine).toBe(logFile!.lines[logFile!.lines.length - 1]!.lineNumber);
  });
});

// ===========================================================================
// Finding Tree — Build from Mock Findings
// ===========================================================================

describe('E2E — Finding Tree', () => {
  const mockFindings: Finding[] = [
    {
      id: 'finding-root',
      title: 'Database unreachable',
      severity: 'critical',
      confidence: 0.95,
      affectedComponents: ['app-pod'],
      reasoningSummary: 'DNS resolution failed for db.internal',
      evidence: [{ path: 'logs/app/app-pod.log', note: 'no such host error found' }],
      contradictionsChecked: [],
      recommendedAction: 'Fix DB_HOST environment variable',
      missingEvidence: [],
    },
    {
      id: 'finding-child-1',
      title: 'Pod not ready',
      severity: 'high',
      confidence: 0.9,
      affectedComponents: ['app-pod'],
      reasoningSummary: 'Readiness probe failing due to DB connectivity',
      evidence: [
        { path: 'cluster-resources/pods/default/app-pod.yaml', note: 'Ready=False' },
      ],
      contradictionsChecked: [],
      recommendedAction: 'Resolve root cause (DB connectivity)',
      missingEvidence: [],
    },
    {
      id: 'finding-child-2',
      title: 'Unhealthy events fired',
      severity: 'medium',
      confidence: 0.8,
      affectedComponents: ['app-pod'],
      reasoningSummary: 'Kubernetes fired Unhealthy events for the pod',
      evidence: [
        { path: 'cluster-resources/events/default.json', note: 'Unhealthy event found' },
      ],
      contradictionsChecked: [],
      recommendedAction: 'Monitor after root-cause resolution',
      missingEvidence: [],
    },
  ];

  it('buildFindingTree returns a node for each finding', () => {
    const edges = [
      { id: 'e1', source: 'finding-root', target: 'finding-child-1', type: 'causes' as const },
      { id: 'e2', source: 'finding-root', target: 'finding-child-2', type: 'causes' as const },
    ];

    const tree = buildFindingTree(mockFindings, edges);
    expect(tree.length).toBe(3);
  });

  it('root finding has 2 children after buildFindingTree', () => {
    const edges = [
      { id: 'e1', source: 'finding-root', target: 'finding-child-1', type: 'causes' as const },
      { id: 'e2', source: 'finding-root', target: 'finding-child-2', type: 'causes' as const },
    ];

    const tree = buildFindingTree(mockFindings, edges);
    const root = tree.find((n) => n.finding.id === 'finding-root');
    expect(root).toBeDefined();
    expect(root!.children.length).toBe(2);
  });

  it('child findings have parent set correctly', () => {
    const edges = [
      { id: 'e1', source: 'finding-root', target: 'finding-child-1', type: 'causes' as const },
    ];

    const tree = buildFindingTree(mockFindings, edges);
    const child = tree.find((n) => n.finding.id === 'finding-child-1');
    expect(child).toBeDefined();
    expect(child!.parent).toBe('finding-root');
  });

  it('findingTreeToJSON serializes the tree without circular references', () => {
    const edges = [
      { id: 'e1', source: 'finding-root', target: 'finding-child-1', type: 'causes' as const },
      { id: 'e2', source: 'finding-root', target: 'finding-child-2', type: 'causes' as const },
    ];

    const tree = buildFindingTree(mockFindings, edges);

    expect(() => JSON.stringify(findingTreeToJSON(tree))).not.toThrow();

    const serialized = JSON.stringify(findingTreeToJSON(tree));
    const parsed = JSON.parse(serialized) as unknown[];
    expect(Array.isArray(parsed)).toBe(true);
  });

  it('finding tree can be built from pipeline analyzer findings via no-op edges', async () => {
    // Run a minimal pipeline and build a finding tree from its analyzer results
    const pipelineResult = await analyzeBundlePipeline(wrongDbBundlePath);

    try {
      const findings: Finding[] = pipelineResult.analyzerResults.map((ar, i) => ({
        id: `analyzer-finding-${i}`,
        title: ar.title,
        severity: ar.isFail ? 'critical' : ar.isWarn ? 'high' : ('info' as const),
        confidence: 0.8,
        affectedComponents: [],
        reasoningSummary: ar.message,
        evidence: [{ path: `analyzer/${ar.name}`, note: ar.title }],
        contradictionsChecked: [],
        recommendedAction: 'Review analyzer output',
        missingEvidence: [],
      }));

      // No cause edges — each finding is its own root
      const tree = buildFindingTree(findings, []);
      expect(tree.length).toBe(findings.length);
      for (const node of tree) {
        expect(node.parent).toBeUndefined();
      }
    } finally {
      await cleanupPipelineResult(pipelineResult);
    }
  });
});
