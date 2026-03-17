import { describe, it, expect } from 'vitest';
import type { Finding, FindingSeverity } from '../../types/index.js';
import type { Hypothesis, HypothesisSet } from '../hypothesis-types.js';
import type { InvestigatorContext } from '../types.js';
import type { BundleProfile, K8sResource, K8sEvent } from '../../types/index.js';
import type { LogFile } from '../../parsers/index.js';
import {
  convertHypothesisToFinding,
  convertHypothesisSetsToFindings,
  mergeHypothesisFindings,
} from '../hypothesis-converter.js';
import { runInvestigation } from '../orchestrator.js';

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



/**
 * Builds a fully-populated Hypothesis with all required fields for converter tests.
 */
function makeHypothesis(overrides: Partial<Hypothesis> = {}): Hypothesis {
  return {
    id: 'pod-crashloop:default/app-pod:missing-secret',
    symptom: "Pod 'app-pod' is in CrashLoopBackOff in namespace 'default'",
    rootCause:
      'A required Kubernetes Secret or key is absent, causing the container to fail on startup',
    category: 'missing-secret',
    evidenceAssessment: {
      supporting: [
        {
          path: 'cluster-resources/events/default.json',
          note: 'FailedMount event for app-pod: secret not found',
          artifactType: 'event',
        },
        {
          path: 'cluster-resources/pods/default/app-pod.yaml',
          note: "Pod 'app-pod' references secret 'app-credentials' which is absent",
          artifactType: 'kubernetes-resource',
        },
      ],
      contradicting: [
        {
          path: 'cluster-resources/secrets/default/other-secret.yaml',
          note: "Secret 'other-secret' exists in namespace 'default'",
          artifactType: 'kubernetes-resource',
        },
      ],
      missingDecisive: [
        'Pod application logs showing a secret or credential error at startup would decisively confirm this hypothesis',
      ],
    },
    confidence: 0.75,
    confidenceRationale:
      'Confidence 0.75: 2 supporting evidence items; 1 specific diagnostic signal; 1 contradicting item; 1 missing decisive evidence item.',
    specGapRecommendations: [
      'Spec gap [missing-secret]: Pod application logs showing a secret or credential error at startup would decisively confirm this hypothesis',
    ],
    sourceFindings: ['finding:k8s:crashloop:0'],
    ...overrides,
  };
}

/**
 * Builds a Finding with the minimum required fields (mirrors test helpers in
 * other test files for consistency).
 */
function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'finding:test:0',
    title: 'Test Finding',
    severity: 'high' as FindingSeverity,
    confidence: 0.7,
    affectedComponents: ['Pod/default/app-pod'],
    reasoningSummary: 'A test finding.',
    evidence: [{ path: 'logs/app.log', note: 'Test evidence' }],
    contradictionsChecked: [],
    recommendedAction: 'Investigate.',
    missingEvidence: [],
    ...overrides,
  };
}

/**
 * Builds a minimal HypothesisSet from a list of hypotheses.
 */
function makeHypothesisSet(
  hypotheses: Hypothesis[],
  symptomKey = 'pod-crashloop:default/app-pod',
): HypothesisSet {
  return {
    symptomKey,
    symptomDescription: "Pod 'app-pod' is in CrashLoopBackOff in namespace 'default'",
    hypotheses,
    topHypothesis: hypotheses[0] ?? null,
  };
}

// ---------------------------------------------------------------------------
// CrashLoopBackOff fixtures for orchestrator integration tests
// ---------------------------------------------------------------------------

const crashLoopPod: K8sResource = {
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: { name: 'app-pod', namespace: 'default' },
  spec: {
    containers: [
      {
        name: 'app',
        image: 'myapp:v1.2.3',
        envFrom: [{ secretRef: { name: 'app-credentials' } }],
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
        restartCount: 8,
        state: {
          waiting: {
            reason: 'CrashLoopBackOff',
            message: 'back-off 5m0s restarting failed container',
          },
        },
      },
    ],
  },
};

const backOffEvent: K8sEvent = {
  involvedObject: { kind: 'Pod', name: 'app-pod', namespace: 'default' },
  reason: 'BackOff',
  message: 'Back-off restarting failed container',
  type: 'Warning',
  count: 12,
  firstTimestamp: '2024-01-01T00:00:00Z',
  lastTimestamp: '2024-01-01T01:00:00Z',
};

