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
import type {
  InvestigationLLMClient,
  SeedAwareInvestigationLLMClient,
} from '../ai/llm-client.js';
import type { IndexedChunk } from '../ai/chunk-indexer.js';
import type { ResourceRelationshipGraph } from '../graph/resource-graph.js';
import type { LexicalSearchIndex } from '../ai/lexical-search.js';
import type { AIFinding, AIFindingEvidence } from '../ai/schemas.js';
import type { EmbeddingClientInterface } from '../ai/embeddings.js';
import type { VectorStore } from '../ai/vector-store.js';
import type { DiagnosticGraph } from '../graph/diagnostic-graph.js';
import { validateAIFindings } from '../ai/schemas.js';
import { getRelatedChunks } from '../graph/resource-graph.js';
import type { GraphScoredChunk } from '../graph/resource-graph.js';
import { traverseForChunks, RETRIEVAL_EDGE_TYPES, isDiagnosticGraph } from '../graph/traversal.js';
import { buildInvestigationPrompt } from '../ai/prompts.js';
import { estimateTokens } from '../ai/chunk-indexer.js';
import { generateHypotheticalDocument } from '../ai/hyde.js';

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

// ---------------------------------------------------------------------------
// Seed-specific graph traversal parameters
// ---------------------------------------------------------------------------

/**
 * Hard cap on the number of graph nodes returned from traversal, regardless
 * of depth. Prevents breadth explosion in large, well-connected graphs.
 *
 * 30 nodes covers:
 * - 1 starting pod
 * - 5-8 direct deps (secrets, configmaps, events, deployment)
 * - 10-15 depth-2 nodes (sibling pods, remote services)
 * - 5-10 depth-3/4 nodes (remote pod deps)
 */
export const MAX_GRAPH_NODES = 30;

/**
 * Minimum edge weight for graph traversal. Edges below this threshold are
 * not followed. Prunes near-zero temporal-correlation edges (those at the
 * extreme end of the 60-second window) while preserving all structural edges
 * (which default to weight 1.0).
 *
 * At 0.1, a temporal-correlation edge is pruned only when the time delta
 * exceeds ~54 seconds (weight = 1 - 54/60 = 0.1). Everything closer passes.
 */
export const GRAPH_MIN_WEIGHT = 0.1;

/**
 * Returns the optimal graph traversal depth for a seed based on its category.
 *
 * Depth is tuned per category based on the typical K8s graph path length
 * from the seed's starting node to the evidence that explains the failure:
 *
 * | Category | Depth | Reasoning |
 * |---|---|---|
 * | kubernetes | 3 | Pod → deps(1) → Deployment/sibling-pods(2) → sibling-events(3) |
 * | connectivity | 4 | Pod → ConfigMap(1) → remote-Service(2) → remote-Pod(3) → remote-deps(4) |
 * | configuration | 2 | Pod → Secret/ConfigMap(1) → ExternalSecret(2). Direct refs only. |
 * | log | 2 | Pod → deps(1) → owner(2). BM25 handles log-to-evidence correlation. |
 *
 * Returns 3 as a safe default for any unrecognised category.
 */
export function maxDepthForSeed(seed: InvestigationSeed): number {
  switch (seed.category) {
    case 'kubernetes':     return 3;
    case 'connectivity':   return 4;
    case 'configuration':  return 2;
    case 'log':            return 2;
    default:               return 3;
  }
}

/**
 * Number of semantic (vector) search results to retrieve per seed.
 *
 * Semantic hits are appended at lower priority than graph/lexical hits and are
 * capped separately to limit noise contribution to the merged context.
 */
const SEMANTIC_TOP_K = 5;

/**
 * Default token budget for merged context sent to the LLM per seed call.
 *
 * Set to ~80 % of a 128 k-token context window (128 × 1 024 × 0.8 ≈ 104 k).
 * Lower-priority chunks (those ranked later by RRF) fall back to their
 * {@link IndexedChunk.summary} content once the cumulative estimated token
 * count would exceed this limit.
 *
 * Exported so callers can override the budget for testing or for models with
 * different context window sizes.
 */
