import { describe, it, expect } from 'vitest';
import type { InvestigatorContext, InvestigationSeed } from '../types.js';
import type { BundleProfile, K8sResource } from '../../types/index.js';
import type { LogFile, LogLine } from '../../parsers/index.js';
import { investigateServices } from '../service-investigator.js';

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

function makeService(
  name: string,
  namespace = 'default',
  selector: Record<string, string> = { app: name },
): K8sResource {
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name, namespace },
    spec: { selector, ports: [{ port: 80, targetPort: 8080 }] },
    status: {},
  };
}

/**
 * Builds an Endpoints resource (Kubernetes v1 Endpoints object).
 *
 * Each address in `readyAddresses` is a ready backend.
 * Each address in `notReadyAddresses` is a not-ready backend.
 */
function makeEndpoints(
  name: string,
  namespace = 'default',
  readyAddresses: string[] = [],
  notReadyAddresses: string[] = [],
): K8sResource {
  const subsets =
    readyAddresses.length > 0 || notReadyAddresses.length > 0
      ? [
          {
            addresses: readyAddresses.map((ip) => ({ ip })),
            notReadyAddresses: notReadyAddresses.map((ip) => ({ ip })),
            ports: [{ port: 8080 }],
          },
        ]
      : [];
  return {
    apiVersion: 'v1',
    kind: 'Endpoints',
    metadata: { name, namespace },
    // Kubernetes Endpoints put `subsets` inside spec for our K8sResource model.
    // The service-investigator checks both top-level and spec.subsets.
    spec: { subsets },
  };
}

/**
 * Builds a Pod that references a service via env vars and has a ready status.
 */
