// ---------------------------------------------------------------------------
// AI Configuration
// ---------------------------------------------------------------------------
//
// Reads AI provider settings from environment variables and optional CLI
// overrides. AI is enabled only when a valid API key is present AND the
// caller has not explicitly opted out with --no-ai.
//
// Environment variables:
//   OPENAI_API_KEY         — OpenAI API key (required for AI features)
//   SBI_LLM_API_KEY        — Optional credential for a local LLM endpoint.
//                            Defaults to a non-secret placeholder in local mode.
//   SBI_AI_MODEL           — Chat completion model (default: gpt-5.6-terra)
//   SBI_LLM_BACKEND        — LLM backend (default: openai)
//                            Values: openai | local
//   SBI_LLM_URL            — LLM endpoint URL (default: https://api.openai.com/v1)
//                            For local backends (Ollama, llama.cpp, vLLM):
//                              http://localhost:11434/v1
//   SBI_TOKEN_BUDGET        — Max tokens of context per AI seed call (default: 100000)
//   SBI_EMBEDDING_MODEL    — Embedding model     (default: text-embedding-3-small)
//   SBI_EMBEDDING_BACKEND  — Embedding backend   (default: local)
//                            Values: local | openai | none
//   SBI_EMBEDDING_URL      — Local embedding endpoint (default: http://localhost:8080)
//                            Used when SBI_EMBEDDING_BACKEND=local

import { getRecorderMode } from './recorder.js';

export type AIProvider = 'openai' | 'none';

/**
 * Backend to use for LLM chat completions.
 *
 * - `openai` — OpenAI API (default). Requires OPENAI_API_KEY.
 * - `local`  — Any OpenAI-compatible local server (Ollama, llama.cpp,
 *              vLLM, LM Studio). Uses SBI_LLM_URL as the base endpoint.
 *              Uses SBI_LLM_API_KEY when configured, otherwise a non-secret
 *              placeholder; OPENAI_API_KEY is never sent to the endpoint.
 */
export type LLMBackend = 'openai' | 'local';

/**
 * Backend to use for text embeddings.
 *
 * - `local`  — Local HTTP embedding service (TEI or Ollama). Preferred for
 *              offline / on-premise deployments. Falls back to Ollama when
 *              TEI is unavailable.
 * - `openai` — OpenAI Embeddings API (requires OPENAI_API_KEY).
 * - `none`   — Disable embeddings entirely; graph + BM25 retrieval only.
 */
export type EmbeddingBackend = 'local' | 'openai' | 'none';

export interface AIConfig {
  /** AI provider. 'none' means AI features are disabled. */
  provider: AIProvider;
  /** OpenAI API key used for cloud LLM calls and OpenAI embeddings. */
  apiKey: string;
  /**
   * Credential sent to the configured LLM endpoint.
   *
   * Local backends never inherit `OPENAI_API_KEY`; they use
   * `SBI_LLM_API_KEY` or a non-secret placeholder instead.
   */
  llmApiKey?: string;
  /** Chat completion model identifier. */
  model: string;
  /**
   * LLM backend to use for chat completions.
   *
   * Defaults to 'openai'. When 'local', the system connects to a local
   * OpenAI-compatible server at `llmUrl`.
   */
  llmBackend: LLMBackend;
  /**
   * Base URL for the LLM API.
   *
   * Defaults to 'https://api.openai.com/v1' for cloud, or the value of
   * SBI_LLM_URL for local backends.
   */
  llmUrl: string;
  /**
   * Maximum tokens of chunk context sent to the LLM per seed investigation.
   *
   * Defaults to 100,000 (~80% of a 128K context window). Reduce for local
   * models with smaller context windows (e.g. 20,000 for 32K models).
   */
  tokenBudget: number;
  /** Text embedding model identifier. */
  embeddingModel: string;
  /**
   * Embedding backend to use.
   *
   * Defaults to 'local' so the system prefers a locally-running embedding
   * service (TEI or Ollama) over the OpenAI API.
   */
  embeddingBackend: EmbeddingBackend;
  /**
   * Base URL for the local embedding service.
   *
   * Used when `embeddingBackend === 'local'`.  Defaults to
   * `http://localhost:8080` (HuggingFace TEI default port).
   */
  embeddingUrl: string;
  /** Whether AI features are active for this run. */
  enabled: boolean;
}

export interface LoadAIConfigOverrides {
  /** When true, disable AI features regardless of environment variables. */
  noAi?: boolean;
  /** Override the AI provider. Accepts `openai` or `none`. */
  aiProvider?: string;
}

function resolveRequestedProvider(aiProvider?: string): AIProvider {
  const normalized = aiProvider?.trim().toLowerCase();

  if (normalized === undefined || normalized === '' || normalized === 'openai') {
    return 'openai';
  }
  if (normalized === 'none') {
    return 'none';
  }
  throw new Error(
    `Invalid AI provider "${aiProvider}". Expected one of: openai, none.`,
  );
}

