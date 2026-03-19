// ---------------------------------------------------------------------------
// HyDE — Hypothetical Document Embeddings
// ---------------------------------------------------------------------------
//
// Instead of embedding the raw seed hypothesis for vector search, ask the LLM
// to generate what the ideal evidence chunk would look like, then embed that.
//
// The hypothetical document embedding is closer in vector space to the real
// evidence than the question/hypothesis is, because it shares the same
// vocabulary, phrase patterns, and field references as actual chunks.
//
// Example:
//   Hypothesis: "Pod app-pod is in CrashLoopBackOff"
//   HyDE output: "Container app in pod app-pod terminated with exit code 1 due
//     to missing environment variable DB_PASSWORD referenced from secret
//     app-credentials which does not exist in namespace default"
//   → Embed this → retrieve evidence closer in semantic space
//
// Reference: Gao et al. (2022) "Precise Zero-Shot Dense Retrieval without
// Relevance Labels". HyDE eliminates the vocabulary mismatch between a concise
// query and the verbose, structured evidence that supports it.
//
// Graceful degradation: if the LLM call fails or returns an empty string,
// `generateHypotheticalDocument` falls back to returning the raw hypothesis.
// The caller receives a string in either case — no error is surfaced.

// ---------------------------------------------------------------------------
// HydeLLMClient interface
// ---------------------------------------------------------------------------

/**
 * Minimal LLM client interface required by HyDE.
 *
 * Only a plain-text generation method is needed — no JSON mode, no schema
 * validation.  {@link LLMClient} in `llm-client.ts` satisfies this interface
 * after adding its `generateText` method.
 *
 * Mock implementations for testing only need to provide this single method.
 *
 * @example
 * ```typescript
 * const mockClient: HydeLLMClient = {
 *   generateText: async (_sys, _user) => 'Container app terminated with exit code 1',
 * };
 * ```
 */
export interface HydeLLMClient {
  /**
   * Generates free-form text given a system and user prompt.
   *
   * Unlike `investigateSeed`, this method does NOT use JSON mode — it returns
   * the model's natural language response directly.
   *
   * Implementations should throw on network/API failure (rather than
   * swallowing errors) so that `generateHypotheticalDocument` can detect
   * failures and fall back to the raw hypothesis.
   *
   * @param systemPrompt - System-level context for the generation task.
   * @param userPrompt   - User-facing prompt describing the generation task.
   * @returns Generated text string.  May be empty on model refusal/timeout.
   */
  generateText(systemPrompt: string, userPrompt: string): Promise<string>;
}

// ---------------------------------------------------------------------------
// HyDE system prompt
// ---------------------------------------------------------------------------

/**
 * System prompt sent to the LLM for hypothetical document generation.
 *
 * Instructs the model to produce evidence-like text (Kubernetes manifests,
 * log lines, event descriptions) rather than explanatory prose.  The evidence
 * should match the vocabulary and structure of real support bundle chunks so
 * that its embedding is close in vector space to the actual evidence.
 */
export const HYDE_SYSTEM_PROMPT =
  'You are a Kubernetes diagnostic expert. Given a hypothesis about a Kubernetes cluster issue, ' +
  'generate a concise, realistic evidence snippet that would appear in a support bundle if this ' +
  'hypothesis were true. Write only the evidence text — no explanation, no headers, no commentary. ' +
  'Use the same vocabulary as real Kubernetes resource specs, log lines, or event descriptions ' +
  '(field names, status conditions, error messages, container names, namespace names).';

// ---------------------------------------------------------------------------
// generateHypotheticalDocument
// ---------------------------------------------------------------------------

/**
 * Generates a hypothetical evidence document for a seed hypothesis using the
 * HyDE (Hypothetical Document Embeddings) technique.
 *
 * The returned string is intended to be passed to `embeddingClient.embedSingle`
 * **instead of** the raw hypothesis.  Because the hypothetical document
 * shares vocabulary with real evidence chunks, its embedding is closer in
 * vector space to those chunks than the terse hypothesis string would be.
 *
 * **Graceful degradation:** if the LLM call throws or returns an empty string,
 * the raw `hypothesis` is returned unchanged.  The caller can always embed the
 * returned value without additional error handling.
 *
 * @param hypothesis - The seed hypothesis text (e.g. "Pod app-pod is in
 *   CrashLoopBackOff in namespace default").
 * @param llmClient  - An LLM client implementing {@link HydeLLMClient}
 *   (typically the same `LLMClient` used for investigation calls).
 * @returns The hypothetical evidence document, or `hypothesis` if generation
 *   fails or returns an empty string.
 *
 * @example
 * ```typescript
 * const hydeDoc = await generateHypotheticalDocument(seed.hypothesis, llmClient);
 * const embedding = await embeddingClient.embedSingle(hydeDoc);
 * ```
 */
export async function generateHypotheticalDocument(
  hypothesis: string,
  llmClient: HydeLLMClient,
): Promise<string> {
  const userPrompt =
    `Hypothesis: ${hypothesis}\n\n` +
    'Generate a short, realistic evidence snippet (2–6 sentences or equivalent structured text) ' +
    'that would appear in a Kubernetes support bundle if this hypothesis were true:';

  try {
    const generated = await llmClient.generateText(HYDE_SYSTEM_PROMPT, userPrompt);
    const trimmed = generated.trim();
    // Fall back to the raw hypothesis if the LLM returns empty content
    return trimmed.length > 0 ? trimmed : hypothesis;
  } catch {
    // Fall back to the raw hypothesis on any error (network, API, timeout)
    return hypothesis;
  }
}