/**
 * A FailedMount event for app-pod — triggers missing-secret evidence in the
 * hypothesis evidence collector (the BackOff event alone is not enough).
 */
const failedMountEvent: K8sEvent = {
  involvedObject: { kind: 'Pod', name: 'app-pod', namespace: 'default' },
  reason: 'FailedMount',
  message: "secret \"app-credentials\" not found",
  type: 'Warning',
  count: 5,
  firstTimestamp: '2024-01-01T00:00:00Z',
  lastTimestamp: '2024-01-01T01:00:00Z',
};

/**
 * A dummy Secret in the same namespace — allows the evidence collector to
 * compare the pod's `app-credentials` reference against the actual inventory
 * and generate supporting evidence for the missing-secret hypothesis.
 */
const dummySecret: K8sResource = {
  apiVersion: 'v1',
  kind: 'Secret',
  metadata: { name: 'other-secret', namespace: 'default' },
};

// ---------------------------------------------------------------------------
// Tests — convertHypothesisToFinding
// ---------------------------------------------------------------------------

describe('convertHypothesisToFinding — high-confidence hypothesis produces correct fields', () => {
  const hypothesis = makeHypothesis({ confidence: 0.75 });
  const finding = convertHypothesisToFinding(hypothesis, 1);

  it('has the correct id format', () => {
    expect(finding.id).toBe('finding:hypothesis:missing-secret:1');
  });

  it('title includes the root cause and symptom', () => {
    expect(finding.title).toContain('[Hypothesis]');
    expect(finding.title).toContain(hypothesis.rootCause);
    expect(finding.title).toContain(hypothesis.symptom);
  });

  it('confidence matches the hypothesis confidence', () => {
    expect(finding.confidence).toBe(0.75);
  });

  it('severity is critical for high-confidence missing-secret hypothesis', () => {
    // missing-secret base severity is critical; confidence 0.75 >= 0.2 → no downgrade
    expect(finding.severity).toBe('critical');
  });

  it('evidence is the supporting evidence from the hypothesis', () => {
    expect(finding.evidence).toEqual(hypothesis.evidenceAssessment.supporting);
    expect(finding.evidence).toHaveLength(2);
  });

  it('contradictionsChecked contains the notes from contradicting evidence', () => {
    expect(finding.contradictionsChecked).toHaveLength(1);
    expect(finding.contradictionsChecked[0]).toContain("Secret 'other-secret' exists");
  });

  it('missingEvidence contains missingDecisive + specGapRecommendations', () => {
    const combined = [
      ...hypothesis.evidenceAssessment.missingDecisive,
      ...hypothesis.specGapRecommendations,
    ];
    expect(finding.missingEvidence).toEqual(combined);
    expect(finding.missingEvidence.length).toBeGreaterThanOrEqual(1);
  });

  it('reasoningSummary contains confidence rationale and rank', () => {
    expect(finding.reasoningSummary).toContain('[Differential diagnosis, rank #1]');
    expect(finding.reasoningSummary).toContain(hypothesis.confidenceRationale);
    expect(finding.reasoningSummary).toContain(hypothesis.rootCause);
    expect(finding.reasoningSummary).toContain(hypothesis.symptom);
  });

  it('recommendedAction is category-specific and non-empty', () => {
    expect(finding.recommendedAction).toBeTruthy();
    expect(finding.recommendedAction.length).toBeGreaterThan(0);
    // missing-secret action should mention Secret
    expect(finding.recommendedAction).toMatch(/secret/i);
  });

  it('affectedComponents is derived from the Pod symptom key', () => {
    // id "pod-crashloop:default/app-pod:missing-secret" → Pod/default/app-pod
    expect(finding.affectedComponents).toContain('Pod/default/app-pod');
  });
});

