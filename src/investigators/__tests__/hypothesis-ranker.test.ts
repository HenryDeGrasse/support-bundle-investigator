import { describe, it, expect } from 'vitest';
import type { Evidence } from '../../types/index.js';
import type { Hypothesis } from '../hypothesis-types.js';
import {
  scoreHypothesis,
  buildConfidenceRationale,
  rankHypotheses,
  identifySpecGaps,
} from '../hypothesis-ranker.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * Builds a minimal {@link Hypothesis} with the given evidence assessment
 * fields, all other fields set to sensible defaults.
 */
function makeHypothesis(overrides: {
  supporting?: Evidence[];
  contradicting?: Evidence[];
  missingDecisive?: string[];
  category?: Hypothesis['category'];
  id?: string;
} = {}): Hypothesis {
  return {
    id: overrides.id ?? 'hyp:test:0',
    symptom: 'Pod app-pod is in CrashLoopBackOff',
    rootCause: 'A required Secret is absent',
    category: overrides.category ?? 'missing-secret',
    evidenceAssessment: {
      supporting: overrides.supporting ?? [],
      contradicting: overrides.contradicting ?? [],
      missingDecisive: overrides.missingDecisive ?? [],
    },
    confidence: 0.0,
    confidenceRationale: 'Not yet scored',
    specGapRecommendations: [],
    sourceFindings: ['finding:test:0'],
  };
}

// ---------------------------------------------------------------------------
// Specific evidence fixtures — contain exact diagnostic signals that match
// the SPECIFIC_PATTERNS in hypothesis-ranker.ts.
// ---------------------------------------------------------------------------

const specificLogEvidence: Evidence = {
  path: 'logs/default/app-pod/app/current.log',
  note: 'Log line shows DNS resolution failure: "ERROR dial tcp: lookup my-service: no such host"',
  artifactType: 'log',
};

const specificK8sEvidence: Evidence = {
  path: 'cluster-resources/pods/default/app-pod.yaml',
  note: "Container 'app' waiting with reason 'ErrImagePull' — image pull failed",
  artifactType: 'kubernetes-resource',
};

const specificEventEvidence: Evidence = {
  path: 'cluster-resources/events/default.json',
  note: "FailedMount event for 'app-pod': MountVolume.SetUp failed: secret 'db-creds' not found",
  artifactType: 'event',
};

const specificLogEvidence2: Evidence = {
  path: 'logs/default/app-pod/app/current.log',
  note: 'Log line shows connection failure: "ERROR context deadline exceeded while connecting to db:5432"',
  artifactType: 'log',
};

const specificMissingSecretK8sEvidence: Evidence = {
  path: 'cluster-resources/pods/default/app-pod.yaml',
  note: "Referenced secret 'app-credentials' absent from namespace 'default'",
  artifactType: 'kubernetes-resource',
};

const specificMissingSecretLogEvidence: Evidence = {
  path: 'logs/default/app-pod/app/current.log',
  note: 'Log line shows configuration error: "secret app-credentials not found during startup"',
  artifactType: 'log',
};

const specificImagePullEventEvidence: Evidence = {
  path: 'cluster-resources/events/default.json',
  note: "Event indicates image pull failure for 'api': Failed to pull image 'registry.local/app:v9'",
  artifactType: 'event',
};

const specificImagePullK8sEvidence: Evidence = {
  path: 'cluster-resources/pods/default/api.yaml',
  note: "Container 'api' waiting with reason 'ImagePullBackOff' — failed to pull image",
  artifactType: 'kubernetes-resource',
};

const specificVolumeMountEvidence: Evidence = {
  path: 'cluster-resources/events/default.json',
  note: 'FailedMount event for pod db-pod: MountVolume.SetUp failed for volume "data"',
  artifactType: 'event',
};

const specificPvcProvisioningEvidence: Evidence = {
  path: 'cluster-resources/persistentvolumeclaims/default/data.yaml',
  note: 'Resource not-found error: storageclass.storage.k8s.io "fast-ssd" not found during PVC provisioning',
  artifactType: 'kubernetes-resource',
};

// ---------------------------------------------------------------------------
// Generic evidence fixtures — describe only symptom status, no specific signal.
// ---------------------------------------------------------------------------

const genericK8sEvidence: Evidence = {
  path: 'cluster-resources/pods/default/app-pod.yaml',
  note: 'Pod is not ready',
  artifactType: 'kubernetes-resource',
};

const genericK8sEvidence2: Evidence = {
  path: 'cluster-resources/pods/default/app-pod.yaml',
  note: 'Running but not ready — pod status shows unhealthy',
  artifactType: 'kubernetes-resource',
};

const genericK8sEvidence3: Evidence = {
  path: 'cluster-resources/pods/default/app-pod.yaml',
  note: 'Container is not ready',
  artifactType: 'kubernetes-resource',
};

