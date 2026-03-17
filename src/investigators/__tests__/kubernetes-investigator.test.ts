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
      config: 0,
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
