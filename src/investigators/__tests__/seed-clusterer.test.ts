import { describe, it, expect, vi } from 'vitest';
import type { InvestigationSeed, SeedClusterLLMClient } from '../types.js';
import {
  clusterSeeds,
  toUnclusteredSeeds,
  CLUSTER_MIN_SEEDS,
  CLUSTER_PRIORITY_BOOST,
} from '../seed-clusterer.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeSeed(
  id: string,
  hypothesis: string,
  priority: number,
  source = 'pod:default/app-pod',
  category: InvestigationSeed['category'] = 'kubernetes',
): InvestigationSeed {
  return { id, hypothesis, source, category, priority };
}

function makeMockLLM(response: string): SeedClusterLLMClient {
  return {
    generateText: vi.fn().mockResolvedValue(response),
  };
}

function makeMockLLMThrows(error: Error): SeedClusterLLMClient {
  return {
    generateText: vi.fn().mockRejectedValue(error),
  };
}

/**
 * Builds a valid LLM cluster response JSON for a given list of clusters.
 * Each cluster entry: { label, seedIds, representativeSeedId }
 */
function buildValidLLMResponse(
  clusters: Array<{
    label: string;
    seedIds: string[];
    representativeSeedId: string;
  }>,
): string {
  return JSON.stringify({
    clusters: clusters.map((c) => ({
      label: c.label,
      reasoning: 'Test reasoning',
      seedIds: c.seedIds,
      representativeSeedId: c.representativeSeedId,
    })),
  });
}

// ---------------------------------------------------------------------------
// toUnclusteredSeeds tests
// ---------------------------------------------------------------------------

describe('toUnclusteredSeeds', () => {
  it('returns empty array for empty input', () => {
    const result = toUnclusteredSeeds([]);
    expect(result).toHaveLength(0);
  });

  it('maps each seed to a ClusteredSeed with memberSeeds: [self]', () => {
    const seeds = [makeSeed('s1', 'hypothesis one', 80), makeSeed('s2', 'hypothesis two', 60)];
    const result = toUnclusteredSeeds(seeds);

    expect(result).toHaveLength(2);
    for (const clustered of result) {
      expect(clustered.memberSeeds).toHaveLength(1);
      expect(clustered.memberSeeds[0]).toBe(
        seeds.find((s) => s.id === clustered.id),
      );
    }
  });

  it('preserves original priority', () => {
    const seeds = [makeSeed('s1', 'hypothesis one', 75)];
    const result = toUnclusteredSeeds(seeds);
    expect(result[0]!.priority).toBe(75);
    expect(result[0]!.originalPriority).toBe(75);
  });

  it('preserves original hypothesis', () => {
    const seeds = [makeSeed('s1', 'CrashLoopBackOff in default/app-pod', 90)];
    const result = toUnclusteredSeeds(seeds);
    expect(result[0]!.hypothesis).toBe('CrashLoopBackOff in default/app-pod');
  });

  it('preserves original source', () => {
    const seeds = [makeSeed('s1', 'some hypothesis', 50, 'pod:default/my-pod')];
    const result = toUnclusteredSeeds(seeds);
    expect(result[0]!.source).toBe('pod:default/my-pod');
  });

  it('preserves original category', () => {
    const seeds = [makeSeed('s1', 'missing secret', 80, 'analyzer:secret-check', 'configuration')];
    const result = toUnclusteredSeeds(seeds);
    expect(result[0]!.category).toBe('configuration');
  });

  it('sets clusterLabel equal to the original hypothesis', () => {
    const hypothesis = 'Pod app-pod is not ready';
    const seeds = [makeSeed('s1', hypothesis, 50)];
    const result = toUnclusteredSeeds(seeds);
    expect(result[0]!.clusterLabel).toBe(hypothesis);
  });

  it('sets originalPriority equal to priority for singletons', () => {
    const seeds = [makeSeed('s1', 'hypothesis', 65)];
    const result = toUnclusteredSeeds(seeds);
    expect(result[0]!.originalPriority).toBe(65);
    expect(result[0]!.priority).toBe(65);
  });

  it('returns results sorted by priority descending', () => {
    const seeds = [
      makeSeed('s1', 'low priority', 30),
      makeSeed('s2', 'high priority', 90),
      makeSeed('s3', 'medium priority', 60),
    ];
    const result = toUnclusteredSeeds(seeds);
    expect(result[0]!.priority).toBe(90);
    expect(result[1]!.priority).toBe(60);
    expect(result[2]!.priority).toBe(30);
  });

  it('preserves input sort order when input is already sorted descending', () => {
    const seeds = [
      makeSeed('s1', 'high priority', 90),
      makeSeed('s2', 'medium priority', 60),
      makeSeed('s3', 'low priority', 30),
    ];
    const result = toUnclusteredSeeds(seeds);
    expect(result[0]!.id).toBe('s1');
    expect(result[1]!.id).toBe('s2');
    expect(result[2]!.id).toBe('s3');
  });

  it('handles a single seed', () => {
    const seeds = [makeSeed('s1', 'lone hypothesis', 70)];
    const result = toUnclusteredSeeds(seeds);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('s1');
    expect(result[0]!.memberSeeds).toHaveLength(1);
    expect(result[0]!.memberSeeds[0]!.id).toBe('s1');
  });
});

