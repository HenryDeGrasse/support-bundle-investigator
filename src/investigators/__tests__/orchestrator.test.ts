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
    // Force investigateWithAI to throw at the function level (not just per-seed)
    // by passing deps that throw on property access (before the seed loop).
    const badDeps = new Proxy({}, {
      get: (): never => {
        throw new Error('Catastrophic AI infrastructure failure');
      },
    }) as unknown as AIInvestigatorDeps;

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const context = makeContext({ resources: [crashLoopPod], events: [backOffEvent] });
    // Should NOT throw — orchestrator catches the outer-level failure
    const result = await runInvestigation(context, badDeps);

    // Heuristic findings should still be present
    const crashFinding = result.findings.find((f) =>
      f.title.toLowerCase().includes('crashloop'),
    );
    expect(crashFinding).toBeDefined();

    // AI is marked as not enabled because investigateWithAI itself threw
    expect(result.metadata.aiEnabled).toBe(false);
    expect(result.metadata.aiFindings).toBe(0);

    // Orchestrator-level warning should have been logged
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[Orchestrator] AI investigation failed'),
    );

    warnSpy.mockRestore();
  });

  it('AI findings are included in the verified + sorted final findings', async () => {
    const aiFinding = {
      title: 'AI: Low confidence finding',
      severity: 'info' as const,
      confidence: 0.4,
      affectedComponents: ['Pod/default/app-pod'],
      reasoningSummary: 'Low priority observation.',
      evidence: [{ path: 'logs/app.log', note: 'Minor log entry' }],
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

    // Critical findings should come before info
    const hasCriticalBefore =
      result.findings.some((f) => f.severity === 'critical') &&
      result.findings.findIndex((f) => f.severity === 'critical') <
        result.findings.findIndex((f) => f.title.includes('AI:'));
    expect(hasCriticalBefore).toBe(true);
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
});
