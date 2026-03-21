// ---------------------------------------------------------------------------
// LLM Client
// ---------------------------------------------------------------------------
//
// Thin wrapper around the OpenAI chat completions API for structured AI
// investigations.
//
// Design principles:
// - Never throws — all API/network/parse errors are caught, logged with
//   console.warn, and returned as empty findings arrays.
// - Uses JSON mode (response_format: { type: 'json_object' }) to ensure
//   the model returns valid JSON that can be parsed and validated.
// - Validates the parsed response through `validateAIFindings` before
//   returning — invalid findings are dropped, not thrown.

import OpenAI from 'openai';
import type { AIConfig } from './config.js';
import type { AIFinding } from './schemas.js';
import { validateAIFindings } from './schemas.js';
import type { HydeLLMClient } from './hyde.js';

// ---------------------------------------------------------------------------
// AIFindingResponse
// ---------------------------------------------------------------------------

/**
 * The response produced by a single LLM investigation call.
 *
 * On API failure, `findings` is empty and `rawResponse` is absent.
 * On JSON parse failure, `findings` is empty and `rawResponse` holds the
 * unparseable string for debugging.
 */
export interface AIFindingResponse {
  /** Validated, sanitised findings. Empty when the call fails or returns nothing useful. */
  findings: AIFinding[];
  /** Raw JSON string returned by the model (present even on validation failure). */
  rawResponse?: string;
}

// ---------------------------------------------------------------------------
// LLMClient
// ---------------------------------------------------------------------------

/**
 * Wraps the OpenAI chat completions API for structured K8s investigation.
 *
 * Implements {@link HydeLLMClient} so it can be passed directly to
 * `generateHypotheticalDocument` without any adapter.
 *
 * Instantiate with a loaded {@link AIConfig} (must have `enabled: true` and a
 * valid `apiKey`). If the config is disabled, callers should not construct
 * this class — use the `isAIEnabled` guard from `config.ts` first.
 *
 * Supports both cloud (OpenAI) and local (Ollama, llama.cpp, vLLM, LM Studio)
 * backends via the `llmUrl` config field. Local backends use an OpenAI-
 * compatible API, so the same client works for both.
 */
export class LLMClient implements HydeLLMClient {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(config: AIConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.llmUrl,
    });
    this.model = config.model;
  }

  /**
   * Generates free-form text given a system and user prompt.
   *
   * Unlike `investigateSeed`, this method does NOT use JSON mode — the model
   * response is returned as a plain string.
   *
   * **Does not swallow errors** — throws on network/API failure so that
   * callers (e.g. `generateHypotheticalDocument`) can detect failure and apply
   * their own fallback logic.
   *
   * @param systemPrompt - System-level context for the generation task.
   * @param userPrompt   - User-facing prompt.
   * @returns Generated text string.  Empty string if the model returns no content.
   */
  async generateText(systemPrompt: string, userPrompt: string): Promise<string> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    });

    return response.choices[0]?.message?.content ?? '';
  }

  /**
   * Calls the LLM with a system + user prompt pair and returns structured
   * findings.
   *
   * Uses `response_format: { type: 'json_object' }` so the model always
   * returns a JSON object. The response is parsed and validated through
   * {@link validateAIFindings} before being returned.
   *
   * **Graceful degradation**: any error (network, API, JSON parse, validation)
   * is caught and logged via `console.warn`. The method always resolves, never
   * rejects.
   *
   * @param systemPrompt - System prompt with grounding rules and playbook.
   * @param userPrompt   - User prompt with hypothesis, chunks, and schema.
   * @returns AIFindingResponse — validated findings + optional raw response.
   */
  async investigateSeed(
    systemPrompt: string,
    userPrompt: string,
  ): Promise<AIFindingResponse> {
    let rawResponse: string | undefined;

    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      });

      rawResponse = response.choices[0]?.message?.content ?? '{}';

      let parsed: unknown;
      try {
        parsed = JSON.parse(rawResponse);
      } catch (parseError) {
        console.warn(
          `[LLMClient] Failed to parse JSON response: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
        );
        return { findings: [], rawResponse };
      }

      // Extract the `findings` array from the parsed JSON object
      const rawFindings =
        parsed !== null &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        'findings' in parsed
          ? (parsed as Record<string, unknown>)['findings']
          : [];

      const findings = validateAIFindings(rawFindings);

      return { findings, rawResponse };
    } catch (error) {
      console.warn(
        `[LLMClient] API call failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { findings: [] };
    }
  }
}