const genericK8sEvidence4: Evidence = {
  path: 'cluster-resources/deployments/default/app.yaml',
  note: 'Pod status shows not-ready condition',
  artifactType: 'kubernetes-resource',
};

// ---------------------------------------------------------------------------
// Contradicting evidence fixtures
// ---------------------------------------------------------------------------

const contradictingEvidence: Evidence = {
  path: 'cluster-resources/secrets/default/db-creds.yaml',
  note: "Secret 'db-creds' exists in namespace 'default' — weakens missing-secret hypothesis",
  artifactType: 'kubernetes-resource',
};

const contradictingEvidence2: Evidence = {
  path: 'logs/default/app-pod/app/current.log',
  note: 'Log line shows successful connection (contradicts connectivity failure): "INFO successfully connected to backend"',
  artifactType: 'log',
};

// ---------------------------------------------------------------------------
// scoreHypothesis — confidence bounds tests
// ---------------------------------------------------------------------------

describe('scoreHypothesis — 3 supporting (specific, cross-source), 0 contradicting → high confidence', () => {
  const hyp = makeHypothesis({
    supporting: [specificLogEvidence, specificK8sEvidence, specificEventEvidence],
  });
  const score = scoreHypothesis(hyp);

  it('returns a score >= 0.70', () => {
    expect(score).toBeGreaterThanOrEqual(0.70);
  });

  it('returns a score <= 1.0', () => {
    expect(score).toBeLessThanOrEqual(1.0);
  });
});

describe('scoreHypothesis — 1 supporting, 2 contradicting → low confidence', () => {
  const hyp = makeHypothesis({
    supporting: [specificLogEvidence],
    contradicting: [contradictingEvidence, contradictingEvidence2],
  });
  const score = scoreHypothesis(hyp);

  it('returns a score <= 0.40', () => {
    expect(score).toBeLessThanOrEqual(0.40);
  });

  it('returns a non-negative score', () => {
    expect(score).toBeGreaterThanOrEqual(0.0);
  });
});

describe('scoreHypothesis — 2 supporting (specific, cross-source), 0 contradicting, 2 missing → medium confidence', () => {
  const hyp = makeHypothesis({
    // One log + one kubernetes-resource → triggers cross-source bonus (+0.10)
    // base=0.30, specificity=0.30, cross-source=0.10, missing=0.20 → 0.50
    supporting: [specificLogEvidence, specificK8sEvidence],
    missingDecisive: [
      'CoreDNS logs would confirm DNS resolution failures',
      'Pod application logs showing startup error',
    ],
  });
  const score = scoreHypothesis(hyp);

  it('returns a score >= 0.40', () => {
    expect(score).toBeGreaterThanOrEqual(0.40);
  });

  it('returns a score <= 0.65', () => {
    expect(score).toBeLessThanOrEqual(0.65);
  });
});

describe('scoreHypothesis — empty evidence → very low confidence', () => {
  const hyp = makeHypothesis();
  const score = scoreHypothesis(hyp);

  it('returns a score <= 0.20', () => {
    expect(score).toBeLessThanOrEqual(0.20);
  });

  it('returns 0.0 with no evidence at all', () => {
    expect(score).toBe(0.0);
  });
});

// ---------------------------------------------------------------------------
// scoreHypothesis — monotonicity tests
// ---------------------------------------------------------------------------

describe('scoreHypothesis — removing supporting evidence monotonically decreases confidence', () => {
  const threeItems = [specificLogEvidence, specificLogEvidence2, specificK8sEvidence];
  const twoItems = [specificLogEvidence, specificLogEvidence2];
  const oneItem = [specificLogEvidence];
  const zeroItems: Evidence[] = [];

  const score3 = scoreHypothesis(makeHypothesis({ supporting: threeItems }));
  const score2 = scoreHypothesis(makeHypothesis({ supporting: twoItems }));
  const score1 = scoreHypothesis(makeHypothesis({ supporting: oneItem }));
  const score0 = scoreHypothesis(makeHypothesis({ supporting: zeroItems }));

  it('3 items > 2 items', () => {
    expect(score3).toBeGreaterThan(score2);
  });

  it('2 items > 1 item', () => {
    expect(score2).toBeGreaterThan(score1);
  });

  it('1 item > 0 items', () => {
    expect(score1).toBeGreaterThan(score0);
  });
});

describe('scoreHypothesis — adding contradicting evidence monotonically decreases confidence', () => {
  // Start with a well-supported hypothesis (3 specific items, single source)
  const baseSupporting = [specificLogEvidence, specificLogEvidence2, specificK8sEvidence];

  const score0 = scoreHypothesis(
    makeHypothesis({ supporting: baseSupporting, contradicting: [] }),
  );
  const score1 = scoreHypothesis(
    makeHypothesis({ supporting: baseSupporting, contradicting: [contradictingEvidence] }),
  );
  const score2 = scoreHypothesis(
    makeHypothesis({
      supporting: baseSupporting,
      contradicting: [contradictingEvidence, contradictingEvidence2],
    }),
  );

  it('0 contradicting > 1 contradicting', () => {
    expect(score0).toBeGreaterThan(score1);
  });

  it('1 contradicting > 2 contradicting', () => {
    expect(score1).toBeGreaterThan(score2);
  });
});

