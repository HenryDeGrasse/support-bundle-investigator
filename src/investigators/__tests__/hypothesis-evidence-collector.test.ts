import { describe, it, expect } from 'vitest';
import type { BundleProfile, K8sResource, K8sEvent } from '../../types/index.js';
import type { InvestigatorContext } from '../types.js';
import type { LogFile, LogLine } from '../../parsers/index.js';
import type { Hypothesis } from '../hypothesis-types.js';
import {
  collectEvidenceForHypothesis,
  collectFalsifyingEvidence,
} from '../hypothesis-evidence-collector.js';

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

/** Build a minimal LogFile with lines. */
function makeLogFile(path: string, lines: string[]): LogFile {
  return {
    path,
    lines: lines.map((content, i) => ({
      lineNumber: i + 1,
      content,
      level: 'info' as const,
    })) as LogLine[],
    errorCount: 0,
    warningCount: 0,
    importance: 50,
  };
}

/** Build a minimal K8sEvent. */
function makeEvent(
  reason: string,
  message: string,
  objectName: string,
  objectKind = 'Pod',
  namespace = 'default',
): K8sEvent {
  return {
    type: 'Warning',
    reason,
    message,
    involvedObject: { kind: objectKind, name: objectName, namespace },
  };
}

/** Build a minimal K8sResource. */
function makeResource(kind: string, name: string, namespace = 'default'): K8sResource {
  return {
    apiVersion: 'v1',
    kind,
    metadata: { name, namespace },
  };
}

/** Build a minimal Hypothesis with a given category. */
function makeHypothesis(
  overrides: Partial<Hypothesis> & Pick<Hypothesis, 'category'>,
): Hypothesis {
  return {
    id: `symptom:default/app-pod:${overrides.category}`,
    symptom: 'Pod app-pod is in CrashLoopBackOff',
    rootCause: 'Some root cause',
    evidenceAssessment: { supporting: [], contradicting: [], missingDecisive: [] },
    confidence: 0,
    confidenceRationale: 'Not yet scored',
    specGapRecommendations: [],
    sourceFindings: ['finding:test:0'],
    ...overrides,
  };
}

// ===========================================================================
// missing-secret hypothesis
// ===========================================================================

describe('collectEvidenceForHypothesis — missing-secret: secret is absent', () => {
  // Context: FailedMount event, no Secret resource in context
  const ctx = makeContext({
    events: [
      makeEvent(
        'FailedMount',
        "MountVolume.SetUp failed: secret 'db-credentials' not found",
        'app-pod',
      ),
    ],
    resources: [
      makeResource('Pod', 'app-pod'),
    ],
  });
  const hypothesis = makeHypothesis({ category: 'missing-secret' });
  const assessment = collectEvidenceForHypothesis(hypothesis, ctx);

  it('finds at least one supporting evidence item for a FailedMount event', () => {
    expect(assessment.supporting.length).toBeGreaterThanOrEqual(1);
  });

  it('supporting evidence items have non-empty path', () => {
    for (const ev of assessment.supporting) {
      expect(ev.path).toBeTruthy();
    }
  });

  it('supporting evidence items have descriptive note', () => {
    for (const ev of assessment.supporting) {
      expect(ev.note).toBeTruthy();
      expect(ev.note.length).toBeGreaterThan(5);
    }
  });

  it('contradicting is empty when no Secret resource exists', () => {
    expect(assessment.contradicting).toHaveLength(0);
  });

  it('missingDecisive lists pod logs as a decisive gap', () => {
    expect(assessment.missingDecisive.length).toBeGreaterThanOrEqual(1);
    const joined = assessment.missingDecisive.join(' ').toLowerCase();
    expect(joined).toMatch(/log|pod|secret/);
  });
});

describe('collectEvidenceForHypothesis — missing-secret: secret exists', () => {
  // Context: pod references Secret resource that IS present → contradicting evidence
  const ctx = makeContext({
    resources: [
      {
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: { name: 'app-pod', namespace: 'default' },
        spec: {
          containers: [
            {
              name: 'app',
              envFrom: [{ secretRef: { name: 'db-credentials' } }],
            },
          ],
        },
      },
      makeResource('Secret', 'db-credentials'),
    ],
  });
  const hypothesis = makeHypothesis({ category: 'missing-secret' });
  const assessment = collectEvidenceForHypothesis(hypothesis, ctx);

  it('finds at least one contradicting evidence item when the referenced secret exists', () => {
    expect(assessment.contradicting.length).toBeGreaterThanOrEqual(1);
  });

  it('contradicting evidence has non-empty path', () => {
    for (const ev of assessment.contradicting) {
      expect(ev.path).toBeTruthy();
    }
  });

  it('contradicting evidence note mentions the secret', () => {
    const joined = assessment.contradicting.map((e) => e.note).join(' ').toLowerCase();
    expect(joined).toMatch(/secret|db-credentials/);
  });
});

describe('collectEvidenceForHypothesis — missing-secret: unrelated secret does not contradict', () => {
  const ctx = makeContext({
    resources: [
      {
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: { name: 'app-pod', namespace: 'default' },
        spec: {
          containers: [
            {
              name: 'app',
              envFrom: [{ secretRef: { name: 'db-credentials' } }],
            },
          ],
        },
      },
      makeResource('Secret', 'other-secret'),
    ],
  });
  const hypothesis = makeHypothesis({ category: 'missing-secret' });
  const assessment = collectEvidenceForHypothesis(hypothesis, ctx);

  it('finds supporting evidence for the missing referenced secret', () => {
    expect(assessment.supporting.some((e) => e.note.includes('db-credentials'))).toBe(true);
  });

  it('does not treat an unrelated existing secret as contradicting evidence', () => {
    expect(assessment.contradicting.some((e) => e.note.includes('other-secret'))).toBe(false);
  });
});

// ===========================================================================
// dns-failure hypothesis
// ===========================================================================

describe('collectEvidenceForHypothesis — dns-failure: no such host in logs', () => {
  const ctx = makeContext({
    logs: [
      makeLogFile('logs/default/app-pod/app/current.log', [
        'INFO  starting application',
        'ERROR dial tcp: lookup my-service.default.svc.cluster.local: no such host',
        'ERROR failed to connect to database',
      ]),
    ],
  });
  const hypothesis = makeHypothesis({ category: 'dns-failure' });
  const assessment = collectEvidenceForHypothesis(hypothesis, ctx);

  it('finds supporting evidence for "no such host" log pattern', () => {
    expect(assessment.supporting.length).toBeGreaterThanOrEqual(1);
  });

  it('supporting evidence path references the log file', () => {
    const paths = assessment.supporting.map((e) => e.path);
    expect(paths.some((p) => p.includes('app-pod'))).toBe(true);
  });

  it('supporting evidence note mentions DNS or host resolution', () => {
    const notes = assessment.supporting.map((e) => e.note).join(' ').toLowerCase();
    expect(notes).toMatch(/dns|host|resolv|lookup/);
  });

  it('missingDecisive lists CoreDNS logs as a decisive gap', () => {
    expect(assessment.missingDecisive.length).toBeGreaterThanOrEqual(1);
    const joined = assessment.missingDecisive.join(' ').toLowerCase();
    expect(joined).toMatch(/coredns|dns|kube-dns/);
  });
});

describe('collectEvidenceForHypothesis — dns-failure: successful connection log present', () => {
  // Both "no such host" AND "connected" in logs → both supporting AND contradicting
  const ctx = makeContext({
    logs: [
      makeLogFile('logs/default/app-pod/app/current.log', [
        'ERROR dial tcp: no such host',
        'INFO  connected to service successfully',
        'INFO  ready',
      ]),
    ],
  });
  const hypothesis = makeHypothesis({ category: 'dns-failure' });
  const assessment = collectEvidenceForHypothesis(hypothesis, ctx);

  it('has at least one supporting evidence (dns error line)', () => {
    expect(assessment.supporting.length).toBeGreaterThanOrEqual(1);
  });

  it('has at least one contradicting evidence (successful connection line)', () => {
    expect(assessment.contradicting.length).toBeGreaterThanOrEqual(1);
  });

  it('contradicting evidence note mentions a successful connection', () => {
    const notes = assessment.contradicting.map((e) => e.note).join(' ').toLowerCase();
    expect(notes).toMatch(/connect|success|ready/);
  });

  it('both supporting and contradicting have real paths', () => {
    for (const ev of [...assessment.supporting, ...assessment.contradicting]) {
      expect(ev.path).toBeTruthy();
    }
  });
});

describe('collectEvidenceForHypothesis — dns-failure: missing Service resource', () => {
  const ctx = makeContext({
    resources: [
      makeResource('Pod', 'app-pod'),
      // intentionally no Service resource
    ],
    logs: [
      makeLogFile('logs/default/app-pod/app/current.log', [
        'ERROR no such host: my-backend.default.svc.cluster.local',
      ]),
    ],
  });
  const hypothesis = makeHypothesis({ category: 'dns-failure' });
  const assessment = collectEvidenceForHypothesis(hypothesis, ctx);

  it('finds supporting evidence when no Service exists', () => {
    expect(assessment.supporting.length).toBeGreaterThanOrEqual(1);
  });
  it('does not invent contradicting service evidence when no matching Service is captured', () => {
    expect(assessment.contradicting.some((e) => e.path.includes('cluster-resources/services/'))).toBe(false);
  });
});

