// ---------------------------------------------------------------------------
// Local Embedding Client
// ---------------------------------------------------------------------------
//
// Implements EmbeddingClientInterface for locally-hosted embedding services.
//
// Supported backends:
//   tei    — HuggingFace Text Embeddings Inference (batch endpoint /embed)
//   ollama — Ollama per-text endpoint /api/embeddings
//   auto   — Try TEI first; fall back to Ollama on any error (default)
//
// The `createEmbeddingClient` factory reads AIConfig and returns the right
// EmbeddingClientInterface implementation:
//   embeddingBackend=local   → LocalEmbeddingClient (TEI → Ollama auto mode)
//   embeddingBackend=openai  → EmbeddingClient (OpenAI API, requires apiKey)
//   embeddingBackend=none    → undefined (graph + BM25 only)
//
// Graceful degradation chain:
//   TEI (token-level) → Ollama (pooled) → OpenAI API → no semantic retrieval

import type { AIConfig } from './config.js';
import type { EmbeddingClientInterface } from './embeddings.js';
import { EmbeddingClient } from './embeddings.js';
import type { LateChunkEmbeddingClient } from './late-chunking.js';
import { sanitizeSensitiveText } from '../utils/sensitive-data.js';

// ---------------------------------------------------------------------------
// LocalEmbeddingClient config
// ---------------------------------------------------------------------------

/**
 * Local backend type.
 *
 * - `tei`    — HuggingFace TEI: `POST /embed` with `{ "inputs": [...] }`
 * - `ollama` — Ollama: `POST /api/embeddings` with `{ "model", "prompt" }` per text
 * - `auto`   — Try TEI first, fall back to Ollama on any error (default)
 */
export type LocalBackendType = 'tei' | 'ollama' | 'auto';

export interface LocalEmbeddingClientConfig {
  /** Base URL of the embedding service (trailing slash is stripped). */
  url: string;
  /** Model name passed to Ollama. Ignored by TEI (model is baked into the server). */
  model: string;
  /**
   * Which protocol to use.
   * @default 'auto'
   */
  backend?: LocalBackendType;
  /** Per-request timeout in milliseconds. @default 30000 */
  timeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// LocalEmbeddingClient
// ---------------------------------------------------------------------------

/**
 * Embedding client that calls a locally-hosted embedding service.
 *
 * Implements {@link EmbeddingClientInterface}.
 *
 * In `auto` mode (default), each call first attempts the TEI batch endpoint.
 * If TEI is unavailable or returns an error, it falls back to individual
 * Ollama requests.  Both failure modes degrade gracefully — empty arrays are
 * returned rather than throwing.
 */
export class LocalEmbeddingClient implements LateChunkEmbeddingClient {
  private readonly url: string;
  private readonly model: string;
  private readonly backend: LocalBackendType;
  private readonly timeoutMs: number;

  constructor(config: LocalEmbeddingClientConfig) {
    this.url = config.url.replace(/\/+$/, ''); // strip trailing slash(es)
    this.model = config.model;
    this.backend = config.backend ?? 'auto';
    this.timeoutMs =
      Number.isFinite(config.timeoutMs) && (config.timeoutMs ?? 0) > 0
        ? Math.floor(config.timeoutMs!)
        : DEFAULT_REQUEST_TIMEOUT_MS;
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Embeds an array of texts using the configured local backend.
   *
   * In `auto` mode, tries TEI first and falls back to Ollama on any error.
   * Returns a parallel array of vectors; failed entries are empty arrays.
   */
  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const sanitizedTexts = texts.map(sanitizeSensitiveText);

    if (this.backend === 'ollama') {
      return this.embedWithOllama(sanitizedTexts);
    }

    // 'tei' or 'auto': try TEI first
    const teiResult = await this.tryEmbedWithTEI(sanitizedTexts);
    if (teiResult !== null) {
      return teiResult;
    }

    // TEI failed — if auto mode, fall back to Ollama
    if (this.backend === 'auto') {
      return this.embedWithOllama(sanitizedTexts);
    }

    // backend === 'tei' with no fallback: return empty arrays
    return new Array(sanitizedTexts.length).fill([]) as number[][];
  }

  /**
   * Embeds a single text string.
   *
   * Returns an empty array on failure.
   */
  async embedSingle(text: string): Promise<number[]> {
    const results = await this.embed([text]);
    return results[0] ?? [];
  }

