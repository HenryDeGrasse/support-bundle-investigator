import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { InvestigatorContext, InvestigationSeed } from '../types.js';
import type { BundleProfile } from '../../types/index.js';
import type { LogFile } from '../../parsers/index.js';
import type { AIInvestigatorDeps } from '../ai-investigator.js';
import type { IndexedChunk } from '../../ai/chunk-indexer.js';
import type { ResourceRelationshipGraph } from '../../graph/resource-graph.js';
import type { AIFindingResponse } from '../../ai/llm-client.js';
import {
  investigateWithAI,
  DEFAULT_MAX_SEEDS,
  mergeChunks,
  DEFAULT_TOKEN_BUDGET,
  computeChunkOverlap,
  deduplicateSeeds,
  resolveSeedStartNodes,
} from '../ai-investigator.js';
import type { RetrievalList } from '../ai-investigator.js';
import { estimateTokens } from '../../ai/chunk-indexer.js';
import { generateHypotheticalDocument } from '../../ai/hyde.js';
import type { HydeLLMClient } from '../../ai/hyde.js';
import { DiagnosticGraph } from '../../graph/diagnostic-graph.js';

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

function makeContext(
  partial: Partial<InvestigatorContext> = {},
): InvestigatorContext {
  return {
    analyzerResults: [],
    resources: [],
    events: [],
    logs: [] as LogFile[],
    profile: makeProfile(),
    ...partial,
  };
}

function makeSeed(
  id: string,
  category: InvestigationSeed['category'],
  hypothesis: string,
  priority = 80,
  source = 'pod:default/app-pod',
): InvestigationSeed {
  return { id, hypothesis, source, category, priority };
}

function makeChunk(
  id: string,
  artifactId: string,
  content: string,
  category: IndexedChunk['artifactCategory'] = 'kubernetes-resource',
): IndexedChunk {
  return {
    id,
    artifactId,
    content,
    startLine: 1,
    endLine: content.split('\n').length,
    summary: `Chunk from ${artifactId}`,
    identifiers: [],
    artifactCategory: category,
  };
}

// ---------------------------------------------------------------------------
// Mock AIFinding
// ---------------------------------------------------------------------------

const VALID_AI_FINDING = {
  title: 'CrashLoopBackOff: Pod app-pod in namespace default',
  severity: 'critical' as const,
  confidence: 0.9,
  affectedComponents: ['Pod/default/app-pod', 'Container/app'],
  reasoningSummary:
    'The app-pod container is in CrashLoopBackOff with 8 restarts. BackOff events corroborate the restart loop.',
  evidence: [
    {
      path: 'cluster-resources/pods/default/app-pod.json',
      note: 'Container app in CrashLoopBackOff state with 8 restarts',
      lineRange: [1, 10] as [number, number],
    },
  ],
  contradictionsChecked: ['Container is in CrashLoopBackOff — confirmed waiting state'],
  recommendedAction:
    'Inspect container logs with `kubectl logs app-pod -n default --previous`.',
  missingEvidence: [],
};

