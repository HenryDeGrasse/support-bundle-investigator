// ---------------------------------------------------------------------------
// AI Investigator
// ---------------------------------------------------------------------------
//
// Implements an AI-powered investigation flow that augments the heuristic
// pipeline with graph traversal and lexical retrieval.
//
// Design principles:
// - Graph-first: `getRelatedChunks` provides the deterministic precision floor.
// - Lexical expansion: `LexicalSearchIndex.search` adds supplementary evidence.
// - Grounded findings: every AI finding must cite evidence from provided chunks.
// - Graceful degradation: LLM errors are caught and logged; the pipeline
//   continues with remaining seeds rather than aborting.
// - Category-specific playbooks: each seed's category routes to the right
//   investigation playbook via `buildInvestigationPrompt`.

import type { Finding, Evidence, GraphEdge } from '../types/index.js';
import type { InvestigatorContext, InvestigatorResult, InvestigationSeed } from './types.js';
import type { LLMClient } from '../ai/llm-client.js';
import type { IndexedChunk } from '../ai/chunk-indexer.js';
import type { ResourceRelationshipGraph } from '../graph/resource-graph.js';
import type { LexicalSearchIndex } from '../ai/lexical-search.js';
import type { AIFinding, AIFindingEvidence } from '../ai/schemas.js';
import type { EmbeddingClient } from '../ai/embeddings.js';
import type { VectorStore } from '../ai/vector-store.js';
import { validateAIFindings } from '../ai/schemas.js';
import { getRelatedChunks } from '../graph/resource-graph.js';
import { buildInvestigationPrompt } from '../ai/prompts.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of seeds to investigate per AI invocation (configurable). */
export const DEFAULT_MAX_SEEDS = 10;

/**
 * Maximum number of chunks sent to the LLM per seed call.
 *
 * Graph hits are included first (highest precision), then lexical hits fill
 * the remaining slots. Capped to keep the context window manageable.
 */
const MAX_CHUNKS_PER_SEED = 20;

/** Number of lexical search results to retrieve per seed. */
const LEXICAL_TOP_K = 10;

/**
 * Number of semantic (vector) search results to retrieve per seed.
 *
 * Semantic hits are appended at lower priority than graph/lexical hits and are
 * capped separately to limit noise contribution to the merged context.
 */
const SEMANTIC_TOP_K = 5;

// ---------------------------------------------------------------------------
// AIInvestigatorDeps
// ---------------------------------------------------------------------------

/**
 * External dependencies required by the AI investigator.
 *
 * The four required deps (llmClient, chunkIndex, resourceGraph, lexicalIndex)
 * form the deterministic precision floor. The two optional deps
 * (embeddingClient, vectorStore) add semantic expansion — if absent,
 * investigation proceeds with graph + lexical results only.
 */
export interface AIInvestigatorDeps {
  /** LLM client for structured investigation calls. */
  llmClient: LLMClient;
  /** Pre-built flat chunk index from `buildChunkIndex`. */
  chunkIndex: IndexedChunk[];
  /** Pre-built K8s resource relationship graph from `buildResourceGraph`. */
  resourceGraph: ResourceRelationshipGraph;
  /** Pre-built lexical inverted index from `LexicalSearchIndex.build`. */
  lexicalIndex: LexicalSearchIndex;
  /**
   * Optional embedding client for semantic query expansion.
   *
   * When present, the seed hypothesis is embedded and the resulting vector is
   * used to retrieve semantically similar chunks from `vectorStore`. Semantic
   * hits are appended at lower priority than graph and lexical hits.
   *
   * If absent (or if embedding fails), investigation continues without semantic
   * expansion.
   */
  embeddingClient?: EmbeddingClient;
  /**
   * Optional pre-built vector store populated with chunk embeddings.
   *
   * Only consulted when `embeddingClient` is also present. If absent, semantic
   * retrieval is skipped.
   */
  vectorStore?: VectorStore;
  /**
   * When `true`, log per-seed retrieval statistics to stdout.
   *
   * Output format:
   * `[AIInvestigator] Seed: {hypothesis} → {N} graph, {M} lexical, {K} semantic chunks across {T} artifact types`
   */
  verbose?: boolean;
}

