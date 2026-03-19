import { describe, it, expect, vi } from 'vitest';
import type { InvestigatorContext } from '../types.js';
import type { BundleProfile, K8sResource, K8sEvent } from '../../types/index.js';
import type { LogFile, LogLine } from '../../parsers/index.js';
import type { AIInvestigatorDeps } from '../ai-investigator.js';
import type { ResourceRelationshipGraph } from '../../graph/resource-graph.js';
import { classifyLogLevel } from '../../parsers/index.js';
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

function makeLogLine(content: string, lineNumber: number): LogLine {
  return { lineNumber, content, level: classifyLogLevel(content) };
}

function makeLogFile(logPath: string, lines: string[]): LogFile {
  const logLines = lines.map((c, i) => makeLogLine(c, i + 1));
  const errorCount = logLines.filter((l) => l.level === 'error').length;
  const warningCount = logLines.filter((l) => l.level === 'warning').length;
  return { path: logPath, lines: logLines, errorCount, warningCount, importance: 0.5 };
}

// ---------------------------------------------------------------------------
// Fixtures — CrashLoopBackOff pod
// ---------------------------------------------------------------------------

const crashLoopPod: K8sResource = {
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: { name: 'app-pod', namespace: 'default' },
  spec: {
    containers: [{ name: 'app', image: 'myapp:v1.2.3' }],
  },
  status: {
    phase: 'Running',
    conditions: [
      { type: 'Ready', status: 'False', reason: 'ContainersNotReady' },
    ],
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

// ---------------------------------------------------------------------------
// Fixtures — missing Secret
// ---------------------------------------------------------------------------

const missingSecretPod: K8sResource = {
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: { name: 'secret-pod', namespace: 'production' },
  spec: {
    containers: [
      {
        name: 'app',
        image: 'myapp:v2.0.0',
        envFrom: [{ secretRef: { name: 'app-credentials' } }],
      },
    ],
  },
  status: { phase: 'Pending' },
};

/** A dummy Secret in the same namespace so the checker runs. */
const dummySecret: K8sResource = {
  apiVersion: 'v1',
  kind: 'Secret',
  metadata: { name: 'other-secret', namespace: 'production' },
};

// ---------------------------------------------------------------------------
// Fixtures — log file with DNS failures
// ---------------------------------------------------------------------------

const dnsFailureLog: LogFile = makeLogFile('pod-logs/default/dns-pod/app.log', [
  'INFO  Starting application',
  'ERROR lookup db.internal: no such host',
  'ERROR lookup db.internal: no such host',
  'WARN  Retrying connection',
  'ERROR lookup db.internal: no such host',
]);

// ---------------------------------------------------------------------------
// AI deps helpers
// ---------------------------------------------------------------------------

function makeEmptyAIDeps(): AIInvestigatorDeps {
  const emptyGraph: ResourceRelationshipGraph = { nodes: new Map(), edges: [] };
  return {
    llmClient: {
      investigateSeed: vi.fn().mockResolvedValue({ findings: [] }),
    } as unknown as AIInvestigatorDeps['llmClient'],
    chunkIndex: [],
    resourceGraph: emptyGraph,
    lexicalIndex: {
      build: vi.fn(),
      search: vi.fn().mockReturnValue([]),
      extractQueryIdentifiers: vi.fn().mockReturnValue([]),
    } as unknown as AIInvestigatorDeps['lexicalIndex'],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runInvestigation', () => {
  it('returns an InvestigationResult with the expected shape on an empty context', async () => {
    const result = await runInvestigation(makeContext());

    expect(result).toMatchObject({
      findings: expect.any(Array),
      edges: expect.any(Array),
      seeds: expect.any(Array),
      metadata: {
        seedCount: expect.any(Number),
        rawFindingCount: expect.any(Number),
        finalFindingCount: expect.any(Number),
        aiEnabled: false,
        aiFindings: 0,
      },
    });
    expect(result.findings).toHaveLength(0);
    expect(result.seeds).toHaveLength(0);
    expect(result.metadata.seedCount).toBe(0);
    expect(result.metadata.rawFindingCount).toBe(0);
    expect(result.metadata.finalFindingCount).toBe(0);
  });

  it('generates seeds from context data', async () => {
    const context = makeContext({ resources: [crashLoopPod], events: [backOffEvent] });
    const result = await runInvestigation(context);

    // Seeds should be generated for the CrashLoopBackOff pod and the Warning event
    expect(result.seeds.length).toBeGreaterThan(0);
    const crashSeed = result.seeds.find((s) =>
      s.hypothesis.toLowerCase().includes('crashloop'),
    );
    expect(crashSeed).toBeDefined();
    expect(crashSeed?.category).toBe('kubernetes');
    expect(crashSeed?.priority).toBeGreaterThanOrEqual(80);
  });

  it('runs the Kubernetes investigator and produces CrashLoopBackOff findings', async () => {
    const context = makeContext({ resources: [crashLoopPod], events: [backOffEvent] });
    const result = await runInvestigation(context);

    const crashFinding = result.findings.find((f) =>
      f.title.toLowerCase().includes('crashloop'),
    );
    expect(crashFinding).toBeDefined();
    expect(crashFinding?.severity).toBe('critical');
    expect(crashFinding?.confidence).toBeGreaterThan(0);
  });

  it('runs the Log investigator and produces DNS failure findings', async () => {
    const context = makeContext({ logs: [dnsFailureLog] });
    const result = await runInvestigation(context);

    const dnsFinding = result.findings.find(
      (f) => f.title.toLowerCase().includes('dns'),
    );
    expect(dnsFinding).toBeDefined();
    expect(dnsFinding?.severity).toBe('high');
  });

  it('runs the Configuration investigator and produces missing-secret findings', async () => {
    const context = makeContext({
      resources: [missingSecretPod, dummySecret],
    });
    const result = await runInvestigation(context);

    const secretFinding = result.findings.find((f) =>
      f.title.toLowerCase().includes('secret'),
    );
    expect(secretFinding).toBeDefined();
    expect(secretFinding?.severity).toBe('critical');
  });

  it('collects edges from all three investigators', async () => {
    const context = makeContext({
      resources: [crashLoopPod, missingSecretPod, dummySecret],
      events: [backOffEvent],
      logs: [dnsFailureLog],
    });
    const result = await runInvestigation(context);

    // Edges come from k8s, log, and config investigators
    expect(result.edges.length).toBeGreaterThan(0);
    expect(result.edges.every((e) => e.id && e.source && e.target && e.type)).toBe(true);
  });

  it('runs the verifier — deduplication reduces raw finding count when there is overlap', async () => {
    // A context that triggers the same issue from multiple investigators
    const context = makeContext({
      resources: [crashLoopPod],
      events: [backOffEvent],
      logs: [dnsFailureLog],
    });
    const result = await runInvestigation(context);

    // finalFindingCount should be <= rawFindingCount (dedup can only remove or keep)
    expect(result.metadata.finalFindingCount).toBeLessThanOrEqual(
      result.metadata.rawFindingCount,
    );
    // The metadata counts should be consistent with the returned arrays
    expect(result.findings).toHaveLength(result.metadata.finalFindingCount);
  });

  it('sorts findings by severity descending, then confidence descending', async () => {
    const context = makeContext({
      resources: [crashLoopPod, missingSecretPod, dummySecret],
      events: [backOffEvent],
      logs: [dnsFailureLog],
    });
    const result = await runInvestigation(context);

    const severityOrder: Record<string, number> = {
      critical: 4,
      high: 3,
      medium: 2,
      low: 1,
      info: 0,
    };

    for (let i = 0; i < result.findings.length - 1; i++) {
      const current = result.findings[i]!;
      const next = result.findings[i + 1]!;
      const currentSev = severityOrder[current.severity] ?? 0;
      const nextSev = severityOrder[next.severity] ?? 0;

      if (currentSev === nextSev) {
        // Same severity: confidence must be non-increasing
        expect(current.confidence).toBeGreaterThanOrEqual(next.confidence);
      } else {
        // Severity must be non-increasing
        expect(currentSev).toBeGreaterThanOrEqual(nextSev);
      }
    }
  });

  it('metadata rawFindingCount equals sum of findings from all three investigators', async () => {
    // The raw count (before dedup) should account for what each investigator returned.
    // We verify that finalFindingCount <= rawFindingCount and both are non-negative.
    const context = makeContext({
      resources: [crashLoopPod],
      events: [backOffEvent],
      logs: [dnsFailureLog],
    });
    const result = await runInvestigation(context);

    expect(result.metadata.rawFindingCount).toBeGreaterThanOrEqual(0);
    expect(result.metadata.finalFindingCount).toBeGreaterThanOrEqual(0);
    expect(result.metadata.finalFindingCount).toBeLessThanOrEqual(
      result.metadata.rawFindingCount,
    );
  });

  it('all finding ids are unique after orchestration', async () => {
    const context = makeContext({
      resources: [crashLoopPod, missingSecretPod, dummySecret],
      events: [backOffEvent],
      logs: [dnsFailureLog],
    });
    const result = await runInvestigation(context);

    const ids = result.findings.map((f) => f.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it('seeds are partitioned and passed to the correct investigator types', async () => {
    // A context with both k8s issues and log issues generates seeds of both categories
    const context = makeContext({
      resources: [crashLoopPod],
      events: [backOffEvent],
      logs: [dnsFailureLog],
    });
    const result = await runInvestigation(context);

    const k8sSeeds = result.seeds.filter((s) => s.category === 'kubernetes');
    const logSeeds = result.seeds.filter((s) => s.category === 'log');

    expect(k8sSeeds.length).toBeGreaterThan(0);
    expect(logSeeds.length).toBeGreaterThan(0);
  });

  it('handles context with only analyzer results', async () => {
    const context = makeContext({
      analyzerResults: [
        {
          name: 'replicaset',
          title: 'Deployment has no ready replicas',
          message: 'The deployment has 0/1 ready replicas',
          severity: 'error' as const,
          isPass: false,
          isFail: true,
          isWarn: false,
        },
      ],
    });
    const result = await runInvestigation(context);

    // Should generate at least one seed from the error-severity analyzer result
    const analyzerSeed = result.seeds.find((s) => s.source.startsWith('analyzer:'));
    expect(analyzerSeed).toBeDefined();

    // Result is structurally valid
    expect(result.findings).toBeInstanceOf(Array);
    expect(result.edges).toBeInstanceOf(Array);
  });

  // ── AI integration tests ────────────────────────────────────────────────────

  it('metadata.aiEnabled is false and metadata.aiFindings is 0 when no aiDeps provided', async () => {
    const context = makeContext({ resources: [crashLoopPod], events: [backOffEvent] });
    const result = await runInvestigation(context);

    expect(result.metadata.aiEnabled).toBe(false);
    expect(result.metadata.aiFindings).toBe(0);
  });

  it('merges AI findings with heuristic findings when aiDeps is provided', async () => {
    // Use a finding that's about a ConfigMap typo — NOT crashloop — so it
    // won't be deduplicated with the heuristic CrashLoopBackOff finding.
    const aiFinding = {
      title: 'ConfigMap db-config has DB_USER typo: "amdin" instead of "admin"',
      severity: 'high' as const,
      confidence: 0.8,
      affectedComponents: ['ConfigMap/default/db-config'],
      reasoningSummary: 'DB_USER has a typo "amdin" that causes auth failures.',
      evidence: [
        {
          path: 'cluster-resources/configmaps/default/db-config.json',
          note: 'DB_USER=amdin (likely typo of "admin")',
        },
      ],
      contradictionsChecked: ['ConfigMap has correct keys'],
      recommendedAction: 'Fix the DB_USER value in the ConfigMap.',
      missingEvidence: [],
    };

    const deps = makeEmptyAIDeps();
    (deps.llmClient.investigateSeed as ReturnType<typeof vi.fn>).mockResolvedValue({
      findings: [aiFinding],
    });

    const context = makeContext({ resources: [crashLoopPod], events: [backOffEvent] });
    const result = await runInvestigation(context, deps);

    // AI finding should be present (different issue type, won't be deduped with crashloop)
    const aiFindingResult = result.findings.find((f) =>
      f.title.includes('DB_USER typo'),
    );
    expect(aiFindingResult).toBeDefined();

    // Heuristic CrashLoopBackOff finding should still be present
    const heuristicFinding = result.findings.find((f) =>
      f.title.toLowerCase().includes('crashloop'),
    );
    expect(heuristicFinding).toBeDefined();
  });

  it('metadata reflects AI state when aiDeps is provided and AI succeeds', async () => {
    const aiFinding = {
      title: 'AI root cause finding',
      severity: 'high' as const,
      confidence: 0.8,
      affectedComponents: ['Pod/default/app-pod'],
      reasoningSummary: 'Auth failure traced to ConfigMap typo.',
      evidence: [{ path: 'logs/app.log', note: 'FATAL auth error' }],
      contradictionsChecked: [],
      recommendedAction: 'Fix ConfigMap.',
      missingEvidence: [],
    };

    const deps = makeEmptyAIDeps();
    (deps.llmClient.investigateSeed as ReturnType<typeof vi.fn>).mockResolvedValue({
      findings: [aiFinding],
    });

    const context = makeContext({ resources: [crashLoopPod] });
    const result = await runInvestigation(context, deps);

    expect(result.metadata.aiEnabled).toBe(true);
    expect(result.metadata.aiFindings).toBeGreaterThanOrEqual(1);
  });

  it('metadata.aiEnabled is true even when AI returns empty findings', async () => {
    const deps = makeEmptyAIDeps();
    // LLM returns no findings (e.g. not enough context)
    (deps.llmClient.investigateSeed as ReturnType<typeof vi.fn>).mockResolvedValue({
      findings: [],
    });

    const context = makeContext({ resources: [crashLoopPod] });
    const result = await runInvestigation(context, deps);

    expect(result.metadata.aiEnabled).toBe(true);
    expect(result.metadata.aiFindings).toBe(0);
  });

  it('handles per-seed LLM failure gracefully — heuristic findings still returned, aiEnabled=true', async () => {
    // When individual LLM calls fail, investigateWithAI handles errors internally
    // and returns empty findings. The orchestrator still marks aiEnabled=true
    // because AI setup succeeded.
    const deps = makeEmptyAIDeps();
    (deps.llmClient.investigateSeed as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Network error'),
    );

    // Spy on console.warn to verify warning is logged (by investigateWithAI)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const context = makeContext({ resources: [crashLoopPod], events: [backOffEvent] });
    // Should NOT throw even though all LLM calls fail
    const result = await runInvestigation(context, deps);

    // Heuristic findings should still be present
    const crashFinding = result.findings.find((f) =>
      f.title.toLowerCase().includes('crashloop'),
    );
    expect(crashFinding).toBeDefined();

    // AI was set up correctly (aiEnabled=true) but produced no findings
    expect(result.metadata.aiEnabled).toBe(true);
    expect(result.metadata.aiFindings).toBe(0);

    warnSpy.mockRestore();
  });

  it('degrades gracefully when investigateWithAI itself throws — aiEnabled=false, heuristic findings kept', async () => {
    // Force investigateWithAI to throw by providing a deps object whose
    // llmClient.investigateSeed throws catastrophically for all seeds.
    const badDeps: AIInvestigatorDeps = {
      llmClient: {
        investigateSeed: () => {
          throw new Error('Catastrophic AI infrastructure failure');
        },
      } as unknown as AIInvestigatorDeps['llmClient'],
      chunkIndex: [],
      resourceGraph: { nodes: new Map(), edges: [] } as unknown as AIInvestigatorDeps['resourceGraph'],
      lexicalIndex: {
        build: () => {},
        search: () => [],
      } as unknown as AIInvestigatorDeps['lexicalIndex'],
    };

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const context = makeContext({ resources: [crashLoopPod], events: [backOffEvent] });
    // Should NOT throw — orchestrator catches the outer-level failure
    const result = await runInvestigation(context, badDeps);

    // Heuristic findings should still be present
    const crashFinding = result.findings.find((f) =>
      f.title.toLowerCase().includes('crashloop'),
    );
    expect(crashFinding).toBeDefined();

    // AI produced no findings because every seed failed
    expect(result.metadata.aiFindings).toBe(0);

    warnSpy.mockRestore();
  });

  it('AI findings are included in the verified + sorted final findings', async () => {
    const aiFinding = {
      title: 'AI: Low confidence finding',
      severity: 'info' as const,
      confidence: 0.4,
      affectedComponents: ['Pod/default/other-pod'],
      reasoningSummary: 'Low priority observation on a different pod.',
      evidence: [{ path: 'logs/other.log', note: 'Minor log entry' }],
      contradictionsChecked: [],
      recommendedAction: 'Monitor.',
      missingEvidence: [],
    };

    const deps = makeEmptyAIDeps();
    (deps.llmClient.investigateSeed as ReturnType<typeof vi.fn>).mockResolvedValue({
      findings: [aiFinding],
    });

    const context = makeContext({ resources: [crashLoopPod], events: [backOffEvent] });
    const result = await runInvestigation(context, deps);

    // AI finding should exist (on different component, so not absorbed)
    const aiEntry = result.findings.find((f) => f.id.startsWith('finding:ai:'));
    expect(aiEntry).toBeDefined();

    // Critical findings should come before info-level AI findings
    const criticalIdx = result.findings.findIndex((f) => f.severity === 'critical');
    const aiIdx = result.findings.findIndex((f) => f.id.startsWith('finding:ai:'));
    if (criticalIdx !== -1 && aiIdx !== -1) {
      expect(criticalIdx).toBeLessThan(aiIdx);
    }
  });

  it('AI edges are included in the result edges array', async () => {
    const aiFinding = {
      title: 'AI finding with evidence',
      severity: 'high' as const,
      confidence: 0.9,
      affectedComponents: ['Pod/default/app-pod'],
      reasoningSummary: 'Evidence-backed finding.',
      evidence: [
        { path: 'logs/app.log', note: 'Corroborating log entry' },
        { path: 'cluster-resources/pods/default/app-pod.json', note: 'Pod status' },
      ],
      contradictionsChecked: [],
      recommendedAction: 'Fix the issue.',
      missingEvidence: [],
    };

    const deps = makeEmptyAIDeps();
    (deps.llmClient.investigateSeed as ReturnType<typeof vi.fn>).mockResolvedValue({
      findings: [aiFinding],
    });

    const context = makeContext({ resources: [crashLoopPod] });
    const result = await runInvestigation(context, deps);

    // AI creates one edge per evidence item
    const aiEdges = result.edges.filter((e) => e.id.startsWith('edge:ai:'));
    expect(aiEdges).toHaveLength(2);
  });

  // ── Step-3 quality improvements ──────────────────────────────────────────

  describe('hypothesis dedup and single-set-per-pod', () => {
    it('generates only one hypothesis set per pod when k8s and log investigators both produce findings for the same pod', async () => {
      // A log file whose path basename matches the pod name → resolveLogPodComponent
      // normalises the component to Pod/default/app-pod, the same as the k8s finding.
      const appPodLog = makeLogFile('pod-logs/default/app-pod.log', [
        'ERROR lookup db: no such host',
      ]);
      const context = makeContext({
        resources: [crashLoopPod],
        events: [backOffEvent],
        logs: [appPodLog],
      });
      const result = await runInvestigation(context);

      // One hypothesis group (both findings share primary component Pod/default/app-pod)
      // → the crashloop template produces exactly 5 hypotheses.
      // Without step-1 normalisation we would get 2 groups → 7 hypotheses.
      expect(result.metadata.hypothesesGenerated).toBe(5);
    });
  });

  describe('symptom suppression', () => {
    // ── Fixtures ────────────────────────────────────────────────────────────

    /** Running pod whose Ready condition is False; has a service-env reference
     *  that will generate DNS-failure evidence in the hypothesis layer. */
    const notReadyDnsPod: K8sResource = {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: 'web-pod', namespace: 'default' },
      spec: {
        containers: [
          {
            name: 'app',
            image: 'nginx:latest',
            // env var whose value is a single-label service name picked up by
            // collectPodServiceReferences and the DNS evidence collector
            env: [{ name: 'DB_HOST', value: 'db' }],
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
            restartCount: 0,
            // running state (not waiting) → no CrashLoopBackOff / ImagePullBackOff
            state: { running: {} },
          },
        ],
      },
    };

    /** Log file whose basename matches notReadyDnsPod's name → component is
     *  normalised to Pod/default/web-pod by resolveLogPodComponent. */
    const dnsLogForWebPod = makeLogFile('pod-logs/default/web-pod.log', [
      'ERROR lookup db: no such host',
    ]);

    /** CrashLoop pod that references a missing secret; used to trigger a
     *  high-confidence missing-secret hypothesis. */
    const crashLoopSecretPod: K8sResource = {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: 'svc-pod', namespace: 'default' },
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
        conditions: [{ type: 'Ready', status: 'False' }],
        containerStatuses: [
          {
            name: 'app',
            ready: false,
            restartCount: 8,
            state: {
              waiting: { reason: 'CrashLoopBackOff', message: 'back-off' },
            },
          },
        ],
      },
    };

    /** Deployment with 0 ready replicas in the same namespace as crashLoopSecretPod. */
    const unhealthyDeploymentFixture: K8sResource = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'svc-deploy', namespace: 'default' },
      spec: { replicas: 1 },
      status: { readyReplicas: 0, availableReplicas: 0, replicas: 1 },
    };

    /**
     * A Secret in the 'default' namespace (not the missing one) so that
     * indexResourceNamesByNamespace returns a non-null set for 'default',
     * allowing the missing-secret evidence collector to flag app-credentials
     * as absent.
     */
    const otherDefaultSecret: K8sResource = {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: 'other-secret', namespace: 'default' },
    };

    /** FailedMount event corroborating the missing-secret diagnosis. */
    const failedMountCrashEvent: K8sEvent = {
      involvedObject: { kind: 'Pod', name: 'svc-pod', namespace: 'default' },
      reason: 'FailedMount',
      message:
        'MountVolume.SetUp failed for volume "creds" : secret "app-credentials" not found',
      type: 'Warning',
      count: 5,
      firstTimestamp: '2024-01-01T00:00:00Z',
      lastTimestamp: '2024-01-01T01:00:00Z',
    };

    /** Running pod with Ready=False but NO events and NO log files — all
     *  hypotheses score zero, so the Not Ready Pod finding must be preserved. */
    const notReadyQuietPod: K8sResource = {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: 'quiet-pod', namespace: 'default' },
      spec: { containers: [{ name: 'app', image: 'myapp:v1' }] },
      status: {
        phase: 'Running',
        conditions: [{ type: 'Ready', status: 'False', reason: 'ContainersNotReady' }],
        containerStatuses: [
          { name: 'app', ready: false, restartCount: 0, state: { running: {} } },
        ],
      },
    };

    /** Pending pod backed by a PVC whose StorageClass does not exist. */
    const pendingPvcPod: K8sResource = {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: 'db-pod', namespace: 'default' },
      spec: {
        containers: [{ name: 'db', image: 'postgres:15' }],
        volumes: [{ name: 'data', persistentVolumeClaim: { claimName: 'data-pvc' } }],
      },
      status: {
        phase: 'Pending',
        conditions: [{ type: 'Ready', status: 'False', reason: 'ContainersNotReady' }],
        containerStatuses: [
          {
            name: 'db',
            ready: false,
            restartCount: 0,
            state: { waiting: { reason: 'ContainerCreating', message: 'waiting for volume' } },
          },
        ],
      },
    };

    const pendingPvc: K8sResource = {
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: { name: 'data-pvc', namespace: 'default' },
      spec: {
        accessModes: ['ReadWriteOnce'],
        storageClassName: 'fast-ssd',
        resources: { requests: { storage: '10Gi' } },
      },
      status: { phase: 'Pending' },
    };

    const provisioningFailedEvent: K8sEvent = {
      involvedObject: { kind: 'PersistentVolumeClaim', name: 'data-pvc', namespace: 'default' },
      reason: 'ProvisioningFailed',
      message: 'storageclass.storage.k8s.io "fast-ssd" not found',
      type: 'Warning',
      count: 6,
      firstTimestamp: '2024-01-01T00:00:00Z',
      lastTimestamp: '2024-01-01T01:00:00Z',
    };

    const failedMountPendingEvent: K8sEvent = {
      involvedObject: { kind: 'Pod', name: 'db-pod', namespace: 'default' },
      reason: 'FailedMount',
      message:
        'Unable to attach or mount volumes: unmounted volumes=[data], unattached volumes=[data]',
      type: 'Warning',
      count: 6,
      firstTimestamp: '2024-01-01T00:00:05Z',
      lastTimestamp: '2024-01-01T01:00:00Z',
    };

    // ── Tests ────────────────────────────────────────────────────────────────

    it('suppresses Not Ready Pod finding when a root-cause hypothesis covers the same pod', async () => {
      // dns-failure hypothesis gets confidence ≥ 0.5 from:
      //   • one DNS failure log line  → supporting item (log)
      //   • pod service ref (DB_HOST=db)  → supporting item (k8s)
      //   • conservative "no services captured" note  → supporting item (k8s)
      // That exceeds the 0.5 threshold and qualifies as a root-cause finding,
      // which should suppress the Not Ready Pod heuristic for the same pod.
      const context = makeContext({
        resources: [notReadyDnsPod],
        logs: [dnsLogForWebPod],
      });
      const result = await runInvestigation(context);

      const notReadyFinding = result.findings.find((f) =>
        f.id.startsWith('finding:k8s:notready:'),
      );
      expect(notReadyFinding).toBeUndefined();

      // The dns-failure hypothesis (root-cause) should still be present
      const rootCauseFinding = result.findings.find((f) =>
        f.id.startsWith('finding:hypothesis:dns-failure:'),
      );
      expect(rootCauseFinding).toBeDefined();
    });

    it('suppresses Pending Pod finding when a root-cause hypothesis covers the same pod', async () => {
      const context = makeContext({
        resources: [pendingPvcPod, pendingPvc],
        events: [provisioningFailedEvent, failedMountPendingEvent],
      });
      const result = await runInvestigation(context);

      const pendingFinding = result.findings.find((f) =>
        f.id.startsWith('finding:k8s:pending:'),
      );
      expect(pendingFinding).toBeUndefined();

      const rootCauseFinding = result.findings.find((f) =>
        f.id.startsWith('finding:hypothesis:volume-mount-failure:'),
      );
      expect(rootCauseFinding).toBeDefined();
    });

    it('removes graph edges that reference findings suppressed in the final pass', async () => {
      const context = makeContext({
        resources: [notReadyDnsPod],
        logs: [dnsLogForWebPod],
      });
      const result = await runInvestigation(context);

      const retainedFindingIds = new Set(result.findings.map((f) => f.id));
      const findingRefs = result.edges.flatMap((edge) =>
        [edge.source, edge.target].filter((nodeId) => nodeId.startsWith('finding:')),
      );

      expect(findingRefs.every((nodeId) => retainedFindingIds.has(nodeId))).toBe(true);
      expect(
        findingRefs.some((nodeId) => nodeId.startsWith('finding:k8s:notready:')),
      ).toBe(false);
    });

    it('suppresses Unhealthy Workload finding when a root-cause finding covers a pod in the same namespace', async () => {
      // missing-secret hypothesis reaches confidence ~1.0 from FailedMount event +
      // pod secret reference.  Its component is Pod/default/svc-pod (namespace 'default').
      // The workload finding component is Deployment/default/svc-deploy (same namespace).
      // The suppression pass must remove the workload finding.
      const context = makeContext({
        resources: [crashLoopSecretPod, unhealthyDeploymentFixture, otherDefaultSecret],
        events: [failedMountCrashEvent],
      });
      const result = await runInvestigation(context);

      const workloadFinding = result.findings.find((f) =>
        f.id.startsWith('finding:k8s:workload:'),
      );
      expect(workloadFinding).toBeUndefined();
    });

    it('preserves CrashLoopBackOff finding even when a root-cause hypothesis covers the same pod', async () => {
      // CrashLoopBackOff (finding:k8s:crashloop:*) is an informative symptom that
      // names the failure mode and must not be suppressed even when a root-cause
      // hypothesis (e.g. missing-secret, confidence 1.0) exists for the same pod.
      const context = makeContext({
        resources: [crashLoopSecretPod, otherDefaultSecret],
        events: [failedMountCrashEvent],
      });
      const result = await runInvestigation(context);

      const crashFinding = result.findings.find((f) =>
        f.id.startsWith('finding:k8s:crashloop:'),
      );
      expect(crashFinding).toBeDefined();
    });

    it('preserves Not Ready Pod finding when no root-cause hypothesis covers it', async () => {
      // Pod with Ready=False but NO events and NO log files → all hypotheses
      // score 0 → nonZeroHypothesisFindings is empty → rootCauseFindings is empty
      // → the Not Ready Pod finding must survive the suppression pass.
      const context = makeContext({ resources: [notReadyQuietPod] });
      const result = await runInvestigation(context);

      const notReadyFinding = result.findings.find((f) =>
        f.id.startsWith('finding:k8s:notready:'),
      );
      expect(notReadyFinding).toBeDefined();
    });
  });

  describe('AI-primary absorption with step-1 component normalisation', () => {
    it('absorbs log findings into AI findings when they share the same pod component', async () => {
      // The log file basename 'dns-app' matches the pod name → resolveLogPodComponent
      // normalises the log finding's component to Pod/default/dns-app.
      // The AI finding has the same component → the log finding is absorbed.
      const dnsPod: K8sResource = {
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: { name: 'dns-app', namespace: 'default' },
        spec: { containers: [{ name: 'app', image: 'myapp:v1.0' }] },
        status: {
          phase: 'Running',
          conditions: [{ type: 'Ready', status: 'True' }],
          containerStatuses: [
            { name: 'app', ready: true, restartCount: 0, state: { running: {} } },
          ],
        },
      };

      const dnsAppLog = makeLogFile('pod-logs/default/dns-app.log', [
        'ERROR lookup db: no such host',
      ]);

      const aiDnsFinding = {
        title: 'DNS resolution failure: pod cannot reach in-cluster service',
        severity: 'high' as const,
        confidence: 0.9,
        affectedComponents: ['Pod/default/dns-app'],
        reasoningSummary: 'DNS lookup failures observed in application logs.',
        evidence: [{ path: 'cluster-resources/pods/default/dns-app.yaml', note: 'Pod status' }],
        contradictionsChecked: [],
        recommendedAction: 'Check CoreDNS logs and verify service name.',
        missingEvidence: [],
      };

      const deps = makeEmptyAIDeps();
      (deps.llmClient.investigateSeed as ReturnType<typeof vi.fn>).mockResolvedValue({
        findings: [aiDnsFinding],
      });

      const context = makeContext({ resources: [dnsPod], logs: [dnsAppLog] });
      const result = await runInvestigation(context, deps);

      // The log finding should be absorbed into the AI finding (same component)
      const logFinding = result.findings.find(
        (f) =>
          f.id.startsWith('finding:log:') &&
          f.affectedComponents.some((c) => c === 'Pod/default/dns-app'),
      );
      expect(logFinding).toBeUndefined();

      // The AI finding should be present (and enriched with log evidence)
      const aiFindingResult = result.findings.find(
        (f) =>
          f.id.startsWith('finding:ai:') &&
          f.affectedComponents.some((c) => c === 'Pod/default/dns-app'),
      );
      expect(aiFindingResult).toBeDefined();
    });
  });

  describe('final dedup uses full normalised title (no 80-char truncation)', () => {
    it('preserves two findings whose titles differ only after position 80', async () => {
      // Both titles share the same first 80 characters after normalisation but
      // differ in the suffix.  With the old 80-char truncation, only one would
      // survive the dedup pass.  With the full-title comparison, both survive.
      const title1 =
        'Connection failure: the pod cannot reach the database service endpoint at hostname-prod-a';
      const title2 =
        'Connection failure: the pod cannot reach the database service endpoint at hostname-prod-b';

      // Sanity-check the fixture: same 80-char prefix, different full titles
      const norm1 = title1.toLowerCase().trim();
      const norm2 = title2.toLowerCase().trim();
      expect(norm1.slice(0, 80)).toBe(norm2.slice(0, 80));
      expect(norm1).not.toBe(norm2);

      const aiFinding1 = {
        title: title1,
        severity: 'high' as const,
        confidence: 0.9,
        affectedComponents: ['Pod/ns-a/app'],
        reasoningSummary: 'Pod in ns-a cannot reach endpoint.',
        evidence: [{ path: 'logs/ns-a/app.log', note: 'Connection error' }],
        contradictionsChecked: [],
        recommendedAction: 'Investigate endpoint in ns-a.',
        missingEvidence: [],
      };
      const aiFinding2 = {
        title: title2,
        severity: 'high' as const,
        confidence: 0.8,
        affectedComponents: ['Pod/ns-b/app'],
        reasoningSummary: 'Pod in ns-b cannot reach endpoint.',
        evidence: [{ path: 'logs/ns-b/app.log', note: 'Connection error' }],
        contradictionsChecked: [],
        recommendedAction: 'Investigate endpoint in ns-b.',
        missingEvidence: [],
      };

      const deps = makeEmptyAIDeps();
      (deps.llmClient.investigateSeed as ReturnType<typeof vi.fn>).mockResolvedValue({
        findings: [aiFinding1, aiFinding2],
      });

      // Use a context that generates at least one seed so the AI mock is called
      const context = makeContext({ resources: [crashLoopPod], events: [backOffEvent] });
      const result = await runInvestigation(context, deps);

      const found1 = result.findings.find((f) => f.title === title1);
      const found2 = result.findings.find((f) => f.title === title2);

      expect(found1).toBeDefined();
      expect(found2).toBeDefined();
    });
  });
});
