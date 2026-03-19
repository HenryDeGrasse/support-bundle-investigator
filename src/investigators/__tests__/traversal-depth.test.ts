import { describe, it, expect } from 'vitest';
import {
  maxDepthForSeed,
  MAX_GRAPH_NODES,
  GRAPH_MIN_WEIGHT,
} from '../ai-investigator.js';
import type { InvestigationSeed } from '../types.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeSeed(
  category: InvestigationSeed['category'],
  hypothesis = 'test hypothesis',
): InvestigationSeed {
  return {
    id: `seed:${category}:0`,
    hypothesis,
    source: 'test',
    category,
    priority: 50,
  };
}

// ---------------------------------------------------------------------------
// maxDepthForSeed — seed-category-specific traversal depth
// ---------------------------------------------------------------------------

describe('maxDepthForSeed', () => {
  it('returns 3 for kubernetes seeds (pod-level, same-namespace)', () => {
    expect(maxDepthForSeed(makeSeed('kubernetes'))).toBe(3);
  });

  it('returns 4 for connectivity seeds (cross-namespace service chains)', () => {
    expect(maxDepthForSeed(makeSeed('connectivity'))).toBe(4);
  });

  it('returns 2 for configuration seeds (direct refs only)', () => {
    expect(maxDepthForSeed(makeSeed('configuration'))).toBe(2);
  });

  it('returns 2 for log seeds (BM25 handles the rest)', () => {
    expect(maxDepthForSeed(makeSeed('log'))).toBe(2);
  });

  it('returns 3 as default for unknown categories', () => {
    // Cast to bypass type checking for the unknown category test
    expect(maxDepthForSeed(makeSeed('unknown' as never))).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// MAX_GRAPH_NODES — hard cap on traversal result size
// ---------------------------------------------------------------------------

describe('MAX_GRAPH_NODES', () => {
  it('is exported and is a positive number', () => {
    expect(MAX_GRAPH_NODES).toBeGreaterThan(0);
  });

  it('is 30 to balance coverage vs noise', () => {
    // 30 nodes is enough for:
    // - 1 starting pod
    // - 5-8 direct deps (secrets, configmaps, events, deployment)
    // - 10-15 depth-2 nodes (sibling pods, remote services)
    // - 5-10 depth-3/4 nodes (remote pod deps)
    // while preventing unbounded expansion in large clusters
    expect(MAX_GRAPH_NODES).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// GRAPH_MIN_WEIGHT — prune weak edges
// ---------------------------------------------------------------------------

describe('GRAPH_MIN_WEIGHT', () => {
  it('is exported and is a number >= 0', () => {
    expect(GRAPH_MIN_WEIGHT).toBeGreaterThanOrEqual(0);
  });

  it('is 0.1 to prune only near-zero temporal correlations', () => {
    // 0.1 means: temporal-correlation edges at 54+ seconds away
    // (weight = 1 - 54/60 = 0.1) are pruned. Everything closer passes.
    // This is conservative — we don't want to prune structural edges
    // (which have weight 1.0 or undefined=1.0).
    expect(GRAPH_MIN_WEIGHT).toBe(0.1);
  });
});

// ---------------------------------------------------------------------------
// Integration: depth values match the reasoning
// ---------------------------------------------------------------------------

describe('traversal depth rationale', () => {
  it('kubernetes depth 3 reaches sibling pod events but not their PVCs', () => {
    // Pod(0) -> Deployment(1) -> sibling-pod(2) -> sibling-event(3)
    // sibling-pod -> sibling-PVC would be depth 4 — excluded
    // This is correct: sibling PVC details rarely explain the original pod's crash
    const depth = maxDepthForSeed(makeSeed('kubernetes'));
    expect(depth).toBe(3);
    expect(depth).toBeLessThan(4); // explicitly not 4
  });

  it('connectivity depth 4 reaches remote pod dependencies', () => {
    // Pod(0) -> ConfigMap(1) -> remote-Service(2) -> remote-Pod(3) -> remote-Secret(4)
    // The remote secret is where connection credentials or storage failures live
    const depth = maxDepthForSeed(makeSeed('connectivity'));
    expect(depth).toBe(4);
  });

  it('configuration depth 2 stays within direct references', () => {
    // Pod(0) -> Secret/ConfigMap(1) -> ExternalSecret(2)
    // No need to traverse further — the misconfiguration is in the direct reference
    const depth = maxDepthForSeed(makeSeed('configuration'));
    expect(depth).toBe(2);
  });

  it('log depth 2 relies on BM25 for log-to-evidence correlation', () => {
    // Log seeds connect to their pod (depth 1) and pod's direct deps (depth 2)
    // BM25 identifier matching does the real work for log correlation
    const depth = maxDepthForSeed(makeSeed('log'));
    expect(depth).toBe(2);
  });

  it('connectivity is the only category that reaches depth 4', () => {
    const categories: InvestigationSeed['category'][] = [
      'kubernetes', 'configuration', 'log', 'connectivity',
    ];
    const depths = categories.map((c) => maxDepthForSeed(makeSeed(c)));
    const maxes = depths.filter((d) => d >= 4);
    expect(maxes).toHaveLength(1);
    expect(maxDepthForSeed(makeSeed('connectivity'))).toBe(4);
  });
});
