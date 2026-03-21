// ---------------------------------------------------------------------------
// Seed Clusterer
// ---------------------------------------------------------------------------
//
// Provides a pre-investigation AI seed-clustering pass that groups raw
// deterministic seeds by likely shared root cause using a single LLM call.
//
// Public API:
//   clusterSeeds        — async; groups seeds via LLM, falls back gracefully
//   toUnclusteredSeeds  — sync; identity mapping (used when AI is disabled)
//
// Design principles:
// - Additive: deterministic seed generation is never modified.
// - Graceful degradation: any LLM error or parse/validation failure falls back
//   to `toUnclusteredSeeds()`, producing identical output to the no-AI path.
// - Threshold: seeds.length < 3 → skip LLM entirely (clustering overhead
//   unjustified for trivial seed lists).
// - Re-scoring: each additional converging seed adds +5 priority, capped at 100.

import type { InvestigationSeed, ClusteredSeed, SeedClusterLLMClient } from './types.js';
import { buildSeedClusteringPrompt } from '../ai/prompts.js';

// ---------------------------------------------------------------------------
// Minimum seed count for clustering
// ---------------------------------------------------------------------------

/**
 * Minimum number of seeds required to attempt LLM clustering.
 *
 * Fewer than this many seeds makes clustering overhead unjustified — each
 * seed is simply wrapped as a singleton `ClusteredSeed` via
 * `toUnclusteredSeeds`.
 */
export const CLUSTER_MIN_SEEDS = 3;

/**
 * Priority boost applied per additional converging seed in a cluster.
 *
 * Formula: `Math.min(originalPriority + CLUSTER_PRIORITY_BOOST * (clusterSize - 1), 100)`
 */
export const CLUSTER_PRIORITY_BOOST = 5;

// ---------------------------------------------------------------------------
// LLM response schema (internal)
// ---------------------------------------------------------------------------

interface LLMCluster {
  label: string;
  reasoning: string;
  seedIds: string[];
  representativeSeedId: string;
}

interface LLMClusterResponse {
  clusters: LLMCluster[];
}

// ---------------------------------------------------------------------------
// toUnclusteredSeeds (sync, exported)
// ---------------------------------------------------------------------------

/**
 * Maps each seed to a singleton {@link ClusteredSeed} with no clustering
 * applied.
 *
 * Used when:
 * - AI is disabled (`--no-ai` flag → `llmClient` is `undefined`).
 * - The seed count is below {@link CLUSTER_MIN_SEEDS}.
 * - The LLM call fails or returns an invalid response.
 *
 * Each returned `ClusteredSeed` satisfies:
 * - `memberSeeds = [seed]`
 * - `clusterLabel = seed.hypothesis`
 * - `originalPriority = seed.priority`
 * - `priority = seed.priority` (unchanged — no boost for singletons)
 * - `hypothesis`, `source`, `category` = unchanged from the input seed
 *
 * The return value is sorted by priority descending (matching the
 * `generateSeeds` sort contract).
 *
 * @param seeds - Raw deterministic seeds from `generateSeeds()`.
 * @returns One singleton `ClusteredSeed` per input seed, sorted by priority descending.
 */
export function toUnclusteredSeeds(seeds: InvestigationSeed[]): ClusteredSeed[] {
  return seeds
    .map((seed): ClusteredSeed => ({
      ...seed,
      memberSeeds: [seed],
      clusterLabel: seed.hypothesis,
      originalPriority: seed.priority,
    }))
    .sort((a, b) => b.priority - a.priority);
}

// ---------------------------------------------------------------------------
// Validation helpers (internal)
// ---------------------------------------------------------------------------

/**
 * Type guard: checks that the parsed JSON value roughly matches
 * {@link LLMClusterResponse}.
 */
function isLLMClusterResponse(value: unknown): value is LLMClusterResponse {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (!Array.isArray(obj['clusters'])) return false;
  return true;
}

