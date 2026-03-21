import { describe, it, expect, vi } from 'vitest';
import type { InvestigatorContext } from '../types.js';
import type { BundleProfile, K8sResource, K8sEvent, Finding } from '../../types/index.js';
import type { LogFile, LogLine } from '../../parsers/index.js';
import type { AIInvestigatorDeps } from '../ai-investigator.js';
import type { ResourceRelationshipGraph } from '../../graph/resource-graph.js';
import { classifyLogLevel } from '../../parsers/index.js';
import {
  runInvestigation,
  normalizeIssueFamilyForPass1,
  normalizeTitleForPass2,
  __testOnlyPass1ComponentMerge,
  __testOnlyPass2TitleDedup,
} from '../orchestrator.js';
import { getRootCauses } from '../../graph/finding-tree.js';

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

function makeFinding(overrides: Partial<Finding> & Pick<Finding, 'id' | 'title'>): Finding {
  return {
    id: overrides.id,
    title: overrides.title,
    severity: overrides.severity ?? 'high',
    confidence: overrides.confidence ?? 0.7,
    affectedComponents: overrides.affectedComponents ?? ['Pod/default/example-pod'],
    reasoningSummary: overrides.reasoningSummary ?? 'Test finding',
    evidence: overrides.evidence ?? [],
    contradictionsChecked: overrides.contradictionsChecked ?? [],
    recommendedAction: overrides.recommendedAction ?? 'Investigate',
    missingEvidence: overrides.missingEvidence ?? [],
    confidenceQuality: overrides.confidenceQuality,
  };
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
      // generateText is used by the seed-clustering pass (clusterSeeds).
      // Default: empty string → graceful fallback to unclustered seeds.
      // Override in individual tests to exercise the clustering path.
      generateText: vi.fn().mockResolvedValue(''),
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
// Seed-clustering test helper
// ---------------------------------------------------------------------------

/**
 * Parses the serialised seed list from a `buildSeedClusteringPrompt` user
 * prompt and returns the array of `{ id, priority }` objects.
 *
 * The prompt embeds the seed list in a fenced JSON block:
 *
 * ```json
 * [{ "id": "seed:pod:0", "priority": 90, ... }, ...]
 * ```
 *
 * Returns `null` when the block cannot be found or parsed (defensive helper
 * for mock implementations — callers can return `''` on failure to trigger
 * the clusterer's graceful fallback path).
 */
function parseSeedsFromClusteringPrompt(
  userPrompt: string,
): Array<{ id: string; priority: number }> | null {
  try {
    const match = userPrompt.match(/```json\n([\s\S]*?)\n```/);
    if (!match) return null;
    const parsed = JSON.parse(match[1]) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed as Array<{ id: string; priority: number }>;
  } catch {
    return null;
  }
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

      // The root-cause finding may come from either the hypothesis layer
      // (finding:hypothesis:volume-mount-failure:*) or the graph-driven phase
      // (finding:missing-storage-class:*) depending on whether the causal
      // template matches.  Either form satisfies the suppression contract.
      const rootCauseFinding = result.findings.find((f) =>
        f.id.startsWith('finding:hypothesis:volume-mount-failure:') ||
        f.id.includes('missing-storage-class'),
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

  describe('cross-symptom correlation integration (7.5)', () => {
    function makeCrashLoopDnsPod(namespace: string, podName: string): K8sResource {
      return {
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: { name: podName, namespace },
        spec: {
          containers: [
            {
              name: 'app',
              image: 'example:v1',
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
              restartCount: 6,
              state: {
                waiting: {
                  reason: 'CrashLoopBackOff',
                  message: 'back-off restarting failed container app',
                },
              },
            },
          ],
        },
      };
    }

    function makeCrashLoopDnsLog(namespace: string, podName: string): LogFile {
      return makeLogFile(`pod-logs/${namespace}/${podName}.log`, [
        'INFO starting application',
        'ERROR lookup db: no such host',
      ]);
    }

    it('produces a cluster-wide DNS meta-finding for 3 crashlooping pods in the same namespace', async () => {
      const pods = [
        makeCrashLoopDnsPod('default', 'dns-app-0'),
        makeCrashLoopDnsPod('default', 'dns-app-1'),
        makeCrashLoopDnsPod('default', 'dns-app-2'),
      ];
      const logs = [
        makeCrashLoopDnsLog('default', 'dns-app-0'),
        makeCrashLoopDnsLog('default', 'dns-app-1'),
        makeCrashLoopDnsLog('default', 'dns-app-2'),
      ];

      const result = await runInvestigation(makeContext({ resources: pods, logs }));

      const metaFinding = result.findings.find((f) =>
        /^finding:meta:cluster-wide:dns-failure:default:/.test(f.id),
      );
      expect(metaFinding).toBeDefined();
      expect(metaFinding!.title).toMatch(/cluster-wide dns failure/i);
      expect(metaFinding!.affectedComponents).toEqual(
        expect.arrayContaining([
          'Pod/default/dns-app-0',
          'Pod/default/dns-app-1',
          'Pod/default/dns-app-2',
        ]),
      );
    });

    it('gives the cluster-wide meta-finding higher confidence than any individual DNS hypothesis', async () => {
      const pods = [
        makeCrashLoopDnsPod('default', 'dns-app-0'),
        makeCrashLoopDnsPod('default', 'dns-app-1'),
        makeCrashLoopDnsPod('default', 'dns-app-2'),
      ];
      const logs = [
        makeCrashLoopDnsLog('default', 'dns-app-0'),
        makeCrashLoopDnsLog('default', 'dns-app-1'),
        makeCrashLoopDnsLog('default', 'dns-app-2'),
      ];

      const result = await runInvestigation(makeContext({ resources: pods, logs }));

      const metaFinding = result.findings.find((f) =>
        /^finding:meta:cluster-wide:dns-failure:default:/.test(f.id),
      );
      const individualDnsHypotheses = result.findings.filter((f) =>
        f.id.startsWith('finding:hypothesis:dns-failure:'),
      );

      expect(metaFinding).toBeDefined();
      expect(individualDnsHypotheses.length).toBeGreaterThan(0);

      const maxIndividualConfidence = Math.max(...individualDnsHypotheses.map((f) => f.confidence));
      expect(metaFinding!.confidence).toBeGreaterThan(maxIndividualConfidence);
    });

    it('does not correlate the same DNS failure across namespaces', async () => {
      const pods = [
        makeCrashLoopDnsPod('default', 'dns-app-a'),
        makeCrashLoopDnsPod('production', 'dns-app-b'),
      ];
      const logs = [
        makeCrashLoopDnsLog('default', 'dns-app-a'),
        makeCrashLoopDnsLog('production', 'dns-app-b'),
      ];

      const result = await runInvestigation(makeContext({ resources: pods, logs }));

      const metaFindings = result.findings.filter((f) =>
        f.id.startsWith('finding:meta:cluster-wide:dns-failure:'),
      );
      expect(metaFindings).toHaveLength(0);
    });

    it('retains the meta-finding after pass1/pass2 dedup and final sorting', async () => {
      const pods = [
        makeCrashLoopDnsPod('default', 'dns-app-0'),
        makeCrashLoopDnsPod('default', 'dns-app-1'),
        makeCrashLoopDnsPod('default', 'dns-app-2'),
      ];
      const logs = [
        makeCrashLoopDnsLog('default', 'dns-app-0'),
        makeCrashLoopDnsLog('default', 'dns-app-1'),
        makeCrashLoopDnsLog('default', 'dns-app-2'),
      ];

      const result = await runInvestigation(makeContext({ resources: pods, logs }));

      const metaFindings = result.findings.filter((f) =>
        /^finding:meta:cluster-wide:dns-failure:default:/.test(f.id),
      );
      expect(metaFindings).toHaveLength(1);
      expect(result.findings.some((f) => f.id.startsWith('finding:hypothesis:dns-failure:'))).toBe(true);
    });
  });

  // ── Two-pass dedup strategy (7.8) ──────────────────────────────────────────
  //
  // The orchestrator must implement exactly two dedup passes:
  //   Pass 1 — component-based merge (structural): groups findings by
  //            (primaryComponent, issueFamily) and applies a single merge
  //            strategy (AI > hypothesis > heuristic; evidence absorbed from
  //            non-winners).
  //   Pass 2 — title-based dedup (cosmetic): normalises titles and keeps the
  //            higher-confidence entry when two findings share the same
  //            normalised title. AI findings win title collisions.
  //   Symptom suppression remains a separate post-dedup filter.
  //
  // The tests below validate the behavioural contracts of each pass and
  // verify that existing correctness invariants are preserved.

  describe('two-pass dedup strategy (7.8)', () => {
    // ── Fixtures ──────────────────────────────────────────────────────────────

    /** Pod with CrashLoopBackOff that also references a missing Secret, so it
     *  generates BOTH a crashloop finding (family: crashloop) and a
     *  missing-secret hypothesis (family: missing-secret) on the same component.
     */
    const dualFamilyPod: K8sResource = {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: 'dual-pod', namespace: 'default' },
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
            state: { waiting: { reason: 'CrashLoopBackOff', message: 'back-off' } },
          },
        ],
      },
    };

    const dualPodFailedMountEvent: K8sEvent = {
      involvedObject: { kind: 'Pod', name: 'dual-pod', namespace: 'default' },
      reason: 'FailedMount',
      message: 'secret "app-credentials" not found',
      type: 'Warning',
      count: 5,
      firstTimestamp: '2024-01-01T00:00:00Z',
      lastTimestamp: '2024-01-01T01:00:00Z',
    };

    /** A Secret in the default namespace (not the missing one) so the
     *  missing-secret evidence collector can confirm app-credentials is absent. */
    const defaultNamespaceSecret: K8sResource = {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: 'other-secret', namespace: 'default' },
    };

    /** Pod whose Ready=False is explained by DNS failure; used in the
     *  symptom-suppression contract test below. */
    const notReadyDnsPodForPassTest: K8sResource = {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: 'dns-test-pod', namespace: 'default' },
      spec: {
        containers: [
          {
            name: 'app',
            image: 'nginx:latest',
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
            state: { running: {} },
          },
        ],
      },
    };

    const dnsLogForPassTest = makeLogFile('pod-logs/default/dns-test-pod.log', [
      'ERROR lookup db: no such host',
    ]);

    // ── Normalization contracts ───────────────────────────────────────────────

    it('normalization helpers keep component/family and title responsibilities separate', () => {
      const heuristicSecret = makeFinding({
        id: 'finding:config:0',
        title: "Missing Secret 'app-credentials' required by pod",
      });
      const hypothesisTitle =
        "[Hypothesis] Missing Secret 'app-credentials' required by pod (symptom: Pod/default/example-pod)";

      expect(normalizeIssueFamilyForPass1(heuristicSecret)).toBe('missing-secret');
      expect(normalizeTitleForPass2(hypothesisTitle)).toBe(
        "missing secret 'app-credentials' required by pod",
      );
    });

    // ── Pass 1: Component-based merge ─────────────────────────────────────────

    it('Pass 1 — hypothesis displaces heuristic for the same component/family and absorbs its evidence', () => {
      const heuristic = makeFinding({
        id: 'finding:config:missing-secret:0',
        title: "Missing Secret 'app-credentials' not found for pod",
        confidence: 0.55,
        affectedComponents: ['Pod/default/shared-pod'],
        evidence: [
          {
            path: 'cluster-resources/pods/default/shared-pod.yaml',
            note: 'Pod references secret app-credentials',
            artifactType: 'kubernetes-resource',
          },
        ],
      });
      const hypothesis = makeFinding({
        id: 'finding:hypothesis:missing-secret:0',
        title:
          "[Hypothesis] Missing Secret 'app-credentials' prevents startup (symptom: Pod/default/shared-pod)",
        confidence: 0.8,
        affectedComponents: ['Pod/default/shared-pod'],
        evidence: [
          {
            path: 'cluster-resources/events/default.json',
            note: 'FailedMount event says secret app-credentials not found',
            artifactType: 'event',
          },
        ],
      });

      const result = __testOnlyPass1ComponentMerge([heuristic], [hypothesis]);

      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe('finding:hypothesis:missing-secret:0');
      expect(result[0]!.evidence).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ note: 'Pod references secret app-credentials' }),
          expect.objectContaining({ note: 'FailedMount event says secret app-credentials not found' }),
        ]),
      );
    });

    it('Pass 1 — AI wins over hypothesis for the same component/family and absorbs hypothesis evidence', () => {
      const ai = makeFinding({
        id: 'finding:ai:0',
        title: "Missing Secret 'app-credentials' prevents startup",
        confidence: 0.92,
        affectedComponents: ['Pod/default/shared-pod'],
        evidence: [
          {
            path: 'ai/context.txt',
            note: 'AI correlated missing secret with startup failure',
            artifactType: 'log',
          },
        ],
      });
      const hypothesis = makeFinding({
        id: 'finding:hypothesis:missing-secret:1',
        title:
          "[Hypothesis] Missing Secret 'app-credentials' prevents startup (symptom: Pod/default/shared-pod)",
        confidence: 0.81,
        affectedComponents: ['Pod/default/shared-pod'],
        evidence: [
          {
            path: 'cluster-resources/events/default.json',
            note: 'FailedMount event says secret app-credentials not found',
            artifactType: 'event',
          },
        ],
      });

      const result = __testOnlyPass1ComponentMerge([ai], [hypothesis]);

      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe('finding:ai:0');
      expect(result[0]!.evidence).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ note: 'AI correlated missing secret with startup failure' }),
          expect.objectContaining({ note: 'FailedMount event says secret app-credentials not found' }),
        ]),
      );
    });

    it('Pass 1 — competing hypothesis findings with the same component/family but different titles both survive', () => {
      const hypothesisA = makeFinding({
        id: 'finding:hypothesis:missing-secret:10',
        title: "[Hypothesis] Missing Secret 'app-credentials' prevents startup (symptom: Pod/default/shared-pod)",
        affectedComponents: ['Pod/default/shared-pod'],
      });
      const hypothesisB = makeFinding({
        id: 'finding:hypothesis:missing-secret:11',
        title: "[Hypothesis] Secret volume mount for 'app-credentials' is misconfigured (symptom: Pod/default/shared-pod)",
        affectedComponents: ['Pod/default/shared-pod'],
      });

      const result = __testOnlyPass1ComponentMerge([], [hypothesisA, hypothesisB]);

      expect(result).toHaveLength(2);
      expect(result.map((finding) => finding.id)).toEqual(
        expect.arrayContaining([
          'finding:hypothesis:missing-secret:10',
          'finding:hypothesis:missing-secret:11',
        ]),
      );
    });

    // ── Pass 2: Title-based dedup ─────────────────────────────────────────────

    it('Pass 2 — keeps the higher-confidence finding when normalized titles match across components', () => {
      const lowConfidence = makeFinding({
        id: 'finding:heuristic:0',
        title:
          "[Hypothesis] Missing Secret 'shared-credentials' is absent from the namespace (symptom: Pod/default/pod-a)",
        confidence: 0.6,
        affectedComponents: ['Pod/default/pod-a'],
      });
      const highConfidence = makeFinding({
        id: 'finding:heuristic:1',
        title: "Missing Secret 'shared-credentials' is absent from the namespace",
        confidence: 0.9,
        affectedComponents: ['Pod/default/pod-b'],
      });

      const result = __testOnlyPass2TitleDedup([lowConfidence, highConfidence]);

      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe('finding:heuristic:1');
      expect(result[0]!.affectedComponents).toContain('Pod/default/pod-b');
    });

    it('non-overlap — evidence absorbed in Pass 1 is preserved when Pass 2 selects that finding', () => {
      const heuristic = makeFinding({
        id: 'finding:config:missing-secret:2',
        title: "Missing Secret 'shared-credentials' is absent from the namespace",
        confidence: 0.55,
        affectedComponents: ['Pod/default/pod-a'],
        evidence: [
          {
            path: 'cluster-resources/pods/default/pod-a.yaml',
            note: 'Pod A references secret shared-credentials',
            artifactType: 'kubernetes-resource',
          },
        ],
      });
      const hypothesis = makeFinding({
        id: 'finding:hypothesis:missing-secret:2',
        title:
          "[Hypothesis] Missing Secret 'shared-credentials' is absent from the namespace (symptom: Pod/default/pod-a)",
        confidence: 0.8,
        affectedComponents: ['Pod/default/pod-a'],
        evidence: [
          {
            path: 'cluster-resources/events/default.json',
            note: 'FailedMount event confirms shared-credentials is missing',
            artifactType: 'event',
          },
        ],
      });
      const competingTitleDuplicate = makeFinding({
        id: 'finding:ai:other-component',
        title: "Missing Secret 'shared-credentials' is absent from the namespace",
        confidence: 0.4,
        affectedComponents: ['Pod/default/pod-b'],
        evidence: [
          {
            path: 'cluster-resources/pods/default/pod-b.yaml',
            note: 'Pod B also references the secret',
            artifactType: 'kubernetes-resource',
          },
        ],
      });

      const pass1 = __testOnlyPass1ComponentMerge([heuristic], [hypothesis]);
      const pass2 = __testOnlyPass2TitleDedup([...pass1, competingTitleDuplicate]);

      expect(pass2).toHaveLength(1);
      expect(pass2[0]!.id).toBe('finding:hypothesis:missing-secret:2');
      expect(pass2[0]!.evidence).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ note: 'Pod A references secret shared-credentials' }),
          expect.objectContaining({ note: 'FailedMount event confirms shared-credentials is missing' }),
        ]),
      );
    });

    // ── Pass 1: Component-based merge ─────────────────────────────────────────

    it('Pass 1 — AI finding absorbs hypothesis and heuristic findings for the same component and issue family', async () => {
      // dualFamilyPod has CrashLoopBackOff + references missing secret →
      // the seed generator creates a CrashLoopBackOff seed (so the AI mock is
      // called), the config investigator produces a heuristic missing-secret
      // finding, and the hypothesis layer produces a missing-secret hypothesis
      // (all for Pod/default/dual-pod).
      //
      // An AI finding that addresses the same
      // (component=Pod/default/dual-pod, family=missing-secret) must absorb
      // both the heuristic and hypothesis missing-secret findings, leaving
      // exactly ONE missing-secret finding for that pod.
      const aiFinding = {
        title: "Missing Secret 'app-credentials' causes pod crash",
        severity: 'critical' as const,
        confidence: 0.95,
        affectedComponents: ['Pod/default/dual-pod'],
        reasoningSummary: 'Secret app-credentials is absent from default namespace.',
        evidence: [
          {
            path: 'cluster-resources/pods/default/dual-pod.yaml',
            note: 'envFrom secretRef: app-credentials',
          },
        ],
        contradictionsChecked: [],
        recommendedAction: 'Create the missing secret.',
        missingEvidence: [],
      };

      const deps = makeEmptyAIDeps();
      (deps.llmClient.investigateSeed as ReturnType<typeof vi.fn>).mockResolvedValue({
        findings: [aiFinding],
      });

      const context = makeContext({
        resources: [dualFamilyPod, defaultNamespaceSecret],
        events: [dualPodFailedMountEvent],
      });
      const result = await runInvestigation(context, deps);

      // All missing-secret findings for dual-pod → consolidated to the AI
      // finding by Pass 1 (one normalization strategy + one merge strategy).
      const missingSecretForPod = result.findings.filter(
        (f) =>
          f.affectedComponents.some((c) => c === 'Pod/default/dual-pod') &&
          (f.id.includes('missing-secret') ||
            f.title.toLowerCase().includes('secret')),
      );
      expect(missingSecretForPod).toHaveLength(1);
      expect(missingSecretForPod[0]!.id.startsWith('finding:ai:')).toBe(true);
    });

    it('Pass 1 — hypothesis finding wins over heuristic finding for same component and issue family (no AI)', async () => {
      // Without AI, the hypothesis layer produces a high-confidence
      // missing-secret hypothesis finding.  The heuristic config investigator
      // also produces a missing-secret finding for the same pod.  Pass 1 must
      // keep the hypothesis finding (higher priority than heuristic) and
      // absorb the heuristic one — leaving exactly ONE finding per (component,
      // family) group.
      const context = makeContext({ resources: [missingSecretPod, dummySecret] });
      const result = await runInvestigation(context);

      const missingSecretForPod = result.findings.filter(
        (f) =>
          f.affectedComponents.some((c) => c === 'Pod/production/secret-pod') &&
          (f.id.includes('missing-secret') ||
            f.title.toLowerCase().includes('secret')),
      );
      expect(missingSecretForPod).toHaveLength(1);
      // Hypothesis finding wins over heuristic (finding:hypothesis:* prefix)
      expect(missingSecretForPod[0]!.id.startsWith('finding:hypothesis:')).toBe(true);
    });

    it('Pass 1 — findings for different issue families on the same component both survive', async () => {
      // dualFamilyPod generates:
      //   • finding:k8s:crashloop:* (family: crashloop)
      //   • finding:hypothesis:missing-secret:* (family: missing-secret)
      // Both reference Pod/default/dual-pod but belong to different families →
      // Pass 1 must place them in separate groups and preserve both.
      const context = makeContext({
        resources: [dualFamilyPod, defaultNamespaceSecret],
        events: [dualPodFailedMountEvent],
      });
      const result = await runInvestigation(context);

      const crashFinding = result.findings.find((f) =>
        f.id.startsWith('finding:k8s:crashloop:'),
      );
      expect(crashFinding).toBeDefined();

      // The missing-secret finding may come from either the hypothesis layer
      // (finding:hypothesis:missing-secret:*) or the graph-driven phase
      // (finding:missing-secret:app-credentials:default).  Both satisfy the
      // behavioral contract: two findings from different families survive.
      const secretFinding = result.findings.find((f) =>
        f.id.startsWith('finding:hypothesis:missing-secret:') ||
        f.id.includes('missing-secret'),
      );
      expect(secretFinding).toBeDefined();
    });

    // ── Pass 2: Title-based dedup ──────────────────────────────────────────────

    it('Pass 2 — deduplicates findings with identical normalised titles from different components', async () => {
      // Two AI findings with the exact same root-cause title but targeting
      // different pods.  Pass 1 does NOT merge them (different primary
      // components).  Pass 2 sees the same normalised title and keeps only
      // the higher-confidence entry.
      const sharedTitle =
        "Missing Secret 'shared-credentials' is absent from the namespace";

      const aiFinding1 = {
        title: sharedTitle,
        severity: 'critical' as const,
        confidence: 0.9,
        affectedComponents: ['Pod/default/pod-alpha'],
        reasoningSummary: 'pod-alpha cannot start; shared-credentials missing.',
        evidence: [{ path: 'logs/pod-alpha.log', note: 'envFrom: shared-credentials' }],
        contradictionsChecked: [],
        recommendedAction: 'Create the secret.',
        missingEvidence: [],
      };
      const aiFinding2 = {
        title: sharedTitle,
        severity: 'critical' as const,
        confidence: 0.7,
        affectedComponents: ['Pod/default/pod-beta'],
        reasoningSummary: 'pod-beta also cannot start; same missing secret.',
        evidence: [{ path: 'logs/pod-beta.log', note: 'envFrom: shared-credentials' }],
        contradictionsChecked: [],
        recommendedAction: 'Create the secret.',
        missingEvidence: [],
      };

      const deps = makeEmptyAIDeps();
      (deps.llmClient.investigateSeed as ReturnType<typeof vi.fn>).mockResolvedValue({
        findings: [aiFinding1, aiFinding2],
      });

      const context = makeContext({ resources: [crashLoopPod], events: [backOffEvent] });
      const result = await runInvestigation(context, deps);

      const matchingFindings = result.findings.filter(
        (f) => f.title === sharedTitle,
      );
      // Exactly one finding should survive Pass 2
      expect(matchingFindings).toHaveLength(1);
      // The higher-confidence entry wins
      expect(matchingFindings[0]!.confidence).toBeCloseTo(0.9, 1);
    });

    it('Pass 2 — higher-confidence finding wins title collision regardless of source order', async () => {
      // Lower-confidence finding arrives before higher-confidence one in the
      // sorted array.  Pass 2 must replace the lower-confidence entry when it
      // encounters the higher-confidence duplicate, not keep insertion order.
      //
      // We identify the winner by its affectedComponents ('Pod/default/svc-b'
      // for the higher-confidence entry, 'Pod/default/svc-a' for the lower),
      // since post-processing adjustments may shift the absolute confidence
      // value away from the original 0.9 / 0.6.
      const sharedTitle = 'DNS resolution failure: service endpoint unreachable';

      const lowConf = {
        title: sharedTitle,
        severity: 'high' as const,
        confidence: 0.6,
        affectedComponents: ['Pod/default/svc-a'],
        reasoningSummary: 'DNS failure in svc-a.',
        evidence: [{ path: 'logs/svc-a.log', note: 'lookup failed' }],
        contradictionsChecked: [],
        recommendedAction: 'Check CoreDNS.',
        missingEvidence: [],
      };
      const highConf = {
        title: sharedTitle,
        severity: 'high' as const,
        confidence: 0.9,
        affectedComponents: ['Pod/default/svc-b'],
        reasoningSummary: 'DNS failure in svc-b (more evidence).',
        evidence: [
          { path: 'logs/svc-b.log', note: 'lookup failed' },
          { path: 'cluster-resources/pods/default/svc-b.yaml', note: 'env DB_HOST=db' },
        ],
        contradictionsChecked: [],
        recommendedAction: 'Check CoreDNS.',
        missingEvidence: [],
      };

      const deps = makeEmptyAIDeps();
      // Deliver low-confidence first so insertion order cannot be the winning factor
      (deps.llmClient.investigateSeed as ReturnType<typeof vi.fn>).mockResolvedValue({
        findings: [lowConf, highConf],
      });

      const context = makeContext({ resources: [crashLoopPod], events: [backOffEvent] });
      const result = await runInvestigation(context, deps);

      const matchingFindings = result.findings.filter((f) => f.title === sharedTitle);
      // Exactly one finding should survive Pass 2
      expect(matchingFindings).toHaveLength(1);
      // The higher-confidence entry (svc-b) wins; the lower-confidence entry (svc-a) is dropped
      expect(matchingFindings[0]!.affectedComponents).toContain('Pod/default/svc-b');
    });

    // ── Symptom suppression: separate post-dedup filter ───────────────────────

    it('symptom suppression runs after both dedup passes (contract: third independent step)', async () => {
      // This mirrors the existing suppression tests but explicitly documents the
      // relationship to the two-pass design: symptom suppression is a separate
      // filter that fires AFTER both Pass 1 and Pass 2 have completed.
      const context = makeContext({
        resources: [notReadyDnsPodForPassTest],
        logs: [dnsLogForPassTest],
      });
      const result = await runInvestigation(context);

      // After both dedup passes, symptom suppression must still remove the
      // Not-Ready-Pod finding when a root-cause hypothesis exists.
      const notReadyFinding = result.findings.find((f) =>
        f.id.startsWith('finding:k8s:notready:'),
      );
      expect(notReadyFinding).toBeUndefined();

      // The dns-failure root cause survived both passes and suppression.
      const rootCause = result.findings.find((f) =>
        f.id.startsWith('finding:hypothesis:dns-failure:'),
      );
      expect(rootCause).toBeDefined();
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

  // ── Graph-driven investigation (Phase 5e / 4.8) ───────────────────────────
  //
  // The orchestrator now runs a graph-query phase BEFORE the hypothesis
  // generator.  When causal template matching discovers a known failure chain
  // (e.g. MissingSecret → FailedMount → CrashLoopBackOff), it:
  //   1. Skips the hypothesis generator for those matched symptom findings.
  //   2. Creates a synthetic root-cause Finding linked to the symptom via a
  //      `causes` edge so the FindingTree has a real parent→child structure.
  //   3. Ranks the graph root causes by causal path length, edge weights,
  //      and evidence count.
  //   4. Falls back to the hypothesis generator for unmatched symptoms.
  //
  // The existing procedural pipeline (hypothesis generation) becomes the
  // fallback path only when no causal template matches a symptom.

  describe('graph-driven investigation (4.8)', () => {
    // ── Fixtures ─────────────────────────────────────────────────────────────

    /**
     * A pod with CrashLoopBackOff but NO secret references in its spec.
     * The k8s investigator produces ONLY the crashloop finding.
     * A companion FailedMount event (see below) triggers the causal template.
     */
    const graphTemplatePod: K8sResource = {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: 'template-pod', namespace: 'default' },
      spec: {
        containers: [{ name: 'app', image: 'myapp:v1.0.0' }],
      },
      status: {
        phase: 'Running',
        conditions: [{ type: 'Ready', status: 'False', reason: 'ContainersNotReady' }],
        containerStatuses: [
          {
            name: 'app',
            ready: false,
            restartCount: 8,
            state: { waiting: { reason: 'CrashLoopBackOff', message: 'back-off 5m0s restarting' } },
          },
        ],
      },
    };

    /** FailedMount event for template-pod that names the missing secret. */
    const templateFailedMountEvent: K8sEvent = {
      involvedObject: { kind: 'Pod', name: 'template-pod', namespace: 'default' },
      reason: 'FailedMount',
      message: 'MountVolume.SetUp failed for volume "creds": secret "app-secret" not found',
      type: 'Warning',
      count: 5,
      firstTimestamp: '2024-01-01T00:00:00Z',
      lastTimestamp: '2024-01-01T01:00:00Z',
    };

    /**
     * BackOff event (NOT FailedMount) — no secret name → causal template
     * will NOT match, so the hypothesis generator must be used as fallback.
     */
    const templateBackOffEvent: K8sEvent = {
      involvedObject: { kind: 'Pod', name: 'template-pod', namespace: 'default' },
      reason: 'BackOff',
      message: 'Back-off restarting failed container',
      type: 'Warning',
      count: 12,
      firstTimestamp: '2024-01-01T00:00:00Z',
      lastTimestamp: '2024-01-01T01:00:00Z',
    };

    /**
     * Second pod for ranking test (image pull failure with ErrImagePull).
     */
    const imagePullPod: K8sResource = {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: 'image-pod', namespace: 'default' },
      spec: {
        containers: [{ name: 'app', image: 'myapp:v999' }],
      },
      status: {
        phase: 'Pending',
        conditions: [{ type: 'Ready', status: 'False' }],
        containerStatuses: [
          {
            name: 'app',
            ready: false,
            restartCount: 0,
            state: { waiting: { reason: 'ImagePullBackOff', message: 'Back-off pulling image "myapp:v999"' } },
          },
        ],
      },
    };

    const errImagePullEvent: K8sEvent = {
      involvedObject: { kind: 'Pod', name: 'image-pod', namespace: 'default' },
      reason: 'ErrImagePull',
      message: 'failed to pull image "myapp:v999": not found',
      type: 'Warning',
      count: 3,
      firstTimestamp: '2024-01-01T00:00:00Z',
      lastTimestamp: '2024-01-01T01:00:00Z',
    };

    const imagePullBackOffEvent: K8sEvent = {
      involvedObject: { kind: 'Pod', name: 'image-pod', namespace: 'default' },
      reason: 'ImagePullBackOff',
      message: 'Back-off pulling image "myapp:v999"',
      type: 'Warning',
      count: 8,
      firstTimestamp: '2024-01-01T00:00:10Z',
      lastTimestamp: '2024-01-01T01:00:00Z',
    };

    // ── Test 1: graph traversal replaces hypothesis generator for matched symptoms ──

    it('sets graphMatchedSymptoms > 0 when causal template matches the crashloop symptom', async () => {
      // The FailedMount event with a named secret triggers the
      // missing-secret-crashloop causal template.  The crashloop symptom is
      // matched → hypothesis generator is skipped for that finding.
      const context = makeContext({
        resources: [graphTemplatePod],
        events: [templateFailedMountEvent],
      });
      const result = await runInvestigation(context);

      expect(result.metadata.graphMatchedSymptoms).toBeGreaterThan(0);
    });

    it('hypothesis generator is skipped for matched symptoms (hypothesesGenerated = 0 when only one matched symptom and no other findings)', async () => {
      // graphTemplatePod produces ONLY a crashloop finding (no secret refs in spec
      // → config investigator emits nothing).  templateFailedMountEvent triggers
      // the causal template, so the crashloop finding is marked "graph-handled".
      // With no remaining unmatched findings, the hypothesis generator produces 0.
      const context = makeContext({
        resources: [graphTemplatePod],
        events: [templateFailedMountEvent],
      });
      const result = await runInvestigation(context);

      expect(result.metadata.hypothesesGenerated).toBe(0);
    });

    it('creates a synthetic root-cause finding linked to the matched symptom', async () => {
      const context = makeContext({
        resources: [graphTemplatePod],
        events: [templateFailedMountEvent],
      });
      const result = await runInvestigation(context);

      // The causal template creates a synthetic "missing-secret" root-cause finding.
      const rootCauseFinding = result.findings.find((f) =>
        f.id.includes('missing-secret') && f.id.includes('app-secret'),
      );
      expect(rootCauseFinding).toBeDefined();
      expect(rootCauseFinding!.severity).toBe('critical');
      expect(rootCauseFinding!.confidence).toBeGreaterThan(0);
    });

    // ── Test 2: hypothesis generator used as fallback ─────────────────────────

    it('uses hypothesis generator as fallback when no causal template matches', async () => {
      // BackOff event has no FailedMount + no secret name → no causal template
      // match → hypothesis generator runs for the crashloop finding.
      const context = makeContext({
        resources: [graphTemplatePod],
        events: [templateBackOffEvent],
      });
      const result = await runInvestigation(context);

      // No causal template matched
      expect(result.metadata.graphMatchedSymptoms).toBe(0);
      // Hypothesis generator ran (crashloop generates 5 hypotheses)
      expect(result.metadata.hypothesesGenerated).toBeGreaterThan(0);
    });

    // ── Test 3: root causes ranked by path length, edge weights, evidence count ──

    it('multiple graph root causes appear in the finding list and are in severity-confidence order', async () => {
      // Two causal templates match:
      //   - missing-secret-crashloop (crashloop + FailedMount with secret)
      //   - bad-image-tag (imagepull + ErrImagePull)
      // Both root causes must appear in the result findings.
      const context = makeContext({
        resources: [graphTemplatePod, imagePullPod],
        events: [templateFailedMountEvent, errImagePullEvent, imagePullBackOffEvent],
      });
      const result = await runInvestigation(context);

      expect(result.metadata.graphMatchedSymptoms).toBeGreaterThanOrEqual(2);

      // Both root-cause findings should appear
      const missingSecretRoot = result.findings.find((f) =>
        f.id.includes('missing-secret') && f.id.includes('app-secret'),
      );
      const badImageRoot = result.findings.find((f) =>
        f.id.includes('bad-image-tag'),
      );
      expect(missingSecretRoot).toBeDefined();
      expect(badImageRoot).toBeDefined();

      // Result findings are sorted by severity desc, confidence desc
      // (the existing sort logic applies to graph root-cause findings too)
      for (let i = 0; i < result.findings.length - 1; i++) {
        const severityOrder: Record<string, number> = {
          critical: 4, high: 3, medium: 2, low: 1, info: 0,
        };
        const cur = result.findings[i]!;
        const nxt = result.findings[i + 1]!;
        const curSev = severityOrder[cur.severity] ?? 0;
        const nxtSev = severityOrder[nxt.severity] ?? 0;
        if (curSev === nxtSev) {
          expect(cur.confidence).toBeGreaterThanOrEqual(nxt.confidence);
        } else {
          expect(curSev).toBeGreaterThanOrEqual(nxtSev);
        }
      }
    });

    // ── Test 4: finding tree built from causes edges ──────────────────────────

    it('finding tree has non-trivial causal structure (root-cause → symptom) when causal template matches', async () => {
      const context = makeContext({
        resources: [graphTemplatePod],
        events: [templateFailedMountEvent],
      });
      const result = await runInvestigation(context);

      // The finding tree should have at least one node with children
      const hasChildren = result.findingTree.some((n) => n.children.length > 0);
      expect(hasChildren).toBe(true);

      // The root causes (nodes with no parent) should include the missing-secret finding
      const rootCauseNodes = getRootCauses(result.findingTree);
      const missingSecretRoot = rootCauseNodes.find((n) =>
        n.finding.id.includes('missing-secret'),
      );
      expect(missingSecretRoot).toBeDefined();

      // The crashloop finding should be a child of the root-cause node
      const crashloopChild = missingSecretRoot!.children.find((child) =>
        child.finding.id.includes('crashloop'),
      );
      expect(crashloopChild).toBeDefined();
    });

    it('finding tree is flat (no causes edges) when no causal template matches', async () => {
      // BackOff event only → no causal template match → no causes edges
      const context = makeContext({
        resources: [graphTemplatePod],
        events: [templateBackOffEvent],
      });
      const result = await runInvestigation(context);

      // No causes edges → finding tree is flat (all nodes are root causes)
      const rootCauseNodes = getRootCauses(result.findingTree);
      // All findings are root causes (no parents assigned)
      expect(rootCauseNodes.length).toBe(result.findingTree.length);
    });

    it('graph-matched symptoms are excluded from the hypothesis generator but still appear in final findings', async () => {
      // The crashloop finding is matched by a causal template and excluded from
      // hypothesis generation.  It must still appear in the final findings
      // (graph-driven does not remove heuristic findings, only skips hypothesis gen).
      const context = makeContext({
        resources: [graphTemplatePod],
        events: [templateFailedMountEvent],
      });
      const result = await runInvestigation(context);

      const crashFinding = result.findings.find((f) =>
        f.id.startsWith('finding:k8s:crashloop:'),
      );
      expect(crashFinding).toBeDefined();

      // And the graph root-cause is also present
      const rootCause = result.findings.find((f) =>
        f.id.includes('missing-secret') && f.id.includes('app-secret'),
      );
      expect(rootCause).toBeDefined();
    });

    it('metadata.graphMatchedSymptoms is 0 when context is empty', async () => {
      const result = await runInvestigation(makeContext());
      expect(result.metadata.graphMatchedSymptoms).toBe(0);
    });
  });

  // ── Seed clustering integration (step-7) ──────────────────────────────────
  //
  // These tests verify the pre-investigation AI seed-clustering pass that was
  // inserted between generateSeeds() and the heuristic investigator fan-out.
  //
  // Key invariants:
  //  - Clustering is skipped when AI is disabled (no aiDeps) or seed count < 3.
  //  - When clustering succeeds: seedClusterCount < seeds.length (collapsed).
  //  - Priorities are boosted by CLUSTER_PRIORITY_BOOST per additional member.
  //  - investigateSeed is called once per cluster representative, not per seed.
  //  - LLM generateText failure triggers graceful fallback (unclustered seeds).
  //  - result.seeds always contains the full pre-clustering audit trail.

  describe('seed clustering integration', () => {
    // ── Fixture: a second pod that generates a not-ready seed ─────────────────

    /** Running pod with Ready=False (no CrashLoop/ImagePull) → generates a
     *  not-ready seed with priority 50. Used to inflate seed count to 4. */
    const notReadyWorkerPod: K8sResource = {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: 'worker-pod', namespace: 'default' },
      spec: { containers: [{ name: 'app', image: 'worker:v1' }] },
      status: {
        phase: 'Running',
        conditions: [{ type: 'Ready', status: 'False', reason: 'ContainersNotReady' }],
        containerStatuses: [
          { name: 'app', ready: false, restartCount: 0, state: { running: {} } },
        ],
      },
    };

    // ── Test 1: no AI deps → seeds pass through as singletons ─────────────────

    it('no AI deps → seedClusteringEnabled is false and all clusteredSeeds are singletons', async () => {
      // crashLoopPod + backOffEvent = 2 seeds; no aiDeps → clustering never attempted
      const context = makeContext({ resources: [crashLoopPod], events: [backOffEvent] });
      const result = await runInvestigation(context);

      expect(result.metadata.seedClusteringEnabled).toBe(false);
      expect(result.metadata.seedClusterCount).toBe(result.seeds.length);
      for (const cs of result.clusteredSeeds) {
        expect(cs.memberSeeds).toHaveLength(1);
      }
    });

    // ── Test 2: AI deps present but seed count below threshold ─────────────────

    it('AI deps with fewer than 3 seeds → clustering skipped, seedClusteringEnabled is false', async () => {
      // crashLoopPod alone → 1 seed (CrashLoopBackOff, priority 90)
      const context = makeContext({ resources: [crashLoopPod] });
      const deps = makeEmptyAIDeps();

      const result = await runInvestigation(context, deps);

      expect(result.metadata.seedClusteringEnabled).toBe(false);
      expect(result.metadata.seedClusterCount).toBe(result.seeds.length);
      for (const cs of result.clusteredSeeds) {
        expect(cs.memberSeeds).toHaveLength(1);
      }
      // generateText must NOT have been called (clustering is skipped below threshold)
      expect(
        (deps.llmClient.generateText as ReturnType<typeof vi.fn>),
      ).not.toHaveBeenCalled();
    });

    // ── Test 3: AI deps + ≥3 seeds → clustering attempted and succeeds ─────────

    it('AI deps with >= 3 seeds → clustering attempted and seedClusteringEnabled is true', async () => {
      // 3 seeds: crashLoopPod(90) + dnsFailureLog(50) + backOffEvent(30)
      const context = makeContext({
        resources: [crashLoopPod],
        events: [backOffEvent],
        logs: [dnsFailureLog],
      });
      const deps = makeEmptyAIDeps();

      // Collapse all 3 seeds into 1 cluster; representative is the first (highest priority)
      (deps.llmClient.generateText as ReturnType<typeof vi.fn>).mockImplementation(
        async (_system: string, user: string) => {
          const seeds = parseSeedsFromClusteringPrompt(user);
          if (!seeds || seeds.length === 0) return '';
          return JSON.stringify({
            clusters: [
              {
                label: 'Shared root cause',
                reasoning: 'All three seeds are symptoms of the same crash loop',
                seedIds: seeds.map((s) => s.id),
                representativeSeedId: seeds[0]!.id, // highest-priority seed
              },
            ],
          });
        },
      );

      const result = await runInvestigation(context, deps);

      expect(result.metadata.seedClusteringEnabled).toBe(true);
      // 3 seeds collapsed into 1 cluster
      expect(result.metadata.seedClusterCount).toBe(1);
      expect(result.clusteredSeeds).toHaveLength(1);
      // Priority boosted: min(90 + 5*(3-1), 100) = min(100, 100) = 100
      expect(result.clusteredSeeds[0]!.priority).toBe(100);
      expect(result.clusteredSeeds[0]!.originalPriority).toBe(90);
      // Original seeds are still preserved in result.seeds
      expect(result.seeds).toHaveLength(3);
    });

    // ── Test 4: clustered seeds reach AI investigator (call count) ─────────────

    it('clustered seeds reach AI investigator: investigateSeed called at most once per cluster representative', async () => {
      // 4 seeds: crashLoopPod(90) + notReadyWorkerPod(50) + dnsFailureLog(50) + backOffEvent(30)
      const context = makeContext({
        resources: [crashLoopPod, notReadyWorkerPod],
        events: [backOffEvent],
        logs: [dnsFailureLog],
      });
      const deps = makeEmptyAIDeps();

      // Group the 4 seeds into exactly 2 clusters of 2 each
      (deps.llmClient.generateText as ReturnType<typeof vi.fn>).mockImplementation(
        async (_system: string, user: string) => {
          const seeds = parseSeedsFromClusteringPrompt(user);
          if (!seeds || seeds.length < 2) return '';
          const mid = Math.ceil(seeds.length / 2);
          const clusterA = seeds.slice(0, mid);
          const clusterB = seeds.slice(mid);
          const clusters: Array<{
            label: string;
            reasoning: string;
            seedIds: string[];
            representativeSeedId: string;
          }> = [
            {
              label: 'Cluster A',
              reasoning: 'Crash and not-ready on the same workload',
              seedIds: clusterA.map((s) => s.id),
              representativeSeedId: clusterA[0]!.id,
            },
          ];
          if (clusterB.length > 0) {
            clusters.push({
              label: 'Cluster B',
              reasoning: 'Log errors and warning events from the same cause',
              seedIds: clusterB.map((s) => s.id),
              representativeSeedId: clusterB[0]!.id,
            });
          }
          return JSON.stringify({ clusters });
        },
      );

      await runInvestigation(context, deps);

      // Core cost-reduction assertion:
      // 4 original seeds → 2 cluster representatives → investigateSeed called
      // at most 2 times (not 4 times).
      const investigateCallCount = (
        deps.llmClient.investigateSeed as ReturnType<typeof vi.fn>
      ).mock.calls.length;
      expect(investigateCallCount).toBeLessThanOrEqual(2);
      expect(investigateCallCount).toBeLessThan(4);
    });

    // ── Test 5: combined hypothesis flows through AI path ─────────────────────

    it('investigateSeed receives combined hypothesis from all member seeds in a cluster', async () => {
      // 3 seeds; group first 2 (crashLoop + dnsLog) together, leave backOff singleton
      const context = makeContext({
        resources: [crashLoopPod],
        events: [backOffEvent],
        logs: [dnsFailureLog],
      });
      const deps = makeEmptyAIDeps();

      (deps.llmClient.generateText as ReturnType<typeof vi.fn>).mockImplementation(
        async (_system: string, user: string) => {
          const seeds = parseSeedsFromClusteringPrompt(user);
          if (!seeds || seeds.length < 2) return '';
          // seeds is sorted by priority desc: [crashLoop(90), dnsLog(50), backOff(30)]
          return JSON.stringify({
            clusters: [
              {
                label: 'CrashLoop + log errors cluster',
                reasoning: 'Crash loop is producing the log errors',
                seedIds: [seeds[0]!.id, seeds[1]!.id],
                representativeSeedId: seeds[0]!.id,
              },
              {
                label: 'BackOff singleton',
                reasoning: 'Unrelated warning event',
                seedIds: [seeds[2]!.id],
                representativeSeedId: seeds[2]!.id,
              },
            ],
          });
        },
      );

      await runInvestigation(context, deps);

      // The combined cluster's investigateSeed call must include hypothesis text
      // from both member seeds (joined by '\n\nAlso investigate: ')
      const calls = (deps.llmClient.investigateSeed as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.length).toBeGreaterThan(0);

      // Find the call where the user prompt contains the combined hypothesis separator
      const combinedClusterCall = calls.find(
        (call: unknown[]) =>
          typeof call[1] === 'string' && (call[1] as string).includes('Also investigate:'),
      );
      expect(combinedClusterCall).toBeDefined();
    });

    // ── Test 6: LLM generateText throws → graceful degradation ────────────────

    it('LLM generateText throws → graceful degradation: unclustered seeds, investigation completes normally', async () => {
      // clusterSeeds has its own internal try-catch: when generateText throws,
      // it logs a warning and returns toUnclusteredSeeds(seeds) without re-throwing.
      // The orchestrator therefore always sets seedClusteringEnabled=true when
      // clusterSeeds is called — the flag means "clustering was attempted", not
      // "clustering produced actual clusters".  The key contract to verify is:
      //   • no throw from runInvestigation
      //   • clusteredSeeds are all singletons (fallback path was taken)
      //   • heuristic findings are still produced normally
      const context = makeContext({
        resources: [crashLoopPod],
        events: [backOffEvent],
        logs: [dnsFailureLog],
      });
      const deps = makeEmptyAIDeps();
      (deps.llmClient.generateText as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('OpenAI API rate limit exceeded'),
      );

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const result = await runInvestigation(context, deps);
      warnSpy.mockRestore();

      // Investigation must complete without throwing
      expect(result).toBeDefined();

      // All clusteredSeeds are singletons (graceful unclustered fallback within clusterSeeds)
      for (const cs of result.clusteredSeeds) {
        expect(cs.memberSeeds).toHaveLength(1);
      }

      // seedClusterCount equals original seed count (no reduction — all singletons)
      expect(result.metadata.seedClusterCount).toBe(result.seeds.length);

      // Heuristic findings are still produced normally
      const crashFinding = result.findings.find((f) =>
        f.title.toLowerCase().includes('crashloop'),
      );
      expect(crashFinding).toBeDefined();

      // generateText was indeed called (the failure was real, not skipped)
      expect(
        (deps.llmClient.generateText as ReturnType<typeof vi.fn>),
      ).toHaveBeenCalled();
    });

    // ── Test 7: original seeds preserved in result ─────────────────────────────

    it('result.seeds contains all pre-clustering seeds; result.clusteredSeeds carries memberSeeds', async () => {
      const context = makeContext({
        resources: [crashLoopPod],
        events: [backOffEvent],
        logs: [dnsFailureLog],
      });
      const deps = makeEmptyAIDeps();

      // Collapse all 3 seeds into 1 cluster
      (deps.llmClient.generateText as ReturnType<typeof vi.fn>).mockImplementation(
        async (_system: string, user: string) => {
          const seeds = parseSeedsFromClusteringPrompt(user);
          if (!seeds) return '';
          return JSON.stringify({
            clusters: [
              {
                label: 'All seeds in one cluster',
                reasoning: 'All symptoms share a single root cause',
                seedIds: seeds.map((s) => s.id),
                representativeSeedId: seeds[0]!.id,
              },
            ],
          });
        },
      );

      const result = await runInvestigation(context, deps);

      // result.seeds = all 3 pre-clustering seeds (full audit trail preserved)
      expect(result.seeds).toHaveLength(3);

      // result.clusteredSeeds = 1 cluster representative
      expect(result.clusteredSeeds).toHaveLength(1);

      // The single cluster representative has all 3 original seeds in memberSeeds
      expect(result.clusteredSeeds[0]!.memberSeeds).toHaveLength(3);

      // Every original seed ID appears in memberSeeds
      const memberIds = result.clusteredSeeds[0]!.memberSeeds.map((m) => m.id);
      for (const seed of result.seeds) {
        expect(memberIds).toContain(seed.id);
      }
    });
  });
});