// ---------------------------------------------------------------------------
// clusterSeeds — below-threshold passthrough tests
// ---------------------------------------------------------------------------

describe('clusterSeeds — below-threshold passthrough', () => {
  it('returns unclustered seeds when seed count is 0 (no LLM call)', async () => {
    const mockLLM = makeMockLLM('');
    const result = await clusterSeeds([], mockLLM);

    expect(result).toHaveLength(0);
    expect(mockLLM.generateText).not.toHaveBeenCalled();
  });

  it('returns unclustered seeds when seed count is 1 (no LLM call)', async () => {
    const seeds = [makeSeed('s1', 'only seed', 80)];
    const mockLLM = makeMockLLM('');
    const result = await clusterSeeds(seeds, mockLLM);

    expect(result).toHaveLength(1);
    expect(result[0]!.memberSeeds).toHaveLength(1);
    expect(result[0]!.memberSeeds[0]!.id).toBe('s1');
    expect(mockLLM.generateText).not.toHaveBeenCalled();
  });

  it(`returns unclustered seeds when seed count is ${CLUSTER_MIN_SEEDS - 1} (no LLM call)`, async () => {
    const seeds = Array.from({ length: CLUSTER_MIN_SEEDS - 1 }, (_, i) =>
      makeSeed(`s${i}`, `hypothesis ${i}`, 60 - i * 5),
    );
    const mockLLM = makeMockLLM('');
    const result = await clusterSeeds(seeds, mockLLM);

    expect(result).toHaveLength(CLUSTER_MIN_SEEDS - 1);
    expect(mockLLM.generateText).not.toHaveBeenCalled();
    for (const c of result) {
      expect(c.memberSeeds).toHaveLength(1);
    }
  });

  it('below-threshold result has correct singleton ClusteredSeed fields', async () => {
    const seeds = [
      makeSeed('s1', 'high priority seed', 90),
      makeSeed('s2', 'medium priority seed', 60),
    ];
    const mockLLM = makeMockLLM('');
    const result = await clusterSeeds(seeds, mockLLM);

    for (const clustered of result) {
      const original = seeds.find((s) => s.id === clustered.id)!;
      expect(clustered.originalPriority).toBe(original.priority);
      expect(clustered.priority).toBe(original.priority);
      expect(clustered.clusterLabel).toBe(original.hypothesis);
      expect(clustered.memberSeeds[0]).toBe(original);
    }
  });
});

// ---------------------------------------------------------------------------
// clusterSeeds — successful clustering tests
// ---------------------------------------------------------------------------

