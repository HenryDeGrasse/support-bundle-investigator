// ---------------------------------------------------------------------------
// Pipeline progress callback tests
//
// Tests that onProgress is called correctly for each pipeline step:
// - 'started' event emitted before work begins
// - 'completed' event emitted after work finishes with artifactsProcessed
// - Events emitted in the correct order
// - No throw when onProgress is not provided
// - artifactsProcessed is undefined on 'started' events
//
// These tests mock all heavy dependencies so they run fast without real
// bundles. Same pattern as analyze-ai.test.ts.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — must be at top level before imports
// ---------------------------------------------------------------------------

vi.mock('../../ingestion/index.js', () => ({
  extractBundle: vi.fn(),
  profileBundle: vi.fn(),
}));

vi.mock('../../parsers/index.js', () => ({
  parseAnalyzerFile: vi.fn().mockResolvedValue([]),
  mergeAnalyzerResults: vi.fn().mockReturnValue([]),
  parseResourceFile: vi.fn().mockResolvedValue([]),
  parseEventFile: vi.fn().mockResolvedValue([]),
  identifyLogFiles: vi.fn().mockReturnValue([]),
  parseLogFile: vi.fn().mockResolvedValue({ path: '', lines: [], errorCount: 0, warningCount: 0, importance: 0 }),
}));

vi.mock('../../graph/index.js', () => ({
  InvestigationGraphImpl: vi.fn().mockImplementation(() => ({
    addNode: vi.fn(),
    addEdge: vi.fn(),
    getNode: vi.fn().mockReturnValue(null),
  })),
  buildResourceGraph: vi.fn().mockReturnValue({ nodes: new Map(), edges: [] }),
}));

vi.mock('../../investigators/index.js', () => ({
  runInvestigation: vi.fn(),
}));

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
import type { PipelineProgressEvent } from '../analyze.js';
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

function makeManifest(fileCount = 0) {
  return {
    bundlePath: '/fake/bundle.tar.gz',
    extractedPath: '/fake/extracted',
    files: Array.from({ length: fileCount }, (_, i) => ({
      relativePath: `file-${i}.yaml`,
      absolutePath: `/fake/extracted/file-${i}.yaml`,
      category: 'unknown',
      size: 100,
    })),
    totalSize: fileCount * 100,
    extractedAt: new Date(),
  };
}