export const DEFAULT_TOKEN_BUDGET = 100_000;

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
  llmClient: InvestigationLLMClient;
  /** Pre-built flat chunk index from `buildChunkIndex`. */
  chunkIndex: IndexedChunk[];
  /** Pre-built K8s resource relationship graph (backward-compat adapter). */
  resourceGraph: ResourceRelationshipGraph;
  /**
   * Unified DiagnosticGraph with label-selector, service-selector, temporal,
   * and causal edges. When present, graph retrieval uses the richer
   * `traverseForChunks` instead of the legacy `getRelatedChunks` BFS.
   */
  diagnosticGraph?: DiagnosticGraph;
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
  embeddingClient?: EmbeddingClientInterface;
  /**
   * Optional pre-built vector store populated with chunk embeddings.
   *
   * Only consulted when `embeddingClient` is also present. If absent, semantic
   * retrieval is skipped.
   */
  vectorStore?: VectorStore;
  /**
   * Maximum tokens of chunk context sent to the LLM per seed investigation.
   *
   * Defaults to {@link DEFAULT_TOKEN_BUDGET} (~100K). Reduce for local models
   * with smaller context windows (e.g. 20,000 for 32K context models).
   */
  tokenBudget?: number;
  /**
   * When `true`, log per-seed retrieval statistics to stdout.
   *
   * Output format:
   * `[AIInvestigator] Seed: {hypothesis} → {N} graph, {M} lexical, {K} semantic chunks across {T} artifact types`
   */
  verbose?: boolean;
  /**
   * Optional callback invoked before each seed investigation begins.
   * Used by the TUI to show per-seed progress during the AI phase.
   */
  onSeedProgress?: (
    seedIndex: number,
    seedTotal: number,
    seedLabel: string,
  ) => void;
}

// ---------------------------------------------------------------------------
// Shared counter type
// ---------------------------------------------------------------------------

interface Counter {
  value: number;
}

// ---------------------------------------------------------------------------
// DiagnosticGraph seed → node ID resolution
// ---------------------------------------------------------------------------

/**
 * Resolves a seed to one or more starting node IDs in the DiagnosticGraph.
 *
 * Strategy:
 * 1. Parse `Pod/<ns>/<name>` components from the seed source (from seed.id or
 *    hypothesis text) to get concrete K8s node IDs.
 * 2. Fall back to identifier extraction from the hypothesis text: look for
 *    known resource names that appear as graph nodes.
 * 3. If nothing matches, return an empty array (caller falls back to BFS path).
 *
 * Node ID format in DiagnosticGraph: `{Kind}:{namespace}/{name}`
 */
function resolveSeedStartNodes(
  seed: InvestigationSeed,
  graph: DiagnosticGraph,
): string[] {
  const nodeIds: string[] = [];

  // Extract Pod/namespace/name patterns from the seed source or hypothesis
  const combinedText = `${seed.source} ${seed.hypothesis}`;

  // Pattern: Pod/<namespace>/<name> from seed.source (set by seed generator)
  const podPattern = /Pod\/([^/\s]+)\/([^/\s,]+)/g;
  let match: RegExpExecArray | null;
  while ((match = podPattern.exec(combinedText)) !== null) {
    const ns = match[1]!;
    const name = match[2]!;
    const nodeId = `Pod:${ns}/${name}`;
    if (graph.getNode(nodeId) && !nodeIds.includes(nodeId)) nodeIds.push(nodeId);
  }

  // Pattern: extract bare resource names from seed hypothesis that match graph node names
  if (nodeIds.length === 0) {
    const hypothesis = seed.hypothesis.toLowerCase();
    for (const [id, node] of graph.nodes) {
      if (node.nodeType !== 'resource' && node.nodeType !== 'workload-group') continue;
      const data = node.data as { name?: string };
      const name = (data.name ?? '').toLowerCase();
      if (name.length > 2 && hypothesis.includes(name)) {
        if (!nodeIds.includes(id)) nodeIds.push(id);
        if (nodeIds.length >= 3) break; // cap to avoid over-broad traversal
      }
    }
  }

  return nodeIds;
}

