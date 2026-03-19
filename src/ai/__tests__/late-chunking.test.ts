// ---------------------------------------------------------------------------
// Late Chunking Infrastructure Tests
// ---------------------------------------------------------------------------
//
// Tests for:
//   mapChunkBoundariesToTokenPositions  — line-range → token-index mapping
//   averagePoolSlice                    — average-pool a token embedding slice
//   lateChunkEmbed                      — full orchestration (TEI + fallback)
//
// All HTTP I/O is fully mocked; no real embedding service is required.

import { describe, it, expect, vi } from 'vitest';
import {
  mapChunkBoundariesToTokenPositions,
  averagePoolSlice,
  lateChunkEmbed,
} from '../late-chunking.js';
import type { ChunkBoundary, LateChunkEmbeddingClient } from '../late-chunking.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal LateChunkEmbeddingClient with controllable responses. */
function makeMockClient(
  tokenEmbeddings: number[][] | null,
  pooledEmbeddings: number[][] = [],
): LateChunkEmbeddingClient {
  return {
    embedTokenLevel: vi.fn().mockResolvedValue(tokenEmbeddings),
    embed: vi.fn().mockResolvedValue(pooledEmbeddings),
    embedSingle: vi.fn().mockResolvedValue([]),
  };
}

// ---------------------------------------------------------------------------
// mapChunkBoundariesToTokenPositions
// ---------------------------------------------------------------------------

describe('mapChunkBoundariesToTokenPositions', () => {
  // ── basic proportional mapping ─────────────────────────────────────────

  it('maps two equal-length lines to equal token halves', () => {
    // Lines "aaaa" and "bbbb" (4 chars each + 1 newline = 5 each, total = 10 chars)
    // numTokens = 10 → each line occupies exactly 5 tokens
    const lines = ['aaaa', 'bbbb'];
    const boundaries: ChunkBoundary[] = [
      { startLine: 1, endLine: 1 },
      { startLine: 2, endLine: 2 },
    ];
    const ranges = mapChunkBoundariesToTokenPositions(lines, boundaries, 10);

    expect(ranges).toHaveLength(2);
    expect(ranges[0]).toEqual({ startToken: 0, endToken: 4 });
    expect(ranges[1]).toEqual({ startToken: 5, endToken: 9 });
  });

  it('maps a single-line document to the full token range', () => {
    // "hello world" is 11 chars + 1 newline = 12 total chars, numTokens = 12
    const lines = ['hello world'];
    const boundaries: ChunkBoundary[] = [{ startLine: 1, endLine: 1 }];
    const ranges = mapChunkBoundariesToTokenPositions(lines, boundaries, 12);

    expect(ranges).toHaveLength(1);
    expect(ranges[0]).toEqual({ startToken: 0, endToken: 11 });
  });

  it('maps a multi-line chunk correctly', () => {
    // Three equal-length lines ("aaaa", "bbbb", "cccc"), each 5 chars, total 15.
    // numTokens = 15
    // Chunk spanning lines 1-2 covers chars 0-9 (exclusive 10):
    //   startToken = floor(0/15 * 15) = 0
    //   endToken   = ceil(10/15 * 15) - 1 = ceil(10) - 1 = 9
    // Chunk spanning line 3 covers chars 10-14 (exclusive 15):
    //   startToken = floor(10/15 * 15) = 10
    //   endToken   = min(ceil(15/15 * 15) - 1, 14) = 14
    const lines = ['aaaa', 'bbbb', 'cccc'];
    const boundaries: ChunkBoundary[] = [
      { startLine: 1, endLine: 2 },
      { startLine: 3, endLine: 3 },
    ];
    const ranges = mapChunkBoundariesToTokenPositions(lines, boundaries, 15);

    expect(ranges).toHaveLength(2);
    expect(ranges[0]).toEqual({ startToken: 0, endToken: 9 });
    expect(ranges[1]).toEqual({ startToken: 10, endToken: 14 });
  });

  it('the full-document boundary maps to the full token range', () => {
    const lines = ['line one', 'line two', 'line three'];
    const boundaries: ChunkBoundary[] = [{ startLine: 1, endLine: 3 }];
    const numTokens = 20;
    const ranges = mapChunkBoundariesToTokenPositions(lines, boundaries, numTokens);

    expect(ranges[0]!.startToken).toBe(0);
    expect(ranges[0]!.endToken).toBe(numTokens - 1);
  });

  it('startToken is always ≤ endToken for every boundary', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
    const boundaries: ChunkBoundary[] = [
      { startLine: 1, endLine: 1 },
      { startLine: 3, endLine: 5 },
      { startLine: 7, endLine: 10 },
    ];
    const ranges = mapChunkBoundariesToTokenPositions(lines, boundaries, 100);
    for (const { startToken, endToken } of ranges) {
      expect(startToken).toBeLessThanOrEqual(endToken);
    }
  });

  it('all returned token indices are within [0, numTokens - 1]', () => {
    const lines = ['a', 'b', 'c', 'd'];
    const boundaries: ChunkBoundary[] = [
      { startLine: 1, endLine: 2 },
      { startLine: 3, endLine: 4 },
    ];
    const numTokens = 8;
    const ranges = mapChunkBoundariesToTokenPositions(lines, boundaries, numTokens);
    for (const { startToken, endToken } of ranges) {
      expect(startToken).toBeGreaterThanOrEqual(0);
      expect(endToken).toBeLessThanOrEqual(numTokens - 1);
    }
  });

  it('clamps out-of-bounds line numbers to the document range', () => {
    const lines = ['hello', 'world'];
    // startLine=0 (below 1) and endLine=999 (beyond doc) should clamp gracefully
    const boundaries: ChunkBoundary[] = [{ startLine: 0, endLine: 999 }];
    const ranges = mapChunkBoundariesToTokenPositions(lines, boundaries, 10);

    expect(ranges[0]!.startToken).toBe(0);
    expect(ranges[0]!.endToken).toBe(9);
  });

  // ── edge cases ─────────────────────────────────────────────────────────

  it('returns [{startToken:0, endToken:0}] for each boundary when document is empty', () => {
    const ranges = mapChunkBoundariesToTokenPositions(
      [],
      [{ startLine: 1, endLine: 1 }],
      10,
    );
    expect(ranges).toHaveLength(1);
    expect(ranges[0]).toEqual({ startToken: 0, endToken: 0 });
  });

  it('returns [{startToken:0, endToken:0}] for each boundary when numTokens is 0', () => {
    const ranges = mapChunkBoundariesToTokenPositions(
      ['hello', 'world'],
      [{ startLine: 1, endLine: 1 }],
      0,
    );
    expect(ranges).toHaveLength(1);
    expect(ranges[0]).toEqual({ startToken: 0, endToken: 0 });
  });

  it('returns an empty array when there are no boundaries', () => {
    const ranges = mapChunkBoundariesToTokenPositions(['hello', 'world'], [], 10);
    expect(ranges).toHaveLength(0);
  });

  it('returns a range per boundary, in the same order as input', () => {
    const lines = ['a', 'b', 'c', 'd', 'e'];
    const boundaries: ChunkBoundary[] = [
      { startLine: 1, endLine: 2 },
      { startLine: 4, endLine: 5 },
    ];
    const ranges = mapChunkBoundariesToTokenPositions(lines, boundaries, 50);
    // Second chunk starts after first (ascending order)
    expect(ranges[1]!.startToken).toBeGreaterThan(ranges[0]!.startToken);
  });
});