describe('collectEvidenceForHypothesis — dns-failure: unrelated Service does not contradict', () => {
  const ctx = makeContext({
    resources: [
      makeResource('Service', 'other-service'),
    ],
    logs: [
      makeLogFile('logs/default/app-pod/app/current.log', [
        'ERROR dial tcp: lookup my-backend.default.svc.cluster.local: no such host',
      ]),
    ],
  });
  const hypothesis = makeHypothesis({ category: 'dns-failure' });
  const assessment = collectEvidenceForHypothesis(hypothesis, ctx);

  it('keeps supporting DNS evidence', () => {
    expect(assessment.supporting.length).toBeGreaterThanOrEqual(1);
  });

  it('does not treat an unrelated Service as contradicting evidence', () => {
    expect(assessment.contradicting.some((e) => e.note.includes('other-service'))).toBe(false);
  });
});

describe('collectEvidenceForHypothesis — dns-failure: numeric env values are not treated as service hostnames', () => {
  const ctx = makeContext({
    resources: [
      {
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: { name: 'app-pod', namespace: 'default' },
        spec: {
          containers: [
            {
              name: 'app',
              env: [
                { name: 'DB_HOST', value: 'db.internal:5432' },
                { name: 'DB_PORT', value: '5432' },
                { name: 'DATABASE_URL', value: 'http://postgres.default.svc.cluster.local:5432/healthz' },
              ],
            },
          ],
        },
      },
    ],
    logs: [
      makeLogFile('logs/default/app-pod/app/current.log', [
        'ERROR dial tcp: lookup db.internal: no such host',
      ]),
    ],
  });
  const hypothesis = makeHypothesis({ category: 'dns-failure' });
  const assessment = collectEvidenceForHypothesis(hypothesis, ctx);

  it('keeps real hostname/service evidence for DB_HOST and DATABASE_URL', () => {
    const notes = assessment.supporting.map((e) => e.note).join(' ');
    expect(notes).toContain('lookup db.internal: no such host');
    expect(notes).toContain('postgres.default.svc.cluster.local:5432');
  });

  it('does not invent a numeric hostname or numeric service resource from DB_PORT', () => {
    const combined = [...assessment.supporting, ...assessment.contradicting]
      .map((e) => `${e.path} ${e.note}`)
      .join(' ');

    expect(combined).not.toMatch(/hostname '\s*5432\s*'/i);
    expect(combined).not.toMatch(/service '\s*5432\s*'/i);
    expect(combined).not.toContain('cluster-resources/services/default/5432.yaml');
  });
});

// ===========================================================================
// image-pull-failure hypothesis
// ===========================================================================

describe('collectEvidenceForHypothesis — image-pull-failure: ErrImagePull event present', () => {
  const ctx = makeContext({
    events: [
      makeEvent(
        'Failed',
        'Failed to pull image "myapp:v999": not found',
        'app-pod',
      ),
      makeEvent(
        'BackOff',
        'Back-off pulling image "myapp:v999"',
        'app-pod',
      ),
    ],
    resources: [
      {
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: { name: 'app-pod', namespace: 'default' },
        spec: {
          containers: [{ name: 'app', image: 'myapp:v999' }],
        },
        status: {
          containerStatuses: [
            {
              name: 'app',
              ready: false,
              restartCount: 0,
              state: { waiting: { reason: 'ErrImagePull', message: 'not found' } },
            },
          ],
        },
      },
    ],
  });
  const hypothesis = makeHypothesis({ category: 'image-pull-failure' });
  const assessment = collectEvidenceForHypothesis(hypothesis, ctx);

  it('finds at least one supporting evidence item for ErrImagePull', () => {
    expect(assessment.supporting.length).toBeGreaterThanOrEqual(1);
  });

  it('supporting evidence path references the pod resource or events', () => {
    const paths = assessment.supporting.map((e) => e.path);
    const relevant = paths.some(
      (p) => p.includes('app-pod') || p.includes('event'),
    );
    expect(relevant).toBe(true);
  });

  it('supporting evidence note mentions image pull or ErrImagePull', () => {
    const notes = assessment.supporting.map((e) => e.note).join(' ').toLowerCase();
    expect(notes).toMatch(/image|pull|errimagepull/);
  });

  it('missingDecisive lists registry logs as a decisive gap', () => {
    expect(assessment.missingDecisive.length).toBeGreaterThanOrEqual(1);
    const joined = assessment.missingDecisive.join(' ').toLowerCase();
    expect(joined).toMatch(/registry|log|access/);
  });
});

describe('collectEvidenceForHypothesis — image-pull-failure: image exists in status', () => {
  // Pod status shows image is present (running container → image pulled fine)
  const ctx = makeContext({
    resources: [
      {
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: { name: 'app-pod', namespace: 'default' },
        spec: { containers: [{ name: 'app', image: 'myapp:v1.0' }] },
        status: {
          containerStatuses: [
            {
              name: 'app',
              ready: true,
              restartCount: 0,
              image: 'myapp:v1.0',
              imageID: 'docker.io/library/myapp@sha256:abc123',
              state: { running: { startedAt: '2024-01-01T00:00:00Z' } },
            },
          ],
        },
      },
    ],
  });
  const hypothesis = makeHypothesis({ category: 'image-pull-failure' });
  const assessment = collectEvidenceForHypothesis(hypothesis, ctx);

  it('finds contradicting evidence when container is running (image was pulled)', () => {
    expect(assessment.contradicting.length).toBeGreaterThanOrEqual(1);
  });

  it('contradicting evidence note mentions image or running', () => {
    const notes = assessment.contradicting.map((e) => e.note).join(' ').toLowerCase();
    expect(notes).toMatch(/image|running|pull/);
  });
});

// ===========================================================================
// config-error hypothesis
// ===========================================================================

describe('collectEvidenceForHypothesis — config-error: not-found errors in logs', () => {
  const ctx = makeContext({
    logs: [
      makeLogFile('logs/default/app-pod/app/current.log', [
        'FATAL config: environment variable DATABASE_URL not found',
        'ERROR failed to start: missing configuration',
      ]),
    ],
    resources: [makeResource('Pod', 'app-pod')],
  });
  const hypothesis = makeHypothesis({ category: 'config-error' });
  const assessment = collectEvidenceForHypothesis(hypothesis, ctx);

  it('finds supporting evidence for config not-found errors in logs', () => {
    expect(assessment.supporting.length).toBeGreaterThanOrEqual(1);
  });

  it('supporting evidence path references the log file', () => {
    const paths = assessment.supporting.map((e) => e.path);
    expect(paths.some((p) => p.includes('app-pod'))).toBe(true);
  });

  it('missingDecisive mentions config file or ConfigMap', () => {
    const joined = assessment.missingDecisive.join(' ').toLowerCase();
    expect(joined).toMatch(/config|configmap|env/);
  });
});

// ===========================================================================
// connectivity-failure hypothesis
// ===========================================================================

describe('collectEvidenceForHypothesis — connectivity-failure: timeout patterns in logs', () => {
  const ctx = makeContext({
    logs: [
      makeLogFile('logs/default/app-pod/app/current.log', [
        'ERROR context deadline exceeded while connecting to db:5432',
        'ERROR connection timed out to redis-master.default.svc.cluster.local:6379',
      ]),
    ],
  });
  const hypothesis = makeHypothesis({ category: 'connectivity-failure' });
  const assessment = collectEvidenceForHypothesis(hypothesis, ctx);

  it('finds supporting evidence for connection timeout logs', () => {
    expect(assessment.supporting.length).toBeGreaterThanOrEqual(1);
  });

  it('supporting evidence note mentions timeout or connection', () => {
    const notes = assessment.supporting.map((e) => e.note).join(' ').toLowerCase();
    expect(notes).toMatch(/timeout|connect|deadline/);
  });

  it('missingDecisive mentions network policy data', () => {
    const joined = assessment.missingDecisive.join(' ').toLowerCase();
    expect(joined).toMatch(/network|policy|endpoint/);
  });
});

describe('collectEvidenceForHypothesis — connectivity-failure: successful later connection', () => {
  const ctx = makeContext({
    logs: [
      makeLogFile('logs/default/app-pod/app/current.log', [
        'ERROR connection timed out on startup',
        'INFO  successfully connected to backend on retry',
        'INFO  server ready',
      ]),
    ],
  });
  const hypothesis = makeHypothesis({ category: 'connectivity-failure' });
  const assessment = collectEvidenceForHypothesis(hypothesis, ctx);

  it('has at least one supporting evidence item (timeout)', () => {
    expect(assessment.supporting.length).toBeGreaterThanOrEqual(1);
  });

  it('has at least one contradicting evidence item (later success)', () => {
    expect(assessment.contradicting.length).toBeGreaterThanOrEqual(1);
  });
});

describe('collectEvidenceForHypothesis — connectivity-failure: missing Endpoints requires a referenced service', () => {
  const ctx = makeContext({
    resources: [makeResource('Pod', 'app-pod')],
    logs: [
      makeLogFile('logs/default/app-pod/app/current.log', [
        'ERROR context deadline exceeded while connecting to db.internal:5432',
      ]),
    ],
  });
  const hypothesis = makeHypothesis({ category: 'connectivity-failure' });
  const assessment = collectEvidenceForHypothesis(hypothesis, ctx);

  it('keeps timeout log evidence', () => {
    expect(assessment.supporting.some((e) => /timeout|deadline/i.test(e.note))).toBe(true);
  });

  it('does not treat a missing Endpoints inventory as supporting evidence when no in-cluster service is referenced in pod specs', () => {
    expect(assessment.supporting.some((e) => e.path === 'cluster-resources/endpoints/')).toBe(false);
  });
});