// ---------------------------------------------------------------------------
// scoreHypothesis — cross-source bonus
// ---------------------------------------------------------------------------

describe('scoreHypothesis — cross-source evidence scores higher than same-source', () => {
  // Same source: both from 'log'
  const sameSupportingLog: Evidence[] = [
    { path: 'logs/a.log', note: 'Log line shows: "no such host backend"', artifactType: 'log' },
    { path: 'logs/b.log', note: 'Log line shows: "connection refused on port 5432"', artifactType: 'log' },
  ];

  // Cross-source: one 'log', one 'kubernetes-resource'
  const crossSourceSupporting: Evidence[] = [
    { path: 'logs/a.log', note: 'Log line shows: "no such host backend"', artifactType: 'log' },
    {
      path: 'cluster-resources/pods/default/app-pod.yaml',
      note: "Container 'app' waiting with reason 'ErrImagePull'",
      artifactType: 'kubernetes-resource',
    },
  ];

  const scoreSameSource = scoreHypothesis(makeHypothesis({ supporting: sameSupportingLog }));
  const scoreCrossSource = scoreHypothesis(makeHypothesis({ supporting: crossSourceSupporting }));

  it('cross-source score is greater than same-source score', () => {
    expect(scoreCrossSource).toBeGreaterThan(scoreSameSource);
  });

  it('cross-source score exceeds same-source score by ~0.10', () => {
    expect(scoreCrossSource - scoreSameSource).toBeCloseTo(0.10, 5);
  });
});

// ---------------------------------------------------------------------------
// scoreHypothesis — evidence diversity bonus (3+ artifact types)
// ---------------------------------------------------------------------------

describe('scoreHypothesis — evidence diversity bonus: 3 types scores higher than 2 types', () => {
  // Three items from 3 distinct artifact types — no category-decisive patterns
  // so the only scoring difference is the diversity bonus.
  const item1: Evidence = {
    path: 'logs/a.log',
    note: 'Log line shows: "no such host backend"',
    artifactType: 'log',
  };
  const item2: Evidence = {
    path: 'cluster-resources/pods/default/app.yaml',
    note: 'Log line shows: "connection refused to db:5432"',
    artifactType: 'kubernetes-resource',
  };
  // Third item as 'event' type
  const item3event: Evidence = {
    path: 'cluster-resources/events/default.json',
    note: 'Log line shows: "context deadline exceeded"',
    artifactType: 'event',
  };
  // Third item as 'log' type — keeps type count at 2
  const item3log: Evidence = {
    path: 'logs/c.log',
    note: 'Log line shows: "context deadline exceeded"',
    artifactType: 'log',
  };

  const scoreThreeTypes = scoreHypothesis(
    makeHypothesis({ category: 'connectivity-failure', supporting: [item1, item2, item3event] }),
  );
  const scoreTwoTypes = scoreHypothesis(
    makeHypothesis({ category: 'connectivity-failure', supporting: [item1, item2, item3log] }),
  );

  it('3 distinct artifact types scores higher than 2 distinct artifact types', () => {
    expect(scoreThreeTypes).toBeGreaterThan(scoreTwoTypes);
  });

  it('the difference equals the evidence diversity bonus (0.05)', () => {
    expect(scoreThreeTypes - scoreTwoTypes).toBeCloseTo(0.05, 5);
  });
});

// ---------------------------------------------------------------------------
// scoreHypothesis — cross-namespace corroboration bonus
// ---------------------------------------------------------------------------

describe('scoreHypothesis — cross-namespace bonus: evidence with cross-namespace match scores higher', () => {
  const crossNamespaceNote =
    "Service 'my-svc' exists in namespace 'staging' (not 'default' as referenced). " +
    "Did you mean to reference 'my-svc.staging.svc.cluster.local'?";
  const plainMissingNote = "Service 'my-svc' was not found in namespace 'default'";

  const withCrossNamespace = makeHypothesis({
    category: 'dns-failure',
    supporting: [
      {
        path: 'cluster-resources/services/default.json',
        note: crossNamespaceNote,
        artifactType: 'kubernetes-resource',
      },
    ],
  });

  const withoutCrossNamespace = makeHypothesis({
    category: 'dns-failure',
    supporting: [
      {
        path: 'cluster-resources/services/default.json',
        note: plainMissingNote,
        artifactType: 'kubernetes-resource',
      },
    ],
  });

  const scoreWith = scoreHypothesis(withCrossNamespace);
  const scoreWithout = scoreHypothesis(withoutCrossNamespace);

  it('cross-namespace evidence scores significantly higher', () => {
    expect(scoreWith).toBeGreaterThan(scoreWithout);
  });

  it('the difference is at least the cross-namespace bonus (0.15)', () => {
    expect(scoreWith - scoreWithout).toBeGreaterThanOrEqual(0.15);
  });
});

