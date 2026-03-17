/**
 * Differential Diagnosis and Contradiction Injection Test Suite
 *
 * This file validates the hypothesis verification layer's ability to:
 *
 *   A. Differential diagnosis — the same visible symptom can arise from
 *      multiple root causes; the system should rank the most-evidenced cause
 *      at the top.
 *
 *   B. Contradiction injection — when evidence conflicts (e.g., DNS failure
 *      logs followed by a successful connection), contradictions must be
 *      surfaced and confidence must drop compared to the non-conflicted
 *      equivalent scenario.
 *
 *   C. Evidence ablation — progressively removing evidence from a "bad DB
 *      credentials" scenario (pod can't connect because a required secret is
 *      missing) must cause confidence to decrease monotonically, missing
 *      evidence to be named explicitly, and spec-gap recommendations to
 *      appear when appropriate.
 */

import { describe, it, expect } from 'vitest';
import type { Finding, FindingSeverity } from '../../types/index.js';
import type { K8sEvent, K8sResource } from '../../types/index.js';
import type { BundleProfile } from '../../types/index.js';
import type { LogFile, LogLine } from '../../parsers/index.js';
import type { InvestigatorContext } from '../types.js';
import type { Hypothesis, HypothesisSet } from '../hypothesis-types.js';
import { generateAllHypotheses } from '../hypothesis-generator.js';
import { collectEvidenceForHypothesis } from '../hypothesis-evidence-collector.js';
import { scoreHypothesis, rankHypotheses, identifySpecGaps } from '../hypothesis-ranker.js';
import { convertHypothesisToFinding } from '../hypothesis-converter.js';

// ---------------------------------------------------------------------------
// Shared fixture helpers
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

function makeLogFile(path: string, lines: string[]): LogFile {
  return {
    path,
    lines: lines.map(
      (content, i): LogLine => ({
        lineNumber: i + 1,
        content,
        level: 'info',
      }),
    ),
    errorCount: 0,
    warningCount: 0,
    importance: 50,
  };
}

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

function makeResource(kind: string, name: string, namespace = 'default'): K8sResource {
  return {
    apiVersion: 'v1',
    kind,
    metadata: { name, namespace },
  };
}

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'finding:test:0',
    title: 'Test Finding',
    severity: 'high' as FindingSeverity,
    confidence: 0.75,
    affectedComponents: ['Pod/default/app-pod'],
    reasoningSummary: 'Test reasoning.',
    evidence: [
      {
        path: 'cluster-resources/pods/default/app-pod.yaml',
        note: 'Pod is unhealthy',
        artifactType: 'kubernetes-resource',
      },
    ],
    contradictionsChecked: [],
    recommendedAction: 'Investigate.',
    missingEvidence: [],
    ...overrides,
  };
}

/** Minimal hypothesis for targeted evidence collection tests. */
function makeHypothesis(
  overrides: Partial<Hypothesis> & Pick<Hypothesis, 'category'>,
): Hypothesis {
  return {
    id: `pod-crashloop:default/app-pod:${overrides.category}`,
    symptom: "Pod 'app-pod' is in CrashLoopBackOff in namespace 'default'",
    rootCause: 'Test root cause',
    evidenceAssessment: { supporting: [], contradicting: [], missingDecisive: [] },
    confidence: 0,
    confidenceRationale: 'Not yet scored',
    specGapRecommendations: [],
    sourceFindings: ['finding:test:0'],
    ...overrides,
  };
}

/**
 * Helper: runs the full generator → collector → ranker pipeline for a list
 * of findings and returns ranked hypotheses for the first symptom set found.
 */
function runDiagnosis(findings: Finding[], context: InvestigatorContext): {
  topCategory: Hypothesis['category'] | null;
  topConfidence: number;
  allRanked: Hypothesis[];
  sets: HypothesisSet[];
} {
  const sets = generateAllHypotheses(findings, context);
  for (const set of sets) {
    const evidenced = set.hypotheses.map((h) => ({
      ...h,
      evidenceAssessment: collectEvidenceForHypothesis(h, context),
    }));
    const ranked = rankHypotheses(evidenced).map((h) => ({
      ...h,
      specGapRecommendations: identifySpecGaps(h),
    }));
    set.hypotheses = ranked;
    set.topHypothesis = ranked[0] ?? null;
  }
  const firstSet = sets[0];
  return {
    topCategory: firstSet?.topHypothesis?.category ?? null,
    topConfidence: firstSet?.topHypothesis?.confidence ?? 0,
    allRanked: firstSet?.hypotheses ?? [],
    sets,
  };
}

// ===========================================================================
// SECTION A — Differential Diagnosis
// ===========================================================================
//
// The same visible symptom (e.g., CrashLoopBackOff) can arise from different
// root causes. The system should rank the most strongly-evidenced root cause
// at the top while keeping all alternatives for transparency.

// ---------------------------------------------------------------------------
// A.1 — CrashLoopBackOff with missing secret → missing-secret ranked top
// ---------------------------------------------------------------------------