function nextFindingId(category: string, counter: Counter): string {
  return `finding:ai:${category}:${counter.value++}`;
}

function nextEdgeId(counter: Counter): string {
  return `edge:ai:${counter.value++}`;
}

// ---------------------------------------------------------------------------
// affectedComponents normalization (7.3)
// ---------------------------------------------------------------------------

/**
 * Kind aliases used when normalizing LLM-generated component strings.
 *
 * Maps every lowercase variant the LLM might produce to the canonical
 * PascalCase Kubernetes Kind name.
 */
const KIND_ALIASES: Record<string, string> = {
  pod: 'Pod',
  deployment: 'Deployment',
  statefulset: 'StatefulSet',
  daemonset: 'DaemonSet',
  replicaset: 'ReplicaSet',
  service: 'Service',
  secret: 'Secret',
  configmap: 'ConfigMap',
  persistentvolumeclaim: 'PersistentVolumeClaim',
  pvc: 'PersistentVolumeClaim',
  job: 'Job',
  cronjob: 'CronJob',
  ingress: 'Ingress',
  namespace: 'Namespace',
  node: 'Node',
};

/**
 * Normalizes a single `affectedComponents` entry from an LLM-generated AI
 * finding to the canonical `Kind/namespace/name` format used throughout the
 * pipeline.
 *
 * Handles the common LLM variant: lowercase kind prefix (e.g.
 * `pod/default/app-pod` → `Pod/default/app-pod`).  Already-correct entries
 * (`Pod/default/app-pod`) are returned unchanged.
 */
function normalizeAffectedComponent(component: string): string {
  const trimmed = component.trim();
  const slashIdx = trimmed.indexOf('/');
  if (slashIdx === -1) return trimmed; // no slash → can't infer Kind, leave as-is

  const rawKind = trimmed.slice(0, slashIdx).toLowerCase();
  const rest    = trimmed.slice(slashIdx + 1);

  const canonical = KIND_ALIASES[rawKind];
  if (canonical === undefined) return trimmed; // unknown kind, leave as-is

  return `${canonical}/${rest}`;
}

// ---------------------------------------------------------------------------
// Grounding score (7.1 + 7.2)
// ---------------------------------------------------------------------------

/** Confidence penalty applied per ungrounded evidence citation. */
export const UNGROUNDED_PENALTY = 0.10;

/**
 * Applies a grounding penalty to a finding's confidence based on how many of
 * its evidence items cite paths that were actually retrieved.
 *
 * Rules:
 * - When `retrievedCount === 0` (nothing was retrieved for this seed) no
 *   grounding check is meaningful — return the confidence unchanged.
 * - When `retrievedCount > 0` and `groundedCount === 0` (the LLM cited ONLY
 *   paths not in the retrieved set), the finding is hallucinatory — return
 *   `null` to signal that the caller should drop it.
 * - Otherwise apply `-UNGROUNDED_PENALTY` per ungrounded citation and clamp
 *   the result to `[0, 1]`.
 *
 * @param confidence     - Raw confidence from the LLM (`[0, 1]`).
 * @param groundedCount  - Number of evidence items that matched a retrieved chunk.
 * @param ungroundedCount- Number of evidence items that did NOT match.
 * @param retrievedCount - Total number of chunks retrieved for this seed.
 * @returns Adjusted confidence, or `null` if the finding should be dropped.
 */
export function applyGroundingPenalty(
  confidence: number,
  groundedCount: number,
  ungroundedCount: number,
  retrievedCount: number,
): number | null {
  // No retrieved chunks → cannot assess grounding, pass through unchanged
  if (retrievedCount === 0) return confidence;

  // All citations ungrounded → hallucinatory finding, drop it
  if (groundedCount === 0) return null;

  // Apply penalty and clamp
  const adjusted = confidence - ungroundedCount * UNGROUNDED_PENALTY;
  return Math.min(1.0, Math.max(0.0, adjusted));
}