describe('clusterSeeds — successful clustering', () => {
  // 5 seeds: cluster A (s1, s2), cluster B (s3, s4, s5)
  const seeds = [
    makeSeed('s1', 'CrashLoopBackOff in default/app-pod', 90, 'pod:default/app-pod'),
    makeSeed('s2', 'Pod app-pod is not ready', 50, 'pod:default/app-pod'),
    makeSeed('s3', 'Missing secret db-credentials', 80, 'analyzer:secret-check', 'configuration'),
    makeSeed('s4', 'Volume mount failed for secret db-credentials', 60, 'event:FailedMount'),
    makeSeed('s5', 'Warning event: BackOff in default', 30, 'event:BackOff'),
  ];

  function buildSuccessResponse(): string {
    return buildValidLLMResponse([
      {
        label: 'CrashLoopBackOff caused by missing Secret db-credentials',
        seedIds: ['s1', 's2', 's5'],
        representativeSeedId: 's1', // highest priority in group
      },
      {
        label: 'Missing Secret db-credentials causing mount failure',
        seedIds: ['s3', 's4'],
        representativeSeedId: 's3', // highest priority in group
      },
    ]);
  }

  it('calls LLM when seed count meets threshold', async () => {
    const mockLLM = makeMockLLM(buildSuccessResponse());
    await clusterSeeds(seeds, mockLLM);
    expect(mockLLM.generateText).toHaveBeenCalledOnce();
  });

  it('returns correct number of ClusteredSeeds (one per cluster)', async () => {
    const mockLLM = makeMockLLM(buildSuccessResponse());
    const result = await clusterSeeds(seeds, mockLLM);
    // 2 clusters → 2 ClusteredSeeds
    expect(result).toHaveLength(2);
  });

  it('sets clusterLabel to the LLM-provided label', async () => {
    const mockLLM = makeMockLLM(buildSuccessResponse());
    const result = await clusterSeeds(seeds, mockLLM);
    const crashCluster = result.find((c) => c.id === 's1')!;
    expect(crashCluster.clusterLabel).toBe(
      'CrashLoopBackOff caused by missing Secret db-credentials',
    );
  });

  it('sets memberSeeds to all members of the cluster including representative', async () => {
    const mockLLM = makeMockLLM(buildSuccessResponse());
    const result = await clusterSeeds(seeds, mockLLM);

    const crashCluster = result.find((c) => c.id === 's1')!;
    const memberIds = crashCluster.memberSeeds.map((m) => m.id).sort();
    expect(memberIds).toEqual(['s1', 's2', 's5'].sort());
  });

  it('representative is first in memberSeeds array', async () => {
    const mockLLM = makeMockLLM(buildSuccessResponse());
    const result = await clusterSeeds(seeds, mockLLM);

    const crashCluster = result.find((c) => c.id === 's1')!;
    expect(crashCluster.memberSeeds[0]!.id).toBe('s1');
  });

  it('uses the representative seed id, source, and category', async () => {
    const mockLLM = makeMockLLM(buildSuccessResponse());
    const result = await clusterSeeds(seeds, mockLLM);

    const configCluster = result.find((c) => c.id === 's3')!;
    expect(configCluster.id).toBe('s3');
    expect(configCluster.source).toBe('analyzer:secret-check');
    expect(configCluster.category).toBe('configuration');
  });

  it('memberSeeds objects preserve original source, category, and priority (not mutated)', async () => {
    const mockLLM = makeMockLLM(buildSuccessResponse());
    const result = await clusterSeeds(seeds, mockLLM);

    const crashCluster = result.find((c) => c.id === 's1')!;
    const memberS2 = crashCluster.memberSeeds.find((m) => m.id === 's2')!;
    expect(memberS2.source).toBe('pod:default/app-pod');
    expect(memberS2.category).toBe('kubernetes');
    expect(memberS2.priority).toBe(50);
    expect(memberS2.hypothesis).toBe('Pod app-pod is not ready');
  });

  it('result is sorted by priority descending', async () => {
    const mockLLM = makeMockLLM(buildSuccessResponse());
    const result = await clusterSeeds(seeds, mockLLM);
    for (let i = 1; i < result.length; i++) {
      expect(result[i]!.priority).toBeLessThanOrEqual(result[i - 1]!.priority);
    }
  });
});

// ---------------------------------------------------------------------------
// clusterSeeds — combined hypothesis tests
// ---------------------------------------------------------------------------