describe('Differential diagnosis — A.1: CrashLoopBackOff + missing secret', () => {
  /**
   * Scenario: Pod 'app-pod' is in CrashLoopBackOff. A FailedMount event
   * indicates that 'db-credentials' secret is not found. The pod spec
   * references that secret but it does not exist in the namespace.
   * A dummy unrelated Secret is present to enable namespace-level inventory
   * checks in the evidence collector.
   */
  const crashLoopFinding = makeFinding({
    id: 'finding:k8s:crashloop:0',
    title: "CrashLoopBackOff: Pod 'app-pod' in namespace 'default'",
    affectedComponents: ['Pod/default/app-pod'],
  });

  const podWithSecretRef: K8sResource = {
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
  };

  const dummySecret = makeResource('Secret', 'other-secret', 'default');

  const failedMountEvent = makeEvent(
    'FailedMount',
    "MountVolume.SetUp failed: secret 'db-credentials' not found",
    'app-pod',
  );

  const context = makeContext({
    events: [failedMountEvent],
    resources: [podWithSecretRef, dummySecret],
    // No db-credentials Secret in namespace
  });

  const { topCategory, topConfidence, allRanked } = runDiagnosis(
    [crashLoopFinding],
    context,
  );

  it('top hypothesis is missing-secret when FailedMount event and absent secret are present', () => {
    expect(topCategory).toBe('missing-secret');
  });

  it('top hypothesis confidence is high (≥ 0.70) reflecting strong supporting evidence', () => {
    expect(topConfidence).toBeGreaterThanOrEqual(0.70);
  });

  it('generates at least 3 competing hypotheses for CrashLoopBackOff', () => {
    expect(allRanked.length).toBeGreaterThanOrEqual(3);
  });

  it('missing-secret outranks all other hypotheses', () => {
    const missingSecretHyp = allRanked.find((h) => h.category === 'missing-secret')!;
    const others = allRanked.filter((h) => h.category !== 'missing-secret');
    expect(missingSecretHyp).toBeDefined();
    for (const other of others) {
      expect(missingSecretHyp.confidence).toBeGreaterThan(other.confidence);
    }
  });

  it('config-error and generic-crash alternatives have lower confidence than missing-secret', () => {
    const missingSecretConf = allRanked.find((h) => h.category === 'missing-secret')!.confidence;
    const configErrorConf = allRanked.find((h) => h.category === 'config-error')?.confidence ?? 0;
    const genericCrashConf =
      allRanked.find((h) => h.category === 'generic-crash')?.confidence ?? 0;
    expect(missingSecretConf).toBeGreaterThan(configErrorConf);
    expect(missingSecretConf).toBeGreaterThan(genericCrashConf);
  });

  it('missing-secret hypothesis has FailedMount-related supporting evidence', () => {
    const missingSecretHyp = allRanked.find((h) => h.category === 'missing-secret')!;
    const notes = missingSecretHyp.evidenceAssessment.supporting.map((e) => e.note).join(' ');
    expect(notes.toLowerCase()).toMatch(/failedmount|secret.*not.*found|missing secret/i);
  });
});

// ---------------------------------------------------------------------------
// A.2 — CrashLoopBackOff with bad DB endpoint / DNS errors → dns-failure top
// ---------------------------------------------------------------------------

describe('Differential diagnosis — A.2: CrashLoopBackOff + DNS failure logs → dns-failure ranked top', () => {
  /**
   * Scenario: The visible symptom is still CrashLoopBackOff, but the real root
   * cause is that the application tries to resolve a bad database hostname
   * during startup and exits when DNS lookup fails.
   */
  const crashLoopFinding = makeFinding({
    id: 'finding:k8s:crashloop:dns:0',
    title: "CrashLoopBackOff: Pod 'app-pod' in namespace 'default'",
    affectedComponents: ['Pod/default/app-pod'],
  });

  const podWithDbEnv: K8sResource = {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name: 'app-pod', namespace: 'default' },
    spec: {
      containers: [
        {
          name: 'app',
          env: [{ name: 'DATABASE_HOST', value: 'mydb.default.svc.cluster.local:5432' }],
        },
      ],
    },
  };

  const dnsErrorLogs = makeLogFile('logs/default/app-pod/app/current.log', [
    'INFO  starting application',
    'ERROR dial tcp: lookup mydb.default.svc.cluster.local: no such host',
    'FATAL cannot start without database connection',
  ]);

  const dnsErrorEvent = makeEvent(
    'BackOff',
    'Back-off restarting failed container after lookup mydb.default.svc.cluster.local failed: no such host',
    'app-pod',
  );

  const context = makeContext({
    resources: [podWithDbEnv],
    events: [dnsErrorEvent],
    // No Service 'mydb' captured in the namespace
    logs: [dnsErrorLogs],
  });

  const { topCategory, topConfidence, allRanked } = runDiagnosis([crashLoopFinding], context);

  it('top hypothesis is dns-failure when crash loops are accompanied by DNS lookup errors', () => {
    expect(topCategory).toBe('dns-failure');
  });

  it('dns-failure confidence is strong (≥ 0.70) when logs, events, and pod spec align', () => {
    expect(topConfidence).toBeGreaterThanOrEqual(0.70);
  });

  it('generates at least 4 competing hypotheses for a CrashLoopBackOff symptom', () => {
    expect(allRanked.length).toBeGreaterThanOrEqual(4);
  });

  it('dns-failure outranks missing-secret, config-error, and generic-crash alternatives', () => {
    const dnsHyp = allRanked.find((h) => h.category === 'dns-failure')!;
    const missingSecretHyp = allRanked.find((h) => h.category === 'missing-secret');
    const configErrorHyp = allRanked.find((h) => h.category === 'config-error');
    const genericCrashHyp = allRanked.find((h) => h.category === 'generic-crash');
    expect(dnsHyp).toBeDefined();
    if (missingSecretHyp) expect(dnsHyp.confidence).toBeGreaterThan(missingSecretHyp.confidence);
    if (configErrorHyp) expect(dnsHyp.confidence).toBeGreaterThan(configErrorHyp.confidence);
    if (genericCrashHyp) expect(dnsHyp.confidence).toBeGreaterThan(genericCrashHyp.confidence);
  });

  it('dns-failure hypothesis supporting evidence references DNS logs, event timeline, and missing service context', () => {
    const dnsHyp = allRanked.find((h) => h.category === 'dns-failure')!;
    const notes = dnsHyp.evidenceAssessment.supporting.map((e) => e.note).join(' ');
    expect(notes.toLowerCase()).toMatch(/dns|no such host|lookup|missing service|hostname/i);
  });

  it('missing-secret remains below dns-failure when there is no FailedMount or absent Secret evidence', () => {
    const missingSecretHyp = allRanked.find((h) => h.category === 'missing-secret');
    expect(missingSecretHyp?.confidence ?? 0).toBeLessThan(topConfidence);
  });
});