// ---------------------------------------------------------------------------
// averagePoolSlice
// ---------------------------------------------------------------------------

describe('averagePoolSlice', () => {
  it('returns the single token vector when the slice is one token wide', () => {
    const embeddings = [[1, 2, 3]];
    const result = averagePoolSlice(embeddings, 0, 0);
    expect(result).toEqual([1, 2, 3]);
  });

  it('returns the element-wise mean of a two-token slice', () => {
    // avg([[1, 0], [3, 4]]) = [2, 2]
    const embeddings = [[1, 0], [3, 4]];
    const result = averagePoolSlice(embeddings, 0, 1);
    expect(result).toHaveLength(2);
    expect(result[0]).toBeCloseTo(2, 10);
    expect(result[1]).toBeCloseTo(2, 10);
  });

  it('correctly averages a three-token slice', () => {
    // avg([[1, 2], [3, 4], [5, 6]]) = [3, 4]
    const embeddings = [[1, 2], [3, 4], [5, 6]];
    const result = averagePoolSlice(embeddings, 0, 2);
    expect(result[0]).toBeCloseTo(3, 10);
    expect(result[1]).toBeCloseTo(4, 10);
  });

  it('averages only the requested sub-slice (not the whole tensor)', () => {
    // Tokens 1 and 2 only: avg([[3, 4], [5, 6]]) = [4, 5]
    const embeddings = [[1, 2], [3, 4], [5, 6]];
    const result = averagePoolSlice(embeddings, 1, 2);
    expect(result[0]).toBeCloseTo(4, 10);
    expect(result[1]).toBeCloseTo(5, 10);
  });

  it('returns a result with the same dimensionality as the token vectors', () => {
    const dim = 768;
    const embeddings = [
      new Array(dim).fill(1) as number[],
      new Array(dim).fill(3) as number[],
    ];
    const result = averagePoolSlice(embeddings, 0, 1);
    expect(result).toHaveLength(dim);
    for (const v of result) {
      expect(v).toBeCloseTo(2, 10);
    }
  });

  it('clamps out-of-bounds indices gracefully (no throw)', () => {
    const embeddings = [[1, 2], [3, 4]];
    // startToken=-5, endToken=100 → clamps to 0..1
    const result = averagePoolSlice(embeddings, -5, 100);
    expect(result[0]).toBeCloseTo(2, 10);
    expect(result[1]).toBeCloseTo(3, 10);
  });

  it('returns the startToken vector when endToken < startToken (after clamping)', () => {
    // startToken=1, endToken=0 → clamped endToken = max(clampedStart, endToken)=1 → single token
    const embeddings = [[1, 2], [3, 4]];
    const result = averagePoolSlice(embeddings, 1, 0);
    // endToken clamped to max(1, clamp(0, 0, 1)) = 1 → slice is [[3,4]]
    expect(result[0]).toBeCloseTo(3, 10);
    expect(result[1]).toBeCloseTo(4, 10);
  });

  it('returns an empty array when the token embedding matrix is empty', () => {
    const result = averagePoolSlice([], 0, 0);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// lateChunkEmbed — TEI happy path
// ---------------------------------------------------------------------------

describe('lateChunkEmbed — TEI token-level path', () => {
  it('calls embedTokenLevel with the full document text', async () => {
    // Token embeddings: 4 tokens, dim 2
    const tokenEmbeddings = [
      [0.1, 0.2],
      [0.3, 0.4],
      [0.4, 0.6],
      [0.7, 0.8],
    ];
    const client = makeMockClient(tokenEmbeddings);

    const document = 'hello\nworld';
    const documentLines = ['hello', 'world'];
    const boundaries: ChunkBoundary[] = [
      { startLine: 1, endLine: 1 },
      { startLine: 2, endLine: 2 },
    ];

    await lateChunkEmbed(client, document, documentLines, boundaries);

    expect(client.embedTokenLevel).toHaveBeenCalledOnce();
    expect(client.embedTokenLevel).toHaveBeenCalledWith(document);
  });

  it('does NOT call embed() on the standard path when TEI succeeds', async () => {
    const client = makeMockClient([[0.1, 0.2], [0.3, 0.4]]);

    await lateChunkEmbed(client, 'hello\nworld', ['hello', 'world'], [
      { startLine: 1, endLine: 2 },
    ]);

    expect(client.embed).not.toHaveBeenCalled();
  });

  it('returns one embedding vector per chunk boundary', async () => {
    // 4 tokens, 2 chunks (each 2 tokens)
    const client = makeMockClient([
      [1, 0],
      [3, 4],
      [5, 6],
      [7, 8],
    ]);
    const boundaries: ChunkBoundary[] = [
      { startLine: 1, endLine: 1 },
      { startLine: 2, endLine: 2 },
    ];
    const result = await lateChunkEmbed(
      client,
      'hello\nworld',
      ['hello', 'world'],
      boundaries,
    );

    expect(result).toHaveLength(2);
  });

  it('average-pools the correct token slice for each chunk', async () => {
    // Lines: "hello" (5+1=6 chars) and "world" (5+1=6 chars), total 12 chars
    // numTokens=4 → each line maps to 2 tokens (tokens 0-1 and tokens 2-3)
    const tokenEmbeddings = [
      [1, 0],  // token 0 → line 1
      [3, 4],  // token 1 → line 1
      [5, 6],  // token 2 → line 2
      [7, 8],  // token 3 → line 2
    ];
    const client = makeMockClient(tokenEmbeddings);

    const result = await lateChunkEmbed(
      client,
      'hello\nworld',
      ['hello', 'world'],
      [
        { startLine: 1, endLine: 1 },
        { startLine: 2, endLine: 2 },
      ],
    );

    // Chunk 1: avg(tokens 0-1) = avg([[1,0],[3,4]]) = [2, 2]
    expect(result[0]![0]).toBeCloseTo(2, 10);
    expect(result[0]![1]).toBeCloseTo(2, 10);
    // Chunk 2: avg(tokens 2-3) = avg([[5,6],[7,8]]) = [6, 7]
    expect(result[1]![0]).toBeCloseTo(6, 10);
    expect(result[1]![1]).toBeCloseTo(7, 10);
  });

  it('returns an empty array immediately when boundaries is empty', async () => {
    const client = makeMockClient([[0.1, 0.2]]);

    const result = await lateChunkEmbed(client, 'any doc', ['any doc'], []);

    expect(result).toEqual([]);
    expect(client.embedTokenLevel).not.toHaveBeenCalled();
    expect(client.embed).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// lateChunkEmbed — fallback to standard per-chunk embedding
// ---------------------------------------------------------------------------

describe('lateChunkEmbed — fallback to standard per-chunk embedding', () => {
  it('falls back to embed() when embedTokenLevel returns null', async () => {
    const pooledEmbeddings = [[0.5, 0.6], [0.7, 0.8]];
    const client = makeMockClient(null, pooledEmbeddings);

    const result = await lateChunkEmbed(
      client,
      'hello\nworld',
      ['hello', 'world'],
      [
        { startLine: 1, endLine: 1 },
        { startLine: 2, endLine: 2 },
      ],
    );

    expect(client.embedTokenLevel).toHaveBeenCalledOnce();
    expect(client.embed).toHaveBeenCalledOnce();
    expect(result).toEqual(pooledEmbeddings);
  });

  it('falls back to embed() when embedTokenLevel returns an empty array', async () => {
    const pooledEmbeddings = [[0.1, 0.2]];
    const client = makeMockClient([], pooledEmbeddings);

    const result = await lateChunkEmbed(
      client,
      'hello',
      ['hello'],
      [{ startLine: 1, endLine: 1 }],
    );

    expect(client.embed).toHaveBeenCalledOnce();
    expect(result).toEqual(pooledEmbeddings);
  });

  it('passes the correct chunk text for each boundary to embed() on fallback', async () => {
    const client = makeMockClient(null, [[], []]);

    const documentLines = ['line one', 'line two', 'line three'];
    const boundaries: ChunkBoundary[] = [
      { startLine: 1, endLine: 2 },   // "line one\nline two"
      { startLine: 3, endLine: 3 },   // "line three"
    ];

    await lateChunkEmbed(
      client,
      documentLines.join('\n'),
      documentLines,
      boundaries,
    );

    expect(client.embed).toHaveBeenCalledWith([
      'line one\nline two',
      'line three',
    ]);
  });

  it('returns as many embeddings as boundaries when falling back', async () => {
    const numBoundaries = 5;
    const pooled = Array.from({ length: numBoundaries }, (_, i) => [i * 0.1]);
    const client = makeMockClient(null, pooled);

    const documentLines = Array.from({ length: numBoundaries }, (_, i) => `line ${i + 1}`);
    const boundaries: ChunkBoundary[] = documentLines.map((_, i) => ({
      startLine: i + 1,
      endLine: i + 1,
    }));

    const result = await lateChunkEmbed(
      client,
      documentLines.join('\n'),
      documentLines,
      boundaries,
    );

    expect(result).toHaveLength(numBoundaries);
  });

  it('clamps out-of-bounds line numbers when extracting fallback chunk text', async () => {
    const client = makeMockClient(null, [[]]);
    const documentLines = ['only line'];

    // startLine=0 is out of bounds (1-indexed), endLine=999 is beyond document
    const boundaries: ChunkBoundary[] = [{ startLine: 0, endLine: 999 }];

    await lateChunkEmbed(client, 'only line', documentLines, boundaries);

    // Should call embed with "only line" (clamped to line 1 only)
    expect(client.embed).toHaveBeenCalledWith(['only line']);
  });
});

// ---------------------------------------------------------------------------
// lateChunkEmbed — interface (type compliance)
// ---------------------------------------------------------------------------

describe('lateChunkEmbed — interface compliance', () => {
  it('accepts any object implementing LateChunkEmbeddingClient (structural typing)', async () => {
    const customClient: LateChunkEmbeddingClient = {
      embedTokenLevel: vi.fn().mockResolvedValue([[0.5, 0.5]]),
      embed: vi.fn().mockResolvedValue([[0.5, 0.5]]),
      embedSingle: vi.fn().mockResolvedValue([0.5, 0.5]),
    };

    const result = await lateChunkEmbed(
      customClient,
      'hello',
      ['hello'],
      [{ startLine: 1, endLine: 1 }],
    );

    expect(result).toHaveLength(1);
    expect(Array.isArray(result[0])).toBe(true);
  });
});