function resolveLLMBackend(raw: string | undefined): LLMBackend {
  const normalized = raw?.trim().toLowerCase();
  if (normalized === undefined || normalized === '') return 'openai';
  if (normalized === 'local') return 'local';
  if (normalized === 'openai') return 'openai';
  throw new Error(
    `Invalid SBI_LLM_BACKEND "${raw}". Expected one of: openai, local.`,
  );
}

function resolveEmbeddingBackend(raw: string | undefined): EmbeddingBackend {
  const normalized = raw?.trim().toLowerCase();
  if (normalized === undefined || normalized === '') return 'local';
  if (normalized === 'local') return 'local';
  if (normalized === 'openai') return 'openai';
  if (normalized === 'none') return 'none';
  throw new Error(
    `Invalid SBI_EMBEDDING_BACKEND "${raw}". Expected one of: local, openai, none.`,
  );
}

/** Default LLM base URL for OpenAI cloud. */
const OPENAI_DEFAULT_URL = 'https://api.openai.com/v1';

/** Default LLM base URL for local backends (Ollama). */
const LOCAL_LLM_DEFAULT_URL = 'http://localhost:11434/v1';

/**
 * Loads AI configuration from environment variables, applying optional
 * overrides from CLI flags.
 *
 * AI is enabled when:
 *  - `noAi` is NOT set to true, AND
 *  - The requested provider is not `none`, AND
 *  - Either:
 *    - A non-empty `OPENAI_API_KEY` env var is present (cloud mode), OR
 *    - `SBI_LLM_BACKEND=local` is set (local mode uses SBI_LLM_API_KEY or a
 *      non-secret placeholder, since most local servers do not require auth).
 */
export function loadAIConfig(overrides: LoadAIConfigOverrides = {}): AIConfig {
  const { noAi = false, aiProvider } = overrides;

  const apiKey = process.env['OPENAI_API_KEY'] ?? '';
  const model = process.env['SBI_AI_MODEL'] ?? 'gpt-5.6-terra';
  const llmBackend = resolveLLMBackend(process.env['SBI_LLM_BACKEND']);
  const embeddingModel = process.env['SBI_EMBEDDING_MODEL'] ?? 'text-embedding-3-small';
  const embeddingBackend = resolveEmbeddingBackend(process.env['SBI_EMBEDDING_BACKEND']);
  const embeddingUrl = process.env['SBI_EMBEDDING_URL'] ?? 'http://localhost:8080';
  const requestedProvider = resolveRequestedProvider(aiProvider);
  const recorderMode = getRecorderMode();

  // Resolve LLM URL: explicit env var > backend-specific default
  const llmUrlEnv = process.env['SBI_LLM_URL'] ?? '';
  const llmUrl = llmUrlEnv.trim().length > 0
    ? llmUrlEnv.trim()
    : llmBackend === 'local'
      ? LOCAL_LLM_DEFAULT_URL
      : OPENAI_DEFAULT_URL;

  // Token budget: explicit env var > default 100K
  const tokenBudgetEnv = process.env['SBI_TOKEN_BUDGET'];
  const tokenBudget = tokenBudgetEnv != null && tokenBudgetEnv.trim().length > 0
    ? Math.max(1000, parseInt(tokenBudgetEnv, 10) || 100_000)
    : 100_000;

  const hasKey = apiKey.trim().length > 0;

  // Local backends accept any API key (or a dummy key) since local servers
  // typically don't validate authentication. Cloud mode requires a real key.
  const enabled =
    requestedProvider === 'openai' &&
    !noAi &&
    (hasKey || llmBackend === 'local' || recorderMode === 'replay');

  const provider: AIProvider = enabled ? 'openai' : 'none';

  // Keep cloud and local credentials separate. In particular, never forward
  // an ambient OPENAI_API_KEY to an OpenAI-compatible local/LAN endpoint.
  const localLLMApiKey = process.env['SBI_LLM_API_KEY']?.trim();
  const llmApiKey = llmBackend === 'local'
    ? (localLLMApiKey && localLLMApiKey.length > 0 ? localLLMApiKey : 'local')
    : hasKey
      ? apiKey
      : recorderMode === 'replay'
        ? 'replay'
        : '';

  // `apiKey` remains the cloud OpenAI credential because the embedding backend
  // can be OpenAI even when chat completions use a local server.
  const effectiveApiKey = hasKey
    ? apiKey
    : recorderMode === 'replay'
      ? 'replay'
      : '';

  return {
    provider,
    apiKey: effectiveApiKey,
    llmApiKey,
    model,
    llmBackend,
    llmUrl,
    tokenBudget,
    embeddingModel,
    embeddingBackend,
    embeddingUrl,
    enabled,
  };
}

/**
 * Returns true when AI features are active for the given config.
 *
 * Convenience wrapper so callers avoid importing the full config shape just
 * to perform a boolean check.
 */
export function isAIEnabled(config: AIConfig): boolean {
  return config.enabled;
}