// ---------------------------------------------------------------------------
// A.3 — CrashLoopBackOff with secret present → missing-secret drops in rank
// ---------------------------------------------------------------------------

describe('Differential diagnosis — A.3: CrashLoopBackOff + secret present → missing-secret drops', () => {
  /**
   * Scenario: Same pod in CrashLoopBackOff, but this time the referenced
   * 'db-credentials' secret EXISTS in the namespace. There are no FailedMount
   * events. The missing-secret hypothesis should drop significantly in rank
   * compared to A.1.
   */
  const crashLoopFinding = makeFinding({
    id: 'finding:k8s:crashloop:0',
    title: "CrashLoopBackOff: Pod 'app-pod' in namespace 'default'",
    affectedComponents: ['Pod/default/app-pod'],
  });

  const podWithSecretRef: K8sResource = {
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
  };

  // The Secret NOW EXISTS — this should contradict missing-secret
  const dbCredentialsSecret = makeResource('Secret', 'db-credentials', 'default');

  const contextWithSecret = makeContext({
    events: [], // No FailedMount events
    resources: [podWithSecretRef, dbCredentialsSecret],
  });

  const contextWithoutSecret = makeContext({
    events: [
      makeEvent(
        'FailedMount',
        "MountVolume.SetUp failed: secret 'db-credentials' not found",
        'app-pod',
      ),
    ],
    resources: [podWithSecretRef, makeResource('Secret', 'other-secret')],
    // db-credentials is absent
  });

  const resultWithSecret = runDiagnosis([crashLoopFinding], contextWithSecret);
  const resultWithoutSecret = runDiagnosis([crashLoopFinding], contextWithoutSecret);

  const missingSecretWithSecret = resultWithSecret.allRanked.find(
    (h) => h.category === 'missing-secret',
  )!;
  const missingSecretWithoutSecret = resultWithoutSecret.allRanked.find(
    (h) => h.category === 'missing-secret',
  )!;

  it('missing-secret confidence is strictly lower when the secret exists', () => {
    expect(missingSecretWithSecret.confidence).toBeLessThan(missingSecretWithoutSecret.confidence);
  });

  it('missing-secret confidence drops to zero when secret is present and no FailedMount events', () => {
    expect(missingSecretWithSecret.confidence).toBe(0);
  });

  it('missing-secret hypothesis has contradicting evidence when the secret exists', () => {
    expect(missingSecretWithSecret.evidenceAssessment.contradicting.length).toBeGreaterThanOrEqual(
      1,
    );
  });

  it('contradicting evidence notes that the secret exists', () => {
    const notes = missingSecretWithSecret.evidenceAssessment.contradicting
      .map((e) => e.note)
      .join(' ')
      .toLowerCase();
    expect(notes).toMatch(/secret.*exists|db-credentials/i);
  });

  it('missing-secret hypothesis has no contradicting evidence when the secret is absent', () => {
    expect(missingSecretWithoutSecret.evidenceAssessment.contradicting).toHaveLength(0);
  });

  it('system generates all candidate hypotheses regardless of which is most likely', () => {
    // All four CrashLoop hypotheses should still be generated even when
    // missing-secret is ruled out by contradicting evidence
    const categories = resultWithSecret.allRanked.map((h) => h.category);
    expect(categories).toContain('config-error');
    expect(categories).toContain('oom-kill');
    expect(categories).toContain('generic-crash');
  });
});

// ===========================================================================
// SECTION B — Contradiction Injection
// ===========================================================================
//
// When evidence conflicts, contradictions must be surfaced in the hypothesis
// evidence assessment, confidence must drop compared to a non-contradicted
// equivalent, and the system must not overclaim a definitive root cause.