function makeProfile() {
  return {
    manifest: makeManifest(0),
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

function makeInvestigationResult() {
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
    },
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  vi.mocked(extractBundle).mockResolvedValue(
    makeManifest(5) as ReturnType<typeof extractBundle> extends Promise<infer T> ? T : never,
  );
  vi.mocked(profileBundle).mockResolvedValue(
    makeProfile() as ReturnType<typeof profileBundle> extends Promise<infer T> ? T : never,
  );
  vi.mocked(mergeAnalyzerResults).mockReturnValue([]);
  vi.mocked(identifyLogFiles).mockReturnValue([]);
  vi.mocked(runInvestigation).mockResolvedValue(makeInvestigationResult());
  vi.mocked(buildResourceGraph).mockReturnValue({ nodes: new Map(), edges: [] });

  // AI disabled by default
  vi.mocked(loadAIConfig).mockReturnValue({
    provider: 'none',
    apiKey: '',
    model: 'gpt-4o',
    embeddingModel: 'text-embedding-3-small',
    enabled: false,
  });
  vi.mocked(isAIEnabled).mockReturnValue(false);
  vi.mocked(buildChunkIndex).mockReturnValue([]);

  const mockLexInstance = { build: vi.fn(), search: vi.fn().mockReturnValue([]) };
  vi.mocked(LexicalSearchIndex).mockImplementation(
    () => mockLexInstance as unknown as InstanceType<typeof LexicalSearchIndex>,
  );
  const mockLLMInstance = { investigateSeed: vi.fn().mockResolvedValue({ findings: [] }) };
  vi.mocked(LLMClient).mockImplementation(
    () => mockLLMInstance as unknown as InstanceType<typeof LLMClient>,
  );

  const mockEmbeddingInstance = {
    embed: vi.fn().mockResolvedValue([]),
    embedSingle: vi.fn().mockResolvedValue([]),
  };
  vi.mocked(EmbeddingClient).mockImplementation(
    () => mockEmbeddingInstance as unknown as InstanceType<typeof EmbeddingClient>,
  );

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

describe('analyzeBundlePipeline — onProgress callback', () => {
  // ── Basic emission ────────────────────────────────────────────────────────

  it('does not throw when onProgress is not provided', async () => {
    await expect(analyzeBundlePipeline('/fake/bundle.tar.gz')).resolves.not.toThrow();
  });

  it('does not throw when onProgress is undefined explicitly', async () => {
    await expect(
      analyzeBundlePipeline('/fake/bundle.tar.gz', { onProgress: undefined }),
    ).resolves.not.toThrow();
  });

  // ── Event ordering: started then completed ────────────────────────────────

  it('emits started before completed for every step (AI disabled)', async () => {
    const events: PipelineProgressEvent[] = [];
    const onProgress = vi.fn((e: PipelineProgressEvent) => events.push(e));

    await analyzeBundlePipeline('/fake/bundle.tar.gz', { onProgress });

    // Expected 8 steps × 2 events = 16 (no ai-index when AI disabled)
    const expectedSteps = [
      'extract',
      'profile',
      'parse-analyzers',
      'parse-resources',
      'parse-events',
      'parse-logs',
      'build-graph',
      'investigate',
    ];

    for (const step of expectedSteps) {
      const startedIdx = events.findIndex((e) => e.step === step && e.status === 'started');
      const completedIdx = events.findIndex((e) => e.step === step && e.status === 'completed');

      expect(startedIdx, `step '${step}' should have a 'started' event`).toBeGreaterThanOrEqual(0);
      expect(completedIdx, `step '${step}' should have a 'completed' event`).toBeGreaterThanOrEqual(0);
      expect(startedIdx, `step '${step}' started should come before completed`).toBeLessThan(completedIdx);
    }
  });

  it('emits events in pipeline order', async () => {
    const stepOrder: string[] = [];
    const onProgress = vi.fn((e: PipelineProgressEvent) => {
      if (e.status === 'started') stepOrder.push(e.step);
    });

    await analyzeBundlePipeline('/fake/bundle.tar.gz', { onProgress });

    expect(stepOrder).toEqual([
      'extract',
      'profile',
      'parse-analyzers',
      'parse-resources',
      'parse-events',
      'parse-logs',
      'build-graph',
      'investigate',
    ]);
  });

  // ── artifactsProcessed ────────────────────────────────────────────────────

  it('artifactsProcessed is undefined on started events', async () => {
    const onProgress = vi.fn();

    await analyzeBundlePipeline('/fake/bundle.tar.gz', { onProgress });

    const startedCalls = (onProgress.mock.calls as [PipelineProgressEvent][])
      .map(([e]) => e)
      .filter((e) => e.status === 'started');

    expect(startedCalls.length).toBeGreaterThan(0);
    for (const event of startedCalls) {
      expect(event.artifactsProcessed).toBeUndefined();
    }
  });

  it('artifactsProcessed is a number on completed events', async () => {
    const onProgress = vi.fn();

    await analyzeBundlePipeline('/fake/bundle.tar.gz', { onProgress });

    const completedCalls = (onProgress.mock.calls as [PipelineProgressEvent][])
      .map(([e]) => e)
      .filter((e) => e.status === 'completed');

    expect(completedCalls.length).toBeGreaterThan(0);
    for (const event of completedCalls) {
      expect(typeof event.artifactsProcessed).toBe('number');
    }
  });

  it('extract completed event carries file count from manifest', async () => {
    vi.mocked(extractBundle).mockResolvedValue(
      makeManifest(42) as ReturnType<typeof extractBundle> extends Promise<infer T> ? T : never,
    );

    const onProgress = vi.fn();
    await analyzeBundlePipeline('/fake/bundle.tar.gz', { onProgress });

    const extractCompleted = (onProgress.mock.calls as [PipelineProgressEvent][])
      .map(([e]) => e)
      .find((e) => e.step === 'extract' && e.status === 'completed');

    expect(extractCompleted?.artifactsProcessed).toBe(42);
  });

  // ── AI-index step ─────────────────────────────────────────────────────────

  it('emits ai-index started and completed when AI is enabled', async () => {
    vi.mocked(loadAIConfig).mockReturnValue({
      provider: 'openai',
      apiKey: 'sk-test',
      model: 'gpt-4o',
      embeddingModel: 'text-embedding-3-small',
      enabled: true,
    });
    vi.mocked(isAIEnabled).mockReturnValue(true);
    vi.mocked(buildChunkIndex).mockReturnValue([
      {
        id: 'chunk:0',
        artifactId: 'test',
        content: 'test',
        startLine: 1,
        endLine: 1,
        summary: 'test',
        identifiers: [],
        artifactCategory: 'kubernetes-resource' as const,
      },
    ]);

    const onProgress = vi.fn();
    await analyzeBundlePipeline('/fake/bundle.tar.gz', { onProgress });

    const calls = onProgress.mock.calls as [PipelineProgressEvent][];
    const aiStarted = calls.map(([e]) => e).find((e) => e.step === 'ai-index' && e.status === 'started');
    const aiCompleted = calls.map(([e]) => e).find((e) => e.step === 'ai-index' && e.status === 'completed');

    expect(aiStarted).toBeDefined();
    expect(aiCompleted).toBeDefined();
    expect(aiCompleted?.artifactsProcessed).toBe(1);
  });

  it('does not emit ai-index when AI is disabled', async () => {
    vi.mocked(isAIEnabled).mockReturnValue(false);

    const onProgress = vi.fn();
    await analyzeBundlePipeline('/fake/bundle.tar.gz', { onProgress });

    const aiEvents = (onProgress.mock.calls as [PipelineProgressEvent][])
      .map(([e]) => e)
      .filter((e) => e.step === 'ai-index');

    expect(aiEvents).toHaveLength(0);
  });

  it('emits ai-index completed with artifactsProcessed=0 when AI setup fails', async () => {
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
    const onProgress = vi.fn();

    await analyzeBundlePipeline('/fake/bundle.tar.gz', { onProgress });

    const aiCompleted = (onProgress.mock.calls as [PipelineProgressEvent][])
      .map(([e]) => e)
      .find((e) => e.step === 'ai-index' && e.status === 'completed');

    expect(aiCompleted).toBeDefined();
    expect(aiCompleted?.artifactsProcessed).toBe(0);

    warnSpy.mockRestore();
  });

  // ── Total call count ──────────────────────────────────────────────────────

  it('calls onProgress exactly 16 times for 8 steps when AI is disabled (2 per step)', async () => {
    const onProgress = vi.fn();
    await analyzeBundlePipeline('/fake/bundle.tar.gz', { onProgress });

    // 8 steps × 2 events (started + completed) = 16
    expect(onProgress).toHaveBeenCalledTimes(16);
  });

  it('calls onProgress exactly 18 times for 9 steps when AI is enabled (2 per step)', async () => {
    vi.mocked(loadAIConfig).mockReturnValue({
      provider: 'openai',
      apiKey: 'sk-test',
      model: 'gpt-4o',
      embeddingModel: 'text-embedding-3-small',
      enabled: true,
    });
    vi.mocked(isAIEnabled).mockReturnValue(true);
    vi.mocked(buildChunkIndex).mockReturnValue([]);

    const onProgress = vi.fn();
    await analyzeBundlePipeline('/fake/bundle.tar.gz', { onProgress });

    // 9 steps × 2 events = 18
    expect(onProgress).toHaveBeenCalledTimes(18);
  });
});