// ---------------------------------------------------------------------------
// buildConfidenceRationale — cross-namespace mention
// ---------------------------------------------------------------------------

describe('buildConfidenceRationale — mentions cross-namespace when cross-namespace evidence present', () => {
  const crossNamespaceEvidence: Evidence = {
    path: 'cluster-resources/services/default.json',
    note: "Service 'my-svc' exists in namespace 'staging' (not 'default' as referenced).",
    artifactType: 'kubernetes-resource',
  };

  const hyp = makeHypothesis({
    category: 'dns-failure',
    supporting: [crossNamespaceEvidence],
  });

  it('rationale mentions "cross-namespace"', () => {
    const rationale = buildConfidenceRationale(hyp);
    expect(rationale.toLowerCase()).toMatch(/cross.namespace/);
  });
});

// ---------------------------------------------------------------------------
// scoreHypothesis — generic symptom-only evidence cap
// ---------------------------------------------------------------------------

describe('scoreHypothesis — generic symptom-only evidence caps confidence at 0.50', () => {
  // Five generic items — without the cap these would score higher than 0.50
  const hyp = makeHypothesis({
    supporting: [
      genericK8sEvidence,
      genericK8sEvidence2,
      genericK8sEvidence3,
      genericK8sEvidence4,
      { path: 'cluster-resources/pods/default/other.yaml', note: 'Pod is not ready', artifactType: 'kubernetes-resource' },
    ],
  });
  const score = scoreHypothesis(hyp);

  it('caps score at 0.50 when all supporting evidence is generic', () => {
    expect(score).toBeLessThanOrEqual(0.50);
  });

  it('score is still positive (not zero) with generic evidence', () => {
    expect(score).toBeGreaterThan(0.0);
  });
});

describe('scoreHypothesis — mixed generic+specific evidence is NOT capped at 0.50', () => {
  // One specific item and one generic item — generic cap should NOT apply
  const hyp = makeHypothesis({
    supporting: [specificLogEvidence, genericK8sEvidence],
  });
  const score = scoreHypothesis(hyp);

  it('score can exceed 0.50 when at least one specific item exists', () => {
    // base = 0.30, specificity = 0.15 (one specific), cross-source = 0.10 → 0.55
    expect(score).toBeGreaterThan(0.50);
  });
});

describe('scoreHypothesis — collector-style missing-secret resource evidence is treated as specific', () => {
  const collectorStyleEvidence: Evidence = {
    path: 'cluster-resources/pods/default/app-pod.yaml',
    note: "Pod 'app-pod' references secret 'db-creds' via volume 'creds', but that secret is absent from captured resources in namespace 'default'",
    artifactType: 'kubernetes-resource',
  };
  const score = scoreHypothesis(makeHypothesis({ supporting: [collectorStyleEvidence] }));

  it('receives a specificity bonus instead of scoring like generic symptom evidence', () => {
    expect(score).toBeCloseTo(0.30, 5);
  });
});

describe('scoreHypothesis — collector-style configuration-error logs are treated as specific', () => {
  const collectorStyleEvidence: Evidence = {
    path: 'logs/default/app-pod/app/current.log',
    note: 'Log line indicates configuration error: "permission denied reading /etc/app/config.yaml"',
    artifactType: 'log',
  };
  const score = scoreHypothesis(makeHypothesis({ supporting: [collectorStyleEvidence] }));

  it('receives a specificity bonus even when the exact raw error is not one of the canned examples', () => {
    expect(score).toBeCloseTo(0.30, 5);
  });
});

// ---------------------------------------------------------------------------
// scoreHypothesis — score is always in [0, 1]
// ---------------------------------------------------------------------------

describe('scoreHypothesis — output is always in [0, 1]', () => {
  const cases: Array<{ label: string; hyp: Hypothesis }> = [
    { label: 'empty', hyp: makeHypothesis() },
    {
      label: 'many supporting',
      hyp: makeHypothesis({
        supporting: [
          specificLogEvidence, specificK8sEvidence, specificEventEvidence,
          specificLogEvidence2,
          { path: 'x', note: 'Log line shows: "crashloopbackoff detected"', artifactType: 'log' },
        ],
      }),
    },
    {
      label: 'many contradicting',
      hyp: makeHypothesis({
        supporting: [specificLogEvidence],
        contradicting: [
          contradictingEvidence, contradictingEvidence2,
          { path: 'x', note: 'Contradiction three', artifactType: 'log' },
          { path: 'y', note: 'Contradiction four', artifactType: 'kubernetes-resource' },
        ],
      }),
    },
    {
      label: 'many missing',
      hyp: makeHypothesis({
        missingDecisive: ['gap 1', 'gap 2', 'gap 3', 'gap 4', 'gap 5'],
      }),
    },
  ];

  for (const { label, hyp } of cases) {
    it(`score is >= 0.0 for case '${label}'`, () => {
      expect(scoreHypothesis(hyp)).toBeGreaterThanOrEqual(0.0);
    });
    it(`score is <= 1.0 for case '${label}'`, () => {
      expect(scoreHypothesis(hyp)).toBeLessThanOrEqual(1.0);
    });
  }
});