function makePodReferencingService(
  podName: string,
  namespace: string,
  serviceName: string,
  ready = true,
): K8sResource {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name: podName, namespace, labels: { app: podName } },
    spec: {
      containers: [
        {
          name: 'app',
          image: 'myapp:v1.0.0',
          env: [{ name: 'SERVICE_HOST', value: serviceName }],
        },
      ],
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
 * Builds a minimal log file containing DNS failure lines for the given service.
 */
function makeDnsFailureLog(podName: string, namespace: string, serviceName: string): LogFile {
  const lines: LogLine[] = [
    {
      lineNumber: 1,
      content: `2024-01-15T10:00:00Z INFO  Starting application`,
      level: 'info',
    },
    {
      lineNumber: 2,
      content: `2024-01-15T10:00:05Z ERROR dial tcp: lookup ${serviceName}: no such host`,
      level: 'error',
    },
    {
      lineNumber: 3,
      content: `2024-01-15T10:00:10Z ERROR connection refused to ${serviceName}:80`,
      level: 'error',
    },
  ];
  return {
    path: `pods/logs/${namespace}/${podName}/app.log`,
    lines,
    errorCount: 2,
    warningCount: 0,
    importance: 0.8,
  };
}

// ---------------------------------------------------------------------------
// Test: No findings when service has ready endpoints
// ---------------------------------------------------------------------------

describe('investigateServices — service with ready endpoints', () => {
  it('produces no finding when a referenced service has ≥1 ready endpoint address', () => {
    const pod = makePodReferencingService('app-pod', 'default', 'my-service');
    const service = makeService('my-service', 'default');
    const endpoints = makeEndpoints('my-service', 'default', ['10.0.0.1']);

    const ctx = makeContext({ resources: [pod, service, endpoints] });
    const result = investigateServices(ctx, noSeeds);

    expect(result.findings).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
  });

  it('produces no finding when the namespace has no Service resources (bundle gap)', () => {
    // If there are no services at all, we cannot assess endpoint health.
    const pod = makePodReferencingService('app-pod', 'default', 'my-service');
    const ctx = makeContext({ resources: [pod] });
    const result = investigateServices(ctx, noSeeds);
    expect(result.findings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Test: Finding when service exists but has 0 ready endpoints
// ---------------------------------------------------------------------------

describe('investigateServices — service with 0 ready endpoints', () => {
  it('generates a finding when Service exists but Endpoints has 0 ready addresses', () => {
    const pod = makePodReferencingService('app-pod', 'default', 'my-service');
    const service = makeService('my-service', 'default');
    const endpoints = makeEndpoints('my-service', 'default', [], []); // 0 ready

    const ctx = makeContext({ resources: [pod, service, endpoints] });
    const result = investigateServices(ctx, noSeeds);

    expect(result.findings).toHaveLength(1);
    const finding = result.findings[0]!;
    expect(finding.title).toContain('my-service');
    expect(finding.title.toLowerCase()).toMatch(/0 ready|no ready|zero ready/);
    expect(finding.severity).toBe('high');
    expect(finding.confidence).toBeGreaterThanOrEqual(0.75);
    expect(finding.affectedComponents).toContain('Service/default/my-service');
  });

  it('includes the service name and namespace in the finding reasoning', () => {
    const pod = makePodReferencingService('app-pod', 'default', 'my-service');
    const service = makeService('my-service', 'default');
    const endpoints = makeEndpoints('my-service', 'default', [], []);

    const ctx = makeContext({ resources: [pod, service, endpoints] });
    const result = investigateServices(ctx, noSeeds);

    const finding = result.findings[0]!;
    expect(finding.reasoningSummary).toContain('my-service');
    expect(finding.reasoningSummary).toContain('default');
  });

  it('generates a finding when Endpoints resource is absent for an existing Service', () => {
    // Service exists but no Endpoints object was captured in the bundle.
    const pod = makePodReferencingService('app-pod', 'default', 'my-service');
    const service = makeService('my-service', 'default');
    // No Endpoints resource provided.

    const ctx = makeContext({ resources: [pod, service] });
    const result = investigateServices(ctx, noSeeds);

    expect(result.findings).toHaveLength(1);
    const finding = result.findings[0]!;
    expect(finding.title).toContain('my-service');
    expect(finding.affectedComponents).toContain('Service/default/my-service');
  });

  it('counts only ready addresses (not notReady) when checking endpoint health', () => {
    const pod = makePodReferencingService('app-pod', 'default', 'my-service');
    const service = makeService('my-service', 'default');
    // 1 notReady address, 0 ready
    const endpoints = makeEndpoints('my-service', 'default', [], ['10.0.0.2']);

    const ctx = makeContext({ resources: [pod, service, endpoints] });
    const result = investigateServices(ctx, noSeeds);

    expect(result.findings).toHaveLength(1);
    const finding = result.findings[0]!;
    expect(finding.title).toContain('my-service');
  });
});

// ---------------------------------------------------------------------------
// Test: Cross-reference with DNS failure findings
// ---------------------------------------------------------------------------

describe('investigateServices — cross-reference with DNS failures', () => {
  it('elevates confidence when DNS failure logs match the service name', () => {
    const pod = makePodReferencingService('app-pod', 'default', 'my-service');
    const service = makeService('my-service', 'default');
    const endpoints = makeEndpoints('my-service', 'default', [], []);
    const dnsLog = makeDnsFailureLog('app-pod', 'default', 'my-service');

    const ctxWithoutLog = makeContext({ resources: [pod, service, endpoints] });
    const ctxWithLog = makeContext({ resources: [pod, service, endpoints], logs: [dnsLog] });

    const resultWithout = investigateServices(ctxWithoutLog, noSeeds);
    const resultWith = investigateServices(ctxWithLog, noSeeds);

    expect(resultWithout.findings).toHaveLength(1);
    expect(resultWith.findings).toHaveLength(1);

    const confWithout = resultWithout.findings[0]!.confidence;
    const confWith = resultWith.findings[0]!.confidence;

    // DNS log match should increase confidence
    expect(confWith).toBeGreaterThan(confWithout);
  });

  it('includes the DNS failure log line in the finding evidence when present', () => {
    const pod = makePodReferencingService('app-pod', 'default', 'my-service');
    const service = makeService('my-service', 'default');
    const endpoints = makeEndpoints('my-service', 'default', [], []);
    const dnsLog = makeDnsFailureLog('app-pod', 'default', 'my-service');

    const ctx = makeContext({ resources: [pod, service, endpoints], logs: [dnsLog] });
    const result = investigateServices(ctx, noSeeds);

    expect(result.findings).toHaveLength(1);
    const evidence = result.findings[0]!.evidence;
    // Log evidence paths end in '.log' or contain 'logs/'
    const logEvidence = evidence.find(
      (e) => e.path.endsWith('.log') || e.path.includes('/logs/') || e.artifactType === 'log',
    );
    expect(logEvidence).toBeDefined();
    expect(logEvidence!.note.toLowerCase()).toMatch(/dns|no such host|lookup|connection/i);
  });
});

// ---------------------------------------------------------------------------
// Test: Causal graph edges
// ---------------------------------------------------------------------------

describe('investigateServices — causal graph edges', () => {
  it('creates a ServiceNoEndpoints → ConnectionFailure causal edge', () => {
    const pod = makePodReferencingService('app-pod', 'default', 'my-service');
    const service = makeService('my-service', 'default');
    const endpoints = makeEndpoints('my-service', 'default', [], []);

    const ctx = makeContext({ resources: [pod, service, endpoints] });
    const result = investigateServices(ctx, noSeeds);

    expect(result.findings).toHaveLength(1);
    const findingId = result.findings[0]!.id;

    // There should be at least one 'causes' edge from the service-no-endpoints
    // finding to a downstream effect node
    const causesEdges = result.edges.filter((e) => e.type === 'causes');
    expect(causesEdges.length).toBeGreaterThanOrEqual(1);

    // The source of at least one edge is the service-no-endpoints finding
    const sourceIsServiceFinding = causesEdges.some((e) => e.source === findingId);
    expect(sourceIsServiceFinding).toBe(true);
  });

  it('creates a supports edge from evidence to the finding', () => {
    const pod = makePodReferencingService('app-pod', 'default', 'my-service');
    const service = makeService('my-service', 'default');
    const endpoints = makeEndpoints('my-service', 'default', [], []);

    const ctx = makeContext({ resources: [pod, service, endpoints] });
    const result = investigateServices(ctx, noSeeds);

    expect(result.findings).toHaveLength(1);
    const findingId = result.findings[0]!.id;

    const supportsEdges = result.edges.filter(
      (e) => e.type === 'supports' && e.target === findingId,
    );
    expect(supportsEdges.length).toBeGreaterThanOrEqual(1);
  });

  it('creates a PodNotReady causal edge when a referencing pod is not ready', () => {
    const pod = makePodReferencingService('app-pod', 'default', 'my-service', false);
    const service = makeService('my-service', 'default');
    const endpoints = makeEndpoints('my-service', 'default', [], []);

    const ctx = makeContext({ resources: [pod, service, endpoints] });
    const result = investigateServices(ctx, noSeeds);

    expect(result.findings).toHaveLength(1);
    const findingId = result.findings[0]!.id;

    // Edge: findingId → downstream pod-not-ready node (or pod component target)
    const causesEdges = result.edges.filter(
      (e) => e.type === 'causes' && e.source === findingId,
    );
    expect(causesEdges.length).toBeGreaterThanOrEqual(1);

    // The target should reference the pod component
    const hasPodTarget = causesEdges.some(
      (e) => e.target.includes('app-pod') || e.target.includes('PodNotReady'),
    );
    expect(hasPodTarget).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test: Multiple services
// ---------------------------------------------------------------------------

describe('investigateServices — multiple services', () => {
  it('generates a finding per service with 0 ready endpoints (not one combined finding)', () => {
    const pod = makePodReferencingService('app-pod', 'default', 'service-a');
    const podB = makePodReferencingService('worker-pod', 'default', 'service-b');

    const serviceA = makeService('service-a', 'default');
    const serviceB = makeService('service-b', 'default');
    const endpointsA = makeEndpoints('service-a', 'default', [], []);
    const endpointsB = makeEndpoints('service-b', 'default', [], []);

    const ctx = makeContext({
      resources: [pod, podB, serviceA, serviceB, endpointsA, endpointsB],
    });
    const result = investigateServices(ctx, noSeeds);

    expect(result.findings).toHaveLength(2);
    const titles = result.findings.map((f) => f.title);
    expect(titles.some((t) => t.includes('service-a'))).toBe(true);
    expect(titles.some((t) => t.includes('service-b'))).toBe(true);
  });

  it('only generates findings for services with 0 ready endpoints in a mixed set', () => {
    const pod = makePodReferencingService('app-pod', 'default', 'service-a');
    const podB = makePodReferencingService('worker-pod', 'default', 'service-b');

    const serviceA = makeService('service-a', 'default');
    const serviceB = makeService('service-b', 'default');
    const endpointsA = makeEndpoints('service-a', 'default', [], []); // unhealthy
    const endpointsB = makeEndpoints('service-b', 'default', ['10.0.0.1']); // healthy

    const ctx = makeContext({
      resources: [pod, podB, serviceA, serviceB, endpointsA, endpointsB],
    });
    const result = investigateServices(ctx, noSeeds);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.title).toContain('service-a');
  });
});

// ---------------------------------------------------------------------------
// Test: Finding ID format and uniqueness
// ---------------------------------------------------------------------------

describe('investigateServices — finding ID format', () => {
  it('uses the finding:service: prefix in the finding ID', () => {
    const pod = makePodReferencingService('app-pod', 'default', 'my-service');
    const service = makeService('my-service', 'default');
    const endpoints = makeEndpoints('my-service', 'default', [], []);

    const ctx = makeContext({ resources: [pod, service, endpoints] });
    const result = investigateServices(ctx, noSeeds);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.id).toMatch(/^finding:service:/);
  });

  it('produces unique finding IDs across multiple findings', () => {
    const podA = makePodReferencingService('app-pod', 'default', 'service-a');
    const podB = makePodReferencingService('worker-pod', 'default', 'service-b');
    const serviceA = makeService('service-a', 'default');
    const serviceB = makeService('service-b', 'default');
    const endpointsA = makeEndpoints('service-a', 'default', [], []);
    const endpointsB = makeEndpoints('service-b', 'default', [], []);

    const ctx = makeContext({
      resources: [podA, podB, serviceA, serviceB, endpointsA, endpointsB],
    });
    const result = investigateServices(ctx, noSeeds);

    expect(result.findings).toHaveLength(2);
    const ids = result.findings.map((f) => f.id);
    expect(new Set(ids).size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Test: InvestigatorResult structure
// ---------------------------------------------------------------------------

describe('investigateServices — return type contract', () => {
  it('always returns an object with findings and edges arrays', () => {
    const ctx = makeContext();
    const result = investigateServices(ctx, noSeeds);
    expect(Array.isArray(result.findings)).toBe(true);
    expect(Array.isArray(result.edges)).toBe(true);
  });

  it('returns empty arrays when there are no pods or services', () => {
    const ctx = makeContext();
    const result = investigateServices(ctx, noSeeds);
    expect(result.findings).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
  });

  it('includes a recommendedAction in every finding', () => {
    const pod = makePodReferencingService('app-pod', 'default', 'my-service');
    const service = makeService('my-service', 'default');
    const endpoints = makeEndpoints('my-service', 'default', [], []);

    const ctx = makeContext({ resources: [pod, service, endpoints] });
    const result = investigateServices(ctx, noSeeds);

    for (const finding of result.findings) {
      expect(typeof finding.recommendedAction).toBe('string');
      expect(finding.recommendedAction.length).toBeGreaterThan(0);
    }
  });
});