// ---------------------------------------------------------------------------
// Chunk merging — Reciprocal Rank Fusion (RRF)
// ---------------------------------------------------------------------------

/**
 * A ranked list of chunks from a single retrieval system.
 *
 * Each entry represents the output of one retrieval system (graph, lexical, or
 * semantic). The `chunks` array must already be sorted in descending relevance
 * order — the position of a chunk in the array determines its rank contribution
 * to the RRF score.
 *
 * An optional parallel `scores` array (same length as `chunks`) may carry the
 * raw retrieval scores (hop-distance, BM25, cosine similarity), but is not used
 * by `mergeChunks` itself — rank within the list is what counts for RRF.
 */
export interface RetrievalList {
  chunks: IndexedChunk[];
  scores?: number[];
}

/**
 * RRF constant `k` — controls how strongly top-ranked chunks are boosted.
 *
 * A value of 60 is the standard from the RRF paper (Cormack et al., 2009).
 * Higher `k` → flatter curve (top ranks matter less); lower → steeper boost.
 */
const RRF_K = 60;

/**
 * Merges multiple ranked chunk lists into a single deduplicated list using
 * Reciprocal Rank Fusion (RRF), then applies a configurable token budget so
 * that the total estimated tokens sent to the LLM stays within model limits.
 *
 * Algorithm:
 * 1. For every chunk in every retrieval list, accumulate an RRF score:
 *    `score += 1 / (k + rank)` where `rank` is 1-based position in the list.
 * 2. Chunks missing from a system contribute nothing from that system (no
 *    penalty — just no boost from that source).
 * 3. Sort by descending RRF score. Ties are broken by chunk ID (lexicographic)
 *    for determinism.
 * 4. Cap the merged list at {@link MAX_CHUNKS_PER_SEED}.
 * 5. **Token budget pass** — iterate the capped list in priority order
 *    (highest RRF score first). Track cumulative estimated tokens via
 *    `estimateTokens(chunk.content)` (≈ `content.length / 4`). When the next
 *    chunk's full content would push the running total above `tokenBudget`,
 *    return a copy of that chunk with `content` replaced by `chunk.summary`
 *    instead. The original chunk object is never mutated.
 *
 * @param retrievalLists - One entry per retrieval system, each containing a
 *   ranked `chunks` array (already sorted best-first).
 * @param tokenBudget - Maximum estimated tokens to include as full content.
 *   Chunks that would exceed this limit fall back to their summary.
 *   Defaults to {@link DEFAULT_TOKEN_BUDGET} (~100 k tokens, ≈ 80% of 128 k).
 * @returns Merged, deduplicated chunk array capped at {@link MAX_CHUNKS_PER_SEED},
 *   with lower-priority chunks switched to summary-only content when the
 *   budget is exceeded.
 */
