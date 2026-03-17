// ---------------------------------------------------------------------------
// In-Memory Vector Store
// ---------------------------------------------------------------------------
//
// Stores chunk-embedding pairs and retrieves the top-K most similar chunks
// for a given query embedding via cosine similarity.
//
// Design principles:
// - Pure in-memory, no external dependencies. A 10 k-chunk bundle at 1536
//   dimensions uses ~60 MB of float64 memory — acceptable for local analysis.
// - Linear scan cosine similarity: fast enough for bundles up to ~10 k chunks.
// - Optional namespace filter: scopes retrieval to a Kubernetes namespace.
// - Never throws — callers should treat an empty result as "no semantic hits".

import type { IndexedChunk } from './chunk-indexer.js';

// ---------------------------------------------------------------------------
// ScoredChunk (re-exported from here for vector-store consumers)
// ---------------------------------------------------------------------------

/**
 * An {@link IndexedChunk} paired with a cosine-similarity score in [0, 1].
 */
export interface ScoredChunk {
  chunk: IndexedChunk;
  /** Cosine similarity score in the range [0, 1]. Higher is more relevant. */
  score: number;
}

// ---------------------------------------------------------------------------
// Stored record
// ---------------------------------------------------------------------------

interface ChunkRecord {
  chunk: IndexedChunk;
  embedding: number[];
}

// ---------------------------------------------------------------------------
// cosineSimilarity (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Computes the cosine similarity between two vectors.
 *
 * Returns 0 for zero-length or mismatched vectors instead of throwing, so
 * bad embeddings degrade gracefully rather than breaking retrieval.
 *
 * @param a - First vector.
 * @param b - Second vector.
 * @returns Cosine similarity in [−1, 1], clamped to [0, 1] for non-negative
 *   embedding spaces. Returns 0 for degenerate inputs.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) {
    return 0;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }

  if (normA === 0 || normB === 0) return 0;

  // Clamp to [0, 1] — embeddings from ada/text-embedding-3 are always ≥ 0
  // in practice, but negative cosine values would be noise.
  return Math.max(0, dot / (Math.sqrt(normA) * Math.sqrt(normB)));
}

// ---------------------------------------------------------------------------
// VectorStore
// ---------------------------------------------------------------------------

/**
 * In-memory vector store for {@link IndexedChunk} embeddings.
 *
 * ### Usage
 * ```typescript
 * const store = new VectorStore();
 * store.addAll(chunks, embeddings);   // parallel arrays
 * const hits = store.query(queryEmbedding, 5);
 * ```
 *
 * ### Namespace filtering
 * Pass a `{ namespace }` filter to `query` to restrict results to chunks
 * from a specific Kubernetes namespace. This is useful when investigating a
 * seed scoped to a single namespace.
 */
export class VectorStore {
  private records: ChunkRecord[] = [];

  /**
   * Stores chunk-embedding pairs.
   *
   * `chunks` and `embeddings` must be parallel arrays of equal length.
   * Entries where the embedding is an empty array are silently skipped —
   * this handles partial embedding failures from {@link EmbeddingClient}.
   *
   * Calling `addAll` again appends to existing records. Call `clear` first
   * to rebuild from scratch.
   *
   * @param chunks     - Indexed chunks to store.
   * @param embeddings - Parallel embedding vectors. Empty arrays are skipped.
   */
  addAll(chunks: IndexedChunk[], embeddings: number[][]): void {
    const len = Math.min(chunks.length, embeddings.length);

    for (let i = 0; i < len; i++) {
      const embedding = embeddings[i]!;
      if (embedding.length === 0) continue; // Skip failed embeddings

      this.records.push({ chunk: chunks[i]!, embedding });
    }
  }

  /**
   * Returns the top-`topK` chunks most similar to `queryEmbedding`.
   *
   * If `queryEmbedding` is an empty array (e.g. from a failed
   * {@link EmbeddingClient.embedSingle} call), returns `[]` immediately so
   * callers can degrade gracefully.
   *
   * @param queryEmbedding - Embedding of the query text.
   * @param topK           - Maximum number of results to return.
   * @param filter         - Optional filter. Currently supports `namespace`.
   * @returns Scored chunks sorted by descending cosine similarity.
   */
  query(
    queryEmbedding: number[],
    topK: number,
    filter?: { namespace?: string },
  ): ScoredChunk[] {
    if (queryEmbedding.length === 0 || this.records.length === 0 || topK <= 0) {
      return [];
    }

    const ns = filter?.namespace;

    const scored: ScoredChunk[] = [];

    for (const record of this.records) {
      // Apply namespace filter
      if (ns !== undefined && record.chunk.namespace !== ns) {
        continue;
      }

      const score = cosineSimilarity(queryEmbedding, record.embedding);
      if (score > 0) {
        scored.push({ chunk: record.chunk, score });
      }
    }

    // Sort descending by score, then by chunk id for determinism
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.chunk.id.localeCompare(b.chunk.id);
    });

    return scored.slice(0, topK);
  }

  /**
   * Returns the number of indexed records (chunks with valid embeddings).
   */
  get size(): number {
    return this.records.length;
  }

  /**
   * Removes all stored records.
   */
  clear(): void {
    this.records = [];
  }
}
