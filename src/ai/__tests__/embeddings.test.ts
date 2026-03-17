import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EmbeddingClient } from '../embeddings.js';
import type { AIConfig } from '../config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<AIConfig> = {}): AIConfig {
  return {
    provider: 'openai',
    apiKey: 'test-key',
    model: 'gpt-4o',
    embeddingModel: 'text-embedding-3-small',
    enabled: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EmbeddingClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── embed() ───────────────────────────────────────────────────────────────

  it('returns an empty array when given no texts', async () => {
    const client = new EmbeddingClient(makeConfig());
    const result = await client.embed([]);
    expect(result).toEqual([]);
  });

  it('returns a parallel array of vectors for each input text', async () => {
    const client = new EmbeddingClient(makeConfig());

    // Mock the OpenAI client on the instance via module interception
    const mockCreate = vi.fn().mockResolvedValue({
      data: [
        { embedding: [0.1, 0.2, 0.3], index: 0 },
        { embedding: [0.4, 0.5, 0.6], index: 1 },
      ],
    });

    // @ts-expect-error — accessing private field for test
    client.client = { embeddings: { create: mockCreate } };

    const result = await client.embed(['hello', 'world']);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual([0.1, 0.2, 0.3]);
    expect(result[1]).toEqual([0.4, 0.5, 0.6]);
  });

  it('passes the configured embeddingModel to the API', async () => {
    const client = new EmbeddingClient(makeConfig({ embeddingModel: 'text-embedding-3-large' }));

    const mockCreate = vi.fn().mockResolvedValue({
      data: [{ embedding: [1, 0, 0], index: 0 }],
    });

    // @ts-expect-error — accessing private field for test
    client.client = { embeddings: { create: mockCreate } };

    await client.embed(['test text']);

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'text-embedding-3-large' }),
    );
  });

  it('returns empty arrays for failed batches without throwing', async () => {
    const client = new EmbeddingClient(makeConfig());

    const mockCreate = vi.fn().mockRejectedValue(new Error('API error'));

    // @ts-expect-error — accessing private field for test
    client.client = { embeddings: { create: mockCreate } };

    // Should not throw
    const result = await client.embed(['text1', 'text2']);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual([]);
    expect(result[1]).toEqual([]);
  });

  it('processes texts in batches of 100', async () => {
    const client = new EmbeddingClient(makeConfig());

    const mockCreate = vi.fn().mockImplementation(async ({ input }: { input: string[] }) => ({
      data: input.map((_, i) => ({ embedding: [i], index: i })),
    }));

    // @ts-expect-error — accessing private field for test
    client.client = { embeddings: { create: mockCreate } };

    // 150 texts → should produce 2 batches: 100 + 50
    const texts = Array.from({ length: 150 }, (_, i) => `text ${i}`);
    const result = await client.embed(texts);

    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(150);
  });

  it('handles partial batch failure: failed batch fills with empty arrays, other batches succeed', async () => {
    const client = new EmbeddingClient(makeConfig());

    let callCount = 0;
    const mockCreate = vi.fn().mockImplementation(async ({ input }: { input: string[] }) => {
      callCount++;
      if (callCount === 1) {
        // First batch of 100 succeeds
        return {
          data: input.map((_, i) => ({ embedding: [i * 0.1], index: i })),
        };
      }
      // Second batch fails
      throw new Error('Second batch failed');
    });

    // @ts-expect-error — accessing private field for test
    client.client = { embeddings: { create: mockCreate } };

    const texts = Array.from({ length: 110 }, (_, i) => `text ${i}`);
    const result = await client.embed(texts);

    expect(result).toHaveLength(110);
    // First 100 texts should have valid embeddings
    expect(result[0]).toEqual([0]);
    expect(result[99]).toHaveLength(1);
    // Last 10 texts should have empty arrays
    for (let i = 100; i < 110; i++) {
      expect(result[i]).toEqual([]);
    }
  });

  // ── embedSingle() ─────────────────────────────────────────────────────────

  it('embedSingle returns the embedding vector for a single text', async () => {
    const client = new EmbeddingClient(makeConfig());

    const mockCreate = vi.fn().mockResolvedValue({
      data: [{ embedding: [0.7, 0.8, 0.9], index: 0 }],
    });

    // @ts-expect-error — accessing private field for test
    client.client = { embeddings: { create: mockCreate } };

    const result = await client.embedSingle('single text');

    expect(result).toEqual([0.7, 0.8, 0.9]);
  });

  it('embedSingle returns an empty array on API failure without throwing', async () => {
    const client = new EmbeddingClient(makeConfig());

    const mockCreate = vi.fn().mockRejectedValue(new Error('API down'));

    // @ts-expect-error — accessing private field for test
    client.client = { embeddings: { create: mockCreate } };

    const result = await client.embedSingle('will fail');

    expect(result).toEqual([]);
  });

  it('embedSingle resolves to an empty array (not undefined) on failure', async () => {
    const client = new EmbeddingClient(makeConfig());

    const mockCreate = vi.fn().mockRejectedValue(new Error('timeout'));

    // @ts-expect-error — accessing private field for test
    client.client = { embeddings: { create: mockCreate } };

    const result = await client.embedSingle('failing text');

    expect(result).toBeDefined();
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(0);
  });
});
