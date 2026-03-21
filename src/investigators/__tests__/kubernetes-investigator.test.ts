import { describe, it, expect } from 'vitest';
import type { InvestigatorContext, InvestigationSeed } from '../types.js';
import type { BundleProfile } from '../../types/index.js';
import type { K8sResource, K8sEvent } from '../../types/index.js';
import type { LogFile } from '../../parsers/index.js';
import { investigateKubernetes } from '../kubernetes-investigator.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Minimal BundleProfile — investigator does not inspect profile fields. */
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
      'cluster-info': 0,
      'helm-release': 0,
      unknown: 0,
    },
  };
}

/** Builds an empty InvestigatorContext. */
function makeContext(
  partial: Partial<InvestigatorContext> = {},
): InvestigatorContext {
  return {
    analyzerResults: [],
    resources: [],
    events: [],
    logs: [] as LogFile[],
    profile: makeProfile(),
    ...partial,
  };
}

/** A CrashLoopBackOff Pod resource (mirrors missing-secret-crashloop fixture). */
const crashLoopPod: K8sResource = {
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: { name: 'app-pod', namespace: 'default' },
  spec: {
    containers: [{ name: 'app', image: 'myapp:v1.2.3' }],
  },
  status: {
    phase: 'Running',
    conditions: [
      { type: 'Ready', status: 'False', reason: 'ContainersNotReady' },
    ],
    containerStatuses: [
      {
        name: 'app',
        ready: false,
        restartCount: 8,
        state: {
          waiting: { reason: 'CrashLoopBackOff', message: 'back-off 5m0s restarting failed container' },
        },
      },
    ],
  },
};

/** BackOff and FailedMount events matching the crashLoopPod scenario. */
const crashLoopEvents: K8sEvent[] = [
  {
    type: 'Warning',
    reason: 'BackOff',
    message: 'Back-off restarting failed container app in pod app-pod_default(uid)',
    involvedObject: { kind: 'Pod', name: 'app-pod', namespace: 'default' },
    count: 8,
    firstTimestamp: '2024-01-15T13:30:05Z',
    lastTimestamp: '2024-01-15T13:55:05Z',
  },
  {
    type: 'Warning',
    reason: 'FailedMount',
    message: 'MountVolume.SetUp failed for volume "app-credentials": secret "app-credentials" not found',
    involvedObject: { kind: 'Pod', name: 'app-pod', namespace: 'default' },
    count: 8,
    firstTimestamp: '2024-01-15T13:30:10Z',
    lastTimestamp: '2024-01-15T13:55:10Z',
  },
];

/** An ImagePullBackOff Pod resource (mirrors bad-image-tag fixture). */
const imagePullPod: K8sResource = {
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: { name: 'app-pod', namespace: 'default' },
  spec: {
    containers: [{ name: 'app', image: 'myapp:v999.99.99' }],
  },
  status: {
    phase: 'Pending',
    conditions: [
      { type: 'Ready', status: 'False', reason: 'ContainersNotReady' },
    ],
    containerStatuses: [
      {
        name: 'app',
        ready: false,
        restartCount: 0,
        state: {
          waiting: { reason: 'ImagePullBackOff', message: 'Back-off pulling image "myapp:v999.99.99"' },
        },
      },
    ],
  },
};

/** ErrImagePull and Failed pull events matching the imagePullPod scenario. */
const imagePullEvents: K8sEvent[] = [
  {
    type: 'Warning',
    reason: 'ErrImagePull',
    message: 'rpc error: code = NotFound desc = failed to pull image "myapp:v999.99.99": not found',
    involvedObject: { kind: 'Pod', name: 'app-pod', namespace: 'default' },
    count: 5,
    firstTimestamp: '2024-01-15T16:00:12Z',
    lastTimestamp: '2024-01-15T16:05:12Z',
  },
  {
    type: 'Warning',
    reason: 'Failed',
    message: 'Failed to pull image "myapp:v999.99.99": rpc error: code = NotFound',
    involvedObject: { kind: 'Pod', name: 'app-pod', namespace: 'default' },
    count: 5,
    firstTimestamp: '2024-01-15T16:00:10Z',
    lastTimestamp: '2024-01-15T16:05:10Z',
  },
];

/** A Not-Ready running Pod (mirrors wrong-db-endpoint fixture). */
const notReadyPod: K8sResource = {
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: { name: 'app-pod', namespace: 'default' },
  spec: {
    containers: [{ name: 'app', image: 'myapp:v1.2.3' }],
  },
  status: {
    phase: 'Running',
    conditions: [
      { type: 'Ready', status: 'False', reason: 'ContainersNotReady', message: 'containers with unready status: [app]' },
    ],
    containerStatuses: [
      {
        name: 'app',
        ready: false,
        restartCount: 0,
        state: { running: { startedAt: '2024-01-15T10:00:10Z' } },
      },
    ],
  },
};

/** Unhealthy events for the not-ready pod. */
const notReadyEvents: K8sEvent[] = [
  {
    type: 'Warning',
    reason: 'Unhealthy',
    message: 'Readiness probe failed: Get "http://10.0.0.5:8080/healthz": dial tcp 10.0.0.5:8080: connect: connection refused',
    involvedObject: { kind: 'Pod', name: 'app-pod', namespace: 'default' },
    count: 12,
    firstTimestamp: '2024-01-15T10:05:30Z',
    lastTimestamp: '2024-01-15T10:07:00Z',
  },
];

/** An unhealthy Deployment (mirrors missing-secret-crashloop fixture). */
const unhealthyDeployment: K8sResource = {
  apiVersion: 'apps/v1',
  kind: 'Deployment',
  metadata: { name: 'app-deployment', namespace: 'default' },
  spec: { replicas: 1 },
  status: {
    replicas: 1,
    updatedReplicas: 1,
    readyReplicas: 0,
    availableReplicas: 0,
  },
};

/** A healthy Deployment. */
const healthyDeployment: K8sResource = {
  apiVersion: 'apps/v1',
  kind: 'Deployment',
  metadata: { name: 'healthy-deploy', namespace: 'default' },
  spec: { replicas: 2 },
  status: {
    replicas: 2,
    readyReplicas: 2,
    availableReplicas: 2,
  },
};

/** A healthy Pod (all containers ready, Running phase). */
const healthyPod: K8sResource = {
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: { name: 'healthy-pod', namespace: 'default' },
  spec: { containers: [{ name: 'app', image: 'myapp:v1.0.0' }] },
  status: {
    phase: 'Running',
    conditions: [{ type: 'Ready', status: 'True' }],
    containerStatuses: [
      { name: 'app', ready: true, restartCount: 0, state: { running: {} } },
    ],
  },
};

/** Empty seeds — the investigator should work with zero seeds. */
const noSeeds: InvestigationSeed[] = [];

// ---------------------------------------------------------------------------
// Scenario 1 — CrashLoopBackOff
// ---------------------------------------------------------------------------

