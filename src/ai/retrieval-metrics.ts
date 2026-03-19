/**
 * Retrieval quality metrics — precision@k, recall@k, and MRR.
 *
 * These functions implement standard information-retrieval evaluation metrics.
 * They serve as the measurement infrastructure for retrieval regression tests
 * and the benchmark scripts in `scripts/`.
 *
 * **No scoring constants live here** — this module is pure measurement.
 * Scoring weights remain in `lexical-search.ts`, `resource-graph.ts`, and
 * `ai-investigator.ts`.
 */

// ---------------------------------------------------------------------------
// RetrievalMetrics
// ---------------------------------------------------------------------------

/**
 * Result of {@link computeRetrievalMetrics}.
 */
export interface RetrievalMetrics {
  /**
   * Precision at k: fraction of top-k retrieved items that are relevant.
   *
   * `|retrieved∩expected| / k`
   */
  precisionAtK: number;

  /**
   * Recall at k: fraction of relevant items that appear in the top-k results.
   *
   * `|retrieved∩expected| / |expected|`
   */
  recallAtK: number;

  /**
   * Mean Reciprocal Rank: reciprocal of the rank of the first relevant item
   * in the **full** retrieved list.  `0` when no relevant item appears.
   *
   * MRR is computed over the full `retrieved` array (not just top-k) so that
   * a relevant item at rank 7 is not lost when k=5.
   */
  mrr: number;

  /** Number of relevant items found within the top-k results. */
  hitsAtK: number;

  /** Total number of unique relevant items expected (size of the expected set). */
  expectedCount: number;

  /** The k cutoff value used for this computation. */
  k: number;
}

// ---------------------------------------------------------------------------
// computeRetrievalMetrics
// ---------------------------------------------------------------------------

/**
 * Computes precision@k, recall@k, and MRR for a single retrieval result.
 *
 * @param retrieved - Ordered array of retrieved item IDs (rank 1 = index 0).
 *                    Items beyond the list are not considered.
 * @param expected  - Array of relevant item IDs (the ground-truth relevance
 *                    set).  Duplicate IDs are deduplicated internally — each
 *                    unique expected ID counts once.
 * @param k         - Cutoff rank (default 5).  `precisionAtK` and `recallAtK`
 *                    are evaluated at this cutoff.  `mrr` uses the **full**
 *                    `retrieved` list regardless of k.
 * @returns {@link RetrievalMetrics}
 *
 * @example
 * // Relevant items at ranks 1 and 3:
 * const m = computeRetrievalMetrics(
 *   ['a', 'x', 'b', 'y', 'z'],  // retrieved (rank 1..5)
 *   ['a', 'b', 'c'],              // expected (ground truth)
 * );
 * // m.precisionAtK === 2/5 === 0.4
 * // m.recallAtK    === 2/3 ≈ 0.667
 * // m.mrr          === 1/1 === 1.0   (first relevant at rank 1)
 * // m.hitsAtK      === 2
 * // m.expectedCount === 3
 * // m.k             === 5
 */
export function computeRetrievalMetrics(
  retrieved: readonly string[],
  expected: readonly string[],
  k = 5,
): RetrievalMetrics {
  const expectedSet = new Set(expected);
  const topK = retrieved.slice(0, k);

  // Count hits within top-k
  const hitsAtK = topK.filter((id) => expectedSet.has(id)).length;

  // Precision@k: avoid divide-by-zero when k=0
  const precisionAtK = k > 0 ? hitsAtK / k : 0;

  // Recall@k: avoid divide-by-zero when no expected items
  const recallAtK = expectedSet.size > 0 ? hitsAtK / expectedSet.size : 0;

  // MRR: scan the full retrieved list for the first relevant hit
  let mrr = 0;
  for (let i = 0; i < retrieved.length; i++) {
    if (expectedSet.has(retrieved[i]!)) {
      mrr = 1 / (i + 1);
      break;
    }
  }

  return {
    precisionAtK,
    recallAtK,
    mrr,
    hitsAtK,
    expectedCount: expectedSet.size,
    k,
  };
}

// ---------------------------------------------------------------------------
// aggregateRetrievalMetrics
// ---------------------------------------------------------------------------

/**
 * Aggregates multiple {@link RetrievalMetrics} into macro-averages.
 *
 * Uses macro-averaging: each query contributes equally regardless of
 * expected-set size.  This is the standard approach for IR evaluation when
 * the number of relevant documents varies across queries.
 *
 * @param metrics - Array of per-query metrics to aggregate.
 * @returns The macro-averaged metrics.  Returns a zeroed record when the
 *          input array is empty.
 */
export function aggregateRetrievalMetrics(
  metrics: readonly RetrievalMetrics[],
): {
  precisionAtK: number;
  recallAtK: number;
  mrr: number;
  meanHitsAtK: number;
  queryCount: number;
} {
  if (metrics.length === 0) {
    return { precisionAtK: 0, recallAtK: 0, mrr: 0, meanHitsAtK: 0, queryCount: 0 };
  }

  let sumPrecision = 0;
  let sumRecall = 0;
  let sumMrr = 0;
  let sumHits = 0;

  for (const m of metrics) {
    sumPrecision += m.precisionAtK;
    sumRecall += m.recallAtK;
    sumMrr += m.mrr;
    sumHits += m.hitsAtK;
  }

  const n = metrics.length;
  return {
    precisionAtK: sumPrecision / n,
    recallAtK: sumRecall / n,
    mrr: sumMrr / n,
    meanHitsAtK: sumHits / n,
    queryCount: n,
  };
}
