import { describe, it, expect } from 'vitest';
import type { Finding, Evidence, FindingSeverity } from '../../types/index.js';
import type { InvestigatorContext } from '../types.js';
import type { BundleProfile, K8sResource, K8sEvent } from '../../types/index.js';
import type { LogFile, LogLine } from '../../parsers/index.js';
import { classifyLogLevel } from '../../parsers/index.js';
import { verifyFindings } from '../verifier.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeProfile(): BundleProfile {
  return {
    manifest: {
      bundlePath: '',
      extractedPath: '',
      files: [],
      totalSize: 0,
      extractedAt: new Date(),
    },
    analyzerCount: 0,
    logFileCount: 0,
    resourceCount: 0,
    eventCount: 0,
    namespaces: [],
    workloads: [],
    coverageGaps: [],
    artifactsByCategory: {
      analyzer: 0,
      log: 0,
      'kubernetes-resource': 0,
      event: 0,
      config: 0,
      'cluster-info': 0,
      'helm-release': 0,
      unknown: 0,
    },
  };
}

function makeContext(partial: Partial<InvestigatorContext> = {}): InvestigatorContext {
  return {
    analyzerResults: [],
    resources: [],
    events: [],
    logs: [] as LogFile[],
    profile: makeProfile(),
    ...partial,
  };
}

function makeLogLine(content: string, lineNumber: number): LogLine {
  return { lineNumber, content, level: classifyLogLevel(content) };
}

function makeLogFile(path: string, lines: string[]): LogFile {
  const logLines = lines.map((c, i) => makeLogLine(c, i + 1));
  const errorCount = logLines.filter((l) => l.level === 'error').length;
  const warningCount = logLines.filter((l) => l.level === 'warning').length;
  return { path, lines: logLines, errorCount, warningCount, importance: 0.5 };
}

/** Builds a minimal valid Finding with sensible defaults. */
function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'finding:test:0',
    title: 'Test Finding',
    severity: 'high' as FindingSeverity,
    confidence: 0.75,
    affectedComponents: [],
    reasoningSummary: 'Test reasoning.',
    evidence: [
      { path: 'cluster-resources/pods/default/app-pod.yaml', note: 'Pod is unhealthy', artifactType: 'kubernetes-resource' },
    ],
    contradictionsChecked: ['Initial check: pod status inspected'],
    recommendedAction: 'Take action.',
    missingEvidence: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Shared resource fixtures
// ---------------------------------------------------------------------------

/** A Pod that is Ready=True (healthy). */
const healthyPod: K8sResource = {
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: { name: 'app-pod', namespace: 'default' },
  spec: {},
  status: {
    phase: 'Running',
    conditions: [{ type: 'Ready', status: 'True' }],
    containerStatuses: [
      { name: 'app', ready: true, restartCount: 0, state: { running: {} } },
    ],
  },
};

/** A Pod that is NOT Ready and has CrashLoopBackOff. */
const crashLoopPod: K8sResource = {
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: { name: 'app-pod', namespace: 'default' },
  spec: {},
  status: {
    phase: 'Running',
    conditions: [{ type: 'Ready', status: 'False' }],
    containerStatuses: [
      {
        name: 'app',
        ready: false,
        restartCount: 8,
        state: { waiting: { reason: 'CrashLoopBackOff', message: 'back-off' } },
      },
    ],
  },
};

/** A Pod that is NOT Ready and has zero restarts. */
const zeroRestartPod: K8sResource = {
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: { name: 'app-pod', namespace: 'default' },
  spec: {},
  status: {
    phase: 'Running',
    conditions: [{ type: 'Ready', status: 'False' }],
    containerStatuses: [
      {
        name: 'app',
        ready: false,
        restartCount: 0,
        state: { waiting: { reason: 'CrashLoopBackOff', message: 'back-off' } },
      },
    ],
  },
};

/** A healthy Deployment (readyReplicas == replicas). */
const healthyDeployment: K8sResource = {
  apiVersion: 'apps/v1',
  kind: 'Deployment',
  metadata: { name: 'app-deployment', namespace: 'default' },
  spec: { replicas: 2 },
  status: { replicas: 2, readyReplicas: 2, availableReplicas: 2 },
};

/** An unhealthy Deployment (readyReplicas < replicas). */
const unhealthyDeployment: K8sResource = {
  apiVersion: 'apps/v1',
  kind: 'Deployment',
  metadata: { name: 'app-deployment', namespace: 'default' },
  spec: { replicas: 2 },
  status: { replicas: 2, readyReplicas: 0, availableReplicas: 0 },
};

// ---------------------------------------------------------------------------
// Scenario A: Contradiction detection — pod with Ready=True
// ---------------------------------------------------------------------------

