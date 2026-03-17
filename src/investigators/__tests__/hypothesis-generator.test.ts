import { describe, it, expect } from 'vitest';
import type { Finding, FindingSeverity } from '../../types/index.js';
import type { BundleProfile } from '../../types/index.js';
import type { InvestigatorContext } from '../types.js';
import type { LogFile } from '../../parsers/index.js';
import {
  groupFindingsBySymptom,
  generateHypothesesForSymptom,
  generateAllHypotheses,
} from '../hypothesis-generator.js';

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
    contradictionsChecked: ['Initial check: pod status inspected'],
    recommendedAction: 'Take action.',
    missingEvidence: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Reusable finding fixtures
// ---------------------------------------------------------------------------

/** A CrashLoopBackOff finding (mirrors kubernetes-investigator output). */
const crashLoopFinding: Finding = makeFinding({
  id: 'finding:k8s:crashloop:0',
  title: "CrashLoopBackOff: Pod 'app-pod' in namespace 'default'",
  severity: 'critical',
  confidence: 0.95,
  affectedComponents: ['Pod/default/app-pod', 'Container/app'],
  evidence: [
    {
      path: 'cluster-resources/pods/default/app-pod.yaml',
      note: "Container 'app' is in CrashLoopBackOff with 8 restarts",
      artifactType: 'kubernetes-resource',
    },
    {
      path: 'cluster-resources/events/default.json',
      note: 'FailedMount events — missing Secret or ConfigMap',
      artifactType: 'event',
    },
  ],
});

/** An ImagePullBackOff finding. */
const imagePullFinding: Finding = makeFinding({
  id: 'finding:k8s:imagepull:0',
  title: "ImagePullBackOff: Pod 'app-pod' in namespace 'default' (image: myapp:v999.99.99)",
  severity: 'critical',
  confidence: 0.95,
  affectedComponents: ['Pod/default/app-pod', 'Container/app', 'Image/myapp:v999.99.99'],
  evidence: [
    {
      path: 'cluster-resources/pods/default/app-pod.yaml',
      note: "Container 'app' is in ImagePullBackOff for image 'myapp:v999.99.99'",
      artifactType: 'kubernetes-resource',
    },
  ],
});

/** A not-ready finding. */
const notReadyFinding: Finding = makeFinding({
  id: 'finding:k8s:notready:0',
  title: "Not Ready Pod: 'app-pod' in namespace 'default' (Running but not Ready)",
  severity: 'high',
  confidence: 0.75,
  affectedComponents: ['Pod/default/app-pod'],
  evidence: [
    {
      path: 'cluster-resources/pods/default/app-pod.yaml',
      note: 'Pod is Running but not Ready',
      artifactType: 'kubernetes-resource',
    },
  ],
});

/** A finding for a different pod. */
const otherPodFinding: Finding = makeFinding({
  id: 'finding:k8s:crashloop:1',
  title: "CrashLoopBackOff: Pod 'worker-pod' in namespace 'default'",
  severity: 'critical',
  confidence: 0.85,
  affectedComponents: ['Pod/default/worker-pod', 'Container/worker'],
  evidence: [
    {
      path: 'cluster-resources/pods/default/worker-pod.yaml',
      note: "Container 'worker' is in CrashLoopBackOff with 5 restarts",
      artifactType: 'kubernetes-resource',
    },
  ],
});

/** A finding whose Pod is not the first affected component. */
const reorderedComponentsFinding: Finding = makeFinding({
  id: 'finding:k8s:reordered:0',
  title: "CrashLoopBackOff: Pod 'app-pod' in namespace 'default'",
  affectedComponents: ['Container/app', 'Pod/default/app-pod'],
});

/** A readiness symptom phrased via probe failure rather than the words "not ready". */
const readinessProbeFailureFinding: Finding = makeFinding({
  id: 'finding:k8s:readiness-probe:0',
  title: "Readiness probe failed for Pod 'app-pod' in namespace 'default'",
  reasoningSummary: 'The readiness probe keeps failing, so the pod never becomes ready.',
  evidence: [
    {
      path: 'cluster-resources/events/default.json',
      note: 'Readiness probe failed: connection refused on /healthz',
      artifactType: 'event',
    },
  ],
});

// ---------------------------------------------------------------------------
// groupFindingsBySymptom
// ---------------------------------------------------------------------------

