// ---------------------------------------------------------------------------
// Embedding Client
// ---------------------------------------------------------------------------
//
// Thin wrapper around OpenAI's text embedding API.
//
// Design principles:
// - Never throws — all API/network errors are caught and logged via
//   console.warn, returning empty arrays so callers can proceed without
//   embeddings (graceful degradation).
// - Batches requests in groups of 100 to stay within API limits.
// - Uses text-embedding-3-small by default (1536-dimensional vectors).

import OpenAI from 'openai';
import type { AIConfig } from './config.js';

/** Batch size for embedding API calls. OpenAI allows up to 2048 inputs. */
const EMBEDDING_BATCH_SIZE = 100;

// ---------------------------------------------------------------------------
// EmbeddingClient
// ---------------------------------------------------------------------------

/**
 * Wraps the OpenAI embeddings API for batch text embedding.
 *
 * Graceful degradation: any embedding failure returns an empty array for the
 * affected batch rather than throwing. Callers that check for empty arrays
 * can skip semantic retrieval and fall back to graph + lexical results.
 */
export class EmbeddingClient {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(config: AIConfig) {
    this.client = new OpenAI({ apiKey: config.apiKey });
    this.model = config.embeddingModel;
  }

  /**
   * Embeds an array of texts in batches of {@link EMBEDDING_BATCH_SIZE}.
   *
   * Returns a parallel array of embedding vectors. If any batch fails, the
   * corresponding entries are filled with empty arrays so the caller can
   * identify which embeddings are missing.
   *
   * @param texts - Input texts to embed.
   * @returns A parallel array of float vectors (may contain empty sub-arrays on
   *   partial failure).
   */
  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const results: number[][] = new Array(texts.length).fill([]);

    for (let start = 0; start < texts.length; start += EMBEDDING_BATCH_SIZE) {
      const end = Math.min(start + EMBEDDING_BATCH_SIZE, texts.length);
      const batch = texts.slice(start, end);

      try {
        const response = await this.client.embeddings.create({
          model: this.model,
          input: batch,
        });

        // Response data is sorted by index
        for (const item of response.data) {
          results[start + item.index] = item.embedding;
        }
      } catch (error) {
        console.warn(
          `[EmbeddingClient] Batch embedding failed (texts ${start}–${end - 1}): ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
        // Leave entries as empty arrays for graceful degradation
      }
    }

    return results;
  }

  /**
   * Embeds a single text string.
   *
   * Returns an empty array on failure, enabling callers to skip semantic
   * retrieval rather than aborting.
   *
   * @param text - Input text to embed.
   * @returns Embedding vector, or an empty array on failure.
   */
  async embedSingle(text: string): Promise<number[]> {
    const results = await this.embed([text]);
    return results[0] ?? [];
  }
}