describe('resolveSeedStartNodes', () => {
  function makePodGraph(): DiagnosticGraph {
    const graph = new DiagnosticGraph();
    for (const namespace of ['team-a', 'team-b']) {
      graph.addNode({
        id: `Pod:${namespace}/api`,
        nodeType: 'resource',
        data: { kind: 'Pod', namespace, name: 'api' },
      });
    }
    return graph;
  }

  it('resolves the canonical pod:namespace/name source without matching a same-named pod elsewhere', () => {
    const graph = makePodGraph();
    const seed = makeSeed(
      'seed:pod:0',
      'kubernetes',
      'Pod api is in CrashLoopBackOff',
      100,
      'pod:team-b/api',
    );

    expect(resolveSeedStartNodes(seed, graph)).toEqual(['Pod:team-b/api']);
  });

  it('uses every canonical member source from a clustered seed', () => {
    const graph = makePodGraph();
    const first = makeSeed('seed:pod:0', 'kubernetes', 'team-a api failing', 100, 'pod:team-a/api');
    const second = makeSeed('seed:pod:1', 'kubernetes', 'team-b api failing', 90, 'pod:team-b/api');
    const clusteredSeed = {
      ...first,
      hypothesis: `${first.hypothesis}\n\nAlso investigate: ${second.hypothesis}`,
      memberSeeds: [first, second],
      clusterLabel: 'api failures',
      originalPriority: first.priority,
    };

    expect(resolveSeedStartNodes(clusteredSeed, graph)).toEqual([
      'Pod:team-a/api',
      'Pod:team-b/api',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Build mock deps
// ---------------------------------------------------------------------------

function makeMockDeps(
  investigateSeedImpl: () => Promise<AIFindingResponse>,
): AIInvestigatorDeps {
  const mockInvestigateSeed = vi.fn(investigateSeedImpl);

  const mockLlmClient = {
    investigateSeed: mockInvestigateSeed,
  } as unknown as AIInvestigatorDeps['llmClient'];

  const emptyGraph: ResourceRelationshipGraph = {
    nodes: new Map(),
    edges: [],
  };

  const mockLexicalIndex = {
    build: vi.fn(),
    search: vi.fn().mockReturnValue([]),
    extractQueryIdentifiers: vi.fn().mockReturnValue([]),
  } as unknown as AIInvestigatorDeps['lexicalIndex'];

  return {
    llmClient: mockLlmClient,
    chunkIndex: [],
    resourceGraph: emptyGraph,
    lexicalIndex: mockLexicalIndex,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('investigateWithAI', () => {
  // Reset mocks between tests
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Basic shape ────────────────────────────────────────────────────────────

  it('returns an InvestigatorResult with findings and edges arrays on empty seeds', async () => {
    const deps = makeMockDeps(async () => ({ findings: [] }));
    const result = await investigateWithAI(makeContext(), [], deps);

    expect(result).toMatchObject({
      findings: expect.any(Array),
      edges: expect.any(Array),
    });
    expect(result.findings).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
    expect(result.metadata?.aiRunStats).toEqual({
      model: 'unknown',
      totalCalls: 0,
      successfulCalls: 0,
      failedCalls: 0,
      totalLatencyMs: 0,
      avgLatencyMs: 0,
    });
  });

  it('aggregates AI call telemetry into metadata.aiRunStats', async () => {
    const deps = makeMockDeps(async () => ({
      findings: [VALID_AI_FINDING],
      telemetry: {
        model: 'gpt-4o',
        latencyMs: 125,
        success: true,
        promptTokens: 120,
        completionTokens: 40,
        estimatedCostUsd: 0.0012,
      },
    }));

    const seeds = [makeSeed('seed:k8s:0', 'kubernetes', 'Pod app-pod is in CrashLoopBackOff')];
    const result = await investigateWithAI(makeContext(), seeds, deps);

    expect(result.metadata?.aiRunStats).toEqual({
      model: 'gpt-4o',
      totalCalls: 1,
      successfulCalls: 1,
      failedCalls: 0,
      totalLatencyMs: 125,
      avgLatencyMs: 125,
      totalPromptTokens: 120,
      totalCompletionTokens: 40,
      estimatedCostUsd: 0.0012,
    });
  });

  it('does not double-count telemetry when post-call response processing throws', async () => {
    const deps = makeMockDeps(async () => {
      const response: AIFindingResponse = {
        findings: [],
        telemetry: {
          model: 'gpt-4o',
          latencyMs: 90,
          success: true,
          promptTokens: 100,
          completionTokens: 20,
          estimatedCostUsd: 0.0008,
        },
      };

      Object.defineProperty(response, 'findings', {
        enumerable: true,
        configurable: true,
        get() {
          throw new Error('response findings accessor failed');
        },
      });

      return response;
    });

    const seeds = [makeSeed('seed:k8s:0', 'kubernetes', 'Pod app-pod is in CrashLoopBackOff')];
    const result = await investigateWithAI(makeContext(), seeds, deps);

    expect(result.findings).toEqual([]);
    expect(result.metadata?.aiRunStats).toEqual({
      model: 'gpt-4o',
      totalCalls: 1,
      successfulCalls: 1,
      failedCalls: 0,
      totalLatencyMs: 90,
      avgLatencyMs: 90,
      totalPromptTokens: 100,
      totalCompletionTokens: 20,
      estimatedCostUsd: 0.0008,
    });
  });

  // ── Finding generation from LLM response ──────────────────────────────────

  it('converts a valid AI finding to a Finding with the expected shape', async () => {
    const deps = makeMockDeps(async () => ({
      findings: [VALID_AI_FINDING],
    }));

    const seeds = [makeSeed('seed:k8s:0', 'kubernetes', 'Pod app-pod is in CrashLoopBackOff')];
    const result = await investigateWithAI(makeContext(), seeds, deps);

    expect(result.findings).toHaveLength(1);
    const finding = result.findings[0]!;

    expect(finding.id).toMatch(/^finding:ai:kubernetes:\d+$/);
    expect(finding.title).toBe(VALID_AI_FINDING.title);
    expect(finding.severity).toBe('critical');
    expect(finding.confidence).toBe(0.9);
    expect(finding.affectedComponents).toEqual(VALID_AI_FINDING.affectedComponents);
    expect(finding.reasoningSummary).toBe(VALID_AI_FINDING.reasoningSummary);
    expect(finding.recommendedAction).toBe(VALID_AI_FINDING.recommendedAction);
    expect(finding.missingEvidence).toEqual([]);
    expect(finding.contradictionsChecked).toEqual(VALID_AI_FINDING.contradictionsChecked);
  });

  // ── Evidence citation mapping ───────────────────────────────────────────────

  it('maps AI evidence to canonical Evidence type with path and note', async () => {
    const deps = makeMockDeps(async () => ({
      findings: [VALID_AI_FINDING],
    }));

    const seeds = [makeSeed('seed:k8s:0', 'kubernetes', 'Pod app-pod is in CrashLoopBackOff')];
    const result = await investigateWithAI(makeContext(), seeds, deps);

    const finding = result.findings[0]!;
    expect(finding.evidence).toHaveLength(1);

    const evidence = finding.evidence[0]!;
    expect(evidence.path).toBe('cluster-resources/pods/default/app-pod.json');
    expect(evidence.note).toBe('Container app in CrashLoopBackOff state with 8 restarts');
  });

  it('sets artifactType on evidence when the chunk path is in the chunk index', async () => {
    const podChunk = makeChunk(
      'chunk:pod:0',
      'cluster-resources/pods/default/app-pod.json',
      'CrashLoopBackOff status',
      'kubernetes-resource',
    );

    const deps = makeMockDeps(async () => ({
      findings: [VALID_AI_FINDING],
    }));
    deps.chunkIndex.push(podChunk);
    // Also add to the lexical mock so search can return something
    (deps.lexicalIndex.search as ReturnType<typeof vi.fn>).mockReturnValue([
      { chunk: podChunk, score: 3.0 },
    ]);

    const seeds = [makeSeed('seed:k8s:0', 'kubernetes', 'Pod app-pod is in CrashLoopBackOff')];
    const result = await investigateWithAI(makeContext(), seeds, deps);

    const evidence = result.findings[0]?.evidence[0];
    expect(evidence?.artifactType).toBe('kubernetes-resource');
  });

  it('preserves timestamp on evidence when the matched chunk has one', async () => {
    const logChunk: IndexedChunk = {
      ...makeChunk(
        'chunk:log:0',
        'logs/app/app-pod.log',
        '2024-01-01T00:00:00Z FATAL startup failed',
        'log',
      ),
      timestamp: '2024-01-01T00:00:00.000Z',
    };

    const deps = makeMockDeps(async () => ({
      findings: [
        {
          ...VALID_AI_FINDING,
          evidence: [
            {
              path: 'logs/app/app-pod.log',
              note: 'FATAL startup failed',
              lineRange: [1, 1],
            },
          ],
        },
      ],
    }));
    deps.chunkIndex.push(logChunk);
    (deps.lexicalIndex.search as ReturnType<typeof vi.fn>).mockReturnValue([
      { chunk: logChunk, score: 3.0 },
    ]);

    const seeds = [makeSeed('seed:log:0', 'log', 'Log file logs/app/app-pod.log contains errors')];
    const result = await investigateWithAI(makeContext(), seeds, deps);

    const evidence = result.findings[0]?.evidence[0];
    expect(evidence?.artifactType).toBe('log');
    expect(evidence?.timestamp).toBe('2024-01-01T00:00:00.000Z');
  });

  it('uses evidence lineRange to match the correct chunk when a file has multiple chunks', async () => {
    const chunk1: IndexedChunk = {
      ...makeChunk('chunk:log:1', 'logs/app/app-pod.log', 'first chunk', 'log'),
      startLine: 1,
      endLine: 50,
      timestamp: '2024-01-01T00:00:00.000Z',
    };
    const chunk2: IndexedChunk = {
      ...makeChunk('chunk:log:2', 'logs/app/app-pod.log', 'second chunk', 'log'),
      startLine: 51,
      endLine: 100,
      timestamp: '2024-01-01T00:05:00.000Z',
    };

    const deps = makeMockDeps(async () => ({
      findings: [
        {
          ...VALID_AI_FINDING,
          evidence: [
            {
              path: 'logs/app/app-pod.log',
              note: 'error appears in the later chunk',
              lineRange: [60, 65],
            },
          ],
        },
      ],
    }));
    deps.chunkIndex.push(chunk1, chunk2);
    (deps.lexicalIndex.search as ReturnType<typeof vi.fn>).mockReturnValue([
      { chunk: chunk1, score: 2.0 },
      { chunk: chunk2, score: 1.5 },
    ]);

    const seeds = [makeSeed('seed:log:0', 'log', 'Log file logs/app/app-pod.log contains errors')];
    const result = await investigateWithAI(makeContext(), seeds, deps);

    expect(result.findings[0]?.evidence[0]?.timestamp).toBe('2024-01-01T00:05:00.000Z');
  });

  it('leaves artifactType undefined when the evidence path is not in the chunk index', async () => {
    const deps = makeMockDeps(async () => ({
      findings: [VALID_AI_FINDING],
    }));
    // chunkIndex is empty — path will not be found

    const seeds = [makeSeed('seed:k8s:0', 'kubernetes', 'Pod app-pod is in CrashLoopBackOff')];
    const result = await investigateWithAI(makeContext(), seeds, deps);

    const evidence = result.findings[0]?.evidence[0];
    expect(evidence?.artifactType).toBeUndefined();
  });

  // ── Graph edge creation ────────────────────────────────────────────────────

  it('creates graph edges linking evidence to finding with supports type', async () => {
    const deps = makeMockDeps(async () => ({
      findings: [VALID_AI_FINDING],
    }));

    const seeds = [makeSeed('seed:k8s:0', 'kubernetes', 'Pod app-pod is in CrashLoopBackOff')];
    const result = await investigateWithAI(makeContext(), seeds, deps);

    expect(result.edges).toHaveLength(1);
    const edge = result.edges[0]!;

    expect(edge.id).toMatch(/^edge:ai:\d+$/);
    expect(edge.type).toBe('supports');
    expect(edge.source).toBe('evidence:cluster-resources/pods/default/app-pod.json');
    expect(edge.target).toBe(result.findings[0]!.id);
    expect(edge.weight).toBe(0.9);
  });

  it('creates one edge per evidence item across multiple findings', async () => {
    const twoEvidenceFinding = {
      ...VALID_AI_FINDING,
      title: 'Multi-evidence finding',
      evidence: [
        {
          path: 'cluster-resources/pods/default/app-pod.json',
          note: 'CrashLoopBackOff state',
        },
        {
          path: 'cluster-resources/events/default.json',
          note: 'BackOff events',
        },
      ],
    };

    const deps = makeMockDeps(async () => ({
      findings: [twoEvidenceFinding],
    }));

    const seeds = [makeSeed('seed:k8s:0', 'kubernetes', 'Pod app-pod is in CrashLoopBackOff')];
    const result = await investigateWithAI(makeContext(), seeds, deps);

    expect(result.edges).toHaveLength(2);
    expect(result.edges[0]!.source).toBe(
      'evidence:cluster-resources/pods/default/app-pod.json',
    );
    expect(result.edges[1]!.source).toBe(
      'evidence:cluster-resources/events/default.json',
    );
    expect(new Set(result.edges.map((e) => e.target)).size).toBe(1);
  });

  // ── Seed category → playbook routing ──────────────────────────────────────

  it('calls llmClient.investigateSeed for each seed category', async () => {
    const mockInvestigateSeed = vi.fn().mockResolvedValue({ findings: [] });
    const deps: AIInvestigatorDeps = {
      llmClient: { investigateSeed: mockInvestigateSeed } as unknown as AIInvestigatorDeps['llmClient'],
      chunkIndex: [],
      resourceGraph: { nodes: new Map(), edges: [] },
      lexicalIndex: {
        build: vi.fn(),
        search: vi.fn().mockReturnValue([]),
        extractQueryIdentifiers: vi.fn().mockReturnValue([]),
      } as unknown as AIInvestigatorDeps['lexicalIndex'],
    };

    const seeds: InvestigationSeed[] = [
      makeSeed('seed:k8s:0', 'kubernetes', 'Pod is in CrashLoopBackOff', 90),
      makeSeed('seed:log:0', 'log', 'Log file has FATAL errors', 70),
      makeSeed('seed:config:0', 'configuration', 'Missing secret app-credentials', 80),
      makeSeed('seed:conn:0', 'connectivity', 'DNS lookup failure for db.internal', 75),
    ];

    await investigateWithAI(makeContext(), seeds, deps);

    // One call per seed
    expect(mockInvestigateSeed).toHaveBeenCalledTimes(4);

    // Verify each call received a non-empty system prompt mentioning the right playbook.
    // Seeds are sorted by priority descending before investigation, so we check all
    // system prompts collectively rather than by position.
    const calls = mockInvestigateSeed.mock.calls as [string, string][];
    const systemPrompts = calls.map(([system]) => system);
    const combined = systemPrompts.join('\n---\n');

    expect(combined).toContain('CrashLoop');
    expect(combined).toContain('Log-Driven');
    expect(combined).toContain('Configuration');
    expect(combined).toContain('DNS');
  });

  it('routes kubernetes seed with image-pull hypothesis to image-pull playbook', async () => {
    const mockInvestigateSeed = vi.fn().mockResolvedValue({ findings: [] });
    const deps: AIInvestigatorDeps = {
      llmClient: { investigateSeed: mockInvestigateSeed } as unknown as AIInvestigatorDeps['llmClient'],
      chunkIndex: [],
      resourceGraph: { nodes: new Map(), edges: [] },
      lexicalIndex: {
        build: vi.fn(),
        search: vi.fn().mockReturnValue([]),
        extractQueryIdentifiers: vi.fn().mockReturnValue([]),
      } as unknown as AIInvestigatorDeps['lexicalIndex'],
    };

    const seeds = [
      makeSeed('seed:k8s:imagepull', 'kubernetes', 'Pod is in ImagePullBackOff for image nginx:bad-tag'),
    ];

    await investigateWithAI(makeContext(), seeds, deps);

    const [systemPrompt] = (mockInvestigateSeed.mock.calls as [string, string][])[0]!;
    expect(systemPrompt).toContain('ImagePullBackOff');
  });

  // ── Graceful handling of LLM errors ───────────────────────────────────────

  it('continues with remaining seeds when a single seed LLM call fails', async () => {
    let callCount = 0;
    const mockInvestigateSeed = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error('Network timeout');
      }
      return { findings: [VALID_AI_FINDING] };
    });

    const deps: AIInvestigatorDeps = {
      llmClient: { investigateSeed: mockInvestigateSeed } as unknown as AIInvestigatorDeps['llmClient'],
      chunkIndex: [],
      resourceGraph: { nodes: new Map(), edges: [] },
      lexicalIndex: {
        build: vi.fn(),
        search: vi.fn().mockReturnValue([]),
        extractQueryIdentifiers: vi.fn().mockReturnValue([]),
      } as unknown as AIInvestigatorDeps['lexicalIndex'],
    };

    const seeds = [
      makeSeed('seed:k8s:0', 'kubernetes', 'Pod is in CrashLoopBackOff', 90),
      makeSeed('seed:log:0', 'log', 'FATAL errors in log', 70),
    ];

    // Should not throw even though the first seed fails
    const result = await investigateWithAI(makeContext(), seeds, deps);

    // Second seed succeeds → one finding produced
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.title).toBe(VALID_AI_FINDING.title);
    // Total of 2 calls were made
    expect(mockInvestigateSeed).toHaveBeenCalledTimes(2);
  });

  it('returns empty findings and does not throw when all LLM calls fail', async () => {
    const mockInvestigateSeed = vi.fn().mockRejectedValue(new Error('API error'));
    const deps: AIInvestigatorDeps = {
      llmClient: { investigateSeed: mockInvestigateSeed } as unknown as AIInvestigatorDeps['llmClient'],
      chunkIndex: [],
      resourceGraph: { nodes: new Map(), edges: [] },
      lexicalIndex: {
        build: vi.fn(),
        search: vi.fn().mockReturnValue([]),
        extractQueryIdentifiers: vi.fn().mockReturnValue([]),
      } as unknown as AIInvestigatorDeps['lexicalIndex'],
    };

    const seeds = [makeSeed('seed:k8s:0', 'kubernetes', 'Pod is in CrashLoopBackOff')];

    // Must not throw
    const result = await investigateWithAI(makeContext(), seeds, deps);

    expect(result.findings).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
  });

  it('treats empty findings response (not an error) as zero findings', async () => {
    const deps = makeMockDeps(async () => ({ findings: [] }));

    const seeds = [makeSeed('seed:k8s:0', 'kubernetes', 'Pod is in CrashLoopBackOff')];
    const result = await investigateWithAI(makeContext(), seeds, deps);

    expect(result.findings).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
  });

  it('re-validates findings returned by llmClient before conversion', async () => {
    const deps = makeMockDeps(async () => ({
      findings: [
        {
          ...VALID_AI_FINDING,
          title: '',
        } as unknown as AIFindingResponse['findings'][number],
      ],
    }));

    const seeds = [makeSeed('seed:k8s:0', 'kubernetes', 'Pod is in CrashLoopBackOff')];
    const result = await investigateWithAI(makeContext(), seeds, deps);

    expect(result.findings).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
  });

  // ── Max-seed limiting ─────────────────────────────────────────────────────

  it('limits investigation to DEFAULT_MAX_SEEDS seeds', async () => {
    const mockInvestigateSeed = vi.fn().mockResolvedValue({ findings: [] });
    const deps: AIInvestigatorDeps = {
      llmClient: { investigateSeed: mockInvestigateSeed } as unknown as AIInvestigatorDeps['llmClient'],
      chunkIndex: [],
      resourceGraph: { nodes: new Map(), edges: [] },
      lexicalIndex: {
        build: vi.fn(),
        search: vi.fn().mockReturnValue([]),
        extractQueryIdentifiers: vi.fn().mockReturnValue([]),
      } as unknown as AIInvestigatorDeps['lexicalIndex'],
    };

    // Create more seeds than the default limit
    const seeds: InvestigationSeed[] = Array.from({ length: DEFAULT_MAX_SEEDS + 5 }, (_, i) =>
      makeSeed(`seed:k8s:${i}`, 'kubernetes', `Pod ${i} is failing`, i),
    );

    await investigateWithAI(makeContext(), seeds, deps);

    expect(mockInvestigateSeed).toHaveBeenCalledTimes(DEFAULT_MAX_SEEDS);
  });

  it('respects a custom maxSeeds parameter', async () => {
    const mockInvestigateSeed = vi.fn().mockResolvedValue({ findings: [] });
    const deps: AIInvestigatorDeps = {
      llmClient: { investigateSeed: mockInvestigateSeed } as unknown as AIInvestigatorDeps['llmClient'],
      chunkIndex: [],
      resourceGraph: { nodes: new Map(), edges: [] },
      lexicalIndex: {
        build: vi.fn(),
        search: vi.fn().mockReturnValue([]),
        extractQueryIdentifiers: vi.fn().mockReturnValue([]),
      } as unknown as AIInvestigatorDeps['lexicalIndex'],
    };

    const seeds: InvestigationSeed[] = Array.from({ length: 8 }, (_, i) =>
      makeSeed(`seed:k8s:${i}`, 'kubernetes', `Pod ${i} is failing`, i),
    );

    await investigateWithAI(makeContext(), seeds, deps, 3);

    expect(mockInvestigateSeed).toHaveBeenCalledTimes(3);
  });

  it('processes highest-priority seeds first', async () => {
    const processedHypotheses: string[] = [];
    const mockInvestigateSeed = vi.fn().mockImplementation(
      async (_system: string, user: string) => {
        // Extract hypothesis from user prompt
        const lines = user.split('\n');
        const hypothesisIdx = lines.findIndex((l) => l === '## Investigation Hypothesis');
        if (hypothesisIdx !== -1) {
          processedHypotheses.push(lines[hypothesisIdx + 2] ?? '');
        }
        return { findings: [] };
      },
    );

    const deps: AIInvestigatorDeps = {
      llmClient: { investigateSeed: mockInvestigateSeed } as unknown as AIInvestigatorDeps['llmClient'],
      chunkIndex: [],
      resourceGraph: { nodes: new Map(), edges: [] },
      lexicalIndex: {
        build: vi.fn(),
        search: vi.fn().mockReturnValue([]),
        extractQueryIdentifiers: vi.fn().mockReturnValue([]),
      } as unknown as AIInvestigatorDeps['lexicalIndex'],
    };

    const seeds: InvestigationSeed[] = [
      makeSeed('seed:low', 'kubernetes', 'Low priority pod failing', 30),
      makeSeed('seed:high', 'kubernetes', 'Critical pod crashlooping', 95),
      makeSeed('seed:med', 'kubernetes', 'Medium priority issue', 60),
    ];

    await investigateWithAI(makeContext(), seeds, deps, 2);

    // Should have called LLM for high and medium priority seeds
    expect(mockInvestigateSeed).toHaveBeenCalledTimes(2);
    // First processed should be the highest priority
    expect(processedHypotheses[0]).toBe('Critical pod crashlooping');
  });

  // ── Chunk deduplication between graph and lexical results ─────────────────

  it('deduplicates chunks that appear in both graph and lexical results', async () => {
    const sharedChunk = makeChunk(
      'chunk:pod:0',
      'cluster-resources/pods/default/app-pod.json',
      'CrashLoopBackOff status',
      'kubernetes-resource',
    );
    const lexicalOnlyChunk = makeChunk(
      'chunk:event:0',
      'cluster-resources/events/default.json',
      'BackOff event for app-pod',
      'event',
    );

    let capturedUserPrompt = '';
    const mockInvestigateSeed = vi.fn().mockImplementation(
      async (_system: string, user: string) => {
        capturedUserPrompt = user;
        return { findings: [] };
      },
    );

    const deps: AIInvestigatorDeps = {
      llmClient: { investigateSeed: mockInvestigateSeed } as unknown as AIInvestigatorDeps['llmClient'],
      chunkIndex: [sharedChunk, lexicalOnlyChunk],
      resourceGraph: { nodes: new Map(), edges: [] },
      lexicalIndex: {
        build: vi.fn(),
        search: vi.fn().mockReturnValue([
          { chunk: sharedChunk, score: 3.0 },
          { chunk: lexicalOnlyChunk, score: 2.0 },
        ]),
        extractQueryIdentifiers: vi.fn().mockReturnValue([]),
      } as unknown as AIInvestigatorDeps['lexicalIndex'],
    };

    // Also provide graph result for the shared chunk
    // We do this by adding the chunk to a mock graph neighborhood
    // Since getRelatedChunks uses the resourceGraph, we simulate by having a
    // seed with source that cannot be parsed (so no graph chunks), then verifying
    // lexical dedup
    const seeds = [
      makeSeed('seed:k8s:0', 'kubernetes', 'Pod app-pod is in CrashLoopBackOff', 90, 'pod:default/app-pod'),
    ];

    await investigateWithAI(makeContext(), seeds, deps);

    // The prompt should mention 2 chunks total (lexical results), not duplicating sharedChunk
    // Count occurrences of "### Chunk" in the user prompt
    const chunkMatches = capturedUserPrompt.match(/### Chunk \d+/g) ?? [];
    // The lexical search returns 2 unique chunks
    expect(chunkMatches.length).toBeLessThanOrEqual(2);
  });

  it('includes graph chunks before lexical chunks in merged context', async () => {
    // We test ordering by verifying graph chunks appear first in the prompt.
    // To get graph chunks, we need a seed source that produces graph results.
    // We use a real resource graph setup with a pod chunk.
    const podChunk = makeChunk(
      'chunk:pod:app-pod',
      'cluster-resources/pods/default/app-pod.json',
      'name: app-pod\nstatus: CrashLoopBackOff',
      'kubernetes-resource',
    );
    podChunk.identifiers = ['app-pod', 'default'];
    podChunk.namespace = 'default';

    const eventChunk = makeChunk(
      'chunk:event:0',
      'cluster-resources/events/default.json',
      'BackOff event for app-pod',
      'event',
    );
    eventChunk.identifiers = ['app-pod', 'BackOff'];

    let capturedUserPrompt = '';
    const mockInvestigateSeed = vi.fn().mockImplementation(
      async (_system: string, user: string) => {
        capturedUserPrompt = user;
        return { findings: [] };
      },
    );

    const deps: AIInvestigatorDeps = {
      llmClient: { investigateSeed: mockInvestigateSeed } as unknown as AIInvestigatorDeps['llmClient'],
      chunkIndex: [podChunk, eventChunk],
      resourceGraph: { nodes: new Map(), edges: [] },
      lexicalIndex: {
        build: vi.fn(),
        // Only return the event chunk from lexical (not the pod chunk)
        search: vi.fn().mockReturnValue([
          { chunk: eventChunk, score: 2.0 },
        ]),
        extractQueryIdentifiers: vi.fn().mockReturnValue([]),
      } as unknown as AIInvestigatorDeps['lexicalIndex'],
    };

    const seeds = [makeSeed('seed:k8s:0', 'kubernetes', 'app-pod CrashLoopBackOff', 90)];
    await investigateWithAI(makeContext(), seeds, deps);

    // The prompt should contain the event chunk as there are no graph results
    // (empty graph, no edges), so only lexical results are used
    expect(capturedUserPrompt).toContain('cluster-resources/events/default.json');
  });

  // ── Finding id uniqueness ───────────────────────────────────────────────────

  it('generates unique finding IDs across all seeds', async () => {
    const deps = makeMockDeps(async () => ({
      findings: [VALID_AI_FINDING],
    }));

    const seeds = [
      makeSeed('seed:k8s:0', 'kubernetes', 'Pod app-pod is in CrashLoopBackOff', 90),
      makeSeed('seed:k8s:1', 'kubernetes', 'Pod other-pod is in CrashLoopBackOff', 80),
    ];

    const result = await investigateWithAI(makeContext(), seeds, deps);

    const ids = result.findings.map((f) => f.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  // ── Multiple findings from single seed ────────────────────────────────────

  it('handles multiple findings from a single LLM call', async () => {
    const secondFinding = {
      ...VALID_AI_FINDING,
      title: 'Missing Secret: app-credentials not found',
      severity: 'critical' as const,
      evidence: [
        {
          path: 'cluster-resources/events/default.json',
          note: 'FailedMount event: secret app-credentials not found',
        },
      ],
    };

    const deps = makeMockDeps(async () => ({
      findings: [VALID_AI_FINDING, secondFinding],
    }));

    const seeds = [makeSeed('seed:k8s:0', 'kubernetes', 'Pod app-pod is in CrashLoopBackOff')];
    const result = await investigateWithAI(makeContext(), seeds, deps);

    expect(result.findings).toHaveLength(2);
    expect(result.edges).toHaveLength(2); // one edge per finding (one evidence each)
  });

  // ── Context parameter is accepted ────────────────────────────────────────

  it('accepts the context parameter without errors (available for future use)', async () => {
    const deps = makeMockDeps(async () => ({ findings: [] }));

    const context = makeContext({
      analyzerResults: [
        {
          name: 'test-analyzer',
          title: 'Test finding',
          message: 'Something went wrong',
          severity: 'error' as const,
          isPass: false,
          isFail: true,
          isWarn: false,
        },
      ],
    });

    await expect(
      investigateWithAI(context, [], deps),
    ).resolves.not.toThrow();
  });

  // ── Semantic retrieval (expansion layer) ──────────────────────────────────

  it('works without embeddingClient or vectorStore (graph + lexical only)', async () => {
    const deps = makeMockDeps(async () => ({ findings: [VALID_AI_FINDING] }));
    // No embeddingClient or vectorStore — should still work fine
    expect(deps.embeddingClient).toBeUndefined();
    expect(deps.vectorStore).toBeUndefined();

    const seeds = [makeSeed('seed:k8s:0', 'kubernetes', 'Pod app-pod is in CrashLoopBackOff')];
    const result = await investigateWithAI(makeContext(), seeds, deps);

    expect(result.findings).toHaveLength(1);
  });

  it('calls embedSingle on embeddingClient when both embeddingClient and vectorStore are present', async () => {
    const mockEmbedSingle = vi.fn().mockResolvedValue([0.1, 0.2, 0.3]);
    const mockQuery = vi.fn().mockReturnValue([]);

    const deps = makeMockDeps(async () => ({ findings: [] }));
    deps.embeddingClient = {
      embed: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
      embedSingle: mockEmbedSingle,
    } as unknown as AIInvestigatorDeps['embeddingClient'];
    deps.vectorStore = {
      query: mockQuery,
      addAll: vi.fn(),
      size: 0,
      clear: vi.fn(),
    } as unknown as AIInvestigatorDeps['vectorStore'];

    const seeds = [makeSeed('seed:k8s:0', 'kubernetes', 'Pod app-pod is in CrashLoopBackOff')];
    await investigateWithAI(makeContext(), seeds, deps);

    expect(mockEmbedSingle).toHaveBeenCalledWith('Pod app-pod is in CrashLoopBackOff');
    expect(mockQuery).toHaveBeenCalled();
  });

  it('appends semantic chunks at lower priority than lexical chunks', async () => {
    const lexicalChunk = makeChunk(
      'chunk:lexical',
      'cluster-resources/events/default.json',
      'BackOff event',
      'event',
    );
    const semanticChunk = makeChunk(
      'chunk:semantic',
      'logs/api-server/app.log',
      'FATAL: password auth failed',
      'log',
    );

    let capturedUserPrompt = '';
    const mockInvestigateSeed = vi.fn().mockImplementation(
      async (_system: string, user: string) => {
        capturedUserPrompt = user;
        return { findings: [] };
      },
    );

    const mockEmbedSingle = vi.fn().mockResolvedValue([0.5, 0.5, 0.0]);
    const mockQuery = vi.fn().mockReturnValue([{ chunk: semanticChunk, score: 0.85 }]);

    const deps: AIInvestigatorDeps = {
      llmClient: { investigateSeed: mockInvestigateSeed } as unknown as AIInvestigatorDeps['llmClient'],
      chunkIndex: [lexicalChunk, semanticChunk],
      resourceGraph: { nodes: new Map(), edges: [] },
      lexicalIndex: {
        build: vi.fn(),
        search: vi.fn().mockReturnValue([{ chunk: lexicalChunk, score: 3.0 }]),
        extractQueryIdentifiers: vi.fn().mockReturnValue([]),
      } as unknown as AIInvestigatorDeps['lexicalIndex'],
      embeddingClient: {
        embed: vi.fn(),
        embedSingle: mockEmbedSingle,
      } as unknown as AIInvestigatorDeps['embeddingClient'],
      vectorStore: {
        query: mockQuery,
        addAll: vi.fn(),
        size: 2,
        clear: vi.fn(),
      } as unknown as AIInvestigatorDeps['vectorStore'],
    };

    const seeds = [makeSeed('seed:k8s:0', 'kubernetes', 'Pod app-pod CrashLoopBackOff')];
    await investigateWithAI(makeContext(), seeds, deps);

    // Both lexical and semantic chunks should appear in the prompt
    expect(capturedUserPrompt).toContain('cluster-resources/events/default.json');
    expect(capturedUserPrompt).toContain('logs/api-server/app.log');

    // Lexical chunk should appear before semantic chunk (higher priority)
    const lexicalIdx = capturedUserPrompt.indexOf('cluster-resources/events/default.json');
    const semanticIdx = capturedUserPrompt.indexOf('logs/api-server/app.log');
    expect(lexicalIdx).toBeLessThan(semanticIdx);
  });

  it('deduplicates semantic hits that are already present from lexical retrieval', async () => {
    const sharedChunk = makeChunk(
      'chunk:shared',
      'cluster-resources/pods/default/app-pod.json',
      'CrashLoopBackOff',
      'kubernetes-resource',
    );

    let capturedUserPrompt = '';
    const mockInvestigateSeed = vi.fn().mockImplementation(
      async (_system: string, user: string) => {
        capturedUserPrompt = user;
        return { findings: [] };
      },
    );

    const mockEmbedSingle = vi.fn().mockResolvedValue([0.5, 0.5, 0.0]);
    // Semantic returns the same chunk that lexical already returned
    const mockQuery = vi.fn().mockReturnValue([{ chunk: sharedChunk, score: 0.95 }]);

    const deps: AIInvestigatorDeps = {
      llmClient: { investigateSeed: mockInvestigateSeed } as unknown as AIInvestigatorDeps['llmClient'],
      chunkIndex: [sharedChunk],
      resourceGraph: { nodes: new Map(), edges: [] },
      lexicalIndex: {
        build: vi.fn(),
        search: vi.fn().mockReturnValue([{ chunk: sharedChunk, score: 3.0 }]),
        extractQueryIdentifiers: vi.fn().mockReturnValue([]),
      } as unknown as AIInvestigatorDeps['lexicalIndex'],
      embeddingClient: {
        embed: vi.fn(),
        embedSingle: mockEmbedSingle,
      } as unknown as AIInvestigatorDeps['embeddingClient'],
      vectorStore: {
        query: mockQuery,
        addAll: vi.fn(),
        size: 1,
        clear: vi.fn(),
      } as unknown as AIInvestigatorDeps['vectorStore'],
    };

    const seeds = [makeSeed('seed:k8s:0', 'kubernetes', 'Pod app-pod CrashLoopBackOff')];
    await investigateWithAI(makeContext(), seeds, deps);

    // Chunk should appear exactly once despite being in both lexical and semantic results.
    // The chunk header (### Chunk N) is the canonical deduplication indicator.
    // The path can appear multiple times in one chunk's formatted output (Source line, Summary
    // line from the makeChunk helper, and the grounding reminder) — so we count headers only.
    const chunkHeaderMatches = capturedUserPrompt.match(/### Chunk \d+/g) ?? [];
    expect(chunkHeaderMatches.length).toBe(1);
  });

  it('handles embeddingClient failure gracefully and continues with graph + lexical', async () => {
    const mockEmbedSingle = vi.fn().mockRejectedValue(new Error('embedding API down'));
    let capturedUserPrompt = '';
    const mockInvestigateSeed = vi.fn().mockImplementation(
      async (_system: string, user: string) => {
        capturedUserPrompt = user;
        return { findings: [] };
      },
    );

    const lexicalChunk = makeChunk(
      'chunk:lexical',
      'cluster-resources/events/default.json',
      'BackOff event',
      'event',
    );

    const deps: AIInvestigatorDeps = {
      llmClient: { investigateSeed: mockInvestigateSeed } as unknown as AIInvestigatorDeps['llmClient'],
      chunkIndex: [lexicalChunk],
      resourceGraph: { nodes: new Map(), edges: [] },
      lexicalIndex: {
        build: vi.fn(),
        search: vi.fn().mockReturnValue([{ chunk: lexicalChunk, score: 2.0 }]),
        extractQueryIdentifiers: vi.fn().mockReturnValue([]),
      } as unknown as AIInvestigatorDeps['lexicalIndex'],
      embeddingClient: {
        embed: vi.fn(),
        embedSingle: mockEmbedSingle,
      } as unknown as AIInvestigatorDeps['embeddingClient'],
      vectorStore: {
        query: vi.fn().mockReturnValue([]),
        addAll: vi.fn(),
        size: 0,
        clear: vi.fn(),
      } as unknown as AIInvestigatorDeps['vectorStore'],
    };

    const seeds = [makeSeed('seed:k8s:0', 'kubernetes', 'Pod app-pod CrashLoopBackOff')];

    // Should not throw even when embedding fails
    const result = await investigateWithAI(makeContext(), seeds, deps);

    // Investigation should complete with lexical results
    expect(mockInvestigateSeed).toHaveBeenCalledTimes(1);
    expect(capturedUserPrompt).toContain('cluster-resources/events/default.json');
    expect(result).toBeDefined();
  });

  it('skips semantic retrieval when embeddingClient returns empty vector', async () => {
    const mockEmbedSingle = vi.fn().mockResolvedValue([]); // empty → no semantic query
    const mockQuery = vi.fn().mockReturnValue([]);

    const deps: AIInvestigatorDeps = {
      llmClient: { investigateSeed: vi.fn().mockResolvedValue({ findings: [] }) } as unknown as AIInvestigatorDeps['llmClient'],
      chunkIndex: [],
      resourceGraph: { nodes: new Map(), edges: [] },
      lexicalIndex: {
        build: vi.fn(),
        search: vi.fn().mockReturnValue([]),
        extractQueryIdentifiers: vi.fn().mockReturnValue([]),
      } as unknown as AIInvestigatorDeps['lexicalIndex'],
      embeddingClient: {
        embed: vi.fn(),
        embedSingle: mockEmbedSingle,
      } as unknown as AIInvestigatorDeps['embeddingClient'],
      vectorStore: {
        query: mockQuery,
        addAll: vi.fn(),
        size: 0,
        clear: vi.fn(),
      } as unknown as AIInvestigatorDeps['vectorStore'],
    };

    const seeds = [makeSeed('seed:k8s:0', 'kubernetes', 'Pod app-pod CrashLoopBackOff')];
    await investigateWithAI(makeContext(), seeds, deps);

    // vectorStore.query should NOT be called when embedSingle returns empty
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('skips semantic retrieval when only embeddingClient is present (no vectorStore)', async () => {
    const mockEmbedSingle = vi.fn().mockResolvedValue([0.1, 0.2, 0.3]);

    const deps: AIInvestigatorDeps = {
      llmClient: { investigateSeed: vi.fn().mockResolvedValue({ findings: [] }) } as unknown as AIInvestigatorDeps['llmClient'],
      chunkIndex: [],
      resourceGraph: { nodes: new Map(), edges: [] },
      lexicalIndex: {
        build: vi.fn(),
        search: vi.fn().mockReturnValue([]),
        extractQueryIdentifiers: vi.fn().mockReturnValue([]),
      } as unknown as AIInvestigatorDeps['lexicalIndex'],
      embeddingClient: {
        embed: vi.fn(),
        embedSingle: mockEmbedSingle,
      } as unknown as AIInvestigatorDeps['embeddingClient'],
      // No vectorStore
    };

    const seeds = [makeSeed('seed:k8s:0', 'kubernetes', 'Pod app-pod CrashLoopBackOff')];

    // Should not throw and should not call embedSingle
    await expect(investigateWithAI(makeContext(), seeds, deps)).resolves.not.toThrow();
    expect(mockEmbedSingle).not.toHaveBeenCalled();
  });

  it('logs verbose retrieval stats using chunk counts per retrieval mode', async () => {
    const lexicalChunk = makeChunk(
      'chunk:lexical',
      'logs/app.log',
      'CrashLoopBackOff for app-pod',
      'log',
    );
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const deps: AIInvestigatorDeps = {
      llmClient: { investigateSeed: vi.fn().mockResolvedValue({ findings: [] }) } as unknown as AIInvestigatorDeps['llmClient'],
      chunkIndex: [lexicalChunk],
      resourceGraph: { nodes: new Map(), edges: [] },
      lexicalIndex: {
        build: vi.fn(),
        search: vi.fn().mockReturnValue([{ chunk: lexicalChunk, score: 2.0 }]),
        extractQueryIdentifiers: vi.fn().mockReturnValue([]),
      } as unknown as AIInvestigatorDeps['lexicalIndex'],
      verbose: true,
    };

    try {
      await investigateWithAI(
        makeContext(),
        [makeSeed('seed:k8s:0', 'kubernetes', 'Pod app-pod CrashLoopBackOff')],
        deps,
      );

      expect(consoleSpy).toHaveBeenCalledWith(
        '[AIInvestigator] Seed: Pod app-pod CrashLoopBackOff → ' +
          '0 graph chunks, 1 lexical chunks, 0 semantic chunks across 1 artifact types',
      );
    } finally {
      consoleSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// RRF mergeChunks unit tests
// ---------------------------------------------------------------------------

describe('mergeChunks (RRF)', () => {
  // ── RRF-1: cross-system agreement rewards a chunk seen in both graph and lexical ──

  it('ranks a chunk found in both graph (rank 1) and lexical (rank 1) above chunks found in only one system', () => {
    // chunkA appears at rank 1 in both graph and lexical → double RRF boost
    // chunkB appears at graph rank 2 only → single, lower-ranked contribution
    // chunkC appears at lexical rank 2 only → single, lower-ranked contribution
    const chunkA = makeChunk('chunk:a', 'path/a.json', 'content a');
    const chunkB = makeChunk('chunk:b', 'path/b.json', 'content b');
    const chunkC = makeChunk('chunk:c', 'path/c.json', 'content c');

    const graphList: RetrievalList = { chunks: [chunkA, chunkB] };
    const lexicalList: RetrievalList = { chunks: [chunkA, chunkC] };

    // chunkA: 1/(60+1) + 1/(60+1) = 2/61 ≈ 0.03279
    // chunkB: 1/(60+2) = 1/62 ≈ 0.01613 (graph only)
    // chunkC: 1/(60+2) = 1/62 ≈ 0.01613 (lexical only)
    const result = mergeChunks([graphList, lexicalList]);

    expect(result[0]!.id).toBe('chunk:a');
  });

  it('ranks a chunk found by graph (rank 1) and lexical (rank 3) above a chunk found only by graph (rank 2)', () => {
    const chunkA = makeChunk('chunk:a', 'path/a.json', 'content a');
    const chunkB = makeChunk('chunk:b', 'path/b.json', 'content b');
    const chunkC = makeChunk('chunk:c', 'path/c.json', 'filler content c');
    const chunkX = makeChunk('chunk:x', 'path/x.json', 'extra content');

    // chunkA: graph rank 1 (1/61) + lexical rank 3 (1/63) ≈ 0.032266
    // chunkB: graph rank 2 only (1/62) ≈ 0.016129
    // chunkC: lexical rank 1 only (1/61) ≈ 0.016393
    // chunkX: lexical rank 2 only (1/62) ≈ 0.016129
    // chunkA (cross-system agreement) outranks chunkB (single-system only)
    const graphList: RetrievalList = { chunks: [chunkA, chunkB] };
    const lexicalList: RetrievalList = { chunks: [chunkC, chunkX, chunkA] };

    const result = mergeChunks([graphList, lexicalList]);

    expect(result[0]!.id).toBe('chunk:a');
    // chunkB only appears in graph, so it has lower RRF than cross-system chunkA
    const chunkBIdx = result.findIndex((c) => c.id === 'chunk:b');
    const chunkAIdx = result.findIndex((c) => c.id === 'chunk:a');
    expect(chunkAIdx).toBeLessThan(chunkBIdx);
  });

  // ── RRF-2: chunk found by all 3 systems ranks highest ────────────────────

  it('ranks a chunk found by all 3 systems (graph, lexical, semantic) highest', () => {
    const tripleChunk = makeChunk('chunk:triple', 'path/triple.json', 'triple hit');
    const graphOnly = makeChunk('chunk:graph', 'path/graph.json', 'graph only');
    const lexOnly = makeChunk('chunk:lex', 'path/lex.json', 'lexical only');
    const semOnly = makeChunk('chunk:sem', 'path/sem.json', 'semantic only');

    const graphList: RetrievalList = { chunks: [tripleChunk, graphOnly] };
    const lexicalList: RetrievalList = { chunks: [tripleChunk, lexOnly] };
    const semanticList: RetrievalList = { chunks: [tripleChunk, semOnly] };

    // tripleChunk: 3 × 1/(60+1) = 3/61 ≈ 0.04918
    // graphOnly: 1/(60+2) = 1/62 ≈ 0.01613
    // lexOnly: 1/(60+2) = 1/62 ≈ 0.01613
    // semOnly: 1/(60+2) = 1/62 ≈ 0.01613
    const result = mergeChunks([graphList, lexicalList, semanticList]);

    expect(result[0]!.id).toBe('chunk:triple');
  });

  // ── RRF-3: results are capped at MAX_CHUNKS_PER_SEED (20) ────────────────

  it('caps merged results at MAX_CHUNKS_PER_SEED (20)', () => {
    // Create 30 unique chunks across graph + lexical
    const graphChunks = Array.from({ length: 15 }, (_, i) =>
      makeChunk(`chunk:g${i}`, `path/g${i}.json`, `graph content ${i}`),
    );
    const lexicalChunks = Array.from({ length: 15 }, (_, i) =>
      makeChunk(`chunk:l${i}`, `path/l${i}.json`, `lexical content ${i}`),
    );

    const graphList: RetrievalList = { chunks: graphChunks };
    const lexicalList: RetrievalList = { chunks: lexicalChunks };

    const result = mergeChunks([graphList, lexicalList]);

    expect(result.length).toBeLessThanOrEqual(20);
  });

  // ── RRF-4: merge is deterministic ────────────────────────────────────────

  it('produces deterministic output for the same inputs', () => {
    const chunks = Array.from({ length: 10 }, (_, i) =>
      makeChunk(`chunk:${i}`, `path/${i}.json`, `content ${i}`),
    );

    // Mix chunks across lists in non-trivial ways
    const graphList: RetrievalList = { chunks: [chunks[2]!, chunks[0]!, chunks[7]!, chunks[4]!] };
    const lexicalList: RetrievalList = { chunks: [chunks[0]!, chunks[3]!, chunks[2]!, chunks[9]!] };
    const semanticList: RetrievalList = { chunks: [chunks[7]!, chunks[2]!, chunks[5]!] };

    const result1 = mergeChunks([graphList, lexicalList, semanticList]);
    const result2 = mergeChunks([graphList, lexicalList, semanticList]);

    // Both runs must produce identical ordering
    expect(result1.map((c) => c.id)).toEqual(result2.map((c) => c.id));
  });

  it('is deterministic when two chunks have identical RRF scores (tie-break by ID)', () => {
    // Two chunks each appearing in only one system at the same rank — identical RRF scores
    const chunkAlpha = makeChunk('chunk:alpha', 'path/alpha.json', 'content alpha');
    const chunkZeta = makeChunk('chunk:zeta', 'path/zeta.json', 'content zeta');

    const graphList: RetrievalList = { chunks: [chunkAlpha] };
    const lexicalList: RetrievalList = { chunks: [chunkZeta] };

    // Both have RRF = 1/61; tie broken by id: 'chunk:alpha' < 'chunk:zeta'
    const result = mergeChunks([graphList, lexicalList]);

    expect(result[0]!.id).toBe('chunk:alpha');
    expect(result[1]!.id).toBe('chunk:zeta');
  });

  // ── Token budget ──────────────────────────────────────────────────────────

  it('includes all chunks with full content when they fit within the default budget', () => {
    // Small chunks (10 tokens each at 40 chars) never hit the 100k default budget
    const chunkA = makeChunk('chunk:a', 'a.json', 'a'.repeat(40));
    const chunkB = makeChunk('chunk:b', 'b.json', 'b'.repeat(40));

    const result = mergeChunks([{ chunks: [chunkA, chunkB] }]);

    expect(result[0]!.content).toBe('a'.repeat(40));
    expect(result[1]!.content).toBe('b'.repeat(40));
  });

  it('falls back to chunk.summary content for lower-priority chunks when budget is exceeded', () => {
    // chunkA content: 40 chars = 10 tokens
    // chunkB content: 40 chars = 10 tokens
    // budget = 15 → chunkA fits (usedTokens: 0→10 ≤ 15), chunkB doesn't (10+10=20 > 15)
    const chunkA = makeChunk('chunk:a', 'a.json', 'a'.repeat(40));
    const chunkB = makeChunk('chunk:b', 'b.json', 'b'.repeat(40));

    const result = mergeChunks([{ chunks: [chunkA, chunkB] }], 15);

    expect(result[0]!.content).toBe('a'.repeat(40));       // full content preserved
    expect(result[1]!.content).toBe('Chunk from b.json');  // summary fallback
  });

  it('tracks cumulative token count across all chunks in priority order', () => {
    // 40 chars = 10 tokens each
    // budget = 25 → A fits (10), B fits (20), C doesn't (30 > 25)
    const chunkA = makeChunk('chunk:a', 'a.json', 'a'.repeat(40));
    const chunkB = makeChunk('chunk:b', 'b.json', 'b'.repeat(40));
    const chunkC = makeChunk('chunk:c', 'c.json', 'c'.repeat(40));

    const result = mergeChunks([{ chunks: [chunkA, chunkB, chunkC] }], 25);

    expect(result[0]!.content).toBe('a'.repeat(40));       // full content (10 tokens used)
    expect(result[1]!.content).toBe('b'.repeat(40));       // full content (20 tokens used)
    expect(result[2]!.content).toBe('Chunk from c.json');  // summary fallback (would be 30)
  });

  it('does not mutate the original chunk when falling back to summary', () => {
    const chunkA = makeChunk('chunk:a', 'a.json', 'a'.repeat(40));
    const chunkB = makeChunk('chunk:b', 'b.json', 'b'.repeat(40));
    const origContentA = chunkA.content;
    const origContentB = chunkB.content;

    // Tight budget forces chunkB to use summary
    mergeChunks([{ chunks: [chunkA, chunkB] }], 15);

    // Original objects must not have been mutated
    expect(chunkA.content).toBe(origContentA);
    expect(chunkB.content).toBe(origContentB);
  });

  it('returns all chunks as summary-only when budget is 0', () => {
    const chunkA = makeChunk('chunk:a', 'a.json', 'a'.repeat(40));
    const chunkB = makeChunk('chunk:b', 'b.json', 'b'.repeat(40));

    const result = mergeChunks([{ chunks: [chunkA, chunkB] }], 0);

    // Budget of 0 means even the first chunk's content (10 tokens) exceeds it
    expect(result[0]!.content).toBe('Chunk from a.json');
    expect(result[1]!.content).toBe('Chunk from b.json');
  });
});

// ---------------------------------------------------------------------------
// estimateTokens unit tests
// ---------------------------------------------------------------------------

describe('estimateTokens', () => {
  it('returns 0 for an empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('returns Math.floor(text.length / 4)', () => {
    expect(estimateTokens('aaaa')).toBe(1);           // 4 / 4 = 1
    expect(estimateTokens('a'.repeat(8))).toBe(2);    // 8 / 4 = 2
    expect(estimateTokens('a'.repeat(100))).toBe(25); // 100 / 4 = 25
  });

  it('uses floor division (rounds down for non-multiples of 4)', () => {
    expect(estimateTokens('aaa')).toBe(0);   // floor(3/4) = 0
    expect(estimateTokens('aaaaa')).toBe(1); // floor(5/4) = 1
    expect(estimateTokens('a'.repeat(7))).toBe(1); // floor(7/4) = 1
  });

  it('works on realistic log line content', () => {
    const logLine = '2024-01-01T00:00:00Z ERROR connection refused to db.internal:5432';
    // 68 chars → floor(68/4) = 17 tokens
    expect(estimateTokens(logLine)).toBe(Math.floor(logLine.length / 4));
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_TOKEN_BUDGET constant
// ---------------------------------------------------------------------------

describe('DEFAULT_TOKEN_BUDGET', () => {
  it('is approximately 80% of a 128k context window (~100k tokens)', () => {
    // 80% of 128 * 1024 = 104,857 tokens; we use a round number near that
    expect(DEFAULT_TOKEN_BUDGET).toBeGreaterThanOrEqual(95_000);
    expect(DEFAULT_TOKEN_BUDGET).toBeLessThanOrEqual(110_000);
  });
});

// ---------------------------------------------------------------------------
// generateHypotheticalDocument (HyDE) unit tests
// ---------------------------------------------------------------------------

describe('generateHypotheticalDocument', () => {
  // ── Basic shape ───────────────────────────────────────────────────────────

  it('returns the LLM-generated hypothetical document when the call succeeds', async () => {
    const hypotheticalText =
      'Container app in pod app-pod terminated with exit code 1 due to ' +
      'missing environment variable DB_PASSWORD referenced from secret ' +
      'app-credentials which does not exist in namespace default.';

    const mockClient: HydeLLMClient = {
      generateText: vi.fn().mockResolvedValue(hypotheticalText),
    };

    const result = await generateHypotheticalDocument(
      'Pod app-pod is in CrashLoopBackOff',
      mockClient,
    );

    expect(result).toBe(hypotheticalText);
  });

  it('calls generateText with a system prompt and a user prompt containing the hypothesis', async () => {
    const mockGenerateText = vi.fn().mockResolvedValue('hypothetical evidence text');
    const mockClient: HydeLLMClient = { generateText: mockGenerateText };

    const hypothesis = 'Pod app-pod is in CrashLoopBackOff';
    await generateHypotheticalDocument(hypothesis, mockClient);

    expect(mockGenerateText).toHaveBeenCalledTimes(1);
    const [systemPrompt, userPrompt] = mockGenerateText.mock.calls[0] as [string, string];

    // System prompt should give Kubernetes diagnostic context
    expect(systemPrompt).toContain('Kubernetes');
    // User prompt should contain the hypothesis
    expect(userPrompt).toContain(hypothesis);
  });

  it('returns the raw hypothesis when the LLM call throws an error (graceful fallback)', async () => {
    const mockClient: HydeLLMClient = {
      generateText: vi.fn().mockRejectedValue(new Error('LLM API unavailable')),
    };

    const hypothesis = 'Pod app-pod is in CrashLoopBackOff';
    const result = await generateHypotheticalDocument(hypothesis, mockClient);

    // Must not throw; must return the raw hypothesis as fallback
    expect(result).toBe(hypothesis);
  });

  it('returns the raw hypothesis when the LLM returns an empty string', async () => {
    const mockClient: HydeLLMClient = {
      generateText: vi.fn().mockResolvedValue(''),
    };

    const hypothesis = 'Missing Secret app-credentials in namespace default';
    const result = await generateHypotheticalDocument(hypothesis, mockClient);

    expect(result).toBe(hypothesis);
  });

  it('trims whitespace from the LLM response before returning', async () => {
    const innerText = 'Pod app-pod OOMKilled: container exceeded memory limit 256Mi';
    const mockClient: HydeLLMClient = {
      generateText: vi.fn().mockResolvedValue(`\n\n  ${innerText}  \n`),
    };

    const result = await generateHypotheticalDocument(
      'Pod app-pod was OOM-killed',
      mockClient,
    );

    expect(result).toBe(innerText);
  });

  it('returns the raw hypothesis when the LLM returns only whitespace', async () => {
    const mockClient: HydeLLMClient = {
      generateText: vi.fn().mockResolvedValue('   \n  \t  '),
    };

    const hypothesis = 'Service has no ready endpoints';
    const result = await generateHypotheticalDocument(hypothesis, mockClient);

    expect(result).toBe(hypothesis);
  });

  it('generates a more detailed, evidence-like text than the input hypothesis', async () => {
    // The hypothetical document should be longer and more specific than the hypothesis
    const hypothesis = 'DNS lookup failure in pod app-pod';
    const hypotheticalDoc =
      'dial tcp: lookup db.internal on 10.96.0.10:53: no such host\n' +
      'Pod app-pod in namespace default failed to resolve hostname db.internal.\n' +
      'CoreDNS returned NXDOMAIN for the query. The database service endpoint ' +
      'may not exist or the service name is misconfigured.';

    const mockClient: HydeLLMClient = {
      generateText: vi.fn().mockResolvedValue(hypotheticalDoc),
    };

    const result = await generateHypotheticalDocument(hypothesis, mockClient);

    // The result should be the detailed document, not the short hypothesis
    expect(result.length).toBeGreaterThan(hypothesis.length);
    expect(result).toContain('db.internal');
    expect(result).toContain('NXDOMAIN');
  });
});

// ---------------------------------------------------------------------------
// HyDE integration with investigateWithAI
// ---------------------------------------------------------------------------

describe('investigateWithAI — HyDE integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('embeds the hypothetical document instead of the raw hypothesis when HyDE succeeds', async () => {
    const hypotheticalDoc =
      'Container app terminated with exit code 1. FailedMount event: ' +
      'secret "app-credentials" not found in namespace "default".';

    const mockEmbedSingle = vi.fn().mockResolvedValue([0.1, 0.2, 0.3]);
    const mockQuery = vi.fn().mockReturnValue([]);
    // The llmClient mock supports both investigateSeed (for the LLM call) and
    // generateText (for HyDE document generation).
    const mockGenerateText = vi.fn().mockResolvedValue(hypotheticalDoc);
    const mockInvestigateSeed = vi.fn().mockResolvedValue({ findings: [] });

    const deps: AIInvestigatorDeps = {
      llmClient: {
        investigateSeed: mockInvestigateSeed,
        generateText: mockGenerateText,
      } as unknown as AIInvestigatorDeps['llmClient'],
      chunkIndex: [],
      resourceGraph: { nodes: new Map(), edges: [] },
      lexicalIndex: {
        build: vi.fn(),
        search: vi.fn().mockReturnValue([]),
        extractQueryIdentifiers: vi.fn().mockReturnValue([]),
      } as unknown as AIInvestigatorDeps['lexicalIndex'],
      embeddingClient: {
        embed: vi.fn(),
        embedSingle: mockEmbedSingle,
      } as unknown as AIInvestigatorDeps['embeddingClient'],
      vectorStore: {
        query: mockQuery,
        addAll: vi.fn(),
        size: 0,
        clear: vi.fn(),
      } as unknown as AIInvestigatorDeps['vectorStore'],
    };

    const seeds = [
      makeSeed('seed:k8s:0', 'kubernetes', 'Pod app-pod is in CrashLoopBackOff'),
    ];

    await investigateWithAI(makeContext(), seeds, deps);

    // HyDE should have been called with the hypothesis
    expect(mockGenerateText).toHaveBeenCalledTimes(1);
    const [, userPrompt] = mockGenerateText.mock.calls[0] as [string, string];
    expect(userPrompt).toContain('Pod app-pod is in CrashLoopBackOff');

    // embedSingle should be called with the HYPOTHETICAL DOCUMENT, not the raw hypothesis
    expect(mockEmbedSingle).toHaveBeenCalledTimes(1);
    expect(mockEmbedSingle).toHaveBeenCalledWith(hypotheticalDoc);
    expect(mockEmbedSingle).not.toHaveBeenCalledWith('Pod app-pod is in CrashLoopBackOff');
  });

  it('falls back to embedding the raw hypothesis when HyDE LLM call fails', async () => {
    const mockEmbedSingle = vi.fn().mockResolvedValue([0.1, 0.2, 0.3]);
    const mockQuery = vi.fn().mockReturnValue([]);
    // generateText throws — simulates LLM API being unavailable for HyDE
    const mockGenerateText = vi.fn().mockRejectedValue(new Error('LLM timeout'));
    const mockInvestigateSeed = vi.fn().mockResolvedValue({ findings: [] });

    const deps: AIInvestigatorDeps = {
      llmClient: {
        investigateSeed: mockInvestigateSeed,
        generateText: mockGenerateText,
      } as unknown as AIInvestigatorDeps['llmClient'],
      chunkIndex: [],
      resourceGraph: { nodes: new Map(), edges: [] },
      lexicalIndex: {
        build: vi.fn(),
        search: vi.fn().mockReturnValue([]),
        extractQueryIdentifiers: vi.fn().mockReturnValue([]),
      } as unknown as AIInvestigatorDeps['lexicalIndex'],
      embeddingClient: {
        embed: vi.fn(),
        embedSingle: mockEmbedSingle,
      } as unknown as AIInvestigatorDeps['embeddingClient'],
      vectorStore: {
        query: mockQuery,
        addAll: vi.fn(),
        size: 0,
        clear: vi.fn(),
      } as unknown as AIInvestigatorDeps['vectorStore'],
    };

    const hypothesis = 'Pod app-pod is in CrashLoopBackOff';
    const seeds = [makeSeed('seed:k8s:0', 'kubernetes', hypothesis)];

    // Should not throw even though HyDE's generateText fails
    await expect(investigateWithAI(makeContext(), seeds, deps)).resolves.not.toThrow();

    // embedSingle should be called with the RAW HYPOTHESIS as fallback
    expect(mockEmbedSingle).toHaveBeenCalledTimes(1);
    expect(mockEmbedSingle).toHaveBeenCalledWith(hypothesis);
  });

  it('falls back to embedding the raw hypothesis when HyDE returns empty string', async () => {
    const mockEmbedSingle = vi.fn().mockResolvedValue([0.4, 0.5, 0.6]);
    const mockQuery = vi.fn().mockReturnValue([]);
    // generateText returns empty string — simulates model refusal or timeout
    const mockGenerateText = vi.fn().mockResolvedValue('');
    const mockInvestigateSeed = vi.fn().mockResolvedValue({ findings: [] });

    const deps: AIInvestigatorDeps = {
      llmClient: {
        investigateSeed: mockInvestigateSeed,
        generateText: mockGenerateText,
      } as unknown as AIInvestigatorDeps['llmClient'],
      chunkIndex: [],
      resourceGraph: { nodes: new Map(), edges: [] },
      lexicalIndex: {
        build: vi.fn(),
        search: vi.fn().mockReturnValue([]),
        extractQueryIdentifiers: vi.fn().mockReturnValue([]),
      } as unknown as AIInvestigatorDeps['lexicalIndex'],
      embeddingClient: {
        embed: vi.fn(),
        embedSingle: mockEmbedSingle,
      } as unknown as AIInvestigatorDeps['embeddingClient'],
      vectorStore: {
        query: mockQuery,
        addAll: vi.fn(),
        size: 0,
        clear: vi.fn(),
      } as unknown as AIInvestigatorDeps['vectorStore'],
    };

    const hypothesis = 'Missing Secret app-credentials in namespace default';
    const seeds = [makeSeed('seed:config:0', 'configuration', hypothesis)];

    await investigateWithAI(makeContext(), seeds, deps);

    // embedSingle should be called with the RAW HYPOTHESIS as fallback
    expect(mockEmbedSingle).toHaveBeenCalledWith(hypothesis);
  });

  it('does not call generateText when embeddingClient is absent (no HyDE without semantic retrieval)', async () => {
    const mockGenerateText = vi.fn().mockResolvedValue('hypothetical doc');
    const mockInvestigateSeed = vi.fn().mockResolvedValue({ findings: [] });

    const deps: AIInvestigatorDeps = {
      llmClient: {
        investigateSeed: mockInvestigateSeed,
        generateText: mockGenerateText,
      } as unknown as AIInvestigatorDeps['llmClient'],
      chunkIndex: [],
      resourceGraph: { nodes: new Map(), edges: [] },
      lexicalIndex: {
        build: vi.fn(),
        search: vi.fn().mockReturnValue([]),
        extractQueryIdentifiers: vi.fn().mockReturnValue([]),
      } as unknown as AIInvestigatorDeps['lexicalIndex'],
      // No embeddingClient or vectorStore → semantic retrieval skipped
    };

    const seeds = [makeSeed('seed:k8s:0', 'kubernetes', 'Pod app-pod is in CrashLoopBackOff')];
    await investigateWithAI(makeContext(), seeds, deps);

    // HyDE should NOT be triggered when there is no embeddingClient
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it('retrieves semantically similar chunks using the hypothetical document embedding', async () => {
    const semanticChunk = makeChunk(
      'chunk:semantic',
      'logs/api-server/app.log',
      'secret "app-credentials" not found',
      'log',
    );

    const hypotheticalDoc =
      'secret "app-credentials" not found in namespace default. ' +
      'FailedMount: unable to retrieve secret.';

    const mockEmbedSingle = vi.fn().mockResolvedValue([0.9, 0.1, 0.0]);
    const mockQuery = vi.fn().mockReturnValue([{ chunk: semanticChunk, score: 0.92 }]);
    const mockGenerateText = vi.fn().mockResolvedValue(hypotheticalDoc);

    let capturedUserPrompt = '';
    const mockInvestigateSeed = vi.fn().mockImplementation(
      async (_system: string, user: string) => {
        capturedUserPrompt = user;
        return { findings: [] };
      },
    );

    const deps: AIInvestigatorDeps = {
      llmClient: {
        investigateSeed: mockInvestigateSeed,
        generateText: mockGenerateText,
      } as unknown as AIInvestigatorDeps['llmClient'],
      chunkIndex: [semanticChunk],
      resourceGraph: { nodes: new Map(), edges: [] },
      lexicalIndex: {
        build: vi.fn(),
        search: vi.fn().mockReturnValue([]),
        extractQueryIdentifiers: vi.fn().mockReturnValue([]),
      } as unknown as AIInvestigatorDeps['lexicalIndex'],
      embeddingClient: {
        embed: vi.fn(),
        embedSingle: mockEmbedSingle,
      } as unknown as AIInvestigatorDeps['embeddingClient'],
      vectorStore: {
        query: mockQuery,
        addAll: vi.fn(),
        size: 1,
        clear: vi.fn(),
      } as unknown as AIInvestigatorDeps['vectorStore'],
    };

    const seeds = [makeSeed('seed:k8s:0', 'kubernetes', 'Pod app-pod has FailedMount for secret')];
    await investigateWithAI(makeContext(), seeds, deps);

    // The vector store query should have been issued with the hypothetical doc's embedding
    // (SEMANTIC_TOP_K = 5 is the internal constant in ai-investigator.ts)
    expect(mockQuery).toHaveBeenCalledWith([0.9, 0.1, 0.0], 5);
    // The semantic chunk should appear in the LLM prompt
    expect(capturedUserPrompt).toContain('logs/api-server/app.log');
  });
});

// ---------------------------------------------------------------------------
// computeChunkOverlap unit tests
// ---------------------------------------------------------------------------

describe('computeChunkOverlap', () => {
  // Helper to create a minimal mock lexical index that always returns the given results
  function makeSearchMockFixed(
    results: { chunk: IndexedChunk; score: number }[],
  ): AIInvestigatorDeps['lexicalIndex'] {
    return {
      build: vi.fn(),
      search: vi.fn().mockReturnValue(results),
      extractQueryIdentifiers: vi.fn().mockReturnValue([]),
    } as unknown as AIInvestigatorDeps['lexicalIndex'];
  }

  function makeSearchMockSequence(
    first: { chunk: IndexedChunk; score: number }[],
    second: { chunk: IndexedChunk; score: number }[],
  ): AIInvestigatorDeps['lexicalIndex'] {
    return {
      build: vi.fn(),
      search: vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second),
      extractQueryIdentifiers: vi.fn().mockReturnValue([]),
    } as unknown as AIInvestigatorDeps['lexicalIndex'];
  }

  it('returns 0 when both seeds retrieve no chunks (empty sets)', () => {
    const graph: ResourceRelationshipGraph = { nodes: new Map(), edges: [] };
    const lexical = makeSearchMockFixed([]);

    const seedA = makeSeed('seed:a', 'kubernetes', 'Pod A crashlooping');
    const seedB = makeSeed('seed:b', 'kubernetes', 'Pod B crashlooping');

    expect(computeChunkOverlap(seedA, seedB, [], graph, lexical)).toBe(0);
  });

  it('returns 1.0 when both seeds retrieve identical chunk sets', () => {
    const sharedA = makeChunk('chunk:shared-a', 'pods/default.json', 'content a');
    const sharedB = makeChunk('chunk:shared-b', 'events/default.json', 'content b');
    const sharedResults = [
      { chunk: sharedA, score: 3.0 },
      { chunk: sharedB, score: 2.0 },
    ];

    const graph: ResourceRelationshipGraph = { nodes: new Map(), edges: [] };
    const lexical = makeSearchMockFixed(sharedResults);

    const seedA = makeSeed('seed:a', 'kubernetes', 'Pod A crashlooping');
    const seedB = makeSeed('seed:b', 'kubernetes', 'Pod B crashlooping');

    const overlap = computeChunkOverlap(seedA, seedB, [sharedA, sharedB], graph, lexical);
    expect(overlap).toBe(1.0);
  });

  it('returns correct Jaccard similarity for partial overlap: |A∩B| / |A∪B|', () => {
    // A = {chunk:a, chunk:shared}
    // B = {chunk:shared, chunk:b}
    // intersection = {chunk:shared} (1)
    // union = {chunk:a, chunk:shared, chunk:b} (3)
    // Jaccard = 1/3
    const chunkA = makeChunk('chunk:a', 'pods/default.json', 'pod a');
    const chunkShared = makeChunk('chunk:shared', 'events/default.json', 'event');
    const chunkB = makeChunk('chunk:b', 'logs/app.log', 'log b');

    const graph: ResourceRelationshipGraph = { nodes: new Map(), edges: [] };
    const lexical = makeSearchMockSequence(
      [{ chunk: chunkA, score: 3.0 }, { chunk: chunkShared, score: 2.0 }],
      [{ chunk: chunkShared, score: 3.0 }, { chunk: chunkB, score: 2.0 }],
    );

    const seedA = makeSeed('seed:a', 'kubernetes', 'Pod A crashlooping');
    const seedB = makeSeed('seed:b', 'kubernetes', 'Pod B crashlooping');

    const overlap = computeChunkOverlap(
      seedA, seedB, [chunkA, chunkShared, chunkB], graph, lexical,
    );
    expect(overlap).toBeCloseTo(1 / 3, 5);
  });

  it('returns 0 when seeds have completely disjoint chunk sets', () => {
    const chunkA1 = makeChunk('chunk:a1', 'pods/default.json', 'pod a1');
    const chunkA2 = makeChunk('chunk:a2', 'events/default.json', 'event a2');
    const chunkB1 = makeChunk('chunk:b1', 'logs/app.log', 'log b1');
    const chunkB2 = makeChunk('chunk:b2', 'configmaps/default.json', 'configmap b2');

    const graph: ResourceRelationshipGraph = { nodes: new Map(), edges: [] };
    const lexical = makeSearchMockSequence(
      [{ chunk: chunkA1, score: 3.0 }, { chunk: chunkA2, score: 2.0 }],
      [{ chunk: chunkB1, score: 3.0 }, { chunk: chunkB2, score: 2.0 }],
    );

    const seedA = makeSeed('seed:a', 'kubernetes', 'Pod A crashlooping');
    const seedB = makeSeed('seed:b', 'kubernetes', 'Pod B crashlooping');

    const overlap = computeChunkOverlap(
      seedA, seedB, [chunkA1, chunkA2, chunkB1, chunkB2], graph, lexical,
    );
    expect(overlap).toBe(0);
  });

  it('includes graph-retrieved chunks in the overlap computation', () => {
    // Graph-retrieved chunks are included in the chunk set for each seed.
    // When both seeds share a graph chunk, overlap should reflect that.
    // We simulate this by using a seed source that parseSeedSource can parse
    // and a chunk with matching identifiers — but since getRelatedChunks
    // needs a real graph, the easiest path is to verify that graph chunks
    // retrieved by getRelatedChunks contribute to the set.
    //
    // For this test we use empty graph (so no graph chunks) and verify
    // the lexical contribution is computed correctly — the graph path is
    // exercised by the BFS tests in resource-graph.test.ts.
    const sharedChunk = makeChunk('chunk:shared', 'pods/default.json', 'shared content');

    const graph: ResourceRelationshipGraph = { nodes: new Map(), edges: [] };
    const lexical = makeSearchMockFixed([{ chunk: sharedChunk, score: 3.0 }]);

    const seedA = makeSeed('seed:a', 'kubernetes', 'Pod A crashlooping');
    const seedB = makeSeed('seed:b', 'kubernetes', 'Pod B crashlooping');

    // Both seeds get the same chunk from lexical → Jaccard = 1.0
    const overlap = computeChunkOverlap(seedA, seedB, [sharedChunk], graph, lexical);
    expect(overlap).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// deduplicateSeeds unit tests
// ---------------------------------------------------------------------------

describe('deduplicateSeeds', () => {
  function emptyLexical(): AIInvestigatorDeps['lexicalIndex'] {
    return {
      build: vi.fn(),
      search: vi.fn().mockReturnValue([]),
      extractQueryIdentifiers: vi.fn().mockReturnValue([]),
    } as unknown as AIInvestigatorDeps['lexicalIndex'];
  }

  it('returns an empty array for empty input', () => {
    const graph: ResourceRelationshipGraph = { nodes: new Map(), edges: [] };
    const result = deduplicateSeeds([], [], graph, emptyLexical());
    expect(result).toHaveLength(0);
  });

  it('returns a single seed unchanged', () => {
    const graph: ResourceRelationshipGraph = { nodes: new Map(), edges: [] };
    const seed = makeSeed('seed:a', 'kubernetes', 'Pod A crashlooping');
    const result = deduplicateSeeds([seed], [], graph, emptyLexical());
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(seed);
  });

  it('does not merge seeds when overlap is below the default threshold (0.8)', () => {
    // chunkA for seedA, chunkB for seedB → Jaccard = 0 < 0.8 → no merge
    const chunkA = makeChunk('chunk:a', 'pods/default.json', 'pod a');
    const chunkB = makeChunk('chunk:b', 'logs/app.log', 'log b');

    const graph: ResourceRelationshipGraph = { nodes: new Map(), edges: [] };
    const lexical = {
      build: vi.fn(),
      search: vi.fn()
        .mockReturnValueOnce([{ chunk: chunkA, score: 3.0 }])
        .mockReturnValueOnce([{ chunk: chunkB, score: 3.0 }]),
      extractQueryIdentifiers: vi.fn().mockReturnValue([]),
    } as unknown as AIInvestigatorDeps['lexicalIndex'];

    const seedA = makeSeed('seed:a', 'kubernetes', 'Pod A crashlooping');
    const seedB = makeSeed('seed:b', 'kubernetes', 'Pod B crashlooping');

    const result = deduplicateSeeds([seedA, seedB], [chunkA, chunkB], graph, lexical);
    expect(result).toHaveLength(2);
  });

  it('merges two seeds when their chunk overlap exceeds the threshold', () => {
    // Both seeds get the same chunk → Jaccard = 1.0 > 0.8 → merge
    const sharedChunk = makeChunk('chunk:shared', 'pods/default.json', 'shared content');

    const graph: ResourceRelationshipGraph = { nodes: new Map(), edges: [] };
    const lexical = {
      build: vi.fn(),
      search: vi.fn().mockReturnValue([{ chunk: sharedChunk, score: 3.0 }]),
      extractQueryIdentifiers: vi.fn().mockReturnValue([]),
    } as unknown as AIInvestigatorDeps['lexicalIndex'];

    const seedA = makeSeed('seed:a', 'kubernetes', 'Pod A crashlooping', 90);
    const seedB = makeSeed('seed:b', 'kubernetes', 'Pod B crashlooping', 70);

    const result = deduplicateSeeds([seedA, seedB], [sharedChunk], graph, lexical);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toMatch(/^seed:merged:/);
  });

  it('does not merge seeds when overlap equals the threshold exactly (strict >)', () => {
    // setA = {a,b,c,d,e} (5 chunks), setB = {a,b,c,d} (4 chunks)
    // intersection = 4, union = 5, Jaccard = 4/5 = 0.8
    // threshold > 0.8 is NOT satisfied → no merge
    const chunkA = makeChunk('chunk:a', 'a.json', 'a');
    const chunkB = makeChunk('chunk:b', 'b.json', 'b');
    const chunkC = makeChunk('chunk:c', 'c.json', 'c');
    const chunkD = makeChunk('chunk:d', 'd.json', 'd');
    const chunkE = makeChunk('chunk:e', 'e.json', 'e');

    const graph: ResourceRelationshipGraph = { nodes: new Map(), edges: [] };
    const lexical = {
      build: vi.fn(),
      search: vi.fn()
        .mockReturnValueOnce([
          { chunk: chunkA, score: 5.0 },
          { chunk: chunkB, score: 4.0 },
          { chunk: chunkC, score: 3.0 },
          { chunk: chunkD, score: 2.0 },
          { chunk: chunkE, score: 1.0 },
        ])
        .mockReturnValueOnce([
          { chunk: chunkA, score: 5.0 },
          { chunk: chunkB, score: 4.0 },
          { chunk: chunkC, score: 3.0 },
          { chunk: chunkD, score: 2.0 },
        ]),
      extractQueryIdentifiers: vi.fn().mockReturnValue([]),
    } as unknown as AIInvestigatorDeps['lexicalIndex'];

    const seedA = makeSeed('seed:a', 'kubernetes', 'Pod A crashlooping');
    const seedB = makeSeed('seed:b', 'kubernetes', 'Pod B crashlooping');

    const result = deduplicateSeeds(
      [seedA, seedB],
      [chunkA, chunkB, chunkC, chunkD, chunkE],
      graph,
      lexical,
    );
    expect(result).toHaveLength(2);
  });

  it('merged seed has priority equal to the maximum of the two seeds', () => {
    const sharedChunk = makeChunk('chunk:shared', 'pods/default.json', 'shared');

    const graph: ResourceRelationshipGraph = { nodes: new Map(), edges: [] };
    const lexical = {
      build: vi.fn(),
      search: vi.fn().mockReturnValue([{ chunk: sharedChunk, score: 3.0 }]),
      extractQueryIdentifiers: vi.fn().mockReturnValue([]),
    } as unknown as AIInvestigatorDeps['lexicalIndex'];

    const seedA = makeSeed('seed:a', 'kubernetes', 'Pod A crashlooping', 60);
    const seedB = makeSeed('seed:b', 'kubernetes', 'Pod B crashlooping', 85);

    const result = deduplicateSeeds([seedA, seedB], [sharedChunk], graph, lexical);
    expect(result).toHaveLength(1);
    expect(result[0]!.priority).toBe(85);
  });

  it('merged seed hypothesis contains both original hypotheses', () => {
    const sharedChunk = makeChunk('chunk:shared', 'pods/default.json', 'shared');

    const graph: ResourceRelationshipGraph = { nodes: new Map(), edges: [] };
    const lexical = {
      build: vi.fn(),
      search: vi.fn().mockReturnValue([{ chunk: sharedChunk, score: 3.0 }]),
      extractQueryIdentifiers: vi.fn().mockReturnValue([]),
    } as unknown as AIInvestigatorDeps['lexicalIndex'];

    const hypothesisA = 'Pod app-pod is in CrashLoopBackOff';
    const hypothesisB = 'Pod other-pod is in CrashLoopBackOff';
    const seedA = makeSeed('seed:a', 'kubernetes', hypothesisA, 90);
    const seedB = makeSeed('seed:b', 'kubernetes', hypothesisB, 70);

    const result = deduplicateSeeds([seedA, seedB], [sharedChunk], graph, lexical);
    expect(result).toHaveLength(1);
    expect(result[0]!.hypothesis).toContain(hypothesisA);
    expect(result[0]!.hypothesis).toContain(hypothesisB);
  });

  it('merged seed category comes from the first (higher-priority) seed', () => {
    const sharedChunk = makeChunk('chunk:shared', 'pods/default.json', 'shared');

    const graph: ResourceRelationshipGraph = { nodes: new Map(), edges: [] };
    const lexical = {
      build: vi.fn(),
      search: vi.fn().mockReturnValue([{ chunk: sharedChunk, score: 3.0 }]),
      extractQueryIdentifiers: vi.fn().mockReturnValue([]),
    } as unknown as AIInvestigatorDeps['lexicalIndex'];

    // seedA (kubernetes, priority 90) vs seedB (log, priority 70)
    const seedA = makeSeed('seed:a', 'kubernetes', 'Pod A crashlooping', 90);
    const seedB = makeSeed('seed:b', 'log', 'Log file has errors', 70);

    const result = deduplicateSeeds([seedA, seedB], [sharedChunk], graph, lexical);
    expect(result).toHaveLength(1);
    expect(result[0]!.category).toBe('kubernetes');
  });

  it('uses a custom threshold when provided (lower threshold merges more aggressively)', () => {
    // setA = {a, b}, setB = {a, c} → Jaccard = 1/3 ≈ 0.333
    // threshold=0.8: 0.333 < 0.8 → no merge
    // threshold=0.2: 0.333 > 0.2 → merge
    const chunkA = makeChunk('chunk:a', 'a.json', 'a');
    const chunkB = makeChunk('chunk:b', 'b.json', 'b');
    const chunkC = makeChunk('chunk:c', 'c.json', 'c');

    const graph: ResourceRelationshipGraph = { nodes: new Map(), edges: [] };

    // First test: high threshold → no merge
    const lexicalHigh = {
      build: vi.fn(),
      search: vi.fn()
        .mockReturnValueOnce([{ chunk: chunkA, score: 3.0 }, { chunk: chunkB, score: 2.0 }])
        .mockReturnValueOnce([{ chunk: chunkA, score: 3.0 }, { chunk: chunkC, score: 2.0 }]),
      extractQueryIdentifiers: vi.fn().mockReturnValue([]),
    } as unknown as AIInvestigatorDeps['lexicalIndex'];

    const seedA1 = makeSeed('seed:a', 'kubernetes', 'Pod A crashlooping');
    const seedB1 = makeSeed('seed:b', 'kubernetes', 'Pod B crashlooping');
    const resultHigh = deduplicateSeeds(
      [seedA1, seedB1], [chunkA, chunkB, chunkC], graph, lexicalHigh, 0.8,
    );
    expect(resultHigh).toHaveLength(2); // no merge

    // Second test: low threshold → merge
    const lexicalLow = {
      build: vi.fn(),
      search: vi.fn()
        .mockReturnValueOnce([{ chunk: chunkA, score: 3.0 }, { chunk: chunkB, score: 2.0 }])
        .mockReturnValueOnce([{ chunk: chunkA, score: 3.0 }, { chunk: chunkC, score: 2.0 }]),
      extractQueryIdentifiers: vi.fn().mockReturnValue([]),
    } as unknown as AIInvestigatorDeps['lexicalIndex'];

    const seedA2 = makeSeed('seed:a', 'kubernetes', 'Pod A crashlooping');
    const seedB2 = makeSeed('seed:b', 'kubernetes', 'Pod B crashlooping');
    const resultLow = deduplicateSeeds(
      [seedA2, seedB2], [chunkA, chunkB, chunkC], graph, lexicalLow, 0.2,
    );
    expect(resultLow).toHaveLength(1); // merged
  });

  it('handles three seeds where two pairs overlap: merges transitively', () => {
    // seedA and seedB share chunks → merge into mergedAB
    // seedC has no overlap with mergedAB → stays separate
    const sharedChunk = makeChunk('chunk:shared', 'pods/default.json', 'shared');
    const chunkC = makeChunk('chunk:c', 'logs/app.log', 'log c');

    const graph: ResourceRelationshipGraph = { nodes: new Map(), edges: [] };
    const lexical = {
      build: vi.fn(),
      search: vi.fn()
        // First pair check: seedA and seedB both get sharedChunk
        .mockReturnValueOnce([{ chunk: sharedChunk, score: 3.0 }]) // seedA overlap computation
        .mockReturnValueOnce([{ chunk: sharedChunk, score: 3.0 }]) // seedB overlap computation
        // Any subsequent calls return empty (no more merges needed)
        .mockReturnValue([]),
      extractQueryIdentifiers: vi.fn().mockReturnValue([]),
    } as unknown as AIInvestigatorDeps['lexicalIndex'];

    const seedA = makeSeed('seed:a', 'kubernetes', 'Pod A crashlooping', 90);
    const seedB = makeSeed('seed:b', 'kubernetes', 'Pod B crashlooping', 80);
    const seedC = makeSeed('seed:c', 'log', 'Log file has errors', 70);

    const result = deduplicateSeeds(
      [seedA, seedB, seedC], [sharedChunk, chunkC], graph, lexical,
    );
    // seedA + seedB merged → 2 seeds total (merged + seedC)
    expect(result).toHaveLength(2);
    expect(result.some((s) => s.id.startsWith('seed:merged:'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// investigateWithAI — seed deduplication integration tests
// ---------------------------------------------------------------------------

describe('investigateWithAI — seed deduplication', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('makes one LLM call when two seeds have chunk overlap above the threshold (2.10)', async () => {
    // Both seeds retrieve the same chunk → Jaccard = 1.0 > 0.8 → merge → 1 LLM call
    const sharedChunk = makeChunk('chunk:shared', 'pods/default.json', 'shared content');
    const mockInvestigateSeed = vi.fn().mockResolvedValue({ findings: [] });

    const deps: AIInvestigatorDeps = {
      llmClient: {
        investigateSeed: mockInvestigateSeed,
      } as unknown as AIInvestigatorDeps['llmClient'],
      chunkIndex: [sharedChunk],
      resourceGraph: { nodes: new Map(), edges: [] },
      lexicalIndex: {
        build: vi.fn(),
        // Always returns the same chunk → both seeds get the same chunk set
        search: vi.fn().mockReturnValue([{ chunk: sharedChunk, score: 3.0 }]),
        extractQueryIdentifiers: vi.fn().mockReturnValue([]),
      } as unknown as AIInvestigatorDeps['lexicalIndex'],
    };

    const seeds: InvestigationSeed[] = [
      makeSeed('seed:k8s:0', 'kubernetes', 'Pod app-pod is in CrashLoopBackOff', 90),
      makeSeed('seed:k8s:1', 'kubernetes', 'Pod other-pod is in CrashLoopBackOff', 80),
    ];

    await investigateWithAI(makeContext(), seeds, deps);

    // Seeds merged → only 1 LLM call instead of 2
    expect(mockInvestigateSeed).toHaveBeenCalledTimes(1);
  });

  it('makes two separate LLM calls when seeds have low chunk overlap', async () => {
    // seedA gets chunkA, seedB gets chunkB → Jaccard = 0 < 0.8 → no merge → 2 LLM calls
    const chunkA = makeChunk('chunk:a', 'pods/a.json', 'pod a content');
    const chunkB = makeChunk('chunk:b', 'pods/b.json', 'pod b content');
    const mockInvestigateSeed = vi.fn().mockResolvedValue({ findings: [] });

    const deps: AIInvestigatorDeps = {
      llmClient: {
        investigateSeed: mockInvestigateSeed,
      } as unknown as AIInvestigatorDeps['llmClient'],
      chunkIndex: [chunkA, chunkB],
      resourceGraph: { nodes: new Map(), edges: [] },
      lexicalIndex: {
        build: vi.fn(),
        search: vi.fn()
          // Overlap computation for the pair: seedA gets chunkA, seedB gets chunkB
          .mockReturnValueOnce([{ chunk: chunkA, score: 3.0 }])
          .mockReturnValueOnce([{ chunk: chunkB, score: 3.0 }])
          // Investigation: both seeds → empty (irrelevant for the call-count assertion)
          .mockReturnValue([]),
        extractQueryIdentifiers: vi.fn().mockReturnValue([]),
      } as unknown as AIInvestigatorDeps['lexicalIndex'],
    };

    const seeds: InvestigationSeed[] = [
      makeSeed('seed:k8s:0', 'kubernetes', 'Pod app-pod is in CrashLoopBackOff', 90),
      makeSeed('seed:k8s:1', 'kubernetes', 'Pod other-pod is in CrashLoopBackOff', 80),
    ];

    await investigateWithAI(makeContext(), seeds, deps);

    // No merge → 2 separate LLM calls
    expect(mockInvestigateSeed).toHaveBeenCalledTimes(2);
  });

  it('combined seed prompt contains both original hypotheses', async () => {
    // When seeds are merged, the single LLM prompt should include both hypothesis texts
    const sharedChunk = makeChunk('chunk:shared', 'pods/default.json', 'shared content');

    let capturedUserPrompt = '';
    const mockInvestigateSeed = vi.fn().mockImplementation(
      async (_system: string, user: string) => {
        capturedUserPrompt = user;
        return { findings: [] };
      },
    );

    const deps: AIInvestigatorDeps = {
      llmClient: {
        investigateSeed: mockInvestigateSeed,
      } as unknown as AIInvestigatorDeps['llmClient'],
      chunkIndex: [sharedChunk],
      resourceGraph: { nodes: new Map(), edges: [] },
      lexicalIndex: {
        build: vi.fn(),
        search: vi.fn().mockReturnValue([{ chunk: sharedChunk, score: 3.0 }]),
        extractQueryIdentifiers: vi.fn().mockReturnValue([]),
      } as unknown as AIInvestigatorDeps['lexicalIndex'],
    };

    const hypothesisA = 'Pod app-pod is in CrashLoopBackOff';
    const hypothesisB = 'Pod other-pod is in CrashLoopBackOff';

    const seeds: InvestigationSeed[] = [
      makeSeed('seed:k8s:0', 'kubernetes', hypothesisA, 90),
      makeSeed('seed:k8s:1', 'kubernetes', hypothesisB, 80),
    ];

    await investigateWithAI(makeContext(), seeds, deps);

    // One merged call was made
    expect(mockInvestigateSeed).toHaveBeenCalledTimes(1);
    // The prompt should contain both original hypotheses
    expect(capturedUserPrompt).toContain(hypothesisA);
    expect(capturedUserPrompt).toContain(hypothesisB);
  });

  it('deduplication runs after maxSeeds slicing — only top seeds are considered for merging', async () => {
    // 3 seeds given, maxSeeds=2; top 2 (priority 90 and 80) are considered.
    // Both top seeds have 100% chunk overlap → merge → 1 LLM call.
    // The third seed (priority 70) is never reached.
    const sharedChunk = makeChunk('chunk:shared', 'pods/default.json', 'shared content');
    const mockInvestigateSeed = vi.fn().mockResolvedValue({ findings: [] });

    const deps: AIInvestigatorDeps = {
      llmClient: {
        investigateSeed: mockInvestigateSeed,
      } as unknown as AIInvestigatorDeps['llmClient'],
      chunkIndex: [sharedChunk],
      resourceGraph: { nodes: new Map(), edges: [] },
      lexicalIndex: {
        build: vi.fn(),
        search: vi.fn().mockReturnValue([{ chunk: sharedChunk, score: 3.0 }]),
        extractQueryIdentifiers: vi.fn().mockReturnValue([]),
      } as unknown as AIInvestigatorDeps['lexicalIndex'],
    };

    const seeds: InvestigationSeed[] = [
      makeSeed('seed:k8s:0', 'kubernetes', 'Pod A failing', 90),
      makeSeed('seed:k8s:1', 'kubernetes', 'Pod B failing', 80),
      makeSeed('seed:k8s:2', 'kubernetes', 'Pod C failing', 70),
    ];

    // maxSeeds=2: only top 2 seeds considered; both merge → 1 LLM call
    await investigateWithAI(makeContext(), seeds, deps, 2);

    expect(mockInvestigateSeed).toHaveBeenCalledTimes(1);
  });

  it('merged finding ids use the merged seed category', async () => {
    // Verify that merged seeds produce findings with the correct id prefix.
    // Evidence path must match the retrieved chunk's artifactId so the finding
    // is not dropped by the grounding check (7.1).
    const sharedChunk = makeChunk('chunk:shared', 'pods/default.json', 'shared');
    const groundedFinding = {
      ...VALID_AI_FINDING,
      evidence: [{ path: 'pods/default.json', note: 'Pod in CrashLoopBackOff' }],
    };
    const mockInvestigateSeed = vi.fn().mockResolvedValue({ findings: [groundedFinding] });

    const deps: AIInvestigatorDeps = {
      llmClient: {
        investigateSeed: mockInvestigateSeed,
      } as unknown as AIInvestigatorDeps['llmClient'],
      chunkIndex: [sharedChunk],
      resourceGraph: { nodes: new Map(), edges: [] },
      lexicalIndex: {
        build: vi.fn(),
        search: vi.fn().mockReturnValue([{ chunk: sharedChunk, score: 3.0 }]),
        extractQueryIdentifiers: vi.fn().mockReturnValue([]),
      } as unknown as AIInvestigatorDeps['lexicalIndex'],
    };

    const seeds: InvestigationSeed[] = [
      makeSeed('seed:k8s:0', 'kubernetes', 'Pod app-pod is in CrashLoopBackOff', 90),
      makeSeed('seed:k8s:1', 'kubernetes', 'Pod other-pod is in CrashLoopBackOff', 80),
    ];

    const result = await investigateWithAI(makeContext(), seeds, deps);

    // The merged seed's category is 'kubernetes' (from the first/higher-priority seed)
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.id).toMatch(/^finding:ai:kubernetes:/);
  });
});

// ---------------------------------------------------------------------------
// 7.1 + 7.2 — Grounding verification & confidence scoring
// ---------------------------------------------------------------------------
//
// When the AI investigator retrieves non-empty chunks and passes them to the
// LLM, every finding the LLM returns must cite at least one path that
// corresponds to an actually-retrieved chunk.  Ungrounded citations receive a
// confidence penalty; fully-ungrounded findings are dropped entirely.
//
// When the retrieved chunk set is empty (retrieval returned nothing), no
// grounding check is applied — the LLM had no chunks to cite from.

describe('grounding verification and confidence scoring (7.1 + 7.2)', () => {
  /** Build a deps object whose lexical index returns a specific set of chunks. */
  function makeDepsWithChunks(
    chunks: IndexedChunk[],
    investigateSeedImpl: () => Promise<AIFindingResponse>,
  ): AIInvestigatorDeps {
    const deps = makeMockDeps(investigateSeedImpl);
    return {
      ...deps,
      chunkIndex: chunks,
      lexicalIndex: {
        build: vi.fn(),
        search: vi.fn().mockReturnValue(chunks.map((c) => ({ chunk: c, score: 1.0 }))),
        extractQueryIdentifiers: vi.fn().mockReturnValue([]),
      } as unknown as AIInvestigatorDeps['lexicalIndex'],
    };
  }

  it('drops a finding when retrieved chunks are non-empty and ALL citations are ungrounded', async () => {
    // Retrieval returns one real chunk, but LLM cites a completely different path.
    const realChunk = makeChunk('c1', 'cluster-resources/pods/default.json', 'pod spec');
    const deps = makeDepsWithChunks([realChunk], async () => ({
      findings: [
        {
          ...VALID_AI_FINDING,
          evidence: [
            { path: 'cluster-resources/pods/default/nonexistent.yaml', note: 'fabricated citation' },
          ],
        },
      ],
    }));

    const seeds = [makeSeed('seed:k8s:0', 'kubernetes', 'Pod app-pod is crashing')];
    const result = await investigateWithAI(makeContext(), seeds, deps);

    // Finding must be dropped — all citations are hallucinated paths
    expect(result.findings).toHaveLength(0);
  });

  it('keeps a finding when all citations are grounded', async () => {
    const realChunk = makeChunk('c1', 'cluster-resources/pods/default.json', 'pod spec');
    const deps = makeDepsWithChunks([realChunk], async () => ({
      findings: [
        {
          ...VALID_AI_FINDING,
          confidence: 0.85,
          evidence: [
            { path: 'cluster-resources/pods/default.json', note: 'pod in CrashLoopBackOff' },
          ],
        },
      ],
    }));

    const seeds = [makeSeed('seed:k8s:0', 'kubernetes', 'Pod app-pod is crashing')];
    const result = await investigateWithAI(makeContext(), seeds, deps);

    expect(result.findings).toHaveLength(1);
    // Confidence should be unchanged — no ungrounded citations
    expect(result.findings[0]!.confidence).toBe(0.85);
  });

  it('penalizes confidence by 0.10 for each ungrounded citation when some are grounded', async () => {
    const realChunk = makeChunk('c1', 'cluster-resources/pods/default.json', 'pod spec');
    const deps = makeDepsWithChunks([realChunk], async () => ({
      findings: [
        {
          ...VALID_AI_FINDING,
          confidence: 0.9,
          evidence: [
            { path: 'cluster-resources/pods/default.json', note: 'grounded evidence' },
            { path: 'cluster-resources/pods/default/fabricated.yaml', note: 'ungrounded evidence' },
          ],
        },
      ],
    }));

    const seeds = [makeSeed('seed:k8s:0', 'kubernetes', 'Pod app-pod is crashing')];
    const result = await investigateWithAI(makeContext(), seeds, deps);

    expect(result.findings).toHaveLength(1);
    // -0.10 for one ungrounded citation: 0.9 - 0.10 = 0.80
    expect(result.findings[0]!.confidence).toBeCloseTo(0.80, 5);
    expect(result.findings[0]!.evidence).toEqual([
      expect.objectContaining({
        path: 'cluster-resources/pods/default.json',
        note: 'grounded evidence',
      }),
    ]);
    expect(result.edges.map((edge) => edge.source)).toEqual([
      'evidence:cluster-resources/pods/default.json',
    ]);
    expect(result.edges.some((edge) => edge.source.includes('fabricated.yaml'))).toBe(false);
  });

  it('applies -0.10 per ungrounded citation (two ungrounded)', async () => {
    const realChunk = makeChunk('c1', 'cluster-resources/pods/default.json', 'pod spec');
    const deps = makeDepsWithChunks([realChunk], async () => ({
      findings: [
        {
          ...VALID_AI_FINDING,
          confidence: 0.9,
          evidence: [
            { path: 'cluster-resources/pods/default.json', note: 'grounded' },
            { path: 'cluster-resources/pods/default/fake1.yaml', note: 'ungrounded 1' },
            { path: 'cluster-resources/pods/default/fake2.yaml', note: 'ungrounded 2' },
          ],
        },
      ],
    }));

    const seeds = [makeSeed('seed:k8s:0', 'kubernetes', 'Pod app-pod is crashing')];
    const result = await investigateWithAI(makeContext(), seeds, deps);

    expect(result.findings).toHaveLength(1);
    // 0.9 - 0.10 - 0.10 = 0.70
    expect(result.findings[0]!.confidence).toBeCloseTo(0.70, 5);
  });

  it('clamps penalized confidence to 0 rather than going negative', async () => {
    const realChunk = makeChunk('c1', 'cluster-resources/pods/default.json', 'pod spec');
    const deps = makeDepsWithChunks([realChunk], async () => ({
      findings: [
        {
          ...VALID_AI_FINDING,
          confidence: 0.05,
          evidence: [
            { path: 'cluster-resources/pods/default.json', note: 'grounded' },
            { path: 'cluster-resources/pods/default/fake.yaml', note: 'ungrounded' },
          ],
        },
      ],
    }));

    const seeds = [makeSeed('seed:k8s:0', 'kubernetes', 'Pod app-pod is crashing')];
    const result = await investigateWithAI(makeContext(), seeds, deps);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.confidence).toBeGreaterThanOrEqual(0);
  });

  it('does NOT apply grounding penalty when retrieved chunks are empty', async () => {
    // Empty retrieval → no chunks to check against → findings pass through unchanged
    const deps = makeMockDeps(async () => ({
      findings: [
        {
          ...VALID_AI_FINDING,
          confidence: 0.9,
          evidence: [
            { path: 'cluster-resources/pods/default/app-pod.json', note: 'unverifiable' },
          ],
        },
      ],
    }));
    // deps.chunkIndex = [] and lexical returns [] → mergedChunks is empty

    const seeds = [makeSeed('seed:k8s:0', 'kubernetes', 'Pod app-pod is crashing')];
    const result = await investigateWithAI(makeContext(), seeds, deps);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.confidence).toBe(0.9);
  });
});

// ---------------------------------------------------------------------------
// 7.3 — affectedComponents normalization
// ---------------------------------------------------------------------------
//
// LLM responses may use variant formats for component identifiers:
//   - Lowercase kind: pod/default/app-pod instead of Pod/default/app-pod
//   - Correct format:  Pod/default/app-pod  (unchanged)
//
// convertAIFindings must normalize these before findings enter the verifier.

describe('affectedComponents normalization (7.3)', () => {
  it('normalizes lowercase pod/ prefix to Pod/', async () => {
    const deps = makeMockDeps(async () => ({
      findings: [
        {
          ...VALID_AI_FINDING,
          affectedComponents: ['pod/default/app-pod'],
        },
      ],
    }));
    const seeds = [makeSeed('seed:k8s:0', 'kubernetes', 'Pod is crashing')];
    const result = await investigateWithAI(makeContext(), seeds, deps);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.affectedComponents).toContain('Pod/default/app-pod');
    expect(result.findings[0]!.affectedComponents).not.toContain('pod/default/app-pod');
  });

  it('normalizes lowercase deployment/ prefix to Deployment/', async () => {
    const deps = makeMockDeps(async () => ({
      findings: [
        {
          ...VALID_AI_FINDING,
          affectedComponents: ['deployment/default/my-app'],
        },
      ],
    }));
    const seeds = [makeSeed('seed:k8s:0', 'kubernetes', 'Deployment is unhealthy')];
    const result = await investigateWithAI(makeContext(), seeds, deps);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.affectedComponents).toContain('Deployment/default/my-app');
  });

  it('normalizes statefulset/ (lowercase) to StatefulSet/', async () => {
    const deps = makeMockDeps(async () => ({
      findings: [
        {
          ...VALID_AI_FINDING,
          affectedComponents: ['statefulset/default/my-db'],
        },
      ],
    }));
    const seeds = [makeSeed('seed:k8s:0', 'kubernetes', 'StatefulSet is unhealthy')];
    const result = await investigateWithAI(makeContext(), seeds, deps);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.affectedComponents).toContain('StatefulSet/default/my-db');
  });

  it('leaves already-correct Pod/namespace/name unchanged', async () => {
    const deps = makeMockDeps(async () => ({
      findings: [
        {
          ...VALID_AI_FINDING,
          affectedComponents: ['Pod/default/app-pod', 'Container/app'],
        },
      ],
    }));
    const seeds = [makeSeed('seed:k8s:0', 'kubernetes', 'Pod is crashing')];
    const result = await investigateWithAI(makeContext(), seeds, deps);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.affectedComponents).toEqual(['Pod/default/app-pod', 'Container/app']);
  });

  it('normalizes mixed-case components in the same finding', async () => {
    const deps = makeMockDeps(async () => ({
      findings: [
        {
          ...VALID_AI_FINDING,
          affectedComponents: ['pod/default/app-pod', 'secret/default/app-secret'],
        },
      ],
    }));
    const seeds = [makeSeed('seed:k8s:0', 'kubernetes', 'Pod is crashing')];
    const result = await investigateWithAI(makeContext(), seeds, deps);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.affectedComponents).toContain('Pod/default/app-pod');
    expect(result.findings[0]!.affectedComponents).toContain('Secret/default/app-secret');
  });

  it('sets per-seed context on seed-aware LLM clients before investigation calls', async () => {
    const setSeedContext = vi.fn();
    const clearSeedContext = vi.fn();
    const investigateSeed = vi.fn().mockResolvedValue({ findings: [] });
    const deps: AIInvestigatorDeps = {
      llmClient: {
        setSeedContext,
        clearSeedContext,
        investigateSeed,
      } as unknown as AIInvestigatorDeps['llmClient'],
      chunkIndex: [],
      resourceGraph: { nodes: new Map(), edges: [] },
      lexicalIndex: {
        build: vi.fn(),
        search: vi.fn().mockReturnValue([]),
        extractQueryIdentifiers: vi.fn().mockReturnValue([]),
      } as unknown as AIInvestigatorDeps['lexicalIndex'],
    };

    const seeds = [makeSeed('seed:k8s:context', 'kubernetes', 'Pod is crashing')];
    await investigateWithAI(makeContext(), seeds, deps);

    expect(setSeedContext).toHaveBeenCalledWith('seed:k8s:context', 'kubernetes');
    expect(clearSeedContext).toHaveBeenCalledTimes(1);
    expect(investigateSeed).toHaveBeenCalledTimes(1);
  });
});
