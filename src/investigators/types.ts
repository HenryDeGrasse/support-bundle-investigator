import type { AnalyzerResult, BundleProfile, K8sEvent, K8sResource } from '../types/index.js';
import type { Finding } from '../types/index.js';
import type { GraphEdge } from '../types/index.js';
import type { LogFile, HelmRelease } from '../parsers/index.js';

// ---------------------------------------------------------------------------
// Seed categories
// ---------------------------------------------------------------------------

/**
 * The kind of investigation that a seed targets.
 *
 * - `kubernetes`    — Pod lifecycle, workload health, events
 * - `log`           — High-importance log files with significant errors
 * - `configuration` — Missing secrets, wrong config values, env mismatches
 * - `connectivity`  — DNS resolution failures, unreachable endpoints, networking
 */
export type SeedCategory = 'kubernetes' | 'log' | 'configuration' | 'connectivity';

// ---------------------------------------------------------------------------
// InvestigationSeed
// ---------------------------------------------------------------------------

/**
 * A single hypothesis to be investigated, generated from parsed bundle data.
 *
 * Seeds are sorted by {@link priority} (highest first) so investigators work
 * on the most actionable leads first.
 */
export interface InvestigationSeed {
  /** Unique identifier within a seed generation run. */
  id: string;
  /** Human-readable description of what to investigate. */
  hypothesis: string;
  /** Identifier of the artifact or rule that produced the seed. */
  source: string;
  /** Which investigator type this seed targets. */
  category: SeedCategory;
  /** Urgency / importance in [0, 100]. Higher = more important. */
  priority: number;
}

// ---------------------------------------------------------------------------
// InvestigatorContext
// ---------------------------------------------------------------------------

/**
 * All parsed bundle data made available to investigators and the seed
 * generator.  Mirrors the data-bearing fields of `PipelineResult` without
 * the graph or trace — those are pipeline-level concerns.
 */
export interface InvestigatorContext {
  analyzerResults: AnalyzerResult[];
  resources: K8sResource[];
  events: K8sEvent[];
  logs: LogFile[];
  profile: BundleProfile;
  /**
   * Maps each parsed K8sResource to the relative source file path it was
   * loaded from (e.g. `cluster-resources/pods/default.json`).  Used by
   * `buildChunkIndex` to set accurate `artifactId` values instead of
   * fabricating a per-resource path.
   *
   * Optional: when absent, `buildChunkIndex` falls back to a constructed path.
   */
  resourceSourceFiles?: Map<K8sResource, string>;
  /**
   * Helm releases parsed from `helm-release` classified files in the bundle.
   *
   * Optional: when absent, no Helm release chunks are produced.
   */
  helmReleases?: HelmRelease[];
}

// ---------------------------------------------------------------------------
// ClusteredSeed
// ---------------------------------------------------------------------------

/**
 * An {@link InvestigationSeed} that has been processed by the AI seed-clustering
 * pass. Extends the base seed with cluster membership metadata so downstream
 * investigators (especially the AI investigator) have full context about all
 * the original seeds collapsed into this representative.
 *
 * ## How clustering works
 *
 * After `generateSeeds()` produces the raw deterministic seed list, an optional
 * LLM clustering pass groups seeds by likely shared root cause.  Within each
 * group, all seeds are collapsed into a single representative `ClusteredSeed`:
 *
 * - **`hypothesis`** — concatenation of all member hypotheses joined by
 *   `'\n\nAlso investigate: '` (the same separator used by `createMergedSeed`
 *   in `ai-investigator.ts`).  This ensures lexical search, HyDE embedding,
 *   and the LLM prompt all cover every member symptom.
 * - **`source`** — the highest-priority member's source (used by graph
 *   retrieval to find the primary resource).  Additional member sources are
 *   accessible via `memberSeeds`.
 * - **`priority`** — re-scored upward when multiple seeds converge (see
 *   `originalPriority` for the pre-cluster value).
 * - **`category`** — inherited from the highest-priority member.
 *
 * Seeds that are not grouped (singleton clusters) are still wrapped as
 * `ClusteredSeed` for type uniformity:
 * - `memberSeeds` = `[self]`
 * - `clusterLabel` = the original `hypothesis`
 * - `originalPriority` = `priority` (unchanged)
 */
export interface ClusteredSeed extends InvestigationSeed {
  /**
   * All original seeds collapsed into this cluster representative, including
   * the representative itself as the first element.
   *
   * Downstream consumers (the AI investigator) need the full seed objects —
   * not just IDs — because `seed.source` is parsed for graph traversal and
   * `seed.hypothesis` is used for lexical search and HyDE embedding.
   *
   * For unclustered (singleton) seeds this is `[self]` — a single-element
   * array containing the seed itself.
   */
  memberSeeds: InvestigationSeed[];

  /**
   * LLM-generated shared root-cause label for the cluster.
   *
   * Example: `'CrashLoopBackOff in namespace default'`.
   *
   * For unclustered seeds this equals the original `hypothesis` string.
   */
  clusterLabel: string;

  /**
   * The seed priority **before** the cluster re-scoring boost was applied.
   *
   * Useful for audit trails and debugging — shows how much the clustering
   * step raised the urgency of this lead.
   *
   * For unclustered seeds `originalPriority === priority`.
   */
  originalPriority: number;
}

// ---------------------------------------------------------------------------
// SeedClusterLLMClient
// ---------------------------------------------------------------------------

/**
 * Minimal LLM client interface required by the seed-clustering pass.
 *
 * Mirrors the {@link HydeLLMClient} pattern from `src/ai/hyde.ts`: only a
 * plain-text generation method is needed — no JSON mode, no schema validation.
 * The real {@link LLMClient} satisfies this interface without any adapter
 * because it already implements `generateText`.
 *
 * Mock implementations for testing only need to provide this single method.
 *
 * @example
 * ```typescript
 * const mockClient: SeedClusterLLMClient = {
 *   generateText: async (_sys, _user) => JSON.stringify({ clusters: [] }),
 * };
 * ```
 */
export interface SeedClusterLLMClient {
  /**
   * Generates free-form text (including JSON) given a system and user prompt.
   *
   * Implementations should throw on network/API failure so that the clustering
   * pass can detect the error, fall back gracefully, and continue with the
   * original unclustered seeds.
   *
   * @param systemPrompt - System-level context for the clustering task.
   * @param userPrompt   - User-facing prompt carrying the serialised seed list.
   * @returns Generated text string (expected to be a JSON object).
   */
  generateText(systemPrompt: string, userPrompt: string): Promise<string>;
}

// ---------------------------------------------------------------------------
// InvestigatorResult
// ---------------------------------------------------------------------------

/**
 * What a targeted investigator produces after examining its seeds.
 *
 * - `findings` — evidence-backed diagnosis entries
 * - `edges`    — new graph relationships discovered during investigation
 */
export interface InvestigatorResult {
  findings: Finding[];
  edges: GraphEdge[];
}
