/**
 * Hypothesis Ranking Integration Test Suite
 *
 * This file validates advanced ranking scenarios for the hypothesis verification
 * layer:
 *
 *   D. Ranking tests — validates that specific root-cause evidence outranks
 *      generic symptom observations, that exact error-message signals produce
 *      higher confidence than pattern-only matches, and that fewer
 *      contradictions break ranking ties.
 *
 *   E. Noise / decoy tests — validates that irrelevant sidecar warnings, stale
 *      events from other namespaces, and healthy pods with similar names do not
 *      corrupt the diagnosis of the genuinely failing pod.
 *
 *   F. Counterfactual identifier tests — validates that the system diagnoses
 *      the same underlying failure correctly regardless of the specific name
 *      strings used for pods, secrets, namespaces, and hostnames.
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

// ---------------------------------------------------------------------------
// Shared fixture helpers (mirrors differential-diagnosis.test.ts style)
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

/** Minimal hypothesis for direct scoring tests in section D. */
function makeHypothesis(
  overrides: Partial<Hypothesis> & Pick<Hypothesis, 'category'>,
): Hypothesis {
  return {
    id: `pod-symptom:default/app-pod:${overrides.category}`,
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
 * Runs the full generator → collector → ranker pipeline for a list of
 * findings and returns ranked hypotheses for the first symptom set found.
 */
function runDiagnosis(
  findings: Finding[],
  context: InvestigatorContext,
): {
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
// SECTION D — Ranking Tests
// ===========================================================================
//
// Validates that specific root-cause evidence outranks generic symptom
// observations, that exact error-message signals produce higher confidence
// than pattern-only matches, and that fewer contradictions break ranking ties.

// ---------------------------------------------------------------------------
// D.1 — DNS error logs present → dns-failure outranks generic symptom hypotheses
// ---------------------------------------------------------------------------

describe('Ranking — D.1: DNS error logs present → dns-failure outranks generic symptom hypotheses', () => {
  /**
   * Scenario: A 'not-ready' pod symptom is accompanied by DNS error logs and
   * a pod spec that references an in-cluster database hostname.  The
   * dns-failure hypothesis should rank above the generic readiness-failure and
   * connectivity-failure alternatives.
   */
  const notReadyFinding = makeFinding({
    id: 'finding:k8s:not-ready:0',
    title: "Pod 'app-pod' is running but not ready in namespace 'default'",
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
    'INFO  starting application server',
    'ERROR dial tcp: lookup mydb.default.svc.cluster.local: no such host',
    'FATAL cannot start without database connection',
  ]);

  const context = makeContext({
    resources: [podWithDbEnv],
    logs: [dnsErrorLogs],
  });

  const { topCategory, topConfidence, allRanked } = runDiagnosis([notReadyFinding], context);

  it('top hypothesis is dns-failure when DNS error logs and pod spec hostname are present', () => {
    expect(topCategory).toBe('dns-failure');
  });

  it('dns-failure confidence is meaningfully positive (≥ 0.50) with specific DNS evidence', () => {
    expect(topConfidence).toBeGreaterThanOrEqual(0.50);
  });

  it('dns-failure outranks readiness-failure hypothesis', () => {
    const dnsHyp = allRanked.find((h) => h.category === 'dns-failure')!;
    const readinessHyp = allRanked.find((h) => h.category === 'readiness-failure');
    expect(dnsHyp).toBeDefined();
    if (readinessHyp) {
      expect(dnsHyp.confidence).toBeGreaterThan(readinessHyp.confidence);
    }
  });

  it('dns-failure outranks connectivity-failure hypothesis', () => {
    const dnsHyp = allRanked.find((h) => h.category === 'dns-failure')!;
    const connHyp = allRanked.find((h) => h.category === 'connectivity-failure');
    expect(dnsHyp).toBeDefined();
    if (connHyp) {
      expect(dnsHyp.confidence).toBeGreaterThan(connHyp.confidence);
    }
  });

  it('all not-ready candidate hypotheses are generated (3 minimum)', () => {
    expect(allRanked.length).toBeGreaterThanOrEqual(3);
  });
});

describe('Ranking — D.1b: mixed timeout + DNS logs still prefer dns-failure when exact lookup failures exist', () => {
  const notReadyFinding = makeFinding({
    id: 'finding:k8s:not-ready:mixed',
    title: "Pod 'app-pod' is running but not ready in namespace 'default'",
    affectedComponents: ['Pod/default/app-pod'],
  });

  const podWithHostAndPort: K8sResource = {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name: 'app-pod', namespace: 'default' },
    spec: {
      containers: [
        {
          name: 'app',
          env: [
            { name: 'DB_HOST', value: 'db.internal' },
            { name: 'DB_PORT', value: '5432' },
          ],
        },
      ],
    },
  };

  const mixedNetworkLogs = makeLogFile('logs/default/app-pod/app/current.log', [
    'ERROR dial tcp: lookup db.internal: no such host',
    'ERROR context deadline exceeded while connecting to db.internal:5432',
    'ERROR Failed to connect to database after 5 attempts: dial tcp: lookup db.internal: no such host',
  ]);

  const context = makeContext({
    resources: [podWithHostAndPort],
    logs: [mixedNetworkLogs],
  });

  const { topCategory, allRanked } = runDiagnosis([notReadyFinding], context);
  const dnsHyp = allRanked.find((h) => h.category === 'dns-failure');
  const connectivityHyp = allRanked.find((h) => h.category === 'connectivity-failure');

  it('top hypothesis is dns-failure', () => {
    expect(topCategory).toBe('dns-failure');
  });

  it('dns-failure outranks connectivity-failure when exact lookup failures are present', () => {
    expect(dnsHyp).toBeDefined();
    expect(connectivityHyp).toBeDefined();
    expect(dnsHyp!.confidence).toBeGreaterThan(connectivityHyp!.confidence);
  });

  it('dns-failure supporting evidence does not invent numeric service names from DB_PORT', () => {
    const evidenceText = dnsHyp!.evidenceAssessment.supporting
      .map((e) => `${e.path} ${e.note}`)
      .join(' ');

    expect(evidenceText).not.toContain('cluster-resources/services/default/5432.yaml');
    expect(evidenceText).not.toMatch(/hostname '\s*5432\s*'/i);
    expect(evidenceText).not.toMatch(/service '\s*5432\s*'/i);
  });
});

// ---------------------------------------------------------------------------
// D.2 — DNS error logs absent → generic symptom hypothesis may outrank dns-failure
// ---------------------------------------------------------------------------

describe('Ranking — D.2: DNS logs absent → generic symptom hypothesis may outrank dns-failure claim', () => {
  /**
   * Scenario A (with DNS logs): same 'not-ready' pod with DNS error logs →
   * dns-failure ranks high.
   *
   * Scenario B (without DNS logs): Unhealthy event is present but no DNS-
   * specific log evidence.  Without specific DNS signals, dns-failure has no
   * supporting evidence and is outranked by readiness-failure which has the
   * Unhealthy event.
   */
  const notReadyFinding = makeFinding({
    id: 'finding:k8s:not-ready:1',
    title: "Pod 'app-pod' is running but not ready in namespace 'default'",
    affectedComponents: ['Pod/default/app-pod'],
  });

  const unhealthyEvent = makeEvent(
    'Unhealthy',
    'Readiness probe failed: HTTP probe failed with statuscode: 503',
    'app-pod',
  );

  const podWithReadinessProbe: K8sResource = {
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
  };

  const contextWithDnsLogs = makeContext({
    resources: [podWithReadinessProbe],
    events: [unhealthyEvent],
    logs: [
      makeLogFile('logs/default/app-pod/app/current.log', [
        'ERROR dial tcp: lookup mydb.default.svc: no such host',
      ]),
    ],
  });

  const contextWithoutDnsLogs = makeContext({
    resources: [podWithReadinessProbe],
    events: [unhealthyEvent],
    logs: [], // No DNS-specific logs
  });

  const resultWithDns = runDiagnosis([notReadyFinding], contextWithDnsLogs);
  const resultWithoutDns = runDiagnosis([notReadyFinding], contextWithoutDnsLogs);

  it('with DNS logs, dns-failure has higher confidence than without', () => {
    const dnsWithLogs = resultWithDns.allRanked.find((h) => h.category === 'dns-failure')!;
    const dnsWithoutLogs = resultWithoutDns.allRanked.find((h) => h.category === 'dns-failure')!;
    expect(dnsWithLogs.confidence).toBeGreaterThan(dnsWithoutLogs.confidence);
  });

  it('without DNS logs, dns-failure confidence is very low (≤ 0.15)', () => {
    const dnsHyp = resultWithoutDns.allRanked.find((h) => h.category === 'dns-failure')!;
    expect(dnsHyp.confidence).toBeLessThanOrEqual(0.15);
  });

  it('without DNS logs, readiness-failure (generic symptom) ranks at or above dns-failure', () => {
    const dnsHyp = resultWithoutDns.allRanked.find((h) => h.category === 'dns-failure')!;
    const readinessHyp = resultWithoutDns.allRanked.find((h) => h.category === 'readiness-failure')!;
    expect(readinessHyp.confidence).toBeGreaterThanOrEqual(dnsHyp.confidence);
  });

  it('without DNS logs, readiness-failure is positioned before dns-failure in ranked list', () => {
    const dnsIdx = resultWithoutDns.allRanked.findIndex((h) => h.category === 'dns-failure');
    const readinessIdx = resultWithoutDns.allRanked.findIndex(
      (h) => h.category === 'readiness-failure',
    );
    expect(readinessIdx).toBeLessThan(dnsIdx);
  });

  it('readiness-failure confidence is positive when Unhealthy event and readiness probe exist', () => {
    const readinessHyp = resultWithoutDns.allRanked.find((h) => h.category === 'readiness-failure')!;
    expect(readinessHyp.confidence).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// D.3 — Specific evidence (exact error match) produces higher confidence than
//        generic pattern-only match
// ---------------------------------------------------------------------------

describe('Ranking — D.3: Specific evidence produces higher confidence than generic pattern-only match', () => {
  /**
   * A hypothesis with exact diagnostic signals (e.g., "no such host" in logs)
   * should score strictly higher than one with only generic status observations
   * (e.g., "pod is not ready") that are capped by the generic-only cap.
   */

  const specificEvidence: Hypothesis['evidenceAssessment'] = {
    supporting: [
      {
        path: 'logs/default/app-pod/app/current.log',
        note: 'Log line shows DNS resolution failure: "ERROR dial tcp: lookup mydb.default.svc: no such host"',
        artifactType: 'log',
      },
      {
        path: 'cluster-resources/pods/default/app-pod.yaml',
        note: "Pod 'app-pod' references in-cluster hostname 'mydb.default.svc:5432' via container 'app' env 'DATABASE_HOST'",
        artifactType: 'kubernetes-resource',
      },
    ],
    contradicting: [],
    missingDecisive: [],
  };

  const genericEvidence: Hypothesis['evidenceAssessment'] = {
    supporting: [
      {
        path: 'cluster-resources/pods/default/app-pod.yaml',
        note: 'Pod is not ready',
        artifactType: 'kubernetes-resource',
      },
      {
        path: 'cluster-resources/pods/default/app-pod.yaml',
        note: 'Running but not ready — pod status shows unhealthy',
        artifactType: 'kubernetes-resource',
      },
    ],
    contradicting: [],
    missingDecisive: [],
  };

  const specificHyp = makeHypothesis({
    category: 'dns-failure',
    evidenceAssessment: specificEvidence,
  });
  const genericHyp = makeHypothesis({
    category: 'readiness-failure',
    evidenceAssessment: genericEvidence,
  });

  const specificScore = scoreHypothesis(specificHyp);
  const genericScore = scoreHypothesis(genericHyp);

  it('specific evidence hypothesis scores strictly higher than generic-only hypothesis', () => {
    expect(specificScore).toBeGreaterThan(genericScore);
  });

  it('specific evidence hypothesis has a meaningful confidence (≥ 0.50)', () => {
    expect(specificScore).toBeGreaterThanOrEqual(0.50);
  });

  it('generic-only hypothesis is capped at or below 0.50', () => {
    expect(genericScore).toBeLessThanOrEqual(0.50);
  });

  it('rankHypotheses places the specific hypothesis above the generic one', () => {
    const ranked = rankHypotheses([genericHyp, specificHyp]);
    expect(ranked[0]!.category).toBe('dns-failure');
  });

  it('both hypotheses have valid confidence values in [0, 1]', () => {
    expect(specificScore).toBeGreaterThanOrEqual(0);
    expect(specificScore).toBeLessThanOrEqual(1);
    expect(genericScore).toBeGreaterThanOrEqual(0);
    expect(genericScore).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// D.4 — Equal supporting evidence: the hypothesis with fewer contradictions
//        ranks higher
// ---------------------------------------------------------------------------

describe('Ranking — D.4: Equal supporting evidence, fewer contradictions → higher rank', () => {
  /**
   * Two hypotheses with identical supporting evidence profiles:
   * - hypA: 2 specific supporting items, 0 contradictions
   * - hypB: 2 specific supporting items, 1 contradiction
   *
   * hypA should rank above hypB and their score delta should equal the single
   * contradiction penalty (0.15).
   */

  const sharedSupporting = [
    {
      path: 'logs/default/app-pod/app/current.log',
      note: 'Log line shows DNS resolution failure: "ERROR dial tcp: lookup mydb.svc: no such host"',
      artifactType: 'log' as const,
    },
    {
      path: 'cluster-resources/events/default.json',
      note: "Event indicates DNS-related failure for 'app-pod': lookup mydb failed: no such host",
      artifactType: 'event' as const,
    },
  ];

  const contradiction = {
    path: 'cluster-resources/services/default/mydb.yaml',
    note: "Referenced Service 'mydb' exists in namespace 'default' — pure DNS absence is less likely",
    artifactType: 'kubernetes-resource' as const,
  };

  const hypA = makeHypothesis({
    id: 'hyp:dns:no-contradiction',
    category: 'dns-failure',
    evidenceAssessment: {
      supporting: sharedSupporting,
      contradicting: [],
      missingDecisive: [],
    },
  });

  const hypB = makeHypothesis({
    id: 'hyp:dns:one-contradiction',
    category: 'dns-failure',
    evidenceAssessment: {
      supporting: sharedSupporting,
      contradicting: [contradiction],
      missingDecisive: [],
    },
  });

  const scoreA = scoreHypothesis(hypA);
  const scoreB = scoreHypothesis(hypB);
  // Deliberately pass B first to verify rankHypotheses reorders correctly
  const ranked = rankHypotheses([hypB, hypA]);

  it('hypothesis with no contradictions scores strictly higher than one with a contradiction', () => {
    expect(scoreA).toBeGreaterThan(scoreB);
  });

  it('hypothesis with no contradictions ranks first when supporting evidence is equal', () => {
    expect(ranked[0]!.id).toBe('hyp:dns:no-contradiction');
  });

  it('confidence difference equals exactly the per-contradiction penalty (0.15)', () => {
    expect(scoreA - scoreB).toBeCloseTo(0.15, 5);
  });

  it('the contradicted hypothesis still has a positive confidence', () => {
    expect(scoreB).toBeGreaterThan(0.0);
  });

  it('both hypotheses have matching supporting evidence counts', () => {
    expect(hypA.evidenceAssessment.supporting.length).toBe(
      hypB.evidenceAssessment.supporting.length,
    );
  });
});

// ===========================================================================
// SECTION E — Noise / Decoy Tests
// ===========================================================================
//
// Validates that irrelevant sidecar warnings, stale historical events from
// another namespace, and healthy pods with similar names do not corrupt the
// hypothesis diagnosis for the genuinely failing pod.

// ---------------------------------------------------------------------------
// E.1 — Sidecar container warnings unrelated to the failing pod
// ---------------------------------------------------------------------------

describe('Noise/decoy — E.1: Sidecar container warnings do not corrupt the diagnosis', () => {
  /**
   * Scenario: Pod 'app-pod' has a main container with DNS failure logs and a
   * monitoring sidecar with unrelated memory/disk pressure warnings.  The
   * sidecar warnings should not match any hypothesis evidence pattern, and the
   * dns-failure diagnosis for the main container should be identical with and
   * without the sidecar log file in the context.
   */
  const crashLoopFinding = makeFinding({
    id: 'finding:k8s:crashloop:sidecar:0',
    title: "CrashLoopBackOff: Pod 'app-pod' in namespace 'default'",
    affectedComponents: ['Pod/default/app-pod'],
  });

  const podWithSidecar: K8sResource = {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name: 'app-pod', namespace: 'default' },
    spec: {
      containers: [
        {
          name: 'app',
          env: [{ name: 'DATABASE_HOST', value: 'mydb.default.svc.cluster.local:5432' }],
        },
        {
          name: 'monitoring-sidecar',
          // No env vars referencing services or secrets
        },
      ],
    },
  };

  // Main container: DNS failure logs
  const mainContainerLogs = makeLogFile('logs/default/app-pod/app/current.log', [
    'INFO  starting application',
    'ERROR dial tcp: lookup mydb.default.svc.cluster.local: no such host',
    'FATAL cannot start without database connection',
  ]);

  // Sidecar: unrelated memory and disk warnings — do not match any hypothesis pattern
  const sidecarLogs = makeLogFile('logs/default/app-pod/monitoring-sidecar/current.log', [
    'WARNING memory usage at 78% — consider increasing limits',
    'WARNING disk usage on /tmp at 82%',
    'INFO  metrics scraped successfully',
  ]);

  const contextWithSidecar = makeContext({
    resources: [podWithSidecar],
    logs: [mainContainerLogs, sidecarLogs],
  });

  const contextWithoutSidecar = makeContext({
    resources: [podWithSidecar],
    logs: [mainContainerLogs],
  });

  const resultWithSidecar = runDiagnosis([crashLoopFinding], contextWithSidecar);
  const resultWithoutSidecar = runDiagnosis([crashLoopFinding], contextWithoutSidecar);

  it('top hypothesis is dns-failure even when sidecar logs are present', () => {
    expect(resultWithSidecar.topCategory).toBe('dns-failure');
  });

  it('sidecar logs do not inflate dns-failure confidence (confidence is identical with/without sidecar)', () => {
    const dnsWithSidecar = resultWithSidecar.allRanked.find((h) => h.category === 'dns-failure')!;
    const dnsWithout = resultWithoutSidecar.allRanked.find((h) => h.category === 'dns-failure')!;
    expect(dnsWithSidecar.confidence).toBe(dnsWithout.confidence);
  });

  it('sidecar warnings do not appear as supporting evidence in the dns-failure hypothesis', () => {
    const dnsHyp = resultWithSidecar.allRanked.find((h) => h.category === 'dns-failure')!;
    const sidecarNotes = dnsHyp.evidenceAssessment.supporting
      .map((e) => e.note)
      .join(' ')
      .toLowerCase();
    expect(sidecarNotes).not.toMatch(/memory|disk|metric/i);
  });

  it('dns-failure hypothesis still has specific DNS evidence from the main container logs', () => {
    const dnsHyp = resultWithSidecar.allRanked.find((h) => h.category === 'dns-failure')!;
    const notes = dnsHyp.evidenceAssessment.supporting.map((e) => e.note).join(' ').toLowerCase();
    expect(notes).toMatch(/no such host|lookup|dns/i);
  });

  it('sidecar logs do not inadvertently boost any other hypothesis above dns-failure', () => {
    const dnsConf = resultWithSidecar.allRanked.find((h) => h.category === 'dns-failure')!.confidence;
    const others = resultWithSidecar.allRanked.filter((h) => h.category !== 'dns-failure');
    for (const other of others) {
      expect(dnsConf).toBeGreaterThanOrEqual(other.confidence);
    }
  });
});

// ---------------------------------------------------------------------------
// E.2 — Stale historical events from a different namespace
// ---------------------------------------------------------------------------

describe('Noise/decoy — E.2: Stale historical events from different namespace do not corrupt diagnosis', () => {
  /**
   * Scenario: Pod 'app-pod' in 'default' is failing due to a missing secret.
   * A stale FailedMount event from namespace 'legacy' (for a different pod
   * entirely) exists in the context as historical noise.
   *
   * The missing-secret diagnosis for 'default/app-pod' should remain the top
   * hypothesis, and the stale event should not cause an incorrect hypothesis
   * to dominate.
   */
  const crashLoopFinding = makeFinding({
    id: 'finding:k8s:crashloop:stale:0',
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

  // Relevant event for default/app-pod — the current failure
  const currentFailedMountEvent = makeEvent(
    'FailedMount',
    "MountVolume.SetUp failed: secret 'db-credentials' not found",
    'app-pod',
    'Pod',
    'default',
  );

  // Stale event from namespace 'legacy' — historical noise from a different pod
  const staleEvent = makeEvent(
    'FailedMount',
    "MountVolume.SetUp failed: secret 'old-api-key' not found",
    'legacy-service-pod',
    'Pod',
    'legacy',
  );

  const contextWithNoise = makeContext({
    resources: [podWithSecretRef, makeResource('Secret', 'other-secret', 'default')],
    events: [currentFailedMountEvent, staleEvent],
  });

  const contextWithoutNoise = makeContext({
    resources: [podWithSecretRef, makeResource('Secret', 'other-secret', 'default')],
    events: [currentFailedMountEvent],
  });

  const resultWithNoise = runDiagnosis([crashLoopFinding], contextWithNoise);
  const resultWithoutNoise = runDiagnosis([crashLoopFinding], contextWithoutNoise);

  it('top hypothesis is still missing-secret despite stale events from another namespace', () => {
    expect(resultWithNoise.topCategory).toBe('missing-secret');
  });

  it('missing-secret is also the top hypothesis in the clean context (no stale events)', () => {
    expect(resultWithoutNoise.topCategory).toBe('missing-secret');
  });

  it('missing-secret confidence is positive in both noisy and clean contexts', () => {
    const missingWithNoise = resultWithNoise.allRanked.find((h) => h.category === 'missing-secret')!;
    const missingWithout = resultWithoutNoise.allRanked.find(
      (h) => h.category === 'missing-secret',
    )!;
    expect(missingWithNoise.confidence).toBeGreaterThan(0);
    expect(missingWithout.confidence).toBeGreaterThan(0);
  });

  it('the stale event does not cause dns-failure to dominate over missing-secret', () => {
    const missingHyp = resultWithNoise.allRanked.find((h) => h.category === 'missing-secret')!;
    const dnsHyp = resultWithNoise.allRanked.find((h) => h.category === 'dns-failure');
    if (dnsHyp) {
      expect(missingHyp.confidence).toBeGreaterThan(dnsHyp.confidence);
    }
  });

  it('the stale event does not cause config-error to dominate over missing-secret', () => {
    const missingHyp = resultWithNoise.allRanked.find((h) => h.category === 'missing-secret')!;
    const configHyp = resultWithNoise.allRanked.find((h) => h.category === 'config-error');
    if (configHyp) {
      expect(missingHyp.confidence).toBeGreaterThan(configHyp.confidence);
    }
  });
});

// ---------------------------------------------------------------------------
// E.3 — Second healthy pod with a similar name
// ---------------------------------------------------------------------------

describe('Noise/decoy — E.3: Healthy pod with similar name does not corrupt failing pod diagnosis', () => {
  /**
   * Scenario: Pod 'app-pod' in 'default' has a DNS failure.
   * Pod 'app-pod-v2' in 'default' is healthy (Ready=True, no database env var)
   * and serves as a decoy with a similar name.
   *
   * The healthy pod does not share the same configuration issue, so it should
   * contribute no evidence to any hypothesis.  The dns-failure diagnosis and
   * confidence for 'app-pod' must be identical with and without 'app-pod-v2'.
   */
  const crashLoopFinding = makeFinding({
    id: 'finding:k8s:crashloop:healthy-sibling:0',
    title: "CrashLoopBackOff: Pod 'app-pod' in namespace 'default'",
    affectedComponents: ['Pod/default/app-pod'],
  });

  // The failing pod with a DB hostname reference
  const failingPod: K8sResource = {
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
    status: {
      phase: 'Running',
      conditions: [{ type: 'Ready', status: 'False' }],
      containerStatuses: [{ name: 'app', ready: false, restartCount: 5 }],
    },
  };

  // The healthy decoy pod — similar name, but no DATABASE_HOST and no issues
  const healthyDecoyPod: K8sResource = {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name: 'app-pod-v2', namespace: 'default' },
    spec: {
      containers: [
        {
          name: 'app',
          // No DATABASE_HOST — does not share the failing pod's configuration
        },
      ],
    },
    status: {
      phase: 'Running',
      conditions: [{ type: 'Ready', status: 'True' }],
      containerStatuses: [{ name: 'app', ready: true, restartCount: 0 }],
    },
  };

  // DNS failure logs only for the failing pod
  const failingPodLogs = makeLogFile('logs/default/app-pod/app/current.log', [
    'ERROR dial tcp: lookup mydb.default.svc.cluster.local: no such host',
    'FATAL cannot connect to database',
  ]);

  const contextWithDecoy = makeContext({
    resources: [failingPod, healthyDecoyPod],
    logs: [failingPodLogs],
  });

  const contextWithoutDecoy = makeContext({
    resources: [failingPod],
    logs: [failingPodLogs],
  });

  const resultWithDecoy = runDiagnosis([crashLoopFinding], contextWithDecoy);
  const resultWithoutDecoy = runDiagnosis([crashLoopFinding], contextWithoutDecoy);

  it('top hypothesis is dns-failure even when a healthy sibling pod is present', () => {
    expect(resultWithDecoy.topCategory).toBe('dns-failure');
  });

  it('dns-failure is also the top hypothesis without the healthy decoy pod', () => {
    expect(resultWithoutDecoy.topCategory).toBe('dns-failure');
  });

  it('dns-failure confidence is identical with and without the healthy decoy (decoy shares no config issue)', () => {
    const dnsWithDecoy = resultWithDecoy.allRanked.find((h) => h.category === 'dns-failure')!;
    const dnsWithout = resultWithoutDecoy.allRanked.find((h) => h.category === 'dns-failure')!;
    expect(dnsWithDecoy.confidence).toBe(dnsWithout.confidence);
  });

  it('healthy decoy pod does not cause any incorrect hypothesis to outrank dns-failure', () => {
    const dnsConf = resultWithDecoy.allRanked.find((h) => h.category === 'dns-failure')!.confidence;
    const others = resultWithDecoy.allRanked.filter((h) => h.category !== 'dns-failure');
    for (const other of others) {
      expect(dnsConf).toBeGreaterThanOrEqual(other.confidence);
    }
  });

  it('dns-failure confidence is a positive value in both contexts', () => {
    const dnsWithDecoy = resultWithDecoy.allRanked.find((h) => h.category === 'dns-failure')!;
    const dnsWithout = resultWithoutDecoy.allRanked.find((h) => h.category === 'dns-failure')!;
    expect(dnsWithDecoy.confidence).toBeGreaterThan(0);
    expect(dnsWithout.confidence).toBeGreaterThan(0);
  });
});

// ===========================================================================
// SECTION F — Counterfactual Identifier Tests
// ===========================================================================
//
// Validates that the system diagnoses the same underlying failure correctly
// regardless of the specific name strings used for pods, secrets, namespaces,
// and hostnames.  The hypothesis category and evidence artifact types must be
// consistent regardless of identifier names.

// ---------------------------------------------------------------------------
// F.1 — Wrong DB endpoint scenario with renamed pod, host, and namespace
// ---------------------------------------------------------------------------

describe('Counterfactual — F.1: DNS failure diagnosed correctly with renamed pod, host, and namespace', () => {
  /**
   * Original scenario:
   *   pod='app-pod', namespace='default',
   *   dbHost='mydb.default.svc.cluster.local:5432'
   *
   * Counterfactual scenario (renamed identifiers):
   *   pod='backend-server', namespace='production',
   *   dbHost='postgres.services.svc.cluster.local:5432'
   *
   * Both should be diagnosed as dns-failure with consistent evidence artifact
   * types and similar confidence values.
   */

  function makeDnsScenario(
    podName: string,
    namespace: string,
    dbHost: string,
    logPath: string,
  ): { finding: Finding; context: InvestigatorContext } {
    const finding = makeFinding({
      id: `finding:k8s:crashloop:${podName}:0`,
      title: `CrashLoopBackOff: Pod '${podName}' in namespace '${namespace}'`,
      affectedComponents: [`Pod/${namespace}/${podName}`],
    });

    const pod: K8sResource = {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: podName, namespace },
      spec: {
        containers: [
          {
            name: 'app',
            env: [{ name: 'DATABASE_HOST', value: dbHost }],
          },
        ],
      },
    };

    // Remove the port suffix from the host for use in the DNS lookup log line
    const hostOnly = dbHost.replace(/:\d+$/, '');
    const logs = makeLogFile(logPath, [
      'INFO  starting application',
      `ERROR dial tcp: lookup ${hostOnly}: no such host`,
      'FATAL cannot connect to database, shutting down',
    ]);

    return { finding, context: makeContext({ resources: [pod], logs: [logs] }) };
  }

  const original = makeDnsScenario(
    'app-pod',
    'default',
    'mydb.default.svc.cluster.local:5432',
    'logs/default/app-pod/app/current.log',
  );

  const counterfactual = makeDnsScenario(
    'backend-server',
    'production',
    'postgres.services.svc.cluster.local:5432',
    'logs/production/backend-server/app/current.log',
  );

  const originalResult = runDiagnosis([original.finding], original.context);
  const counterfactualResult = runDiagnosis([counterfactual.finding], counterfactual.context);

  it('original scenario (app-pod/default/mydb) is diagnosed as dns-failure', () => {
    expect(originalResult.topCategory).toBe('dns-failure');
  });

  it('counterfactual scenario (backend-server/production/postgres.services) is also diagnosed as dns-failure', () => {
    expect(counterfactualResult.topCategory).toBe('dns-failure');
  });

  it('both scenarios produce the same top hypothesis category regardless of identifier names', () => {
    expect(originalResult.topCategory).toBe(counterfactualResult.topCategory);
  });

  it('counterfactual confidence is within 0.15 of the original confidence', () => {
    expect(
      Math.abs(originalResult.topConfidence - counterfactualResult.topConfidence),
    ).toBeLessThanOrEqual(0.15);
  });

  it('original dns-failure hypothesis contains DNS-specific evidence (exact error signal)', () => {
    const dnsHyp = originalResult.allRanked.find((h) => h.category === 'dns-failure')!;
    const notes = dnsHyp.evidenceAssessment.supporting.map((e) => e.note).join(' ').toLowerCase();
    expect(notes).toMatch(/no such host|lookup|dns/i);
  });

  it('counterfactual dns-failure hypothesis also contains DNS-specific evidence', () => {
    const dnsHyp = counterfactualResult.allRanked.find((h) => h.category === 'dns-failure')!;
    const notes = dnsHyp.evidenceAssessment.supporting.map((e) => e.note).join(' ').toLowerCase();
    expect(notes).toMatch(/no such host|lookup|dns/i);
  });

  it('original and counterfactual produce the same supporting artifact type set for dns-failure', () => {
    const originalTypes = new Set(
      originalResult.allRanked
        .find((h) => h.category === 'dns-failure')!
        .evidenceAssessment.supporting.map((e) => e.artifactType),
    );
    const cfTypes = new Set(
      counterfactualResult.allRanked
        .find((h) => h.category === 'dns-failure')!
        .evidenceAssessment.supporting.map((e) => e.artifactType),
    );
    expect([...originalTypes].sort()).toEqual([...cfTypes].sort());
  });

  it('original and counterfactual both have log evidence for the dns-failure hypothesis', () => {
    const originalTypes = new Set(
      originalResult.allRanked
        .find((h) => h.category === 'dns-failure')!
        .evidenceAssessment.supporting.map((e) => e.artifactType),
    );
    const cfTypes = new Set(
      counterfactualResult.allRanked
        .find((h) => h.category === 'dns-failure')!
        .evidenceAssessment.supporting.map((e) => e.artifactType),
    );
    expect(originalTypes.has('log')).toBe(true);
    expect(cfTypes.has('log')).toBe(true);
  });

  it('original and counterfactual both have kubernetes-resource evidence for the dns-failure hypothesis', () => {
    const originalTypes = new Set(
      originalResult.allRanked
        .find((h) => h.category === 'dns-failure')!
        .evidenceAssessment.supporting.map((e) => e.artifactType),
    );
    const cfTypes = new Set(
      counterfactualResult.allRanked
        .find((h) => h.category === 'dns-failure')!
        .evidenceAssessment.supporting.map((e) => e.artifactType),
    );
    expect(originalTypes.has('kubernetes-resource')).toBe(true);
    expect(cfTypes.has('kubernetes-resource')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// F.2 — Missing secret scenario with renamed secret, pod, and namespace
// ---------------------------------------------------------------------------

describe('Counterfactual — F.2: Missing secret diagnosed correctly with renamed secret, pod, and namespace', () => {
  /**
   * Original scenario:
   *   pod='app-pod', namespace='default', secret='db-credentials'
   *
   * Counterfactual scenario (renamed identifiers):
   *   pod='api-server', namespace='production', secret='database-auth'
   *
   * Both should be diagnosed as missing-secret with consistent evidence
   * artifact types and the correct secret name appearing in supporting notes.
   */

  function makeMissingSecretScenario(
    podName: string,
    namespace: string,
    secretName: string,
  ): { finding: Finding; context: InvestigatorContext } {
    const finding = makeFinding({
      id: `finding:k8s:crashloop:${podName}:secret:0`,
      title: `CrashLoopBackOff: Pod '${podName}' in namespace '${namespace}'`,
      affectedComponents: [`Pod/${namespace}/${podName}`],
    });

    const pod: K8sResource = {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: podName, namespace },
      spec: {
        containers: [
          {
            name: 'app',
            envFrom: [{ secretRef: { name: secretName } }],
          },
        ],
      },
    };

    const failedMountEvent = makeEvent(
      'FailedMount',
      `MountVolume.SetUp failed: secret '${secretName}' not found`,
      podName,
      'Pod',
      namespace,
    );

    // A different secret exists in the namespace (so the Secret inventory is non-empty)
    // but the referenced secret is intentionally absent.
    const otherSecret = makeResource('Secret', `${secretName}-backup`, namespace);

    return {
      finding,
      context: makeContext({
        resources: [pod, otherSecret],
        events: [failedMountEvent],
      }),
    };
  }

  const original = makeMissingSecretScenario('app-pod', 'default', 'db-credentials');
  const counterfactual = makeMissingSecretScenario('api-server', 'production', 'database-auth');

  const originalResult = runDiagnosis([original.finding], original.context);
  const counterfactualResult = runDiagnosis([counterfactual.finding], counterfactual.context);

  it('original scenario (app-pod/default/db-credentials) is diagnosed as missing-secret', () => {
    expect(originalResult.topCategory).toBe('missing-secret');
  });

  it('counterfactual scenario (api-server/production/database-auth) is also diagnosed as missing-secret', () => {
    expect(counterfactualResult.topCategory).toBe('missing-secret');
  });

  it('both scenarios produce the same top hypothesis category regardless of identifier names', () => {
    expect(originalResult.topCategory).toBe(counterfactualResult.topCategory);
  });

  it('counterfactual confidence is within 0.15 of the original confidence', () => {
    expect(
      Math.abs(originalResult.topConfidence - counterfactualResult.topConfidence),
    ).toBeLessThanOrEqual(0.15);
  });

  it('original missing-secret hypothesis has FailedMount supporting evidence', () => {
    const msHyp = originalResult.allRanked.find((h) => h.category === 'missing-secret')!;
    const notes = msHyp.evidenceAssessment.supporting.map((e) => e.note).join(' ').toLowerCase();
    expect(notes).toMatch(/failedmount|secret.*not.*found/i);
  });

  it('counterfactual missing-secret hypothesis also has FailedMount supporting evidence', () => {
    const msHyp = counterfactualResult.allRanked.find((h) => h.category === 'missing-secret')!;
    const notes = msHyp.evidenceAssessment.supporting.map((e) => e.note).join(' ').toLowerCase();
    expect(notes).toMatch(/failedmount|secret.*not.*found/i);
  });

  it('counterfactual supporting evidence names the correct renamed secret (database-auth)', () => {
    const msHyp = counterfactualResult.allRanked.find((h) => h.category === 'missing-secret')!;
    const notes = msHyp.evidenceAssessment.supporting.map((e) => e.note).join(' ');
    expect(notes).toMatch(/database-auth/);
  });

  it('original and counterfactual produce the same supporting artifact type set for missing-secret', () => {
    const originalTypes = new Set(
      originalResult.allRanked
        .find((h) => h.category === 'missing-secret')!
        .evidenceAssessment.supporting.map((e) => e.artifactType),
    );
    const cfTypes = new Set(
      counterfactualResult.allRanked
        .find((h) => h.category === 'missing-secret')!
        .evidenceAssessment.supporting.map((e) => e.artifactType),
    );
    expect([...originalTypes].sort()).toEqual([...cfTypes].sort());
  });

  it('original and counterfactual both have event evidence for missing-secret hypothesis', () => {
    const originalTypes = new Set(
      originalResult.allRanked
        .find((h) => h.category === 'missing-secret')!
        .evidenceAssessment.supporting.map((e) => e.artifactType),
    );
    const cfTypes = new Set(
      counterfactualResult.allRanked
        .find((h) => h.category === 'missing-secret')!
        .evidenceAssessment.supporting.map((e) => e.artifactType),
    );
    expect(originalTypes.has('event')).toBe(true);
    expect(cfTypes.has('event')).toBe(true);
  });

  it('original and counterfactual both have kubernetes-resource evidence for missing-secret hypothesis', () => {
    const originalTypes = new Set(
      originalResult.allRanked
        .find((h) => h.category === 'missing-secret')!
        .evidenceAssessment.supporting.map((e) => e.artifactType),
    );
    const cfTypes = new Set(
      counterfactualResult.allRanked
        .find((h) => h.category === 'missing-secret')!
        .evidenceAssessment.supporting.map((e) => e.artifactType),
    );
    expect(originalTypes.has('kubernetes-resource')).toBe(true);
    expect(cfTypes.has('kubernetes-resource')).toBe(true);
  });

  it('both scenarios: missing-secret outranks dns-failure (no DNS evidence in context)', () => {
    const originalMs = originalResult.allRanked.find((h) => h.category === 'missing-secret')!;
    const originalDns = originalResult.allRanked.find((h) => h.category === 'dns-failure');
    if (originalDns) {
      expect(originalMs.confidence).toBeGreaterThan(originalDns.confidence);
    }

    const cfMs = counterfactualResult.allRanked.find((h) => h.category === 'missing-secret')!;
    const cfDns = counterfactualResult.allRanked.find((h) => h.category === 'dns-failure');
    if (cfDns) {
      expect(cfMs.confidence).toBeGreaterThan(cfDns.confidence);
    }
  });

  it('both scenarios generate the full crashloop candidate hypothesis set', () => {
    const originalCategories = originalResult.allRanked.map((h) => h.category);
    const cfCategories = counterfactualResult.allRanked.map((h) => h.category);
    for (const cat of ['missing-secret', 'config-error', 'dns-failure', 'oom-kill', 'generic-crash'] as const) {
      expect(originalCategories).toContain(cat);
      expect(cfCategories).toContain(cat);
    }
  });
});