// ---------------------------------------------------------------------------
// Shared counter type
// ---------------------------------------------------------------------------

interface Counter {
  value: number;
}

function nextFindingId(category: string, counter: Counter): string {
  return `finding:ai:${category}:${counter.value++}`;
}

function nextEdgeId(counter: Counter): string {
  return `edge:ai:${counter.value++}`;
}

// ---------------------------------------------------------------------------
// Chunk merging (graph-first, deduplicated)
// ---------------------------------------------------------------------------

/**
 * Merges graph neighborhood, lexical search, and semantic search chunks into a
 * single deduplicated array.
 *
 * Priority order (highest → lowest):
 * 1. **Graph chunks** — deterministic, 100% precision floor. Always included first.
 * 2. **Lexical chunks** — exact identifier matching. Appended in score order.
 * 3. **Semantic chunks** — cosine-similarity expansion. Appended last, skipping
 *    any already present from graph/lexical retrieval.
 *
 * Total is capped at {@link MAX_CHUNKS_PER_SEED}.
 */
function mergeChunks(
  graphChunks: IndexedChunk[],
  lexicalChunks: IndexedChunk[],
  semanticChunks: IndexedChunk[] = [],
): IndexedChunk[] {
  const seen = new Set<string>();
  const merged: IndexedChunk[] = [];

  for (const chunk of graphChunks) {
    if (!seen.has(chunk.id) && merged.length < MAX_CHUNKS_PER_SEED) {
      seen.add(chunk.id);
      merged.push(chunk);
    }
  }

  for (const chunk of lexicalChunks) {
    if (!seen.has(chunk.id) && merged.length < MAX_CHUNKS_PER_SEED) {
      seen.add(chunk.id);
      merged.push(chunk);
    }
  }

  for (const chunk of semanticChunks) {
    if (!seen.has(chunk.id) && merged.length < MAX_CHUNKS_PER_SEED) {
      seen.add(chunk.id);
      merged.push(chunk);
    }
  }

  return merged;
}

// ---------------------------------------------------------------------------
// convertAIFindings
// ---------------------------------------------------------------------------

/**
 * Chooses the best indexed chunk to enrich an AI evidence citation.
 *
 * Multiple chunks can share the same `artifactId` (most commonly log files).
 * When the LLM provides a `lineRange`, prefer the chunk that fully contains
 * that range; otherwise fall back to the earliest deterministic chunk for the
 * path. This lets downstream reporting preserve the most relevant
 * artifact-level metadata (artifact type, timestamp) without changing the
 * existing `Evidence` structure.
 */
function matchChunkForEvidence(
  evidence: AIFindingEvidence,
  chunksByPath: ReadonlyMap<string, IndexedChunk[]>,
): IndexedChunk | undefined {
  const candidates = chunksByPath.get(evidence.path);
  if (candidates === undefined || candidates.length === 0) {
    return undefined;
  }

  if (evidence.lineRange !== undefined) {
    const [start, end] = evidence.lineRange;

    const containingChunk = candidates.find(
      (chunk) => chunk.startLine <= start && chunk.endLine >= end,
    );
    if (containingChunk !== undefined) {
      return containingChunk;
    }

    const overlappingChunk = candidates.find(
      (chunk) => chunk.endLine >= start && chunk.startLine <= end,
    );
    if (overlappingChunk !== undefined) {
      return overlappingChunk;
    }
  }

  return [...candidates].sort((a, b) => {
    if (a.startLine !== b.startLine) return a.startLine - b.startLine;
    return a.id.localeCompare(b.id);
  })[0];
}

