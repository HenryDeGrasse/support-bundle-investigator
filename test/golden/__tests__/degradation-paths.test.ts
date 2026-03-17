// ---------------------------------------------------------------------------
// Priority 6: Degradation Path Tests
// ---------------------------------------------------------------------------
//
// Tests every failure mode in the AI pipeline to ensure graceful degradation.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { investigateWithAI } from '../../../src/investigators/ai-investigator.js';
import type { AIInvestigatorDeps } from '../../../src/investigators/ai-investigator.js';
import type { InvestigatorContext, InvestigationSeed } from '../../../src/investigators/types.js';
import type { LLMClient, AIFindingResponse } from '../../../src/ai/llm-client.js';
import type { LexicalSearchIndex } from '../../../src/ai/lexical-search.js';
import type { EmbeddingClient } from '../../../src/ai/embeddings.js';
import type { VectorStore } from '../../../src/ai/vector-store.js';
import type { IndexedChunk } from '../../../src/ai/chunk-indexer.js';
import type { ResourceRelationshipGraph } from '../../../src/graph/resource-graph.js';

afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(): InvestigatorContext {
  return {
    analyzerResults: [],
    resources: [],
    events: [],
    logs: [],
    profile: {
      manifest: { bundlePath: '', extractedPath: '', files: [], totalSize: 0, extractedAt: new Date() },
      analyzerCount: 0, logFileCount: 0, resourceCount: 0, eventCount: 0,
      namespaces: [], workloads: [], coverageGaps: [],
      artifactsByCategory: { analyzer: 0, log: 0, 'kubernetes-resource': 0, event: 0, config: 0, 'cluster-info': 0, 'helm-release': 0, unknown: 0 },
    },
  };
}

function makeSeeds(count: number): InvestigationSeed[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `seed:test:${i}`,
    hypothesis: `Hypothesis ${i}`,
    source: `pod:default/pod-${i}`,
    category: 'kubernetes' as const,
    priority: 90 - i,
  }));
}

function makeLLMClient(responses: Array<AIFindingResponse | Error>): LLMClient {
  let callIndex = 0;
  return {
    investigateSeed: vi.fn().mockImplementation(async () => {
      const response = responses[callIndex++];
      if (response instanceof Error) throw response;
      return response ?? { findings: [], rawResponse: '{}' };
    }),
  } as unknown as LLMClient;
}

function makeBaseDeps(llm: LLMClient): AIInvestigatorDeps {
  return {
    llmClient: llm,
    chunkIndex: [],
    resourceGraph: { nodes: new Map(), edges: [] } as ResourceRelationshipGraph,
    lexicalIndex: { search: vi.fn().mockReturnValue([]) } as unknown as LexicalSearchIndex,
  };
}

function makeValidResponse(title: string): AIFindingResponse {
  return {
    findings: [{
      title,
      severity: 'high' as const,
      confidence: 0.8,
      affectedComponents: ['Pod/default/test'],
      reasoningSummary: 'Test reasoning',
      evidence: [{ path: 'test.yaml', note: 'evidence' }],
      contradictionsChecked: ['none'],
      recommendedAction: 'fix it',
      missingEvidence: [],
    }],
    rawResponse: '{}',
  };
}

// ---------------------------------------------------------------------------
// Partial LLM failures
// ---------------------------------------------------------------------------