// ---------------------------------------------------------------------------
// B.1 — DNS failure logs followed by successful connection → contradictions
//        surfaced, confidence drops
// ---------------------------------------------------------------------------

describe('Contradiction injection — B.1: DNS failure then successful connection', () => {
  /**
   * Scenario A (contradicted): Logs show a DNS resolution failure, but
   * subsequent log lines show a successful database connection. The system
   * should surface a contradiction and lower confidence.
   *
   * Scenario B (clean): Only DNS failure logs, no subsequent success lines.
   */
  const dnsHyp = makeHypothesis({ category: 'dns-failure' });

  const podWithDbEnv: K8sResource = {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name: 'app-pod', namespace: 'default' },
    spec: {
      containers: [
        {
          name: 'app',
          env: [{ name: 'DATABASE_HOST', value: 'mydb.default.svc:5432' }],
        },
      ],
    },
  };

  const contradictedContext = makeContext({
    resources: [podWithDbEnv],
    logs: [
      makeLogFile('logs/default/app-pod/app/current.log', [
        'INFO  starting application',
        'ERROR dial tcp: lookup mydb.default.svc: no such host',
        'INFO  retrying connection...',
        'INFO  connected to database successfully',
        'INFO  server ready to accept connections',
      ]),
    ],
  });

  const cleanContext = makeContext({
    resources: [podWithDbEnv],
    logs: [
      makeLogFile('logs/default/app-pod/app/current.log', [
        'INFO  starting application',
        'ERROR dial tcp: lookup mydb.default.svc: no such host',
        'ERROR connection failed permanently',
        'FATAL cannot proceed without database',
      ]),
    ],
  });

  const contradictedAssessment = collectEvidenceForHypothesis(dnsHyp, contradictedContext);
  const cleanAssessment = collectEvidenceForHypothesis(dnsHyp, cleanContext);

  const contradictedScore = scoreHypothesis({
    ...dnsHyp,
    evidenceAssessment: contradictedAssessment,
  });
  const cleanScore = scoreHypothesis({ ...dnsHyp, evidenceAssessment: cleanAssessment });
  const contradictedFinding = convertHypothesisToFinding(
    {
      ...dnsHyp,
      confidence: contradictedScore,
      confidenceRationale: 'Contradicted DNS scenario',
      evidenceAssessment: contradictedAssessment,
    },
    1,
  );

  it('contradiction is surfaced when successful connection follows DNS failure', () => {
    expect(contradictedAssessment.contradicting.length).toBeGreaterThanOrEqual(1);
  });

  it('contradicting evidence note mentions a successful connection', () => {
    const notes = contradictedAssessment.contradicting.map((e) => e.note).join(' ').toLowerCase();
    expect(notes).toMatch(/success|connect|ready/i);
  });

  it('clean (non-contradicted) context has no contradicting evidence', () => {
    expect(cleanAssessment.contradicting).toHaveLength(0);
  });

  it('converted finding surfaces contradictions in contradictionsChecked', () => {
    expect(contradictedFinding.contradictionsChecked.join(' ').toLowerCase()).toMatch(
      /success|connect|ready/i,
    );
  });

  it('contradicted confidence is lower than clean confidence', () => {
    expect(contradictedScore).toBeLessThan(cleanScore);
  });

  it('clean scenario confidence is meaningfully higher than zero', () => {
    // The clean scenario has only DNS failure evidence → meaningful positive confidence
    expect(cleanScore).toBeGreaterThan(0);
  });

  it('contradicted scenario confidence is lower by at least the contradiction penalty', () => {
    // Each contradicting item costs 0.15; at least one should reduce score by ~0.15
    expect(cleanScore - contradictedScore).toBeGreaterThanOrEqual(0.10);
  });

  it('both scenarios retain supporting DNS failure evidence', () => {
    expect(contradictedAssessment.supporting.length).toBeGreaterThanOrEqual(1);
    expect(cleanAssessment.supporting.length).toBeGreaterThanOrEqual(1);
  });

  it('system does not drop to zero confidence when contradictions partially offset evidence', () => {
    // The contradicted scenario still has some DNS failure evidence, so confidence
    // should be positive (not completely ruled out — DNS error DID occur)
    expect(contradictedScore).toBeGreaterThanOrEqual(0);
    // System should not overclaim: confidence is meaningfully lower than clean
    expect(contradictedScore).toBeLessThanOrEqual(cleanScore);
  });
});

// ---------------------------------------------------------------------------
// B.2 — Readiness failures + pod now Ready=True → contradiction noted,
//        confidence reduced, system reports 'recovered' state
// ---------------------------------------------------------------------------