  /**
   * Embeds a single document and returns one vector per token (TEI only).
   *
   * Calls the TEI `/embed_all` endpoint which returns a 2-D array of shape
   * `[num_tokens, dim]`.  Returns `null` when TEI is unavailable, the
   * endpoint returns an error, or the backend is Ollama (which does not
   * support token-level output).
   *
   * Returning `null` signals {@link lateChunkEmbed} to fall back to standard
   * per-chunk embedding via `embed()`.
   *
   * @param text - Full document text.
   * @returns Token-level embeddings `[num_tokens, dim]`, or `null` on failure.
   */
  async embedTokenLevel(text: string): Promise<number[][] | null> {
    // Ollama does not support token-level outputs.
    if (this.backend === 'ollama') return null;

    try {
      const response = await this.fetchWithTimeout(`${this.url}/embed_all`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inputs: sanitizeSensitiveText(text) }),
      });

      if (!response.ok) {
        console.warn(
          `[LocalEmbeddingClient] TEI /embed_all failed: HTTP ${response.status}`,
        );
        return null;
      }

      const data = (await response.json()) as number[][];
      return data;
    } catch (error) {
      console.warn(
        `[LocalEmbeddingClient] TEI /embed_all error: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Private: TEI backend
  // ---------------------------------------------------------------------------

  /**
   * Attempts to embed texts via the TEI batch endpoint (`POST /embed`).
   *
   * Returns the result array on success, or `null` on any error (HTTP error
   * status or network failure).  Callers use `null` as the signal to fall
   * back to Ollama in auto mode.
   */
  private async tryEmbedWithTEI(texts: string[]): Promise<number[][] | null> {
    try {
      const response = await this.fetchWithTimeout(`${this.url}/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inputs: texts }),
      });

      if (!response.ok) {
        console.warn(
          `[LocalEmbeddingClient] TEI request failed: HTTP ${response.status}`,
        );
        return null;
      }

      const data = (await response.json()) as number[][];
      return data;
    } catch (error) {
      console.warn(
        `[LocalEmbeddingClient] TEI embedding failed: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Private: Ollama backend
  // ---------------------------------------------------------------------------

  /**
   * Embeds texts via the Ollama per-text endpoint (`POST /api/embeddings`).
   *
   * Issues one HTTP request per text (Ollama's legacy embedding API does not
   * support batching).  Failed entries are filled with empty arrays.
   */
  private async embedWithOllama(texts: string[]): Promise<number[][]> {
    const results: number[][] = new Array(texts.length).fill([]) as number[][];

    for (let i = 0; i < texts.length; i++) {
      try {
        const response = await this.fetchWithTimeout(`${this.url}/api/embeddings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: this.model, prompt: texts[i] }),
        });

        if (!response.ok) {
          console.warn(
            `[LocalEmbeddingClient] Ollama request failed for text ${i}: ` +
              `HTTP ${response.status}`,
          );
          continue;
        }

        const data = (await response.json()) as { embedding: number[] };
        results[i] = data.embedding;
      } catch (error) {
        console.warn(
          `[LocalEmbeddingClient] Ollama embedding failed for text ${i}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
        // Leave as empty array
      }
    }

    return results;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates the appropriate {@link EmbeddingClientInterface} based on the AI
 * configuration.
 *
 * Selection logic:
 * - `embeddingBackend === 'local'`  → {@link LocalEmbeddingClient} (auto mode:
 *   TEI → Ollama fallback)
 * - `embeddingBackend === 'openai'` → {@link EmbeddingClient} (requires a
 *   non-empty `apiKey`)
 * - `embeddingBackend === 'none'`   → `undefined` (skip semantic retrieval)
 *
 * Returns `undefined` when no usable backend is available.  The pipeline
 * interprets `undefined` as "no semantic retrieval — use graph + BM25 only."
 *
 * @param config - Loaded AI configuration.
 * @returns An embedding client, or `undefined` if embeddings are disabled.
 */
export function createEmbeddingClient(
  config: AIConfig,
): EmbeddingClientInterface | undefined {
  const backend = config.embeddingBackend;

  if (backend === 'local') {
    return new LocalEmbeddingClient({
      url: config.embeddingUrl,
      model: config.embeddingModel,
      // default backend: 'auto' (TEI → Ollama)
    });
  }

  if (backend === 'openai') {
    // Only create the OpenAI client when a key is present
    if (config.apiKey.trim().length > 0) {
      return new EmbeddingClient(config);
    }
    return undefined;
  }

  // backend === 'none' (or unrecognised): skip embeddings
  return undefined;
}
