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
}));

// Mock graph — minimal implementation of what analyze.ts needs
vi.mock('../../graph/index.js', () => ({
  InvestigationGraphImpl: vi.fn().mockImplementation(() => ({
    addNode: vi.fn(),
    addEdge: vi.fn(),
    getNode: vi.fn().mockReturnValue(null),
  })),
  buildResourceGraph: vi.fn().mockReturnValue({ nodes: new Map(), edges: [] }),
}));

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
  EmbeddingClient: vi.fn(),
  VectorStore: vi.fn(),
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
  EmbeddingClient,
  VectorStore,
} from '../../ai/index.js';
import { buildResourceGraph } from '../../graph/index.js';

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
      config: 0,
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
    seeds: [],
    metadata: {
      seedCount: 0,
      rawFindingCount: 0,
      finalFindingCount: 0,
      aiEnabled: false,
      aiFindings: 0,
      hypothesesGenerated: 0,
      hypothesesVerified: 0,
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
    enabled: false,
  });
  vi.mocked(isAIEnabled).mockReturnValue(false);
  vi.mocked(buildChunkIndex).mockReturnValue([]);

  // Ensure buildResourceGraph always returns a valid graph (clearAllMocks may
  // have cleared the implementation set in the vi.mock factory)
  vi.mocked(buildResourceGraph).mockReturnValue({ nodes: new Map(), edges: [] });

  // LexicalSearchIndex mock instance
  const mockLexInstance = { build: vi.fn(), search: vi.fn().mockReturnValue([]) };
  vi.mocked(LexicalSearchIndex).mockImplementation(() => mockLexInstance as unknown as InstanceType<typeof LexicalSearchIndex>);

  // LLMClient mock instance
  const mockLLMInstance = { investigateSeed: vi.fn().mockResolvedValue({ findings: [] }) };
  vi.mocked(LLMClient).mockImplementation(() => mockLLMInstance as unknown as InstanceType<typeof LLMClient>);

  // EmbeddingClient mock instance
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
    expect(buildResourceGraph).toHaveBeenCalledOnce();
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
    vi.mocked(EmbeddingClient).mockImplementation(
      () => mockEmbeddingInstance as unknown as InstanceType<typeof EmbeddingClient>,
    );

    const mockVectorStoreInstance = {
      addAll: vi.fn(),
      query: vi.fn().mockReturnValue([]),
      size: 1,
    };
    vi.mocked(VectorStore).mockImplementation(
      () => mockVectorStoreInstance as unknown as InstanceType<typeof VectorStore>,
    );

    await analyzeBundlePipeline('/fake/bundle.tar.gz');

    expect(EmbeddingClient).toHaveBeenCalledOnce();
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
      enabled: true,
    });
    vi.mocked(isAIEnabled).mockReturnValue(true);
    vi.mocked(buildChunkIndex).mockReturnValue([]);

    const result = await analyzeBundlePipeline('/fake/bundle.tar.gz');

    const aiStep = result.trace.steps.find((s) => s.name === 'ai-index');
    expect(aiStep).toBeDefined();
    expect(aiStep?.completedAt).toBeDefined();
  });

  // ── Graceful fallback when AI setup throws ───────────────────────────────

  it('continues with heuristic-only mode when buildChunkIndex throws', async () => {
    vi.mocked(loadAIConfig).mockReturnValue({
      provider: 'openai',
      apiKey: 'sk-test',
      model: 'gpt-4o',
      embeddingModel: 'text-embedding-3-small',
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