// ---------------------------------------------------------------------------
// buildConfidenceRationale
// ---------------------------------------------------------------------------

describe('buildConfidenceRationale — non-empty string explaining the score', () => {
  it('returns a non-empty string for an empty-evidence hypothesis', () => {
    const rationale = buildConfidenceRationale(makeHypothesis());
    expect(typeof rationale).toBe('string');
    expect(rationale.length).toBeGreaterThan(0);
  });

  it('mentions "no supporting evidence" for an empty-evidence hypothesis', () => {
    const rationale = buildConfidenceRationale(makeHypothesis());
    expect(rationale.toLowerCase()).toMatch(/no supporting evidence/);
  });

  it('mentions the supporting evidence count when items are present', () => {
    const hyp = makeHypothesis({ supporting: [specificLogEvidence, specificK8sEvidence] });
    const rationale = buildConfidenceRationale(hyp);
    expect(rationale).toMatch(/2/);
  });

  it('mentions "contradicting" when contradicting items exist', () => {
    const hyp = makeHypothesis({
      supporting: [specificLogEvidence],
      contradicting: [contradictingEvidence],
    });
    const rationale = buildConfidenceRationale(hyp);
    expect(rationale.toLowerCase()).toMatch(/contradict/);
  });

  it('mentions "missing" when missing decisive items exist', () => {
    const hyp = makeHypothesis({
      supporting: [specificLogEvidence],
      missingDecisive: ['CoreDNS logs needed'],
    });
    const rationale = buildConfidenceRationale(hyp);
    expect(rationale.toLowerCase()).toMatch(/missing/);
  });

  it('mentions "specific" or "diagnostic" when specific evidence exists', () => {
    const hyp = makeHypothesis({ supporting: [specificLogEvidence] });
    const rationale = buildConfidenceRationale(hyp);
    expect(rationale.toLowerCase()).toMatch(/specific|diagnostic/);
  });

  it('mentions "cross-source" when evidence spans multiple artifact types', () => {
    const hyp = makeHypothesis({
      supporting: [specificLogEvidence, specificK8sEvidence],
    });
    const rationale = buildConfidenceRationale(hyp);
    expect(rationale.toLowerCase()).toMatch(/cross.source/);
  });

  it('mentions the generic cap when all evidence is generic', () => {
    const hyp = makeHypothesis({
      supporting: [genericK8sEvidence, genericK8sEvidence2],
    });
    const rationale = buildConfidenceRationale(hyp);
    expect(rationale.toLowerCase()).toMatch(/generic|cap/);
  });

  it('includes the numeric score in the rationale', () => {
    const hyp = makeHypothesis({ supporting: [specificLogEvidence] });
    const score = scoreHypothesis(hyp);
    const rationale = buildConfidenceRationale(hyp);
    // Rationale should contain the formatted score (e.g. "0.30")
    expect(rationale).toContain(score.toFixed(2));
  });
});

// ---------------------------------------------------------------------------
// rankHypotheses
// ---------------------------------------------------------------------------

describe('rankHypotheses — sorting by confidence descending', () => {
  // Three hypotheses with clearly different evidence profiles
  const lowHyp = makeHypothesis({
    id: 'hyp:low',
    supporting: [],
    contradicting: [contradictingEvidence],
  });
  const midHyp = makeHypothesis({
    id: 'hyp:mid',
    supporting: [specificLogEvidence],
  });
  const highHyp = makeHypothesis({
    id: 'hyp:high',
    supporting: [specificLogEvidence, specificK8sEvidence, specificEventEvidence],
  });

  // Deliberately pass in ascending order
  const ranked = rankHypotheses([lowHyp, midHyp, highHyp]);

  it('returns an array of the same length', () => {
    expect(ranked).toHaveLength(3);
  });

  it('first element has the highest confidence', () => {
    expect(ranked[0]!.id).toBe('hyp:high');
  });

  it('last element has the lowest confidence', () => {
    expect(ranked[2]!.id).toBe('hyp:low');
  });

  it('confidence values are in descending order', () => {
    expect(ranked[0]!.confidence).toBeGreaterThanOrEqual(ranked[1]!.confidence);
    expect(ranked[1]!.confidence).toBeGreaterThanOrEqual(ranked[2]!.confidence);
  });

  it('updates confidence field on each hypothesis', () => {
    for (const h of ranked) {
      // All should have been scored (not left at 0.0, unless genuinely 0)
      expect(h.confidence).toBeGreaterThanOrEqual(0.0);
      expect(h.confidence).toBeLessThanOrEqual(1.0);
    }
  });

  it('updates confidenceRationale to a non-empty string on each hypothesis', () => {
    for (const h of ranked) {
      expect(typeof h.confidenceRationale).toBe('string');
      expect(h.confidenceRationale.length).toBeGreaterThan(0);
    }
  });

  it('does not mutate the original hypothesis objects', () => {
    expect(highHyp.confidence).toBe(0.0);
    expect(highHyp.confidenceRationale).toBe('Not yet scored');
  });
});