describe('groupFindingsBySymptom — empty findings', () => {
  it('returns an empty map when no findings are provided', () => {
    const groups = groupFindingsBySymptom([]);
    expect(groups.size).toBe(0);
  });
});

describe('groupFindingsBySymptom — single finding', () => {
  it('creates exactly one group for a single finding', () => {
    const groups = groupFindingsBySymptom([crashLoopFinding]);
    expect(groups.size).toBe(1);
  });

  it('the group key contains the primary component identifier', () => {
    const groups = groupFindingsBySymptom([crashLoopFinding]);
    const keys = Array.from(groups.keys());
    // Key should reference the pod component
    expect(keys[0]).toBeTruthy();
    expect(keys.some(k => k.includes('app-pod'))).toBe(true);
  });

  it('the group contains the original finding', () => {
    const groups = groupFindingsBySymptom([crashLoopFinding]);
    const findings = Array.from(groups.values())[0]!;
    expect(findings).toHaveLength(1);
    expect(findings[0]!.id).toBe('finding:k8s:crashloop:0');
  });

  it('prefers the Pod component even when it is not first in affectedComponents', () => {
    const groups = groupFindingsBySymptom([reorderedComponentsFinding]);
    expect(Array.from(groups.keys())).toEqual(['Pod/default/app-pod']);
  });
});

describe('groupFindingsBySymptom — multiple findings for the same pod', () => {
  it('groups both findings under one key', () => {
    const groups = groupFindingsBySymptom([crashLoopFinding, notReadyFinding]);
    expect(groups.size).toBe(1);
  });

  it('the single group contains both findings', () => {
    const groups = groupFindingsBySymptom([crashLoopFinding, notReadyFinding]);
    const findings = Array.from(groups.values())[0]!;
    expect(findings).toHaveLength(2);
  });
});

describe('groupFindingsBySymptom — findings for different pods', () => {
  it('creates separate groups for different pods', () => {
    const groups = groupFindingsBySymptom([crashLoopFinding, otherPodFinding]);
    expect(groups.size).toBe(2);
  });

  it('each group contains exactly one finding', () => {
    const groups = groupFindingsBySymptom([crashLoopFinding, otherPodFinding]);
    for (const findings of groups.values()) {
      expect(findings).toHaveLength(1);
    }
  });

  it('app-pod and worker-pod are in different groups', () => {
    const groups = groupFindingsBySymptom([crashLoopFinding, otherPodFinding]);
    const keys = Array.from(groups.keys());
    const appPodKey = keys.find(k => k.includes('app-pod'));
    const workerPodKey = keys.find(k => k.includes('worker-pod'));
    expect(appPodKey).toBeDefined();
    expect(workerPodKey).toBeDefined();
    expect(appPodKey).not.toBe(workerPodKey);
  });
});

// ---------------------------------------------------------------------------
// generateHypothesesForSymptom — CrashLoopBackOff
// ---------------------------------------------------------------------------

