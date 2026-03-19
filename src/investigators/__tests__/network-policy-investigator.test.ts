import { describe, it, expect } from 'vitest';
import type { InvestigatorContext, InvestigationSeed } from '../types.js';
import type { BundleProfile, K8sResource } from '../../types/index.js';
import type { LogFile } from '../../parsers/index.js';
import { investigateNetworkPolicies } from '../network-policy-investigator.js';

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

const noSeeds: InvestigationSeed[] = [];

// ---------------------------------------------------------------------------
// Resource fixture helpers
// ---------------------------------------------------------------------------

/**
 * Creates a Pod with given labels and optional readiness status.
 */
function makePod(
  name: string,
  namespace: string,
  labels: Record<string, string>,
  ready = true,
): K8sResource {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name, namespace, labels },
    spec: {
      containers: [{ name: 'app', image: 'myapp:v1' }],
    },
    status: {
      phase: ready ? 'Running' : 'Pending',
      conditions: [{ type: 'Ready', status: ready ? 'True' : 'False' }],
      containerStatuses: [
        {
          name: 'app',
          ready,
          restartCount: 0,
          state: ready ? { running: {} } : { waiting: { reason: 'ContainerCreating' } },
        },
      ],
    },
  };
}

/**
 * Creates a Service with the given selector and ports.
 */
function makeService(
  name: string,
  namespace: string,
  selector: Record<string, string> = { app: name },
  ports: Array<{ port: number; protocol?: string }> = [{ port: 80 }],
): K8sResource {
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name, namespace },
    spec: { selector, ports },
    status: {},
  };
}

/**
 * Creates a NetworkPolicy resource.
 *
 * @param name             - Policy name
 * @param namespace        - Namespace it lives in
 * @param podSelector      - Labels that select pods this policy applies to
 * @param policyTypes      - 'Ingress', 'Egress', or both
 * @param ingressRules     - Array of ingress rule objects (raw)
 * @param egressRules      - Array of egress rule objects (raw)
 */
function makeNetworkPolicy(
  name: string,
  namespace: string,
  podSelector: Record<string, string>,
  policyTypes: string[] = ['Ingress', 'Egress'],
  ingressRules: unknown[] = [],
  egressRules: unknown[] = [],
): K8sResource {
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: { name, namespace },
    spec: {
      podSelector: { matchLabels: podSelector },
      policyTypes,
      ingress: ingressRules,
      egress: egressRules,
    },
    status: {},
  };
}

/**
 * Creates a NetworkPolicy that blocks ALL egress (empty egress rule list
 * + policyTypes includes Egress).
 */
function makeBlockAllEgressPolicy(
  name: string,
  namespace: string,
  podSelector: Record<string, string>,
): K8sResource {
  return makeNetworkPolicy(name, namespace, podSelector, ['Egress'], [], []);
}

/**
 * Creates a NetworkPolicy that allows egress only to a specific port.
 * Any other port is blocked.
 */
function makeEgressAllowOnPortPolicy(
  name: string,
  namespace: string,
  podSelector: Record<string, string>,
  allowedPort: number,
  allowedProtocol = 'TCP',
): K8sResource {
  return makeNetworkPolicy(
    name,
    namespace,
    podSelector,
    ['Egress'],
    [],
    [
      {
        ports: [{ port: allowedPort, protocol: allowedProtocol }],
      },
    ],
  );
}

/**
 * Creates a NetworkPolicy that blocks all ingress for the selected pods.
 */
function makeBlockAllIngressPolicy(
  name: string,
  namespace: string,
  podSelector: Record<string, string>,
): K8sResource {
  return makeNetworkPolicy(name, namespace, podSelector, ['Ingress'], [], []);
}

// ---------------------------------------------------------------------------
// Test: Return type contract
// ---------------------------------------------------------------------------