describe('rankHypotheses — empty input', () => {
  it('returns an empty array for empty input', () => {
    expect(rankHypotheses([])).toHaveLength(0);
  });
});

describe('rankHypotheses — single hypothesis', () => {
  it('returns a single-element array', () => {
    const hyp = makeHypothesis({ supporting: [specificLogEvidence] });
    const result = rankHypotheses([hyp]);
    expect(result).toHaveLength(1);
  });

  it('updates confidence on the single hypothesis', () => {
    const hyp = makeHypothesis({ supporting: [specificLogEvidence] });
    const result = rankHypotheses([hyp]);
    expect(result[0]!.confidence).toBeGreaterThan(0.0);
  });
});

describe('rankHypotheses — tie-breaking (equal confidence)', () => {
  const hypA = makeHypothesis({ id: 'hyp:a', supporting: [specificLogEvidence] });
  const hypB = makeHypothesis({ id: 'hyp:b', supporting: [specificLogEvidence2] });
  // Both have identical evidence profiles → equal confidence
  const ranked = rankHypotheses([hypA, hypB]);

  it('returns both hypotheses', () => {
    expect(ranked).toHaveLength(2);
  });

  it('both hypotheses have equal confidence', () => {
    expect(ranked[0]!.confidence).toBe(ranked[1]!.confidence);
  });
});

// ---------------------------------------------------------------------------
// identifySpecGaps
// ---------------------------------------------------------------------------

describe('identifySpecGaps — emits recommendations when missingDecisive is non-empty', () => {
  const hyp = makeHypothesis({
    category: 'dns-failure',
    missingDecisive: [
      'CoreDNS or kube-dns pod logs would decisively confirm DNS failures',
      'Network policy resources would confirm whether traffic is blocked',
    ],
  });
  const gaps = identifySpecGaps(hyp);

  it('returns a non-empty array when missingDecisive is non-empty', () => {
    expect(gaps.length).toBeGreaterThan(0);
  });

  it('returns one recommendation per missing decisive item', () => {
    expect(gaps).toHaveLength(2);
  });

  it('each recommendation is a non-empty string', () => {
    for (const gap of gaps) {
      expect(typeof gap).toBe('string');
      expect(gap.length).toBeGreaterThan(0);
    }
  });

  it('recommendations reference the hypothesis category', () => {
    const joined = gaps.join(' ').toLowerCase();
    expect(joined).toMatch(/dns-failure/);
  });

  it('recommendations include the missing evidence description', () => {
    // At least one gap should contain the original missing description text
    const joined = gaps.join(' ').toLowerCase();
    expect(joined).toMatch(/coredns|dns|kube-dns/);
  });
});

describe('identifySpecGaps — returns empty array when no evidence is missing', () => {
  const hyp = makeHypothesis({
    missingDecisive: [],
  });

  it('returns an empty array when missingDecisive is empty', () => {
    expect(identifySpecGaps(hyp)).toHaveLength(0);
  });
});

describe('identifySpecGaps — different categories produce category-specific prefixes', () => {
  const missingSecret = makeHypothesis({
    category: 'missing-secret',
    missingDecisive: ['Pod logs showing startup failure'],
  });
  const imagePull = makeHypothesis({
    category: 'image-pull-failure',
    missingDecisive: ['Registry access logs'],
  });

  it('missing-secret recommendation mentions missing-secret', () => {
    const gaps = identifySpecGaps(missingSecret);
    expect(gaps[0]).toMatch(/missing-secret/);
  });

  it('image-pull-failure recommendation mentions image-pull-failure', () => {
    const gaps = identifySpecGaps(imagePull);
    expect(gaps[0]).toMatch(/image-pull-failure/);
  });
});

// ---------------------------------------------------------------------------
// Integration — scoreHypothesis + identifySpecGaps together
// ---------------------------------------------------------------------------