describe('clusterSeeds — combined hypothesis', () => {
  it('cluster of 2 seeds joins hypotheses with separator', async () => {
    const seeds = [
      makeSeed('s1', 'CrashLoopBackOff in default/app-pod', 90),
      makeSeed('s2', 'Pod app-pod is not ready', 50),
      makeSeed('s3', 'Warning event for app-pod', 30),
    ];

    const llmResponse = buildValidLLMResponse([
      {
        label: 'CrashLoopBackOff cluster',
        seedIds: ['s1', 's2'],
        representativeSeedId: 's1',
      },
      {
        label: 'Singleton warning',
        seedIds: ['s3'],
        representativeSeedId: 's3',
      },
    ]);
    const mockLLM = makeMockLLM(llmResponse);
    const result = await clusterSeeds(seeds, mockLLM);

    const cluster = result.find((c) => c.id === 's1')!;
    expect(cluster.hypothesis).toBe(
      'CrashLoopBackOff in default/app-pod\n\nAlso investigate: Pod app-pod is not ready',
    );
  });

  it('cluster of 3 seeds joins all three hypotheses with separator', async () => {
    const seeds = [
      makeSeed('s1', 'CrashLoopBackOff in default/app-pod', 90),
      makeSeed('s2', 'Pod app-pod is not ready', 50),
      makeSeed('s3', 'Warning event: BackOff in default', 30),
      // Extra seed to meet threshold and get exact 1-cluster grouping
      makeSeed('s4', 'Unrelated log error', 45, 'log:app.log', 'log'),
    ];

    const llmResponse = buildValidLLMResponse([
      {
        label: 'CrashLoopBackOff cluster of 3',
        seedIds: ['s1', 's2', 's3'],
        representativeSeedId: 's1',
      },
      {
        label: 'Log singleton',
        seedIds: ['s4'],
        representativeSeedId: 's4',
      },
    ]);
    const mockLLM = makeMockLLM(llmResponse);
    const result = await clusterSeeds(seeds, mockLLM);

    const cluster = result.find((c) => c.id === 's1')!;
    expect(cluster.hypothesis).toBe(
      'CrashLoopBackOff in default/app-pod\n\nAlso investigate: Pod app-pod is not ready\n\nAlso investigate: Warning event: BackOff in default',
    );
  });

  it('singleton cluster preserves hypothesis unchanged', async () => {
    const seeds = [
      makeSeed('s1', 'CrashLoopBackOff in default/app-pod', 90),
      makeSeed('s2', 'Pod app-pod is not ready', 50),
      makeSeed('s3', 'Unrelated config error', 60, 'analyzer:cfg', 'configuration'),
    ];

    const llmResponse = buildValidLLMResponse([
      {
        label: 'Crash cluster',
        seedIds: ['s1', 's2'],
        representativeSeedId: 's1',
      },
      {
        label: 'Config singleton',
        seedIds: ['s3'],
        representativeSeedId: 's3',
      },
    ]);
    const mockLLM = makeMockLLM(llmResponse);
    const result = await clusterSeeds(seeds, mockLLM);

    const singleton = result.find((c) => c.id === 's3')!;
    expect(singleton.hypothesis).toBe('Unrelated config error');
  });
});

// ---------------------------------------------------------------------------
// clusterSeeds — priority re-scoring tests
// ---------------------------------------------------------------------------

