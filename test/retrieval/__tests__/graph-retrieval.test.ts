/**
 * Graph retrieval precision/recall tests — Phase 2 quality gate.
 *
 * These tests exercise `getRelatedChunks` (and its helpers) against realistic
 * multi-namespace fixture data, including the completed RRF quality gate.
 *
 * Fixture source: `multi-namespace-retrieval`
 *
 * Step dependencies:
 *   - step-13 (2.6): hop-distance scoring for graph chunk retrieval
 *   - step-14 (2.5): extend getRelatedChunks to Analyzer and Log seeds
 *   - step-15 (2.2): Reciprocal Rank Fusion (combines lexical + graph results)
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import {
  buildResourceGraph,
  getRelatedChunks,
} from '../../../src/graph/resource-graph.js';
import type { ResourceRelationshipGraph, GraphScoredChunk } from '../../../src/graph/resource-graph.js';
import { buildChunkIndex } from '../../../src/ai/chunk-indexer.js';
import type { IndexedChunk } from '../../../src/ai/chunk-indexer.js';
import { parseResourceJson } from '../../../src/parsers/k8s-resource-parser.js';
import { parseEventsJson } from '../../../src/parsers/event-parser.js';
import { parseAnalyzerJson } from '../../../src/parsers/analyzer-parser.js';
import { parseLogFile } from '../../../src/parsers/log-parser.js';
import { LexicalSearchIndex } from '../../../src/ai/lexical-search.js';
import { mergeChunks } from '../../../src/investigators/ai-investigator.js';
import type { K8sResource, K8sEvent } from '../../../src/types/index.js';
import type { InvestigationSeed } from '../../../src/investigators/types.js';
import type { BundleProfile } from '../../../src/types/index.js';
import type { ArtifactCategory } from '../../../src/types/index.js';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const SCENARIOS = path.resolve(__dirname, '../../fixtures/scenarios');
const MULTI_NS_DIR = path.join(SCENARIOS, 'multi-namespace-retrieval');
const MISSING_SECRET_DIR = path.join(SCENARIOS, 'missing-secret-crashloop');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readJson(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8');
}

/**
 * Builds a minimal BundleProfile required by `InvestigatorContext`.
 */
function makeMinimalProfile(): BundleProfile {
  const cats: Record<ArtifactCategory, number> = {
    analyzer: 0,
    log: 0,
    'kubernetes-resource': 0,
    event: 0,
    'cluster-info': 0,
    'helm-release': 0,
    unknown: 0,
  };
  return {
    manifest: {
      bundlePath: '',
      extractedPath: '',
      files: [],
      totalSize: 0,
      extractedAt: new Date(),
    },
    analyzerCount: 0,
    logFileCount: 0,
    resourceCount: 0,
    eventCount: 0,
    namespaces: [],
    workloads: [],
    coverageGaps: [],
    artifactsByCategory: cats,
  };
}

function makeSeed(source: string, hypothesis = 'test hypothesis'): InvestigationSeed {
  return {
    id: `seed:${source}`,
    hypothesis,
    source,
    category: 'kubernetes',
    priority: 80,
  };
}

// ---------------------------------------------------------------------------
// Fixture: multi-namespace-retrieval
//
// Loaded once for all tests in this file.
// Covers default, database, and monitoring namespaces.
// ---------------------------------------------------------------------------

const allResources: K8sResource[] = [];
const allEvents: K8sEvent[] = [];
let graph: ResourceRelationshipGraph = { nodes: new Map(), edges: [] };
let chunkIndex: IndexedChunk[] = [];

