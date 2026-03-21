// ---------------------------------------------------------------------------
// Pipeline AI integration tests
//
// Tests the conditional AI path in analyzeBundlePipeline:
// - AI path skipped when no API key (OPENAI_API_KEY not set)
// - AI path skipped when --no-ai flag is set
// - AI deps passed to orchestrator when AI is enabled (mocked)
// - Graceful fallback when AI setup throws
// - Trace includes ai-index step when AI is active
//
// These tests mock all heavy dependencies (ingestion, parsers, graph,
// investigators) so they run fast without real bundles or API calls.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — must be at top level before imports
// ---------------------------------------------------------------------------

// Mock ingestion
vi.mock('../../ingestion/index.js', () => ({
  extractBundle: vi.fn(),
  profileBundle: vi.fn(),
}));

// Mock parsers
vi.mock('../../parsers/index.js', () => ({
  parseAnalyzerFile: vi.fn().mockResolvedValue([]),
  mergeAnalyzerResults: vi.fn().mockReturnValue([]),
  parseResourceFile: vi.fn().mockResolvedValue([]),
  parseEventFile: vi.fn().mockResolvedValue([]),
  identifyLogFiles: vi.fn().mockReturnValue([]),
  parseLogFile: vi.fn().mockResolvedValue({ path: '', lines: [], errorCount: 0, warningCount: 0, importance: 0 }),
  sortEventsByTime: vi.fn((events: unknown[]) => [...events]),
  parseHelmReleaseFile: vi.fn().mockResolvedValue([]),
}));

// Mock graph — minimal implementation of what analyze.ts needs
vi.mock('../../graph/index.js', () => {
  const diagGraph = {
    addNode: vi.fn(), addEdge: vi.fn(),
    getNode: vi.fn().mockReturnValue(undefined),
    getEdgesFrom: vi.fn().mockReturnValue([]),
    getEdgesTo: vi.fn().mockReturnValue([]),
    getNeighbors: vi.fn().mockReturnValue([]),
    nodes: new Map(), edges: [],
    toResourceRelationshipGraph: vi.fn().mockReturnValue({ nodes: new Map(), edges: [] }),
  };
  return {
    InvestigationGraphImpl: vi.fn().mockImplementation(() => ({
      addNode: vi.fn(),
      addEdge: vi.fn(),
      getNode: vi.fn().mockReturnValue(null),
    })),
    buildResourceGraph: vi.fn().mockReturnValue({ nodes: new Map(), edges: [] }),
    buildDiagnosticGraph: vi.fn().mockReturnValue(diagGraph),
    buildWorkloadGroups: vi.fn(),
    addTemporalCorrelationEdges: vi.fn(),
    addTemporalSequenceEdges: vi.fn(),
    asResourceRelationshipGraph: vi.fn().mockReturnValue({ nodes: new Map(), edges: [] }),
  };
});

// Mock investigators — runInvestigation is the key integration point
vi.mock('../../investigators/index.js', () => ({
  runInvestigation: vi.fn(),
}));

