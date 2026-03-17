import { describe, it, expect } from 'vitest';
import type { BundleProfile, K8sResource, K8sEvent } from '../../types/index.js';
import type { InvestigatorContext } from '../types.js';
import type { LogFile, LogLine } from '../../parsers/index.js';
import type { Hypothesis } from '../hypothesis-types.js';
import { collectEvidenceForHypothesis } from '../hypothesis-evidence-collector.js';

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
// Empty context → missingDecisive populated, no supporting evidence
// ===========================================================================

describe('collectEvidenceForHypothesis — empty context', () => {
  const emptyCtx = makeContext();

  const categories = [
    'missing-secret',
    'dns-failure',
    'image-pull-failure',
    'config-error',
    'connectivity-failure',
    'readiness-failure',
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
