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
import { sanitizeSensitiveText } from '../utils/sensitive-data.js';

/** Batch size for embedding API calls. OpenAI allows up to 2048 inputs. */
const EMBEDDING_BATCH_SIZE = 100;

// ---------------------------------------------------------------------------
// EmbeddingClientInterface
// ---------------------------------------------------------------------------

/**
 * Common interface for all embedding backends.
 *
 * Both {@link EmbeddingClient} (OpenAI) and {@link LocalEmbeddingClient}
 * (TEI / Ollama) implement this interface so the rest of the pipeline is
 * backend-agnostic.
 *
 * Graceful-degradation contract: all implementations MUST return empty arrays
 * (not throw) when embeddings fail, enabling callers to skip semantic
 * retrieval rather than aborting.
 */
export interface EmbeddingClientInterface {
  /**
   * Embeds an array of texts.
   *
   * Returns a parallel array of embedding vectors.  Entries may be empty
   * arrays when the corresponding embedding could not be computed.
   *
   * @param texts - Input texts to embed.
   * @returns Parallel array of float vectors (empty sub-arrays on failure).
   */
  embed(texts: string[]): Promise<number[][]>;

  /**
   * Embeds a single text string.
   *
   * Returns an empty array on failure.
   *
   * @param text - Input text to embed.
   * @returns Embedding vector, or an empty array on failure.
   */
  embedSingle(text: string): Promise<number[]>;
}

// ---------------------------------------------------------------------------
// EmbeddingClient (OpenAI backend)
// ---------------------------------------------------------------------------

/**
 * Wraps the OpenAI embeddings API for batch text embedding.
 *
 * Implements {@link EmbeddingClientInterface}.
 *
 * Graceful degradation: any embedding failure returns an empty array for the
 * affected batch rather than throwing. Callers that check for empty arrays
 * can skip semantic retrieval and fall back to graph + lexical results.
 */
export class EmbeddingClient implements EmbeddingClientInterface {
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
      // OpenAI embeddings are an external-egress boundary just like LLM
      // prompts. Redact here so every cloud embedding call is protected even
      // when a caller bypasses the normal prompt-building path.
      const batch = texts.slice(start, end).map(sanitizeSensitiveText);

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