export function mergeChunks(
  retrievalLists: RetrievalList[],
  tokenBudget = DEFAULT_TOKEN_BUDGET,
): IndexedChunk[] {
  // ── Step 1–4: RRF scoring, dedup, sort, cap ───────────────────────────────

  // Accumulate RRF scores: chunkId → { chunk, rrfScore }
  const scoreMap = new Map<string, { chunk: IndexedChunk; rrfScore: number }>();

  for (const { chunks } of retrievalLists) {
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      const rank = i + 1; // 1-based
      const contribution = 1 / (RRF_K + rank);

      const existing = scoreMap.get(chunk.id);
      if (existing !== undefined) {
        existing.rrfScore += contribution;
      } else {
        scoreMap.set(chunk.id, { chunk, rrfScore: contribution });
      }
    }
  }

  // Sort by descending RRF score; break ties by chunk ID for determinism
  const sorted = [...scoreMap.values()].sort((a, b) => {
    if (b.rrfScore !== a.rrfScore) return b.rrfScore - a.rrfScore;
    return a.chunk.id.localeCompare(b.chunk.id);
  });

  const capped = sorted.slice(0, MAX_CHUNKS_PER_SEED);

  // ── Step 5: Token budget pass ─────────────────────────────────────────────
  // Iterate in priority order (highest RRF first). High-priority chunks get
  // full content; once the cumulative token count would exceed the budget,
  // switch remaining chunks to their summary (cheaper, still informative).

  let usedTokens = 0;
  return capped.map(({ chunk }) => {
    const contentTokens = estimateTokens(chunk.content);
    if (usedTokens + contentTokens <= tokenBudget) {
      usedTokens += contentTokens;
      return chunk; // full content fits — return original (no copy needed)
    }
    // Budget exceeded: return a shallow copy with content replaced by summary.
    // The original chunk object is NOT mutated.
    return { ...chunk, content: chunk.summary };
  });
}

// ---------------------------------------------------------------------------
// Seed deduplication — computeChunkOverlap and deduplicateSeeds
// ---------------------------------------------------------------------------

/**
 * Retrieves the set of chunk IDs that a given seed would retrieve using the
 * graph traversal and lexical search pipelines.
 *
 * Used internally by {@link computeChunkOverlap} to avoid duplicating the
 * retrieval logic between overlap computation and actual investigation.
 *
 * @param seed          - The seed whose chunk set to compute.
 * @param chunkIndex    - Pre-built flat chunk index.
 * @param resourceGraph - Pre-built K8s resource relationship graph.
 * @param lexicalIndex  - Pre-built lexical inverted index.
 * @returns Set of chunk IDs retrieved by graph traversal + lexical search.
 */
function getChunkIdsForSeed(
  seed: InvestigationSeed,
  chunkIndex: IndexedChunk[],
  resourceGraph: ResourceRelationshipGraph,
  lexicalIndex: AIInvestigatorDeps['lexicalIndex'],
): Set<string> {
  const graphScoredChunks = getRelatedChunks(resourceGraph, seed, chunkIndex);
  const lexicalResults = lexicalIndex.search(seed.hypothesis, LEXICAL_TOP_K);

  const ids = new Set<string>();
  for (const { chunk } of graphScoredChunks) {
    ids.add(chunk.id);
  }
  for (const { chunk } of lexicalResults) {
    ids.add(chunk.id);
  }
  return ids;
}

/**
 * Computes the Jaccard similarity of the chunk sets retrieved for two seeds.
 *
 * Both seeds' chunk sets are computed using graph traversal + lexical search
 * (the same retrieval pipeline used in actual investigation). The Jaccard
 * coefficient `|A ∩ B| / |A ∪ B|` measures how much evidence overlap the
 * two seeds share.
 *
 * Returns 0 when both seeds retrieve no chunks (empty ∩ empty).
 *
 * @param seedA         - First investigation seed.
 * @param seedB         - Second investigation seed.
 * @param chunkIndex    - Pre-built flat chunk index.
 * @param resourceGraph - Pre-built K8s resource relationship graph.
 * @param lexicalIndex  - Pre-built lexical inverted index.
 * @returns Jaccard similarity in [0, 1]. 1.0 = identical chunk sets.
 */
export function computeChunkOverlap(
  seedA: InvestigationSeed,
  seedB: InvestigationSeed,
  chunkIndex: IndexedChunk[],
  resourceGraph: ResourceRelationshipGraph,
  lexicalIndex: AIInvestigatorDeps['lexicalIndex'],
): number {
  const setA = getChunkIdsForSeed(seedA, chunkIndex, resourceGraph, lexicalIndex);
  const setB = getChunkIdsForSeed(seedB, chunkIndex, resourceGraph, lexicalIndex);

  // Both empty: no evidence overlap (return 0, not NaN from 0/0)
  if (setA.size === 0 && setB.size === 0) return 0;

  let intersectionCount = 0;
  for (const id of setA) {
    if (setB.has(id)) intersectionCount++;
  }

  const unionCount = setA.size + setB.size - intersectionCount;
  return intersectionCount / unionCount;
}