// ===========================================================================
// readiness-failure hypothesis
// ===========================================================================

describe('collectEvidenceForHypothesis — readiness-failure: Unhealthy events present', () => {
  const ctx = makeContext({
    events: [
      makeEvent(
        'Unhealthy',
        'Readiness probe failed: HTTP probe failed with statuscode: 503',
        'app-pod',
      ),
    ],
    resources: [
      {
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: { name: 'app-pod', namespace: 'default' },
        spec: {
          containers: [
            {
              name: 'app',
              readinessProbe: {
                httpGet: { path: '/healthz', port: 8080 },
                initialDelaySeconds: 5,
                periodSeconds: 10,
              },
            },
          ],
        },
      },
    ],
  });
  const hypothesis = makeHypothesis({ category: 'readiness-failure' });
  const assessment = collectEvidenceForHypothesis(hypothesis, ctx);

  it('finds supporting evidence for Unhealthy events', () => {
    expect(assessment.supporting.length).toBeGreaterThanOrEqual(1);
  });

  it('supporting evidence note mentions readiness or probe', () => {
    const notes = assessment.supporting.map((e) => e.note).join(' ').toLowerCase();
    expect(notes).toMatch(/readiness|probe|unhealthy/);
  });

  it('missingDecisive mentions detailed probe output', () => {
    const joined = assessment.missingDecisive.join(' ').toLowerCase();
    expect(joined).toMatch(/probe|output|detail|log/);
  });
});

describe('collectEvidenceForHypothesis — readiness-failure: pod later became ready', () => {
  const ctx = makeContext({
    events: [
      makeEvent('Unhealthy', 'Readiness probe failed', 'app-pod'),
    ],
    resources: [
      {
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: { name: 'app-pod', namespace: 'default' },
        status: {
          conditions: [
            { type: 'Ready', status: 'True', reason: 'ContainersReady' },
          ],
          containerStatuses: [
            { name: 'app', ready: true, restartCount: 0, state: { running: {} } },
          ],
          phase: 'Running',
        },
      },
    ],
  });
  const hypothesis = makeHypothesis({ category: 'readiness-failure' });
  const assessment = collectEvidenceForHypothesis(hypothesis, ctx);

  it('finds contradicting evidence when pod is now ready', () => {
    expect(assessment.contradicting.length).toBeGreaterThanOrEqual(1);
  });

  it('contradicting evidence note mentions ready or running', () => {
    const notes = assessment.contradicting.map((e) => e.note).join(' ').toLowerCase();
    expect(notes).toMatch(/ready|running/);
  });
});

// ===========================================================================
// Template-driven evidence rules (7.11a)
// ===========================================================================

describe('collectEvidenceForHypothesis — oom-kill: template rules match container status and events', () => {
  const ctx = makeContext({
    events: [
      makeEvent('Killing', 'Container app was OOMKilled after exceeding memory limit', 'app-pod'),
    ],
    resources: [
      {
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: { name: 'app-pod', namespace: 'default' },
        status: {
          containerStatuses: [
            {
              name: 'app',
              ready: false,
              restartCount: 3,
              lastState: {
                terminated: { reason: 'OOMKilled', exitCode: 137 },
              },
            },
          ],
        },
      },
    ],
  });
  const hypothesis = makeHypothesis({
    category: 'oom-kill',
    rootCause: 'The container exceeded its memory limit and was killed',
    evidenceRules: [
      {
        label: 'OOMKilled exit reason',
        pattern: 'oomkilled|oom.*kill|out of memory|exit code 137',
        type: 'supporting',
      },
    ],
  });
  const assessment = collectEvidenceForHypothesis(hypothesis, ctx);

  it('finds supporting evidence from both pod status and events', () => {
    const combined = assessment.supporting.map((e) => `${e.path} ${e.note}`).join(' ');
    expect(combined).toMatch(/oomkilled|memory limit|exit code 137/i);
    expect(assessment.supporting.some((e) => e.path === 'cluster-resources/pods/default.json')).toBe(true);
    expect(assessment.supporting.some((e) => e.path === 'cluster-resources/events/default.json')).toBe(true);
  });

  it('does not fall back to the generic no-collector missing evidence message when template rules matched', () => {
    expect(assessment.missingDecisive.join(' ')).not.toMatch(/No dedicated evidence collector/i);
  });
});

describe('collectEvidenceForHypothesis — oom-kill: dedicated collector finds status, limits, requests, events, and logs', () => {
  const ctx = makeContext({
    events: [
      makeEvent('OOMKilled', 'Container app in pod app-pod was OOMKilled after exceeding its memory limit', 'app-pod'),
    ],
    logs: [
      makeLogFile('logs/default/app-pod/app/current.log', [
        'ERROR runtime: out of memory while allocating cache',
      ]),
    ],
    resources: [
      {
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: { name: 'app-pod', namespace: 'default' },
        spec: {
          containers: [
            {
              name: 'app',
              resources: {
                requests: { memory: '128Mi' },
                limits: { memory: '256Mi' },
              },
            },
          ],
        },
        status: {
          containerStatuses: [
            {
              name: 'app',
              ready: false,
              restartCount: 2,
              state: { terminated: { reason: 'OOMKilled', exitCode: 137 } },
              lastState: { terminated: { reason: 'OOMKilled', exitCode: 137 } },
            },
          ],
        },
      },
    ],
  });
  const hypothesis = makeHypothesis({ category: 'oom-kill' });
  const assessment = collectEvidenceForHypothesis(hypothesis, ctx);

  it('finds supporting evidence from OOMKilled container status', () => {
    expect(
      assessment.supporting.some(
        (e) => e.path === 'cluster-resources/pods/default.json' && /oomkilled|exit code 137/i.test(e.note),
      ),
    ).toBe(true);
  });

  it('finds supporting evidence from pod memory requests and limits', () => {
    expect(
      assessment.supporting.some(
        (e) => e.path === 'cluster-resources/pods/default.json' && /128Mi|256Mi|memory request|memory limit/i.test(e.note),
      ),
    ).toBe(true);
  });

  it('finds supporting evidence from OOM-related events and logs', () => {
    expect(assessment.supporting.some((e) => e.path === 'cluster-resources/events/default.json')).toBe(true);
    expect(assessment.supporting.some((e) => e.path.includes('app-pod') && /out of memory/i.test(e.note))).toBe(true);
  });
});

describe('collectEvidenceForHypothesis — oom-kill: dedicated collector also reads init container memory settings', () => {
  const ctx = makeContext({
    resources: [
      {
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: { name: 'app-pod', namespace: 'default' },
        spec: {
          initContainers: [
            {
              name: 'init-cache',
              resources: {
                requests: { memory: '64Mi' },
                limits: { memory: '96Mi' },
              },
            },
          ],
        },
        status: {
          initContainerStatuses: [
            {
              name: 'init-cache',
              ready: false,
              restartCount: 1,
              lastState: { terminated: { reason: 'OOMKilled', exitCode: 137 } },
            },
          ],
        },
      },
    ],
  });
  const hypothesis = makeHypothesis({ category: 'oom-kill' });
  const assessment = collectEvidenceForHypothesis(hypothesis, ctx);

  it('captures init container OOMKilled status and memory request/limit evidence', () => {
    const combined = assessment.supporting.map((e) => `${e.path} ${e.note}`).join(' ');
    expect(combined).toMatch(/init-cache/i);
    expect(combined).toMatch(/64Mi|96Mi/i);
    expect(combined).toMatch(/oomkilled|exit code 137/i);
  });
});

describe('collectEvidenceForHypothesis — generic-crash: template rules match fatal and panic log patterns', () => {
  const ctx = makeContext({
    logs: [
      makeLogFile('logs/default/app-pod/app/current.log', [
        'INFO booting application',
        'FATAL failed to initialize runtime',
        'panic: nil pointer dereference',
      ]),
    ],
  });
  const hypothesis = makeHypothesis({
    category: 'generic-crash',
    rootCause: 'The application has an unclassified crash bug',
    evidenceRules: [
      {
        label: 'Crash signatures in logs',
        pattern: 'error|panic|fatal',
        type: 'supporting',
      },
    ],
  });
  const assessment = collectEvidenceForHypothesis(hypothesis, ctx);

  it('uses template rules to collect supporting log evidence for generic-crash', () => {
    const combined = assessment.supporting.map((e) => `${e.path} ${e.note}`).join(' ');
    expect(combined).toMatch(/panic|fatal/i);
    expect(assessment.supporting.some((e) => e.path.includes('app-pod'))).toBe(true);
  });

  it('treats template rules as the primary evidence source for categories without dedicated collectors', () => {
    expect(assessment.supporting.length).toBeGreaterThanOrEqual(2);
    expect(assessment.missingDecisive.join(' ')).not.toMatch(/No dedicated evidence collector/i);
  });
});