describe('verifyFindings — pod Ready=True contradicts not-ready finding', () => {
  const finding = makeFinding({
    id: 'finding:k8s:notready:0',
    title: "Not Ready Pod: 'app-pod' in namespace 'default' (Running but not Ready)",
    affectedComponents: ['Pod/default/app-pod'],
    confidence: 0.75,
  });
  const context = makeContext({ resources: [healthyPod] });
  const result = verifyFindings([finding], context);

  it('returns exactly one finding', () => {
    expect(result).toHaveLength(1);
  });

  it('appends a Ready=True contradiction to contradictionsChecked', () => {
    const checks = result[0]!.contradictionsChecked.join(' ').toLowerCase();
    expect(checks).toContain("ready=true");
  });

  it('preserves the original contradiction entries', () => {
    expect(result[0]!.contradictionsChecked).toContain('Initial check: pod status inspected');
  });

  it('reduces confidence due to the contradiction', () => {
    expect(result[0]!.confidence).toBeLessThan(finding.confidence);
  });

  it('confidence remains in [0, 1]', () => {
    const c = result[0]!.confidence;
    expect(c).toBeGreaterThanOrEqual(0);
    expect(c).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Scenario B: Contradiction detection — CrashLoopBackOff with restartCount=0
// ---------------------------------------------------------------------------

describe('verifyFindings — CrashLoopBackOff contradicted by restartCount=0', () => {
  const finding = makeFinding({
    id: 'finding:k8s:crashloop:0',
    title: "CrashLoopBackOff: Pod 'app-pod' in namespace 'default'",
    affectedComponents: ['Pod/default/app-pod', 'Container/app'],
    confidence: 0.75,
    contradictionsChecked: [],
  });
  const context = makeContext({ resources: [zeroRestartPod] });
  const result = verifyFindings([finding], context);

  it('appends a restartCount=0 contradiction', () => {
    const checks = result[0]!.contradictionsChecked.join(' ').toLowerCase();
    expect(checks).toContain('restartcount=0');
  });

  it('reduces confidence', () => {
    expect(result[0]!.confidence).toBeLessThan(0.75);
  });
});

// ---------------------------------------------------------------------------
// Scenario C: No contradiction when pod truly is unhealthy
// ---------------------------------------------------------------------------

describe('verifyFindings — no spurious contradiction for genuinely crashed pod', () => {
  const finding = makeFinding({
    id: 'finding:k8s:crashloop:0',
    title: "CrashLoopBackOff: Pod 'app-pod' in namespace 'default'",
    affectedComponents: ['Pod/default/app-pod'],
    confidence: 0.85,
    contradictionsChecked: [],
  });
  const context = makeContext({ resources: [crashLoopPod] });
  const result = verifyFindings([finding], context);

  it('does NOT add a Ready=True contradiction', () => {
    const checks = result[0]!.contradictionsChecked.join(' ').toLowerCase();
    expect(checks).not.toContain("ready=true");
  });

  it('does NOT add a restartCount=0 contradiction', () => {
    const checks = result[0]!.contradictionsChecked.join(' ').toLowerCase();
    expect(checks).not.toContain('restartcount=0');
  });
});

// ---------------------------------------------------------------------------
// Scenario D: Workload contradiction — deployment actually healthy
// ---------------------------------------------------------------------------

describe('verifyFindings — workload Ready=True contradicts unhealthy-workload finding', () => {
  const finding = makeFinding({
    id: 'finding:k8s:workload:0',
    title: "Unhealthy Workload: Deployment 'app-deployment' in namespace 'default'",
    affectedComponents: ['Deployment/default/app-deployment'],
    confidence: 0.70,
    contradictionsChecked: [],
  });
  const context = makeContext({ resources: [healthyDeployment] });
  const result = verifyFindings([finding], context);

  it('appends a healthy-deployment contradiction', () => {
    const checks = result[0]!.contradictionsChecked.join(' ').toLowerCase();
    expect(checks).toContain("app-deployment");
    expect(checks).toContain("ready replicas");
  });

  it('reduces confidence', () => {
    expect(result[0]!.confidence).toBeLessThan(0.70);
  });
});

// ---------------------------------------------------------------------------
// Scenario E: Workload contradiction — deployment still unhealthy
// ---------------------------------------------------------------------------

describe('verifyFindings — no contradiction when workload is still unhealthy', () => {
  const finding = makeFinding({
    id: 'finding:k8s:workload:0',
    title: "Unhealthy Workload: Deployment 'app-deployment' in namespace 'default'",
    affectedComponents: ['Deployment/default/app-deployment'],
    confidence: 0.70,
    contradictionsChecked: [],
  });
  const context = makeContext({ resources: [unhealthyDeployment] });
  const result = verifyFindings([finding], context);

  it('does NOT add a healthy-deployment contradiction', () => {
    const checks = result[0]!.contradictionsChecked.join(' ').toLowerCase();
    expect(checks).not.toContain('ready replicas');
  });
});

// ---------------------------------------------------------------------------
// Scenario F: Pod/workload health contradictions are issue-aware
// ---------------------------------------------------------------------------

describe('verifyFindings — healthy pod does not contradict a missing-secret finding', () => {
  const finding = makeFinding({
    id: 'finding:config:missing-secret:0',
    title: "Missing Secret: Pod 'app-pod' references non-existent secret(s) in namespace 'default'",
    affectedComponents: ['Pod/default/app-pod', 'Secret/default/app-credentials'],
    confidence: 0.85,
    contradictionsChecked: [],
  });
  const context = makeContext({ resources: [healthyPod] });
  const result = verifyFindings([finding], context);

  it('does NOT add a Ready=True contradiction', () => {
    const checks = result[0]!.contradictionsChecked.join(' ').toLowerCase();
    expect(checks).not.toContain('ready=true');
  });
});

describe('verifyFindings — healthy workload does not contradict an image-mismatch finding', () => {
  const finding = makeFinding({
    id: 'finding:config:image-mismatch:0',
    title: "Image Tag Mismatch: Container 'app' in pod 'app-pod' (namespace 'default')",
    affectedComponents: [
      'Deployment/default/app-deployment',
      'Pod/default/app-pod',
      'Container/app',
      'Image/spec:myapp:v2',
      'Image/status:myapp:v1',
    ],
    confidence: 0.70,
    contradictionsChecked: [],
  });
  const context = makeContext({ resources: [healthyDeployment, healthyPod] });
  const result = verifyFindings([finding], context);

  it('does NOT add a workload-ready contradiction', () => {
    const checks = result[0]!.contradictionsChecked.join(' ').toLowerCase();
    expect(checks).not.toContain('ready replicas');
  });

  it('does NOT add a pod Ready=True contradiction', () => {
    const checks = result[0]!.contradictionsChecked.join(' ').toLowerCase();
    expect(checks).not.toContain('ready=true');
  });
});

// ---------------------------------------------------------------------------
// Scenario G: Log contradiction — DNS failure with successful connection lines
// ---------------------------------------------------------------------------

describe('verifyFindings — successful connection contradicts DNS-failure finding', () => {
  const logPath = 'pods/default/app/app.log';
  const logFile = makeLogFile(logPath, [
    'error dial tcp: lookup db.internal: no such host',
    'info successfully connected to backup-db.internal',
    'error no such host: db.internal',
  ]);

  const finding = makeFinding({
    id: 'finding:log:dns:0',
    title: `DNS Resolution Failures in ${logPath}`,
    affectedComponents: [logPath, 'DNS/db.internal'],
    confidence: 0.80,
    evidence: [{ path: logPath, note: 'Line 1: dial tcp: lookup...', artifactType: 'log' }],
    contradictionsChecked: [],
  });
  const context = makeContext({ logs: [logFile] });
  const result = verifyFindings([finding], context);

  it('appends an intermittent-failure contradiction', () => {
    const checks = result[0]!.contradictionsChecked.join(' ').toLowerCase();
    expect(checks).toContain('successful connection');
  });

  it('reduces confidence', () => {
    expect(result[0]!.confidence).toBeLessThan(0.80);
  });
});

// ---------------------------------------------------------------------------
// Scenario G: No log contradiction when log contains only failures
// ---------------------------------------------------------------------------

describe('verifyFindings — no contradiction when log has only DNS failures', () => {
  const logPath = 'pods/default/app/app.log';
  const logFile = makeLogFile(logPath, [
    'error dial tcp: lookup db.internal: no such host',
    'error connection refused to db.internal:5432',
  ]);

  const finding = makeFinding({
    id: 'finding:log:dns:0',
    title: `DNS Resolution Failures in ${logPath}`,
    affectedComponents: [logPath],
    confidence: 0.80,
    evidence: [{ path: logPath, note: 'Line 1: lookup failed', artifactType: 'log' }],
    contradictionsChecked: [],
  });
  const context = makeContext({ logs: [logFile] });
  const result = verifyFindings([finding], context);

  it('does NOT add a contradiction', () => {
    const checks = result[0]!.contradictionsChecked;
    expect(checks).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario H: Confidence boost for multiple independent evidence paths
// ---------------------------------------------------------------------------

describe('verifyFindings — confidence boost for 3 independent evidence paths', () => {
  const finding = makeFinding({
    confidence: 0.75,
    contradictionsChecked: [],
    evidence: [
      { path: 'pods/default/app-pod.yaml', note: 'Pod status', artifactType: 'kubernetes-resource' },
      { path: 'events/default.json', note: 'BackOff events', artifactType: 'event' },
      { path: 'pods/default/app/app.log', note: 'Container log', artifactType: 'log' },
    ],
  });
  const context = makeContext();
  const result = verifyFindings([finding], context);

  it('boosts confidence when 3 independent evidence paths exist', () => {
    // +0.10 boost for 3+ paths, no contradictions, no single-item penalty
    expect(result[0]!.confidence).toBeGreaterThan(0.75);
  });

  it('confidence does not exceed 1.0', () => {
    expect(result[0]!.confidence).toBeLessThanOrEqual(1.0);
  });
});

// ---------------------------------------------------------------------------
// Scenario I: Confidence boost for 2 independent evidence paths
// ---------------------------------------------------------------------------

describe('verifyFindings — confidence boost for 2 independent evidence paths', () => {
  const finding = makeFinding({
    confidence: 0.75,
    contradictionsChecked: [],
    evidence: [
      { path: 'pods/default/app-pod.yaml', note: 'Pod status', artifactType: 'kubernetes-resource' },
      { path: 'events/default.json', note: 'BackOff events', artifactType: 'event' },
    ],
  });
  const context = makeContext();
  const result = verifyFindings([finding], context);

  it('boosts confidence by 0.05 for 2 paths', () => {
    // +0.05 boost, no contradictions, no single-item penalty
    expect(result[0]!.confidence).toBeCloseTo(0.80, 5);
  });
});

// ---------------------------------------------------------------------------
// Scenario J: Confidence penalty for thin evidence (single item)
// ---------------------------------------------------------------------------

describe('verifyFindings — confidence penalty for single evidence item', () => {
  const finding = makeFinding({
    confidence: 0.75,
    contradictionsChecked: [],
    evidence: [
      { path: 'pods/default/app-pod.yaml', note: 'Pod status', artifactType: 'kubernetes-resource' },
    ],
  });
  const context = makeContext();
  const result = verifyFindings([finding], context);

  it('reduces confidence by 0.05 for single evidence item', () => {
    // −0.05 for thin evidence (single path = single item penalty)
    expect(result[0]!.confidence).toBeCloseTo(0.70, 5);
  });
});

// ---------------------------------------------------------------------------
// Scenario K: Missing evidence — CrashLoopBackOff with no pod log files
// ---------------------------------------------------------------------------

describe('verifyFindings — missing evidence for CrashLoopBackOff without logs', () => {
  const finding = makeFinding({
    id: 'finding:k8s:crashloop:0',
    title: "CrashLoopBackOff: Pod 'app-pod' in namespace 'default'",
    affectedComponents: ['Pod/default/app-pod', 'Container/app'],
    missingEvidence: [],
    contradictionsChecked: [],
  });
  const context = makeContext({ logs: [] }); // no log files
  const result = verifyFindings([finding], context);

  it('adds a missing-log-files entry to missingEvidence', () => {
    const missing = result[0]!.missingEvidence.join(' ').toLowerCase();
    expect(missing).toContain('app-pod');
    expect(missing).toContain('log');
  });
});

// ---------------------------------------------------------------------------
// Scenario K2: Missing evidence not duplicated when already present
// ---------------------------------------------------------------------------

describe('verifyFindings — does not duplicate existing missing evidence entries', () => {
  const existingEntry = `Container log files for pod 'app-pod' in namespace 'default' — needed to determine the root crash reason`;
  const finding = makeFinding({
    id: 'finding:k8s:crashloop:0',
    title: "CrashLoopBackOff: Pod 'app-pod' in namespace 'default'",
    affectedComponents: ['Pod/default/app-pod', 'Container/app'],
    missingEvidence: [existingEntry],
    contradictionsChecked: [],
  });
  const context = makeContext({ logs: [] });
  const result = verifyFindings([finding], context);

  it('does not duplicate an already-recorded missing evidence entry', () => {
    const matching = result[0]!.missingEvidence.filter((m) => m === existingEntry);
    expect(matching).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Scenario L: Missing evidence — not-ready pod with no events
// ---------------------------------------------------------------------------

describe('verifyFindings — missing evidence for not-ready pod without events', () => {
  const finding = makeFinding({
    id: 'finding:k8s:notready:0',
    title: "Not Ready Pod: 'app-pod' in namespace 'default' (Running but not Ready)",
    affectedComponents: ['Pod/default/app-pod'],
    missingEvidence: [],
    contradictionsChecked: [],
    evidence: [
      { path: 'cluster-resources/pods/default/app-pod.yaml', note: 'Pod is Running but not Ready', artifactType: 'kubernetes-resource' },
    ],
  });
  const context = makeContext({ events: [] }); // no events
  const result = verifyFindings([finding], context);

  it('adds a missing-events entry to missingEvidence', () => {
    const missing = result[0]!.missingEvidence.join(' ').toLowerCase();
    expect(missing).toContain('event');
    expect(missing).toContain('app-pod');
  });
});

// ---------------------------------------------------------------------------
// Scenario M: Missing evidence NOT added when log file exists for pod
// ---------------------------------------------------------------------------

describe('verifyFindings — no missing-evidence for CrashLoopBackOff when log exists', () => {
  const finding = makeFinding({
    id: 'finding:k8s:crashloop:0',
    title: "CrashLoopBackOff: Pod 'app-pod' in namespace 'default'",
    affectedComponents: ['Pod/default/app-pod', 'Container/app'],
    missingEvidence: [],
    contradictionsChecked: [],
  });
  const logFile = makeLogFile(
    'pods/default/app-pod/app.log',
    ['error CrashLoopBackOff occurred'],
  );
  const context = makeContext({ logs: [logFile] });
  const result = verifyFindings([finding], context);

  it('does NOT add missing-log-files entry when a pod log file is present', () => {
    const missing = result[0]!.missingEvidence;
    const hasLogMissing = missing.some((m) => m.toLowerCase().includes('log'));
    expect(hasLogMissing).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scenario N: Deduplication — two findings with the same key are merged
// ---------------------------------------------------------------------------

describe('verifyFindings — deduplication: same issue, same component', () => {
  const finding1 = makeFinding({
    id: 'finding:k8s:crashloop:0',
    title: "CrashLoopBackOff: Pod 'app-pod' in namespace 'default'",
    affectedComponents: ['Pod/default/app-pod', 'Container/app'],
    confidence: 0.85,
    evidence: [
      {
        path: 'cluster-resources/pods/default/app-pod.yaml',
        note: 'Container is in CrashLoopBackOff with 8 restarts',
        artifactType: 'kubernetes-resource',
      },
    ],
    contradictionsChecked: ['restartCount confirmed > 0'],
    missingEvidence: [],
  });

  const finding2 = makeFinding({
    id: 'finding:log:crashloop:0',
    title: "CrashLoopBackOff: Pod 'app-pod' in namespace 'default'",
    affectedComponents: ['Pod/default/app-pod'],
    confidence: 0.70,
    evidence: [
      {
        path: 'pods/default/app-pod/app.log',
        note: 'Crash-related errors found in container log',
        artifactType: 'log',
      },
    ],
    contradictionsChecked: [],
    missingEvidence: [],
  });

  const context = makeContext({ resources: [crashLoopPod] });
  const result = verifyFindings([finding1, finding2], context);

  it('merges the two findings into one', () => {
    expect(result).toHaveLength(1);
  });

  it('merged finding has combined evidence from both findings', () => {
    const paths = result[0]!.evidence.map((e) => e.path);
    expect(paths.some((p) => p.includes('app-pod.yaml'))).toBe(true);
    expect(paths.some((p) => p.includes('app.log'))).toBe(true);
  });

  it('merged finding uses the higher confidence (with convergence boost)', () => {
    // Base confidence 0.85, convergence boost +0.05 → 0.90
    expect(result[0]!.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it('merged finding combines contradictionsChecked', () => {
    expect(result[0]!.contradictionsChecked).toContain('restartCount confirmed > 0');
  });

  it('merged finding keeps the higher-confidence finding\'s id and title', () => {
    expect(result[0]!.id).toBe('finding:k8s:crashloop:0');
    expect(result[0]!.title).toContain('CrashLoopBackOff');
  });

  it('merged affectedComponents contains entries from both findings', () => {
    const comps = result[0]!.affectedComponents;
    expect(comps).toContain('Pod/default/app-pod');
    expect(comps.some((c) => c.includes('Container'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scenario O: Deduplication — different components are NOT merged
// ---------------------------------------------------------------------------

describe('verifyFindings — deduplication: same issue type, different components not merged', () => {
  const finding1 = makeFinding({
    id: 'finding:k8s:crashloop:0',
    title: "CrashLoopBackOff: Pod 'pod-alpha' in namespace 'default'",
    affectedComponents: ['Pod/default/pod-alpha'],
    confidence: 0.85,
  });

  const finding2 = makeFinding({
    id: 'finding:k8s:crashloop:1',
    title: "CrashLoopBackOff: Pod 'pod-beta' in namespace 'default'",
    affectedComponents: ['Pod/default/pod-beta'],
    confidence: 0.80,
  });

  const context = makeContext();
  const result = verifyFindings([finding1, finding2], context);

  it('keeps both findings (different pods are separate issues)', () => {
    expect(result).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Scenario P: Deduplication — same component, different issue types not merged
// ---------------------------------------------------------------------------

describe('verifyFindings — deduplication: same component, different issue types not merged', () => {
  const finding1 = makeFinding({
    id: 'finding:k8s:crashloop:0',
    title: "CrashLoopBackOff: Pod 'app-pod' in namespace 'default'",
    affectedComponents: ['Pod/default/app-pod'],
    confidence: 0.85,
  });

  const finding2 = makeFinding({
    id: 'finding:k8s:notready:0',
    title: "Not Ready Pod: 'app-pod' in namespace 'default' (Running but not Ready)",
    affectedComponents: ['Pod/default/app-pod'],
    confidence: 0.75,
  });

  const context = makeContext();
  const result = verifyFindings([finding1, finding2], context);

  it('keeps both findings (CrashLoop ≠ not-ready)', () => {
    expect(result).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Scenario Q: Deduplication — duplicate evidence paths not doubled in merge
// ---------------------------------------------------------------------------

describe('verifyFindings — deduplication: shared evidence path+note is deduplicated', () => {
  const sharedEvidence: Evidence = {
    path: 'cluster-resources/pods/default/app-pod.yaml',
    note: 'Pod is in CrashLoopBackOff',
    artifactType: 'kubernetes-resource',
  };

  const finding1 = makeFinding({
    id: 'finding:k8s:crashloop:0',
    title: "CrashLoopBackOff: Pod 'app-pod' in namespace 'default'",
    affectedComponents: ['Pod/default/app-pod'],
    confidence: 0.85,
    evidence: [sharedEvidence],
    contradictionsChecked: [],
  });

  const finding2 = makeFinding({
    id: 'finding:log:crashloop:0',
    title: "CrashLoopBackOff: Pod 'app-pod' in namespace 'default'",
    affectedComponents: ['Pod/default/app-pod'],
    confidence: 0.70,
    evidence: [
      sharedEvidence, // same path+note
      { path: 'pods/default/app-pod/app.log', note: 'Log errors', artifactType: 'log' },
    ],
    contradictionsChecked: [],
  });

  const context = makeContext();
  const result = verifyFindings([finding1, finding2], context);

  it('merges to one finding', () => {
    expect(result).toHaveLength(1);
  });

  it('deduplicated evidence does not include the shared entry twice', () => {
    const podsYamlEvidence = result[0]!.evidence.filter(
      (e) => e.path === sharedEvidence.path && e.note === sharedEvidence.note,
    );
    expect(podsYamlEvidence).toHaveLength(1);
  });

  it('merged evidence includes the unique log entry', () => {
    expect(result[0]!.evidence.some((e) => e.path.includes('app.log'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scenario R: Deduplication prefers root components over first components
// ---------------------------------------------------------------------------

describe('verifyFindings — deduplication: image pull findings merge on shared image component', () => {
  const finding1 = makeFinding({
    id: 'finding:k8s:imagepull:0',
    title: "ImagePullBackOff: Pod 'app-pod' in namespace 'default' (image: myapp:v999)",
    affectedComponents: [
      'Pod/default/app-pod',
      'Container/app',
      'Image/myapp:v999',
    ],
    severity: 'critical',
    confidence: 0.90,
    evidence: [
      {
        path: 'cluster-resources/pods/default/app-pod.yaml',
        note: 'Container is waiting in ImagePullBackOff',
        artifactType: 'kubernetes-resource',
      },
    ],
    contradictionsChecked: [],
  });

  const finding2 = makeFinding({
    id: 'finding:log:imagepull:0',
    title: 'Image Pull Failures in pods/default/app-pod/app.log',
    affectedComponents: [
      'pods/default/app-pod/app.log',
      'Image/myapp:v999',
    ],
    severity: 'critical',
    confidence: 0.75,
    evidence: [
      {
        path: 'pods/default/app-pod/app.log',
        note: 'ErrImagePull for myapp:v999 found in log',
        artifactType: 'log',
      },
    ],
    contradictionsChecked: [],
  });

  const result = verifyFindings([finding1, finding2], makeContext());

  it('merges the findings even though their first affected components differ', () => {
    expect(result).toHaveLength(1);
  });

  it('preserves evidence from both investigators', () => {
    const paths = result[0]!.evidence.map((e) => e.path);
    expect(paths).toContain('cluster-resources/pods/default/app-pod.yaml');
    expect(paths).toContain('pods/default/app-pod/app.log');
  });

  it('retains the shared image component in the merged finding', () => {
    expect(result[0]!.affectedComponents).toContain('Image/myapp:v999');
  });
});

// ---------------------------------------------------------------------------
// Scenario S: Empty input returns empty output
// ---------------------------------------------------------------------------

describe('verifyFindings — empty input', () => {
  it('returns an empty array when given no findings', () => {
    const result = verifyFindings([], makeContext());
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario S: Output is sorted by confidence descending
// ---------------------------------------------------------------------------

describe('verifyFindings — output sorted by confidence descending', () => {
  const findings = [
    makeFinding({ id: 'f1', title: "CrashLoopBackOff: Pod 'pod-a'", affectedComponents: ['Pod/default/pod-a'], confidence: 0.60, evidence: [{ path: 'p1.yaml', note: 'n1', artifactType: 'kubernetes-resource' }], contradictionsChecked: [] }),
    makeFinding({ id: 'f2', title: "CrashLoopBackOff: Pod 'pod-b'", affectedComponents: ['Pod/default/pod-b'], confidence: 0.90, evidence: [{ path: 'p2.yaml', note: 'n2', artifactType: 'kubernetes-resource' }], contradictionsChecked: [] }),
    makeFinding({ id: 'f3', title: "CrashLoopBackOff: Pod 'pod-c'", affectedComponents: ['Pod/default/pod-c'], confidence: 0.75, evidence: [{ path: 'p3.yaml', note: 'n3', artifactType: 'kubernetes-resource' }], contradictionsChecked: [] }),
  ];

  const result = verifyFindings(findings, makeContext());

  it('first result has the highest confidence', () => {
    expect(result[0]!.confidence).toBeGreaterThanOrEqual(result[1]!.confidence);
  });

  it('last result has the lowest confidence', () => {
    expect(result[result.length - 1]!.confidence).toBeLessThanOrEqual(result[0]!.confidence);
  });

  it('all findings are present after sorting', () => {
    expect(result).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Scenario T: Convergence boost when merging two findings
// ---------------------------------------------------------------------------

describe('verifyFindings — convergence boost on merge', () => {
  const finding1 = makeFinding({
    id: 'finding:k8s:dns:0',
    title: 'DNS Resolution Failures in pod.log',
    affectedComponents: ['pod.log', 'DNS/db.internal'],
    confidence: 0.80,
    evidence: [{ path: 'pod.log', note: 'Line 1: no such host', artifactType: 'log' }],
    contradictionsChecked: [],
  });
  const finding2 = makeFinding({
    id: 'finding:log:dns:0',
    title: 'DNS Resolution Failures in pod.log',
    affectedComponents: ['pod.log'],
    confidence: 0.75,
    evidence: [{ path: 'pod.log', note: 'Line 3: NXDOMAIN', artifactType: 'log' }],
    contradictionsChecked: [],
  });

  const result = verifyFindings([finding1, finding2], makeContext());

  it('merges the two DNS findings into one', () => {
    expect(result).toHaveLength(1);
  });

  it('merged confidence is at least max(0.80, 0.75) + 0.05 convergence boost', () => {
    // single-item penalty applies to each before merge, then boost
    // finding1: 0.80 - 0.05 (thin) = 0.75; finding2: 0.75 - 0.05 (thin) = 0.70
    // max = 0.75 + 0.05 convergence = 0.80
    expect(result[0]!.confidence).toBeGreaterThanOrEqual(0.75);
  });
});

// ---------------------------------------------------------------------------
// Scenario U: Highest severity wins in merge
// ---------------------------------------------------------------------------

describe('verifyFindings — highest severity is preserved after merge', () => {
  const finding1 = makeFinding({
    id: 'finding:k8s:crashloop:0',
    title: "CrashLoopBackOff: Pod 'app-pod' in namespace 'default'",
    affectedComponents: ['Pod/default/app-pod'],
    severity: 'critical',
    confidence: 0.80,
    evidence: [{ path: 'pod.yaml', note: 'n1', artifactType: 'kubernetes-resource' }],
    contradictionsChecked: [],
  });
  const finding2 = makeFinding({
    id: 'finding:log:crashloop:0',
    title: "CrashLoopBackOff: Pod 'app-pod' in namespace 'default'",
    affectedComponents: ['Pod/default/app-pod'],
    severity: 'high',
    confidence: 0.70,
    evidence: [{ path: 'pod.log', note: 'n2', artifactType: 'log' }],
    contradictionsChecked: [],
  });

  const result = verifyFindings([finding1, finding2], makeContext());

  it('merged finding has severity critical (highest of critical and high)', () => {
    expect(result[0]!.severity).toBe('critical');
  });
});

// ---------------------------------------------------------------------------
// Scenario V: Namespace isolation — findings about same-named pod in different
//             namespaces are NOT merged
// ---------------------------------------------------------------------------

describe('verifyFindings — namespace isolation in deduplication', () => {
  const finding1 = makeFinding({
    id: 'finding:k8s:crashloop:0',
    title: "CrashLoopBackOff: Pod 'app-pod' in namespace 'default'",
    affectedComponents: ['Pod/default/app-pod'],
    confidence: 0.85,
    evidence: [{ path: 'pods/default/app-pod.yaml', note: 'n', artifactType: 'kubernetes-resource' }],
    contradictionsChecked: [],
  });
  const finding2 = makeFinding({
    id: 'finding:k8s:crashloop:1',
    title: "CrashLoopBackOff: Pod 'app-pod' in namespace 'prod'",
    affectedComponents: ['Pod/prod/app-pod'],
    confidence: 0.85,
    evidence: [{ path: 'pods/prod/app-pod.yaml', note: 'n', artifactType: 'kubernetes-resource' }],
    contradictionsChecked: [],
  });

  const result = verifyFindings([finding1, finding2], makeContext());

  it('keeps both findings (different namespaces = different root issues)', () => {
    expect(result).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Scenario W: No context resources — no spurious contradictions
// ---------------------------------------------------------------------------

describe('verifyFindings — empty context produces no contradictions', () => {
  const finding = makeFinding({
    title: "CrashLoopBackOff: Pod 'app-pod' in namespace 'default'",
    affectedComponents: ['Pod/default/app-pod'],
    confidence: 0.85,
    contradictionsChecked: ['pre-existing check'],
  });
  const context = makeContext({ resources: [], events: [], logs: [] });
  const result = verifyFindings([finding], context);

  it('only has the original pre-existing contradiction check', () => {
    expect(result[0]!.contradictionsChecked).toEqual(['pre-existing check']);
  });
});

// ---------------------------------------------------------------------------
// Scenario X: Integration — realistic k8s finding through full verifier
// ---------------------------------------------------------------------------

describe('verifyFindings — integration with realistic kubernetes finding', () => {
  const finding = makeFinding({
    id: 'finding:k8s:crashloop:0',
    title: "CrashLoopBackOff: Pod 'app-pod' in namespace 'default'",
    severity: 'critical',
    affectedComponents: ['Pod/default/app-pod', 'Container/app'],
    confidence: 0.95,
    evidence: [
      { path: 'cluster-resources/pods/default/app-pod.yaml', note: 'Container in CrashLoopBackOff with 8 restarts', artifactType: 'kubernetes-resource' },
      { path: 'cluster-resources/events/default.json', note: 'BackOff events', artifactType: 'event' },
    ],
    contradictionsChecked: ['restartCount confirmed > 0'],
    missingEvidence: [],
    recommendedAction: 'Check logs.',
  });

  const k8sEvents: K8sEvent[] = [
    {
      type: 'Warning',
      reason: 'BackOff',
      message: 'Back-off restarting failed container',
      involvedObject: { kind: 'Pod', name: 'app-pod', namespace: 'default' },
      count: 8,
      firstTimestamp: '2024-01-15T13:30:05Z',
      lastTimestamp: '2024-01-15T13:55:05Z',
    },
  ];

  const context = makeContext({
    resources: [crashLoopPod],
    events: k8sEvents,
    logs: [],
  });
  const result = verifyFindings([finding], context);

  it('returns exactly one finding', () => {
    expect(result).toHaveLength(1);
  });

  it('finding id is preserved', () => {
    expect(result[0]!.id).toBe('finding:k8s:crashloop:0');
  });

  it('finding severity is preserved', () => {
    expect(result[0]!.severity).toBe('critical');
  });

  it('finding confidence is still in [0, 1]', () => {
    const c = result[0]!.confidence;
    expect(c).toBeGreaterThanOrEqual(0);
    expect(c).toBeLessThanOrEqual(1);
  });

  it('evidence is unchanged (2 items)', () => {
    expect(result[0]!.evidence).toHaveLength(2);
  });

  it('pre-existing contradictionsChecked entry is preserved', () => {
    expect(result[0]!.contradictionsChecked).toContain('restartCount confirmed > 0');
  });

  it('adds missing-log-file entry since no logs are in context', () => {
    const missing = result[0]!.missingEvidence.join(' ').toLowerCase();
    expect(missing).toContain('log');
    expect(missing).toContain('app-pod');
  });

  it('recommendedAction is preserved', () => {
    expect(result[0]!.recommendedAction).toBe('Check logs.');
  });
});