// Mock AI module — selectively mock AI functions
vi.mock('../../ai/index.js', () => ({
  loadAIConfig: vi.fn(),
  isAIEnabled: vi.fn(),
  buildChunkIndex: vi.fn(),
  LexicalSearchIndex: vi.fn(),
  LLMClient: vi.fn(),
  ReplayableLLMClient: vi.fn(),
  CassetteRecorder: vi.fn(),
  defaultSeedResolver: vi.fn(),
  getRecorderMode: vi.fn(),
  EmbeddingClient: vi.fn(),
  createEmbeddingClient: vi.fn(),
  VectorStore: vi.fn(),
  zeroAIRunStats: vi.fn((model = 'unknown') => ({
    model,
    totalCalls: 0,
    successfulCalls: 0,
    failedCalls: 0,
    totalLatencyMs: 0,
    avgLatencyMs: 0,
  })),
  toAIRunSummary: vi.fn((stats, backend, fallbackModel) => ({
    ...stats,
    model: backend === 'off' ? 'off' : (stats?.model ?? fallbackModel ?? 'unknown'),
    backend,
  })),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { analyzeBundlePipeline } from '../analyze.js';
import { extractBundle, profileBundle } from '../../ingestion/index.js';
import { mergeAnalyzerResults, identifyLogFiles } from '../../parsers/index.js';
import { runInvestigation } from '../../investigators/index.js';
import {
  loadAIConfig,
  isAIEnabled,
  buildChunkIndex,
  LexicalSearchIndex,
  LLMClient,
  ReplayableLLMClient,
  CassetteRecorder,
  defaultSeedResolver,
  getRecorderMode,
  EmbeddingClient,
  createEmbeddingClient,
  VectorStore,
} from '../../ai/index.js';
import { buildDiagnosticGraph, buildWorkloadGroups, addTemporalCorrelationEdges, addTemporalSequenceEdges, asResourceRelationshipGraph } from '../../graph/index.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeManifest() {
  return {
    bundlePath: '/fake/bundle.tar.gz',
    extractedPath: '/fake/extracted',
    files: [],
    totalSize: 0,
    extractedAt: new Date(),
  };
}

function makeProfile() {
  return {
    manifest: makeManifest(),
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

function makeInvestigationResult(partial: Record<string, unknown> = {}) {
  return {
    findings: [],
    edges: [],
    findingTree: [],
    seeds: [],
    clusteredSeeds: [],
    metadata: {
      seedCount: 0,
      rawFindingCount: 0,
      finalFindingCount: 0,
      aiEnabled: false,
      aiFindings: 0,
      hypothesesGenerated: 0,
      hypothesesVerified: 0,
      hypothesesConverted: 0,
      retrievalStats: {
        graphChunks: 0,
        lexicalChunks: 0,
        semanticChunks: 0,
        mergedChunks: 0,
      },
      aiRunStats: {
        model: 'unknown',
        totalCalls: 0,
        successfulCalls: 0,
        failedCalls: 0,
        totalLatencyMs: 0,
        avgLatencyMs: 0,
      },
      graphMatchedSymptoms: 0,
      seedClusterCount: 0,
      seedClusteringEnabled: false,
      ...partial,
    },
  };
}

// ---------------------------------------------------------------------------
// Setup: wire up base mocks that all tests share
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  // Default ingestion mocks
  vi.mocked(extractBundle).mockResolvedValue(makeManifest() as ReturnType<typeof extractBundle> extends Promise<infer T> ? T : never);
  vi.mocked(profileBundle).mockResolvedValue(makeProfile() as ReturnType<typeof profileBundle> extends Promise<infer T> ? T : never);

  // Default parsers
  vi.mocked(mergeAnalyzerResults).mockReturnValue([]);
  vi.mocked(identifyLogFiles).mockReturnValue([]);

  // Default investigation result
  vi.mocked(runInvestigation).mockResolvedValue(makeInvestigationResult());

  // Default AI mocks — disabled by default
  vi.mocked(loadAIConfig).mockReturnValue({
    provider: 'none',
    apiKey: '',
    model: 'gpt-4o',
    embeddingModel: 'text-embedding-3-small',
    embeddingBackend: 'none',
    embeddingUrl: 'http://localhost:8080',
    llmBackend: 'openai',
    llmUrl: 'https://api.openai.com/v1',
    tokenBudget: 100000,
    enabled: false,
  });
  vi.mocked(isAIEnabled).mockReturnValue(false);
  vi.mocked(buildChunkIndex).mockReturnValue([]);

  // createEmbeddingClient returns undefined by default (no embedding)
  vi.mocked(createEmbeddingClient).mockReturnValue(undefined);

  // Ensure diagnostic graph mocks always return valid values (clearAllMocks may
  // have cleared the implementations set in the vi.mock factory)
  vi.mocked(buildDiagnosticGraph).mockReturnValue({ addNode: vi.fn(), addEdge: vi.fn(), getNode: vi.fn().mockReturnValue(undefined), getEdgesFrom: vi.fn().mockReturnValue([]), getEdgesTo: vi.fn().mockReturnValue([]), getNeighbors: vi.fn().mockReturnValue([]), nodes: new Map(), edges: [], toResourceRelationshipGraph: vi.fn().mockReturnValue({ nodes: new Map(), edges: [] }) } as never);
  vi.mocked(buildWorkloadGroups).mockReturnValue(undefined);
  vi.mocked(addTemporalCorrelationEdges).mockReturnValue(undefined);
  vi.mocked(addTemporalSequenceEdges).mockReturnValue(undefined);
  vi.mocked(asResourceRelationshipGraph).mockReturnValue({ nodes: new Map(), edges: [] });

  // LexicalSearchIndex mock instance
  const mockLexInstance = { build: vi.fn(), search: vi.fn().mockReturnValue([]) };
  vi.mocked(LexicalSearchIndex).mockImplementation(() => mockLexInstance as unknown as InstanceType<typeof LexicalSearchIndex>);

  // LLMClient mock instance
  const mockLLMInstance = {
    investigateSeed: vi.fn().mockResolvedValue({ findings: [] }),
    generateText: vi.fn().mockResolvedValue(''),
    getModel: vi.fn().mockReturnValue('gpt-4o'),
  };
  vi.mocked(LLMClient).mockImplementation(() => mockLLMInstance as unknown as InstanceType<typeof LLMClient>);

  vi.mocked(getRecorderMode).mockReturnValue('live');
  vi.mocked(defaultSeedResolver).mockImplementation(() => ({
    seedId: 'seed:default:0',
    seedCategory: 'kubernetes',
  }));

  const mockReplayableLLMInstance = {
    investigateSeed: vi.fn().mockResolvedValue({ findings: [] }),
    generateText: vi.fn().mockResolvedValue(''),
    setSeedContext: vi.fn(),
    clearSeedContext: vi.fn(),
  };
  vi.mocked(ReplayableLLMClient).mockImplementation(
    () => mockReplayableLLMInstance as unknown as InstanceType<typeof ReplayableLLMClient>,
  );

  const mockCassetteRecorderInstance = {
    mode: 'live' as const,
    load: vi.fn().mockResolvedValue(undefined),
    flush: vi.fn().mockResolvedValue(undefined),
  };
  (
    CassetteRecorder as unknown as {
      mockImplementation: (impl: (...args: unknown[]) => unknown) => void;
    }
  ).mockImplementation(() => mockCassetteRecorderInstance);

  // EmbeddingClient mock instance (kept for backward compatibility)
  const mockEmbeddingInstance = {
    embed: vi.fn().mockResolvedValue([]),
    embedSingle: vi.fn().mockResolvedValue([]),
  };
  vi.mocked(EmbeddingClient).mockImplementation(
    () => mockEmbeddingInstance as unknown as InstanceType<typeof EmbeddingClient>,
  );

  // VectorStore mock instance
  const mockVectorStoreInstance = {
    addAll: vi.fn(),
    query: vi.fn().mockReturnValue([]),
    size: 0,
  };
  vi.mocked(VectorStore).mockImplementation(
    () => mockVectorStoreInstance as unknown as InstanceType<typeof VectorStore>,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('analyzeBundlePipeline — AI conditional path', () => {
  // ── AI disabled when no API key ──────────────────────────────────────────

  it('skips AI index step when isAIEnabled returns false (no API key)', async () => {
    vi.mocked(isAIEnabled).mockReturnValue(false);

    const result = await analyzeBundlePipeline('/fake/bundle.tar.gz');

    // buildChunkIndex should NOT have been called
    expect(buildChunkIndex).not.toHaveBeenCalled();
    expect(LexicalSearchIndex).not.toHaveBeenCalled();
    expect(LLMClient).not.toHaveBeenCalled();

    // Trace should NOT include an ai-index step
    const aiStep = result.trace.steps.find((s) => s.name === 'ai-index');
    expect(aiStep).toBeUndefined();
  });

  it('passes undefined aiDeps to runInvestigation when AI is disabled', async () => {
    vi.mocked(isAIEnabled).mockReturnValue(false);

    await analyzeBundlePipeline('/fake/bundle.tar.gz');

    // runInvestigation should have been called without aiDeps (second arg undefined)
    expect(runInvestigation).toHaveBeenCalled();
    expect(vi.mocked(runInvestigation).mock.calls[0]?.[1]).toBeUndefined();
  });

  // ── AI disabled via --no-ai ──────────────────────────────────────────────

  it('skips AI index step when noAi option is set', async () => {
    // loadAIConfig should see noAi: true and return disabled config
    vi.mocked(loadAIConfig).mockReturnValue({
      provider: 'none',
      apiKey: '',
      model: 'gpt-4o',
      embeddingModel: 'text-embedding-3-small',
      embeddingBackend: 'none',
      embeddingUrl: 'http://localhost:8080',
    llmBackend: 'openai',
    llmUrl: 'https://api.openai.com/v1',
    tokenBudget: 100000,
      enabled: false,
    });
    vi.mocked(isAIEnabled).mockReturnValue(false);

    const result = await analyzeBundlePipeline('/fake/bundle.tar.gz', { noAi: true });

    expect(loadAIConfig).toHaveBeenCalledWith({ noAi: true });
    expect(buildChunkIndex).not.toHaveBeenCalled();

    const aiStep = result.trace.steps.find((s) => s.name === 'ai-index');
    expect(aiStep).toBeUndefined();
  });

  // ── AI enabled path ──────────────────────────────────────────────────────

  it('builds AI deps and passes them to runInvestigation when AI is enabled', async () => {
    vi.mocked(loadAIConfig).mockReturnValue({
      provider: 'openai',
      apiKey: 'sk-test',
      model: 'gpt-4o',
      embeddingModel: 'text-embedding-3-small',
      embeddingBackend: 'openai',
      embeddingUrl: 'http://localhost:8080',
    llmBackend: 'openai',
    llmUrl: 'https://api.openai.com/v1',
    tokenBudget: 100000,
      enabled: true,
    });
    vi.mocked(isAIEnabled).mockReturnValue(true);

    const fakeChunks = [
      { id: 'chunk:0', artifactId: 'test', content: 'test', startLine: 1, endLine: 1,
        summary: 'test', identifiers: [], artifactCategory: 'kubernetes-resource' as const },
    ];
    vi.mocked(buildChunkIndex).mockReturnValue(fakeChunks);

    await analyzeBundlePipeline('/fake/bundle.tar.gz');

    // AI setup should have been called
    expect(buildChunkIndex).toHaveBeenCalledOnce();
    expect(buildDiagnosticGraph).toHaveBeenCalledOnce();
    expect(LexicalSearchIndex).toHaveBeenCalledOnce();
    expect(LLMClient).toHaveBeenCalledOnce();

    // runInvestigation should have received aiDeps (not undefined)
    expect(runInvestigation).toHaveBeenCalled();
    expect(vi.mocked(runInvestigation).mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        chunkIndex: fakeChunks,
        resourceGraph: expect.any(Object),
        lexicalIndex: expect.any(Object),
        llmClient: expect.any(Object),
      }),
    );
  });

  it('builds semantic AI deps when embeddings are available', async () => {
    vi.mocked(loadAIConfig).mockReturnValue({
      provider: 'openai',
      apiKey: 'sk-test',
      model: 'gpt-4o',
      embeddingModel: 'text-embedding-3-small',
      embeddingBackend: 'openai',
      embeddingUrl: 'http://localhost:8080',
    llmBackend: 'openai',
    llmUrl: 'https://api.openai.com/v1',
    tokenBudget: 100000,
      enabled: true,
    });
    vi.mocked(isAIEnabled).mockReturnValue(true);

    const fakeChunks = [
      { id: 'chunk:0', artifactId: 'test', content: 'test', startLine: 1, endLine: 1,
        summary: 'chunk summary', identifiers: [], artifactCategory: 'kubernetes-resource' as const },
    ];
    vi.mocked(buildChunkIndex).mockReturnValue(fakeChunks);

    const mockEmbeddingInstance = {
      embed: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
      embedSingle: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
    };
    // Pipeline now uses createEmbeddingClient factory
    vi.mocked(createEmbeddingClient).mockReturnValue(mockEmbeddingInstance);

    const mockVectorStoreInstance = {
      addAll: vi.fn(),
      query: vi.fn().mockReturnValue([]),
      size: 1,
    };
    vi.mocked(VectorStore).mockImplementation(
      () => mockVectorStoreInstance as unknown as InstanceType<typeof VectorStore>,
    );

    await analyzeBundlePipeline('/fake/bundle.tar.gz');

    expect(createEmbeddingClient).toHaveBeenCalledOnce();
    expect(mockEmbeddingInstance.embed).toHaveBeenCalledWith(['chunk summary']);
    expect(VectorStore).toHaveBeenCalledOnce();
    expect(mockVectorStoreInstance.addAll).toHaveBeenCalledWith(fakeChunks, [[0.1, 0.2, 0.3]]);
    expect(runInvestigation).toHaveBeenCalled();
    expect(vi.mocked(runInvestigation).mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        embeddingClient: expect.any(Object),
        vectorStore: expect.any(Object),
      }),
    );
  });

  it('adds ai-index step to trace when AI is enabled', async () => {
    vi.mocked(loadAIConfig).mockReturnValue({
      provider: 'openai',
      apiKey: 'sk-test',
      model: 'gpt-4o',
      embeddingModel: 'text-embedding-3-small',
      embeddingBackend: 'openai',
      embeddingUrl: 'http://localhost:8080',
    llmBackend: 'openai',
    llmUrl: 'https://api.openai.com/v1',
    tokenBudget: 100000,
      enabled: true,
    });
    vi.mocked(isAIEnabled).mockReturnValue(true);
    vi.mocked(buildChunkIndex).mockReturnValue([]);

    const result = await analyzeBundlePipeline('/fake/bundle.tar.gz');

    const aiStep = result.trace.steps.find((s) => s.name === 'ai-index');
    expect(aiStep).toBeDefined();
    expect(aiStep?.completedAt).toBeDefined();
  });

  it('loads replay cassettes, wraps the LLM client, and skips embedding network setup in replay mode', async () => {
    vi.mocked(loadAIConfig).mockReturnValue({
      provider: 'openai',
      apiKey: 'replay',
      model: 'gpt-4o',
      embeddingModel: 'text-embedding-3-small',
      embeddingBackend: 'local',
      embeddingUrl: 'http://localhost:8080',
      llmBackend: 'openai',
      llmUrl: 'https://api.openai.com/v1',
      tokenBudget: 100000,
      enabled: true,
    });
    vi.mocked(isAIEnabled).mockReturnValue(true);
    vi.mocked(buildChunkIndex).mockReturnValue([]);
    vi.mocked(getRecorderMode).mockReturnValue('replay');

    const mockRecorder = {
      mode: 'replay' as const,
      load: vi.fn().mockResolvedValue(undefined),
      flush: vi.fn().mockResolvedValue(undefined),
    };
    (
      CassetteRecorder as unknown as {
        mockImplementation: (impl: (...args: unknown[]) => unknown) => void;
      }
    ).mockImplementation(() => mockRecorder);

    const mockReplayable = {
      investigateSeed: vi.fn().mockResolvedValue({ findings: [] }),
      generateText: vi.fn().mockResolvedValue(''),
      setSeedContext: vi.fn(),
      clearSeedContext: vi.fn(),
    };
    vi.mocked(ReplayableLLMClient).mockImplementation(
      () => mockReplayable as unknown as InstanceType<typeof ReplayableLLMClient>,
    );

    await analyzeBundlePipeline('/fake/bundle.tar.gz', { outputDir: '/tmp/sbi-output' });

    expect(CassetteRecorder).toHaveBeenCalledWith('replay', '/tmp/sbi-output/cassettes');
    expect(mockRecorder.load).toHaveBeenCalledTimes(1);
    expect(mockRecorder.flush).not.toHaveBeenCalled();
    expect(ReplayableLLMClient).toHaveBeenCalledTimes(1);
    expect(createEmbeddingClient).not.toHaveBeenCalled();
    expect(runInvestigation).toHaveBeenCalled();
    expect(vi.mocked(runInvestigation).mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ llmClient: mockReplayable }),
    );
  });

  it('flushes recorded cassettes and respects PipelineOptions.cassetteDir', async () => {
    vi.mocked(loadAIConfig).mockReturnValue({
      provider: 'openai',
      apiKey: 'sk-test',
      model: 'gpt-4o',
      embeddingModel: 'text-embedding-3-small',
      embeddingBackend: 'none',
      embeddingUrl: 'http://localhost:8080',
      llmBackend: 'openai',
      llmUrl: 'https://api.openai.com/v1',
      tokenBudget: 100000,
      enabled: true,
    });
    vi.mocked(isAIEnabled).mockReturnValue(true);
    vi.mocked(buildChunkIndex).mockReturnValue([]);
    vi.mocked(getRecorderMode).mockReturnValue('record');

    const mockRecorder = {
      mode: 'record' as const,
      load: vi.fn().mockResolvedValue(undefined),
      flush: vi.fn().mockResolvedValue(undefined),
    };
    (
      CassetteRecorder as unknown as {
        mockImplementation: (impl: (...args: unknown[]) => unknown) => void;
      }
    ).mockImplementation(() => mockRecorder);

    await analyzeBundlePipeline('/fake/bundle.tar.gz', { cassetteDir: '/tmp/explicit-cassettes' });

    expect(CassetteRecorder).toHaveBeenCalledWith('record', '/tmp/explicit-cassettes');
    expect(mockRecorder.load).not.toHaveBeenCalled();
    expect(mockRecorder.flush).toHaveBeenCalledTimes(1);
    expect(ReplayableLLMClient).toHaveBeenCalledTimes(1);
  });

  // ── Graceful fallback when AI setup throws ───────────────────────────────

  it('continues with heuristic-only mode when buildChunkIndex throws', async () => {
    vi.mocked(loadAIConfig).mockReturnValue({
      provider: 'openai',
      apiKey: 'sk-test',
      model: 'gpt-4o',
      embeddingModel: 'text-embedding-3-small',
      embeddingBackend: 'openai',
      embeddingUrl: 'http://localhost:8080',
    llmBackend: 'openai',
    llmUrl: 'https://api.openai.com/v1',
    tokenBudget: 100000,
      enabled: true,
    });
    vi.mocked(isAIEnabled).mockReturnValue(true);
    vi.mocked(buildChunkIndex).mockImplementation(() => {
      throw new Error('Out of memory');
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Should NOT throw even though AI setup failed
    const result = await analyzeBundlePipeline('/fake/bundle.tar.gz');

    // runInvestigation should still be called, but without aiDeps
    expect(runInvestigation).toHaveBeenCalled();
    expect(vi.mocked(runInvestigation).mock.calls[0]?.[1]).toBeUndefined();

    // Warning should have been logged
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[pipeline] AI index build failed'),
    );

    // Trace captures the AI setup failure for diagnostics
    const aiStep = result.trace.steps.find((s) => s.name === 'ai-index');
    expect(aiStep?.errors).toEqual(['Out of memory']);

    // Result is still valid
    expect(result.findings).toBeInstanceOf(Array);

    warnSpy.mockRestore();
  });

  it('continues with heuristic-only mode when LLMClient constructor throws', async () => {
    vi.mocked(loadAIConfig).mockReturnValue({
      provider: 'openai',
      apiKey: 'sk-test',
      model: 'gpt-4o',
      embeddingModel: 'text-embedding-3-small',
      embeddingBackend: 'openai',
      embeddingUrl: 'http://localhost:8080',
    llmBackend: 'openai',
    llmUrl: 'https://api.openai.com/v1',
    tokenBudget: 100000,
      enabled: true,
    });
    vi.mocked(isAIEnabled).mockReturnValue(true);
    vi.mocked(buildChunkIndex).mockReturnValue([]);
    vi.mocked(LLMClient).mockImplementation(() => {
      throw new Error('Invalid API key');
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Should NOT throw
    await expect(
      analyzeBundlePipeline('/fake/bundle.tar.gz'),
    ).resolves.not.toThrow();

    // AI setup failed → no aiDeps passed
    expect(runInvestigation).toHaveBeenCalled();
    expect(vi.mocked(runInvestigation).mock.calls[0]?.[1]).toBeUndefined();

    warnSpy.mockRestore();
  });

  // ── loadAIConfig receives correct options ─────────────────────────────────

  it('passes noAi option correctly to loadAIConfig', async () => {
    await analyzeBundlePipeline('/fake/bundle.tar.gz', { noAi: true });
    expect(loadAIConfig).toHaveBeenCalledWith({ noAi: true });
  });

  it('passes undefined noAi when option is not set', async () => {
    await analyzeBundlePipeline('/fake/bundle.tar.gz');
    expect(loadAIConfig).toHaveBeenCalledWith({ noAi: undefined });
  });
});
