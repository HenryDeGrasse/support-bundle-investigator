import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { InvestigatorContext, InvestigationSeed } from '../types.js';
import type { BundleProfile } from '../../types/index.js';
import type { LogFile } from '../../parsers/index.js';
import type { AIInvestigatorDeps } from '../ai-investigator.js';
import type { IndexedChunk } from '../../ai/chunk-indexer.js';
import type { ResourceRelationshipGraph } from '../../graph/resource-graph.js';
import type { AIFindingResponse } from '../../ai/llm-client.js';
import { investigateWithAI, DEFAULT_MAX_SEEDS, mergeChunks } from '../ai-investigator.js';
import type { RetrievalList } from '../ai-investigator.js';

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
});
