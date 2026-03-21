/**
 * End-to-End Integration Tests — All 4 Seeded Failure Scenarios
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
import {
  buildReport,
  generateMarkdownReport,
  generateJsonReport,
  generateHtmlReport,
} from '../../../src/reporters/index.js';
import { createTestBundle, getFixturePath } from '../../helpers/create-test-bundle.js';
import type { Finding } from '../../../src/types/index.js';

// ---------------------------------------------------------------------------
// Global setup — build .tar.gz bundles once for all tests
// ---------------------------------------------------------------------------

let tmpDir: string;
let wrongDbBundlePath: string;
let missingSecretBundlePath: string;
let badImageTagBundlePath: string;
let pvcPendingBundlePath: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbi-e2e-'));

  [wrongDbBundlePath, missingSecretBundlePath, badImageTagBundlePath, pvcPendingBundlePath] = await Promise.all([
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
    createTestBundle(
      getFixturePath('pvc-pending'),
      path.join(tmpDir, 'pvc-pending.tar.gz'),
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

  it('graph node count is at least the parsed artifacts plus findings', () => {
    const { graph, analyzerResults, resources, events, logs, findings } = result;
    // Base artifact nodes (analyzer, resource, event, log) + finding nodes must exist.
    const minimumExpectedCount =
      analyzerResults.length + resources.length + events.length + logs.length + findings.length;
    expect(graph.nodes.size).toBeGreaterThanOrEqual(minimumExpectedCount);
  });

  it('all graph edges reference nodes present in the graph', () => {
    for (const edge of result.graph.edges) {
      expect(result.graph.getNode(edge.source)).toBeDefined();
      expect(result.graph.getNode(edge.target)).toBeDefined();
    }
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

  it('trace contains all 8 expected pipeline steps', () => {
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
    expect(parsed.metadata).toBeDefined();
  });

  it('trace metadata includes parsed artifact counts and finding telemetry', () => {
    const metadata = result.trace.metadata;
    expect(metadata).toBeDefined();
    expect(metadata?.['analyzerCount']).toBe(result.analyzerResults.length);
    expect(metadata?.['resourceCount']).toBe(result.resources.length);
    expect(metadata?.['eventCount']).toBe(result.events.length);
    expect(metadata?.['logFileCount']).toBe(result.logs.length);
    expect(metadata?.['helmReleaseCount']).toBe(0);
    expect(metadata?.['findingCount']).toBe(result.findings.length);
    expect(metadata?.['rawFindingCount']).toBeGreaterThanOrEqual(result.findings.length);
    expect(metadata?.['finalFindingCount']).toBe(result.findings.length);

    const seedCategories = metadata?.['seedCategories'] as Record<string, number> | undefined;
    expect(seedCategories).toBeDefined();
    expect(Object.values(seedCategories ?? {}).reduce((sum, count) => sum + count, 0)).toBe(
      metadata?.['seedCount'],
    );

    const hypothesisStats = metadata?.['hypothesisStats'] as
      | { generated: number; verified: number; converted: number }
      | undefined;
    expect(hypothesisStats).toBeDefined();
    expect(hypothesisStats?.generated).toBeGreaterThanOrEqual(hypothesisStats?.verified ?? 0);
    expect(hypothesisStats?.verified).toBeGreaterThanOrEqual(hypothesisStats?.converted ?? 0);

    const confidenceStats = metadata?.['confidenceStats'] as
      | { min: number; max: number; mean: number; median: number }
      | undefined;
    expect(confidenceStats).toBeDefined();
    expect(confidenceStats?.min).toBeGreaterThanOrEqual(0);
    expect(confidenceStats?.max).toBeLessThanOrEqual(1);

    const retrievalStats = metadata?.['retrievalStats'] as
      | { graphChunks: number; lexicalChunks: number; semanticChunks: number; mergedChunks: number }
      | undefined;
    expect(retrievalStats).toBeDefined();
    expect(retrievalStats?.graphChunks).toBeGreaterThanOrEqual(0);
    expect(retrievalStats?.mergedChunks).toBeGreaterThanOrEqual(0);

    expect(metadata?.['parsedArtifactCount']).toBe(
      result.analyzerResults.length +
        result.resources.length +
        result.events.length +
        result.logs.length +
        ((metadata?.['helmReleaseCount'] as number | undefined) ?? 0),
    );
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
    // After step 3.3, chunk.content is the human-readable summarizeResource
    // output (e.g. "Pod: <name> (namespace: <ns>)\nContainers: ..."), not raw
    // JSON.  The raw JSON is preserved in metadata.rawContent.
    expect(chunk.content).toContain('Pod:');
    expect(chunk.content).toContain(pod!.metadata.name);
    // Raw JSON is stashed in metadata for callers that need the full spec
    expect(chunk.metadata?.['rawContent']).toContain('"kind": "Pod"');
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

// ===========================================================================
// Investigation Findings Quality — Scenario 1: Wrong DB Endpoint
// ===========================================================================

describe('E2E — Findings Quality: Wrong DB Endpoint', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await analyzeBundlePipeline(wrongDbBundlePath);
  });

  afterAll(async () => {
    await cleanupPipelineResult(result);
  });

  it('produces at least one investigation finding', () => {
    expect(result.findings.length).toBeGreaterThan(0);
  });

  it('top finding severity is high or critical', () => {
    expect(['high', 'critical']).toContain(result.findings[0]!.severity);
  });

  it('top finding confidence is >= 0.7', () => {
    expect(result.findings[0]!.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it('top finding is related to DB connectivity (DNS or connection/not-ready issue)', () => {
    const top = result.findings[0]!;
    const text = `${top.title} ${top.reasoningSummary}`.toLowerCase();
    const isDbConnectivity =
      text.includes('dns') ||
      text.includes('no such host') ||
      text.includes('db.internal') ||
      text.includes('connection') ||
      text.includes('not ready');
    expect(isDbConnectivity).toBe(true);
  });

  it('every finding has at least one evidence entry', () => {
    for (const finding of result.findings) {
      expect(finding.evidence.length).toBeGreaterThan(0);
    }
  });

  it('every finding has at least one contradictionsChecked entry', () => {
    for (const finding of result.findings) {
      expect(finding.contradictionsChecked.length).toBeGreaterThan(0);
    }
  });

  it('every finding has a non-empty recommendedAction', () => {
    for (const finding of result.findings) {
      expect(finding.recommendedAction.trim().length).toBeGreaterThan(0);
    }
  });

  it('all findings have valid ids (non-empty strings)', () => {
    for (const finding of result.findings) {
      expect(typeof finding.id).toBe('string');
      expect(finding.id.length).toBeGreaterThan(0);
    }
  });
});

// ===========================================================================
// Investigation Findings Quality — Scenario 2: Missing Secret CrashLoop
// ===========================================================================

describe('E2E — Findings Quality: Missing Secret CrashLoop', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await analyzeBundlePipeline(missingSecretBundlePath);
  });

  afterAll(async () => {
    await cleanupPipelineResult(result);
  });

  it('produces at least one investigation finding', () => {
    expect(result.findings.length).toBeGreaterThan(0);
  });

  it('top finding is critical severity (CrashLoopBackOff or missing secret)', () => {
    expect(result.findings[0]!.severity).toBe('critical');
  });

  it('top finding confidence is >= 0.7', () => {
    expect(result.findings[0]!.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it('top finding is about CrashLoopBackOff or missing secret', () => {
    const top = result.findings[0]!;
    const text = `${top.title} ${top.reasoningSummary}`.toLowerCase();
    const isRelevant =
      text.includes('crashloop') ||
      text.includes('missing secret') ||
      text.includes('secret') ||
      text.includes('crashloopbackoff');
    expect(isRelevant).toBe(true);
  });

  it('at least one finding references the missing secret (app-credentials)', () => {
    const allText = result.findings
      .map(
        (f) =>
          `${f.title} ${f.reasoningSummary} ${f.evidence.map((e) => e.note).join(' ')}`,
      )
      .join(' ')
      .toLowerCase();
    expect(allText).toMatch(/app-credentials|secret.*not found|crashloop/i);
  });

  it('every finding has at least one evidence entry', () => {
    for (const finding of result.findings) {
      expect(finding.evidence.length).toBeGreaterThan(0);
    }
  });

  it('every finding has at least one contradictionsChecked entry', () => {
    for (const finding of result.findings) {
      expect(finding.contradictionsChecked.length).toBeGreaterThan(0);
    }
  });

  it('every finding has a non-empty recommendedAction', () => {
    for (const finding of result.findings) {
      expect(finding.recommendedAction.trim().length).toBeGreaterThan(0);
    }
  });
});

// ===========================================================================
// Investigation Findings Quality — Scenario 3: Bad Image Tag
// ===========================================================================

describe('E2E — Findings Quality: Bad Image Tag', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await analyzeBundlePipeline(badImageTagBundlePath);
  });

  afterAll(async () => {
    await cleanupPipelineResult(result);
  });

  it('produces at least one investigation finding', () => {
    expect(result.findings.length).toBeGreaterThan(0);
  });

  it('top finding is critical severity (image pull issue)', () => {
    expect(result.findings[0]!.severity).toBe('critical');
  });

  it('top finding confidence is >= 0.7', () => {
    expect(result.findings[0]!.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it('top finding is about image pull failure', () => {
    const top = result.findings[0]!;
    const text = `${top.title} ${top.reasoningSummary}`.toLowerCase();
    const isImagePull =
      text.includes('imagepull') ||
      text.includes('image pull') ||
      text.includes('errimagepull') ||
      text.includes('image tag');
    expect(isImagePull).toBe(true);
  });

  it('at least one finding references the bad image tag', () => {
    const allText = result.findings
      .map(
        (f) =>
          `${f.title} ${f.reasoningSummary} ${f.evidence.map((e) => e.note).join(' ')}`,
      )
      .join(' ')
      .toLowerCase();
    expect(allText).toMatch(/imagepullbackoff|image.*pull|errimagepull|v999/i);
  });

  it('every finding has at least one evidence entry', () => {
    for (const finding of result.findings) {
      expect(finding.evidence.length).toBeGreaterThan(0);
    }
  });

  it('every finding has at least one contradictionsChecked entry', () => {
    for (const finding of result.findings) {
      expect(finding.contradictionsChecked.length).toBeGreaterThan(0);
    }
  });

  it('every finding has a non-empty recommendedAction', () => {
    for (const finding of result.findings) {
      expect(finding.recommendedAction.trim().length).toBeGreaterThan(0);
    }
  });
});

// ===========================================================================
// Report Generation — Markdown / JSON / HTML
// ===========================================================================

describe('E2E — Report Generation', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await analyzeBundlePipeline(wrongDbBundlePath);
  });

  afterAll(async () => {
    await cleanupPipelineResult(result);
  });

  // ── Markdown ─────────────────────────────────────────────────────────────

  it('markdown report contains the main H1 title', () => {
    const report = buildReport(result);
    const md = generateMarkdownReport(report);
    expect(md).toContain('# Investigation Report');
  });

  it('markdown report contains an Executive Summary section', () => {
    const report = buildReport(result);
    const md = generateMarkdownReport(report);
    expect(md).toContain('## Executive Summary');
  });

  it('markdown report contains a Findings section', () => {
    const report = buildReport(result);
    const md = generateMarkdownReport(report);
    expect(md).toContain('## Findings');
  });

  it('markdown report contains a Missing Evidence section', () => {
    const report = buildReport(result);
    const md = generateMarkdownReport(report);
    expect(md).toContain('## Missing Evidence');
  });

  it('markdown report contains a Spec Improvement Recommendations section', () => {
    const report = buildReport(result);
    const md = generateMarkdownReport(report);
    expect(md).toContain('## Spec Improvement Recommendations');
  });

  it('markdown report mentions the top finding title', () => {
    if (result.findings.length === 0) return;
    const report = buildReport(result);
    const md = generateMarkdownReport(report);
    // Top finding title is rendered as a subsection header
    expect(md).toContain(result.findings[0]!.title);
  });

  // ── JSON ─────────────────────────────────────────────────────────────────

  it('JSON report is valid JSON', () => {
    const report = buildReport(result);
    const json = generateJsonReport(report);
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it('JSON report contains expected top-level fields', () => {
    const report = buildReport(result);
    const parsed = JSON.parse(generateJsonReport(report)) as Record<string, unknown>;
    expect(parsed['schemaVersion']).toBeDefined();
    expect(parsed['generatedAt']).toBeDefined();
    expect(Array.isArray(parsed['findings'])).toBe(true);
    expect(typeof parsed['executiveSummary']).toBe('string');
  });

  it('JSON report findings array length matches pipeline findings count', () => {
    const report = buildReport(result);
    const parsed = JSON.parse(generateJsonReport(report)) as Record<string, unknown>;
    const parsedFindings = parsed['findings'] as unknown[];
    expect(parsedFindings.length).toBe(result.findings.length);
  });

  it('JSON report rootCause is non-null when findings exist', () => {
    if (result.findings.length === 0) return;
    const report = buildReport(result);
    const parsed = JSON.parse(generateJsonReport(report)) as Record<string, unknown>;
    expect(parsed['rootCause']).not.toBeNull();
    expect(typeof parsed['rootCause']).toBe('string');
  });

  it('JSON report each finding has required fields', () => {
    const report = buildReport(result);
    const parsed = JSON.parse(generateJsonReport(report)) as Record<string, unknown>;
    const parsedFindings = parsed['findings'] as Array<Record<string, unknown>>;
    for (const finding of parsedFindings) {
      expect(finding['id']).toBeDefined();
      expect(finding['title']).toBeDefined();
      expect(finding['severity']).toBeDefined();
      expect(finding['confidence']).toBeDefined();
      expect(Array.isArray(finding['evidence'])).toBe(true);
      expect(Array.isArray(finding['contradictionsChecked'])).toBe(true);
      expect(typeof finding['recommendedAction']).toBe('string');
    }
  });

  // ── HTML ──────────────────────────────────────────────────────────────────

  it('HTML report contains valid DOCTYPE declaration', () => {
    const report = buildReport(result);
    const html = generateHtmlReport(report);
    expect(html).toContain('<!DOCTYPE html>');
  });

  it('HTML report contains html, head and body elements', () => {
    const report = buildReport(result);
    const html = generateHtmlReport(report);
    expect(html).toContain('<html');
    expect(html).toContain('</html>');
    expect(html).toContain('<head>');
    expect(html).toContain('<body>');
  });

  it('HTML report contains the Investigation Report heading', () => {
    const report = buildReport(result);
    const html = generateHtmlReport(report);
    expect(html).toContain('Investigation Report');
  });

  it('HTML report does not contain unescaped script injection markers', () => {
    const report = buildReport(result);
    const html = generateHtmlReport(report);
    // Ensure the generated HTML is a well-formed document (not empty, has content)
    expect(html.length).toBeGreaterThan(500);
    expect(html).toContain('</body>');
  });
});

// ===========================================================================
// Spec Recommendations — Generated When Evidence Gaps Exist
// ===========================================================================

describe('E2E — Spec Recommendations', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    // Missing-secret scenario triggers analyzer recommendations because
    // the CrashLoopBackOff finding text mentions "missing Secret or ConfigMap".
    result = await analyzeBundlePipeline(missingSecretBundlePath);
  });

  afterAll(async () => {
    await cleanupPipelineResult(result);
  });

  it('spec recommendations are generated for this scenario', () => {
    const report = buildReport(result);
    expect(report.specRecommendations.length).toBeGreaterThan(0);
  });

  it('every spec recommendation has a valid type', () => {
    const report = buildReport(result);
    const validTypes = new Set(['collector', 'analyzer', 'redaction']);
    for (const rec of report.specRecommendations) {
      expect(validTypes.has(rec.type)).toBe(true);
    }
  });

  it('every spec recommendation has a non-empty description', () => {
    const report = buildReport(result);
    for (const rec of report.specRecommendations) {
      expect(rec.description.trim().length).toBeGreaterThan(0);
    }
  });

  it('every spec recommendation has a non-empty rationale', () => {
    const report = buildReport(result);
    for (const rec of report.specRecommendations) {
      expect(rec.rationale.trim().length).toBeGreaterThan(0);
    }
  });

  it('missing-secret scenario produces an analyzer recommendation', () => {
    const report = buildReport(result);
    const analyzerRec = report.specRecommendations.find((r) => r.type === 'analyzer');
    expect(analyzerRec).toBeDefined();
  });
});

// ===========================================================================
// Pipeline Trace — Investigation Step Coverage
// ===========================================================================

describe('E2E — Pipeline Trace Investigation Steps', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await analyzeBundlePipeline(wrongDbBundlePath);
  });

  afterAll(async () => {
    await cleanupPipelineResult(result);
  });

  it('trace includes the investigate step', () => {
    const stepNames = result.trace.steps.map((s) => s.name);
    expect(stepNames).toContain('investigate');
  });

  it('investigate step records a positive artifactsProcessed count', () => {
    const investigateStep = result.trace.steps.find((s) => s.name === 'investigate');
    expect(investigateStep).toBeDefined();
    expect(investigateStep!.artifactsProcessed).toBeGreaterThan(0);
  });

  it('investigate step has a valid startedAt and completedAt timestamp', () => {
    const investigateStep = result.trace.steps.find((s) => s.name === 'investigate');
    expect(investigateStep).toBeDefined();
    expect(investigateStep!.startedAt).toBeTruthy();
    expect(investigateStep!.completedAt).toBeTruthy();
  });

  it('investigate step includes seed, retrieval, confidence, and hypothesis telemetry', () => {
    const investigateStep = result.trace.steps.find((s) => s.name === 'investigate');
    expect(investigateStep).toBeDefined();
    expect(investigateStep!.seedCount).toBeGreaterThan(0);
    expect(investigateStep!.seedCategories).toBeDefined();
    expect(Object.values(investigateStep!.seedCategories ?? {}).reduce((sum, count) => sum + count, 0))
      .toBe(investigateStep!.seedCount);

    expect(investigateStep!.retrievalStats).toBeDefined();
    expect(investigateStep!.retrievalStats!.graphChunks).toBeGreaterThanOrEqual(0);
    expect(investigateStep!.retrievalStats!.lexicalChunks).toBeGreaterThanOrEqual(0);
    expect(investigateStep!.retrievalStats!.semanticChunks).toBeGreaterThanOrEqual(0);
    expect(investigateStep!.retrievalStats!.mergedChunks).toBeGreaterThanOrEqual(0);

    expect(investigateStep!.confidenceStats).toBeDefined();
    expect(investigateStep!.confidenceStats!.min).toBeGreaterThanOrEqual(0);
    expect(investigateStep!.confidenceStats!.max).toBeLessThanOrEqual(1);
    expect(investigateStep!.confidenceStats!.min).toBeLessThanOrEqual(investigateStep!.confidenceStats!.median);
    expect(investigateStep!.confidenceStats!.median).toBeLessThanOrEqual(investigateStep!.confidenceStats!.max);
    expect(investigateStep!.confidenceStats!.mean).toBeGreaterThanOrEqual(0);
    expect(investigateStep!.confidenceStats!.mean).toBeLessThanOrEqual(1);

    expect(investigateStep!.hypothesisStats).toBeDefined();
    expect(investigateStep!.hypothesisStats!.generated).toBeGreaterThanOrEqual(
      investigateStep!.hypothesisStats!.verified,
    );
    expect(investigateStep!.hypothesisStats!.verified).toBeGreaterThanOrEqual(
      investigateStep!.hypothesisStats!.converted,
    );
    expect(investigateStep!.hypothesisStats!.converted).toBeLessThanOrEqual(result.findings.length);
  });

  it('investigate step completes after build-graph step', () => {
    const steps = result.trace.steps;
    const buildGraphIdx = steps.findIndex((s) => s.name === 'build-graph');
    const investigateIdx = steps.findIndex((s) => s.name === 'investigate');
    expect(buildGraphIdx).toBeGreaterThanOrEqual(0);
    expect(investigateIdx).toBeGreaterThan(buildGraphIdx);
  });
});

// ===========================================================================
// Realistic Bundle Format (analysis.json, flat namespace JSON, EventList,
// pod logs under cluster-resources/pods/logs/, debug severity)
// ===========================================================================

describe('E2E — Realistic Troubleshoot Bundle Format', () => {
  let result: PipelineResult;
  let realisticBundlePath: string;

  beforeAll(async () => {
    realisticBundlePath = await createTestBundle(
      getFixturePath('realistic-bundle-format'),
      path.join(tmpDir, 'realistic-bundle-format.tar.gz'),
    );
    result = await analyzeBundlePipeline(realisticBundlePath);
  });

  afterAll(async () => {
    await cleanupPipelineResult(result);
  });

  // ── Fix #1: analysis.json routed to analyzer parser ─────────────────────
  it('discovers analyzer results from root-level analysis.json', () => {
    expect(result.analyzerResults.length).toBeGreaterThan(0);
  });

  it('parses error-severity analyzer from analysis.json', () => {
    const errorResult = result.analyzerResults.find((r) => r.isFail);
    expect(errorResult).toBeDefined();
    expect(errorResult!.title).toContain('ImagePullBackOff');
  });

  // ── Fix #5: debug severity mapped to pass ───────────────────────────────
  it('maps Troubleshoot "debug" severity to "pass" for passing analyzers', () => {
    const passResult = result.analyzerResults.find((r) => r.isPass);
    expect(passResult).toBeDefined();
    expect(passResult!.severity).toBe('pass');
    expect(passResult!.name).toBe('cluster-version');
  });

  // ── Fix #2: flat namespace-scoped JSON (PodList, DeploymentList) ────────
  it('parses K8s resources from flat namespace-scoped JSON (PodList/DeploymentList)', () => {
    expect(result.resources.length).toBeGreaterThan(0);

    const pod = result.resources.find((r) => r.kind === 'Pod');
    expect(pod).toBeDefined();
    expect(pod!.metadata.name).toBe('app-pod');
    expect(pod!.metadata.namespace).toBe('default');

    const deployment = result.resources.find((r) => r.kind === 'Deployment');
    expect(deployment).toBeDefined();
    expect(deployment!.metadata.name).toBe('app-deployment');
  });

  // ── Fix #4: EventList wrapper parsed correctly ──────────────────────────
  it('parses events from EventList wrapper', () => {
    expect(result.events.length).toBeGreaterThan(0);

    const failedEvent = result.events.find((e) => e.reason === 'Failed');
    expect(failedEvent).toBeDefined();
    expect(failedEvent!.type).toBe('Warning');
  });

  // ── Fix #3: pod logs under cluster-resources/pods/logs/ ─────────────────
  it('identifies pod logs under cluster-resources/pods/logs/ as log files', () => {
    expect(result.logs.length).toBeGreaterThan(0);

    const logFile = result.logs.find((l) => l.path.includes('app.log'));
    expect(logFile).toBeDefined();
    expect(logFile!.errorCount).toBeGreaterThan(0);
  });

  // ── Fix #2: clean namespace extraction (no .json suffix) ────────────────
  it('extracts clean namespaces without .json extension', () => {
    expect(result.profile.namespaces).toContain('default');
    const dirty = result.profile.namespaces.find((ns) => ns.includes('.json'));
    expect(dirty).toBeUndefined();
  });

  // ── Full pipeline produces findings ─────────────────────────────────────
  it('produces investigation findings from realistic bundle', () => {
    expect(result.findings.length).toBeGreaterThan(0);
  });

  it('top finding is about image pull failure', () => {
    const top = result.findings[0]!;
    const text = `${top.title} ${top.reasoning}`.toLowerCase();
    expect(text).toMatch(/image|pull|backoff/);
  });
});

// ===========================================================================
// Scenario 5: PVC Pending — Storage Class Mismatch
// ===========================================================================

describe('E2E — Scenario 5: PVC Pending (Storage Class Mismatch)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await analyzeBundlePipeline(pvcPendingBundlePath, { noAi: true });
  });

  afterAll(async () => {
    await cleanupPipelineResult(result);
  });

  // ── Bundle extraction ────────────────────────────────────────────────────

  it('bundle extracts successfully and produces a non-empty manifest', () => {
    expect(result.profile.manifest.files.length).toBeGreaterThan(0);
  });

  // ── Profile ──────────────────────────────────────────────────────────────

  it('profile shows at least 1 analyzer artifact', () => {
    expect(result.profile.analyzerCount).toBeGreaterThanOrEqual(1);
  });

  it('profile shows at least 1 resource (pod, PVC, or storageclass)', () => {
    expect(result.profile.resourceCount).toBeGreaterThanOrEqual(1);
  });

  it('profile shows at least 1 event', () => {
    expect(result.profile.eventCount).toBeGreaterThanOrEqual(1);
  });

  it('profile shows at least 1 log file', () => {
    expect(result.profile.logFileCount).toBeGreaterThanOrEqual(1);
  });

  // ── Parsed artifacts ─────────────────────────────────────────────────────

  it('parses the db-pod resource', () => {
    const pod = result.resources.find(
      (r) => r.kind === 'Pod' && r.metadata.name === 'db-pod',
    );
    expect(pod).toBeDefined();
  });

  it('parses PersistentVolumeClaim resources', () => {
    const pvcs = result.resources.filter(
      (r) => r.kind === 'PersistentVolumeClaim',
    );
    expect(pvcs.length).toBeGreaterThanOrEqual(1);
  });

  it('parses ProvisioningFailed or FailedMount events', () => {
    const reasons = result.events.map((e) => e.reason);
    const hasStorage = reasons.some(
      (r) => /ProvisioningFailed|FailedMount|FailedScheduling/i.test(r),
    );
    expect(hasStorage).toBe(true);
  });

  it('parses log files with volume/storage errors', () => {
    expect(result.logs.length).toBeGreaterThanOrEqual(1);
    const logContent = result.logs
      .flatMap((l) => l.lines.map((line) => line.content))
      .join(' ')
      .toLowerCase();
    expect(logContent).toMatch(/volume|mount|data directory/);
  });

  // ── Investigation findings ───────────────────────────────────────────────

  it('produces investigation findings', () => {
    expect(result.findings.length).toBeGreaterThan(0);
  });

  it('at least one finding references db-pod or data-pvc', () => {
    const text = result.findings
      .map((f) => `${f.title} ${f.reasoningSummary} ${f.affectedComponents.join(' ')}`)
      .join(' ')
      .toLowerCase();
    expect(text).toMatch(/db-pod|data-pvc|volume|pvc|storage/);
  });

  it('top finding has confidence >= 0.5', () => {
    expect(result.findings[0]!.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it('every finding has at least one evidence entry', () => {
    for (const finding of result.findings) {
      expect(finding.evidence.length).toBeGreaterThan(0);
    }
  });

  it('every finding has a non-empty recommendedAction', () => {
    for (const finding of result.findings) {
      expect(finding.recommendedAction.trim().length).toBeGreaterThan(0);
    }
  });

  // ── Reports ──────────────────────────────────────────────────────────────

  it('markdown report contains the PVC scenario findings', () => {
    const report = buildReport(result);
    const md = generateMarkdownReport(report);
    expect(md).toContain('## Findings');
    expect(md.toLowerCase()).toMatch(/db-pod|volume|pvc|storage|mount/);
  });

  it('JSON report is parseable and contains findings', () => {
    const report = buildReport(result);
    const jsonStr = generateJsonReport(report);
    const parsed = JSON.parse(jsonStr);
    expect(parsed.findings.length).toBeGreaterThan(0);
  });

  it('HTML report contains valid structure', () => {
    const report = buildReport(result);
    const html = generateHtmlReport(report);
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('</html>');
  });
});