beforeAll(() => {
  // ── Resources (all namespaces) ────────────────────────────────────────────
  const namespaces = ['default', 'database', 'monitoring'];
  const resourceFiles = [
    ...namespaces.map((ns) => ({
      path: path.join(MULTI_NS_DIR, 'cluster-resources', 'pods', `${ns}.json`),
    })),
    ...namespaces.map((ns) => ({
      path: path.join(MULTI_NS_DIR, 'cluster-resources', 'deployments', `${ns}.json`),
    })),
    ...namespaces.map((ns) => ({
      path: path.join(MULTI_NS_DIR, 'cluster-resources', 'configmaps', `${ns}.json`),
    })),
    ...namespaces.map((ns) => ({
      path: path.join(MULTI_NS_DIR, 'cluster-resources', 'secrets', `${ns}.json`),
    })),
    { path: path.join(MULTI_NS_DIR, 'cluster-resources', 'persistentvolumeclaims', 'database.json') },
    { path: path.join(MULTI_NS_DIR, 'cluster-resources', 'persistentvolumeclaims', 'monitoring.json') },
  ];

  for (const { path: p } of resourceFiles) {
    if (fs.existsSync(p)) {
      allResources.push(...parseResourceJson(readJson(p)));
    }
  }

  // ── Events (all namespaces) ───────────────────────────────────────────────
  for (const ns of namespaces) {
    const eventsPath = path.join(
      MULTI_NS_DIR,
      'cluster-resources',
      'events',
      `${ns}.json`,
    );
    if (fs.existsSync(eventsPath)) {
      allEvents.push(...parseEventsJson(readJson(eventsPath)));
    }
  }

  // ── Build graph ───────────────────────────────────────────────────────────
  graph = buildResourceGraph(allResources, allEvents);

  // ── Build chunk index (no logs — graph tests don't need them) ────────────
  chunkIndex = buildChunkIndex({
    analyzerResults: [],
    resources: allResources,
    events: allEvents,
    logs: [],
    profile: makeMinimalProfile(),
  });
});

// ---------------------------------------------------------------------------
// Test suite 1: Pod seed → Secret/ConfigMap chunks from graph neighbourhood
//
// web-app-pod (default ns) references:
//   - web-app-config (ConfigMap, via envFrom.configMapRef)
//   - web-app-secret (Secret, via envFrom.secretRef)
//   - db-config (ConfigMap, via env[DB_HOST].valueFrom.configMapKeyRef)
//
// All three referenced resources exist in the multi-namespace fixture, so
// getRelatedChunks should surface their chunks.
// ---------------------------------------------------------------------------