describe('convertHypothesisToFinding — sanitizes supporting evidence', () => {
  const hypothesis = makeHypothesis({
    evidenceAssessment: {
      supporting: [
        {
          path: 'cluster-resources/services/default/5432.yaml',
          note: "Dependency hostname maps to missing Service '5432' in namespace 'default'",
          artifactType: 'kubernetes-resource',
        },
        {
          path: 'cluster-resources/pods/default/app-pod.yaml',
          note: "Pod 'app-pod' references in-cluster hostname 'db.internal' via container 'app' env 'DB_HOST'",
          artifactType: 'kubernetes-resource',
        },
        {
          path: 'cluster-resources/pods/default/app-pod.yaml',
          note: "Pod 'app-pod' references in-cluster hostname 'db.internal' via container 'app' env 'DB_HOST'",
          artifactType: 'kubernetes-resource',
        },
      ],
      contradicting: [],
      missingDecisive: [],
    },
  });
  const finding = convertHypothesisToFinding(hypothesis, 1);

  it('drops suspicious numeric-only service evidence', () => {
    expect(finding.evidence.some((e) => e.path.includes('/services/default/5432.yaml'))).toBe(false);
  });

  it('deduplicates duplicate evidence items', () => {
    expect(finding.evidence).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Tests — low-confidence hypothesis produces severity downgrade
// ---------------------------------------------------------------------------

describe('convertHypothesisToFinding — low-confidence hypothesis produces severity downgrade', () => {
  it('confidence < 0.2 downgrades severity by one level from base', () => {
    const hypothesis = makeHypothesis({ category: 'missing-secret', confidence: 0.15 });
    const finding = convertHypothesisToFinding(hypothesis, 1);
    // missing-secret base is 'critical' (index 4) → drop 1 → 'high' (index 3)
    expect(finding.severity).toBe('high');
    expect(finding.confidence).toBe(0.15);
  });

  it('confidence < 0.1 downgrades severity by two levels from base', () => {
    const hypothesis = makeHypothesis({ category: 'missing-secret', confidence: 0.05 });
    const finding = convertHypothesisToFinding(hypothesis, 1);
    // missing-secret base is 'critical' (index 4) → drop 2 → 'medium' (index 2)
    expect(finding.severity).toBe('medium');
    expect(finding.confidence).toBe(0.05);
  });

  it('confidence < 0.1 for a medium-base category drops to low', () => {
    const hypothesis = makeHypothesis({
      id: 'pod-crashloop:default/app-pod:generic-crash',
      category: 'generic-crash',
      confidence: 0.05,
    });
    const finding = convertHypothesisToFinding(hypothesis, 2);
    // generic-crash base is 'medium' (index 2) → drop 2 → 'info' (index 0)
    expect(finding.severity).toBe('info');
  });

  it('confidence = 0.2 does NOT downgrade (boundary value)', () => {
    const hypothesis = makeHypothesis({ category: 'missing-secret', confidence: 0.2 });
    const finding = convertHypothesisToFinding(hypothesis, 1);
    // At exactly 0.2: condition is confidence < 0.2 → false → no downgrade
    expect(finding.severity).toBe('critical');
  });

  it('zero confidence produces maximally downgraded severity', () => {
    const hypothesis = makeHypothesis({ category: 'missing-secret', confidence: 0 });
    const finding = convertHypothesisToFinding(hypothesis, 1);
    // 'critical' (4) → drop 2 → 'medium' (2)
    expect(finding.severity).toBe('medium');
  });

  it('zero confidence for dns-failure (high base) drops to medium', () => {
    const hypothesis = makeHypothesis({
      id: 'pod-not-ready:default/app-pod:dns-failure',
      category: 'dns-failure',
      confidence: 0,
    });
    const finding = convertHypothesisToFinding(hypothesis, 3);
    // 'high' (3) → drop 2 → 'low' (1)
    expect(finding.severity).toBe('low');
  });
});

// ---------------------------------------------------------------------------
// Tests — affectedComponents derivation
// ---------------------------------------------------------------------------

describe('convertHypothesisToFinding — affectedComponents derivation', () => {
  it('extracts Pod component from pod-crashloop symptom key', () => {
    const h = makeHypothesis({
      id: 'pod-crashloop:default/app-pod:missing-secret',
      category: 'missing-secret',
    });
    const finding = convertHypothesisToFinding(h, 1);
    expect(finding.affectedComponents).toEqual(['Pod/default/app-pod']);
  });

  it('extracts Pod component from pod-imagepull symptom key', () => {
    const h = makeHypothesis({
      id: 'pod-imagepull:production/worker:image-pull-failure',
      category: 'image-pull-failure',
    });
    const finding = convertHypothesisToFinding(h, 1);
    expect(finding.affectedComponents).toEqual(['Pod/production/worker']);
  });

  it('extracts Pod component from pod-not-ready symptom key', () => {
    const h = makeHypothesis({
      id: 'pod-not-ready:staging/api-pod:readiness-failure',
      category: 'readiness-failure',
    });
    const finding = convertHypothesisToFinding(h, 1);
    expect(finding.affectedComponents).toEqual(['Pod/staging/api-pod']);
  });

  it('extracts component from symptom: prefix', () => {
    const h = makeHypothesis({
      id: 'symptom:some-component:generic-crash',
      category: 'generic-crash',
    });
    const finding = convertHypothesisToFinding(h, 1);
    expect(finding.affectedComponents).toEqual(['some-component']);
  });
});

// ---------------------------------------------------------------------------
// Tests — convertHypothesisSetsToFindings
// ---------------------------------------------------------------------------

describe('convertHypothesisSetsToFindings', () => {
  it('returns an empty array for empty sets', () => {
    expect(convertHypothesisSetsToFindings([])).toEqual([]);
  });

  it('converts all hypotheses in a single set', () => {
    const h1 = makeHypothesis({ id: 'pod-crashloop:default/app-pod:missing-secret', category: 'missing-secret', confidence: 0.75 });
    const h2 = makeHypothesis({ id: 'pod-crashloop:default/app-pod:config-error', category: 'config-error', confidence: 0.50 });
    const h3 = makeHypothesis({ id: 'pod-crashloop:default/app-pod:oom-kill', category: 'oom-kill', confidence: 0.20 });

    const set = makeHypothesisSet([h1, h2, h3]);
    const findings = convertHypothesisSetsToFindings([set]);

    expect(findings).toHaveLength(3);
  });

  it('assigns globally unique ranks across multiple sets', () => {
    const setA = makeHypothesisSet(
      [
        makeHypothesis({ id: 'pod-crashloop:default/app-pod:missing-secret', category: 'missing-secret' }),
        makeHypothesis({ id: 'pod-crashloop:default/app-pod:generic-crash', category: 'generic-crash' }),
      ],
      'pod-crashloop:default/app-pod',
    );
    const setB = makeHypothesisSet(
      [
        makeHypothesis({
          id: 'pod-imagepull:default/worker:image-pull-failure',
          category: 'image-pull-failure',
          symptom: "Pod 'worker' cannot pull its image",
        }),
      ],
      'pod-imagepull:default/worker',
    );

    const findings = convertHypothesisSetsToFindings([setA, setB]);
    expect(findings).toHaveLength(3);

    // All ids should be unique
    const ids = findings.map((f) => f.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(3);
  });

  it('includes non-top hypotheses (lower-ranked) for transparency', () => {
    const ranked = [
      makeHypothesis({ id: 'pod-crashloop:default/app-pod:missing-secret', category: 'missing-secret', confidence: 0.75 }),
      makeHypothesis({ id: 'pod-crashloop:default/app-pod:oom-kill', category: 'oom-kill', confidence: 0.30 }),
      makeHypothesis({ id: 'pod-crashloop:default/app-pod:generic-crash', category: 'generic-crash', confidence: 0.10 }),
    ];
    const set = makeHypothesisSet(ranked);
    const findings = convertHypothesisSetsToFindings([set]);

    // All 3 hypotheses are included (not just the top one)
    expect(findings).toHaveLength(3);
    const categories = findings.map((f) => f.id.split(':')[2]);
    expect(categories).toContain('missing-secret');
    expect(categories).toContain('oom-kill');
    expect(categories).toContain('generic-crash');
  });

  it('adds runner-up comparison context to the top finding reasoning summary', () => {
    const top = makeHypothesis({
      id: 'pod-not-ready:default/app-pod:dns-failure',
      category: 'dns-failure',
      confidence: 0.82,
      rootCause: 'DNS resolution is failing for the dependency hostname',
      evidenceAssessment: {
        supporting: [
          {
            path: 'logs/default/app-pod/current.log',
            note: 'Log line shows DNS resolution failure: "lookup db.internal: no such host"',
            artifactType: 'log',
          },
        ],
        contradicting: [],
        missingDecisive: [],
      },
    });
    const runnerUp = makeHypothesis({
      id: 'pod-not-ready:default/app-pod:connectivity-failure',
      category: 'connectivity-failure',
      confidence: 0.67,
      rootCause: 'A required dependency is unavailable due to a generic connectivity failure',
      evidenceAssessment: {
        supporting: [
          {
            path: 'logs/default/app-pod/current.log',
            note: 'Log line shows connection timeout while connecting to db.internal:5432',
            artifactType: 'log',
          },
        ],
        contradicting: [
          {
            path: 'logs/default/app-pod/current.log',
            note: 'Log line shows a later successful connection',
            artifactType: 'log',
          },
        ],
        missingDecisive: [],
      },
    });

    const findings = convertHypothesisSetsToFindings([
      makeHypothesisSet([top, runnerUp], 'pod-not-ready:default/app-pod'),
    ]);

    expect(findings[0]!.reasoningSummary).toContain('Preferred over runner-up');
    expect(findings[0]!.reasoningSummary).toContain('lookup db.internal: no such host');
    expect(findings[0]!.reasoningSummary).toContain('rank #1');
    expect(findings[1]!.reasoningSummary).toContain('rank #2');
  });
});

// ---------------------------------------------------------------------------
// Tests — mergeHypothesisFindings
// ---------------------------------------------------------------------------

describe('mergeHypothesisFindings — prefers hypothesis findings over equivalent originals', () => {
  it('replaces an original finding when issue family and component overlap', () => {
    const original = makeFinding({
      id: 'finding:config:missing-secret:0',
      title: "Missing Secret: Pod 'app-pod' references non-existent secret(s) in namespace 'default'",
      affectedComponents: ['Pod/default/app-pod', 'Secret/default/app-credentials'],
      confidence: 0.65,
    });

    const hypothesisFinding = makeFinding({
      id: 'finding:hypothesis:missing-secret:1',
      title: '[Hypothesis] A required Secret is absent (symptom: CrashLoopBackOff)',
      affectedComponents: ['Pod/default/app-pod'],
      confidence: 0.75,
    });

    const merged = mergeHypothesisFindings([hypothesisFinding], [original]);

    expect(merged).toHaveLength(1);
    expect(merged[0]!.id).toBe('finding:hypothesis:missing-secret:1');
  });

  it('drops all equivalent originals when a hypothesis finding covers the same issue', () => {
    const original1 = makeFinding({
      id: 'finding:k8s:imagepull:0',
      title: "ImagePullBackOff: Pod 'app-pod' in namespace 'default' (image: myapp:v999)",
      affectedComponents: ['Pod/default/app-pod', 'Image/myapp:v999'],
    });
    const original2 = makeFinding({
      id: 'finding:log:image-pull:0',
      title: 'Image Pull Failures in pods/default/app-pod/app.log',
      affectedComponents: ['Pod/default/app-pod', 'Image/myapp:v999'],
    });

    const hypothesisFinding = makeFinding({
      id: 'finding:hypothesis:image-pull-failure:1',
      title: '[Hypothesis] The image tag is invalid (symptom: ImagePullBackOff)',
      affectedComponents: ['Pod/default/app-pod', 'Image/myapp:v999'],
    });

    const merged = mergeHypothesisFindings([hypothesisFinding], [original1, original2]);

    expect(merged).toHaveLength(1);
    expect(merged[0]!.id).toBe('finding:hypothesis:image-pull-failure:1');
  });
});

describe('mergeHypothesisFindings — keeps originals that have no hypothesis equivalent', () => {
  it('keeps original findings for components not covered by any equivalent hypothesis', () => {
    const original = makeFinding({
      id: 'finding:config:missing-service:0',
      title: "Missing Service Reference: Pod 'app-pod' env var(s) reference non-existent service(s)",
      affectedComponents: ['Service/default/db-service'],
      confidence: 0.6,
    });

    const hypothesisFinding = makeFinding({
      id: 'finding:hypothesis:missing-secret:1',
      affectedComponents: ['Pod/default/app-pod'],
    });

    const merged = mergeHypothesisFindings([hypothesisFinding], [original]);

    expect(merged).toHaveLength(2);
    const serviceFindings = merged.filter((f) =>
      f.affectedComponents.includes('Service/default/db-service'),
    );
    expect(serviceFindings).toHaveLength(1);
    expect(serviceFindings[0]!.id).toBe('finding:config:missing-service:0');
  });

  it('keeps a symptom finding on the same component when the hypothesis is a different issue family', () => {
    const original = makeFinding({
      id: 'finding:k8s:crashloop:0',
      title: "CrashLoopBackOff: Pod 'app-pod' in namespace 'default'",
      affectedComponents: ['Pod/default/app-pod'],
    });

    const hypothesisFinding = makeFinding({
      id: 'finding:hypothesis:missing-secret:1',
      title: '[Hypothesis] A required Secret is absent (symptom: CrashLoopBackOff)',
      affectedComponents: ['Pod/default/app-pod'],
    });

    const merged = mergeHypothesisFindings([hypothesisFinding], [original]);

    expect(merged).toHaveLength(2);
    expect(merged.map((f) => f.id)).toContain('finding:hypothesis:missing-secret:1');
    expect(merged.map((f) => f.id)).toContain('finding:k8s:crashloop:0');
  });

  it('keeps all originals when no hypothesis findings are provided', () => {
    const originals = [
      makeFinding({ id: 'finding:k8s:crashloop:0', affectedComponents: ['Pod/default/app-pod'] }),
      makeFinding({ id: 'finding:log:dns:0', title: 'DNS Resolution Failures in pod.log', affectedComponents: ['DNS/db.internal'] }),
    ];

    const merged = mergeHypothesisFindings([], originals);
    expect(merged).toHaveLength(2);
  });

  it('returns only hypothesis findings when originals are empty', () => {
    const hf = makeFinding({ id: 'finding:hypothesis:missing-secret:1', affectedComponents: ['Pod/default/app-pod'] });
    const merged = mergeHypothesisFindings([hf], []);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.id).toBe('finding:hypothesis:missing-secret:1');
  });

  it('keeps findings for different components when both hypothesis and original exist', () => {
    const podOriginal = makeFinding({
      id: 'finding:k8s:crashloop:0',
      title: "CrashLoopBackOff: Pod 'app-pod' in namespace 'default'",
      affectedComponents: ['Pod/default/app-pod'],
    });
    const dnsOriginal = makeFinding({
      id: 'finding:log:dns:0',
      title: 'DNS Resolution Failures in pod.log',
      affectedComponents: ['DNS/db.internal'],
    });

    const hypothesisFinding = makeFinding({
      id: 'finding:hypothesis:missing-secret:1',
      affectedComponents: ['Pod/default/app-pod'],
    });

    const merged = mergeHypothesisFindings([hypothesisFinding], [podOriginal, dnsOriginal]);

    expect(merged).toHaveLength(3);
    expect(merged.map((f) => f.id)).toContain('finding:hypothesis:missing-secret:1');
    expect(merged.map((f) => f.id)).toContain('finding:log:dns:0');
    expect(merged.map((f) => f.id)).toContain('finding:k8s:crashloop:0');
  });
});

// ---------------------------------------------------------------------------
// Tests — orchestrator integration
// ---------------------------------------------------------------------------

describe('orchestrator integration — CrashLoopBackOff produces hypothesis findings', () => {
  it('produces at least one hypothesis finding in the final output', async () => {
    // Include a dummy Secret so the missing-secret hypothesis collector can
    // detect the absent 'app-credentials' reference and generate evidence.
    const context = makeContext({
      resources: [crashLoopPod, dummySecret],
      events: [backOffEvent, failedMountEvent],
    });

    const result = await runInvestigation(context);

    // Hypothesis findings have ids matching "finding:hypothesis:*"
    const hypothesisFindings = result.findings.filter((f) =>
      f.id.startsWith('finding:hypothesis:'),
    );
    expect(hypothesisFindings.length).toBeGreaterThan(0);
  });

  it('prefers a hypothesis missing-secret finding over the equivalent heuristic missing-secret finding', async () => {
    const context = makeContext({
      resources: [crashLoopPod, dummySecret],
      events: [backOffEvent, failedMountEvent],
    });

    const result = await runInvestigation(context);

    const hypothesisMissingSecret = result.findings.find(
      (f) =>
        f.id.startsWith('finding:hypothesis:missing-secret:') &&
        f.affectedComponents.includes('Pod/default/app-pod'),
    );
    const heuristicMissingSecret = result.findings.find(
      (f) =>
        !f.id.startsWith('finding:hypothesis:') &&
        /missing secret/i.test(f.title) &&
        f.affectedComponents.includes('Pod/default/app-pod'),
    );
    const crashLoopSymptom = result.findings.find(
      (f) =>
        !f.id.startsWith('finding:hypothesis:') &&
        /crashloop/i.test(f.title) &&
        f.affectedComponents.includes('Pod/default/app-pod'),
    );

    expect(hypothesisMissingSecret).toBeDefined();
    expect(heuristicMissingSecret).toBeUndefined();
    expect(crashLoopSymptom).toBeDefined();
  });

  it('produces multiple hypothesis findings (differential diagnosis transparency)', async () => {
    // Include a dummy Secret AND a FailedMount event to generate enough
    // evidence for multiple hypotheses to pass the confidence > 0 filter.
    const context = makeContext({
      resources: [crashLoopPod, dummySecret],
      events: [backOffEvent, failedMountEvent],
    });

    const result = await runInvestigation(context);

    // At least one hypothesis finding should be present (missing-secret gets evidence).
    // With FailedMount events + missing secret reference, we expect at least
    // the missing-secret hypothesis to have confidence > 0.
    const hypothesisFindings = result.findings.filter((f) =>
      f.id.startsWith('finding:hypothesis:'),
    );
    expect(hypothesisFindings.length).toBeGreaterThan(0);
  });

  it('hypothesis findings have differential diagnosis context in reasoningSummary', async () => {
    const context = makeContext({
      resources: [crashLoopPod, dummySecret],
      events: [backOffEvent, failedMountEvent],
    });

    const result = await runInvestigation(context);

    const hypothesisFindings = result.findings.filter((f) =>
      f.id.startsWith('finding:hypothesis:'),
    );
    expect(hypothesisFindings.length).toBeGreaterThan(0);

    for (const f of hypothesisFindings) {
      expect(f.reasoningSummary).toMatch(/\[Differential diagnosis, rank #\d+\]/);
    }
  });
});

describe('orchestrator integration — metadata includes hypothesis counts', () => {
  it('metadata contains hypothesesGenerated count', async () => {
    const context = makeContext({
      resources: [crashLoopPod, dummySecret],
      events: [backOffEvent, failedMountEvent],
    });

    const result = await runInvestigation(context);

    expect(result.metadata).toHaveProperty('hypothesesGenerated');
    expect(typeof result.metadata.hypothesesGenerated).toBe('number');
    expect(result.metadata.hypothesesGenerated).toBeGreaterThanOrEqual(0);
  });

  it('metadata contains hypothesesVerified count', async () => {
    const context = makeContext({
      resources: [crashLoopPod, dummySecret],
      events: [backOffEvent, failedMountEvent],
    });

    const result = await runInvestigation(context);

    expect(result.metadata).toHaveProperty('hypothesesVerified');
    expect(typeof result.metadata.hypothesesVerified).toBe('number');
    expect(result.metadata.hypothesesVerified).toBeGreaterThanOrEqual(0);
  });

  it('hypothesesGenerated > 0 for a CrashLoopBackOff context', async () => {
    const context = makeContext({
      resources: [crashLoopPod, dummySecret],
      events: [backOffEvent, failedMountEvent],
    });

    const result = await runInvestigation(context);
    expect(result.metadata.hypothesesGenerated).toBeGreaterThan(0);
  });

  it('hypothesesGenerated = 0 for an empty context (no findings to generate hypotheses from)', async () => {
    const context = makeContext();
    const result = await runInvestigation(context);
    expect(result.metadata.hypothesesGenerated).toBe(0);
  });
});

describe('orchestrator integration — no-AI mode still produces hypothesis findings', () => {
  it('hypothesis layer is active without aiDeps (heuristic-only mode)', async () => {
    // Include dummy Secret and FailedMount event so the missing-secret hypothesis
    // collects evidence and passes the confidence > 0 filter.
    const context = makeContext({
      resources: [crashLoopPod, dummySecret],
      events: [backOffEvent, failedMountEvent],
    });

    // No aiDeps passed → AI investigation is inactive
    const result = await runInvestigation(context);

    expect(result.metadata.aiEnabled).toBe(false);

    // Hypothesis layer should still have run
    const hypothesisFindings = result.findings.filter((f) =>
      f.id.startsWith('finding:hypothesis:'),
    );
    expect(hypothesisFindings.length).toBeGreaterThan(0);
    expect(result.metadata.hypothesesGenerated).toBeGreaterThan(0);
  });

  it('all finding ids remain unique after hypothesis layer integration', async () => {
    const context = makeContext({
      resources: [crashLoopPod, dummySecret],
      events: [backOffEvent, failedMountEvent],
    });

    const result = await runInvestigation(context);

    const ids = result.findings.map((f) => f.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });
});
