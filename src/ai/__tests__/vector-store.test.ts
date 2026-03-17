import { describe, it, expect } from 'vitest';
import { VectorStore, cosineSimilarity } from '../vector-store.js';
import type { IndexedChunk } from '../chunk-indexer.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChunk(
  id: string,
  namespace?: string,
  category: IndexedChunk['artifactCategory'] = 'kubernetes-resource',
): IndexedChunk {
  return {
    id,
    artifactId: `cluster-resources/${id}.json`,
    content: `Content of ${id}`,
    startLine: 1,
    endLine: 3,
    summary: `Summary of ${id}`,
    identifiers: [id],
    artifactCategory: category,
    namespace,
  };
}

/** Creates a simple 3-dimensional unit vector pointing in one direction. */
function makeVec(x: number, y: number, z: number): number[] {
  return [x, y, z];
}

// ---------------------------------------------------------------------------
// cosineSimilarity
// ---------------------------------------------------------------------------

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    const v = [0.5, 0.5, 0.5];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0);
  });

  it('returns a value close to 1 for near-identical vectors', () => {
    const a = [0.8, 0.6, 0.0];
    const b = [0.81, 0.59, 0.01];
    expect(cosineSimilarity(a, b)).toBeGreaterThan(0.99);
  });

  it('returns 0 for empty vectors', () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it('returns 0 when one vector is empty', () => {
    expect(cosineSimilarity([1, 0], [])).toBe(0);
    expect(cosineSimilarity([], [1, 0])).toBe(0);
  });

  it('returns 0 for mismatched-length vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0])).toBe(0);
  });

  it('returns 0 for zero vectors (avoids division by zero)', () => {
    expect(cosineSimilarity([0, 0, 0], [0, 0, 0])).toBe(0);
  });

  it('is commutative: similarity(a, b) === similarity(b, a)', () => {
    const a = [0.3, 0.7, 0.2];
    const b = [0.6, 0.1, 0.9];
    expect(cosineSimilarity(a, b)).toBeCloseTo(cosineSimilarity(b, a));
  });

  it('clamps negative cosine similarity to 0', () => {
    // Opposite vectors have cosine similarity of -1 — should clamp to 0
    expect(cosineSimilarity([1, 0], [-1, 0])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// VectorStore
// ---------------------------------------------------------------------------

describe('VectorStore', () => {
  // ── addAll / size ─────────────────────────────────────────────────────────

  it('starts empty', () => {
    const store = new VectorStore();
    expect(store.size).toBe(0);
  });

  it('adds chunks with valid embeddings', () => {
    const store = new VectorStore();
    const chunks = [makeChunk('chunk-a'), makeChunk('chunk-b')];
    const embeddings = [makeVec(1, 0, 0), makeVec(0, 1, 0)];

    store.addAll(chunks, embeddings);

    expect(store.size).toBe(2);
  });

  it('skips chunks with empty embeddings', () => {
    const store = new VectorStore();
    const chunks = [makeChunk('chunk-a'), makeChunk('chunk-b'), makeChunk('chunk-c')];
    const embeddings = [makeVec(1, 0, 0), [], makeVec(0, 0, 1)];

    store.addAll(chunks, embeddings);

    expect(store.size).toBe(2); // chunk-b skipped
  });

  it('handles parallel arrays of different lengths gracefully (uses shorter)', () => {
    const store = new VectorStore();
    const chunks = [makeChunk('a'), makeChunk('b'), makeChunk('c')];
    const embeddings = [makeVec(1, 0, 0), makeVec(0, 1, 0)]; // only 2

    store.addAll(chunks, embeddings);

    expect(store.size).toBe(2);
  });

  it('appends on successive addAll calls', () => {
    const store = new VectorStore();
    store.addAll([makeChunk('a')], [makeVec(1, 0, 0)]);
    store.addAll([makeChunk('b')], [makeVec(0, 1, 0)]);

    expect(store.size).toBe(2);
  });

  // ── query ─────────────────────────────────────────────────────────────────

  it('returns empty array for empty store', () => {
    const store = new VectorStore();
    const result = store.query(makeVec(1, 0, 0), 5);
    expect(result).toEqual([]);
  });

  it('returns empty array for empty query embedding', () => {
    const store = new VectorStore();
    store.addAll([makeChunk('a')], [makeVec(1, 0, 0)]);

    const result = store.query([], 5);
    expect(result).toEqual([]);
  });

  it('returns empty array when topK is 0', () => {
    const store = new VectorStore();
    store.addAll([makeChunk('a')], [makeVec(1, 0, 0)]);

    const result = store.query(makeVec(1, 0, 0), 0);
    expect(result).toEqual([]);
  });

  it('returns the most similar chunk first', () => {
    const store = new VectorStore();
    const chunks = [makeChunk('similar'), makeChunk('different')];
    const embeddings = [
      makeVec(1, 0, 0),  // similar to query
      makeVec(0, 1, 0),  // orthogonal to query
    ];
    store.addAll(chunks, embeddings);

    const query = makeVec(0.99, 0.14, 0); // nearly pointing in [1,0,0] direction
    const result = store.query(query, 2);

    expect(result[0]!.chunk.id).toBe('similar');
    expect(result[0]!.score).toBeGreaterThan(result[1]!.score);
  });

  it('returns at most topK results', () => {
    const store = new VectorStore();
    const chunks = Array.from({ length: 10 }, (_, i) => makeChunk(`chunk-${i}`));
    const embeddings = chunks.map((_, i) => makeVec(i * 0.1 + 0.1, 0, 0));
    store.addAll(chunks, embeddings);

    const result = store.query(makeVec(1, 0, 0), 3);

    expect(result.length).toBeLessThanOrEqual(3);
  });

  it('includes a cosine similarity score with each result', () => {
    const store = new VectorStore();
    store.addAll([makeChunk('a')], [makeVec(1, 0, 0)]);

    const result = store.query(makeVec(1, 0, 0), 1);

    expect(result).toHaveLength(1);
    expect(result[0]!.score).toBeCloseTo(1.0);
  });

  it('excludes chunks with zero cosine similarity (orthogonal)', () => {
    const store = new VectorStore();
    const chunks = [makeChunk('relevant'), makeChunk('orthogonal')];
    const embeddings = [makeVec(1, 0, 0), makeVec(0, 1, 0)];
    store.addAll(chunks, embeddings);

    // Query points exactly in the [1, 0, 0] direction
    const result = store.query(makeVec(1, 0, 0), 5);

    // Only the relevant chunk should appear; the orthogonal chunk has score 0
    expect(result).toHaveLength(1);
    expect(result[0]!.chunk.id).toBe('relevant');
  });

  // ── Namespace filtering ───────────────────────────────────────────────────

  it('filters results by namespace when filter is provided', () => {
    const store = new VectorStore();
    const chunks = [
      makeChunk('ns-default-pod', 'default'),
      makeChunk('ns-kube-system-pod', 'kube-system'),
      makeChunk('no-namespace-pod', undefined),
    ];
    const embeddings = [makeVec(1, 0, 0), makeVec(1, 0, 0), makeVec(1, 0, 0)];
    store.addAll(chunks, embeddings);

    const result = store.query(makeVec(1, 0, 0), 10, { namespace: 'default' });

    expect(result).toHaveLength(1);
    expect(result[0]!.chunk.id).toBe('ns-default-pod');
  });

  it('returns all matching chunks when no namespace filter is provided', () => {
    const store = new VectorStore();
    const chunks = [
      makeChunk('pod-a', 'default'),
      makeChunk('pod-b', 'kube-system'),
      makeChunk('pod-c', undefined),
    ];
    const embeddings = [makeVec(1, 0, 0), makeVec(1, 0, 0), makeVec(1, 0, 0)];
    store.addAll(chunks, embeddings);

    const result = store.query(makeVec(1, 0, 0), 10);

    expect(result).toHaveLength(3);
  });

  it('returns empty array when namespace filter matches no chunks', () => {
    const store = new VectorStore();
    store.addAll([makeChunk('pod', 'default')], [makeVec(1, 0, 0)]);

    const result = store.query(makeVec(1, 0, 0), 5, { namespace: 'production' });

    expect(result).toEqual([]);
  });

  // ── Sorting determinism ───────────────────────────────────────────────────

  it('breaks score ties deterministically by chunk id', () => {
    const store = new VectorStore();
    // Both chunks have the same embedding → same cosine similarity
    const chunks = [makeChunk('zzz-chunk'), makeChunk('aaa-chunk')];
    const embeddings = [makeVec(1, 0, 0), makeVec(1, 0, 0)];
    store.addAll(chunks, embeddings);

    const result = store.query(makeVec(1, 0, 0), 5);

    // 'aaa-chunk' should come first (lexicographically smaller id)
    expect(result[0]!.chunk.id).toBe('aaa-chunk');
    expect(result[1]!.chunk.id).toBe('zzz-chunk');
  });

  // ── clear ─────────────────────────────────────────────────────────────────

  it('clear removes all stored records', () => {
    const store = new VectorStore();
    store.addAll([makeChunk('a'), makeChunk('b')], [makeVec(1, 0, 0), makeVec(0, 1, 0)]);
    expect(store.size).toBe(2);

    store.clear();

    expect(store.size).toBe(0);
    expect(store.query(makeVec(1, 0, 0), 5)).toEqual([]);
  });
});
