/**
 * Unit tests for retrieval quality metrics (6.3 / 7.7 — measurement infrastructure).
 *
 * Tests verify:
 *   (1) `computeRetrievalMetrics(retrieved, expected)` correctly computes
 *       precision@5, recall@5, and MRR for known input/output pairs.
 *   (2) `aggregateRetrievalMetrics` macro-averages across multiple queries.
 *
 * These tests are the quality gate for the retrieval benchmark infrastructure.
 * All inputs and expected outputs are statically known — no I/O, no fixtures,
 * no side effects.
 */

import { describe, it, expect } from 'vitest';
import {
  computeRetrievalMetrics,
  aggregateRetrievalMetrics,
} from '../../../src/ai/retrieval-metrics.js';

// ---------------------------------------------------------------------------
// computeRetrievalMetrics
// ---------------------------------------------------------------------------

describe('computeRetrievalMetrics', () => {
  // ── precision@k ──────────────────────────────────────────────────────────

  describe('precision@k', () => {
    it('perfect precision when all top-5 are relevant', () => {
      const m = computeRetrievalMetrics(
        ['a', 'b', 'c', 'd', 'e'],
        ['a', 'b', 'c', 'd', 'e'],
      );
      expect(m.precisionAtK).toBe(1.0);
      expect(m.hitsAtK).toBe(5);
    });

    it('zero precision when none of the top-5 are relevant', () => {
      const m = computeRetrievalMetrics(
        ['a', 'b', 'c', 'd', 'e'],
        ['x', 'y', 'z'],
      );
      expect(m.precisionAtK).toBe(0);
      expect(m.hitsAtK).toBe(0);
    });

    it('3/5 precision when exactly 3 of 5 retrieved are relevant', () => {
      const m = computeRetrievalMetrics(
        ['a', 'b', 'c', 'd', 'e'],
        ['a', 'b', 'c'],
      );
      expect(m.precisionAtK).toBeCloseTo(3 / 5, 6);
    });

    it('1/5 precision when 1 of 5 retrieved is relevant', () => {
      const m = computeRetrievalMetrics(
        ['x', 'y', 'a', 'z', 'w'],
        ['a', 'b'],
      );
      expect(m.precisionAtK).toBeCloseTo(1 / 5, 6);
    });

    it('does NOT count items beyond top-k for precision', () => {
      // 'b' is relevant but sits at rank 6 — outside k=5
      const m = computeRetrievalMetrics(
        ['x', 'y', 'z', 'w', 'v', 'b'],
        ['b'],
      );
      expect(m.precisionAtK).toBe(0);
      expect(m.hitsAtK).toBe(0);
    });
  });

  // ── recall@k ─────────────────────────────────────────────────────────────

  describe('recall@k', () => {
    it('perfect recall when all expected items appear in top-5', () => {
      const m = computeRetrievalMetrics(
        ['a', 'b', 'c', 'd', 'e'],
        ['a', 'b', 'c'],
      );
      expect(m.recallAtK).toBe(1.0);
    });

    it('zero recall when no expected items appear in top-5', () => {
      const m = computeRetrievalMetrics(
        ['a', 'b', 'c', 'd', 'e'],
        ['x', 'y'],
      );
      expect(m.recallAtK).toBe(0);
    });

    it('1/2 recall when 1 of 2 expected items found in top-5', () => {
      const m = computeRetrievalMetrics(
        ['x', 'y', 'a', 'z', 'w'],
        ['a', 'b'],
      );
      expect(m.recallAtK).toBeCloseTo(0.5, 6);
    });

    it('recall = 1.0 when expected is a strict subset of top-k retrieved', () => {
      const m = computeRetrievalMetrics(
        ['a', 'b', 'c', 'd', 'e'],
        ['a', 'b'],
      );
      expect(m.recallAtK).toBe(1.0);
    });

    it('2/3 recall when 2 of 3 expected items found in top-5', () => {
      const m = computeRetrievalMetrics(
        ['a', 'b', 'x', 'y', 'z'],
        ['a', 'b', 'c'],
      );
      expect(m.recallAtK).toBeCloseTo(2 / 3, 6);
    });
  });

  // ── MRR ──────────────────────────────────────────────────────────────────

  describe('MRR', () => {
    it('MRR = 1.0 when first retrieved item is relevant (rank 1)', () => {
      const m = computeRetrievalMetrics(['a', 'b', 'c'], ['a']);
      expect(m.mrr).toBe(1.0);
    });

    it('MRR = 0.5 when first relevant item is at rank 2', () => {
      const m = computeRetrievalMetrics(['x', 'a', 'b', 'c'], ['a']);
      expect(m.mrr).toBeCloseTo(0.5, 6);
    });

    it('MRR = 1/3 when first relevant item is at rank 3', () => {
      const m = computeRetrievalMetrics(['x', 'y', 'a', 'b', 'c'], ['a']);
      expect(m.mrr).toBeCloseTo(1 / 3, 6);
    });

    it('MRR = 0 when no relevant item found anywhere', () => {
      const m = computeRetrievalMetrics(['a', 'b', 'c'], ['x', 'y']);
      expect(m.mrr).toBe(0);
    });

    it('MRR is based on rank of FIRST relevant item only', () => {
      // First relevant at rank 2, second at rank 4 — MRR uses rank 2
      const m = computeRetrievalMetrics(['x', 'a', 'y', 'b', 'z'], ['a', 'b']);
      expect(m.mrr).toBeCloseTo(0.5, 6);
    });

    it('MRR uses the full retrieved list, not just top-k', () => {
      // Relevant item at rank 7, but k=5 → not in top-5 → hitsAtK=0
      // MRR still finds the item at rank 7 via full-list scan
      const m = computeRetrievalMetrics(
        ['x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'a'],
        ['a'],
        5,
      );
      expect(m.hitsAtK).toBe(0);
      expect(m.precisionAtK).toBe(0);
      expect(m.mrr).toBeCloseTo(1 / 7, 6);
    });

    it('MRR = 1/1 when the single expected item is first in a list of 10', () => {
      const retrieved = ['target', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
      const m = computeRetrievalMetrics(retrieved, ['target']);
      expect(m.mrr).toBe(1.0);
    });
  });

  // ── edge cases ────────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles empty retrieved list gracefully (no crash, all zeros)', () => {
      const m = computeRetrievalMetrics([], ['a', 'b'], 5);
      expect(m.precisionAtK).toBe(0);
      expect(m.recallAtK).toBe(0);
      expect(m.mrr).toBe(0);
      expect(m.hitsAtK).toBe(0);
    });

    it('handles empty expected set gracefully (recall and MRR both 0)', () => {
      const m = computeRetrievalMetrics(['a', 'b', 'c'], [], 5);
      expect(m.precisionAtK).toBe(0);
      expect(m.recallAtK).toBe(0);
      expect(m.mrr).toBe(0);
      expect(m.expectedCount).toBe(0);
    });

    it('handles k=0 gracefully (precision=0, MRR still uses full list)', () => {
      const m = computeRetrievalMetrics(['a', 'b'], ['a'], 0);
      expect(m.precisionAtK).toBe(0);
      expect(m.recallAtK).toBe(0);
      // MRR still searches the full list even when k=0
      expect(m.mrr).toBe(1.0);
    });

    it('deduplicates the expected set (duplicate IDs count as one)', () => {
      // expected has 'a' twice — should count as 1 unique expected item
      const m = computeRetrievalMetrics(
        ['a', 'b', 'c'],
        ['a', 'a', 'b'],
      );
      expect(m.expectedCount).toBe(2); // 'a' and 'b' are distinct
      expect(m.recallAtK).toBe(1.0);   // both found
    });

    it('respects custom k value (k=3 cutoff)', () => {
      // 'c' is at rank 3, 'd' at rank 4 — k=3 means only ['a','b','c']
      const m = computeRetrievalMetrics(
        ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
        ['c', 'd'],
        3,
      );
      expect(m.k).toBe(3);
      expect(m.hitsAtK).toBe(1); // 'c' is hit; 'd' is at rank 4, outside k=3
      expect(m.precisionAtK).toBeCloseTo(1 / 3, 6);
      expect(m.recallAtK).toBeCloseTo(0.5, 6); // 1 of 2 expected found
    });

    it('returns correct metadata fields (k, expectedCount, hitsAtK)', () => {
      const m = computeRetrievalMetrics(['a', 'b', 'c'], ['a', 'b'], 5);
      expect(m.k).toBe(5);
      expect(m.expectedCount).toBe(2);
      expect(m.hitsAtK).toBe(2);
    });

    it('handles both empty retrieved and empty expected (no crash)', () => {
      const m = computeRetrievalMetrics([], [], 5);
      expect(m.precisionAtK).toBe(0);
      expect(m.recallAtK).toBe(0);
      expect(m.mrr).toBe(0);
    });
  });

  // ── known-value correctness checks ───────────────────────────────────────

  describe('known-value correctness', () => {
    it('scenario: perfect top-1 single expected item', () => {
      // Simple: first result is the only expected item
      const m = computeRetrievalMetrics(['pod-chunk', 'event-chunk', 'log-chunk'], ['pod-chunk']);
      expect(m.precisionAtK).toBeCloseTo(1 / 5, 6); // 1 hit / 5 (k defaults to 5)
      expect(m.recallAtK).toBe(1.0);
      expect(m.mrr).toBe(1.0);
    });

    it('scenario: two expected items both in top-5 at ranks 2 and 4', () => {
      const m = computeRetrievalMetrics(
        ['noise-1', 'pod-chunk', 'noise-2', 'event-chunk', 'noise-3'],
        ['pod-chunk', 'event-chunk'],
      );
      expect(m.hitsAtK).toBe(2);
      expect(m.precisionAtK).toBeCloseTo(2 / 5, 6); // 0.4
      expect(m.recallAtK).toBe(1.0);
      expect(m.mrr).toBeCloseTo(0.5, 6); // first hit at rank 2
    });

    it('scenario: three expected items but only one in top-5 (at rank 3)', () => {
      const m = computeRetrievalMetrics(
        ['n1', 'n2', 'pod-chunk', 'n3', 'n4', 'event-chunk', 'log-chunk'],
        ['pod-chunk', 'event-chunk', 'log-chunk'],
      );
      expect(m.hitsAtK).toBe(1);
      expect(m.precisionAtK).toBeCloseTo(1 / 5, 6); // 0.2
      expect(m.recallAtK).toBeCloseTo(1 / 3, 6);    // 1 of 3 found
      expect(m.mrr).toBeCloseTo(1 / 3, 6);           // first hit at rank 3
    });

    it('scenario: expected item missed in top-5 but found at rank 8 (MRR=1/8)', () => {
      const retrieved = ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'target'];
      const m = computeRetrievalMetrics(retrieved, ['target'], 5);
      expect(m.hitsAtK).toBe(0);
      expect(m.precisionAtK).toBe(0);
      expect(m.recallAtK).toBe(0);
      expect(m.mrr).toBeCloseTo(1 / 8, 6);
    });
  });
});