describe('investigateKubernetes — CrashLoopBackOff', () => {
  const context = makeContext({
    resources: [crashLoopPod],
    events: crashLoopEvents,
  });
  const result = investigateKubernetes(context, noSeeds);

  it('produces exactly one finding', () => {
    expect(result.findings).toHaveLength(1);
  });

  it('finding has severity critical', () => {
    expect(result.findings[0]!.severity).toBe('critical');
  });

  it('finding title references the pod name and CrashLoopBackOff', () => {
    const title = result.findings[0]!.title.toLowerCase();
    expect(title).toContain('crashloopbackoff');
    expect(title).toContain('app-pod');
  });

  it('confidence is in [0, 1]', () => {
    const c = result.findings[0]!.confidence;
    expect(c).toBeGreaterThanOrEqual(0);
    expect(c).toBeLessThanOrEqual(1);
  });

  it('confidence is ≥ 0.85 when corroborating events are present and restarts > 5', () => {
    // restartCount=8 + BackOff events + FailedMount → CONF_CRASHLOOP_FULL
    expect(result.findings[0]!.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it('evidence includes the pod file path', () => {
    const paths = result.findings[0]!.evidence.map((e) => e.path);
    expect(paths.some((p) => p.includes('pods/default/app-pod'))).toBe(true);
  });

  it('evidence includes an events file path for BackOff', () => {
    const notes = result.findings[0]!.evidence.map((e) => e.note.toLowerCase());
    expect(notes.some((n) => n.includes('backoff'))).toBe(true);
  });

  it('evidence includes an events file path for FailedMount', () => {
    const notes = result.findings[0]!.evidence.map((e) => e.note.toLowerCase());
    expect(notes.some((n) => n.includes('failedmount') || n.includes('missing'))).toBe(true);
  });

  it('contradictionsChecked is non-empty', () => {
    expect(result.findings[0]!.contradictionsChecked.length).toBeGreaterThan(0);
  });

  it('recommendedAction is non-empty', () => {
    expect(result.findings[0]!.recommendedAction).toBeTruthy();
  });

  it('affectedComponents includes the pod and container', () => {
    const comps = result.findings[0]!.affectedComponents;
    expect(comps.some((c) => c.includes('app-pod'))).toBe(true);
    expect(comps.some((c) => c.includes('app'))).toBe(true);
  });

  it('produces graph edges linking evidence to the finding', () => {
    expect(result.edges.length).toBeGreaterThan(0);
    const findingId = result.findings[0]!.id;
    const supportEdges = result.edges.filter(
      (e) => e.target === findingId && e.type === 'supports',
    );
    expect(supportEdges.length).toBeGreaterThan(0);
  });

  it('produces a correlates edge between BackOff and FailedMount evidence', () => {
    const correlates = result.edges.filter((e) => e.type === 'correlates');
    expect(correlates.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 1b — CrashLoopBackOff without events (lower confidence)
// ---------------------------------------------------------------------------

describe('investigateKubernetes — CrashLoopBackOff without events', () => {
  const context = makeContext({ resources: [crashLoopPod], events: [] });
  const result = investigateKubernetes(context, noSeeds);

  it('still produces a finding', () => {
    expect(result.findings).toHaveLength(1);
  });

  it('confidence is lower when no events are present', () => {
    // No events → CONF_CRASHLOOP_BASE (0.75)
    expect(result.findings[0]!.confidence).toBeLessThan(0.85);
  });

  it('missingEvidence lists BackOff events', () => {
    const missing = result.findings[0]!.missingEvidence;
    expect(missing.some((m) => m.toLowerCase().includes('backoff') || m.toLowerCase().includes('back'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2 — ImagePullBackOff
// ---------------------------------------------------------------------------

describe('investigateKubernetes — ImagePullBackOff', () => {
  const context = makeContext({
    resources: [imagePullPod],
    events: imagePullEvents,
  });
  const result = investigateKubernetes(context, noSeeds);

  it('produces exactly one finding', () => {
    expect(result.findings).toHaveLength(1);
  });

  it('finding has severity critical', () => {
    expect(result.findings[0]!.severity).toBe('critical');
  });

  it('finding title references ImagePullBackOff and the image tag', () => {
    const title = result.findings[0]!.title;
    expect(title.toLowerCase()).toContain('imagepullbackoff');
    expect(title).toContain('v999.99.99');
  });

  it('confidence is in [0, 1]', () => {
    const c = result.findings[0]!.confidence;
    expect(c).toBeGreaterThanOrEqual(0);
    expect(c).toBeLessThanOrEqual(1);
  });

  it('confidence is high when ErrImagePull events are present', () => {
    expect(result.findings[0]!.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('evidence includes the pod file path', () => {
    const paths = result.findings[0]!.evidence.map((e) => e.path);
    expect(paths.some((p) => p.includes('pods/default/app-pod'))).toBe(true);
  });

  it('evidence note includes the image tag', () => {
    const notes = result.findings[0]!.evidence.map((e) => e.note);
    expect(notes.some((n) => n.includes('v999.99.99'))).toBe(true);
  });

  it('evidence includes ErrImagePull event note', () => {
    const notes = result.findings[0]!.evidence.map((e) => e.note.toLowerCase());
    expect(notes.some((n) => n.includes('errimagepull'))).toBe(true);
  });

  it('evidence includes Failed pull event note', () => {
    const notes = result.findings[0]!.evidence.map((e) => e.note.toLowerCase());
    expect(notes.some((n) => n.includes('failed'))).toBe(true);
  });

  it('contradictionsChecked is non-empty', () => {
    expect(result.findings[0]!.contradictionsChecked.length).toBeGreaterThan(0);
  });

  it('affectedComponents includes the image', () => {
    const comps = result.findings[0]!.affectedComponents;
    expect(comps.some((c) => c.includes('v999.99.99'))).toBe(true);
  });

  it('produces graph edges with supports type', () => {
    const findingId = result.findings[0]!.id;
    const supportEdges = result.edges.filter(
      (e) => e.target === findingId && e.type === 'supports',
    );
    expect(supportEdges.length).toBeGreaterThan(0);
  });

  it('produces a correlates edge between ErrImagePull and Failed evidence', () => {
    const correlates = result.edges.filter((e) => e.type === 'correlates');
    expect(correlates.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2b — ImagePullBackOff without events
// ---------------------------------------------------------------------------

describe('investigateKubernetes — ImagePullBackOff without events', () => {
  const context = makeContext({ resources: [imagePullPod], events: [] });
  const result = investigateKubernetes(context, noSeeds);

  it('still produces a finding', () => {
    expect(result.findings).toHaveLength(1);
  });

  it('confidence is lower without events', () => {
    expect(result.findings[0]!.confidence).toBeLessThan(0.9);
  });

  it('missingEvidence lists ErrImagePull or Failed events', () => {
    const missing = result.findings[0]!.missingEvidence;
    expect(missing.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3 — Not-ready pod (Running phase)
// ---------------------------------------------------------------------------

describe('investigateKubernetes — Not-ready pod (Running phase)', () => {
  const context = makeContext({
    resources: [notReadyPod],
    events: notReadyEvents,
  });
  const result = investigateKubernetes(context, noSeeds);

  it('produces exactly one finding', () => {
    expect(result.findings).toHaveLength(1);
  });

  it('finding has severity high', () => {
    expect(result.findings[0]!.severity).toBe('high');
  });

  it('finding title references the pod name and not-ready status', () => {
    const title = result.findings[0]!.title.toLowerCase();
    expect(title).toContain('not ready');
    expect(title).toContain('app-pod');
  });

  it('confidence is in [0, 1]', () => {
    const c = result.findings[0]!.confidence;
    expect(c).toBeGreaterThanOrEqual(0);
    expect(c).toBeLessThanOrEqual(1);
  });

  it('confidence is elevated when Unhealthy events are present', () => {
    // CONF_NOT_READY_EVENTS = 0.75
    expect(result.findings[0]!.confidence).toBeGreaterThanOrEqual(0.70);
  });

  it('evidence includes the pod file path', () => {
    const paths = result.findings[0]!.evidence.map((e) => e.path);
    expect(paths.some((p) => p.includes('pods/default/app-pod'))).toBe(true);
  });

  it('evidence includes Unhealthy event note', () => {
    const notes = result.findings[0]!.evidence.map((e) => e.note.toLowerCase());
    expect(notes.some((n) => n.includes('unhealthy') || n.includes('readiness'))).toBe(true);
  });

  it('contradictionsChecked mentions Running phase', () => {
    const checks = result.findings[0]!.contradictionsChecked.join(' ').toLowerCase();
    expect(checks).toContain('running');
  });

  it('produces graph edges supporting the finding', () => {
    const findingId = result.findings[0]!.id;
    const supportEdges = result.edges.filter(
      (e) => e.target === findingId && e.type === 'supports',
    );
    expect(supportEdges.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3b — Not-ready pod without events
// ---------------------------------------------------------------------------

describe('investigateKubernetes — Not-ready pod without events', () => {
  const context = makeContext({ resources: [notReadyPod], events: [] });
  const result = investigateKubernetes(context, noSeeds);

  it('still produces a finding', () => {
    expect(result.findings).toHaveLength(1);
  });

  it('confidence is lower without events', () => {
    // CONF_NOT_READY_BASE = 0.60
    expect(result.findings[0]!.confidence).toBeLessThan(0.75);
  });

  it('missingEvidence lists Unhealthy events', () => {
    const missing = result.findings[0]!.missingEvidence;
    expect(missing.some((m) => m.toLowerCase().includes('unhealthy'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scenario 4 — Unhealthy Deployment
// ---------------------------------------------------------------------------

describe('investigateKubernetes — Unhealthy Deployment', () => {
  const context = makeContext({
    resources: [unhealthyDeployment],
    events: [],
  });
  const result = investigateKubernetes(context, noSeeds);

  it('produces exactly one finding', () => {
    expect(result.findings).toHaveLength(1);
  });

  it('finding has severity high', () => {
    expect(result.findings[0]!.severity).toBe('high');
  });

  it('finding title references the Deployment name and unhealthy status', () => {
    const title = result.findings[0]!.title.toLowerCase();
    expect(title).toContain('unhealthy');
    expect(title).toContain('app-deployment');
  });

  it('confidence is in [0, 1]', () => {
    const c = result.findings[0]!.confidence;
    expect(c).toBeGreaterThanOrEqual(0);
    expect(c).toBeLessThanOrEqual(1);
  });

  it('evidence includes the deployment file path', () => {
    const paths = result.findings[0]!.evidence.map((e) => e.path);
    expect(paths.some((p) => p.includes('deployments/default/app-deployment'))).toBe(true);
  });

  it('affectedComponents includes the Deployment', () => {
    const comps = result.findings[0]!.affectedComponents;
    expect(comps.some((c) => c.includes('app-deployment'))).toBe(true);
  });

  it('produces a supports edge from evidence to finding', () => {
    const findingId = result.findings[0]!.id;
    const supportEdges = result.edges.filter(
      (e) => e.target === findingId && e.type === 'supports',
    );
    expect(supportEdges.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 5 — Healthy pod and workload — no findings
// ---------------------------------------------------------------------------

describe('investigateKubernetes — healthy resources produce no findings', () => {
  it('returns no findings for a healthy pod', () => {
    const context = makeContext({ resources: [healthyPod] });
    const result = investigateKubernetes(context, noSeeds);
    expect(result.findings).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
  });

  it('returns no findings for a healthy deployment', () => {
    const context = makeContext({ resources: [healthyDeployment] });
    const result = investigateKubernetes(context, noSeeds);
    expect(result.findings).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
  });

  it('returns no findings for empty context', () => {
    const context = makeContext();
    const result = investigateKubernetes(context, noSeeds);
    expect(result.findings).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 6 — CrashLoopBackOff pod does NOT generate a not-ready finding
// ---------------------------------------------------------------------------

describe('investigateKubernetes — CrashLoopBackOff does not double-report as not-ready', () => {
  const context = makeContext({ resources: [crashLoopPod] });
  const result = investigateKubernetes(context, noSeeds);

  it('produces exactly one finding (not two)', () => {
    // Only CrashLoopBackOff; not-ready detector should skip it
    expect(result.findings).toHaveLength(1);
  });

  it('the single finding is a CrashLoopBackOff finding', () => {
    expect(result.findings[0]!.title.toLowerCase()).toContain('crashloopbackoff');
  });
});

// ---------------------------------------------------------------------------
// Scenario 7 — Combined context (crash + deployment)
// ---------------------------------------------------------------------------

describe('investigateKubernetes — combined context', () => {
  const context = makeContext({
    resources: [crashLoopPod, unhealthyDeployment],
    events: crashLoopEvents,
  });
  const result = investigateKubernetes(context, noSeeds);

  it('produces two findings (CrashLoop + unhealthy Deployment)', () => {
    expect(result.findings).toHaveLength(2);
  });

  it('all findings have confidence in [0, 1]', () => {
    for (const f of result.findings) {
      expect(f.confidence).toBeGreaterThanOrEqual(0);
      expect(f.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('all findings have non-empty evidence arrays', () => {
    for (const f of result.findings) {
      expect(f.evidence.length).toBeGreaterThan(0);
    }
  });

  it('all evidence paths are non-empty strings', () => {
    for (const f of result.findings) {
      for (const ev of f.evidence) {
        expect(ev.path).toBeTruthy();
        expect(typeof ev.path).toBe('string');
      }
    }
  });

  it('all findings have non-empty contradictionsChecked arrays', () => {
    for (const f of result.findings) {
      expect(f.contradictionsChecked.length).toBeGreaterThan(0);
    }
  });

  it('all findings have non-empty recommendedAction', () => {
    for (const f of result.findings) {
      expect(f.recommendedAction).toBeTruthy();
    }
  });

  it('all edges have non-empty id, source, and target', () => {
    for (const edge of result.edges) {
      expect(edge.id).toBeTruthy();
      expect(edge.source).toBeTruthy();
      expect(edge.target).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 8 — Seeds parameter does not affect finding production
// ---------------------------------------------------------------------------

describe('investigateKubernetes — seeds parameter', () => {
  it('produces findings regardless of seed content', () => {
    const seeds: InvestigationSeed[] = [
      {
        id: 'seed:pod:0',
        hypothesis: 'Pod app-pod is in CrashLoopBackOff',
        source: 'pod:default/app-pod',
        category: 'kubernetes',
        priority: 90,
      },
    ];
    const context = makeContext({ resources: [crashLoopPod] });
    const result = investigateKubernetes(context, seeds);
    expect(result.findings).toHaveLength(1);
  });

  it('produces same findings with empty seeds as with non-empty seeds', () => {
    const seeds: InvestigationSeed[] = [
      {
        id: 'seed:pod:0',
        hypothesis: 'Pod app-pod is in CrashLoopBackOff',
        source: 'pod:default/app-pod',
        category: 'kubernetes',
        priority: 90,
      },
    ];
    const context = makeContext({ resources: [crashLoopPod] });
    const withSeeds = investigateKubernetes(context, seeds);
    const withoutSeeds = investigateKubernetes(context, []);
    expect(withSeeds.findings.length).toBe(withoutSeeds.findings.length);
  });
});

// ---------------------------------------------------------------------------
// Scenario 9 — Non-Pod Kubernetes resources are not misclassified
// ---------------------------------------------------------------------------

describe('investigateKubernetes — non-pod resources', () => {
  it('ignores Service resources', () => {
    const serviceResource: K8sResource = {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: 'my-svc', namespace: 'default' },
      spec: {},
      status: {},
    };
    const context = makeContext({ resources: [serviceResource] });
    const result = investigateKubernetes(context, noSeeds);
    expect(result.findings).toHaveLength(0);
  });

  it('ignores ConfigMap resources', () => {
    const cmResource: K8sResource = {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: 'my-cm', namespace: 'default' },
    };
    const context = makeContext({ resources: [cmResource] });
    const result = investigateKubernetes(context, noSeeds);
    expect(result.findings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 10 — StatefulSet unhealthy
// ---------------------------------------------------------------------------

describe('investigateKubernetes — unhealthy StatefulSet', () => {
  const statefulSet: K8sResource = {
    apiVersion: 'apps/v1',
    kind: 'StatefulSet',
    metadata: { name: 'my-db', namespace: 'data' },
    spec: { replicas: 3 },
    status: {
      replicas: 3,
      readyReplicas: 1,
    },
  };

  const context = makeContext({ resources: [statefulSet] });
  const result = investigateKubernetes(context, noSeeds);

  it('produces a finding for the unhealthy StatefulSet', () => {
    expect(result.findings).toHaveLength(1);
  });

  it('finding title mentions StatefulSet', () => {
    expect(result.findings[0]!.title.toLowerCase()).toContain('statefulset');
  });

  it('evidence path includes statefulsets/data/my-db', () => {
    const paths = result.findings[0]!.evidence.map((e) => e.path);
    expect(paths.some((p) => p.includes('statefulsets/data/my-db'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scenario 11 — Events are correlated by namespace as well as pod name
// ---------------------------------------------------------------------------

describe('investigateKubernetes — namespace-scoped pod event correlation', () => {
  it('ignores events from a pod with the same name in a different namespace', () => {
    const prodCrashLoopPod: K8sResource = {
      ...crashLoopPod,
      metadata: { name: 'app-pod', namespace: 'prod' },
    };

    const context = makeContext({
      resources: [prodCrashLoopPod],
      events: crashLoopEvents,
    });

    const result = investigateKubernetes(context, noSeeds);
    const finding = result.findings[0]!;

    expect(result.findings).toHaveLength(1);
    expect(finding.confidence).toBeLessThan(0.85);
    expect(finding.evidence.every((e) => e.artifactType !== 'event')).toBe(true);
    expect(finding.missingEvidence.some((m) => m.includes("namespace 'prod'"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scenario 12 — Pending Pod with FailedMount and ProvisioningFailed events
// ---------------------------------------------------------------------------

/** A Pending Pod stuck in ContainerCreating (mirrors pvc-pending fixture). */
const pendingPvcPod: K8sResource = {
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: { name: 'db-pod', namespace: 'default' },
  spec: {
    containers: [{ name: 'postgres', image: 'postgres:15' }],
    volumes: [
      {
        name: 'data-volume',
        persistentVolumeClaim: { claimName: 'data-pvc' },
      },
    ],
  },
  status: {
    phase: 'Pending',
    conditions: [
      { type: 'Ready', status: 'False', reason: 'ContainersNotReady' },
      { type: 'PodScheduled', status: 'True' },
    ],
    containerStatuses: [
      {
        name: 'postgres',
        ready: false,
        restartCount: 0,
        state: {
          waiting: {
            reason: 'ContainerCreating',
            message: "waiting for volume 'data-volume' to be created",
          },
        },
      },
    ],
  },
};

/** A Pending PVC referencing a non-existent StorageClass. */
const pendingPvc: K8sResource = {
  apiVersion: 'v1',
  kind: 'PersistentVolumeClaim',
  metadata: { name: 'data-pvc', namespace: 'default' },
  spec: {
    accessModes: ['ReadWriteOnce'],
    storageClassName: 'fast-ssd',
    resources: { requests: { storage: '10Gi' } },
  },
  status: { phase: 'Pending' },
};

/** StorageClass that exists (but is NOT 'fast-ssd'). */
const standardStorageClass: K8sResource = {
  apiVersion: 'storage.k8s.io/v1',
  kind: 'StorageClass',
  metadata: { name: 'standard' },
  spec: {},
  status: {},
};

/** Events for the pvc-pending scenario. */
const pendingPvcEvents: K8sEvent[] = [
  {
    type: 'Warning',
    reason: 'ProvisioningFailed',
    message: 'storageclass.storage.k8s.io "fast-ssd" not found',
    involvedObject: { kind: 'PersistentVolumeClaim', name: 'data-pvc', namespace: 'default' },
    count: 8,
    firstTimestamp: '2024-01-15T10:00:00Z',
    lastTimestamp: '2024-01-15T10:05:00Z',
  },
  {
    type: 'Warning',
    reason: 'FailedScheduling',
    message: 'persistentvolumeclaim "data-pvc" not found or is not bound',
    involvedObject: { kind: 'Pod', name: 'db-pod', namespace: 'default' },
    count: 4,
    firstTimestamp: '2024-01-15T10:00:05Z',
    lastTimestamp: '2024-01-15T10:05:00Z',
  },
  {
    type: 'Warning',
    reason: 'FailedMount',
    message: 'Unable to attach or mount volumes: unmounted volumes=[data-volume], unattached volumes=[data-volume]',
    involvedObject: { kind: 'Pod', name: 'db-pod', namespace: 'default' },
    count: 6,
    firstTimestamp: '2024-01-15T10:00:10Z',
    lastTimestamp: '2024-01-15T10:06:00Z',
  },
];

describe('investigateKubernetes — Pending Pod with FailedMount and ProvisioningFailed', () => {
  const context = makeContext({
    resources: [pendingPvcPod, pendingPvc, standardStorageClass],
    events: pendingPvcEvents,
  });
  const result = investigateKubernetes(context, noSeeds);

  it('produces exactly one finding (the pending pod)', () => {
    expect(result.findings).toHaveLength(1);
  });

  it('finding has severity critical', () => {
    expect(result.findings[0]!.severity).toBe('critical');
  });

  it('finding title mentions pod name and volume issue', () => {
    const title = result.findings[0]!.title.toLowerCase();
    expect(title).toContain('db-pod');
    expect(
      title.includes('pvc') || title.includes('volume') || title.includes('provision'),
    ).toBe(true);
  });

  it('finding title mentions the missing StorageClass fast-ssd', () => {
    const title = result.findings[0]!.title;
    expect(title).toContain('fast-ssd');
  });

  it('confidence is ≥ 0.85 when ProvisioningFailed events are present', () => {
    expect(result.findings[0]!.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it('evidence includes the pod file path', () => {
    const paths = result.findings[0]!.evidence.map((e) => e.path);
    expect(paths.some((p) => p.includes('pods/default/db-pod'))).toBe(true);
  });

  it('evidence includes ProvisioningFailed event note', () => {
    const notes = result.findings[0]!.evidence.map((e) => e.note.toLowerCase());
    expect(notes.some((n) => n.includes('provisioningfailed') || n.includes('provisioning'))).toBe(true);
  });

  it('evidence includes FailedMount event note', () => {
    const notes = result.findings[0]!.evidence.map((e) => e.note.toLowerCase());
    expect(notes.some((n) => n.includes('failedmount') || n.includes('failed mount'))).toBe(true);
  });

  it('affectedComponents includes the pod identifier', () => {
    const comps = result.findings[0]!.affectedComponents;
    expect(comps.some((c) => c.includes('db-pod'))).toBe(true);
    expect(comps.some((c) => c.startsWith('Pod/'))).toBe(true);
  });

  it('produces graph edges linking evidence to finding', () => {
    const findingId = result.findings[0]!.id;
    const supportEdges = result.edges.filter(
      (e) => e.target === findingId && e.type === 'supports',
    );
    expect(supportEdges.length).toBeGreaterThan(0);
  });

  it('produces a correlates edge between FailedMount and ProvisioningFailed', () => {
    const correlates = result.edges.filter((e) => e.type === 'correlates');
    expect(correlates.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 12b — Pending Pod with FailedScheduling only
// ---------------------------------------------------------------------------

describe('investigateKubernetes — Pending Pod with FailedScheduling events', () => {
  const pendingPodNoMount: K8sResource = {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name: 'sched-pod', namespace: 'default' },
    spec: {
      containers: [{ name: 'app', image: 'myapp:v1' }],
      nodeSelector: { 'node-type': 'gpu' },
    },
    status: {
      phase: 'Pending',
      conditions: [
        { type: 'PodScheduled', status: 'False', reason: 'Unschedulable' },
      ],
      containerStatuses: [],
    },
  };

  const schedulingEvents: K8sEvent[] = [
    {
      type: 'Warning',
      reason: 'FailedScheduling',
      message: '0/3 nodes are available: 3 node(s) didn\'t match node selector',
      involvedObject: { kind: 'Pod', name: 'sched-pod', namespace: 'default' },
      count: 5,
      firstTimestamp: '2024-01-15T10:00:00Z',
      lastTimestamp: '2024-01-15T10:05:00Z',
    },
  ];

  const context = makeContext({ resources: [pendingPodNoMount], events: schedulingEvents });
  const result = investigateKubernetes(context, noSeeds);

  it('produces a finding for the unschedulable pod', () => {
    expect(result.findings).toHaveLength(1);
  });

  it('finding title mentions scheduling failure', () => {
    const title = result.findings[0]!.title.toLowerCase();
    expect(title).toContain('scheduling');
  });

  it('evidence includes FailedScheduling event', () => {
    const notes = result.findings[0]!.evidence.map((e) => e.note.toLowerCase());
    expect(notes.some((n) => n.includes('failedscheduling') || n.includes('scheduling'))).toBe(true);
  });

  it('affectedComponents includes the pod identifier', () => {
    const comps = result.findings[0]!.affectedComponents;
    expect(comps.some((c) => c.startsWith('Pod/'))).toBe(true);
    expect(comps.some((c) => c.includes('sched-pod'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scenario 12c — Pending Pod with ProvisioningFailed includes PVC evidence
// ---------------------------------------------------------------------------

describe('investigateKubernetes — Pending Pod finding includes ProvisioningFailed evidence when PVC events exist', () => {
  const context = makeContext({
    resources: [pendingPvcPod, pendingPvc, standardStorageClass],
    events: pendingPvcEvents,
  });
  const result = investigateKubernetes(context, noSeeds);

  it('evidence array contains a PVC resource path', () => {
    const paths = result.findings[0]!.evidence.map((e) => e.path);
    expect(paths.some((p) => p.includes('persistentvolumeclaims'))).toBe(true);
  });

  it('ProvisioningFailed events appear in evidence', () => {
    const notes = result.findings[0]!.evidence.map((e) => e.note.toLowerCase());
    expect(notes.some((n) => n.includes('provisioningfailed') || n.includes('provisioning'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scenario 12d — ProvisioningFailed alone still names the PVC in title/evidence
// ---------------------------------------------------------------------------

describe('investigateKubernetes — Pending Pod with ProvisioningFailed but no FailedMount still includes PVC details', () => {
  const context = makeContext({
    resources: [pendingPvcPod, pendingPvc, standardStorageClass],
    events: [pendingPvcEvents[0]!],
  });
  const result = investigateKubernetes(context, noSeeds);

  it('produces a finding that still names the PVC in the title', () => {
    expect(result.findings).toHaveLength(1);
    const title = result.findings[0]!.title;
    expect(title).toContain('data-pvc');
    expect(title).toContain('fast-ssd');
  });

  it('includes the PVC resource path even without FailedMount events', () => {
    const paths = result.findings[0]!.evidence.map((e) => e.path);
    expect(paths.some((p) => p.includes('persistentvolumeclaims/default/data-pvc'))).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// Scenario 12e — ImagePullBackOff in Pending phase is NOT detected as Pending Pod
// ---------------------------------------------------------------------------

describe('investigateKubernetes — ImagePullBackOff in Pending phase is not duplicated as Pending Pod', () => {
  const imagePullPendingPod: K8sResource = {
    ...imagePullPod,
    // imagePullPod already has phase: Pending — it should be picked up by ImagePull detector only
  };

  const context = makeContext({
    resources: [imagePullPendingPod],
    events: imagePullEvents,
  });
  const result = investigateKubernetes(context, noSeeds);

  it('produces exactly one finding (ImagePull only, not Pending Pod)', () => {
    expect(result.findings).toHaveLength(1);
  });

  it('the finding is the ImagePullBackOff finding, not a Pending Pod finding', () => {
    const title = result.findings[0]!.title.toLowerCase();
    expect(title).toContain('imagepullbackoff');
    expect(title).not.toContain('pending pod');
  });
});

// ---------------------------------------------------------------------------
// Causal causes edges — kubernetes investigator
// ---------------------------------------------------------------------------

describe('investigateKubernetes — causal causes edges: MissingSecret→FailedMount→CrashLoopBackOff', () => {
  const context = makeContext({
    resources: [crashLoopPod],
    events: crashLoopEvents, // includes FailedMount mentioning secret "app-credentials"
  });
  const result = investigateKubernetes(context, noSeeds);

  it('emits at least one causes edge', () => {
    const causesEdges = result.edges.filter((e) => e.type === 'causes');
    expect(causesEdges.length).toBeGreaterThan(0);
  });

  it('emits a causes edge from the synthetic missing-secret node to the FailedMount event node', () => {
    const edge = result.edges.find(
      (e) =>
        e.type === 'causes' &&
        e.source === 'finding:missing-secret:app-credentials:default' &&
        e.target === 'event:FailedMount:app-pod:default',
    );
    expect(edge).toBeDefined();
  });

  it('emits a causes edge from the FailedMount event node to the crashloop finding', () => {
    const findingId = result.findings[0]!.id;
    const edge = result.edges.find(
      (e) =>
        e.type === 'causes' &&
        e.source === 'event:FailedMount:app-pod:default' &&
        e.target === findingId,
    );
    expect(edge).toBeDefined();
  });

  it('causes edges have weight > 0', () => {
    const causesEdges = result.edges.filter((e) => e.type === 'causes');
    for (const edge of causesEdges) {
      expect((edge.weight ?? 1) ).toBeGreaterThan(0);
    }
  });

  it('causes edges form a chain: missing-secret → FailedMount → crashloop finding', () => {
    const causesEdges = result.edges.filter((e) => e.type === 'causes');
    const findingId = result.findings[0]!.id;
    // First hop: synthetic root cause → FailedMount event node
    const hop1 = causesEdges.find(
      (e) => e.source.startsWith('finding:missing-secret:') && e.target.startsWith('event:FailedMount:'),
    );
    expect(hop1).toBeDefined();
    // Second hop: FailedMount event node → crashloop finding
    const hop2 = causesEdges.find(
      (e) => e.source.startsWith('event:FailedMount:') && e.target === findingId,
    );
    expect(hop2).toBeDefined();
    // The two hops share the intermediate FailedMount node
    expect(hop1!.target).toBe(hop2!.source);
  });
});

describe('investigateKubernetes — no causes edges without FailedMount+secret events', () => {
  it('does not emit causes edges for CrashLoopBackOff without FailedMount events', () => {
    const context = makeContext({ resources: [crashLoopPod], events: [] });
    const result = investigateKubernetes(context, noSeeds);
    const causesEdges = result.edges.filter((e) => e.type === 'causes');
    expect(causesEdges).toHaveLength(0);
  });

  it('does not emit causes edges for CrashLoopBackOff with BackOff-only events (no secret mentioned)', () => {
    const backOffOnly: K8sEvent[] = [
      {
        type: 'Warning',
        reason: 'BackOff',
        message: 'Back-off restarting failed container',
        involvedObject: { kind: 'Pod', name: 'app-pod', namespace: 'default' },
        count: 3,
        firstTimestamp: '2024-01-15T13:30:05Z',
        lastTimestamp: '2024-01-15T13:30:05Z',
      },
    ];
    const context = makeContext({ resources: [crashLoopPod], events: backOffOnly });
    const result = investigateKubernetes(context, noSeeds);
    const causesEdges = result.edges.filter((e) => e.type === 'causes');
    expect(causesEdges).toHaveLength(0);
  });
});

describe('investigateKubernetes — causal causes edges: BadImageTag→ErrImagePull→ImagePullBackOff', () => {
  const context = makeContext({
    resources: [imagePullPod],
    events: imagePullEvents, // includes ErrImagePull event
  });
  const result = investigateKubernetes(context, noSeeds);

  it('emits at least one causes edge', () => {
    const causesEdges = result.edges.filter((e) => e.type === 'causes');
    expect(causesEdges.length).toBeGreaterThan(0);
  });

  it('emits a causes edge from synthetic bad-image-tag node to ErrImagePull event node', () => {
    const edge = result.edges.find(
      (e) =>
        e.type === 'causes' &&
        e.source.startsWith('finding:bad-image-tag:') &&
        e.target === 'event:ErrImagePull:app-pod:default',
    );
    expect(edge).toBeDefined();
  });

  it('emits a causes edge from ErrImagePull event node to the imagepull finding', () => {
    const findingId = result.findings[0]!.id;
    const edge = result.edges.find(
      (e) =>
        e.type === 'causes' &&
        e.source === 'event:ErrImagePull:app-pod:default' &&
        e.target === findingId,
    );
    expect(edge).toBeDefined();
  });

  it('bad-image-tag node ID encodes the image tag', () => {
    const causesEdges = result.edges.filter((e) => e.type === 'causes');
    const badImageEdge = causesEdges.find((e) => e.source.startsWith('finding:bad-image-tag:'));
    expect(badImageEdge).toBeDefined();
    // Image "myapp:v999.99.99" should appear (possibly with chars sanitised)
    expect(badImageEdge!.source).toContain('myapp');
  });

  it('does not emit causes edges without ErrImagePull events', () => {
    const ctxNoEvents = makeContext({ resources: [imagePullPod], events: [] });
    const r = investigateKubernetes(ctxNoEvents, noSeeds);
    const causesEdges = r.edges.filter((e) => e.type === 'causes');
    expect(causesEdges).toHaveLength(0);
  });
});

describe('investigateKubernetes — causal causes edges: MissingStorageClass→ProvisioningFailed→FailedMount→PodPending', () => {
  const context = makeContext({
    resources: [pendingPvcPod, pendingPvc, standardStorageClass],
    events: pendingPvcEvents,
  });
  const result = investigateKubernetes(context, noSeeds);

  it('emits at least one causes edge', () => {
    const causesEdges = result.edges.filter((e) => e.type === 'causes');
    expect(causesEdges.length).toBeGreaterThan(0);
  });

  it('emits a causes edge from synthetic missing-storage-class node to ProvisioningFailed event node', () => {
    const edge = result.edges.find(
      (e) =>
        e.type === 'causes' &&
        e.source === 'finding:missing-storage-class:fast-ssd:default' &&
        e.target === 'event:ProvisioningFailed:data-pvc:default',
    );
    expect(edge).toBeDefined();
  });

  it('emits a causes edge from ProvisioningFailed node to FailedMount event node', () => {
    const edge = result.edges.find(
      (e) =>
        e.type === 'causes' &&
        e.source === 'event:ProvisioningFailed:data-pvc:default' &&
        e.target === 'event:FailedMount:db-pod:default',
    );
    expect(edge).toBeDefined();
  });

  it('emits a causes edge from FailedMount event node to the pending finding', () => {
    const findingId = result.findings[0]!.id;
    const edge = result.edges.find(
      (e) =>
        e.type === 'causes' &&
        e.source === 'event:FailedMount:db-pod:default' &&
        e.target === findingId,
    );
    expect(edge).toBeDefined();
  });

  it('produces a 3-hop causes chain: missing-storage-class→ProvisioningFailed→FailedMount→pending', () => {
    const causesEdges = result.edges.filter((e) => e.type === 'causes');
    // Verify the 3 causal hops are all present
    expect(causesEdges.length).toBeGreaterThanOrEqual(3);
    const findingId = result.findings[0]!.id;
    const hop1 = causesEdges.find(
      (e) => e.source.startsWith('finding:missing-storage-class:') && e.target.startsWith('event:ProvisioningFailed:'),
    );
    const hop2 = causesEdges.find(
      (e) => e.source.startsWith('event:ProvisioningFailed:') && e.target.startsWith('event:FailedMount:'),
    );
    const hop3 = causesEdges.find(
      (e) => e.source.startsWith('event:FailedMount:') && e.target === findingId,
    );
    expect(hop1).toBeDefined();
    expect(hop2).toBeDefined();
    expect(hop3).toBeDefined();
    // Chain is connected
    expect(hop1!.target).toBe(hop2!.source);
    expect(hop2!.target).toBe(hop3!.source);
  });

  it('does not emit causes edges without ProvisioningFailed events', () => {
    const ctxNoProvFailed = makeContext({
      resources: [pendingPvcPod, pendingPvc, standardStorageClass],
      events: [pendingPvcEvents[1]!, pendingPvcEvents[2]!], // FailedScheduling + FailedMount, no ProvisioningFailed
    });
    const r = investigateKubernetes(ctxNoProvFailed, noSeeds);
    const causesEdges = r.edges.filter((e) => e.type === 'causes');
    expect(causesEdges).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// OOM / Node-health fixtures
// ---------------------------------------------------------------------------

/**
 * A Pod whose last terminated state was OOMKilled — now restarting in
 * CrashLoopBackOff.  Has explicit memory limits so the finding title can
 * include the limit.
 */
const oomCrashLoopPod: K8sResource = {
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: { name: 'memory-hog', namespace: 'default' },
  spec: {
    containers: [
      {
        name: 'app',
        image: 'myapp:v1',
        resources: {
          limits: { memory: '256Mi', cpu: '500m' },
          requests: { memory: '128Mi', cpu: '100m' },
        },
      },
    ],
  },
  status: {
    phase: 'Running',
    conditions: [{ type: 'Ready', status: 'False', reason: 'ContainersNotReady' }],
    containerStatuses: [
      {
        name: 'app',
        ready: false,
        restartCount: 5,
        state: {
          waiting: { reason: 'CrashLoopBackOff', message: 'back-off restarting failed container' },
        },
        // NOTE: `lastState` is not in the ContainerStatus type — stored as raw K8s status
        lastState: {
          terminated: { reason: 'OOMKilled', exitCode: 137 },
        },
      },
    ],
  },
};

/**
 * A Pod whose current container state is OOMKilled (phase=Failed, not restarting).
 * Has explicit memory limits.
 */
const oomTerminatedPod: K8sResource = {
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: { name: 'oom-pod', namespace: 'default' },
  spec: {
    containers: [
      {
        name: 'worker',
        image: 'worker:v2',
        resources: {
          limits: { memory: '128Mi' },
          requests: { memory: '64Mi' },
        },
      },
    ],
  },
  status: {
    phase: 'Failed',
    conditions: [{ type: 'Ready', status: 'False', reason: 'ContainersNotReady' }],
    containerStatuses: [
      {
        name: 'worker',
        ready: false,
        restartCount: 0,
        state: { terminated: { reason: 'OOMKilled', exitCode: 137 } },
      },
    ],
  },
};

/** A Node that is NotReady (Ready=False). */
const notReadyNode: K8sResource = {
  apiVersion: 'v1',
  kind: 'Node',
  metadata: { name: 'node-1' },
  spec: {},
  status: {
    conditions: [
      {
        type: 'Ready',
        status: 'False',
        reason: 'KubeletNotReady',
        message: 'kubelet stopped posting node status',
      },
      { type: 'MemoryPressure', status: 'False', reason: 'KubeletHasSufficientMemory', message: '' },
      { type: 'DiskPressure', status: 'False', reason: 'KubeletHasNoDiskPressure', message: '' },
      { type: 'PIDPressure', status: 'False', reason: 'KubeletHasSufficientPID', message: '' },
    ],
  },
};

/** A Node with MemoryPressure (MemoryPressure=True). */
const memoryPressureNode: K8sResource = {
  apiVersion: 'v1',
  kind: 'Node',
  metadata: { name: 'node-2' },
  spec: {},
  status: {
    conditions: [
      { type: 'Ready', status: 'True', reason: 'KubeletReady', message: '' },
      {
        type: 'MemoryPressure',
        status: 'True',
        reason: 'KubeletHasInsufficientMemory',
        message: 'kubelet has insufficient memory available',
      },
      { type: 'DiskPressure', status: 'False', reason: 'KubeletHasNoDiskPressure', message: '' },
      { type: 'PIDPressure', status: 'False', reason: 'KubeletHasSufficientPID', message: '' },
    ],
  },
};

/** A Node with DiskPressure (DiskPressure=True). */
const diskPressureNode: K8sResource = {
  apiVersion: 'v1',
  kind: 'Node',
  metadata: { name: 'node-3' },
  spec: {},
  status: {
    conditions: [
      { type: 'Ready', status: 'True', reason: 'KubeletReady', message: '' },
      { type: 'MemoryPressure', status: 'False', reason: 'KubeletHasSufficientMemory', message: '' },
      {
        type: 'DiskPressure',
        status: 'True',
        reason: 'KubeletHasDiskPressure',
        message: 'kubelet has disk pressure',
      },
      { type: 'PIDPressure', status: 'False', reason: 'KubeletHasSufficientPID', message: '' },
    ],
  },
};

/** A Node with PIDPressure (PIDPressure=True). */
const pidPressureNode: K8sResource = {
  apiVersion: 'v1',
  kind: 'Node',
  metadata: { name: 'node-4' },
  spec: {},
  status: {
    conditions: [
      { type: 'Ready', status: 'True', reason: 'KubeletReady', message: '' },
      { type: 'MemoryPressure', status: 'False', reason: 'KubeletHasSufficientMemory', message: '' },
      { type: 'DiskPressure', status: 'False', reason: 'KubeletHasNoDiskPressure', message: '' },
      {
        type: 'PIDPressure',
        status: 'True',
        reason: 'KubeletHasPIDPressure',
        message: 'kubelet has PID pressure',
      },
    ],
  },
};

/** A fully healthy Node — all conditions OK. */
const healthyNode: K8sResource = {
  apiVersion: 'v1',
  kind: 'Node',
  metadata: { name: 'healthy-node' },
  spec: {},
  status: {
    capacity: { memory: '16Gi', cpu: '4' },
    allocatable: { memory: '15Gi', cpu: '3900m' },
    conditions: [
      { type: 'Ready', status: 'True', reason: 'KubeletReady', message: '' },
      { type: 'MemoryPressure', status: 'False', reason: 'KubeletHasSufficientMemory', message: '' },
      { type: 'DiskPressure', status: 'False', reason: 'KubeletHasNoDiskPressure', message: '' },
      { type: 'PIDPressure', status: 'False', reason: 'KubeletHasSufficientPID', message: '' },
    ],
  },
};

/** Node whose allocatable memory is significantly lower than capacity. */
const constrainedMemoryNode: K8sResource = {
  apiVersion: 'v1',
  kind: 'Node',
  metadata: { name: 'node-5' },
  spec: {},
  status: {
    capacity: { memory: '16Gi', cpu: '4' },
    allocatable: { memory: '10Gi', cpu: '3500m' },
    conditions: [
      { type: 'Ready', status: 'True', reason: 'KubeletReady', message: '' },
      { type: 'MemoryPressure', status: 'False', reason: 'KubeletHasSufficientMemory', message: '' },
      { type: 'DiskPressure', status: 'False', reason: 'KubeletHasNoDiskPressure', message: '' },
      { type: 'PIDPressure', status: 'False', reason: 'KubeletHasSufficientPID', message: '' },
    ],
  },
};

/** Node with a taint that blocks scheduling for untolerated pods. */
const taintedNoScheduleNode: K8sResource = {
  apiVersion: 'v1',
  kind: 'Node',
  metadata: { name: 'tainted-node' },
  spec: {
    taints: [
      { key: 'dedicated', value: 'gpu', effect: 'NoSchedule' },
    ],
  },
  status: {
    capacity: { memory: '32Gi', cpu: '8' },
    allocatable: { memory: '30Gi', cpu: '7600m' },
    conditions: [
      { type: 'Ready', status: 'True', reason: 'KubeletReady', message: '' },
      { type: 'MemoryPressure', status: 'False', reason: 'KubeletHasSufficientMemory', message: '' },
      { type: 'DiskPressure', status: 'False', reason: 'KubeletHasNoDiskPressure', message: '' },
      { type: 'PIDPressure', status: 'False', reason: 'KubeletHasSufficientPID', message: '' },
    ],
  },
};

const pendingUntoleratedPod: K8sResource = {
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: { name: 'pending-untolerated', namespace: 'default' },
  spec: {
    containers: [{ name: 'app', image: 'myapp:v1' }],
  },
  status: {
    phase: 'Pending',
    conditions: [
      { type: 'PodScheduled', status: 'False', reason: 'Unschedulable' },
    ],
  },
};

/** FailedScheduling event for pods that can't schedule because of a NotReady node. */
const nodeSchedulingEvents: K8sEvent[] = [
  {
    type: 'Warning',
    reason: 'FailedScheduling',
    message: '0/1 nodes are available: 1 node(s) were unschedulable',
    involvedObject: { kind: 'Pod', name: 'pending-pod', namespace: 'default' },
    count: 3,
    firstTimestamp: '2024-01-15T10:00:00Z',
    lastTimestamp: '2024-01-15T10:05:00Z',
  },
];

const taintSchedulingEvents: K8sEvent[] = [
  {
    type: 'Warning',
    reason: 'FailedScheduling',
    message: '0/1 nodes are available: 1 node(s) had untolerated taint {dedicated: gpu}',
    involvedObject: { kind: 'Pod', name: 'pending-untolerated', namespace: 'default' },
    count: 2,
    firstTimestamp: '2024-01-15T11:00:00Z',
    lastTimestamp: '2024-01-15T11:05:00Z',
  },
];

// ---------------------------------------------------------------------------
// Scenario 13 — OOMKilled container (currently in terminated state, no loop)
// ---------------------------------------------------------------------------

describe('investigateKubernetes — OOMKilled container (current terminated state)', () => {
  const context = makeContext({ resources: [oomTerminatedPod] });
  const result = investigateKubernetes(context, noSeeds);

  it('produces exactly one finding for the OOMKilled container', () => {
    const oomFindings = result.findings.filter((f) =>
      f.title.toLowerCase().includes('oom'),
    );
    expect(oomFindings).toHaveLength(1);
  });

  it('finding title contains the container name, pod name, and OOMKilled', () => {
    const oomFinding = result.findings.find((f) => f.title.toLowerCase().includes('oom'));
    expect(oomFinding).toBeDefined();
    expect(oomFinding!.title).toContain('worker');
    expect(oomFinding!.title).toContain('oom-pod');
    expect(oomFinding!.title.toLowerCase()).toContain('oomkilled');
  });

  it('finding title includes the memory limit (128Mi)', () => {
    const oomFinding = result.findings.find((f) => f.title.toLowerCase().includes('oom'));
    expect(oomFinding!.title).toContain('128Mi');
  });

  it('finding severity is high or critical', () => {
    const oomFinding = result.findings.find((f) => f.title.toLowerCase().includes('oom'));
    expect(['critical', 'high']).toContain(oomFinding!.severity);
  });

  it('affectedComponents includes the pod and container', () => {
    const oomFinding = result.findings.find((f) => f.title.toLowerCase().includes('oom'));
    expect(oomFinding!.affectedComponents.some((c) => c.includes('oom-pod'))).toBe(true);
    expect(oomFinding!.affectedComponents.some((c) => c.includes('worker'))).toBe(true);
  });

  it('evidence includes the pod file path', () => {
    const oomFinding = result.findings.find((f) => f.title.toLowerCase().includes('oom'));
    expect(oomFinding!.evidence.some((e) => e.path.includes('pods/default/oom-pod'))).toBe(true);
  });

  it('evidence note references memory limit or resource information', () => {
    const oomFinding = result.findings.find((f) => f.title.toLowerCase().includes('oom'));
    const allNotes = oomFinding!.evidence.map((e) => e.note.toLowerCase()).join(' ');
    expect(allNotes).toMatch(/limit|memory|resource/);
  });

  it('produces graph edges supporting the finding', () => {
    const oomFinding = result.findings.find((f) => f.title.toLowerCase().includes('oom'));
    const supportEdges = result.edges.filter(
      (e) => e.target === oomFinding!.id && e.type === 'supports',
    );
    expect(supportEdges.length).toBeGreaterThan(0);
  });

  it('confidence is in [0, 1]', () => {
    const oomFinding = result.findings.find((f) => f.title.toLowerCase().includes('oom'));
    expect(oomFinding!.confidence).toBeGreaterThanOrEqual(0);
    expect(oomFinding!.confidence).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Scenario 14 — OOMKilled in lastState (pod is now in CrashLoopBackOff)
// ---------------------------------------------------------------------------

describe('investigateKubernetes — OOMKilled in lastState + CrashLoopBackOff', () => {
  const context = makeContext({ resources: [oomCrashLoopPod] });
  const result = investigateKubernetes(context, noSeeds);

  it('produces both an OOM finding and a CrashLoopBackOff finding', () => {
    const oomFindings = result.findings.filter((f) => f.title.toLowerCase().includes('oom'));
    const crashFindings = result.findings.filter((f) =>
      f.title.toLowerCase().includes('crashloopbackoff'),
    );
    expect(oomFindings.length).toBeGreaterThan(0);
    expect(crashFindings.length).toBeGreaterThan(0);
  });

  it('OOM finding title includes container name, pod name, and memory limit', () => {
    const oomFinding = result.findings.find((f) => f.title.toLowerCase().includes('oom'));
    expect(oomFinding).toBeDefined();
    expect(oomFinding!.title).toContain('app');
    expect(oomFinding!.title).toContain('memory-hog');
    expect(oomFinding!.title).toContain('256Mi');
  });

  it('produces causal edges: OOMKill → ContainerRestart → CrashLoopBackOff', () => {
    const causesEdges = result.edges.filter((e) => e.type === 'causes');
    // At least 2 causes edges for the OOM chain
    expect(causesEdges.length).toBeGreaterThanOrEqual(2);
  });

  it('emits a causes edge from OOM finding to a ContainerRestart event node', () => {
    const oomFinding = result.findings.find((f) => f.title.toLowerCase().includes('oom'));
    expect(oomFinding).toBeDefined();
    const oomToRestart = result.edges.find(
      (e) =>
        e.type === 'causes' &&
        e.source === oomFinding!.id &&
        e.target.includes('ContainerRestart'),
    );
    expect(oomToRestart).toBeDefined();
  });

  it('emits a causes edge from ContainerRestart node to CrashLoopBackOff finding', () => {
    const crashFinding = result.findings.find((f) =>
      f.title.toLowerCase().includes('crashloopbackoff'),
    );
    expect(crashFinding).toBeDefined();
    const restartToCrash = result.edges.find(
      (e) =>
        e.type === 'causes' &&
        e.source.includes('ContainerRestart') &&
        e.target === crashFinding!.id,
    );
    expect(restartToCrash).toBeDefined();
  });

  it('the OOMKill causal chain is connected: OOM → ContainerRestart → CrashLoopBackOff', () => {
    const causesEdges = result.edges.filter((e) => e.type === 'causes');
    const oomFinding = result.findings.find((f) => f.title.toLowerCase().includes('oom'));
    const crashFinding = result.findings.find((f) =>
      f.title.toLowerCase().includes('crashloopbackoff'),
    );

    const hop1 = causesEdges.find(
      (e) => e.source === oomFinding!.id && e.target.includes('ContainerRestart'),
    );
    const hop2 = causesEdges.find(
      (e) => e.source.includes('ContainerRestart') && e.target === crashFinding!.id,
    );

    expect(hop1).toBeDefined();
    expect(hop2).toBeDefined();
    expect(hop1!.target).toBe(hop2!.source);
  });

  it('causes edges have weight > 0', () => {
    const causesEdges = result.edges.filter((e) => e.type === 'causes');
    for (const edge of causesEdges) {
      expect((edge.weight ?? 1)).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 15 — OOMKilled without resource limits configured
// ---------------------------------------------------------------------------

describe('investigateKubernetes — OOMKilled without resource limits', () => {
  const podWithoutLimits: K8sResource = {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name: 'no-limits-pod', namespace: 'default' },
    spec: {
      containers: [{ name: 'app', image: 'myapp:v1' }],
    },
    status: {
      phase: 'Failed',
      conditions: [{ type: 'Ready', status: 'False' }],
      containerStatuses: [
        {
          name: 'app',
          ready: false,
          restartCount: 2,
          state: { terminated: { reason: 'OOMKilled', exitCode: 137 } },
        },
      ],
    },
  };

  const context = makeContext({ resources: [podWithoutLimits] });
  const result = investigateKubernetes(context, noSeeds);

  it('still produces an OOM finding even without resource limits configured', () => {
    const oomFindings = result.findings.filter((f) => f.title.toLowerCase().includes('oom'));
    expect(oomFindings).toHaveLength(1);
  });

  it('finding title contains container name and pod name without crashing', () => {
    const oomFinding = result.findings.find((f) => f.title.toLowerCase().includes('oom'));
    expect(oomFinding).toBeDefined();
    expect(oomFinding!.title).toContain('no-limits-pod');
    expect(oomFinding!.title).toContain('app');
  });

  it('recommendedAction mentions memory limit', () => {
    const oomFinding = result.findings.find((f) => f.title.toLowerCase().includes('oom'));
    expect(oomFinding!.recommendedAction.toLowerCase()).toContain('memory');
  });
});

// ---------------------------------------------------------------------------
// Scenario 16 — Node NotReady condition
// ---------------------------------------------------------------------------

describe('investigateKubernetes — Node NotReady', () => {
  const context = makeContext({ resources: [notReadyNode] });
  const result = investigateKubernetes(context, noSeeds);

  it('produces a finding for the NotReady node', () => {
    const nodeFindings = result.findings.filter((f) =>
      f.title.toLowerCase().includes('node-1'),
    );
    expect(nodeFindings.length).toBeGreaterThan(0);
  });

  it('finding title references the node name and NotReady status', () => {
    const nodeFinding = result.findings.find(
      (f) =>
        (f.title.toLowerCase().includes('notready') ||
          f.title.toLowerCase().includes('not ready')) &&
        f.title.includes('node-1'),
    );
    expect(nodeFinding).toBeDefined();
  });

  it('finding severity is critical', () => {
    const nodeFinding = result.findings.find((f) => f.title.includes('node-1'));
    expect(nodeFinding!.severity).toBe('critical');
  });

  it('confidence is in [0, 1]', () => {
    const nodeFinding = result.findings.find((f) => f.title.includes('node-1'));
    expect(nodeFinding!.confidence).toBeGreaterThanOrEqual(0);
    expect(nodeFinding!.confidence).toBeLessThanOrEqual(1);
  });

  it('affectedComponents includes the node', () => {
    const nodeFinding = result.findings.find((f) => f.title.includes('node-1'));
    expect(nodeFinding!.affectedComponents.some((c) => c.includes('node-1'))).toBe(true);
  });

  it('evidence includes reference to the node resource', () => {
    const nodeFinding = result.findings.find((f) => f.title.includes('node-1'));
    expect(nodeFinding!.evidence.length).toBeGreaterThan(0);
    expect(nodeFinding!.evidence.some((e) => e.path.includes('node-1'))).toBe(true);
  });

  it('contradictionsChecked is non-empty', () => {
    const nodeFinding = result.findings.find((f) => f.title.includes('node-1'));
    expect(nodeFinding!.contradictionsChecked.length).toBeGreaterThan(0);
  });

  it('recommendedAction is non-empty and mentions the node name', () => {
    const nodeFinding = result.findings.find((f) => f.title.includes('node-1'));
    expect(nodeFinding!.recommendedAction).toBeTruthy();
    expect(nodeFinding!.recommendedAction).toContain('node-1');
  });

  it('produces graph edges supporting the finding', () => {
    const nodeFinding = result.findings.find((f) => f.title.includes('node-1'));
    const supportEdges = result.edges.filter(
      (e) => e.target === nodeFinding!.id && e.type === 'supports',
    );
    expect(supportEdges.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 17 — Node MemoryPressure condition
// ---------------------------------------------------------------------------

describe('investigateKubernetes — Node MemoryPressure', () => {
  const context = makeContext({ resources: [memoryPressureNode] });
  const result = investigateKubernetes(context, noSeeds);

  it('produces a finding for the MemoryPressure node', () => {
    const pressureFindings = result.findings.filter(
      (f) =>
        (f.title.toLowerCase().includes('memorypressure') ||
          (f.title.toLowerCase().includes('memory') &&
            f.title.toLowerCase().includes('pressure'))) &&
        f.title.includes('node-2'),
    );
    expect(pressureFindings.length).toBeGreaterThan(0);
  });

  it('finding title references the node name and MemoryPressure', () => {
    const finding = result.findings.find(
      (f) =>
        f.title.includes('node-2') &&
        (f.title.toLowerCase().includes('memory') || f.title.toLowerCase().includes('pressure')),
    );
    expect(finding).toBeDefined();
    expect(finding!.title).toContain('node-2');
  });

  it('finding severity is high or critical', () => {
    const finding = result.findings.find((f) => f.title.includes('node-2'));
    expect(['critical', 'high']).toContain(finding!.severity);
  });

  it('affectedComponents includes the node', () => {
    const finding = result.findings.find((f) => f.title.includes('node-2'));
    expect(finding!.affectedComponents.some((c) => c.includes('node-2'))).toBe(true);
  });

  it('produces graph edges supporting the finding', () => {
    const finding = result.findings.find((f) => f.title.includes('node-2'));
    const supportEdges = result.edges.filter(
      (e) => e.target === finding!.id && e.type === 'supports',
    );
    expect(supportEdges.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 18 — Node DiskPressure condition
// ---------------------------------------------------------------------------

describe('investigateKubernetes — Node DiskPressure', () => {
  const context = makeContext({ resources: [diskPressureNode] });
  const result = investigateKubernetes(context, noSeeds);

  it('produces a finding for the DiskPressure node', () => {
    const finding = result.findings.find(
      (f) =>
        f.title.toLowerCase().includes('disk') &&
        f.title.includes('node-3'),
    );
    expect(finding).toBeDefined();
  });

  it('finding title references the node name and DiskPressure', () => {
    const finding = result.findings.find(
      (f) => f.title.includes('node-3') && f.title.toLowerCase().includes('disk'),
    );
    expect(finding!.title).toContain('node-3');
  });

  it('affectedComponents includes the node', () => {
    const finding = result.findings.find((f) => f.title.includes('node-3'));
    expect(finding).toBeDefined();
    expect(finding!.affectedComponents.some((c) => c.includes('node-3'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scenario 19 — Node PIDPressure condition
// ---------------------------------------------------------------------------

describe('investigateKubernetes — Node PIDPressure', () => {
  const context = makeContext({ resources: [pidPressureNode] });
  const result = investigateKubernetes(context, noSeeds);

  it('produces a finding for the PIDPressure node', () => {
    const finding = result.findings.find(
      (f) =>
        f.title.toLowerCase().includes('pid') &&
        f.title.includes('node-4'),
    );
    expect(finding).toBeDefined();
  });

  it('affectedComponents includes the node', () => {
    const finding = result.findings.find((f) => f.title.includes('node-4'));
    expect(finding).toBeDefined();
    expect(finding!.affectedComponents.some((c) => c.includes('node-4'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scenario 20 — Healthy node produces no findings
// ---------------------------------------------------------------------------

describe('investigateKubernetes — healthy node produces no findings', () => {
  it('returns no findings for a healthy node', () => {
    const context = makeContext({ resources: [healthyNode] });
    const result = investigateKubernetes(context, noSeeds);
    expect(result.findings).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 21 — NodeNotReady correlates with pod scheduling failures
// ---------------------------------------------------------------------------

describe('investigateKubernetes — NodeNotReady correlates with FailedScheduling events', () => {
  const context = makeContext({
    resources: [notReadyNode],
    events: nodeSchedulingEvents,
  });
  const result = investigateKubernetes(context, noSeeds);

  it('produces a NodeNotReady finding', () => {
    const nodeFinding = result.findings.find((f) => f.title.includes('node-1'));
    expect(nodeFinding).toBeDefined();
  });

  it('emits a causes edge from NodeNotReady finding to FailedScheduling event node', () => {
    const nodeFinding = result.findings.find((f) => f.title.includes('node-1'));
    expect(nodeFinding).toBeDefined();
    const causesEdge = result.edges.find(
      (e) =>
        e.type === 'causes' &&
        e.source === nodeFinding!.id &&
        e.target.includes('FailedScheduling'),
    );
    expect(causesEdge).toBeDefined();
  });

  it('causal edge target includes the pending pod name', () => {
    const nodeFinding = result.findings.find((f) => f.title.includes('node-1'));
    const causesEdge = result.edges.find(
      (e) =>
        e.type === 'causes' &&
        e.source === nodeFinding!.id &&
        e.target.includes('FailedScheduling'),
    );
    expect(causesEdge!.target).toContain('pending-pod');
  });

  it('causes edge has weight > 0', () => {
    const nodeFinding = result.findings.find((f) => f.title.includes('node-1'));
    const causesEdge = result.edges.find(
      (e) => e.type === 'causes' && e.source === nodeFinding!.id,
    );
    expect((causesEdge!.weight ?? 1)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 21b — Node allocatable memory is significantly below capacity
// ---------------------------------------------------------------------------

describe('investigateKubernetes — node resource constraint from allocatable vs capacity', () => {
  const context = makeContext({ resources: [constrainedMemoryNode] });
  const result = investigateKubernetes(context, noSeeds);

  it('produces a finding about node resource constraints', () => {
    const finding = result.findings.find(
      (f) => f.title.includes('node-5') && /allocatable|capacity|resource/i.test(f.title),
    );
    expect(finding).toBeDefined();
  });

  it('finding severity is medium', () => {
    const finding = result.findings.find((f) => f.title.includes('node-5'));
    expect(finding!.severity).toBe('medium');
  });
});

// ---------------------------------------------------------------------------
// Scenario 21c — NoSchedule taint correlates with Pending pod scheduling failure
// ---------------------------------------------------------------------------

describe('investigateKubernetes — node taint correlates with pod scheduling failure', () => {
  const context = makeContext({
    resources: [taintedNoScheduleNode, pendingUntoleratedPod],
    events: taintSchedulingEvents,
  });
  const result = investigateKubernetes(context, noSeeds);

  it('produces a finding for the unschedulable NoSchedule taint', () => {
    const finding = result.findings.find(
      (f) => f.title.includes('tainted-node') && /NoSchedule|taint/i.test(f.title),
    );
    expect(finding).toBeDefined();
  });

  it('emits a causes edge linking the taint finding to FailedScheduling', () => {
    const finding = result.findings.find(
      (f) => f.title.includes('tainted-node') && /NoSchedule|taint/i.test(f.title),
    );
    const edge = result.edges.find(
      (e) => e.type === 'causes' && e.source === finding!.id && e.target.includes('FailedScheduling'),
    );
    expect(edge).toBeDefined();
    expect(edge!.target).toContain('pending-untolerated');
  });
});

describe('investigateKubernetes — node taint does not claim unrelated scheduling failures', () => {
  const unrelatedSchedulingEvents: K8sEvent[] = [
    {
      type: 'Warning',
      reason: 'FailedScheduling',
      message: "0/1 nodes are available: 1 node(s) didn't match node selector",
      involvedObject: { kind: 'Pod', name: 'pending-untolerated', namespace: 'default' },
      count: 2,
      firstTimestamp: '2024-01-15T10:00:00Z',
      lastTimestamp: '2024-01-15T10:01:00Z',
    },
  ];

  const context = makeContext({
    resources: [taintedNoScheduleNode, pendingUntoleratedPod],
    events: unrelatedSchedulingEvents,
  });
  const result = investigateKubernetes(context, noSeeds);

  it('still produces a taint finding from node and pod state', () => {
    const finding = result.findings.find(
      (f) => f.title.includes('tainted-node') && /NoSchedule|taint/i.test(f.title),
    );
    expect(finding).toBeDefined();
  });

  it('does not emit a causes edge when FailedScheduling message is unrelated to the taint', () => {
    const finding = result.findings.find(
      (f) => f.title.includes('tainted-node') && /NoSchedule|taint/i.test(f.title),
    );
    const edge = result.edges.find(
      (e) => e.type === 'causes' && e.source === finding!.id && e.target.includes('FailedScheduling'),
    );
    expect(edge).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Scenario 21d — MemoryPressure correlates with OOMKilled pod on same node
// ---------------------------------------------------------------------------

describe('investigateKubernetes — MemoryPressure correlates with OOMKilled pods on same node', () => {
  const oomOnPressuredNode: K8sResource = {
    ...oomTerminatedPod,
    metadata: { name: 'oom-on-node-2', namespace: 'default' },
    spec: {
      ...(oomTerminatedPod.spec ?? {}),
      nodeName: 'node-2',
      containers: [
        {
          name: 'worker',
          image: 'worker:v2',
          resources: {
            limits: { memory: '128Mi' },
            requests: { memory: '64Mi' },
          },
        },
      ],
    },
  };

  const context = makeContext({ resources: [memoryPressureNode, oomOnPressuredNode] });
  const result = investigateKubernetes(context, noSeeds);

  it('produces both MemoryPressure and OOM findings', () => {
    const nodeFinding = result.findings.find(
      (f) => f.title.includes('node-2') && /memory|pressure/i.test(f.title),
    );
    const oomFinding = result.findings.find((f) => f.title.includes('oom-on-node-2'));
    expect(nodeFinding).toBeDefined();
    expect(oomFinding).toBeDefined();
  });

  it('emits a causes edge from MemoryPressure finding to OOM finding', () => {
    const nodeFinding = result.findings.find(
      (f) => f.title.includes('node-2') && /memory|pressure/i.test(f.title),
    );
    const oomFinding = result.findings.find((f) => f.title.includes('oom-on-node-2'));
    const edge = result.edges.find(
      (e) => e.type === 'causes' && e.source === nodeFinding!.id && e.target === oomFinding!.id,
    );
    expect(edge).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Scenario 22 — No OOM findings for pods without OOMKilled
// ---------------------------------------------------------------------------

describe('investigateKubernetes — no OOM findings for normal pods', () => {
  it('does not produce OOM findings for a healthy pod', () => {
    const context = makeContext({ resources: [healthyPod] });
    const result = investigateKubernetes(context, noSeeds);
    const oomFindings = result.findings.filter((f) => f.title.toLowerCase().includes('oom'));
    expect(oomFindings).toHaveLength(0);
  });

  it('does not produce OOM findings for a CrashLoopBackOff pod without OOMKilled', () => {
    // crashLoopPod has CrashLoopBackOff but no OOMKilled in lastState
    const context = makeContext({ resources: [crashLoopPod] });
    const result = investigateKubernetes(context, noSeeds);
    const oomFindings = result.findings.filter((f) => f.title.toLowerCase().includes('oom'));
    expect(oomFindings).toHaveLength(0);
  });
});
