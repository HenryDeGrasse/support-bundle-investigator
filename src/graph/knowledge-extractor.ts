// ---------------------------------------------------------------------------
// Knowledge Extractor — LLM triple extraction for GraphRAG (4.5 part 1)
// ---------------------------------------------------------------------------
//
// Extracts structured (subject, relationship, object) triples from chunk text
// using an LLM.  These triples create edges in the unified DiagnosticGraph that
// the deterministic K8s spec parser cannot discover, such as:
//
//   ConfigMap:app-config ─configured-with─► Hostname:db.internal
//   Pod:app-pod ─connects-to─► Hostname:db.internal  (from log content)
//   Secret:registry-creds ─authenticates-with─► Image:myapp:v999
//
// The extractor is designed for graceful degradation: any LLM failure, parse
// error, or malformed response results in an empty triple list rather than an
// exception. Graph and BM25 retrieval continue to work even when triple
// extraction is unavailable.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Recognised entity types for triple extraction.
 *
 * The LLM is instructed to use these as prefixes in `source` and `target`
 * fields (e.g. `"Pod:app-pod"`, `"Hostname:db.internal"`).
 */
export const ENTITY_TYPES: readonly string[] = [
  'Pod',
  'Deployment',
  'Service',
  'Secret',
  'ConfigMap',
  'PVC',
  'Hostname',
  'Image',
  'Error',
  'LogEntry',
] as const;

/**
 * Recognised relationship types for triple extraction.
 *
 * These map to the most semantically meaningful edges for diagnostic graph
 * traversal.  Unknown relationships returned by the LLM are passed through
 * without filtering — they are preserved as-is in the returned triples.
 */
export const RELATIONSHIP_TYPES: readonly string[] = [
  'connects-to',
  'configured-with',
  'fails-because',
  'authenticates-with',
  'resolves-to',
  'exposes',
] as const;

// ---------------------------------------------------------------------------
// KnowledgeLLMClient interface
// ---------------------------------------------------------------------------

/**
 * Minimal LLM client interface required by the knowledge extractor.
 *
 * Only plain-text generation is needed — no JSON mode, no structured schema
 * validation.  {@link HydeLLMClient} (from `ai/hyde.ts`) satisfies this
 * interface, so the same `LLMClient` instance can be passed for both HyDE
 * and knowledge extraction.
 *
 * Mock implementations for testing need only provide `generateText`.
 *
 * @example
 * ```typescript
 * const mockClient: KnowledgeLLMClient = {
 *   generateText: async (_sys, _user) => '{"triples": []}',
 * };
 * ```
 */
export interface KnowledgeLLMClient {
  /**
   * Generates free-form text given a system and user prompt.
   *
   * Should throw on network/API failure (rather than swallowing errors) so
   * that `extractTriples` can detect failures and fall back gracefully.
   */
  generateText(systemPrompt: string, userPrompt: string): Promise<string>;
}

// ---------------------------------------------------------------------------
// KnowledgeTriple
// ---------------------------------------------------------------------------

/**
 * A single extracted knowledge triple.
 *
 * Both `source` and `target` use an `EntityType:name` format where possible
 * (e.g. `"Pod:app-pod"`, `"Hostname:db.internal"`).  The `relationship` is
 * one of {@link RELATIONSHIP_TYPES} or an LLM-generated string.
 */
export interface KnowledgeTriple {
  /** Source entity (e.g. `"Pod:app-pod"`, `"ConfigMap:app-config"`). */
  source: string;
  /** Relationship type (e.g. `"connects-to"`, `"configured-with"`). */
  relationship: string;
  /** Target entity (e.g. `"Hostname:db.internal"`, `"Image:myapp:v1"`). */
  target: string;
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const EXTRACTION_SYSTEM_PROMPT =
  'You are a Kubernetes diagnostic expert. ' +
  'Given a chunk of Kubernetes support bundle evidence (logs, resource specs, events, or analyzer output), ' +
  'extract all meaningful entities and the relationships between them. ' +
  '\n\n' +
  'Return ONLY valid JSON in this exact format:\n' +
  '{ "triples": [{"source": "...", "relationship": "...", "target": "..."}, ...] }\n' +
  '\n' +
  'Entity types to recognise (use as prefix, e.g. "Pod:app-pod"):\n' +
  ENTITY_TYPES.join(', ') +
  '\n\n' +
  'Relationship types to use:\n' +
  RELATIONSHIP_TYPES.join(', ') +
  '\n\n' +
  'Rules:\n' +
  '- Only extract relationships that are explicitly stated or strongly implied.\n' +
  '- Use the EntityType:name format for source and target where the type is known.\n' +
  '- If no relationships are found, return { "triples": [] }.\n' +
  '- Do NOT include explanation, headers, or any text outside the JSON object.';

function buildUserPrompt(chunkContent: string): string {
  return (
    'Extract entities and relationships from this Kubernetes support bundle evidence:\n\n' +
    '---\n' +
    chunkContent +
    '\n---'
  );
}

// ---------------------------------------------------------------------------
// JSON parsing helpers
// ---------------------------------------------------------------------------

/**
 * Attempts to extract a JSON object from a string that may be wrapped in
 * markdown code blocks (```json ... ```).
 */
function unwrapMarkdownJson(text: string): string {
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch?.[1]) {
    return codeBlockMatch[1].trim();
  }
  return text.trim();
}