// ---------------------------------------------------------------------------
// aggregateRetrievalMetrics
// ---------------------------------------------------------------------------

describe('aggregateRetrievalMetrics', () => {
  it('returns all-zero record for empty input (no crash)', () => {
    const agg = aggregateRetrievalMetrics([]);
    expect(agg.precisionAtK).toBe(0);
    expect(agg.recallAtK).toBe(0);
    expect(agg.mrr).toBe(0);
    expect(agg.meanHitsAtK).toBe(0);
    expect(agg.queryCount).toBe(0);
  });

  it('single query aggregate equals that query metrics exactly', () => {
    const m = computeRetrievalMetrics(['a', 'b', 'c'], ['a']);
    const agg = aggregateRetrievalMetrics([m]);
    expect(agg.precisionAtK).toBeCloseTo(m.precisionAtK, 6);
    expect(agg.recallAtK).toBeCloseTo(m.recallAtK, 6);
    expect(agg.mrr).toBeCloseTo(m.mrr, 6);
    expect(agg.queryCount).toBe(1);
  });

  it('macro-averages precision, recall, and MRR across two queries', () => {
    // query 1: 2 hits at k=5, recall=1.0, MRR=1.0
    const m1 = computeRetrievalMetrics(
      ['a', 'b', 'c', 'd', 'e'],
      ['a', 'b'],
    );
    // query 2: 1 hit at k=5 (at rank 3), recall=0.5, MRR=1/3
    const m2 = computeRetrievalMetrics(
      ['x', 'y', 'a', 'z', 'w'],
      ['a', 'b'],
    );

    const agg = aggregateRetrievalMetrics([m1, m2]);

    // precision: (2/5 + 1/5) / 2 = 0.3
    expect(agg.precisionAtK).toBeCloseTo((2 / 5 + 1 / 5) / 2, 6);
    // recall: (1.0 + 0.5) / 2 = 0.75
    expect(agg.recallAtK).toBeCloseTo((1.0 + 0.5) / 2, 6);
    // MRR: (1.0 + 1/3) / 2
    expect(agg.mrr).toBeCloseTo((1.0 + 1 / 3) / 2, 6);
    expect(agg.queryCount).toBe(2);
  });

  it('macro-averages across three queries with varying expected-set sizes', () => {
    // Each query contributes equally regardless of expected count (macro-avg)
    const m1 = computeRetrievalMetrics(['a'], ['a']);                    // P=1/5, R=1.0, MRR=1.0
    const m2 = computeRetrievalMetrics(['x', 'a', 'b'], ['a', 'b', 'c']); // P=2/5, R=2/3, MRR=1/2
    const m3 = computeRetrievalMetrics(['x', 'y', 'z'], ['a']);           // P=0, R=0, MRR=0

    const agg = aggregateRetrievalMetrics([m1, m2, m3]);
    expect(agg.queryCount).toBe(3);

    const expectedP = (m1.precisionAtK + m2.precisionAtK + m3.precisionAtK) / 3;
    const expectedR = (m1.recallAtK + m2.recallAtK + m3.recallAtK) / 3;
    const expectedMrr = (m1.mrr + m2.mrr + m3.mrr) / 3;

    expect(agg.precisionAtK).toBeCloseTo(expectedP, 6);
    expect(agg.recallAtK).toBeCloseTo(expectedR, 6);
    expect(agg.mrr).toBeCloseTo(expectedMrr, 6);
  });

  it('meanHitsAtK is the average hits per query', () => {
    const m1 = computeRetrievalMetrics(['a', 'b', 'c'], ['a', 'b']); // 2 hits
    const m2 = computeRetrievalMetrics(['x', 'y', 'a'], ['a', 'b']); // 1 hit

    const agg = aggregateRetrievalMetrics([m1, m2]);
    expect(agg.meanHitsAtK).toBeCloseTo((2 + 1) / 2, 6);
  });
});
