import { describe, it, expect } from 'vitest';
import type { Finding, FindingSeverity } from '../../types/index.js';
import type { BundleProfile } from '../../types/index.js';
import { generateSpecRecommendations } from '../spec-recommender.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeProfile(overrides: Partial<BundleProfile> = {}): BundleProfile {
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
    ...overrides,
  };
}

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'finding:test:0',
    title: 'Test Finding',
    severity: 'high' as FindingSeverity,
    confidence: 0.75,
    affectedComponents: [],
    reasoningSummary: 'Test reasoning.',
    evidence: [],
    contradictionsChecked: [],
    recommendedAction: 'Take action.',
    missingEvidence: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Section 1: Empty inputs
// ---------------------------------------------------------------------------

describe('generateSpecRecommendations — empty inputs', () => {
  it('returns empty array when there are no findings and no coverage gaps', () => {
    const result = generateSpecRecommendations([], makeProfile());
    expect(result).toHaveLength(0);
  });

  it('returns empty array when findings have no missing evidence and profile has no coverage gaps', () => {
    const finding = makeFinding({
      title: 'CrashLoopBackOff: Pod app-pod',
      missingEvidence: [],
    });
    const result = generateSpecRecommendations([finding], makeProfile());
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Section 2: Collector suggestions from missing evidence
// ---------------------------------------------------------------------------

describe('generateSpecRecommendations — collector: missing logs', () => {
  it('suggests a logs collector when a finding has missing log evidence', () => {
    const finding = makeFinding({
      id: 'finding:k8s:crashloop:0',
      title: "CrashLoopBackOff: Pod 'app-pod' in namespace 'default'",
      missingEvidence: [
        "Container log files for pod 'app-pod' in namespace 'default' — needed to determine the root crash reason",
      ],
    });
    const result = generateSpecRecommendations([finding], makeProfile());

    const logRec = result.find((r) => r.type === 'collector' && r.description.toLowerCase().includes('log'));
    expect(logRec).toBeDefined();
  });

  it('log collector recommendation rationale references the finding title', () => {
    const finding = makeFinding({
      title: "CrashLoopBackOff: Pod 'app-pod' in namespace 'default'",
      missingEvidence: [
        "Container log files for pod 'app-pod' — needed to determine the root crash reason",
      ],
    });
    const result = generateSpecRecommendations([finding], makeProfile());
    const logRec = result.find((r) => r.type === 'collector' && r.description.toLowerCase().includes('log'));

    expect(logRec?.rationale).toContain("CrashLoopBackOff");
  });

  it('does not produce a log-collector recommendation when no missing-evidence mentions logs', () => {
    const finding = makeFinding({
      missingEvidence: ['Kubernetes events for pod X'],
    });
    const result = generateSpecRecommendations([finding], makeProfile());
    const logRec = result.find((r) => r.type === 'collector' && r.description.toLowerCase().includes('logs collector'));
    expect(logRec).toBeUndefined();
  });
});

describe('generateSpecRecommendations — collector: missing events', () => {
  it('suggests an events collector when a finding has missing event evidence', () => {
    const finding = makeFinding({
      title: "Not Ready Pod: 'app-pod' in namespace 'default'",
      missingEvidence: ["Kubernetes events for pod 'app-pod' in namespace 'default'"],
    });
    const result = generateSpecRecommendations([finding], makeProfile());

    const eventsRec = result.find((r) => r.type === 'collector' && r.description.toLowerCase().includes('event'));
    expect(eventsRec).toBeDefined();
  });

  it('events collector recommendation rationale references the finding title', () => {
    const finding = makeFinding({
      title: "Not Ready Pod: 'app-pod'",
      missingEvidence: ["Kubernetes events for pod 'app-pod'"],
    });
    const result = generateSpecRecommendations([finding], makeProfile());
    const eventsRec = result.find((r) => r.type === 'collector' && r.description.toLowerCase().includes('event'));

    expect(eventsRec?.rationale).toContain("Not Ready Pod");
  });
});

describe('generateSpecRecommendations — collector: missing secret metadata', () => {
  it('suggests a secrets collector when missing evidence mentions secret', () => {
    const finding = makeFinding({
      title: "Missing Secret: Pod references non-existent secret",
      missingEvidence: ["Secret metadata for 'app-credentials' in namespace 'default'"],
    });
    const result = generateSpecRecommendations([finding], makeProfile());

    const secretRec = result.find((r) => r.type === 'collector' && r.description.toLowerCase().includes('secret'));
    expect(secretRec).toBeDefined();
  });

  it('secrets collector recommendation includes redaction guidance', () => {
    const finding = makeFinding({
      missingEvidence: ["Secret metadata for 'app-credentials'"],
    });
    const result = generateSpecRecommendations([finding], makeProfile());
    const secretRec = result.find((r) => r.type === 'collector' && r.description.toLowerCase().includes('secret'));

    expect(secretRec?.description.toLowerCase()).toContain('redact');
  });
});

// ---------------------------------------------------------------------------
// Section 3: Deduplication of collector suggestions
// ---------------------------------------------------------------------------

describe('generateSpecRecommendations — deduplication of collector recommendations', () => {
  it('does not produce duplicate log-collector recommendations for multiple findings', () => {
    const findings = [
      makeFinding({
        id: 'finding:k8s:crashloop:0',
        title: "CrashLoopBackOff: Pod 'pod-a'",
        missingEvidence: ["Container log files for pod 'pod-a'"],
      }),
      makeFinding({
        id: 'finding:k8s:crashloop:1',
        title: "CrashLoopBackOff: Pod 'pod-b'",
        missingEvidence: ["Container log files for pod 'pod-b'"],
      }),
    ];
    const result = generateSpecRecommendations(findings, makeProfile());
    const logRecs = result.filter((r) => r.type === 'collector' && r.description.toLowerCase().includes('logs'));
    expect(logRecs).toHaveLength(1);
  });

  it('does not duplicate events-collector for multiple findings with missing events', () => {
    const findings = [
      makeFinding({ missingEvidence: ["Kubernetes events for pod 'pod-a'"] }),
      makeFinding({ missingEvidence: ["Kubernetes events for pod 'pod-b'"] }),
    ];
    const result = generateSpecRecommendations(findings, makeProfile());
    const eventRecs = result.filter((r) => r.type === 'collector' && r.description.toLowerCase().includes('event'));
    expect(eventRecs).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Section 4: Analyzer suggestions from heuristic findings
// ---------------------------------------------------------------------------

describe('generateSpecRecommendations — analyzer: secret-existence', () => {
  it('suggests a secret-existence analyzer for a missing-secret finding', () => {
    const finding = makeFinding({
      title: "Missing Secret: Pod 'app-pod' references non-existent secret(s) in namespace 'default'",
      reasoningSummary: 'Pod spec references secret app-credentials which does not exist.',
    });
    const result = generateSpecRecommendations([finding], makeProfile());

    const analyzerRec = result.find(
      (r) => r.type === 'analyzer' && r.description.toLowerCase().includes('secret'),
    );
    expect(analyzerRec).toBeDefined();
  });

  it('secret-existence analyzer rationale references the triggering finding', () => {
    const finding = makeFinding({
      title: "Missing Secret: Pod 'app-pod' references non-existent secret(s)",
      reasoningSummary: 'Pod spec references secret that does not exist.',
    });
    const result = generateSpecRecommendations([finding], makeProfile());
    const analyzerRec = result.find(
      (r) => r.type === 'analyzer' && r.description.toLowerCase().includes('secret'),
    );
    expect(analyzerRec?.rationale).toContain('Missing Secret');
  });

  it('does not suggest secret-existence analyzer for unrelated findings', () => {
    const finding = makeFinding({
      title: "DNS Resolution Failures in pods/app.log",
      reasoningSummary: 'Log file contains repeated NXDOMAIN errors for db.internal.',
    });
    const result = generateSpecRecommendations([finding], makeProfile());
    const analyzerRec = result.find(
      (r) => r.type === 'analyzer' && r.description.toLowerCase().includes('secret'),
    );
    expect(analyzerRec).toBeUndefined();
  });
});

describe('generateSpecRecommendations — analyzer: imageTag', () => {
  it('suggests an imageTag analyzer for an ImagePullBackOff finding', () => {
    const finding = makeFinding({
      title: "ImagePullBackOff: Pod 'app-pod' in namespace 'default' (image: myapp:v999)",
      reasoningSummary: 'Container is stuck in ImagePullBackOff. Image myapp:v999 could not be pulled.',
    });
    const result = generateSpecRecommendations([finding], makeProfile());

    const analyzerRec = result.find(
      (r) => r.type === 'analyzer' && r.description.toLowerCase().includes('image'),
    );
    expect(analyzerRec).toBeDefined();
  });

  it('suggests an imageTag analyzer for an image tag mismatch finding', () => {
    const finding = makeFinding({
      title: "Image Tag Mismatch: Container 'app' in pod 'app-pod'",
      reasoningSummary: 'Spec image myapp:v2 differs from running image myapp:v1.',
    });
    const result = generateSpecRecommendations([finding], makeProfile());

    const analyzerRec = result.find(
      (r) => r.type === 'analyzer' && r.description.toLowerCase().includes('image'),
    );
    expect(analyzerRec).toBeDefined();
  });
});

describe('generateSpecRecommendations — analyzer: serviceAvailability', () => {
  it('suggests a serviceAvailability analyzer for a missing-service finding', () => {
    const finding = makeFinding({
      title: "Missing Service: Environment variable DB_HOST references unknown service 'db'",
      reasoningSummary: 'Pod env var DB_HOST=db.default.svc.cluster.local but no Service named db exists.',
    });
    const result = generateSpecRecommendations([finding], makeProfile());

    const analyzerRec = result.find(
      (r) => r.type === 'analyzer' && r.description.toLowerCase().includes('service'),
    );
    expect(analyzerRec).toBeDefined();
  });

  it('suggests a serviceAvailability analyzer for actual Missing Service Reference findings from the config investigator', () => {
    const finding = makeFinding({
      title: "Missing Service Reference: Pod 'api-pod' env var(s) reference non-existent service(s)",
      reasoningSummary:
        "Pod 'api-pod' in namespace 'default' has environment variable(s) whose values reference in-cluster service name(s) 'db', but no matching Service resource(s) were found in the referenced namespace(s).",
    });
    const result = generateSpecRecommendations([finding], makeProfile());

    const analyzerRec = result.find(
      (r) => r.type === 'analyzer' && r.description.toLowerCase().includes('serviceavailability'),
    );
    expect(analyzerRec).toBeDefined();
  });
});

describe('generateSpecRecommendations — analyzer: deduplication', () => {
  it('does not produce duplicate analyzer recommendations for multiple similar findings', () => {
    const findings = [
      makeFinding({
        id: 'f1',
        title: "Missing Secret: Pod 'pod-a' references non-existent secret(s)",
      }),
      makeFinding({
        id: 'f2',
        title: "Missing Secret: Pod 'pod-b' references non-existent secret(s)",
      }),
    ];
    const result = generateSpecRecommendations(findings, makeProfile());
    const secretAnalyzerRecs = result.filter(
      (r) => r.type === 'analyzer' && r.description.toLowerCase().includes('secret'),
    );
    expect(secretAnalyzerRecs).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Section 5: Coverage-gap-based recommendations
// ---------------------------------------------------------------------------

describe('generateSpecRecommendations — coverage gaps: no logs', () => {
  it('suggests a logs collector when profile has a no-logs coverage gap', () => {
    const profile = makeProfile({ coverageGaps: ['no log files found in bundle'] });
    const result = generateSpecRecommendations([], profile);

    const logRec = result.find((r) => r.type === 'collector' && r.description.toLowerCase().includes('log'));
    expect(logRec).toBeDefined();
  });

  it('log-coverage rationale references the gap description', () => {
    const profile = makeProfile({ coverageGaps: ['no log files found in bundle'] });
    const result = generateSpecRecommendations([], profile);
    const logRec = result.find((r) => r.type === 'collector' && r.description.toLowerCase().includes('log'));

    expect(logRec?.rationale).toContain('no log files found');
  });
});

describe('generateSpecRecommendations — coverage gaps: no events', () => {
  it('suggests an events collector when profile reports missing events', () => {
    const profile = makeProfile({ coverageGaps: ['no kubernetes events in bundle'] });
    const result = generateSpecRecommendations([], profile);

    const eventsRec = result.find((r) => r.type === 'collector' && r.description.toLowerCase().includes('event'));
    expect(eventsRec).toBeDefined();
  });
});

describe('generateSpecRecommendations — coverage gaps: no analyzers', () => {
  it('suggests adding analyzers when profile reports missing analyzer output', () => {
    const profile = makeProfile({ coverageGaps: ['no analyzer results found'] });
    const result = generateSpecRecommendations([], profile);

    const analyzerRec = result.find((r) => r.type === 'analyzer');
    expect(analyzerRec).toBeDefined();
  });
});

describe('generateSpecRecommendations — coverage gaps: no helm metadata', () => {
  it('suggests a helm collector when profile reports missing helm data', () => {
    const profile = makeProfile({ coverageGaps: ['no helm release metadata found'] });
    const result = generateSpecRecommendations([], profile);

    const helmRec = result.find((r) => r.type === 'collector' && r.description.toLowerCase().includes('helm'));
    expect(helmRec).toBeDefined();
  });
});

describe('generateSpecRecommendations — coverage gaps: redaction', () => {
  it('suggests a redaction rule when profile reports sensitive-data coverage gap', () => {
    const profile = makeProfile({
      coverageGaps: ['bundle may contain sensitive secret values without redaction'],
    });
    const result = generateSpecRecommendations([], profile);

    const redactionRec = result.find((r) => r.type === 'redaction');
    expect(redactionRec).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Section 6: Result ordering
// ---------------------------------------------------------------------------

describe('generateSpecRecommendations — result ordering', () => {
  it('returns collector recommendations before analyzer recommendations before redaction', () => {
    const findings = [
      makeFinding({
        title: "Missing Secret: Pod 'app-pod' references non-existent secret(s)",
        missingEvidence: ["Container log files for pod 'app-pod'"],
      }),
    ];
    const profile = makeProfile({
      coverageGaps: ['bundle may contain sensitive secret values without redaction'],
    });

    const result = generateSpecRecommendations(findings, profile);
    const types = result.map((r) => r.type);

    // Collectors must appear before analyzers, analyzers before redaction
    const firstAnalyzer = types.indexOf('analyzer');
    const firstRedaction = types.indexOf('redaction');
    const lastCollector = types.lastIndexOf('collector');

    if (firstAnalyzer !== -1 && lastCollector !== -1) {
      expect(lastCollector).toBeLessThan(firstAnalyzer);
    }
    if (firstRedaction !== -1 && firstAnalyzer !== -1) {
      expect(firstAnalyzer).toBeLessThan(firstRedaction);
    }
  });
});

// ---------------------------------------------------------------------------
// Section 7: Combined findings + profile
// ---------------------------------------------------------------------------

describe('generateSpecRecommendations — combined findings and profile gaps', () => {
  it('merges recommendations from both findings and profile without duplication', () => {
    // Both the finding and the profile gap point to missing logs.
    // Only one logs collector recommendation should be produced.
    const findings = [
      makeFinding({
        title: "CrashLoopBackOff: Pod 'app-pod'",
        missingEvidence: ["Container log files for pod 'app-pod'"],
      }),
    ];
    const profile = makeProfile({ coverageGaps: ['no log files found in bundle'] });

    const result = generateSpecRecommendations(findings, profile);
    const logRecs = result.filter((r) => r.type === 'collector' && r.description.toLowerCase().includes('log'));
    expect(logRecs).toHaveLength(1);
  });

  it('returns all three types when appropriate', () => {
    const findings = [
      makeFinding({
        title: "Missing Secret: Pod 'app-pod' references non-existent secret(s)",
        missingEvidence: ["Container log files for pod 'app-pod'"],
      }),
    ];
    const profile = makeProfile({
      coverageGaps: ['bundle may contain sensitive secret values without redaction'],
    });

    const result = generateSpecRecommendations(findings, profile);
    const types = new Set(result.map((r) => r.type));

    expect(types.has('collector')).toBe(true);
    expect(types.has('analyzer')).toBe(true);
    expect(types.has('redaction')).toBe(true);
  });

  it('all returned recommendations have non-empty description and rationale', () => {
    const findings = [
      makeFinding({
        title: "Missing Secret: Pod 'app-pod' references non-existent secret(s)",
        missingEvidence: ["Container log files for pod 'app-pod'", "Kubernetes events for pod 'app-pod'"],
      }),
    ];
    const profile = makeProfile({
      coverageGaps: ['no log files found in bundle', 'no kubernetes events in bundle'],
    });

    const result = generateSpecRecommendations(findings, profile);
    for (const rec of result) {
      expect(rec.description.trim().length).toBeGreaterThan(0);
      expect(rec.rationale.trim().length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Section 8: Recommendation structure
// ---------------------------------------------------------------------------

describe('generateSpecRecommendations — recommendation structure', () => {
  it('all recommendations have a valid type field', () => {
    const findings = [
      makeFinding({
        title: "Missing Secret: Pod 'app-pod' references non-existent secret(s)",
        missingEvidence: ["Container log files for pod 'app-pod'"],
      }),
    ];
    const profile = makeProfile({
      coverageGaps: ['bundle may contain sensitive secret values without redaction'],
    });

    const result = generateSpecRecommendations(findings, profile);
    const validTypes = new Set(['collector', 'analyzer', 'redaction']);
    for (const rec of result) {
      expect(validTypes.has(rec.type)).toBe(true);
    }
  });

  it('returns an array (never null or undefined)', () => {
    const result = generateSpecRecommendations([], makeProfile());
    expect(Array.isArray(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Section 9: Hypothesis-layer evidence gaps
// ---------------------------------------------------------------------------

describe('generateSpecRecommendations — hypothesis gaps: CoreDNS logs', () => {
  it('recommends CoreDNS log collector when hypothesis finding has missing CoreDNS logs', () => {
    const finding = makeFinding({
      id: 'finding:hypothesis:dns-failure:1',
      title: '[Hypothesis] DNS resolution failure (symptom: pod crashloop)',
      missingEvidence: [
        'CoreDNS or kube-dns pod logs would decisively confirm DNS resolution failures cluster-wide',
      ],
    });
    const result = generateSpecRecommendations([finding], makeProfile());

    const coreDnsRec = result.find(
      (r) => r.type === 'collector' && r.description.toLowerCase().includes('coredns'),
    );
    expect(coreDnsRec).toBeDefined();
  });

  it('CoreDNS recommendation description mentions kube-system namespace', () => {
    const finding = makeFinding({
      id: 'finding:hypothesis:dns-failure:1',
      title: '[Hypothesis] DNS lookup failure',
      missingEvidence: [
        'CoreDNS or kube-dns pod logs would decisively confirm DNS resolution failures cluster-wide',
      ],
    });
    const result = generateSpecRecommendations([finding], makeProfile());

    const coreDnsRec = result.find(
      (r) => r.type === 'collector' && r.description.toLowerCase().includes('coredns'),
    );
    expect(coreDnsRec?.description.toLowerCase()).toContain('kube-system');
  });

  it('CoreDNS recommendation rationale references the finding title', () => {
    const finding = makeFinding({
      id: 'finding:hypothesis:dns-failure:1',
      title: '[Hypothesis] DNS lookup failure for db.internal',
      missingEvidence: [
        'CoreDNS or kube-dns pod logs would decisively confirm DNS resolution failures cluster-wide',
      ],
    });
    const result = generateSpecRecommendations([finding], makeProfile());

    const coreDnsRec = result.find(
      (r) => r.type === 'collector' && r.description.toLowerCase().includes('coredns'),
    );
    expect(coreDnsRec?.rationale).toContain('[Hypothesis] DNS lookup failure for db.internal');
  });

  it('does not recommend CoreDNS collector for non-hypothesis findings with same text', () => {
    // Non-hypothesis finding (no 'finding:hypothesis:' prefix) should NOT trigger the CoreDNS rec
    const finding = makeFinding({
      id: 'finding:log:dns:1',
      title: 'DNS Resolution Failures in pods/app.log',
      missingEvidence: [
        'CoreDNS or kube-dns pod logs would decisively confirm DNS resolution failures cluster-wide',
      ],
    });
    const result = generateSpecRecommendations([finding], makeProfile());

    const coreDnsRec = result.find(
      (r) => r.type === 'collector' && r.description.toLowerCase().includes('coredns'),
    );
    expect(coreDnsRec).toBeUndefined();
  });

  it('does not produce duplicate CoreDNS recommendations for multiple hypothesis findings', () => {
    const findings = [
      makeFinding({
        id: 'finding:hypothesis:dns-failure:1',
        title: '[Hypothesis] DNS failure A',
        // Use a wide confidence gap so disambiguation is not triggered
        confidence: 0.9,
        missingEvidence: ['CoreDNS or kube-dns pod logs would confirm DNS resolution failures'],
      }),
      makeFinding({
        id: 'finding:hypothesis:dns-failure:2',
        title: '[Hypothesis] DNS failure B',
        confidence: 0.5,
        missingEvidence: ['CoreDNS or kube-dns pod logs would confirm DNS resolution failures'],
      }),
    ];
    const result = generateSpecRecommendations(findings, makeProfile());

    // Only the specific CoreDNS log collector — not the disambiguation rec
    const coreDnsRecs = result.filter(
      (r) =>
        r.type === 'collector' &&
        r.description.toLowerCase().includes('coredns') &&
        !r.description.includes('distinguish'),
    );
    expect(coreDnsRecs).toHaveLength(1);
  });
});

describe('generateSpecRecommendations — hypothesis gaps: NetworkPolicy', () => {
  it('recommends clusterResources collector with NetworkPolicy when hypothesis finding has missing network policy data', () => {
    const finding = makeFinding({
      id: 'finding:hypothesis:connectivity-failure:1',
      title: '[Hypothesis] Network connectivity failure between api and db',
      missingEvidence: [
        'NetworkPolicy resources and Endpoints data would confirm whether the network path is blocked or service backends are absent',
      ],
    });
    const result = generateSpecRecommendations([finding], makeProfile());

    const networkPolicyRec = result.find(
      (r) => r.type === 'collector' && r.description.toLowerCase().includes('networkpolic'),
    );
    expect(networkPolicyRec).toBeDefined();
  });

  it('NetworkPolicy recommendation description mentions networkpolicies resource type', () => {
    const finding = makeFinding({
      id: 'finding:hypothesis:connectivity-failure:1',
      title: '[Hypothesis] Network connectivity blocked',
      missingEvidence: [
        'NetworkPolicy resources and Endpoints data would confirm whether the network path is blocked',
      ],
    });
    const result = generateSpecRecommendations([finding], makeProfile());

    const networkPolicyRec = result.find(
      (r) => r.type === 'collector' && r.description.toLowerCase().includes('networkpolic'),
    );
    expect(networkPolicyRec?.description.toLowerCase()).toContain('networkpolicies');
  });

  it('NetworkPolicy recommendation rationale references the finding title', () => {
    const finding = makeFinding({
      id: 'finding:hypothesis:connectivity-failure:1',
      title: '[Hypothesis] Connectivity failure from api-pod to db-service',
      missingEvidence: [
        'NetworkPolicy resources and Endpoints data would confirm whether the network path is blocked',
      ],
    });
    const result = generateSpecRecommendations([finding], makeProfile());

    const networkPolicyRec = result.find(
      (r) => r.type === 'collector' && r.description.toLowerCase().includes('networkpolic'),
    );
    expect(networkPolicyRec?.rationale).toContain(
      '[Hypothesis] Connectivity failure from api-pod to db-service',
    );
  });

  it('does not produce duplicate NetworkPolicy recommendations for multiple hypothesis findings', () => {
    const findings = [
      makeFinding({
        id: 'finding:hypothesis:connectivity-failure:1',
        title: '[Hypothesis] Connectivity failure A',
        // Use a wide confidence gap so disambiguation is not triggered
        confidence: 0.9,
        missingEvidence: ['NetworkPolicy resources and Endpoints data would confirm the network path'],
      }),
      makeFinding({
        id: 'finding:hypothesis:connectivity-failure:2',
        title: '[Hypothesis] Connectivity failure B',
        confidence: 0.5,
        missingEvidence: ['NetworkPolicy resources and Endpoints data would confirm the network path'],
      }),
    ];
    const result = generateSpecRecommendations(findings, makeProfile());

    // Only the specific NetworkPolicy collector — not the disambiguation rec
    const networkPolicyRecs = result.filter(
      (r) =>
        r.type === 'collector' &&
        r.description.toLowerCase().includes('networkpolic') &&
        !r.description.includes('distinguish'),
    );
    expect(networkPolicyRecs).toHaveLength(1);
  });
});

describe('generateSpecRecommendations — hypothesis gaps: close-confidence disambiguation', () => {
  it('recommends distinguishing evidence when top two hypothesis findings are within 0.15 confidence', () => {
    const findings = [
      makeFinding({
        id: 'finding:hypothesis:dns-failure:1',
        title: '[Hypothesis] DNS resolution failure',
        confidence: 0.65,
        missingEvidence: [
          'Pod application logs showing DNS lookup failures would confirm this hypothesis',
        ],
      }),
      makeFinding({
        id: 'finding:hypothesis:connectivity-failure:2',
        title: '[Hypothesis] Network connectivity failure',
        confidence: 0.55,
        missingEvidence: [
          'NetworkPolicy resources and Endpoints data would confirm whether the network path is blocked',
        ],
      }),
    ];
    const result = generateSpecRecommendations(findings, makeProfile());

    // Should have a recommendation that mentions both hypotheses or distinguishing evidence
    const disambiguationRec = result.find(
      (r) =>
        r.type === 'collector' &&
        (r.description.includes('distinguish') || r.rationale.includes('close confidence') || r.rationale.includes('ambiguity')),
    );
    expect(disambiguationRec).toBeDefined();
  });

  it('disambiguation recommendation mentions both competing hypotheses', () => {
    const findings = [
      makeFinding({
        id: 'finding:hypothesis:dns-failure:1',
        title: '[Hypothesis] DNS resolution failure for db.internal',
        confidence: 0.70,
        missingEvidence: ['Pod logs showing DNS lookup failures would confirm this hypothesis'],
      }),
      makeFinding({
        id: 'finding:hypothesis:missing-secret:2',
        title: '[Hypothesis] Missing Kubernetes Secret for db credentials',
        confidence: 0.60,
        missingEvidence: ['Pod application logs showing a secret or credential error at startup'],
      }),
    ];
    const result = generateSpecRecommendations(findings, makeProfile());

    const disambiguationRec = result.find(
      (r) => r.type === 'collector' && r.description.includes('distinguish'),
    );
    expect(disambiguationRec?.description).toContain('[Hypothesis] DNS resolution failure');
    expect(disambiguationRec?.description).toContain('[Hypothesis] Missing Kubernetes Secret');
  });

  it('disambiguation recommendation rationale mentions the confidence percentages', () => {
    const findings = [
      makeFinding({
        id: 'finding:hypothesis:dns-failure:1',
        title: '[Hypothesis] DNS resolution failure',
        confidence: 0.72,
        missingEvidence: ['Pod logs showing DNS lookup failures'],
      }),
      makeFinding({
        id: 'finding:hypothesis:connectivity-failure:2',
        title: '[Hypothesis] Network connectivity failure',
        confidence: 0.60,
        missingEvidence: ['NetworkPolicy resources would confirm the network path'],
      }),
    ];
    const result = generateSpecRecommendations(findings, makeProfile());

    const disambiguationRec = result.find(
      (r) => r.type === 'collector' && r.rationale.includes('ambiguity'),
    );
    expect(disambiguationRec?.rationale).toContain('72%');
    expect(disambiguationRec?.rationale).toContain('60%');
  });

  it('prefers evidence unique to one hypothesis when suggesting disambiguation data', () => {
    const findings = [
      makeFinding({
        id: 'finding:hypothesis:dns-failure:1',
        title: '[Hypothesis] DNS resolution failure',
        confidence: 0.69,
        missingEvidence: [
          'Shared pod logs from the crashing container',
          'CoreDNS or kube-dns pod logs would decisively confirm DNS resolution failures cluster-wide',
        ],
      }),
      makeFinding({
        id: 'finding:hypothesis:connectivity-failure:2',
        title: '[Hypothesis] Network connectivity failure',
        confidence: 0.60,
        missingEvidence: [
          'Shared pod logs from the crashing container',
          'NetworkPolicy resources and Endpoints data would confirm whether the network path is blocked',
        ],
      }),
    ];
    const result = generateSpecRecommendations(findings, makeProfile());

    const disambiguationRec = result.find(
      (r) => r.type === 'collector' && r.description.includes('distinguish'),
    );
    expect(disambiguationRec?.description).not.toContain('Shared pod logs from the crashing container');
    expect(disambiguationRec?.description).toMatch(/CoreDNS|NetworkPolicy/);
  });

  it('does not compare close-confidence hypotheses from different symptoms', () => {
    const findings = [
      makeFinding({
        id: 'finding:hypothesis:dns-failure:1',
        title:
          "[Hypothesis] DNS resolution failure (symptom: Pod 'api-0' is in CrashLoopBackOff in namespace 'default')",
        confidence: 0.66,
        missingEvidence: ['CoreDNS or kube-dns pod logs would decisively confirm DNS resolution failures'],
      }),
      makeFinding({
        id: 'finding:hypothesis:missing-secret:2',
        title:
          "[Hypothesis] Missing Secret (symptom: Pod 'worker-0' is in CrashLoopBackOff in namespace 'default')",
        confidence: 0.58,
        missingEvidence: ['Pod application logs showing a secret or credential error at startup'],
      }),
    ];
    const result = generateSpecRecommendations(findings, makeProfile());

    const disambiguationRec = result.find(
      (r) => r.type === 'collector' && r.description.includes('distinguish'),
    );
    expect(disambiguationRec).toBeUndefined();
  });

  it('does not produce disambiguation recommendation when top hypothesis is clearly higher confidence (> 0.15 gap)', () => {
    const findings = [
      makeFinding({
        id: 'finding:hypothesis:dns-failure:1',
        title: '[Hypothesis] DNS resolution failure',
        confidence: 0.85,
        missingEvidence: ['Pod logs showing DNS lookup failures'],
      }),
      makeFinding({
        id: 'finding:hypothesis:connectivity-failure:2',
        title: '[Hypothesis] Network connectivity failure',
        confidence: 0.55,
        missingEvidence: ['NetworkPolicy resources would confirm the network path'],
      }),
    ];
    const result = generateSpecRecommendations(findings, makeProfile());

    const disambiguationRec = result.find(
      (r) => r.type === 'collector' && r.description.includes('distinguish'),
    );
    expect(disambiguationRec).toBeUndefined();
  });

  it('does not produce disambiguation recommendation when there is only one hypothesis finding', () => {
    const finding = makeFinding({
      id: 'finding:hypothesis:dns-failure:1',
      title: '[Hypothesis] DNS resolution failure',
      confidence: 0.70,
      missingEvidence: ['Pod logs showing DNS lookup failures'],
    });
    const result = generateSpecRecommendations([finding], makeProfile());

    const disambiguationRec = result.find(
      (r) => r.type === 'collector' && r.description.includes('distinguish'),
    );
    expect(disambiguationRec).toBeUndefined();
  });
});

describe('generateSpecRecommendations — hypothesis gaps: no hypothesis findings', () => {
  it('leaves existing behavior unchanged when there are no hypothesis findings', () => {
    // Only a heuristic finding with missing evidence — the classic suggestMissingCollectors path
    const finding = makeFinding({
      id: 'finding:k8s:crashloop:0',
      title: "CrashLoopBackOff: Pod 'app-pod' in namespace 'default'",
      missingEvidence: ["Container log files for pod 'app-pod'"],
    });
    const result = generateSpecRecommendations([finding], makeProfile());

    // Should still produce a log-collector recommendation
    const logRec = result.find((r) => r.type === 'collector' && r.description.toLowerCase().includes('log'));
    expect(logRec).toBeDefined();

    // Should NOT produce any hypothesis-specific recommendations
    const coreDnsRec = result.find(
      (r) => r.type === 'collector' && r.description.toLowerCase().includes('coredns'),
    );
    expect(coreDnsRec).toBeUndefined();

    const networkPolicyRec = result.find(
      (r) => r.type === 'collector' && r.description.toLowerCase().includes('networkpolic'),
    );
    expect(networkPolicyRec).toBeUndefined();
  });

  it('does not produce disambiguation recommendation when no hypothesis findings exist', () => {
    const findings = [
      makeFinding({
        id: 'finding:k8s:crashloop:0',
        title: "CrashLoopBackOff: Pod 'pod-a'",
        confidence: 0.70,
        missingEvidence: ['Pod logs'],
      }),
      makeFinding({
        id: 'finding:k8s:imagepull:1',
        title: "ImagePullBackOff: Pod 'pod-b'",
        confidence: 0.65,
        missingEvidence: ['Container registry logs'],
      }),
    ];
    const result = generateSpecRecommendations(findings, makeProfile());

    const disambiguationRec = result.find(
      (r) => r.type === 'collector' && r.description.includes('distinguish'),
    );
    expect(disambiguationRec).toBeUndefined();
  });
});

describe('generateSpecRecommendations — hypothesis gaps: mixed hypothesis and heuristic findings', () => {
  it('generates both hypothesis-specific and heuristic-based recommendations together', () => {
    const findings = [
      // Heuristic finding
      makeFinding({
        id: 'finding:k8s:crashloop:0',
        title: "CrashLoopBackOff: Pod 'app-pod'",
        missingEvidence: ["Container log files for pod 'app-pod'"],
      }),
      // Hypothesis finding — no second hypothesis finding so disambiguation is not triggered
      makeFinding({
        id: 'finding:hypothesis:dns-failure:1',
        title: '[Hypothesis] DNS resolution failure',
        confidence: 0.70,
        missingEvidence: [
          'CoreDNS or kube-dns pod logs would decisively confirm DNS resolution failures cluster-wide',
        ],
      }),
    ];
    const result = generateSpecRecommendations(findings, makeProfile());

    // Should have a generic log-collector from heuristic missing evidence
    // (LOG_COLLECTOR_DESCRIPTION mentions "application pods")
    const logRec = result.find(
      (r) => r.type === 'collector' && r.description.toLowerCase().includes('application pods'),
    );
    expect(logRec).toBeDefined();

    // Should have a CoreDNS collector from hypothesis gap
    const coreDnsRec = result.find(
      (r) => r.type === 'collector' && r.description.toLowerCase().includes('coredns'),
    );
    expect(coreDnsRec).toBeDefined();
  });

  it('does not produce disambiguation rec when only one of two findings is a hypothesis finding', () => {
    const findings = [
      makeFinding({
        id: 'finding:k8s:crashloop:0',
        title: "CrashLoopBackOff: Pod 'app-pod'",
        confidence: 0.70,
        missingEvidence: ['Container log files'],
      }),
      makeFinding({
        id: 'finding:hypothesis:dns-failure:1',
        title: '[Hypothesis] DNS resolution failure',
        confidence: 0.65,
        missingEvidence: ['CoreDNS logs would confirm DNS failures'],
      }),
    ];
    const result = generateSpecRecommendations(findings, makeProfile());

    // Only one hypothesis finding exists, so disambiguation should not trigger
    const disambiguationRec = result.find(
      (r) => r.type === 'collector' && r.description.includes('distinguish'),
    );
    expect(disambiguationRec).toBeUndefined();
  });
});