/**
 * Returns `true` when the object has all three required triple fields as
 * non-empty strings.
 */
function isValidTriple(obj: unknown): obj is KnowledgeTriple {
  if (typeof obj !== 'object' || obj === null) return false;
  const t = obj as Record<string, unknown>;
  return (
    typeof t['source'] === 'string' &&
    t['source'].length > 0 &&
    typeof t['relationship'] === 'string' &&
    t['relationship'].length > 0 &&
    typeof t['target'] === 'string' &&
    t['target'].length > 0
  );
}

/**
 * Parses the LLM response string into an array of valid
 * {@link KnowledgeTriple}s.
 *
 * Handles:
 * - Markdown code block wrapping (`\`\`\`json ... \`\`\``)
 * - Missing or non-array `triples` field
 * - Individual triples with missing fields (filtered out)
 *
 * Returns an empty array on any parse error.
 */
function parseTriples(response: string): KnowledgeTriple[] {
  if (!response || response.trim().length === 0) return [];

  try {
    const jsonStr = unwrapMarkdownJson(response);
    const parsed: unknown = JSON.parse(jsonStr);

    if (typeof parsed !== 'object' || parsed === null) return [];

    const parsed_ = parsed as Record<string, unknown>;
    const triples = parsed_['triples'];

    if (!Array.isArray(triples)) return [];

    return triples.filter(isValidTriple);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

/**
 * Returns a unique key for a triple for deduplication purposes.
 */
function tripleKey(t: KnowledgeTriple): string {
  return `${t.source}|${t.relationship}|${t.target}`;
}

/**
 * Deduplicates an array of triples, keeping the first occurrence of each
 * unique (source, relationship, target) combination.
 */
function deduplicateTriples(triples: KnowledgeTriple[]): KnowledgeTriple[] {
  const seen = new Set<string>();
  const result: KnowledgeTriple[] = [];
  for (const t of triples) {
    const key = tripleKey(t);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(t);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// extractTriples — public API
// ---------------------------------------------------------------------------

/**
 * Extracts structured knowledge triples from a chunk of support bundle text
 * using an LLM.
 *
 * Returns an array of deduplicated {@link KnowledgeTriple}s discovered in the
 * chunk content.  These triples can be added as edges to the
 * {@link DiagnosticGraph} to enrich traversal with semantically-extracted
 * relationships that the deterministic K8s spec parser cannot discover.
 *
 * **Graceful degradation:** any LLM error, network failure, malformed JSON, or
 * missing fields results in an empty array rather than a thrown exception.
 * Callers do not need to handle errors from this function.
 *
 * @param chunkContent - The raw text content of the chunk to analyse.
 *   May be log lines, a K8s resource spec, an event description, or any
 *   other support bundle artifact.
 * @param llmClient    - A client implementing {@link KnowledgeLLMClient}.
 *   Typically the same `LLMClient` used for investigation and HyDE calls.
 * @returns Deduplicated array of extracted triples, possibly empty.
 *
 * @example
 * ```typescript
 * const triples = await extractTriples(chunk.content, llmClient);
 * for (const triple of triples) {
 *   graph.addEdge({
 *     id: `semantic:${triple.source}:${triple.relationship}:${triple.target}`,
 *     source: triple.source,
 *     target: triple.target,
 *     type: 'correlates',
 *     weight: 0.6,
 *   });
 * }
 * ```
 */
export async function extractTriples(
  chunkContent: string,
  llmClient: KnowledgeLLMClient,
): Promise<KnowledgeTriple[]> {
  if (!chunkContent || chunkContent.trim().length === 0) {
    return [];
  }

  try {
    const userPrompt = buildUserPrompt(chunkContent);
    const response = await llmClient.generateText(
      EXTRACTION_SYSTEM_PROMPT,
      userPrompt,
    );
    const triples = parseTriples(response);
    return deduplicateTriples(triples);
  } catch {
    // Graceful degradation: any error (network, API, timeout) returns empty
    return [];
  }
}