/**
 * Converts {@link AIFinding}[] from the LLM response into the canonical
 * {@link Finding}[] type used throughout the pipeline.
 *
 * Mapping:
 * - `id`: generated as `finding:ai:{category}:{counter}`
 * - `evidence`: `AIFindingEvidence` → `Evidence` (preserves `path`, `note`,
 *   and enriches from the matched chunk with `artifactType`/`timestamp` when
 *   available).
 * - `GraphEdge[]`: one `supports` edge per evidence item, source =
 *   `evidence:{path}`, target = finding id.
 *
 * @param aiFindings - Validated AI findings from `validateAIFindings`.
 * @param seed       - The seed that produced these findings (for id prefix).
 * @param counter    - Shared mutable counter for unique id generation.
 * @param chunkIndex - The indexed chunks used in this investigation call,
 *                     used to fill in evidence metadata from chunk citations.
 * @returns `{ findings, edges }`
 */
function convertAIFindings(
  aiFindings: AIFinding[],
  seed: InvestigationSeed,
  counter: Counter,
  chunkIndex: IndexedChunk[],
): { findings: Finding[]; edges: GraphEdge[] } {
  const findings: Finding[] = [];
  const edges: GraphEdge[] = [];

  // Build a path → chunks map so evidence with line ranges can resolve to the
  // most specific chunk when multiple chunks share the same file path.
  const chunksByPath = new Map<string, IndexedChunk[]>();
  for (const chunk of chunkIndex) {
    const existing = chunksByPath.get(chunk.artifactId) ?? [];
    existing.push(chunk);
    chunksByPath.set(chunk.artifactId, existing);
  }

  for (const aiF of aiFindings) {
    const findingId = nextFindingId(seed.category, counter);

    // Convert AI evidence items to the canonical Evidence type
    const evidence: Evidence[] = aiF.evidence.map((aiEv) => {
      const matchedChunk = matchChunkForEvidence(aiEv, chunksByPath);
      const ev: Evidence = {
        path: aiEv.path,
        note: aiEv.note,
      };
      if (matchedChunk?.artifactCategory !== undefined) {
        ev.artifactType = matchedChunk.artifactCategory;
      }
      if (matchedChunk?.timestamp !== undefined) {
        ev.timestamp = matchedChunk.timestamp;
      }
      return ev;
    });

    const finding: Finding = {
      id: findingId,
      title: aiF.title,
      severity: aiF.severity,
      confidence: aiF.confidence,
      affectedComponents: aiF.affectedComponents,
      reasoningSummary: aiF.reasoningSummary,
      evidence,
      contradictionsChecked: aiF.contradictionsChecked,
      recommendedAction: aiF.recommendedAction,
      missingEvidence: aiF.missingEvidence,
    };

    findings.push(finding);

    // Create graph edges linking each evidence source to this finding
    for (const ev of evidence) {
      edges.push({
        id: nextEdgeId(counter),
        source: `evidence:${ev.path}`,
        target: findingId,
        type: 'supports',
        weight: aiF.confidence,
      });
    }
  }

  return { findings, edges };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Runs AI-powered investigation for each seed using graph traversal and
 * lexical retrieval to assemble grounded context for the LLM.
 *
 * Investigation flow for each seed:
 * 1. **Graph retrieval** — `getRelatedChunks(resourceGraph, seed, chunkIndex)`
 *    collects the resource neighborhood (100% precision floor).
 * 2. **Lexical retrieval** — `lexicalIndex.search(seed.hypothesis, topK=10)`
 *    finds chunks with matching identifiers for supplementary evidence.
 * 3. **Merge & dedup** — graph chunks first, then lexical, capped at 20.
 * 4. **Prompt construction** — `buildInvestigationPrompt(seed, mergedChunks)`
 *    selects the category-specific playbook and assembles system + user prompts.
 * 5. **LLM call** — `llmClient.investigateSeed(system, user)` with graceful
 *    degradation on failure (error logged, seed skipped).
 * 6. **Conversion** — `convertAIFindings` maps `AIFinding[]` to `Finding[]`
 *    and produces `GraphEdge[]` linking evidence to findings.
 *
 * Seeds are processed up to `maxSeeds` (default {@link DEFAULT_MAX_SEEDS}).
 * Seeds are sorted by priority descending before truncation.
 *
 * @param _context  - Bundle context (available for future use by extensions).
 * @param seeds     - Investigation seeds from `generateSeeds`.
 * @param deps      - Injected AI dependencies.
 * @param maxSeeds  - Maximum number of seeds to investigate (default 10).
 * @returns `InvestigatorResult` with AI-produced findings and graph edges.
 */
export async function investigateWithAI(
  _context: InvestigatorContext,
  seeds: InvestigationSeed[],
  deps: AIInvestigatorDeps,
  maxSeeds = DEFAULT_MAX_SEEDS,
): Promise<InvestigatorResult> {
  const { llmClient, chunkIndex, resourceGraph, lexicalIndex, embeddingClient, vectorStore, verbose = false } = deps;

  // Sort seeds by priority descending and cap at maxSeeds
  const prioritisedSeeds = [...seeds]
    .sort((a, b) => b.priority - a.priority)
    .slice(0, maxSeeds);

  const allFindings: Finding[] = [];
  const allEdges: GraphEdge[] = [];
  const counter: Counter = { value: 0 };

  for (const seed of prioritisedSeeds) {
    try {
      // ── Step 1: Graph retrieval (deterministic precision floor) ───────────
      const graphChunks = getRelatedChunks(resourceGraph, seed, chunkIndex);

      // ── Step 2: Lexical retrieval (supplementary evidence) ────────────────
      const lexicalResults = lexicalIndex.search(seed.hypothesis, LEXICAL_TOP_K);
      const lexicalChunks = lexicalResults.map((r) => r.chunk);

      // ── Step 2b: Semantic retrieval (expansion layer, lower priority) ─────
      let semanticChunks: IndexedChunk[] = [];
      if (embeddingClient !== undefined && vectorStore !== undefined) {
        try {
          const queryEmbedding = await embeddingClient.embedSingle(seed.hypothesis);
          if (queryEmbedding.length > 0) {
            const semanticResults = vectorStore.query(queryEmbedding, SEMANTIC_TOP_K);
            semanticChunks = semanticResults.map((r) => r.chunk);
          }
        } catch (semanticError) {
          // Semantic expansion failure is non-fatal — continue with graph + lexical
          console.warn(
            `[AIInvestigator] Semantic retrieval failed for seed '${seed.id}': ` +
              `${semanticError instanceof Error ? semanticError.message : String(semanticError)}`,
          );
        }
      }

      // ── Step 3: Merge & deduplicate ───────────────────────────────────────
      const mergedChunks = mergeChunks(graphChunks, lexicalChunks, semanticChunks);

      // ── Verbose retrieval stats ───────────────────────────────────────────
      if (verbose) {
        const artifactTypes = new Set<string>(
          mergedChunks.map((c) => c.artifactCategory as string),
        );
        console.log(
          `[AIInvestigator] Seed: ${seed.hypothesis} → ` +
            `${graphChunks.length} graph chunks, ${lexicalChunks.length} lexical chunks, ` +
            `${semanticChunks.length} semantic chunks across ${artifactTypes.size} artifact types`,
        );
      }

      // ── Step 4 + 5: Build prompt and call LLM ─────────────────────────────
      const { system, user } = buildInvestigationPrompt(seed, mergedChunks);
      const response = await llmClient.investigateSeed(system, user);
      const validatedFindings = validateAIFindings(response.findings);

      // ── Step 6: Convert and accumulate ────────────────────────────────────
      const { findings, edges } = convertAIFindings(
        validatedFindings,
        seed,
        counter,
        mergedChunks,
      );

      allFindings.push(...findings);
      allEdges.push(...edges);
    } catch (error) {
      // Graceful degradation: log and continue with remaining seeds
      console.warn(
        `[AIInvestigator] Failed to investigate seed '${seed.id}' (${seed.category}): ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return {
    findings: allFindings,
    edges: allEdges,
  };
}