/**
 * Constructs a merged {@link InvestigationSeed} from two overlapping seeds.
 *
 * The merged seed:
 * - Gets a new `seed:merged:{counter}` id.
 * - Combines both hypotheses so the LLM sees both in a single call.
 * - Inherits category and source from the first (higher-priority) seed.
 * - Uses the maximum priority of the two input seeds.
 *
 * @param seedA    - First seed (expected to be the higher-priority one).
 * @param seedB    - Second seed.
 * @param counter  - Unique counter suffix for the merged seed id.
 * @returns A new merged seed ready for investigation.
 */
function createMergedSeed(
  seedA: InvestigationSeed,
  seedB: InvestigationSeed,
  counter: number,
): InvestigationSeed {
  return {
    id: `seed:merged:${counter}`,
    // Combine both hypotheses so the LLM investigates them in a single call
    hypothesis: `${seedA.hypothesis}\n\nAlso investigate: ${seedB.hypothesis}`,
    source: seedA.source,
    category: seedA.category,
    priority: Math.max(seedA.priority, seedB.priority),
  };
}

/**
 * Deduplicates a list of investigation seeds by merging pairs whose retrieved
 * chunk sets overlap above a similarity threshold.
 *
 * Algorithm (greedy pairwise merge):
 * 1. Scan all `(i, j)` pairs in the current seed list.
 * 2. For the first pair where `computeChunkOverlap > threshold`, replace
 *    both seeds with a single merged seed (containing both hypotheses).
 * 3. Repeat until no pair exceeds the threshold.
 *
 * Seeds with >80% chunk overlap (default) will receive identical context in
 * the LLM prompt, making two separate calls near-redundant. Merging them into
 * a single multi-hypothesis call halves the LLM cost for those seeds without
 * losing diagnostic coverage.
 *
 * The merge is greedy and iterative — it handles transitive overlaps naturally
 * (A∩B>threshold then B∩C>threshold after A+B are merged).
 *
 * @param seeds         - Seeds to deduplicate (order preserved for non-merged seeds).
 * @param chunkIndex    - Pre-built flat chunk index.
 * @param resourceGraph - Pre-built K8s resource relationship graph.
 * @param lexicalIndex  - Pre-built lexical inverted index.
 * @param threshold     - Jaccard similarity threshold above which two seeds are
 *                        merged. Default 0.8 (80%). Comparison is strict: `>`.
 * @returns Deduplicated seed list. Length ≤ input length.
 */
