// ---------------------------------------------------------------------------
// AI Configuration
// ---------------------------------------------------------------------------
//
// Reads AI provider settings from environment variables and optional CLI
// overrides. AI is enabled only when a valid API key is present AND the
// caller has not explicitly opted out with --no-ai.
//
// Environment variables:
//   OPENAI_API_KEY      — OpenAI API key (required for AI features)
//   SBI_AI_MODEL        — Chat completion model (default: gpt-4o)
//   SBI_EMBEDDING_MODEL — Embedding model     (default: text-embedding-3-small)

export type AIProvider = 'openai' | 'none';

export interface AIConfig {
  /** AI provider. 'none' means AI features are disabled. */
  provider: AIProvider;
  /** API key for the chosen provider. Empty string when AI is disabled. */
  apiKey: string;
  /** Chat completion model identifier. */
  model: string;
  /** Text embedding model identifier. */
  embeddingModel: string;
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

  if (normalized === 'none') {
    return 'none';
  }

  return 'openai';
}

/**
 * Loads AI configuration from environment variables, applying optional
 * overrides from CLI flags.
 *
 * AI is enabled only when:
 *  - `noAi` is NOT set to true, AND
 *  - The requested provider is not `none`, AND
 *  - A non-empty `OPENAI_API_KEY` environment variable is present.
 */
export function loadAIConfig(overrides: LoadAIConfigOverrides = {}): AIConfig {
  const { noAi = false, aiProvider } = overrides;

  const apiKey = process.env['OPENAI_API_KEY'] ?? '';
  const model = process.env['SBI_AI_MODEL'] ?? 'gpt-4o';
  const embeddingModel = process.env['SBI_EMBEDDING_MODEL'] ?? 'text-embedding-3-small';
  const requestedProvider = resolveRequestedProvider(aiProvider);

  const hasKey = apiKey.trim().length > 0;
  const enabled = requestedProvider === 'openai' && !noAi && hasKey;

  const provider: AIProvider = enabled ? 'openai' : 'none';

  return {
    provider,
    apiKey,
    model,
    embeddingModel,
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