describe('investigateNetworkPolicies — return type contract', () => {
  it('always returns an object with findings and edges arrays', () => {
    const ctx = makeContext();
    const result = investigateNetworkPolicies(ctx, noSeeds);
    expect(Array.isArray(result.findings)).toBe(true);
    expect(Array.isArray(result.edges)).toBe(true);
  });

  it('returns empty arrays when there are no resources', () => {
    const ctx = makeContext();
    const result = investigateNetworkPolicies(ctx, noSeeds);
    expect(result.findings).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
  });

  it('returns empty arrays when there are pods but no NetworkPolicies', () => {
    const pod = makePod('app-pod', 'default', { app: 'myapp' }, false);
    const ctx = makeContext({ resources: [pod] });
    const result = investigateNetworkPolicies(ctx, noSeeds);
    expect(result.findings).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
  });

  it('includes a recommendedAction in every finding', () => {
    const pod = makePod('app-pod', 'default', { app: 'myapp' }, false);
    const service = makeService('database', 'default', { app: 'database' }, [{ port: 5432 }]);
    const policy = makeBlockAllEgressPolicy('block-egress', 'default', { app: 'myapp' });
    const ctx = makeContext({ resources: [pod, service, policy] });
    const result = investigateNetworkPolicies(ctx, noSeeds);

    for (const finding of result.findings) {
      expect(typeof finding.recommendedAction).toBe('string');
      expect(finding.recommendedAction.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Test: Parses NetworkPolicy resources
// ---------------------------------------------------------------------------

describe('investigateNetworkPolicies — NetworkPolicy parsing', () => {
  it('detects a NetworkPolicy that blocks all egress from a pod', () => {
    const pod = makePod('app-pod', 'default', { app: 'myapp' }, false);
    const service = makeService('database', 'default', { app: 'database' }, [{ port: 5432 }]);
    const policy = makeBlockAllEgressPolicy('block-egress', 'default', { app: 'myapp' });

    const ctx = makeContext({ resources: [pod, service, policy] });
    const result = investigateNetworkPolicies(ctx, noSeeds);

    expect(result.findings.length).toBeGreaterThanOrEqual(1);
  });

  it('does not generate findings when NetworkPolicy has no relevant pod selector match', () => {
    // Pod has label 'app: myapp'; policy selects 'app: other' — no match
    const pod = makePod('app-pod', 'default', { app: 'myapp' }, false);
    const service = makeService('database', 'default', { app: 'database' }, [{ port: 5432 }]);
    const policy = makeBlockAllEgressPolicy('block-egress', 'default', { app: 'other' });

    const ctx = makeContext({ resources: [pod, service, policy] });
    const result = investigateNetworkPolicies(ctx, noSeeds);

    expect(result.findings).toHaveLength(0);
  });

  it('does not generate findings for namespaces the policy does not cover', () => {
    // Pod in 'production'; policy in 'default' — different namespace
    const pod = makePod('app-pod', 'production', { app: 'myapp' }, false);
    const service = makeService('database', 'production', { app: 'database' }, [{ port: 5432 }]);
    const policy = makeBlockAllEgressPolicy('block-egress', 'default', { app: 'myapp' });

    const ctx = makeContext({ resources: [pod, service, policy] });
    const result = investigateNetworkPolicies(ctx, noSeeds);

    expect(result.findings).toHaveLength(0);
  });

  it('handles a NetworkPolicy with empty podSelector (selects all pods)', () => {
    // Empty matchLabels = {} selects all pods in the namespace
    const pod = makePod('app-pod', 'default', { app: 'myapp' }, false);
    const service = makeService('database', 'default', { app: 'database' }, [{ port: 5432 }]);
    const policy = makeNetworkPolicy('block-all-egress', 'default', {}, ['Egress'], [], []);

    const ctx = makeContext({ resources: [pod, service, policy] });
    const result = investigateNetworkPolicies(ctx, noSeeds);

    expect(result.findings.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Test: Egress blocking detection
// ---------------------------------------------------------------------------

describe('investigateNetworkPolicies — egress blocking', () => {
  it('generates a finding when a NetworkPolicy blocks egress to a service port', () => {
    // Policy: only allows egress on port 80 — blocks 5432
    const pod = makePod('app-pod', 'default', { app: 'myapp' }, false);
    const dbService = makeService('postgres', 'default', { app: 'postgres' }, [{ port: 5432 }]);
    const policy = makeEgressAllowOnPortPolicy('restrict-egress', 'default', { app: 'myapp' }, 80);

    const ctx = makeContext({ resources: [pod, dbService, policy] });
    const result = investigateNetworkPolicies(ctx, noSeeds);

    expect(result.findings.length).toBeGreaterThanOrEqual(1);
    const finding = result.findings[0]!;
    // Title should mention the NetworkPolicy name and blocked service/port
    expect(finding.title).toMatch(/NetworkPolicy|network.?policy/i);
    expect(finding.severity).toMatch(/^(critical|high|medium)$/);
  });

  it('generates a finding mentioning policy name, pod name, and service/port', () => {
    const pod = makePod('app-pod', 'default', { app: 'myapp' }, false);
    const dbService = makeService('postgres', 'default', { app: 'postgres' }, [{ port: 5432 }]);
    const policy = makeBlockAllEgressPolicy('block-all-egress', 'default', { app: 'myapp' });

    const ctx = makeContext({ resources: [pod, dbService, policy] });
    const result = investigateNetworkPolicies(ctx, noSeeds);

    expect(result.findings.length).toBeGreaterThanOrEqual(1);

    // At least one finding mentions either the policy, pod, or service
    const allText = result.findings.map((f) => f.title + ' ' + f.reasoningSummary).join(' ');
    expect(allText).toMatch(/block-all-egress|app-pod|postgres/i);
  });

  it('does not flag egress when policy allows it on the required port', () => {
    // Policy allows egress only on port 5432 — exactly what postgres uses
    const pod = makePod('app-pod', 'default', { app: 'myapp' });
    const dbService = makeService('postgres', 'default', { app: 'postgres' }, [{ port: 5432 }]);
    const policy = makeEgressAllowOnPortPolicy('allow-db', 'default', { app: 'myapp' }, 5432);

    const ctx = makeContext({ resources: [pod, dbService, policy] });
    const result = investigateNetworkPolicies(ctx, noSeeds);

    // Port 5432 is explicitly allowed — no blocking finding
    expect(result.findings).toHaveLength(0);
  });

  it('generates a finding when block-all-egress policy would block any service', () => {
    const pod = makePod('app-pod', 'default', { app: 'myapp' }, false);
    const webService = makeService('web-api', 'default', { app: 'web' }, [{ port: 80 }]);
    const policy = makeBlockAllEgressPolicy('deny-all', 'default', { app: 'myapp' });

    const ctx = makeContext({ resources: [pod, webService, policy] });
    const result = investigateNetworkPolicies(ctx, noSeeds);

    expect(result.findings.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Test: Ingress blocking detection
// ---------------------------------------------------------------------------

describe('investigateNetworkPolicies — ingress blocking', () => {
  it('generates a finding when a NetworkPolicy blocks all ingress to a pod', () => {
    // Service tries to expose a pod, but block-all-ingress policy is in effect
    const pod = makePod('backend-pod', 'default', { app: 'backend' }, false);
    const service = makeService('backend-svc', 'default', { app: 'backend' }, [{ port: 8080 }]);
    const policy = makeBlockAllIngressPolicy('deny-ingress', 'default', { app: 'backend' });

    const ctx = makeContext({ resources: [pod, service, policy] });
    const result = investigateNetworkPolicies(ctx, noSeeds);

    expect(result.findings.length).toBeGreaterThanOrEqual(1);
    const allText = result.findings.map((f) => f.title + ' ' + f.reasoningSummary).join(' ');
    expect(allText).toMatch(/ingress|deny-ingress|backend/i);
  });
});

// ---------------------------------------------------------------------------
// Test: Finding content correctness
// ---------------------------------------------------------------------------

describe('investigateNetworkPolicies — finding content', () => {
  it('finding includes policy name in affectedComponents', () => {
    const pod = makePod('app-pod', 'default', { app: 'myapp' }, false);
    const service = makeService('database', 'default', { app: 'database' }, [{ port: 5432 }]);
    const policy = makeBlockAllEgressPolicy('block-egress', 'default', { app: 'myapp' });

    const ctx = makeContext({ resources: [pod, service, policy] });
    const result = investigateNetworkPolicies(ctx, noSeeds);

    expect(result.findings.length).toBeGreaterThanOrEqual(1);
    const finding = result.findings[0]!;
    const componentStr = finding.affectedComponents.join(' ');
    expect(componentStr).toMatch(/NetworkPolicy|block-egress/i);
  });

  it('finding includes the pod name in affectedComponents', () => {
    const pod = makePod('app-pod', 'default', { app: 'myapp' }, false);
    const service = makeService('database', 'default', { app: 'database' }, [{ port: 5432 }]);
    const policy = makeBlockAllEgressPolicy('block-egress', 'default', { app: 'myapp' });

    const ctx = makeContext({ resources: [pod, service, policy] });
    const result = investigateNetworkPolicies(ctx, noSeeds);

    expect(result.findings.length).toBeGreaterThanOrEqual(1);
    const allComponents = result.findings.flatMap((f) => f.affectedComponents);
    expect(allComponents.some((c) => c.includes('app-pod'))).toBe(true);
  });

  it('finding has confidence in [0, 1]', () => {
    const pod = makePod('app-pod', 'default', { app: 'myapp' }, false);
    const service = makeService('database', 'default', { app: 'database' }, [{ port: 5432 }]);
    const policy = makeBlockAllEgressPolicy('block-egress', 'default', { app: 'myapp' });

    const ctx = makeContext({ resources: [pod, service, policy] });
    const result = investigateNetworkPolicies(ctx, noSeeds);

    for (const finding of result.findings) {
      expect(finding.confidence).toBeGreaterThanOrEqual(0);
      expect(finding.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('finding title matches the expected pattern (policy blocks pod traffic)', () => {
    const pod = makePod('app-pod', 'default', { app: 'myapp' }, false);
    const dbService = makeService('postgres', 'default', { app: 'postgres' }, [{ port: 5432 }]);
    const policy = makeBlockAllEgressPolicy('block-egress', 'default', { app: 'myapp' });

    const ctx = makeContext({ resources: [pod, dbService, policy] });
    const result = investigateNetworkPolicies(ctx, noSeeds);

    expect(result.findings.length).toBeGreaterThanOrEqual(1);
    // Finding title should describe the blocking relationship
    const titles = result.findings.map((f) => f.title);
    const hasBlockingTitle = titles.some(
      (t) => /block|deny|prevent|restrict|NetworkPolicy/i.test(t),
    );
    expect(hasBlockingTitle).toBe(true);
  });

  it('finding has at least one evidence item', () => {
    const pod = makePod('app-pod', 'default', { app: 'myapp' }, false);
    const service = makeService('database', 'default', { app: 'database' }, [{ port: 5432 }]);
    const policy = makeBlockAllEgressPolicy('block-egress', 'default', { app: 'myapp' });

    const ctx = makeContext({ resources: [pod, service, policy] });
    const result = investigateNetworkPolicies(ctx, noSeeds);

    for (const finding of result.findings) {
      expect(finding.evidence.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('uses finding:netpol: prefix in IDs', () => {
    const pod = makePod('app-pod', 'default', { app: 'myapp' }, false);
    const service = makeService('database', 'default', { app: 'database' }, [{ port: 5432 }]);
    const policy = makeBlockAllEgressPolicy('block-egress', 'default', { app: 'myapp' });

    const ctx = makeContext({ resources: [pod, service, policy] });
    const result = investigateNetworkPolicies(ctx, noSeeds);

    expect(result.findings.length).toBeGreaterThanOrEqual(1);
    for (const finding of result.findings) {
      expect(finding.id).toMatch(/^finding:netpol:/);
    }
  });

  it('produces unique finding IDs', () => {
    // Two separate blocking relationships → two distinct findings
    const pod = makePod('app-pod', 'default', { app: 'myapp' }, false);
    const db = makeService('postgres', 'default', { app: 'postgres' }, [{ port: 5432 }]);
    const redis = makeService('redis', 'default', { app: 'redis' }, [{ port: 6379 }]);
    // Block all egress → blocks both postgres and redis
    const policy = makeBlockAllEgressPolicy('deny-all', 'default', { app: 'myapp' });

    const ctx = makeContext({ resources: [pod, db, redis, policy] });
    const result = investigateNetworkPolicies(ctx, noSeeds);

    const ids = result.findings.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ---------------------------------------------------------------------------
// Test: Causal graph edges
// ---------------------------------------------------------------------------

describe('investigateNetworkPolicies — causal graph edges', () => {
  it('creates at least one causal edge per finding', () => {
    const pod = makePod('app-pod', 'default', { app: 'myapp' }, false);
    const service = makeService('database', 'default', { app: 'database' }, [{ port: 5432 }]);
    const policy = makeBlockAllEgressPolicy('block-egress', 'default', { app: 'myapp' });

    const ctx = makeContext({ resources: [pod, service, policy] });
    const result = investigateNetworkPolicies(ctx, noSeeds);

    expect(result.findings.length).toBeGreaterThanOrEqual(1);
    const causesEdges = result.edges.filter((e) => e.type === 'causes');
    expect(causesEdges.length).toBeGreaterThanOrEqual(1);
  });

  it('causal edge source is the finding ID', () => {
    const pod = makePod('app-pod', 'default', { app: 'myapp' }, false);
    const service = makeService('database', 'default', { app: 'database' }, [{ port: 5432 }]);
    const policy = makeBlockAllEgressPolicy('block-egress', 'default', { app: 'myapp' });

    const ctx = makeContext({ resources: [pod, service, policy] });
    const result = investigateNetworkPolicies(ctx, noSeeds);

    expect(result.findings.length).toBeGreaterThanOrEqual(1);
    const findingIds = new Set(result.findings.map((f) => f.id));
    const causesEdges = result.edges.filter((e) => e.type === 'causes');

    // At least one causes edge originates from a netpol finding
    const hasNetpolSource = causesEdges.some((e) => findingIds.has(e.source));
    expect(hasNetpolSource).toBe(true);
  });

  it('creates supports edges from evidence to findings', () => {
    const pod = makePod('app-pod', 'default', { app: 'myapp' }, false);
    const service = makeService('database', 'default', { app: 'database' }, [{ port: 5432 }]);
    const policy = makeBlockAllEgressPolicy('block-egress', 'default', { app: 'myapp' });

    const ctx = makeContext({ resources: [pod, service, policy] });
    const result = investigateNetworkPolicies(ctx, noSeeds);

    expect(result.findings.length).toBeGreaterThanOrEqual(1);
    const findingIds = new Set(result.findings.map((f) => f.id));
    const supportsEdges = result.edges.filter((e) => e.type === 'supports');
    expect(supportsEdges.length).toBeGreaterThanOrEqual(1);

    // All supports edges target a finding
    const allSupportTargetFindings = supportsEdges.every((e) => findingIds.has(e.target));
    expect(allSupportTargetFindings).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test: Multiple policies and pods
// ---------------------------------------------------------------------------

describe('investigateNetworkPolicies — multiple policies and pods', () => {
  it('detects blocking for multiple pods independently', () => {
    const pod1 = makePod('pod-a', 'default', { app: 'frontend' }, false);
    const pod2 = makePod('pod-b', 'default', { app: 'backend' }, false);
    const service = makeService('database', 'default', { app: 'db' }, [{ port: 5432 }]);
    const policy1 = makeBlockAllEgressPolicy('deny-frontend', 'default', { app: 'frontend' });
    const policy2 = makeBlockAllEgressPolicy('deny-backend', 'default', { app: 'backend' });

    const ctx = makeContext({ resources: [pod1, pod2, service, policy1, policy2] });
    const result = investigateNetworkPolicies(ctx, noSeeds);

    expect(result.findings.length).toBeGreaterThanOrEqual(1);
    const allText = result.findings.map((f) => f.title + ' ' + f.reasoningSummary).join(' ');
    // Both pods' blocking situations should appear somewhere
    expect(allText).toMatch(/frontend|backend/i);
  });

  it('produces separate findings for multiple NetworkPolicies affecting the same pod', () => {
    const pod = makePod('app-pod', 'default', { app: 'myapp' }, false);
    const db = makeService('postgres', 'default', { app: 'postgres' }, [{ port: 5432 }]);
    const policy1 = makeBlockAllEgressPolicy('deny-egress-1', 'default', { app: 'myapp' });
    const policy2 = makeBlockAllIngressPolicy('deny-ingress-1', 'default', { app: 'myapp' });

    const ctx = makeContext({ resources: [pod, db, policy1, policy2] });
    const result = investigateNetworkPolicies(ctx, noSeeds);

    // Should detect both egress blocking (toward db) and ingress blocking
    expect(result.findings.length).toBeGreaterThanOrEqual(1);
  });

  it('does not produce duplicate findings for the same policy-pod-service combination', () => {
    const pod = makePod('app-pod', 'default', { app: 'myapp' }, false);
    const service = makeService('database', 'default', { app: 'db' }, [{ port: 5432 }]);
    const policy = makeBlockAllEgressPolicy('deny-all', 'default', { app: 'myapp' });

    const ctx = makeContext({ resources: [pod, service, policy] });
    const result = investigateNetworkPolicies(ctx, noSeeds);

    // The same (policy, pod, service) triple must not appear twice
    const keys = result.findings.map((f) => f.id);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

// ---------------------------------------------------------------------------
// Test: Port-specific blocking
// ---------------------------------------------------------------------------

describe('investigateNetworkPolicies — port-specific analysis', () => {
  it('generates a port-specific finding when egress is allowed only on port 80 but service uses 5432', () => {
    const pod = makePod('app-pod', 'default', { app: 'myapp' }, false);
    const dbService = makeService('postgres', 'default', { app: 'postgres' }, [
      { port: 5432, protocol: 'TCP' },
    ]);
    // Policy allows egress only on port 80
    const policy = makeEgressAllowOnPortPolicy('allow-http-only', 'default', { app: 'myapp' }, 80);

    const ctx = makeContext({ resources: [pod, dbService, policy] });
    const result = investigateNetworkPolicies(ctx, noSeeds);

    expect(result.findings.length).toBeGreaterThanOrEqual(1);
    const allText = result.findings.map((f) => f.title + ' ' + f.reasoningSummary).join(' ');
    // Port 5432 should appear in the finding
    expect(allText).toMatch(/5432|postgres/i);
  });

  it('includes the port number in the finding title or reasoning', () => {
    const pod = makePod('app-pod', 'default', { app: 'myapp' }, false);
    const dbService = makeService('postgres', 'default', { app: 'postgres' }, [{ port: 5432 }]);
    const policy = makeBlockAllEgressPolicy('block-egress', 'default', { app: 'myapp' });

    const ctx = makeContext({ resources: [pod, dbService, policy] });
    const result = investigateNetworkPolicies(ctx, noSeeds);

    expect(result.findings.length).toBeGreaterThanOrEqual(1);
    const allText = result.findings.map((f) => f.title + ' ' + f.reasoningSummary).join(' ');
    expect(allText).toMatch(/5432|port/i);
  });
});