export function deduplicateSeeds(
  seeds: InvestigationSeed[],
  chunkIndex: IndexedChunk[],
  resourceGraph: ResourceRelationshipGraph,
  lexicalIndex: AIInvestigatorDeps['lexicalIndex'],
  threshold = 0.8,
): InvestigationSeed[] {
  if (seeds.length <= 1) return seeds;

  const result = [...seeds];
  let mergeCounter = 0;
  let changed = true;

  while (changed) {
    changed = false;
    // Use labelled break to restart the outer loop after a merge
    outer: for (let i = 0; i < result.length; i++) {
      for (let j = i + 1; j < result.length; j++) {
        const overlap = computeChunkOverlap(
          result[i]!,
          result[j]!,
          chunkIndex,
          resourceGraph,
          lexicalIndex,
        );
        if (overlap > threshold) {
          const merged = createMergedSeed(result[i]!, result[j]!, mergeCounter++);
          result.splice(j, 1); // remove j first (higher index) to preserve i
          result[i] = merged;
          changed = true;
          break outer;
        }
      }
    }
  }

  return result;
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

    // Convert AI evidence items, tracking grounded vs ungrounded citations.
    let groundedCount = 0;
    let ungroundedCount = 0;

    const evidence: Evidence[] = aiF.evidence.map((aiEv) => {
      const matchedChunk = matchChunkForEvidence(aiEv, chunksByPath);
      if (matchedChunk !== undefined) {
        groundedCount++;
      } else {
        ungroundedCount++;
      }
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

    // ── 7.1 + 7.2: Grounding verification & confidence scoring ─────────────
    // When chunks were retrieved for this seed, every citation must trace back
    // to an actually-retrieved chunk.  Fully-ungrounded findings are dropped;
    // partially-ungrounded findings receive a -0.10 per-citation penalty.
    const adjustedConfidence = applyGroundingPenalty(
      aiF.confidence,
      groundedCount,
      ungroundedCount,
      chunkIndex.length,
    );
    if (adjustedConfidence === null) {
      // All citations are hallucinated paths — skip this finding entirely.
      // counter was already incremented by nextFindingId above; no extra step.
      continue;
    }

    // ── 7.3: Normalize affectedComponents to canonical Kind/ns/name format ──
    const normalizedComponents = aiF.affectedComponents.map(normalizeAffectedComponent);

    const finding: Finding = {
      id: findingId,
      title: aiF.title,
      severity: aiF.severity,
      confidence: adjustedConfidence,
      affectedComponents: normalizedComponents,
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
        weight: adjustedConfidence,
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
  const { llmClient, chunkIndex, resourceGraph, diagnosticGraph, lexicalIndex, embeddingClient, vectorStore, tokenBudget: depsTokenBudget, verbose = false, onSeedProgress } = deps;
  const effectiveTokenBudget = depsTokenBudget ?? DEFAULT_TOKEN_BUDGET;

  // Sort seeds by priority descending and cap at maxSeeds
  const prioritisedSeeds = [...seeds]
    .sort((a, b) => b.priority - a.priority)
    .slice(0, maxSeeds);

  // Deduplicate seeds with high chunk overlap to reduce redundant LLM calls.
  // Seeds sharing >80% of their retrieved chunks receive nearly identical context
  // — merging them into a single multi-hypothesis call halves cost without
  // losing diagnostic coverage.
  const deduplicatedSeeds = deduplicateSeeds(
    prioritisedSeeds,
    chunkIndex,
    resourceGraph,
    lexicalIndex,
  );

  const allFindings: Finding[] = [];
  const allEdges: GraphEdge[] = [];
  const counter: Counter = { value: 0 };
  const seedTotal = deduplicatedSeeds.length;
  const retrievalStats = {
    graphChunks: 0,
    lexicalChunks: 0,
    semanticChunks: 0,
    mergedChunks: 0,
  };

  for (let seedIdx = 0; seedIdx < deduplicatedSeeds.length; seedIdx++) {
    const seed = deduplicatedSeeds[seedIdx]!;
    try {
      // Emit per-seed progress for TUI
      onSeedProgress?.(seedIdx + 1, seedTotal, seed.hypothesis);
      // ── Step 1: Graph retrieval (deterministic precision floor) ───────────
      // Use DiagnosticGraph typed traversal when available (label-selector,
      // service-selector, temporal, and causal edges included).
      // Fall back to legacy ResourceRelationshipGraph BFS otherwise.
      let graphChunks: IndexedChunk[];
      let graphScores: number[];

      if (diagnosticGraph !== undefined && isDiagnosticGraph(diagnosticGraph)) {
        // Derive starting node IDs from the seed's affected identifiers
        const startNodeIds = resolveSeedStartNodes(seed, diagnosticGraph);
        const seedDepth = maxDepthForSeed(seed);
        const traversalResults: GraphScoredChunk[] = startNodeIds.flatMap((startId) =>
          traverseForChunks(
            diagnosticGraph,
            {
              start: startId,
              direction: 'both',
              edgeTypes: RETRIEVAL_EDGE_TYPES,
              maxDepth: seedDepth,
              scoreDecay: 0.7,
              minWeight: GRAPH_MIN_WEIGHT,
            },
            chunkIndex,
          ).map((r) => ({ chunk: r.chunk, score: r.score })),
        );
        // Deduplicate by chunk id, keeping highest score
        const bestByChunk = new Map<string, GraphScoredChunk>();
        for (const r of traversalResults) {
          const existing = bestByChunk.get(r.chunk.id);
          if (!existing || r.score > existing.score) bestByChunk.set(r.chunk.id, r);
        }
        // Sort by score and cap at MAX_GRAPH_NODES to prevent breadth explosion
        const sorted = [...bestByChunk.values()]
          .sort((a, b) => b.score - a.score)
          .slice(0, MAX_GRAPH_NODES);
        graphChunks = sorted.map((r) => r.chunk);
        graphScores = sorted.map((r) => r.score);
      } else {
        // Legacy path: BFS over ResourceRelationshipGraph
        const graphScoredChunks: GraphScoredChunk[] = getRelatedChunks(resourceGraph, seed, chunkIndex);
        const graphSorted = graphScoredChunks.sort((a, b) => b.score - a.score);
        graphChunks = graphSorted.map((sc) => sc.chunk);
        graphScores = graphSorted.map((sc) => sc.score);
      }

      // ── Step 2: Lexical retrieval (supplementary evidence) ────────────────
      const lexicalResults = lexicalIndex.search(seed.hypothesis, LEXICAL_TOP_K);
      const lexicalChunks = lexicalResults.map((r) => r.chunk);
      const lexicalScores = lexicalResults.map((r) => r.score);

      // ── Step 2b: Semantic retrieval (expansion layer, lower priority) ─────
      // Uses HyDE: generate a hypothetical evidence document from the seed
      // hypothesis before embedding, so the query vector is closer in semantic
      // space to the real evidence chunks.  Falls back to the raw hypothesis
      // if HyDE generation fails (network error, empty response, etc.).
      let semanticChunks: IndexedChunk[] = [];
      let semanticScores: number[] = [];
      if (embeddingClient !== undefined && vectorStore !== undefined) {
        try {
          // HyDE: embed the hypothetical document instead of the raw hypothesis
          const queryText = await generateHypotheticalDocument(seed.hypothesis, llmClient);
          const queryEmbedding = await embeddingClient.embedSingle(queryText);
          if (queryEmbedding.length > 0) {
            const semanticResults = vectorStore.query(queryEmbedding, SEMANTIC_TOP_K);
            semanticChunks = semanticResults.map((r) => r.chunk);
            semanticScores = semanticResults.map((r) => r.score);
          }
        } catch (semanticError) {
          // Semantic expansion failure is non-fatal — continue with graph + lexical
          console.warn(
            `[AIInvestigator] Semantic retrieval failed for seed '${seed.id}': ` +
              `${semanticError instanceof Error ? semanticError.message : String(semanticError)}`,
          );
        }
      }

      // ── Step 3: Merge & deduplicate via RRF ──────────────────────────────
      const retrievalLists: RetrievalList[] = [
        { chunks: graphChunks, scores: graphScores },
        { chunks: lexicalChunks, scores: lexicalScores },
        { chunks: semanticChunks, scores: semanticScores },
      ];
      const mergedChunks = mergeChunks(retrievalLists, effectiveTokenBudget);

      retrievalStats.graphChunks += graphChunks.length;
      retrievalStats.lexicalChunks += lexicalChunks.length;
      retrievalStats.semanticChunks += semanticChunks.length;
      retrievalStats.mergedChunks += mergedChunks.length;

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
      const seedAwareClient = llmClient as Partial<SeedAwareInvestigationLLMClient>;
      seedAwareClient.setSeedContext?.(seed.id, seed.category);

      let response;
      try {
        response = await llmClient.investigateSeed(system, user);
      } finally {
        seedAwareClient.clearSeedContext?.();
      }

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
    metadata: {
      retrievalStats,
    },
  };
}