describe('Degradation: partial LLM failures', () => {
  it('uses findings from successful seeds when some seeds fail', async () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const llm = makeLLMClient([
      makeValidResponse('Finding from seed 0'),
      new Error('API timeout'),  // seed 1 fails
      makeValidResponse('Finding from seed 2'),
    ]);

    const result = await investigateWithAI(makeContext(), makeSeeds(3), makeBaseDeps(llm));

    expect(result.findings).toHaveLength(2);
    expect(result.findings[0]!.title).toBe('Finding from seed 0');
    expect(result.findings[1]!.title).toBe('Finding from seed 2');
    consoleSpy.mockRestore();
  });

  it('returns empty findings when ALL LLM calls fail', async () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const llm = makeLLMClient([
      new Error('Rate limited'),
      new Error('Rate limited'),
      new Error('Rate limited'),
    ]);

    const result = await investigateWithAI(makeContext(), makeSeeds(3), makeBaseDeps(llm));

    expect(result.findings).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
    consoleSpy.mockRestore();
  });

  it('returns empty findings when LLM returns valid JSON with 0 findings for every seed', async () => {
    const llm = makeLLMClient([
      { findings: [], rawResponse: '{"findings":[]}' },
      { findings: [], rawResponse: '{"findings":[]}' },
    ]);

    const result = await investigateWithAI(makeContext(), makeSeeds(2), makeBaseDeps(llm));

    expect(result.findings).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
  });

  it('returns 0 findings when LLM returns findings that all fail validation', async () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const llm = makeLLMClient([{
      findings: [{
        title: '', // empty title → validation failure
        severity: 'high' as const,
        confidence: 0.9,
        affectedComponents: [],
        reasoningSummary: 'test',
        evidence: [{ path: 'test.yaml', note: 'note' }],
        contradictionsChecked: [],
        recommendedAction: 'fix',
        missingEvidence: [],
      }],
      rawResponse: '{}',
    }]);

    const result = await investigateWithAI(makeContext(), makeSeeds(1), makeBaseDeps(llm));
    expect(result.findings).toHaveLength(0);
    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Semantic retrieval failures
// ---------------------------------------------------------------------------

describe('Degradation: semantic retrieval failures', () => {
  it('works without embeddingClient or vectorStore', async () => {
    const llm = makeLLMClient([makeValidResponse('Graph+lexical only')]);
    const deps = makeBaseDeps(llm);
    // No embeddingClient, no vectorStore

    const result = await investigateWithAI(makeContext(), makeSeeds(1), deps);
    expect(result.findings).toHaveLength(1);
  });

  it('continues with graph+lexical when embedSingle throws', async () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const llm = makeLLMClient([makeValidResponse('Fallback finding')]);
    const deps: AIInvestigatorDeps = {
      ...makeBaseDeps(llm),
      embeddingClient: {
        embedSingle: vi.fn().mockRejectedValue(new Error('Embedding API down')),
        embed: vi.fn().mockRejectedValue(new Error('Embedding API down')),
      } as unknown as EmbeddingClient,
      vectorStore: {
        query: vi.fn().mockReturnValue([]),
        size: 0,
      } as unknown as VectorStore,
    };

    const result = await investigateWithAI(makeContext(), makeSeeds(1), deps);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.title).toBe('Fallback finding');
    consoleSpy.mockRestore();
  });

  it('continues when embedSingle returns empty vector', async () => {
    const llm = makeLLMClient([makeValidResponse('No embedding')]);
    const deps: AIInvestigatorDeps = {
      ...makeBaseDeps(llm),
      embeddingClient: {
        embedSingle: vi.fn().mockResolvedValue([]),
        embed: vi.fn().mockResolvedValue([]),
      } as unknown as EmbeddingClient,
      vectorStore: {
        query: vi.fn().mockReturnValue([]),
        size: 0,
      } as unknown as VectorStore,
    };

    const result = await investigateWithAI(makeContext(), makeSeeds(1), deps);
    expect(result.findings).toHaveLength(1);
    // vectorStore.query should NOT have been called with empty vector
    expect(deps.vectorStore!.query).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Empty / edge-case inputs
// ---------------------------------------------------------------------------

describe('Degradation: edge-case inputs', () => {
  it('handles zero seeds gracefully', async () => {
    const llm = makeLLMClient([]);
    const result = await investigateWithAI(makeContext(), [], makeBaseDeps(llm));
    expect(result.findings).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
  });

  it('handles empty chunk index', async () => {
    const llm = makeLLMClient([makeValidResponse('No chunks')]);
    const deps = {
      ...makeBaseDeps(llm),
      chunkIndex: [] as IndexedChunk[],
    };

    const result = await investigateWithAI(makeContext(), makeSeeds(1), deps);
    expect(result.findings).toHaveLength(1);
  });
});