describe('Integration — high missing decisive evidence reduces confidence and triggers spec gaps', () => {
  const hyp = makeHypothesis({
    supporting: [specificLogEvidence],
    missingDecisive: [
      'CoreDNS logs',
      'Network policy resources',
      'Service mesh trace logs',
    ],
  });

  it('score is reduced by missing penalties', () => {
    // base=0.15, specificity=0.15 = 0.30; missing 3 * 0.10 = 0.30 → 0.00
    const score = scoreHypothesis(hyp);
    expect(score).toBeLessThanOrEqual(0.15);
  });

  it('identifySpecGaps returns one recommendation per missing item', () => {
    const gaps = identifySpecGaps(hyp);
    expect(gaps).toHaveLength(3);
  });

  it('all spec-gap recommendations are non-empty strings', () => {
    for (const gap of identifySpecGaps(hyp)) {
      expect(gap.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Integration — rankHypotheses assigns coherent confidence rationale
// ---------------------------------------------------------------------------

describe('Integration — rankHypotheses produces coherent rationales', () => {
  const hypotheses = [
    makeHypothesis({
      id: 'hyp:empty',
      supporting: [],
    }),
    makeHypothesis({
      id: 'hyp:well-supported',
      supporting: [specificLogEvidence, specificK8sEvidence],
      contradicting: [],
    }),
    makeHypothesis({
      id: 'hyp:contradicted',
      supporting: [specificLogEvidence],
      contradicting: [contradictingEvidence, contradictingEvidence2],
    }),
  ];

  const ranked = rankHypotheses(hypotheses);

  it('well-supported hypothesis ranks above empty and contradicted ones', () => {
    expect(ranked[0]!.id).toBe('hyp:well-supported');
  });

  it('empty hypothesis ranks last (or tied last)', () => {
    const lastId = ranked[ranked.length - 1]!.id;
    // Either 'hyp:empty' or 'hyp:contradicted' could be last; both score low
    expect(['hyp:empty', 'hyp:contradicted']).toContain(lastId);
  });

  it('rationale for well-supported hypothesis mentions supporting count', () => {
    const wellSupported = ranked.find((h) => h.id === 'hyp:well-supported')!;
    expect(wellSupported.confidenceRationale).toMatch(/2/);
  });

  it('rationale for contradicted hypothesis mentions contradicting items', () => {
    const contradicted = ranked.find((h) => h.id === 'hyp:contradicted')!;
    expect(contradicted.confidenceRationale.toLowerCase()).toMatch(/contradict/);
  });

  it('rationale for empty hypothesis mentions no supporting evidence', () => {
    const empty = ranked.find((h) => h.id === 'hyp:empty')!;
    expect(empty.confidenceRationale.toLowerCase()).toMatch(/no supporting/);
  });
});

// ---------------------------------------------------------------------------
// Calibration gate — monotonicity, bounds, penalties, and scenario ranking
// ---------------------------------------------------------------------------

describe('calibration', () => {
  describe('monotonicity invariant', () => {
    it('strictly increases as evidence quality improves step-by-step', () => {
      const score0 = scoreHypothesis(makeHypothesis({ category: 'missing-secret', supporting: [] }));
      const score1 = scoreHypothesis(
        makeHypothesis({ category: 'missing-secret', supporting: [genericK8sEvidence] }),
      );
      const score2 = scoreHypothesis(
        makeHypothesis({ category: 'missing-secret', supporting: [specificEventEvidence] }),
      );
      const score3 = scoreHypothesis(
        makeHypothesis({
          category: 'missing-secret',
          supporting: [specificEventEvidence, specificMissingSecretK8sEvidence],
        }),
      );
      const score4 = scoreHypothesis(
        makeHypothesis({
          category: 'missing-secret',
          supporting: [
            specificEventEvidence,
            specificMissingSecretK8sEvidence,
            specificMissingSecretLogEvidence,
          ],
        }),
      );

      const scores = [score0, score1, score2, score3, score4];
      for (let i = 1; i < scores.length; i += 1) {
        expect(scores[i]!).toBeGreaterThan(scores[i - 1]!);
      }
    });
  });

  describe('confidence band boundaries', () => {
    it('scores 0.0 when no evidence is present', () => {
      expect(scoreHypothesis(makeHypothesis())).toBe(0.0);
    });

    it('caps generic-only evidence at 0.50 or below', () => {
      const score = scoreHypothesis(
        makeHypothesis({
          supporting: [
            genericK8sEvidence,
            genericK8sEvidence2,
            genericK8sEvidence3,
            genericK8sEvidence4,
          ],
        }),
      );
      expect(score).toBeLessThanOrEqual(0.5);
    });

    it('caps maximum evidence score at 1.0', () => {
      const score = scoreHypothesis(
        makeHypothesis({
          category: 'dns-failure',
          supporting: [
            specificLogEvidence,
            {
              path: 'cluster-resources/services/default.json',
              note:
                "Service 'db' exists in namespace 'staging' (not 'default' as referenced). Did you mean to reference 'db.staging.svc.cluster.local'?",
              artifactType: 'kubernetes-resource',
            },
            {
              path: 'cluster-resources/events/default.json',
              note: "Event indicates DNS-related failure for 'app-pod': lookup db: no such host",
              artifactType: 'event',
            },
            {
              path: 'logs/default/app-pod/app/retry.log',
              note: 'Log line shows DNS resolution failure: "lookup db: no such host"',
              artifactType: 'log',
            },
          ],
        }),
      );
      expect(score).toBeLessThanOrEqual(1.0);
    });
  });

  describe('penalties', () => {
    it('contradicting evidence lowers the score', () => {
      const withoutContradiction = scoreHypothesis(
        makeHypothesis({
          category: 'dns-failure',
          supporting: [specificLogEvidence, specificEventEvidence],
        }),
      );
      const withContradiction = scoreHypothesis(
        makeHypothesis({
          category: 'dns-failure',
          supporting: [specificLogEvidence, specificEventEvidence],
          contradicting: [contradictingEvidence],
        }),
      );

      expect(withContradiction).toBeLessThan(withoutContradiction);
    });

    it('missing decisive evidence lowers the score', () => {
      const withoutMissing = scoreHypothesis(
        makeHypothesis({
          category: 'dns-failure',
          supporting: [specificLogEvidence, specificEventEvidence],
        }),
      );
      const withMissing = scoreHypothesis(
        makeHypothesis({
          category: 'dns-failure',
          supporting: [specificLogEvidence, specificEventEvidence],
          missingDecisive: ['CoreDNS logs'],
        }),
      );

      expect(withMissing).toBeLessThan(withoutMissing);
    });
  });

  describe('cross-scenario calibration ranking', () => {
    it.each([
      {
        scenario: 'wrong-db-endpoint',
        expectedTopCategory: 'dns-failure' as const,
        hypotheses: [
          makeHypothesis({
            id: 'dns',
            category: 'dns-failure',
            supporting: [
              specificLogEvidence,
              {
                path: 'cluster-resources/services/default.json',
                note: "Dependency hostname maps to missing Service 'db' in namespace 'default'",
                artifactType: 'kubernetes-resource',
              },
            ],
          }),
          makeHypothesis({
            id: 'bad-endpoint',
            category: 'bad-db-endpoint',
            supporting: [
              {
                path: 'cluster-resources/pods/default/app-pod.yaml',
                note: 'Pod references database host value "db" in DB_HOST',
                artifactType: 'kubernetes-resource',
              },
            ],
          }),
          makeHypothesis({
            id: 'connectivity',
            category: 'connectivity-failure',
            supporting: [specificLogEvidence2],
          }),
        ],
      },
      {
        scenario: 'missing-secret-crashloop',
        expectedTopCategory: 'missing-secret' as const,
        hypotheses: [
          makeHypothesis({
            id: 'missing-secret',
            category: 'missing-secret',
            supporting: [specificEventEvidence, specificMissingSecretK8sEvidence],
          }),
          makeHypothesis({
            id: 'config-error',
            category: 'config-error',
            supporting: [
              {
                path: 'cluster-resources/pods/default/app-pod.yaml',
                note: 'Configuration error suspected from startup failure',
                artifactType: 'kubernetes-resource',
              },
            ],
          }),
          makeHypothesis({
            id: 'generic-crash',
            category: 'generic-crash',
            supporting: [genericK8sEvidence],
          }),
        ],
      },
      {
        scenario: 'bad-image-tag',
        expectedTopCategory: 'image-pull-failure' as const,
        hypotheses: [
          makeHypothesis({
            id: 'image-pull',
            category: 'image-pull-failure',
            supporting: [specificImagePullEventEvidence, specificImagePullK8sEvidence],
          }),
          makeHypothesis({
            id: 'connectivity',
            category: 'connectivity-failure',
            supporting: [
              {
                path: 'logs/default/api.log',
                note: 'Log line shows connection failure: "ERROR connection refused to registry.local:443"',
                artifactType: 'log',
              },
            ],
          }),
          makeHypothesis({
            id: 'config-error',
            category: 'config-error',
            supporting: [genericK8sEvidence2],
          }),
        ],
      },
      {
        scenario: 'pvc-pending',
        expectedTopCategory: 'volume-mount-failure' as const,
        hypotheses: [
          makeHypothesis({
            id: 'volume-mount',
            category: 'volume-mount-failure',
            supporting: [specificVolumeMountEvidence, specificPvcProvisioningEvidence],
          }),
          makeHypothesis({
            id: 'missing-service',
            category: 'missing-service',
            supporting: [
              {
                path: 'cluster-resources/services/default.json',
                note: "Dependency hostname maps to missing Service 'db' in namespace 'default'",
                artifactType: 'kubernetes-resource',
              },
            ],
          }),
          makeHypothesis({
            id: 'generic-crash',
            category: 'generic-crash',
            supporting: [genericK8sEvidence3],
          }),
        ],
      },
    ])('ranks $expectedTopCategory highest for $scenario', ({ expectedTopCategory, hypotheses }) => {
      const ranked = rankHypotheses(hypotheses);
      expect(ranked[0]!.category).toBe(expectedTopCategory);
    });
  });
});