/**
 * Validates the LLM cluster response against the input seed list.
 *
 * Checks:
 * 1. Every cluster has a non-empty `seedIds` array.
 * 2. Every seed ID in the input appears in exactly one cluster.
 * 3. `representativeSeedId` is a member of its cluster's `seedIds`.
 * 4. No unknown seed IDs appear in any cluster.
 *
 * @param response   - Parsed LLM response.
 * @param inputSeeds - Original seed list used to generate the prompt.
 * @returns `true` if the response is valid, `false` otherwise.
 */
function validateClusterResponse(
  response: LLMClusterResponse,
  inputSeeds: InvestigationSeed[],
): boolean {
  const inputIds = new Set(inputSeeds.map((s) => s.id));
  const seenIds = new Set<string>();

  for (const cluster of response.clusters) {
    // Each cluster must have a non-empty seedIds array
    if (!Array.isArray(cluster.seedIds) || cluster.seedIds.length === 0) return false;

    // representativeSeedId must be a member of seedIds
    if (!cluster.seedIds.includes(cluster.representativeSeedId)) return false;

    for (const id of cluster.seedIds) {
      // No unknown seed IDs
      if (!inputIds.has(id)) return false;
      // No duplicate seed IDs across clusters
      if (seenIds.has(id)) return false;
      seenIds.add(id);
    }
  }

  // Every input seed must appear in exactly one cluster
  for (const id of inputIds) {
    if (!seenIds.has(id)) return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// buildClusteredSeed (internal)
// ---------------------------------------------------------------------------

/**
 * Constructs a {@link ClusteredSeed} from a validated LLM cluster.
 *
 * The representative seed is the highest-priority member (as required by the
 * LLM prompt grounding rules). Hypothesis text is built by joining all member
 * hypotheses with `'\n\nAlso investigate: '` — the same separator used by
 * `createMergedSeed` in `ai-investigator.ts` so that lexical search, HyDE
 * embedding, and the LLM investigation prompt all cover every member symptom.
 *
 * Priority is re-scored upward:
 * `Math.min(originalPriority + CLUSTER_PRIORITY_BOOST * (clusterSize - 1), 100)`
 *
 * @param cluster        - Validated LLM cluster object.
 * @param seedById       - Map from seed ID → seed for O(1) lookups.
 * @returns A `ClusteredSeed` representing all members of this cluster.
 */
function buildClusteredSeed(
  cluster: LLMCluster,
  seedById: Map<string, InvestigationSeed>,
): ClusteredSeed {
  const representative = seedById.get(cluster.representativeSeedId)!;

  // Collect all member seeds (representative first, then the rest)
  const otherMembers = cluster.seedIds
    .filter((id) => id !== cluster.representativeSeedId)
    .map((id) => seedById.get(id)!);

  const memberSeeds: InvestigationSeed[] = [representative, ...otherMembers];

  // Build combined hypothesis: representative first, others appended
  const hypothesis =
    memberSeeds.length === 1
      ? representative.hypothesis
      : [
          representative.hypothesis,
          ...otherMembers.map((s) => s.hypothesis),
        ].join('\n\nAlso investigate: ');

  // Re-score priority upward based on cluster size
  const originalPriority = representative.priority;
  const priority = Math.min(
    originalPriority + CLUSTER_PRIORITY_BOOST * (memberSeeds.length - 1),
    100,
  );

  return {
    // Spread representative fields first (id, source, category, etc.)
    ...representative,
    // Override with cluster-specific fields
    hypothesis,
    priority,
    memberSeeds,
    clusterLabel: cluster.label,
    originalPriority,
  };
}

// ---------------------------------------------------------------------------
// clusterSeeds (public, async)
// ---------------------------------------------------------------------------

/**
 * Groups raw deterministic investigation seeds by likely shared root cause
 * using a single LLM call, then collapses each cluster into one representative
 * {@link ClusteredSeed} carrying combined evidence pointers.
 *
 * ## Algorithm
 *
 * 1. **Threshold check** — If `seeds.length < {@link CLUSTER_MIN_SEEDS}`,
 *    skip the LLM call entirely and return `toUnclusteredSeeds(seeds)`.
 * 2. **Prompt construction** — `buildSeedClusteringPrompt(seeds)` serialises
 *    the seed list and produces system + user prompts.
 * 3. **LLM call** — `llmClient.generateText(system, user)` returns raw JSON.
 * 4. **Parse** — JSON parse failure → `console.warn` + fall back to
 *    `toUnclusteredSeeds(seeds)`.
 * 5. **Validate** — Response validation failure (unknown IDs, missing seeds,
 *    representative not in cluster) → `console.warn` + fall back to
 *    `toUnclusteredSeeds(seeds)`.
 * 6. **Build** — For each cluster, `buildClusteredSeed` constructs the
 *    representative with merged hypothesis, re-scored priority, and full
 *    `memberSeeds` list.
 * 7. **Sort** — Result sorted by priority descending (matching `generateSeeds`
 *    sort contract).
 *
 * ## Graceful degradation
 *
 * Any error at steps 3–5 causes the function to fall back to
 * `toUnclusteredSeeds(seeds)`, producing identical output to the no-AI path.
 * The caller never needs to handle clustering errors.
 *
 * @param seeds     - Raw deterministic seeds from `generateSeeds()`.
 * @param llmClient - Minimal LLM client satisfying {@link SeedClusterLLMClient}.
 * @returns Clustered seeds sorted by priority descending. Length ≤ input length.
 */
export async function clusterSeeds(
  seeds: InvestigationSeed[],
  llmClient: SeedClusterLLMClient,
): Promise<ClusteredSeed[]> {
  // ── Step 1: Threshold check ───────────────────────────────────────────────
  if (seeds.length < CLUSTER_MIN_SEEDS) {
    return toUnclusteredSeeds(seeds);
  }

  // ── Step 2: Build prompt ──────────────────────────────────────────────────
  const { system, user } = buildSeedClusteringPrompt(seeds);

  // ── Step 3: LLM call ──────────────────────────────────────────────────────
  let rawResponse: string;
  try {
    rawResponse = await llmClient.generateText(system, user);
  } catch (error) {
    console.warn(
      `[SeedClusterer] LLM call failed — falling back to unclustered seeds. ` +
        `Error: ${error instanceof Error ? error.message : String(error)}`,
    );
    return toUnclusteredSeeds(seeds);
  }

  // ── Step 4: Parse JSON ────────────────────────────────────────────────────
  let parsed: unknown;
  try {
    // Strip markdown code fences if the LLM wrapped its JSON response
    const cleaned = rawResponse
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/, '')
      .trim();
    parsed = JSON.parse(cleaned);
  } catch {
    console.warn(
      `[SeedClusterer] Failed to parse LLM response as JSON — falling back to unclustered seeds. ` +
        `Response (first 200 chars): ${rawResponse.slice(0, 200)}`,
    );
    return toUnclusteredSeeds(seeds);
  }

  // ── Step 5: Validate ──────────────────────────────────────────────────────
  if (!isLLMClusterResponse(parsed)) {
    console.warn(
      `[SeedClusterer] LLM response missing 'clusters' array — falling back to unclustered seeds.`,
    );
    return toUnclusteredSeeds(seeds);
  }

  if (!validateClusterResponse(parsed, seeds)) {
    console.warn(
      `[SeedClusterer] LLM cluster response failed validation (unknown/missing/duplicate seed IDs or ` +
        `representative not in cluster) — falling back to unclustered seeds.`,
    );
    return toUnclusteredSeeds(seeds);
  }

  // ── Step 6: Build ClusteredSeed objects ───────────────────────────────────
  const seedById = new Map(seeds.map((s) => [s.id, s]));

  const clusteredSeeds: ClusteredSeed[] = parsed.clusters.map((cluster) =>
    buildClusteredSeed(cluster, seedById),
  );

  // ── Step 7: Sort by priority descending ───────────────────────────────────
  return clusteredSeeds.sort((a, b) => b.priority - a.priority);
}