describe('generateHypothesesForSymptom — CrashLoopBackOff', () => {
  const context = makeContext();
  const hypotheses = generateHypothesesForSymptom(
    'pod-crashloop:default/app-pod',
    [crashLoopFinding],
    context,
  );

  it('generates at least 3 competing hypotheses for a CrashLoopBackOff finding', () => {
    expect(hypotheses.length).toBeGreaterThanOrEqual(3);
  });

  it('includes a missing-secret hypothesis', () => {
    const cats = hypotheses.map(h => h.category);
    expect(cats).toContain('missing-secret');
  });

  it('includes a config-error hypothesis', () => {
    const cats = hypotheses.map(h => h.category);
    expect(cats).toContain('config-error');
  });

  it('includes a generic-crash hypothesis (application bug / unclassified crash)', () => {
    const cats = hypotheses.map(h => h.category);
    expect(cats).toContain('generic-crash');
  });

  it('all hypotheses start with confidence 0.0', () => {
    for (const h of hypotheses) {
      expect(h.confidence).toBe(0.0);
    }
  });

  it('all hypotheses have the symptomKey in their id', () => {
    for (const h of hypotheses) {
      expect(h.id).toContain('pod-crashloop:default/app-pod');
    }
  });

  it('all hypotheses reference the source finding id', () => {
    for (const h of hypotheses) {
      expect(h.sourceFindings).toContain('finding:k8s:crashloop:0');
    }
  });

  it('all hypotheses have empty evidence assessments', () => {
    for (const h of hypotheses) {
      expect(h.evidenceAssessment.supporting).toHaveLength(0);
      expect(h.evidenceAssessment.contradicting).toHaveLength(0);
      expect(h.evidenceAssessment.missingDecisive).toHaveLength(0);
    }
  });

  it('all hypotheses have non-empty symptom description', () => {
    for (const h of hypotheses) {
      expect(h.symptom).toBeTruthy();
    }
  });

  it('all hypotheses have non-empty rootCause description', () => {
    for (const h of hypotheses) {
      expect(h.rootCause).toBeTruthy();
    }
  });

  it('all hypotheses have unique ids', () => {
    const ids = hypotheses.map(h => h.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(hypotheses.length);
  });
});

// ---------------------------------------------------------------------------
// generateHypothesesForSymptom — ImagePullBackOff
// ---------------------------------------------------------------------------

describe('generateHypothesesForSymptom — ImagePullBackOff', () => {
  const context = makeContext();
  const hypotheses = generateHypothesesForSymptom(
    'pod-imagepull:default/app-pod',
    [imagePullFinding],
    context,
  );

  it('generates at least 2 competing hypotheses for an ImagePullBackOff finding', () => {
    expect(hypotheses.length).toBeGreaterThanOrEqual(2);
  });

  it('all generated hypotheses have category image-pull-failure', () => {
    const cats = hypotheses.map(h => h.category);
    expect(cats.every(c => c === 'image-pull-failure')).toBe(true);
  });

  it('includes a hypothesis about bad image tag', () => {
    const hasTagHypothesis = hypotheses.some(
      h => /tag|wrong|not found|invalid/i.test(h.rootCause),
    );
    expect(hasTagHypothesis).toBe(true);
  });

  it('includes a hypothesis about auth failure', () => {
    const hasAuthHypothesis = hypotheses.some(
      h => /auth|credential|secret|pull.*secret/i.test(h.rootCause),
    );
    expect(hasAuthHypothesis).toBe(true);
  });

  it('all hypotheses start with confidence 0.0', () => {
    for (const h of hypotheses) {
      expect(h.confidence).toBe(0.0);
    }
  });

  it('all hypotheses reference the source finding id', () => {
    for (const h of hypotheses) {
      expect(h.sourceFindings).toContain('finding:k8s:imagepull:0');
    }
  });

  it('all hypotheses have unique ids', () => {
    const ids = hypotheses.map(h => h.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(hypotheses.length);
  });
});

// ---------------------------------------------------------------------------
// generateHypothesesForSymptom — not-ready
// ---------------------------------------------------------------------------

describe('generateHypothesesForSymptom — not-ready', () => {
  const context = makeContext();
  const hypotheses = generateHypothesesForSymptom(
    'pod-not-ready:default/app-pod',
    [notReadyFinding],
    context,
  );

  it('generates at least 2 competing hypotheses for a not-ready finding', () => {
    expect(hypotheses.length).toBeGreaterThanOrEqual(2);
  });

  it('includes a dependency-failure / connectivity hypothesis', () => {
    const hasDependency = hypotheses.some(
      h => h.category === 'connectivity-failure' || /dependency|unavailable|service/i.test(h.rootCause),
    );
    expect(hasDependency).toBe(true);
  });

  it('includes a readiness-probe-misconfigured hypothesis', () => {
    const hasReadiness = hypotheses.some(
      h => h.category === 'readiness-failure' || /readiness.*probe|probe.*misconfigured/i.test(h.rootCause),
    );
    expect(hasReadiness).toBe(true);
  });

  it('all hypotheses start with confidence 0.0', () => {
    for (const h of hypotheses) {
      expect(h.confidence).toBe(0.0);
    }
  });

  it('all hypotheses reference the source finding id', () => {
    for (const h of hypotheses) {
      expect(h.sourceFindings).toContain('finding:k8s:notready:0');
    }
  });

  it('all hypotheses have unique ids', () => {
    const ids = hypotheses.map(h => h.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(hypotheses.length);
  });
});

describe('generateHypothesesForSymptom — symptom detection from evidence phrasing', () => {
  const context = makeContext();

  it('treats readiness-probe failure phrasing as a not-ready symptom', () => {
    const hypotheses = generateHypothesesForSymptom(
      'pod-not-ready:default/app-pod',
      [readinessProbeFailureFinding],
      context,
    );

    expect(hypotheses.map(h => h.category)).toContain('readiness-failure');
  });
});

// ---------------------------------------------------------------------------
// generateAllHypotheses — empty findings
// ---------------------------------------------------------------------------

describe('generateAllHypotheses — empty findings', () => {
  it('returns an empty array when given no findings', () => {
    const sets = generateAllHypotheses([], makeContext());
    expect(sets).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// generateAllHypotheses — single CrashLoopBackOff finding
// ---------------------------------------------------------------------------

describe('generateAllHypotheses — single CrashLoopBackOff finding', () => {
  const sets = generateAllHypotheses([crashLoopFinding], makeContext());

  it('produces exactly one HypothesisSet', () => {
    expect(sets).toHaveLength(1);
  });

  it('HypothesisSet has at least 3 hypotheses', () => {
    expect(sets[0]!.hypotheses.length).toBeGreaterThanOrEqual(3);
  });

  it('HypothesisSet has a non-empty symptomKey', () => {
    expect(sets[0]!.symptomKey).toBeTruthy();
  });

  it('symptomKey references the pod name', () => {
    expect(sets[0]!.symptomKey).toContain('app-pod');
  });

  it('HypothesisSet has a non-empty symptomDescription', () => {
    expect(sets[0]!.symptomDescription).toBeTruthy();
  });

  it('topHypothesis is null (not yet scored)', () => {
    expect(sets[0]!.topHypothesis).toBeNull();
  });

  it('all hypotheses start with confidence 0.0', () => {
    for (const h of sets[0]!.hypotheses) {
      expect(h.confidence).toBe(0.0);
    }
  });

  it('hypotheses include missing-secret as a candidate (covers original FailedMount evidence)', () => {
    const cats = sets[0]!.hypotheses.map(h => h.category);
    expect(cats).toContain('missing-secret');
  });

  it('hypotheses include generic-crash as a candidate (covers direct observation)', () => {
    const cats = sets[0]!.hypotheses.map(h => h.category);
    expect(cats).toContain('generic-crash');
  });
});

// ---------------------------------------------------------------------------
// generateAllHypotheses — single ImagePullBackOff finding
// ---------------------------------------------------------------------------

describe('generateAllHypotheses — single ImagePullBackOff finding', () => {
  const sets = generateAllHypotheses([imagePullFinding], makeContext());

  it('produces exactly one HypothesisSet', () => {
    expect(sets).toHaveLength(1);
  });

  it('HypothesisSet has at least 2 hypotheses', () => {
    expect(sets[0]!.hypotheses.length).toBeGreaterThanOrEqual(2);
  });

  it('topHypothesis is null', () => {
    expect(sets[0]!.topHypothesis).toBeNull();
  });

  it('hypotheses cover image-pull-failure category (original finding root cause)', () => {
    const cats = sets[0]!.hypotheses.map(h => h.category);
    expect(cats).toContain('image-pull-failure');
  });

  it('all hypotheses have empty evidenceAssessment.supporting', () => {
    for (const h of sets[0]!.hypotheses) {
      expect(h.evidenceAssessment.supporting).toHaveLength(0);
    }
  });
});

// ---------------------------------------------------------------------------
// generateAllHypotheses — single not-ready finding
// ---------------------------------------------------------------------------

describe('generateAllHypotheses — single not-ready finding', () => {
  const sets = generateAllHypotheses([notReadyFinding], makeContext());

  it('produces exactly one HypothesisSet', () => {
    expect(sets).toHaveLength(1);
  });

  it('HypothesisSet has at least 2 hypotheses', () => {
    expect(sets[0]!.hypotheses.length).toBeGreaterThanOrEqual(2);
  });

  it('topHypothesis is null', () => {
    expect(sets[0]!.topHypothesis).toBeNull();
  });

  it('hypotheses include readiness-failure (original finding root cause)', () => {
    const cats = sets[0]!.hypotheses.map(h => h.category);
    expect(cats).toContain('readiness-failure');
  });
});

// ---------------------------------------------------------------------------
// generateAllHypotheses — multiple findings for same pod → one symptom set
// ---------------------------------------------------------------------------

describe('generateAllHypotheses — multiple findings for same pod', () => {
  const sets = generateAllHypotheses([crashLoopFinding, notReadyFinding], makeContext());

  it('produces exactly one HypothesisSet (same pod → same symptom)', () => {
    expect(sets).toHaveLength(1);
  });

  it('the single set references both source findings in its hypotheses', () => {
    for (const h of sets[0]!.hypotheses) {
      // At least one of the source IDs should be present
      const hasSource = h.sourceFindings.some(
        id => id === 'finding:k8s:crashloop:0' || id === 'finding:k8s:notready:0',
      );
      expect(hasSource).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// generateAllHypotheses — findings for different pods → separate symptom sets
// ---------------------------------------------------------------------------

describe('generateAllHypotheses — findings for different pods', () => {
  const sets = generateAllHypotheses([crashLoopFinding, otherPodFinding], makeContext());

  it('produces two HypothesisSets (one per pod)', () => {
    expect(sets).toHaveLength(2);
  });

  it('each HypothesisSet has at least one hypothesis', () => {
    for (const set of sets) {
      expect(set.hypotheses.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('symptomKeys are different for different pods', () => {
    const keys = sets.map(s => s.symptomKey);
    const unique = new Set(keys);
    expect(unique.size).toBe(2);
  });

  it('one set references app-pod and the other references worker-pod', () => {
    const keys = sets.map(s => s.symptomKey);
    expect(keys.some(k => k.includes('app-pod'))).toBe(true);
    expect(keys.some(k => k.includes('worker-pod'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// generateAllHypotheses — hypotheses include original finding's root cause
// ---------------------------------------------------------------------------

describe('generateAllHypotheses — hypotheses include original finding root cause as candidate', () => {
  it('CrashLoopBackOff finding → generic-crash hypothesis is present', () => {
    const sets = generateAllHypotheses([crashLoopFinding], makeContext());
    const cats = sets[0]!.hypotheses.map(h => h.category);
    // generic-crash represents the direct observation of a crash
    expect(cats).toContain('generic-crash');
  });

  it('ImagePullBackOff finding → image-pull-failure hypothesis is present', () => {
    const sets = generateAllHypotheses([imagePullFinding], makeContext());
    const cats = sets[0]!.hypotheses.map(h => h.category);
    expect(cats).toContain('image-pull-failure');
  });

  it('not-ready finding → readiness-failure hypothesis is present', () => {
    const sets = generateAllHypotheses([notReadyFinding], makeContext());
    const cats = sets[0]!.hypotheses.map(h => h.category);
    expect(cats).toContain('readiness-failure');
  });
});

// ---------------------------------------------------------------------------
// generateAllHypotheses — structural invariants
// ---------------------------------------------------------------------------

describe('generateAllHypotheses — structural invariants', () => {
  const allFindings = [crashLoopFinding, imagePullFinding, notReadyFinding, otherPodFinding];
  // crashLoop and notReady are for the same pod (app-pod), imagePull is also for app-pod,
  // but otherPodFinding is for worker-pod → effectively 2 unique pods
  const sets = generateAllHypotheses(allFindings, makeContext());

  it('all HypothesisSets have non-empty symptomKey', () => {
    for (const s of sets) {
      expect(s.symptomKey).toBeTruthy();
    }
  });

  it('all HypothesisSets have non-empty symptomDescription', () => {
    for (const s of sets) {
      expect(s.symptomDescription).toBeTruthy();
    }
  });

  it('all HypothesisSets have topHypothesis=null (not yet scored)', () => {
    for (const s of sets) {
      expect(s.topHypothesis).toBeNull();
    }
  });

  it('all hypotheses across all sets have confidence 0.0', () => {
    for (const s of sets) {
      for (const h of s.hypotheses) {
        expect(h.confidence).toBe(0.0);
      }
    }
  });

  it('all hypotheses have empty specGapRecommendations', () => {
    for (const s of sets) {
      for (const h of s.hypotheses) {
        expect(h.specGapRecommendations).toHaveLength(0);
      }
    }
  });

  it('all hypotheses have empty evidenceAssessment arrays', () => {
    for (const s of sets) {
      for (const h of s.hypotheses) {
        expect(h.evidenceAssessment.supporting).toHaveLength(0);
        expect(h.evidenceAssessment.contradicting).toHaveLength(0);
        expect(h.evidenceAssessment.missingDecisive).toHaveLength(0);
      }
    }
  });

  it('all hypothesis ids are globally unique across all sets', () => {
    const allIds = sets.flatMap(s => s.hypotheses.map(h => h.id));
    const unique = new Set(allIds);
    expect(unique.size).toBe(allIds.length);
  });

  it('all hypotheses have non-empty sourceFindings', () => {
    for (const s of sets) {
      for (const h of s.hypotheses) {
        expect(h.sourceFindings.length).toBeGreaterThan(0);
      }
    }
  });
});