describe('collectEvidenceForHypothesis — template rules produce supporting and contradicting evidence', () => {
  const ctx = makeContext({
    logs: [
      makeLogFile('logs/default/app-pod/app/current.log', [
        'ERROR database endpoint db.internal refused the connection',
        'INFO successfully connected to database after config update',
      ]),
    ],
    events: [
      makeEvent('Warning', 'Back-end service lookup failed for db.internal', 'app-pod'),
    ],
  });
  const hypothesis = makeHypothesis({
    category: 'bad-db-endpoint',
    symptom: 'Database endpoint configuration appears incorrect',
    rootCause: 'The configured database hostname or port is wrong',
    evidenceRules: [
      {
        label: 'Database endpoint failure',
        pattern: 'db.internal|lookup failed|refused the connection',
        type: 'supporting',
      },
      {
        label: 'Database connectivity recovered',
        pattern: 'successfully connected to database',
        type: 'contradicting',
      },
    ],
  });
  const assessment = collectEvidenceForHypothesis(hypothesis, ctx);

  it('adds supporting evidence for matching supporting rule patterns', () => {
    const notes = assessment.supporting.map((e) => e.note).join(' ');
    expect(notes).toMatch(/Database endpoint failure/i);
    expect(notes).toContain('db.internal');
    expect(notes).toMatch(/lookup failed|refused the connection/i);
  });

  it('adds contradicting evidence for matching contradicting rule patterns', () => {
    const notes = assessment.contradicting.map((e) => e.note).join(' ');
    expect(notes).toMatch(/Database connectivity recovered/i);
    expect(notes).toMatch(/successfully connected to database/i);
  });
});

describe('collectEvidenceForHypothesis — missing-service: dedicated collector checks service inventory and endpoints', () => {
  const ctx = makeContext({
    resources: [
      {
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: { name: 'app-pod', namespace: 'default' },
        spec: {
          containers: [
            {
              name: 'app',
              env: [{ name: 'BACKEND_URL', value: 'http://payments.default.svc.cluster.local:8080' }],
            },
          ],
        },
      },
      makeResource('Service', 'payments'),
      {
        apiVersion: 'v1',
        kind: 'Endpoints',
        metadata: { name: 'payments', namespace: 'default' },
        spec: {
          subsets: [
            {
              addresses: [],
              notReadyAddresses: [{ ip: '10.0.0.10' }],
              ports: [{ port: 8080 }],
            },
          ],
        },
      },
    ],
  });
  const hypothesis = makeHypothesis({ category: 'missing-service' });
  const assessment = collectEvidenceForHypothesis(hypothesis, ctx);

  it('finds supporting evidence when a referenced service has no ready endpoints', () => {
    expect(
      assessment.supporting.some((e) => /payments/.test(e.note) && /0 ready addresses|no ready endpoints|no ready backend/i.test(e.note)),
    ).toBe(true);
  });

  it('records pod, service, and endpoints evidence paths', () => {
    expect(assessment.supporting.some((e) => e.path === 'cluster-resources/pods/default.json')).toBe(true);
    expect(assessment.supporting.some((e) => e.path === 'cluster-resources/services/default.json')).toBe(true);
    expect(assessment.supporting.some((e) => e.path === 'cluster-resources/endpoints/default.json')).toBe(true);
  });
});

describe('collectEvidenceForHypothesis — missing-service: template rules provide fallback evidence when collector has no direct match', () => {
  const ctx = makeContext({
    logs: [
      makeLogFile('logs/default/app-pod/app/current.log', [
        'ERROR upstream service not found: payments',
      ]),
    ],
  });
  const hypothesis = makeHypothesis({
    category: 'missing-service',
    symptom: 'Pod app-pod cannot find the payments service during startup',
    evidenceRules: [
      {
        label: 'Service missing in logs',
        pattern: 'service not found|missing service|cannot find the payments service',
        type: 'supporting',
      },
    ],
  });
  const assessment = collectEvidenceForHypothesis(hypothesis, ctx);

  it('uses template rules for missing-service when the dedicated collector has no direct service-reference evidence', () => {
    expect(assessment.supporting.some((e) => /Template rule 'Service missing in logs'/i.test(e.note))).toBe(true);
    expect(assessment.missingDecisive.join(' ')).not.toMatch(/No dedicated evidence collector/i);
  });
});

describe('collectEvidenceForHypothesis — dedicated collectors are supplemented by template rules', () => {
  const ctx = makeContext({
    logs: [
      makeLogFile('logs/default/app-pod/app/current.log', [
        'ERROR dial tcp: lookup db.default.svc.cluster.local: no such host',
      ]),
    ],
  });
  const hypothesis = makeHypothesis({
    category: 'dns-failure',
    symptom: 'DNS lookup db.default.svc.cluster.local keeps failing during startup',
    rootCause: 'The dependency hostname cannot be resolved',
    evidenceRules: [
      {
        label: 'DNS symptom text',
        pattern: 'dns lookup|cannot be resolved',
        type: 'supporting',
      },
    ],
  });
  const assessment = collectEvidenceForHypothesis(hypothesis, ctx);

  it('keeps dedicated collector evidence from logs', () => {
    expect(assessment.supporting.some((e) => /no such host|dns/i.test(e.note))).toBe(true);
  });

  it('adds supplemental template evidence from symptom text even when dedicated evidence already exists', () => {
    expect(
      assessment.supporting.some(
        (e) => e.path === 'finding:test:0' && /Template rule 'DNS symptom text' matched symptom text/i.test(e.note),
      ),
    ).toBe(true);
  });
});

describe('collectEvidenceForHypothesis — template contradicting rules skip negated phrases', () => {
  const ctx = makeContext({
    events: [
      makeEvent(
        'FailedMount',
        "MountVolume.SetUp failed: secret 'db-credentials' not found",
        'app-pod',
      ),
    ],
    resources: [
      {
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: { name: 'app-pod', namespace: 'default' },
        spec: {
          containers: [
            {
              name: 'app',
              envFrom: [{ secretRef: { name: 'db-credentials' } }],
            },
          ],
        },
      },
    ],
  });
  const hypothesis = makeHypothesis({
    category: 'missing-secret',
    evidenceRules: [
      {
        label: 'Secret exists and is mounted',
        pattern: 'secret.*mounted|secret.*found|secret.*exists',
        type: 'contradicting',
      },
    ],
  });
  const assessment = collectEvidenceForHypothesis(hypothesis, ctx);

  it('does not treat "secret not found" as contradicting evidence', () => {
    expect(
      assessment.contradicting.some((e) => /Template rule 'Secret exists and is mounted'/i.test(e.note)),
    ).toBe(false);
  });
});

// ===========================================================================
// Empty context → missingDecisive populated, no supporting evidence
// ===========================================================================

describe('collectEvidenceForHypothesis — empty context', () => {
  const emptyCtx = makeContext();

  const categories = [
    'missing-secret',
    'dns-failure',
    'image-pull-failure',
    'config-error',
    'oom-kill',
    'connectivity-failure',
    'readiness-failure',
    'missing-service',
  ] as const;

  for (const category of categories) {
    describe(`category: ${category}`, () => {
      const hypothesis = makeHypothesis({ category });
      const assessment = collectEvidenceForHypothesis(hypothesis, emptyCtx);

      it('has no supporting evidence against empty context', () => {
        expect(assessment.supporting).toHaveLength(0);
      });

      it('has missingDecisive populated against empty context', () => {
        expect(assessment.missingDecisive.length).toBeGreaterThanOrEqual(1);
      });
    });
  }
});

// ===========================================================================
// Evidence item structure invariants
// ===========================================================================

describe('collectEvidenceForHypothesis — evidence item structure', () => {
  it('every supporting evidence item has a non-empty path and note', () => {
    const ctx = makeContext({
      events: [
        makeEvent('FailedMount', "secret 'db-creds' not found", 'app-pod'),
      ],
    });
    const hypothesis = makeHypothesis({ category: 'missing-secret' });
    const assessment = collectEvidenceForHypothesis(hypothesis, ctx);

    for (const ev of assessment.supporting) {
      expect(typeof ev.path).toBe('string');
      expect(ev.path.length).toBeGreaterThan(0);
      expect(typeof ev.note).toBe('string');
      expect(ev.note.length).toBeGreaterThan(0);
    }
  });

  it('every contradicting evidence item has a non-empty path and note', () => {
    const ctx = makeContext({
      resources: [makeResource('Secret', 'db-creds')],
    });
    const hypothesis = makeHypothesis({ category: 'missing-secret' });
    const assessment = collectEvidenceForHypothesis(hypothesis, ctx);

    for (const ev of assessment.contradicting) {
      expect(typeof ev.path).toBe('string');
      expect(ev.path.length).toBeGreaterThan(0);
      expect(typeof ev.note).toBe('string');
      expect(ev.note.length).toBeGreaterThan(0);
    }
  });
});

// ===========================================================================
// collectFalsifyingEvidence — active falsification (7.6)
// ===========================================================================

// ---------------------------------------------------------------------------
// dns-failure — active hostname-specific falsification
// ---------------------------------------------------------------------------