describe('clusterSeeds — priority re-scoring', () => {
  it(`cluster of 2 seeds boosts priority by ${CLUSTER_PRIORITY_BOOST}`, async () => {
    const seeds = [
      makeSeed('s1', 'First hypothesis', 60),
      makeSeed('s2', 'Second hypothesis', 50),
      makeSeed('s3', 'Third hypothesis', 40),
    ];

    const llmResponse = buildValidLLMResponse([
      {
        label: 'Cluster of 2',
        seedIds: ['s1', 's2'],
        representativeSeedId: 's1',
      },
      {
        label: 'Singleton',
        seedIds: ['s3'],
        representativeSeedId: 's3',
      },
    ]);
    const mockLLM = makeMockLLM(llmResponse);
    const result = await clusterSeeds(seeds, mockLLM);

    const cluster = result.find((c) => c.id === 's1')!;
    // 2 members → boost = CLUSTER_PRIORITY_BOOST * (2 - 1) = 5
    expect(cluster.priority).toBe(60 + CLUSTER_PRIORITY_BOOST * 1);
    expect(cluster.originalPriority).toBe(60);
  });

  it('cluster of 3 seeds with priority 60 → new priority is min(60 + 5*2, 100) = 70', async () => {
    const seeds = [
      makeSeed('s1', 'First', 60),
      makeSeed('s2', 'Second', 50),
      makeSeed('s3', 'Third', 40),
    ];

    const llmResponse = buildValidLLMResponse([
      {
        label: 'Cluster of 3',
        seedIds: ['s1', 's2', 's3'],
        representativeSeedId: 's1',
      },
    ]);
    const mockLLM = makeMockLLM(llmResponse);
    const result = await clusterSeeds(seeds, mockLLM);

    expect(result).toHaveLength(1);
    const cluster = result[0]!;
    // 3 members → boost = 5 * (3 - 1) = 10
    expect(cluster.priority).toBe(70);
    expect(cluster.originalPriority).toBe(60);
  });

  it('priority is capped at 100', async () => {
    // 4 seeds in one cluster, representative priority 95
    // Would be 95 + 5*3 = 110, but capped at 100
    const seeds = [
      makeSeed('s1', 'First', 95),
      makeSeed('s2', 'Second', 80),
      makeSeed('s3', 'Third', 70),
      makeSeed('s4', 'Fourth', 60),
    ];

    const llmResponse = buildValidLLMResponse([
      {
        label: 'Large cluster',
        seedIds: ['s1', 's2', 's3', 's4'],
        representativeSeedId: 's1',
      },
    ]);
    const mockLLM = makeMockLLM(llmResponse);
    const result = await clusterSeeds(seeds, mockLLM);

    expect(result[0]!.priority).toBe(100);
    expect(result[0]!.originalPriority).toBe(95);
  });

  it('singleton cluster has priority unchanged (no boost applied)', async () => {
    const seeds = [
      makeSeed('s1', 'Clustered seed A', 80),
      makeSeed('s2', 'Clustered seed B', 70),
      makeSeed('s3', 'Singleton seed', 60),
    ];

    const llmResponse = buildValidLLMResponse([
      {
        label: 'Cluster',
        seedIds: ['s1', 's2'],
        representativeSeedId: 's1',
      },
      {
        label: 'Singleton',
        seedIds: ['s3'],
        representativeSeedId: 's3',
      },
    ]);
    const mockLLM = makeMockLLM(llmResponse);
    const result = await clusterSeeds(seeds, mockLLM);

    const singleton = result.find((c) => c.id === 's3')!;
    expect(singleton.priority).toBe(60);
    expect(singleton.originalPriority).toBe(60);
  });
});

// ---------------------------------------------------------------------------
// clusterSeeds — LLM parse failure fallback tests
// ---------------------------------------------------------------------------