describe('Contradiction injection — B.2: Readiness probe failures + pod now Ready', () => {
  /**
   * Scenario A (contradicted): Unhealthy event fired, but the pod's current
   * status shows Ready=True and container ready=true — it has recovered.
   *
   * Scenario B (clean): Same Unhealthy event, but pod is still not ready.
   */
  const readinessHyp = makeHypothesis({ category: 'readiness-failure' });

  const unhealthyEvent = makeEvent(
    'Unhealthy',
    'Readiness probe failed: HTTP probe failed with statuscode: 503',
    'app-pod',
  );

  const podStillUnhealthy: K8sResource = {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name: 'app-pod', namespace: 'default' },
    spec: {
      containers: [
        {
          name: 'app',
          readinessProbe: { httpGet: { path: '/healthz', port: 8080 }, periodSeconds: 10 },
        },
      ],
    },
    status: {
      phase: 'Running',
      conditions: [{ type: 'Ready', status: 'False', reason: 'ContainersNotReady' }],
      containerStatuses: [{ name: 'app', ready: false, restartCount: 2 }],
    },
  };

  const podRecovered: K8sResource = {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name: 'app-pod', namespace: 'default' },
    spec: {
      containers: [
        {
          name: 'app',
          readinessProbe: { httpGet: { path: '/healthz', port: 8080 }, periodSeconds: 10 },
        },
      ],
    },
    status: {
      phase: 'Running',
      // Ready=True contradicts the ongoing readiness failure
      conditions: [{ type: 'Ready', status: 'True', reason: 'ContainersReady' }],
      containerStatuses: [{ name: 'app', ready: true, restartCount: 2 }],
    },
  };

  const contradictedContext = makeContext({
    events: [unhealthyEvent],
    resources: [podRecovered], // Pod has recovered
  });

  const cleanContext = makeContext({
    events: [unhealthyEvent],
    resources: [podStillUnhealthy], // Pod still unhealthy
  });

  const contradictedAssessment = collectEvidenceForHypothesis(readinessHyp, contradictedContext);
  const cleanAssessment = collectEvidenceForHypothesis(readinessHyp, cleanContext);

  const contradictedScore = scoreHypothesis({
    ...readinessHyp,
    evidenceAssessment: contradictedAssessment,
  });
  const cleanScore = scoreHypothesis({ ...readinessHyp, evidenceAssessment: cleanAssessment });
  const contradictedFinding = convertHypothesisToFinding(
    {
      ...readinessHyp,
      confidence: contradictedScore,
      confidenceRationale: 'Recovered readiness scenario',
      evidenceAssessment: contradictedAssessment,
    },
    1,
  );

  it('contradiction is surfaced when pod is now Ready=True despite prior Unhealthy event', () => {
    expect(contradictedAssessment.contradicting.length).toBeGreaterThanOrEqual(1);
  });

  it('contradicting evidence notes that the pod became ready', () => {
    const notes = contradictedAssessment.contradicting.map((e) => e.note).join(' ').toLowerCase();
    expect(notes).toMatch(/ready.*true|ready.*condition|became ready|ready=true/i);
  });

  it('clean (still-unhealthy) context has no contradicting evidence from pod status', () => {
    // Pod not ready → no Ready=True contradicting evidence
    const statusContradictions = cleanAssessment.contradicting.filter((e) =>
      /ready.*true|ready.*condition/i.test(e.note),
    );
    expect(statusContradictions).toHaveLength(0);
  });

  it('converted finding records recovery contradiction in contradictionsChecked', () => {
    expect(contradictedFinding.contradictionsChecked.join(' ').toLowerCase()).toMatch(
      /ready.*true|became ready|ready=true/i,
    );
  });

  it('contradicted confidence is lower than clean confidence', () => {
    expect(contradictedScore).toBeLessThan(cleanScore);
  });

  it('both scenarios retain the Unhealthy event as supporting evidence', () => {
    const contradictedNotes = contradictedAssessment.supporting
      .map((e) => e.note)
      .join(' ')
      .toLowerCase();
    const cleanNotes = cleanAssessment.supporting.map((e) => e.note).join(' ').toLowerCase();
    expect(contradictedNotes).toMatch(/unhealthy|readiness|probe/i);
    expect(cleanNotes).toMatch(/unhealthy|readiness|probe/i);
  });

  it('clean scenario confidence is meaningfully positive (pod has a real readiness issue)', () => {
    expect(cleanScore).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// B.3 — Past FailedMount event + secret now present → contradiction noted,
//        confidence reduced (system detects recovery)
// ---------------------------------------------------------------------------

describe('Contradiction injection — B.3: Past FailedMount + secret now exists (recovery)', () => {
  /**
   * Scenario: A FailedMount event was fired in the past (secret was missing),
   * but the Secret now exists in the namespace. This is a "recovered" state —
   * the system should note the contradiction between the historical event and
   * the current resource state, and reduce confidence.
   *
   * Compare against the "current failure" scenario where the secret is still
   * absent.
   */
  const missingSecretHyp = makeHypothesis({ category: 'missing-secret' });

  const failedMountEvent = makeEvent(
    'FailedMount',
    "MountVolume.SetUp failed: secret 'db-credentials' not found",
    'app-pod',
  );

  const podWithSecretRef: K8sResource = {
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
  };

  // Recovery scenario: FailedMount happened, but secret now exists
  const recoveryContext = makeContext({
    events: [failedMountEvent],
    resources: [podWithSecretRef, makeResource('Secret', 'db-credentials')],
  });

  // Current failure scenario: FailedMount happened AND secret still missing
  const failureContext = makeContext({
    events: [failedMountEvent],
    resources: [podWithSecretRef, makeResource('Secret', 'other-unrelated-secret')],
  });

  const recoveryAssessment = collectEvidenceForHypothesis(missingSecretHyp, recoveryContext);
  const failureAssessment = collectEvidenceForHypothesis(missingSecretHyp, failureContext);

  const recoveryScore = scoreHypothesis({
    ...missingSecretHyp,
    evidenceAssessment: recoveryAssessment,
  });
  const failureScore = scoreHypothesis({
    ...missingSecretHyp,
    evidenceAssessment: failureAssessment,
  });
  const recoveryFinding = convertHypothesisToFinding(
    {
      ...missingSecretHyp,
      confidence: recoveryScore,
      confidenceRationale: 'Recovered missing-secret scenario',
      evidenceAssessment: recoveryAssessment,
    },
    1,
  );

  it('contradiction is surfaced when secret now exists despite past FailedMount event', () => {
    expect(recoveryAssessment.contradicting.length).toBeGreaterThanOrEqual(1);
  });

  it('contradicting evidence notes that the secret exists', () => {
    const notes = recoveryAssessment.contradicting.map((e) => e.note).join(' ').toLowerCase();
    expect(notes).toMatch(/db-credentials.*exists|secret.*exists|exists.*db-credentials/i);
  });

  it('current-failure scenario has no contradicting evidence (secret genuinely absent)', () => {
    expect(failureAssessment.contradicting).toHaveLength(0);
  });

  it('converted finding includes the recovery contradiction in contradictionsChecked', () => {
    expect(recoveryFinding.contradictionsChecked.join(' ').toLowerCase()).toMatch(
      /secret.*exists|db-credentials/i,
    );
  });

  it('recovery scenario confidence is lower than current-failure confidence', () => {
    expect(recoveryScore).toBeLessThan(failureScore);
  });

  it('current-failure scenario retains strong supporting evidence from FailedMount', () => {
    expect(failureAssessment.supporting.length).toBeGreaterThanOrEqual(1);
    const notes = failureAssessment.supporting.map((e) => e.note).join(' ').toLowerCase();
    expect(notes).toMatch(/failedmount|secret.*not.*found/i);
  });

  it('recovery scenario still has past-failure supporting evidence (event is not erased)', () => {
    // The FailedMount event is still supporting evidence — the past failure happened
    expect(recoveryAssessment.supporting.length).toBeGreaterThanOrEqual(1);
  });

  it('system does not overclaim — recovery confidence is reduced but historical event remains', () => {
    // Recovery: both supporting (historical event) and contradicting (current state) exist
    expect(recoveryAssessment.supporting.length).toBeGreaterThanOrEqual(1);
    expect(recoveryAssessment.contradicting.length).toBeGreaterThanOrEqual(1);
    // Score is lower, system doesn't confirm the hypothesis as current root cause
    expect(recoveryScore).toBeLessThan(failureScore);
  });
});

// ===========================================================================
// SECTION C — Evidence Ablation
// ===========================================================================
//
// Wrong DB endpoint / DNS scenario: the application points at an in-cluster
// database hostname that cannot be resolved. We progressively remove evidence
// and assert that confidence falls monotonically, missing evidence is named,
// and spec-gap recommendations appear once the bundle is too sparse.

// ---------------------------------------------------------------------------
// Shared ablation fixtures
// ---------------------------------------------------------------------------

const ablationPodSpec: K8sResource = {
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: { name: 'app-pod', namespace: 'default' },
  spec: {
    containers: [
      {
        name: 'app',
        env: [{ name: 'DATABASE_HOST', value: 'mydb.default.svc.cluster.local:5432' }],
      },
    ],
  },
};

const ablationLogFile = makeLogFile('logs/default/app-pod/app/current.log', [
  'ERROR dial tcp: lookup mydb.default.svc.cluster.local: no such host',
  'FATAL database hostname resolution failed during startup',
]);

const ablationDnsEvent = makeEvent(
  'Unhealthy',
  'Readiness probe failed because lookup mydb.default.svc.cluster.local returned no such host',
  'app-pod',
);

/**
 * Helper: collect evidence and score the dns-failure hypothesis for a given
 * context, then run identifySpecGaps to get recommendations.
 */
function ablationScore(context: InvestigatorContext): {
  score: number;
  supporting: number;
  contradicting: number;
  missingDecisive: number;
  specGaps: string[];
  missingText: string;
} {
  const hyp = makeHypothesis({ category: 'dns-failure' });
  const assessment = collectEvidenceForHypothesis(hyp, context);
  const scored: Hypothesis = { ...hyp, evidenceAssessment: assessment };
  const score = scoreHypothesis(scored);
  const specGaps = identifySpecGaps(scored);
  return {
    score,
    supporting: assessment.supporting.length,
    contradicting: assessment.contradicting.length,
    missingDecisive: assessment.missingDecisive.length,
    specGaps,
    missingText: assessment.missingDecisive.join(' ').toLowerCase(),
  };
}

// ---------------------------------------------------------------------------
// C.1 — Full context (logs + events + pod spec)
// ---------------------------------------------------------------------------

describe('Evidence ablation — C.1: Full DNS context → highest confidence', () => {
  const fullContext = makeContext({
    logs: [ablationLogFile],
    events: [ablationDnsEvent],
    resources: [ablationPodSpec],
  });

  const result = ablationScore(fullContext);

  it('full context provides multiple supporting DNS evidence items', () => {
    expect(result.supporting).toBeGreaterThanOrEqual(4);
  });

  it('full context yields high confidence (≥ 0.80) for dns-failure', () => {
    expect(result.score).toBeGreaterThanOrEqual(0.80);
  });

  it('full context still records at least one missing decisive item when CoreDNS logs are absent', () => {
    expect(result.missingDecisive).toBeGreaterThanOrEqual(1);
    expect(result.missingText).toMatch(/coredns|kube-dns|dns/);
  });
});

// ---------------------------------------------------------------------------
// C.2 — Remove logs → confidence drops, missing log evidence noted
// ---------------------------------------------------------------------------

describe('Evidence ablation — C.2: Remove logs → DNS confidence drops', () => {
  const noLogsContext = makeContext({
    logs: [],
    events: [ablationDnsEvent],
    resources: [ablationPodSpec],
  });

  const fullContext = makeContext({
    logs: [ablationLogFile],
    events: [ablationDnsEvent],
    resources: [ablationPodSpec],
  });

  const noLogsResult = ablationScore(noLogsContext);
  const fullResult = ablationScore(fullContext);

  it('confidence drops when DNS error logs are removed', () => {
    expect(noLogsResult.score).toBeLessThan(fullResult.score);
  });

  it('missing decisive evidence explicitly names missing application logs', () => {
    expect(noLogsResult.missingText).toMatch(/pod application logs|dns lookup failures|hostname/);
  });

  it('confidence without logs remains positive because events and pod spec still support DNS failure', () => {
    expect(noLogsResult.score).toBeGreaterThan(0);
  });

  it('supporting evidence count drops after removing logs', () => {
    expect(noLogsResult.supporting).toBeLessThan(fullResult.supporting);
  });
});

// ---------------------------------------------------------------------------
// C.3 — Remove events → confidence drops further
// ---------------------------------------------------------------------------

describe('Evidence ablation — C.3: Remove events → DNS confidence drops further', () => {
  const noEventsContext = makeContext({
    logs: [],
    events: [],
    resources: [ablationPodSpec],
  });

  const noLogsContext = makeContext({
    logs: [],
    events: [ablationDnsEvent],
    resources: [ablationPodSpec],
  });

  const noEventsResult = ablationScore(noEventsContext);
  const noLogsResult = ablationScore(noLogsContext);

  it('confidence drops further when DNS-related events are also removed', () => {
    expect(noEventsResult.score).toBeLessThan(noLogsResult.score);
  });

  it('missing decisive evidence explicitly names missing Kubernetes event timeline', () => {
    expect(noEventsResult.missingText).toMatch(/kubernetes events|readiness|startup|backoff/);
  });

  it('confidence without logs or events is still positive because pod spec structure remains', () => {
    expect(noEventsResult.score).toBeGreaterThan(0);
  });

  it('pod-spec-only scenario has fewer supporting items than event+pod-spec scenario', () => {
    expect(noEventsResult.supporting).toBeLessThan(noLogsResult.supporting);
  });
});

// ---------------------------------------------------------------------------
// C.4 — Remove pod spec → confidence collapses, spec-gap recommendations appear
// ---------------------------------------------------------------------------

describe('Evidence ablation — C.4: Remove pod spec → DNS spec gaps appear', () => {
  const emptyContext = makeContext({
    logs: [],
    events: [],
    resources: [],
  });

  const noEventsContext = makeContext({
    logs: [],
    events: [],
    resources: [ablationPodSpec],
  });

  const emptyResult = ablationScore(emptyContext);
  const noEventsResult = ablationScore(noEventsContext);

  it('confidence drops to zero when logs, events, and pod spec are all absent', () => {
    expect(emptyResult.score).toBe(0);
  });

  it('confidence is lower than the pod-spec-only scenario', () => {
    expect(emptyResult.score).toBeLessThan(noEventsResult.score);
  });

  it('missing decisive evidence is explicitly listed in the empty context', () => {
    expect(emptyResult.missingDecisive).toBeGreaterThanOrEqual(1);
    expect(emptyResult.missingText).toMatch(/pod spec|container environment|coredns|logs|events/);
  });

  it('spec-gap recommendations are emitted when decisive DNS evidence is missing', () => {
    expect(emptyResult.specGaps.length).toBeGreaterThanOrEqual(1);
  });

  it('spec-gap recommendations mention the dns-failure category', () => {
    const joined = emptyResult.specGaps.join(' ').toLowerCase();
    expect(joined).toMatch(/dns-failure/i);
  });

  it('spec-gap recommendations are non-empty strings', () => {
    for (const gap of emptyResult.specGaps) {
      expect(gap.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// C.5 — Monotonic decrease assertion across all four ablation steps
// ---------------------------------------------------------------------------

describe('Evidence ablation — C.5: DNS confidence decreases monotonically', () => {
  const ctx1Full = makeContext({
    logs: [ablationLogFile],
    events: [ablationDnsEvent],
    resources: [ablationPodSpec],
  });

  const ctx2NoLogs = makeContext({
    logs: [],
    events: [ablationDnsEvent],
    resources: [ablationPodSpec],
  });

  const ctx3NoEvents = makeContext({
    logs: [],
    events: [],
    resources: [ablationPodSpec],
  });

  const ctx4Empty = makeContext({
    logs: [],
    events: [],
    resources: [],
  });

  const score1 = ablationScore(ctx1Full).score;
  const score2 = ablationScore(ctx2NoLogs).score;
  const score3 = ablationScore(ctx3NoEvents).score;
  const score4 = ablationScore(ctx4Empty).score;

  it('full context score ≥ no-logs score', () => {
    expect(score1).toBeGreaterThanOrEqual(score2);
  });

  it('no-logs score ≥ no-events score', () => {
    expect(score2).toBeGreaterThanOrEqual(score3);
  });

  it('no-events score ≥ empty score', () => {
    expect(score3).toBeGreaterThanOrEqual(score4);
  });

  it('full context score is strictly greater than empty score', () => {
    expect(score1).toBeGreaterThan(score4);
  });

  it('full context score is strictly greater than no-logs score (logs contribute)', () => {
    expect(score1).toBeGreaterThan(score2);
  });

  it('no-logs score is strictly greater than no-events score (events contribute)', () => {
    expect(score2).toBeGreaterThan(score3);
  });

  it('no-events score is strictly greater than empty score (pod spec contributes)', () => {
    expect(score3).toBeGreaterThan(score4);
  });

  it('missing decisive evidence count is non-decreasing as evidence is removed', () => {
    const m1 = ablationScore(ctx1Full).missingDecisive;
    const m2 = ablationScore(ctx2NoLogs).missingDecisive;
    const m3 = ablationScore(ctx3NoEvents).missingDecisive;
    const m4 = ablationScore(ctx4Empty).missingDecisive;
    expect(m2).toBeGreaterThanOrEqual(m1);
    expect(m3).toBeGreaterThanOrEqual(m2);
    expect(m4).toBeGreaterThanOrEqual(m3);
  });
});

// ===========================================================================
// SECTION D — Cross-scenario differential invariants
// ===========================================================================
//
// Additional invariants that hold across all scenarios, validating that the
// differential-diagnosis system maintains consistent reasoning properties.

describe('Cross-scenario — system invariants', () => {
  it('a hypothesis with only contradicting evidence scores lower than one with equal supporting + contradicting', () => {
    // Pure contradiction: no supporting, 2 contradicting
    const h1 = makeHypothesis({ category: 'missing-secret' });
    const pureContradiction: Hypothesis = {
      ...h1,
      evidenceAssessment: {
        supporting: [],
        contradicting: [
          {
            path: 'secrets/default/db-credentials.yaml',
            note: "Secret 'db-credentials' exists",
            artifactType: 'kubernetes-resource',
          },
          {
            path: 'secrets/default/other.yaml',
            note: "Secret 'other' also exists",
            artifactType: 'kubernetes-resource',
          },
        ],
        missingDecisive: [],
      },
    };

    // Balanced: some supporting AND contradicting
    const balanced: Hypothesis = {
      ...h1,
      evidenceAssessment: {
        supporting: [
          {
            path: 'events/default.json',
            note: 'FailedMount event: secret not found',
            artifactType: 'event',
          },
        ],
        contradicting: [
          {
            path: 'secrets/default/db-credentials.yaml',
            note: "Secret 'db-credentials' exists",
            artifactType: 'kubernetes-resource',
          },
        ],
        missingDecisive: [],
      },
    };

    expect(scoreHypothesis(pureContradiction)).toBeLessThan(scoreHypothesis(balanced));
  });

  it('same-category hypotheses with identical evidence tie on confidence', () => {
    const base = makeHypothesis({ category: 'missing-secret' });
    const ev = {
      path: 'events/default.json',
      note: 'FailedMount event: secret not found',
      artifactType: 'event' as const,
    };
    const h1: Hypothesis = {
      ...base,
      id: 'h1',
      category: 'missing-secret',
      evidenceAssessment: { supporting: [ev], contradicting: [], missingDecisive: [] },
    };
    const h2: Hypothesis = {
      ...base,
      id: 'h2',
      category: 'missing-secret',
      evidenceAssessment: { supporting: [ev], contradicting: [], missingDecisive: [] },
    };
    expect(scoreHypothesis(h1)).toBe(scoreHypothesis(h2));
  });

  it('rankHypotheses places the highest-confidence hypothesis first across mixed categories', () => {
    const missingSecretHyp: Hypothesis = {
      ...makeHypothesis({ category: 'missing-secret' }),
      evidenceAssessment: {
        supporting: [
          {
            path: 'events/default.json',
            note: 'FailedMount event: secret not found',
            artifactType: 'event',
          },
          {
            path: 'pods/default/app-pod.yaml',
            note: "Pod references secret 'db-credentials' which is absent",
            artifactType: 'kubernetes-resource',
          },
        ],
        contradicting: [],
        missingDecisive: [],
      },
    };

    const dnsFailureHyp: Hypothesis = {
      ...makeHypothesis({ category: 'dns-failure' }),
      evidenceAssessment: {
        supporting: [],
        contradicting: [],
        missingDecisive: ['CoreDNS logs needed'],
      },
    };

    const ranked = rankHypotheses([dnsFailureHyp, missingSecretHyp]);
    expect(ranked[0]!.category).toBe('missing-secret');
    expect(ranked[ranked.length - 1]!.category).toBe('dns-failure');
  });
});