describe('graph retrieval — Pod seed → Secret/ConfigMap neighborhood chunks', () => {
  let result: GraphScoredChunk[];

  beforeAll(() => {
    const seed = makeSeed(
      'pod:default/web-app-pod',
      'Pod web-app-pod is not ready — DNS resolution failure',
    );
    result = getRelatedChunks(graph, seed, chunkIndex);
  });

  it('returns at least one chunk', () => {
    expect(result.length).toBeGreaterThan(0);
  });

  it('returns the web-app-pod resource chunk itself', () => {
    const podChunk = result.find(
      (c) =>
        c.chunk.artifactCategory === 'kubernetes-resource' &&
        c.chunk.identifiers.includes('web-app-pod'),
    );
    expect(podChunk).toBeDefined();
  });

  it('returns the web-app-config ConfigMap chunk (referenced via envFrom)', () => {
    const cmChunk = result.find(
      (c) =>
        c.chunk.artifactCategory === 'kubernetes-resource' &&
        c.chunk.identifiers.includes('web-app-config'),
    );
    expect(cmChunk).toBeDefined();
  });

  it('returns the web-app-secret Secret chunk (referenced via envFrom)', () => {
    const secretChunk = result.find(
      (c) =>
        c.chunk.artifactCategory === 'kubernetes-resource' &&
        c.chunk.identifiers.includes('web-app-secret'),
    );
    expect(secretChunk).toBeDefined();
  });

  it('returns the db-config ConfigMap chunk (referenced via env.valueFrom.configMapKeyRef)', () => {
    const dbCmChunk = result.find(
      (c) =>
        c.chunk.artifactCategory === 'kubernetes-resource' &&
        c.chunk.identifiers.includes('db-config'),
    );
    expect(dbCmChunk).toBeDefined();
  });

  it('does NOT return the postgres-auth-secret Secret resource (not in web-app-pod neighbourhood)', () => {
    // postgres-auth-secret (Secret, database ns) is NOT referenced by
    // web-app-pod and is not reachable within 2 hops from it.
    //
    // Note: migration-pod (database ns) MAY appear because it references
    // db-config — the same ConfigMap that web-app-pod references — so
    // 'db-config' is in relevantNames and migration-pod passes the
    // hasNameMatch check.  That is acceptable (and expected) behaviour.
    //
    // What must NOT appear is the postgres-auth-secret Secret resource itself.
    const postgresAuthSecret = result.find(
      (c) =>
        c.chunk.artifactCategory === 'kubernetes-resource' &&
        typeof c.chunk.metadata === 'object' &&
        c.chunk.metadata !== null &&
        (c.chunk.metadata as Record<string, unknown>)['kind'] === 'Secret' &&
        (c.chunk.metadata as Record<string, unknown>)['name'] === 'postgres-auth-secret',
    );
    expect(postgresAuthSecret).toBeUndefined();
  });

  it('does NOT return monitoring namespace chunks unrelated to web-app-pod', () => {
    const monitoringNoise = result.filter(
      (c) =>
        c.chunk.namespace === 'monitoring' &&
        !c.chunk.identifiers.includes('web-app-pod'),
    );
    expect(monitoringNoise).toHaveLength(0);
  });

  it('results are deduplicated (no chunk appears twice)', () => {
    const ids = result.map((c) => c.chunk.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });
});

// ---------------------------------------------------------------------------
// Test suite 2: Pod seed from missing-secret-crashloop
//
// app-pod (default ns) references app-credentials secret via envFrom.
// The secret does NOT exist in the SecretList (that's the bug), but the
// graph edge is still created from the pod spec, and the pod chunk itself
// should be returned.
// ---------------------------------------------------------------------------

describe('graph retrieval — Pod seed for missing-secret app-pod', () => {
  let msGraph: ResourceRelationshipGraph;
  let msChunkIndex: IndexedChunk[];
  let result: GraphScoredChunk[];

  beforeAll(() => {
    const podsJson = readJson(
      path.join(MISSING_SECRET_DIR, 'cluster-resources', 'pods', 'default.json'),
    );
    const eventsJson = readJson(
      path.join(MISSING_SECRET_DIR, 'cluster-resources', 'events', 'default.json'),
    );
    const pods = parseResourceJson(podsJson);
    const events = parseEventsJson(eventsJson);

    msGraph = buildResourceGraph(pods, events);
    msChunkIndex = buildChunkIndex({
      analyzerResults: [],
      resources: pods,
      events,
      logs: [],
      profile: makeMinimalProfile(),
    });

    const seed = makeSeed(
      'pod:default/app-pod',
      'Pod app-pod is in CrashLoopBackOff — missing secret app-credentials',
    );
    result = getRelatedChunks(msGraph, seed, msChunkIndex);
  });

  it('returns at least one chunk', () => {
    expect(result.length).toBeGreaterThan(0);
  });

  it('returns the app-pod resource chunk', () => {
    const podChunk = result.find(
      (c) =>
        c.chunk.artifactCategory === 'kubernetes-resource' &&
        c.chunk.identifiers.includes('app-pod'),
    );
    expect(podChunk).toBeDefined();
  });

  it('returns event chunks associated with app-pod', () => {
    const eventChunk = result.find(
      (c) => c.chunk.artifactCategory === 'event' && c.chunk.identifiers.includes('app-pod'),
    );
    expect(eventChunk).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Test suite 3: Analyzer seed → returns related resource chunks
//
// SKIP — depends on step-14 (2.5):
//   Currently `getRelatedChunks` for kind='Analyzer' only returns the
//   analyzer chunk itself (via exact artifactId match).  It does NOT follow
//   graph relationships to surface resource chunks mentioned in the analyzer
//   message (e.g. 'web-app-pod', 'db-config').
//
//   After step-14, the implementation should:
//   1. Extract resource names from the analyzer message.
//   2. Walk the graph neighbourhood of those resources.
//   3. Return related pod/configmap/secret chunks.
// ---------------------------------------------------------------------------

describe('graph retrieval — Analyzer seed → related resource chunks (SKIPPED: needs step-14)', () => {
  let analyzerChunkIndex: IndexedChunk[];

  beforeAll(() => {
    const analysisJson = readJson(path.join(MULTI_NS_DIR, 'analysis.json'));
    const analyzerResults = parseAnalyzerJson(analysisJson);

    analyzerChunkIndex = buildChunkIndex({
      analyzerResults,
      resources: allResources,
      events: allEvents,
      logs: [],
      profile: makeMinimalProfile(),
    });
  });

  it(
    // step-14 (2.5): getRelatedChunks for Analyzer seeds now extracts entity
    //   names from the analyzer chunk content and walks the graph neighborhood.
    //
    //   For 'web-app-dns-failure':
    //     message: "Pod 'web-app-pod' in namespace 'default' cannot resolve
    //       'wrong-host.internal'. The ConfigMap 'db-config' in namespace
    //       'database' sets DB_HOST=wrong-host.internal ..."
    //
    //   After step-14: web-app-pod chunk AND db-config chunk are returned.
    'Analyzer seed for web-app-dns-failure returns the web-app-pod chunk',
    () => {
      const seed = makeSeed(
        'analyzer:web-app-dns-failure',
        'Web Application DNS Resolution Failure',
      );
      const result = getRelatedChunks(graph, seed, analyzerChunkIndex);
      const podChunk = result.find(
        (c) =>
          c.chunk.artifactCategory === 'kubernetes-resource' &&
          c.chunk.identifiers.includes('web-app-pod'),
      );
      expect(podChunk).toBeDefined();
    },
  );

  it(
    // step-14 (2.5): db-config ConfigMap chunk is returned as a graph neighbor
    //   of web-app-pod (which references db-config via env.valueFrom.configMapKeyRef).
    'Analyzer seed for web-app-dns-failure returns the db-config ConfigMap chunk',
    () => {
      const seed = makeSeed(
        'analyzer:web-app-dns-failure',
        'Web Application DNS Resolution Failure',
      );
      const result = getRelatedChunks(graph, seed, analyzerChunkIndex);
      const dbConfigChunk = result.find(
        (c) =>
          c.chunk.artifactCategory === 'kubernetes-resource' &&
          c.chunk.identifiers.includes('db-config'),
      );
      expect(dbConfigChunk).toBeDefined();
    },
  );

  it(
    // step-14 (2.5): for the OOM analyzer ('alertmanager-oom'), the
    //   alertmanager-pod chunk is returned via entity name extraction from
    //   the analyzer message.
    'Analyzer seed for alertmanager-oom returns the alertmanager-pod chunk',
    () => {
      const seed = makeSeed(
        'analyzer:alertmanager-oom',
        'Alertmanager OOMKilled',
      );
      const result = getRelatedChunks(graph, seed, analyzerChunkIndex);
      const podChunk = result.find(
        (c) =>
          c.chunk.artifactCategory === 'kubernetes-resource' &&
          c.chunk.identifiers.includes('alertmanager-pod'),
      );
      expect(podChunk).toBeDefined();
    },
  );

  it(
    // This test PASSES currently: the analyzer chunk for 'web-app-dns-failure'
    // is returned because its artifactId matches the seed name exactly.
    'Analyzer seed currently returns the analyzer chunk itself (baseline)',
    () => {
      const seed = makeSeed(
        'analyzer:web-app-dns-failure',
        'Web Application DNS Resolution Failure',
      );
      const result = getRelatedChunks(graph, seed, analyzerChunkIndex);
      const analyzerChunk = result.find(
        (c) => c.chunk.artifactCategory === 'analyzer' && c.chunk.artifactId === 'web-app-dns-failure',
      );
      expect(analyzerChunk).toBeDefined();
    },
  );
});

// ---------------------------------------------------------------------------
// Test suite 4: Hop-distance scoring (implemented in step-13)
//
// `getRelatedChunks` now returns GraphScoredChunk[] with hop-distance scores:
//   - depth-0 (seed resource itself): 1.0
//   - depth-1 (direct graph neighbors): 0.7
//   - depth-2 (two-hop neighbors): 0.4
// ---------------------------------------------------------------------------

describe('graph retrieval — hop-distance scoring', () => {
  it('direct references (hop-1: web-app-config, web-app-secret, db-config) score 0.7', () => {
    const seed = makeSeed('pod:default/web-app-pod');
    const result = getRelatedChunks(graph, seed, chunkIndex);

    // Direct references (hop 1): web-app-config, web-app-secret, db-config
    const directRefs = ['web-app-config', 'web-app-secret', 'db-config'];
    for (const name of directRefs) {
      const sc = result.find((c) => c.chunk.identifiers.includes(name));
      expect(sc).toBeDefined();
      // depth-1 neighbors score 0.7 (or 1.0 if also matched as depth-0 via node-id)
      expect(sc!.score).toBeGreaterThanOrEqual(0.7);
    }
  });

  it('web-app-pod chunk scores 1.0 (depth-0 seed resource)', () => {
    const seed = makeSeed('pod:default/web-app-pod');
    const result = getRelatedChunks(graph, seed, chunkIndex);

    const sc = result.find(
      (c) =>
        c.chunk.artifactCategory === 'kubernetes-resource' &&
        c.chunk.identifiers.includes('web-app-pod'),
    );
    expect(sc).toBeDefined();
    expect(sc!.score).toBe(1.0);
  });

  it('depth-0 seed resource scores higher than depth-1 neighbors', () => {
    const seed = makeSeed('pod:default/web-app-pod');
    const result = getRelatedChunks(graph, seed, chunkIndex);

    // Find the Pod chunk itself (depth-0): must match kind=Pod and name=web-app-pod in metadata
    const podSc = result.find(
      (c) =>
        c.chunk.artifactCategory === 'kubernetes-resource' &&
        typeof c.chunk.metadata === 'object' &&
        c.chunk.metadata !== null &&
        (c.chunk.metadata as Record<string, unknown>)['kind'] === 'Pod' &&
        (c.chunk.metadata as Record<string, unknown>)['name'] === 'web-app-pod',
    );
    // Find the ConfigMap chunk (depth-1): kind=ConfigMap and name=web-app-config in metadata
    // (cannot rely on identifiers alone since the Pod chunk also contains 'web-app-config'
    //  in its identifiers because the pod references the ConfigMap via envFrom)
    const configSc = result.find(
      (c) =>
        c.chunk.artifactCategory === 'kubernetes-resource' &&
        typeof c.chunk.metadata === 'object' &&
        c.chunk.metadata !== null &&
        (c.chunk.metadata as Record<string, unknown>)['kind'] === 'ConfigMap' &&
        (c.chunk.metadata as Record<string, unknown>)['name'] === 'web-app-config',
    );
    expect(podSc).toBeDefined();
    expect(configSc).toBeDefined();
    expect(podSc!.score).toBeGreaterThan(configSc!.score);
  });
});

// ---------------------------------------------------------------------------
// Test suite 5: RRF combined retrieval
//
//   Reciprocal Rank Fusion merges the lexical rank list and graph rank list
//   into a single ranked result.  Tests will assert that:
//   - RRF result for 'DNS failure wrong-host.internal' includes BOTH:
//     a) The log chunk (from lexical ranking)
//     b) The db-config ConfigMap chunk (from graph ranking via web-app-pod)
//   - No single high-scoring noise chunk dominates the combined result.
// ---------------------------------------------------------------------------

describe('graph retrieval — RRF combined result', () => {
  it(
    'combines the lexical DNS log with the graph-related db-config ConfigMap',
    async () => {
      const webAppLog = await parseLogFile(
        path.join(
          MULTI_NS_DIR,
          'cluster-resources',
          'pods',
          'logs',
          'default',
          'web-app-pod',
          'app.log',
        ),
      );
      const combinedChunkIndex = buildChunkIndex({
        analyzerResults: [],
        resources: allResources,
        events: allEvents,
        logs: [webAppLog],
        profile: makeMinimalProfile(),
      });
      const seed = makeSeed(
        'pod:default/web-app-pod',
        'DNS failure wrong-host.internal',
      );
      const graphResults = getRelatedChunks(graph, seed, combinedChunkIndex);
      const lexicalIndex = new LexicalSearchIndex();
      lexicalIndex.build(combinedChunkIndex);
      const lexicalResults = lexicalIndex.search(seed.hypothesis, 10);

      const merged = mergeChunks([
        {
          chunks: graphResults.map((result) => result.chunk),
          scores: graphResults.map((result) => result.score),
        },
        {
          chunks: lexicalResults.map((result) => result.chunk),
          scores: lexicalResults.map((result) => result.score),
        },
      ]);

      expect(
        merged.some(
          (chunk) =>
            chunk.artifactCategory === 'log' &&
            chunk.content.includes('wrong-host.internal'),
        ),
      ).toBe(true);
      expect(
        merged.some(
          (chunk) =>
            chunk.artifactCategory === 'kubernetes-resource' &&
            (chunk.metadata as Record<string, unknown>)['kind'] === 'ConfigMap' &&
            (chunk.metadata as Record<string, unknown>)['name'] === 'db-config',
        ),
      ).toBe(true);
    },
  );
});