describe('clusterSeeds — LLM parse failure fallback', () => {
  const threePlusSeeds = [
    makeSeed('s1', 'First', 90),
    makeSeed('s2', 'Second', 60),
    makeSeed('s3', 'Third', 30),
  ];

  it('falls back to unclustered when LLM returns invalid JSON', async () => {
    const mockLLM = makeMockLLM('this is not json {{{');
    const result = await clusterSeeds(threePlusSeeds, mockLLM);

    expect(result).toHaveLength(threePlusSeeds.length);
    for (const c of result) {
      expect(c.memberSeeds).toHaveLength(1);
    }
  });

  it('does not throw when LLM returns invalid JSON', async () => {
    const mockLLM = makeMockLLM('this is not json {{{');
    await expect(clusterSeeds(threePlusSeeds, mockLLM)).resolves.toBeDefined();
  });

  it('falls back to unclustered when LLM returns empty string', async () => {
    const mockLLM = makeMockLLM('');
    const result = await clusterSeeds(threePlusSeeds, mockLLM);

    expect(result).toHaveLength(threePlusSeeds.length);
    for (const c of result) {
      expect(c.memberSeeds).toHaveLength(1);
    }
  });

  it('does not throw when LLM returns empty string', async () => {
    const mockLLM = makeMockLLM('');
    await expect(clusterSeeds(threePlusSeeds, mockLLM)).resolves.toBeDefined();
  });

  it('falls back to unclustered when LLM throws an error', async () => {
    const mockLLM = makeMockLLMThrows(new Error('OpenAI API rate limit'));
    const result = await clusterSeeds(threePlusSeeds, mockLLM);

    expect(result).toHaveLength(threePlusSeeds.length);
    for (const c of result) {
      expect(c.memberSeeds).toHaveLength(1);
    }
  });

  it('does not throw when LLM throws an error', async () => {
    const mockLLM = makeMockLLMThrows(new Error('network failure'));
    await expect(clusterSeeds(threePlusSeeds, mockLLM)).resolves.toBeDefined();
  });

  it('falls back to unclustered when LLM returns JSON without clusters key', async () => {
    const mockLLM = makeMockLLM(JSON.stringify({ groups: [] }));
    const result = await clusterSeeds(threePlusSeeds, mockLLM);

    expect(result).toHaveLength(threePlusSeeds.length);
    for (const c of result) {
      expect(c.memberSeeds).toHaveLength(1);
    }
  });

  it('falls back to unclustered when LLM returns JSON with null clusters', async () => {
    const mockLLM = makeMockLLM(JSON.stringify({ clusters: null }));
    const result = await clusterSeeds(threePlusSeeds, mockLLM);

    expect(result).toHaveLength(threePlusSeeds.length);
    for (const c of result) {
      expect(c.memberSeeds).toHaveLength(1);
    }
  });

  it('strips markdown code fences before parsing JSON', async () => {
    const validJson = buildValidLLMResponse([
      {
        label: 'cluster A',
        seedIds: ['s1', 's2'],
        representativeSeedId: 's1',
      },
      {
        label: 'singleton B',
        seedIds: ['s3'],
        representativeSeedId: 's3',
      },
    ]);
    const withFences = `\`\`\`json\n${validJson}\n\`\`\``;
    const mockLLM = makeMockLLM(withFences);
    const result = await clusterSeeds(threePlusSeeds, mockLLM);

    // Should successfully parse (not fall back) — 2 clusters
    expect(result).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// clusterSeeds — validation failure fallback tests
// ---------------------------------------------------------------------------

describe('clusterSeeds — validation failure fallback', () => {
  const fiveSeeds = [
    makeSeed('s1', 'First', 90),
    makeSeed('s2', 'Second', 80),
    makeSeed('s3', 'Third', 60),
    makeSeed('s4', 'Fourth', 40),
    makeSeed('s5', 'Fifth', 30),
  ];

  it('falls back to unclustered when LLM omits a seed ID (missing seed)', async () => {
    // LLM only includes s1, s2, s3, s4 — omits s5
    const response = buildValidLLMResponse([
      {
        label: 'Cluster A',
        seedIds: ['s1', 's2'],
        representativeSeedId: 's1',
      },
      {
        label: 'Cluster B',
        seedIds: ['s3', 's4'],
        representativeSeedId: 's3',
      },
      // s5 is missing
    ]);
    const mockLLM = makeMockLLM(response);
    const result = await clusterSeeds(fiveSeeds, mockLLM);

    // Should fall back to unclustered (one ClusteredSeed per input seed)
    expect(result).toHaveLength(fiveSeeds.length);
    for (const c of result) {
      expect(c.memberSeeds).toHaveLength(1);
    }
  });

  it('falls back to unclustered when LLM puts same seed in two clusters (duplicate)', async () => {
    // s1 appears in both cluster A and cluster B
    const response = buildValidLLMResponse([
      {
        label: 'Cluster A',
        seedIds: ['s1', 's2'],
        representativeSeedId: 's1',
      },
      {
        label: 'Cluster B',
        seedIds: ['s1', 's3', 's4', 's5'], // s1 duplicated
        representativeSeedId: 's1',
      },
    ]);
    const mockLLM = makeMockLLM(response);
    const result = await clusterSeeds(fiveSeeds, mockLLM);

    expect(result).toHaveLength(fiveSeeds.length);
    for (const c of result) {
      expect(c.memberSeeds).toHaveLength(1);
    }
  });

  it('falls back to unclustered when representativeSeedId is not in seedIds', async () => {
    // representativeSeedId 's5' is not in seedIds of cluster A
    const response = JSON.stringify({
      clusters: [
        {
          label: 'Cluster A',
          reasoning: 'test',
          seedIds: ['s1', 's2', 's3'],
          representativeSeedId: 's5', // not in seedIds
        },
        {
          label: 'Cluster B',
          reasoning: 'test',
          seedIds: ['s4', 's5'],
          representativeSeedId: 's4',
        },
      ],
    });
    const mockLLM = makeMockLLM(response);
    const result = await clusterSeeds(fiveSeeds, mockLLM);

    expect(result).toHaveLength(fiveSeeds.length);
    for (const c of result) {
      expect(c.memberSeeds).toHaveLength(1);
    }
  });

  it('falls back to unclustered when LLM includes an unknown seed ID', async () => {
    // 'unknown-seed' is not in the input
    const response = buildValidLLMResponse([
      {
        label: 'Cluster A',
        seedIds: ['s1', 's2', 'unknown-seed'],
        representativeSeedId: 's1',
      },
      {
        label: 'Cluster B',
        seedIds: ['s3', 's4', 's5'],
        representativeSeedId: 's3',
      },
    ]);
    const mockLLM = makeMockLLM(response);
    const result = await clusterSeeds(fiveSeeds, mockLLM);

    expect(result).toHaveLength(fiveSeeds.length);
    for (const c of result) {
      expect(c.memberSeeds).toHaveLength(1);
    }
  });

  it('falls back to unclustered when a cluster has an empty seedIds array', async () => {
    const response = JSON.stringify({
      clusters: [
        {
          label: 'Cluster A',
          reasoning: 'test',
          seedIds: ['s1', 's2', 's3', 's4', 's5'],
          representativeSeedId: 's1',
        },
        {
          label: 'Empty cluster',
          reasoning: 'test',
          seedIds: [], // empty
          representativeSeedId: '',
        },
      ],
    });
    const mockLLM = makeMockLLM(response);
    const result = await clusterSeeds(fiveSeeds, mockLLM);

    expect(result).toHaveLength(fiveSeeds.length);
    for (const c of result) {
      expect(c.memberSeeds).toHaveLength(1);
    }
  });

  it('validation failures do not throw', async () => {
    // Missing seed scenario
    const response = buildValidLLMResponse([
      {
        label: 'Only some',
        seedIds: ['s1', 's2'],
        representativeSeedId: 's1',
      },
    ]);
    const mockLLM = makeMockLLM(response);
    await expect(clusterSeeds(fiveSeeds, mockLLM)).resolves.toBeDefined();
  });

  it('fallback result preserves original seeds sorted by priority descending', async () => {
    // Trigger fallback via duplicate seed
    const response = buildValidLLMResponse([
      {
        label: 'Cluster A',
        seedIds: ['s1', 's2', 's1'], // duplicate s1
        representativeSeedId: 's1',
      },
      {
        label: 'Cluster B',
        seedIds: ['s3', 's4', 's5'],
        representativeSeedId: 's3',
      },
    ]);
    const mockLLM = makeMockLLM(response);
    const result = await clusterSeeds(fiveSeeds, mockLLM);

    for (let i = 1; i < result.length; i++) {
      expect(result[i]!.priority).toBeLessThanOrEqual(result[i - 1]!.priority);
    }
  });
});

// ---------------------------------------------------------------------------
// clusterSeeds — sort order tests
// ---------------------------------------------------------------------------

describe('clusterSeeds — sort order', () => {
  it('returns results sorted by priority descending after successful clustering', async () => {
    const seeds = [
      makeSeed('s1', 'Low priority', 30),
      makeSeed('s2', 'Medium priority', 60),
      makeSeed('s3', 'High priority', 90),
    ];

    const llmResponse = buildValidLLMResponse([
      {
        label: 'All together',
        seedIds: ['s1', 's2', 's3'],
        representativeSeedId: 's3',
      },
    ]);
    const mockLLM = makeMockLLM(llmResponse);
    const result = await clusterSeeds(seeds, mockLLM);

    // Single cluster, no ordering assertion needed beyond verifying it's sorted
    expect(result).toHaveLength(1);
  });

  it('returns multi-cluster results sorted by boosted priority descending', async () => {
    const seeds = [
      makeSeed('s1', 'Lower rep', 50),
      makeSeed('s2', 'Lower pair', 40),
      makeSeed('s3', 'Higher rep', 60),
      makeSeed('s4', 'Higher pair', 55),
      makeSeed('s5', 'Singleton', 80),
    ];
    // cluster A (s1, s2): rep priority 50, boosted to 55
    // cluster B (s3, s4): rep priority 60, boosted to 65
    // singleton s5: priority 80
    const llmResponse = buildValidLLMResponse([
      {
        label: 'Cluster A',
        seedIds: ['s1', 's2'],
        representativeSeedId: 's1',
      },
      {
        label: 'Cluster B',
        seedIds: ['s3', 's4'],
        representativeSeedId: 's3',
      },
      {
        label: 'Singleton',
        seedIds: ['s5'],
        representativeSeedId: 's5',
      },
    ]);
    const mockLLM = makeMockLLM(llmResponse);
    const result = await clusterSeeds(seeds, mockLLM);

    expect(result).toHaveLength(3);
    // s5 (priority 80) > cluster B (priority 65) > cluster A (priority 55)
    expect(result[0]!.id).toBe('s5');
    expect(result[1]!.id).toBe('s3');
    expect(result[2]!.id).toBe('s1');
  });
});

// ---------------------------------------------------------------------------
// clusterSeeds — memberSeeds immutability tests
// ---------------------------------------------------------------------------

describe('clusterSeeds — memberSeeds carries full original objects', () => {
  it('each member in memberSeeds has original source intact', async () => {
    const seeds = [
      makeSeed('s1', 'First', 90, 'pod:default/app-pod', 'kubernetes'),
      makeSeed('s2', 'Second', 60, 'event:BackOff', 'kubernetes'),
      makeSeed('s3', 'Third', 30, 'analyzer:cfg', 'configuration'),
    ];

    const llmResponse = buildValidLLMResponse([
      {
        label: 'All together',
        seedIds: ['s1', 's2', 's3'],
        representativeSeedId: 's1',
      },
    ]);
    const mockLLM = makeMockLLM(llmResponse);
    const result = await clusterSeeds(seeds, mockLLM);

    const cluster = result[0]!;
    const memberS2 = cluster.memberSeeds.find((m) => m.id === 's2')!;
    const memberS3 = cluster.memberSeeds.find((m) => m.id === 's3')!;

    expect(memberS2.source).toBe('event:BackOff');
    expect(memberS2.category).toBe('kubernetes');
    expect(memberS2.priority).toBe(60);

    expect(memberS3.source).toBe('analyzer:cfg');
    expect(memberS3.category).toBe('configuration');
    expect(memberS3.priority).toBe(30);
  });

  it('each member in memberSeeds has original hypothesis intact', async () => {
    const seeds = [
      makeSeed('s1', 'CrashLoopBackOff in default/app-pod', 90),
      makeSeed('s2', 'Pod app-pod is not ready', 50),
      makeSeed('s3', 'Warning event for app-pod', 30),
    ];

    const llmResponse = buildValidLLMResponse([
      {
        label: 'Crash cluster',
        seedIds: ['s1', 's2', 's3'],
        representativeSeedId: 's1',
      },
    ]);
    const mockLLM = makeMockLLM(llmResponse);
    const result = await clusterSeeds(seeds, mockLLM);

    const cluster = result[0]!;
    expect(cluster.memberSeeds[0]!.hypothesis).toBe('CrashLoopBackOff in default/app-pod');
    expect(cluster.memberSeeds[1]!.hypothesis).toBe('Pod app-pod is not ready');
    expect(cluster.memberSeeds[2]!.hypothesis).toBe('Warning event for app-pod');
  });

  it('original input seed objects are not mutated by clustering', async () => {
    const seeds = [
      makeSeed('s1', 'First', 90),
      makeSeed('s2', 'Second', 50),
      makeSeed('s3', 'Third', 30),
    ];

    const originalPriorities = seeds.map((s) => s.priority);
    const originalHypotheses = seeds.map((s) => s.hypothesis);

    const llmResponse = buildValidLLMResponse([
      {
        label: 'All cluster',
        seedIds: ['s1', 's2', 's3'],
        representativeSeedId: 's1',
      },
    ]);
    const mockLLM = makeMockLLM(llmResponse);
    await clusterSeeds(seeds, mockLLM);

    // Original seeds should be unmodified
    for (let i = 0; i < seeds.length; i++) {
      expect(seeds[i]!.priority).toBe(originalPriorities[i]);
      expect(seeds[i]!.hypothesis).toBe(originalHypotheses[i]);
    }
  });
});

// ---------------------------------------------------------------------------
// clusterSeeds — exactly at threshold
// ---------------------------------------------------------------------------

describe('clusterSeeds — exactly at threshold', () => {
  it(`calls LLM when seed count equals ${CLUSTER_MIN_SEEDS}`, async () => {
    const seeds = Array.from({ length: CLUSTER_MIN_SEEDS }, (_, i) =>
      makeSeed(`s${i}`, `hypothesis ${i}`, 60 - i * 5),
    );

    const llmResponse = buildValidLLMResponse(
      seeds.map((s) => ({
        label: `Singleton ${s.id}`,
        seedIds: [s.id],
        representativeSeedId: s.id,
      })),
    );
    const mockLLM = makeMockLLM(llmResponse);
    await clusterSeeds(seeds, mockLLM);

    expect(mockLLM.generateText).toHaveBeenCalledOnce();
  });
});