describe('collectFalsifyingEvidence — dns-failure: finds successful connection to same failing hostname', () => {
  it('adds contradicting evidence when a success log for the same hostname is present', () => {
    const ctx = makeContext({
      logs: [
        makeLogFile('logs/default/app-pod/app/current.log', [
          'ERROR dial tcp: lookup my-backend: no such host',
          'INFO successfully connected to my-backend on retry',
        ]),
      ],
    });
    const hypothesis = makeHypothesis({ category: 'dns-failure' });
    const result = collectFalsifyingEvidence(hypothesis, ctx);

    expect(result.contradicting.length).toBeGreaterThanOrEqual(1);
    const combined = result.contradicting.map((e) => e.note).join(' ');
    expect(combined).toMatch(/my-backend/);
  });

  it('every contradicting item has a non-empty path and note', () => {
    const ctx = makeContext({
      logs: [
        makeLogFile('logs/default/app-pod/app/current.log', [
          'ERROR no such host: auth-service',
          'INFO successfully connected to auth-service',
        ]),
      ],
    });
    const hypothesis = makeHypothesis({ category: 'dns-failure' });
    const result = collectFalsifyingEvidence(hypothesis, ctx);

    for (const ev of result.contradicting) {
      expect(ev.path.length).toBeGreaterThan(0);
      expect(ev.note.length).toBeGreaterThan(5);
    }
  });

  it('does NOT add contradicting evidence when success is only for a different hostname', () => {
    const ctx = makeContext({
      logs: [
        makeLogFile('logs/default/app-pod/app/current.log', [
          'ERROR no such host: my-backend',
          'INFO successfully connected to other-service',
        ]),
      ],
    });
    const hypothesis = makeHypothesis({ category: 'dns-failure' });
    const result = collectFalsifyingEvidence(hypothesis, ctx);

    // No hostname-specific success for 'my-backend' → no contradicting
    const hasMismatch = result.contradicting.some(
      (e) =>
        e.note.toLowerCase().includes('my-backend') &&
        e.note.toLowerCase().includes('success'),
    );
    expect(hasMismatch).toBe(false);
  });

  it('returns no contradicting evidence when no DNS failure lines exist in logs', () => {
    const ctx = makeContext({
      logs: [
        makeLogFile('logs/default/app-pod/app/current.log', [
          'INFO application started',
          'INFO ready',
        ]),
      ],
    });
    const hypothesis = makeHypothesis({ category: 'dns-failure' });
    const result = collectFalsifyingEvidence(hypothesis, ctx);

    expect(result.contradicting).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// missing-secret — actively checks whether the Secret is present
// ---------------------------------------------------------------------------

describe('collectFalsifyingEvidence — missing-secret: checks whether the Secret is actually present', () => {
  it('adds contradicting evidence when the named Secret exists in the cluster resources', () => {
    const ctx = makeContext({
      events: [
        makeEvent(
          'FailedMount',
          "MountVolume.SetUp failed: secret 'db-credentials' not found",
          'app-pod',
        ),
      ],
      resources: [makeResource('Secret', 'db-credentials')],
    });
    const hypothesis = makeHypothesis({ category: 'missing-secret' });
    const result = collectFalsifyingEvidence(hypothesis, ctx);

    expect(result.contradicting.length).toBeGreaterThanOrEqual(1);
    expect(result.contradicting.some((e) => e.note.includes('db-credentials'))).toBe(true);
  });

  it('contradicting evidence note is descriptive (mentions present, exists, or actually)', () => {
    const ctx = makeContext({
      events: [
        makeEvent('FailedMount', "secret 'api-token' not found", 'app-pod'),
      ],
      resources: [makeResource('Secret', 'api-token')],
    });
    const hypothesis = makeHypothesis({ category: 'missing-secret' });
    const result = collectFalsifyingEvidence(hypothesis, ctx);

    const combined = result.contradicting.map((e) => e.note).join(' ').toLowerCase();
    expect(combined).toMatch(/present|exist|actually|found/);
  });

  it('returns no contradicting evidence when the named Secret is absent', () => {
    const ctx = makeContext({
      events: [
        makeEvent(
          'FailedMount',
          "MountVolume.SetUp failed: secret 'db-credentials' not found",
          'app-pod',
        ),
      ],
      // No Secret resource → should find nothing to falsify with
    });
    const hypothesis = makeHypothesis({ category: 'missing-secret' });
    const result = collectFalsifyingEvidence(hypothesis, ctx);

    // Secret is genuinely absent — no contradicting evidence
    expect(
      result.contradicting.some((e) => e.note.includes('db-credentials')),
    ).toBe(false);
  });

  it('extracts secret name from a log line and finds it in resources', () => {
    const ctx = makeContext({
      logs: [
        makeLogFile('logs/default/app-pod/app/current.log', [
          "ERROR failed to mount: secret 'app-tls' not found",
        ]),
      ],
      resources: [makeResource('Secret', 'app-tls')],
    });
    const hypothesis = makeHypothesis({ category: 'missing-secret' });
    const result = collectFalsifyingEvidence(hypothesis, ctx);

    expect(result.contradicting.some((e) => e.note.includes('app-tls'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// image-pull-failure (registry auth) — searches for successful pulls from same registry
// ---------------------------------------------------------------------------

describe('collectFalsifyingEvidence — image-pull-failure: searches for successful pulls from same registry', () => {
  it('adds contradicting evidence when a successful pull from the same registry exists in events', () => {
    const ctx = makeContext({
      events: [
        makeEvent(
          'Failed',
          'Failed to pull image "myregistry.io/myapp:v1.0": unauthorized: authentication required',
          'app-pod',
        ),
        makeEvent(
          'Pulled',
          'Successfully pulled image "myregistry.io/sidecar:v2.0"',
          'sidecar-pod',
        ),
      ],
    });
    const hypothesis = makeHypothesis({
      category: 'image-pull-failure',
      rootCause: 'Registry authentication failed for myregistry.io/myapp:v1.0',
    });
    const result = collectFalsifyingEvidence(hypothesis, ctx);

    expect(result.contradicting.length).toBeGreaterThanOrEqual(1);
    const combined = result.contradicting.map((e) => e.note).join(' ');
    expect(combined).toMatch(/myregistry\.io/);
  });

  it('contradicting evidence note mentions the registry and successful pull', () => {
    const ctx = makeContext({
      events: [
        makeEvent('Failed', 'Failed to pull image "gcr.io/myproject/app:v3": access denied', 'app-pod'),
        makeEvent('Pulled', 'Successfully pulled image "gcr.io/myproject/sidecar:latest"', 'other-pod'),
      ],
    });
    const hypothesis = makeHypothesis({
      category: 'image-pull-failure',
      rootCause: 'Registry auth failure for gcr.io/myproject',
    });
    const result = collectFalsifyingEvidence(hypothesis, ctx);

    const combined = result.contradicting.map((e) => e.note).join(' ').toLowerCase();
    expect(combined).toMatch(/gcr\.io/);
    expect(combined).toMatch(/success|pulled/);
  });

  it('does NOT add contradicting evidence when no successful pull from the same registry exists', () => {
    const ctx = makeContext({
      events: [
        makeEvent(
          'Failed',
          'Failed to pull image "myregistry.io/myapp:v1.0": unauthorized',
          'app-pod',
        ),
        // Different registry in the successful pull
        makeEvent(
          'Pulled',
          'Successfully pulled image "docker.io/library/nginx:latest"',
          'nginx-pod',
        ),
      ],
    });
    const hypothesis = makeHypothesis({
      category: 'image-pull-failure',
      rootCause: 'Registry auth failure for myregistry.io',
    });
    const result = collectFalsifyingEvidence(hypothesis, ctx);

    expect(
      result.contradicting.some((e) => /\bmyregistry\.io\b/.test(e.note)),
    ).toBe(false);
  });

  it('also finds successful pulls from registry mentioned in logs', () => {
    const ctx = makeContext({
      events: [
        makeEvent('Failed', 'Failed to pull image "private.registry.com/app:v1": auth failed', 'app-pod'),
      ],
      logs: [
        makeLogFile('logs/default/app-pod/app/current.log', [
          'INFO Successfully pulled image "private.registry.com/init-container:v1"',
        ]),
      ],
    });
    const hypothesis = makeHypothesis({
      category: 'image-pull-failure',
      rootCause: 'Auth failure for private.registry.com',
    });
    const result = collectFalsifyingEvidence(hypothesis, ctx);

    expect(
      result.contradicting.some((e) => /\bprivate\.registry\.com\b/i.test(e.note)),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// collectFalsifyingEvidence — returns empty assessment for unknown categories
// ---------------------------------------------------------------------------

describe('collectFalsifyingEvidence — unknown category returns empty assessment', () => {
  it('returns empty contradicting for a category without active falsification', () => {
    const ctx = makeContext({
      logs: [
        makeLogFile('logs/default/app-pod/app/current.log', ['INFO all good']),
      ],
    });
    const hypothesis = makeHypothesis({ category: 'config-error' });
    const result = collectFalsifyingEvidence(hypothesis, ctx);

    // config-error has no dedicated active falsification — should be empty
    expect(result.supporting).toHaveLength(0);
    expect(result.contradicting).toHaveLength(0);
    expect(result.missingDecisive).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Wiring: collectEvidenceForHypothesis merges falsifying evidence
// ---------------------------------------------------------------------------

describe('collectEvidenceForHypothesis — wiring of collectFalsifyingEvidence into contradicting', () => {
  it('dns-failure: hostname-specific falsification appears in final contradicting array', () => {
    const ctx = makeContext({
      logs: [
        makeLogFile('logs/default/app-pod/app/current.log', [
          'ERROR no such host: my-db',
          'INFO successfully connected to my-db',
        ]),
      ],
    });
    const hypothesis = makeHypothesis({ category: 'dns-failure' });
    const assessment = collectEvidenceForHypothesis(hypothesis, ctx);

    const combined = assessment.contradicting.map((e) => e.note).join(' ');
    expect(combined).toMatch(/my-db/);
  });

  it('missing-secret: named Secret presence appears in contradicting when it exists', () => {
    const ctx = makeContext({
      events: [
        makeEvent('FailedMount', "secret 'api-key' not found", 'app-pod'),
      ],
      resources: [makeResource('Secret', 'api-key')],
    });
    const hypothesis = makeHypothesis({ category: 'missing-secret' });
    const assessment = collectEvidenceForHypothesis(hypothesis, ctx);

    const combined = assessment.contradicting.map((e) => e.note).join(' ');
    expect(combined).toMatch(/api-key/);
  });

  it('image-pull-failure: successful registry pull appears in contradicting', () => {
    const ctx = makeContext({
      events: [
        makeEvent('Failed', 'Failed to pull image "myregistry.io/app:v1": unauthorized', 'app-pod'),
        makeEvent('Pulled', 'Successfully pulled image "myregistry.io/other:v2"', 'other-pod'),
      ],
    });
    const hypothesis = makeHypothesis({
      category: 'image-pull-failure',
      rootCause: 'Registry auth failure for myregistry.io',
    });
    const assessment = collectEvidenceForHypothesis(hypothesis, ctx);

    const combined = assessment.contradicting.map((e) => e.note).join(' ');
    expect(combined).toMatch(/myregistry\.io/);
  });
});

// ===========================================================================
// Two-part Kubernetes short-form hostname parsing  (service.namespace)
// ===========================================================================

describe('extractInClusterServiceRef — two-part hostname: api-service.staging via env URL', () => {
  // Pod in 'default' references http://api-service.staging:8080.
  // The service EXISTS in 'staging' → contradicting evidence expected.
  const ctx = makeContext({
    resources: [
      {
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: { name: 'app-pod', namespace: 'default' },
        spec: {
          containers: [
            {
              name: 'app',
              env: [{ name: 'BACKEND_URL', value: 'http://api-service.staging:8080' }],
            },
          ],
        },
      },
      makeResource('Service', 'api-service', 'staging'),
    ],
  });
  const hypothesis = makeHypothesis({ category: 'dns-failure' });
  const assessment = collectEvidenceForHypothesis(hypothesis, ctx);

  it('generates pod service-reference evidence mentioning api-service in staging', () => {
    const notes = assessment.supporting.map((e) => e.note).join(' ');
    expect(notes).toMatch(/api-service/);
    expect(notes).toMatch(/staging/);
  });

  it('finds contradicting evidence because api-service exists in namespace staging', () => {
    const contNotes = assessment.contradicting.map((e) => e.note).join(' ');
    expect(contNotes).toMatch(/api-service/);
    expect(contNotes).toMatch(/staging/);
  });
});

describe('extractInClusterServiceRef — two-part hostname: api-service.staging missing service', () => {
  // Pod references api-service.staging but the service does NOT exist.
  const ctx = makeContext({
    resources: [
      {
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: { name: 'app-pod', namespace: 'default' },
        spec: {
          containers: [
            {
              name: 'app',
              env: [{ name: 'BACKEND_URL', value: 'http://api-service.staging:8080' }],
            },
          ],
        },
      },
      // intentionally no Service 'api-service' in 'staging'
    ],
  });
  const hypothesis = makeHypothesis({ category: 'dns-failure' });
  const assessment = collectEvidenceForHypothesis(hypothesis, ctx);

  it('generates supporting evidence for the missing service with correct namespace', () => {
    const notes = assessment.supporting.map((e) => e.note).join(' ');
    expect(notes).toMatch(/api-service/);
    expect(notes).toMatch(/staging/);
  });

  it('includes pod evidence path for the pod referencing the cross-namespace service', () => {
    // The pod path uses the flat namespace JSON format (cluster-resources/pods/default.json);
    // the service-existence check emits the service path only when at least one
    // Service already exists in the target namespace.
    const paths = assessment.supporting.map((e) => e.path);
    expect(paths.some((p) => p === 'cluster-resources/pods/default.json')).toBe(true);
  });
});

describe('extractInClusterServiceRef — TLD blocklist: redis.io is not treated as in-cluster service', () => {
  // 'io' is a common TLD — redis.io must NOT be treated as Service 'redis' in
  // namespace 'io'.
  const ctx = makeContext({
    resources: [
      {
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: { name: 'app-pod', namespace: 'default' },
        spec: {
          containers: [
            {
              name: 'app',
              env: [{ name: 'REDIS_URL', value: 'http://redis.io:6379' }],
            },
          ],
        },
      },
    ],
  });
  const hypothesis = makeHypothesis({ category: 'dns-failure' });
  const assessment = collectEvidenceForHypothesis(hypothesis, ctx);

  it('does not generate service-reference evidence for redis in namespace io', () => {
    const combined = [...assessment.supporting, ...assessment.contradicting]
      .map((e) => `${e.path} ${e.note}`)
      .join(' ');

    // Must not create a path like cluster-resources/services/io/redis.yaml
    expect(combined).not.toContain('cluster-resources/services/io/redis.yaml');
    // Must not have a note claiming redis.io resolves to Service 'redis' in 'io'
    expect(combined).not.toMatch(/service 'redis'.*namespace 'io'/i);
  });
});

describe('extractInClusterServiceRef — two-part hostname: my-svc.kube-system', () => {
  // 'kube-system' is a valid Kubernetes namespace, not a TLD.
  // A pod in 'default' referencing http://my-svc.kube-system:8080 should
  // extract a service reference to 'my-svc' in namespace 'kube-system'.
  const ctx = makeContext({
    resources: [
      {
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: { name: 'app-pod', namespace: 'default' },
        spec: {
          containers: [
            {
              name: 'app',
              env: [{ name: 'HEALTH_ENDPOINT', value: 'http://my-svc.kube-system:8080' }],
            },
          ],
        },
      },
      // Service does NOT exist → supporting (missing service) evidence expected
    ],
  });
  const hypothesis = makeHypothesis({ category: 'dns-failure' });
  const assessment = collectEvidenceForHypothesis(hypothesis, ctx);

  it('generates supporting evidence referencing my-svc in namespace kube-system', () => {
    const notes = assessment.supporting.map((e) => e.note).join(' ');
    expect(notes).toMatch(/my-svc/);
    expect(notes).toMatch(/kube-system/);
  });

  it('evidence path references the pod resource that declares the cross-namespace env var', () => {
    // Pod evidence path uses flat namespace JSON (cluster-resources/pods/default.json);
    // the service path for kube-system/my-svc only appears if a Service
    // already exists in kube-system (absent from this minimal context).
    const paths = assessment.supporting.map((e) => e.path);
    expect(paths.some((p) => p === 'cluster-resources/pods/default.json')).toBe(true);
  });
});

describe('extractInClusterServiceRef — backward compat: single-part hostname still works', () => {
  // api-service (no dot) → Service 'api-service' in the pod's own namespace
  const ctx = makeContext({
    resources: [
      {
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: { name: 'app-pod', namespace: 'default' },
        spec: {
          containers: [
            {
              name: 'app',
              env: [{ name: 'SVC_HOST', value: 'api-service' }],
            },
          ],
        },
      },
    ],
  });
  const hypothesis = makeHypothesis({ category: 'dns-failure' });
  const assessment = collectEvidenceForHypothesis(hypothesis, ctx);

  it('generates pod service-reference evidence for single-part hostname api-service', () => {
    const notes = assessment.supporting.map((e) => e.note).join(' ');
    expect(notes).toMatch(/api-service/);
  });

  it('service lookup uses the pod own namespace (default)', () => {
    const paths = assessment.supporting.map((e) => e.path);
    expect(paths.some((p) => p.includes('default'))).toBe(true);
  });
});

describe('extractInClusterServiceRef — backward compat: FQDN hostname still works', () => {
  // api-service.default.svc.cluster.local → Service 'api-service' in 'default'
  const ctx = makeContext({
    resources: [
      {
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: { name: 'app-pod', namespace: 'default' },
        spec: {
          containers: [
            {
              name: 'app',
              env: [
                {
                  name: 'DATABASE_URL',
                  value: 'http://api-service.default.svc.cluster.local:5432/db',
                },
              ],
            },
          ],
        },
      },
    ],
  });
  const hypothesis = makeHypothesis({ category: 'dns-failure' });
  const assessment = collectEvidenceForHypothesis(hypothesis, ctx);

  it('generates pod service-reference evidence for FQDN hostname', () => {
    const notes = assessment.supporting.map((e) => e.note).join(' ');
    expect(notes).toMatch(/api-service/);
  });

  it('pod evidence path references the pod resource in the default namespace', () => {
    // The pod-reference evidence path uses flat namespace JSON format.
    // The dedicated service path (cluster-resources/services/default.json)
    // is only emitted when the target namespace already has ≥1 Service in the bundle.
    const paths = assessment.supporting.map((e) => e.path);
    expect(paths.some((p) => p === 'cluster-resources/pods/default.json')).toBe(true);
  });
});

describe('extractInClusterServiceRef — dns-failure hypothesis with two-part env var URL', () => {
  // End-to-end: dns-failure hypothesis + pod env var http://api-service.staging:8080
  // confirms the service reference is extracted with namespace 'staging'.
  it('confirms service reference with namespace staging from env var URL', () => {
    const ctx = makeContext({
      resources: [
        {
          apiVersion: 'v1',
          kind: 'Pod',
          metadata: { name: 'worker-pod', namespace: 'production' },
          spec: {
            containers: [
              {
                name: 'worker',
                env: [{ name: 'API_URL', value: 'http://api-service.staging:8080' }],
              },
            ],
          },
        },
      ],
      logs: [
        makeLogFile('logs/production/worker-pod/worker/current.log', [
          'ERROR dial tcp: lookup api-service.staging: no such host',
        ]),
      ],
    });
    const hypothesis = makeHypothesis({ category: 'dns-failure' });
    const assessment = collectEvidenceForHypothesis(hypothesis, ctx);

    // Should surface evidence for 'api-service' in namespace 'staging'
    const allNotes = [...assessment.supporting, ...assessment.contradicting]
      .map((e) => e.note)
      .join(' ');
    expect(allNotes).toMatch(/api-service/);
    expect(allNotes).toMatch(/staging/);

    // All evidence notes should surface 'api-service' + 'staging' so the
    // caller can identify the cross-namespace service dependency.
    // (Paths reference the pod/log files, not the service namespace directly.)
  });
});

// ===========================================================================
// Cross-namespace service correlation in DNS failure evidence collector
// ===========================================================================

describe('collectDnsFailureEvidence — cross-namespace: service exists in different namespace', () => {
  // Context: Pod in 'default' with env API_URL=http://api-service.staging:8080
  // No Service in 'staging', but Service 'api-service' exists in 'default'.
  const ctx = makeContext({
    resources: [
      {
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: { name: 'app-pod', namespace: 'default' },
        spec: {
          containers: [
            {
              name: 'app',
              env: [{ name: 'API_URL', value: 'http://api-service.staging:8080' }],
            },
          ],
        },
      },
      makeResource('Service', 'api-service', 'default'),
    ],
  });
  const hypothesis = makeHypothesis({ category: 'dns-failure' });
  const assessment = collectEvidenceForHypothesis(hypothesis, ctx);

  it('produces cross-namespace supporting evidence with exists-in-namespace note', () => {
    const crossNsEvidence = assessment.supporting.filter(
      (e) => /exists in namespace .* \(not /i.test(e.note),
    );
    expect(crossNsEvidence.length).toBeGreaterThanOrEqual(1);
  });

  it('cross-namespace note mentions the found namespace (default)', () => {
    const note = assessment.supporting
      .filter((e) => /exists in namespace .* \(not /i.test(e.note))
      .map((e) => e.note)
      .join(' ');
    expect(note).toMatch(/default/);
  });

  it('cross-namespace note mentions the target namespace that was wrong (staging)', () => {
    const note = assessment.supporting
      .filter((e) => /exists in namespace .* \(not /i.test(e.note))
      .map((e) => e.note)
      .join(' ');
    expect(note).toMatch(/staging/);
  });

  it('cross-namespace note mentions the service name (api-service)', () => {
    const note = assessment.supporting
      .filter((e) => /exists in namespace .* \(not /i.test(e.note))
      .map((e) => e.note)
      .join(' ');
    expect(note).toMatch(/api-service/);
  });

  it('cross-namespace note mentions the env var name (API_URL)', () => {
    const note = assessment.supporting
      .filter((e) => /exists in namespace .* \(not /i.test(e.note))
      .map((e) => e.note)
      .join(' ');
    expect(note).toMatch(/API_URL/);
  });

  it('cross-namespace evidence path points to the service file in the found namespace', () => {
    const paths = assessment.supporting
      .filter((e) => /exists in namespace .* \(not /i.test(e.note))
      .map((e) => e.path);
    // Path uses flat namespace JSON: cluster-resources/services/default.json
    expect(paths.some((p) => p === 'cluster-resources/services/default.json')).toBe(true);
  });

  it('cross-namespace note contains a corrected URL suggestion', () => {
    const note = assessment.supporting
      .filter((e) => /exists in namespace .* \(not /i.test(e.note))
      .map((e) => e.note)
      .join(' ');
    // Should suggest updating from the wrong URL to the correct namespace URL
    expect(note).toMatch(/Update/);
    expect(note).toMatch(/http:\/\/api-service\.default/);
  });

  it('CoreDNS is NOT in missingDecisive when cross-namespace match is confirmed', () => {
    const joined = assessment.missingDecisive.join(' ').toLowerCase();
    expect(joined).not.toMatch(/coredns|kube-dns/);
  });
});

describe('collectDnsFailureEvidence — cross-namespace: service found in same (target) namespace', () => {
  // Context: Pod in 'staging' with env API_URL=http://api-service.staging:8080
  // Service 'api-service' EXISTS in 'staging' → contradicting (not cross-namespace).
  const ctx = makeContext({
    resources: [
      {
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: { name: 'app-pod', namespace: 'staging' },
        spec: {
          containers: [
            {
              name: 'app',
              env: [{ name: 'API_URL', value: 'http://api-service.staging:8080' }],
            },
          ],
        },
      },
      makeResource('Service', 'api-service', 'staging'),
    ],
  });
  const hypothesis = makeHypothesis({ category: 'dns-failure' });
  const assessment = collectEvidenceForHypothesis(hypothesis, ctx);

  it('does not produce cross-namespace evidence when service is in its target namespace', () => {
    const crossNsEvidence = assessment.supporting.filter(
      (e) => /exists in namespace .* \(not /i.test(e.note),
    );
    expect(crossNsEvidence).toHaveLength(0);
  });

  it('produces contradicting evidence because the service exists in the target namespace', () => {
    expect(
      assessment.contradicting.some(
        (e) => /api-service/i.test(e.note) && /staging/i.test(e.note),
      ),
    ).toBe(true);
  });
});

describe('collectDnsFailureEvidence — cross-namespace: service not found in ANY namespace', () => {
  // Context: Pod in 'default' with env API_URL=http://api-service.staging:8080
  // No Service 'api-service' anywhere → no cross-namespace suggestion.
  const ctx = makeContext({
    resources: [
      {
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: { name: 'app-pod', namespace: 'default' },
        spec: {
          containers: [
            {
              name: 'app',
              env: [{ name: 'API_URL', value: 'http://api-service.staging:8080' }],
            },
          ],
        },
      },
      // intentionally no Service resources
    ],
  });
  const hypothesis = makeHypothesis({ category: 'dns-failure' });
  const assessment = collectEvidenceForHypothesis(hypothesis, ctx);

  it('does not produce cross-namespace evidence when service is absent from all namespaces', () => {
    const crossNsEvidence = assessment.supporting.filter(
      (e) => /exists in namespace .* \(not /i.test(e.note),
    );
    expect(crossNsEvidence).toHaveLength(0);
  });

  it('still surfaces the pod reference as supporting evidence (missing service path)', () => {
    const notes = assessment.supporting.map((e) => e.note).join(' ');
    expect(notes).toMatch(/api-service/);
  });
});

describe('collectDnsFailureEvidence — cross-namespace: multiple pods reference same missing service', () => {
  // Context: Two pods in 'default' both reference api-service.staging via different
  // env vars; api-service exists in 'production' (not 'staging').
  const ctx = makeContext({
    resources: [
      {
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: { name: 'app-pod', namespace: 'default' },
        spec: {
          containers: [
            {
              name: 'app',
              env: [{ name: 'API_URL', value: 'http://api-service.staging:8080' }],
            },
          ],
        },
      },
      {
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: { name: 'worker-pod', namespace: 'default' },
        spec: {
          containers: [
            {
              name: 'worker',
              env: [{ name: 'BACKEND_URL', value: 'http://api-service.staging:8080' }],
            },
          ],
        },
      },
      makeResource('Service', 'api-service', 'production'),
    ],
  });
  const hypothesis = makeHypothesis({ category: 'dns-failure' });
  const assessment = collectEvidenceForHypothesis(hypothesis, ctx);

  it('produces cross-namespace evidence for the missing service', () => {
    const crossNsEvidence = assessment.supporting.filter(
      (e) => /exists in namespace .* \(not /i.test(e.note),
    );
    expect(crossNsEvidence.length).toBeGreaterThanOrEqual(1);
  });

  it('cross-namespace note mentions all relevant env vars (API_URL and BACKEND_URL)', () => {
    const notes = assessment.supporting
      .filter((e) => /exists in namespace .* \(not /i.test(e.note))
      .map((e) => e.note)
      .join(' ');
    expect(notes).toMatch(/API_URL/);
    expect(notes).toMatch(/BACKEND_URL/);
  });

  it('cross-namespace note mentions the found namespace (production)', () => {
    const notes = assessment.supporting
      .filter((e) => /exists in namespace .* \(not /i.test(e.note))
      .map((e) => e.note)
      .join(' ');
    expect(notes).toMatch(/production/);
  });
});

// ===========================================================================
// Readiness probe evidence scoping — step 4
// ===========================================================================

/** Helper: make a healthy pod with a readinessProbe in the given namespace. */
function makeHealthyPodWithProbe(name: string, namespace: string): K8sResource {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name, namespace },
    spec: {
      containers: [
        {
          name,
          readinessProbe: { httpGet: { path: '/health', port: 8080 } },
        },
      ],
    },
    status: {
      phase: 'Running',
      conditions: [{ type: 'Ready', status: 'True' }],
      containerStatuses: [{ name, ready: true, restartCount: 0, state: { running: {} } }],
    },
  };
}

/** Helper: make an unhealthy pod with a readinessProbe in the given namespace. */
function makeUnhealthyPodWithProbe(name: string, namespace: string): K8sResource {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name, namespace },
    spec: {
      containers: [
        {
          name,
          readinessProbe: { httpGet: { path: '/health', port: 8080 } },
        },
      ],
    },
    status: {
      phase: 'Running',
      conditions: [{ type: 'Ready', status: 'False' }],
      containerStatuses: [{ name, ready: false, restartCount: 3, state: { waiting: { reason: 'CrashLoopBackOff' } } }],
    },
  };
}

// ---------------------------------------------------------------------------
// Test 1: Unhealthy event for app-pod in default — coredns (kube-system,
//         healthy) must be excluded from supporting evidence.
// ---------------------------------------------------------------------------
describe('collectReadinessFailureEvidence — scoping: kube-system healthy pod excluded when Unhealthy event is in default', () => {
  const ctx = makeContext({
    events: [
      makeEvent('Unhealthy', 'Readiness probe failed: HTTP probe failed with statuscode: 503', 'app-pod', 'Pod', 'default'),
    ],
    resources: [
      makeUnhealthyPodWithProbe('app-pod', 'default'),
      makeHealthyPodWithProbe('coredns-abc', 'kube-system'),
    ],
  });
  const hypothesis = makeHypothesis({ category: 'readiness-failure' });
  const assessment = collectEvidenceForHypothesis(hypothesis, ctx);

  it('app-pod probe config appears in supporting evidence', () => {
    // Path is namespace-level JSON; pod name appears in the evidence note
    expect(
      assessment.supporting.some(
        (e) => e.path === 'cluster-resources/pods/default.json' || /app-pod/i.test(e.note),
      ),
    ).toBe(true);
  });

  it('coredns probe config does NOT appear in supporting evidence', () => {
    expect(
      assessment.supporting.some((e) => e.path.includes('coredns')),
    ).toBe(false);
  });

  it('coredns Ready=True does NOT appear in contradicting evidence', () => {
    expect(
      assessment.contradicting.some((e) => e.path.includes('coredns')),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test 2: No Unhealthy events — unhealthy web-app (default) included,
//         healthy etcd (kube-system) excluded.
// ---------------------------------------------------------------------------
describe('collectReadinessFailureEvidence — scoping: no events, unhealthy non-system pod included, healthy system pod excluded', () => {
  const ctx = makeContext({
    events: [],
    resources: [
      makeUnhealthyPodWithProbe('web-app', 'default'),
      makeHealthyPodWithProbe('etcd-server', 'kube-system'),
    ],
  });
  const hypothesis = makeHypothesis({ category: 'readiness-failure' });
  const assessment = collectEvidenceForHypothesis(hypothesis, ctx);

  it('unhealthy web-app (default) probe config appears in supporting evidence', () => {
    // Path is namespace-level JSON; pod name appears in the evidence note
    expect(
      assessment.supporting.some(
        (e) => e.path === 'cluster-resources/pods/default.json' || /web-app/i.test(e.note),
      ),
    ).toBe(true);
  });

  it('healthy etcd (kube-system) probe config does NOT appear in supporting evidence', () => {
    expect(
      assessment.supporting.some((e) => e.path.includes('etcd')),
    ).toBe(false);
  });

  it('healthy etcd (kube-system) does NOT appear in contradicting evidence', () => {
    expect(
      assessment.contradicting.some((e) => e.path.includes('etcd')),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test 3: Unhealthy event for pod in staging — healthy nginx (default)
//         excluded, unhealthy api (staging) included.
// ---------------------------------------------------------------------------
describe('collectReadinessFailureEvidence — scoping: Unhealthy event in staging, healthy pod in default excluded', () => {
  const ctx = makeContext({
    events: [
      makeEvent('Unhealthy', 'Readiness probe failed', 'api', 'Pod', 'staging'),
    ],
    resources: [
      makeHealthyPodWithProbe('nginx', 'default'),
      makeUnhealthyPodWithProbe('api', 'staging'),
    ],
  });
  const hypothesis = makeHypothesis({ category: 'readiness-failure' });
  const assessment = collectEvidenceForHypothesis(hypothesis, ctx);

  it('api pod (staging) probe config appears in supporting evidence', () => {
    // Path is namespace-level JSON (staging namespace); pod name in note
    expect(
      assessment.supporting.some(
        (e) => e.path === 'cluster-resources/pods/staging.json' || /\bapi\b/i.test(e.note),
      ),
    ).toBe(true);
  });

  it('healthy nginx (default) probe config does NOT appear in supporting evidence', () => {
    expect(
      assessment.supporting.some((e) => e.path.includes('nginx') && e.artifactType === 'kubernetes-resource'),
    ).toBe(false);
  });

  it('healthy nginx (default) Ready=True does NOT appear in contradicting evidence', () => {
    expect(
      assessment.contradicting.some((e) => e.path.includes('nginx')),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test 4: Existing basic tests are unaffected by the scoping change.
//         Verify Unhealthy event + probe config detection still works.
// ---------------------------------------------------------------------------
describe('collectReadinessFailureEvidence — scoping: existing behaviour preserved (Unhealthy + probe)', () => {
  const ctx = makeContext({
    events: [
      makeEvent('Unhealthy', 'Readiness probe failed: HTTP probe failed with statuscode: 503', 'app-pod'),
    ],
    resources: [
      {
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: { name: 'app-pod', namespace: 'default' },
        spec: {
          containers: [
            {
              name: 'app',
              readinessProbe: {
                httpGet: { path: '/healthz', port: 8080 },
                initialDelaySeconds: 5,
                periodSeconds: 10,
              },
            },
          ],
        },
      },
    ],
  });
  const hypothesis = makeHypothesis({ category: 'readiness-failure' });
  const assessment = collectEvidenceForHypothesis(hypothesis, ctx);

  it('finds supporting evidence for Unhealthy event', () => {
    expect(assessment.supporting.length).toBeGreaterThanOrEqual(1);
  });

  it('finds probe config evidence for app-pod in default', () => {
    // Path is namespace-level JSON; pod name and probe info are in the note
    expect(
      assessment.supporting.some(
        (e) =>
          (e.path === 'cluster-resources/pods/default.json' || /app-pod/i.test(e.note)) &&
          /readiness probe/i.test(e.note),
      ),
    ).toBe(true);
  });

  it('supporting evidence note mentions readiness or probe', () => {
    const notes = assessment.supporting.map((e) => e.note).join(' ').toLowerCase();
    expect(notes).toMatch(/readiness|probe|unhealthy/);
  });

  it('missingDecisive mentions detailed probe output', () => {
    const joined = assessment.missingDecisive.join(' ').toLowerCase();
    expect(joined).toMatch(/probe|output|detail/);
  });
});

// ---------------------------------------------------------------------------
// 7.4 — Evidence paths use real Troubleshoot bundle format
// ---------------------------------------------------------------------------
//
// Real Troubleshoot bundles store resources in flat namespace JSON files
// (e.g. cluster-resources/pods/default.json containing a PodList), NOT in
// per-resource files like cluster-resources/pods/default/app-pod.yaml.
// Evidence paths produced by the collector must match the real bundle format
// so that grounding checks in the AI investigator can match them against the
// chunk index (which uses actual source file paths from the bundle manifest).

describe('evidence paths use real bundle format (7.4)', () => {
  // A different secret must exist so the secret inventory is non-null for the
  // namespace; otherwise the structural pod-reference check is skipped.
  const dummySecret = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: 'other-secret', namespace: 'default' },
    data: {},
  };

  const ctx = makeContext({
    resources: [
      {
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: { name: 'app-pod', namespace: 'default' },
        spec: {
          volumes: [
            { name: 'secret-vol', secret: { secretName: 'app-credentials' } },
          ],
          containers: [{ name: 'app', image: 'myrepo/app:v1' }],
        },
        status: {
          phase: 'Running',
          conditions: [{ type: 'Ready', status: 'False' }],
          containerStatuses: [
            {
              name: 'app',
              ready: false,
              restartCount: 5,
              state: { waiting: { reason: 'CrashLoopBackOff' } },
            },
          ],
        },
      },
      dummySecret as import('../../types/index.js').K8sResource,
    ],
    events: [
      makeEvent('BackOff', 'Back-off restarting failed container', 'app-pod'),
      makeEvent('FailedMount', "secret 'app-credentials' not found", 'app-pod'),
    ],
  });

  const hypothesis = makeHypothesis({ category: 'missing-secret' });
  const assessment = collectEvidenceForHypothesis(hypothesis, ctx);

  it('pod evidence path uses flat namespace JSON format (not per-resource yaml)', () => {
    const podPaths = assessment.supporting
      .map((e) => e.path)
      .filter((p) => p.includes('pods'));

    // Must match: cluster-resources/pods/default.json
    expect(podPaths.some((p) => /cluster-resources\/pods\/default\.json$/.test(p))).toBe(true);

    // Must NOT use old per-resource format
    expect(podPaths.some((p) => /pods\/default\/app-pod/.test(p))).toBe(false);
  });

  it('secret evidence path uses flat namespace JSON format', () => {
    const secretPaths = assessment.supporting
      .map((e) => e.path)
      .filter((p) => p.includes('secret'));

    // Must match: cluster-resources/secrets/default.json
    expect(secretPaths.some((p) => /cluster-resources\/secrets\/default\.json$/.test(p))).toBe(true);

    // Must NOT use old per-resource format
    expect(secretPaths.some((p) => /secrets\/default\/app-credentials/.test(p))).toBe(false);
  });

  it('events evidence path already uses the correct flat format', () => {
    // missingDecisive is string[], not EvidenceItem[] — only spread the evidence arrays
    const allPaths = [
      ...assessment.supporting,
      ...assessment.contradicting,
    ].map((e) => e.path);

    const eventPaths = allPaths.filter((p) => p.includes('events'));
    // cluster-resources/events/default.json — no change needed, just confirm
    expect(eventPaths.length).toBeGreaterThan(0);
    expect(eventPaths.every((p) => /cluster-resources\/events\/[\w-]+\.json$/.test(p))).toBe(true);
  });

  it('evidence notes still name the specific resource even though path is namespace-level', () => {
    // The path no longer contains the resource name, but the note must still
    // reference the specific pod or secret so the finding is actionable.
    const combined = assessment.supporting.map((e) => e.note).join(' ');
    expect(combined).toMatch(/app-pod|app-credentials/i);
  });
});
