/**
 * Lexical retrieval precision/recall tests — Phase 2 quality gate.
 *
 * These tests exercise `LexicalSearchIndex` against realistic multi-namespace
 * fixture data, including the completed BM25 quality gate.
 *
 * Fixture sources:
 *   - `missing-secret-crashloop`  — app-pod + FailedMount event (signal)
 *   - `multi-namespace-retrieval` — monitoring namespace pods (noise)
 *
 * Step dependencies:
 *   - step-10 (2.7)  — fix overly aggressive stop-word list
 *   - step-11 (2.9)  — index ConfigMap/Secret data values
 *   - step-12 (2.1)  — replace TF with BM25 scoring
 *   - step-15 (2.2)  — Reciprocal Rank Fusion
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import { LexicalSearchIndex } from '../../../src/ai/lexical-search.js';
import { buildChunkIndex } from '../../../src/ai/chunk-indexer.js';
import type { IndexedChunk } from '../../../src/ai/chunk-indexer.js';
import { parseResourceJson } from '../../../src/parsers/k8s-resource-parser.js';
import { parseEventsJson } from '../../../src/parsers/event-parser.js';
import { parseLogFile } from '../../../src/parsers/log-parser.js';
import type { BundleProfile } from '../../../src/types/index.js';
import type { ArtifactCategory } from '../../../src/types/index.js';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const SCENARIOS = path.resolve(__dirname, '../../fixtures/scenarios');
const MISSING_SECRET_DIR = path.join(SCENARIOS, 'missing-secret-crashloop');
const MULTI_NS_DIR = path.join(SCENARIOS, 'multi-namespace-retrieval');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readJson(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8');
}

/**
 * Builds a minimal BundleProfile required by `InvestigatorContext`.
 * None of the lexical-search tests inspect profile fields.
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

// ---------------------------------------------------------------------------
// Fixture 1: Missing-secret scenario + monitoring namespace noise
//
// Signal:  app-pod (CrashLoopBackOff, references app-credentials secret)
//          FailedMount + BackOff events
//          app.log (secret-not-found error)
// Noise:   prometheus-pod, grafana-pod, alertmanager-pod (monitoring namespace)
// ---------------------------------------------------------------------------

let missingSecretChunks: IndexedChunk[] = [];

beforeAll(async () => {
  // ── Signal: missing-secret-crashloop resources ──────────────────────────
  const msPodsJson = readJson(
    path.join(MISSING_SECRET_DIR, 'cluster-resources', 'pods', 'default.json'),
  );
  const msEventsJson = readJson(
    path.join(MISSING_SECRET_DIR, 'cluster-resources', 'events', 'default.json'),
  );
  const msLogPath = path.join(
    MISSING_SECRET_DIR,
    'cluster-resources',
    'pods',
    'logs',
    'default',
    'app-pod',
    'app.log',
  );

  const msPods = parseResourceJson(msPodsJson);
  const msEvents = parseEventsJson(msEventsJson);
  const msLog = await parseLogFile(msLogPath);

  // ── Noise: monitoring namespace pods from multi-namespace-retrieval ──────
  const monitoringPodsJson = readJson(
    path.join(MULTI_NS_DIR, 'cluster-resources', 'pods', 'monitoring.json'),
  );
  const monitoringPods = parseResourceJson(monitoringPodsJson);

  missingSecretChunks = buildChunkIndex({
    analyzerResults: [],
    resources: [...msPods, ...monitoringPods],
    events: msEvents,
    logs: [msLog],
    profile: makeMinimalProfile(),
  });
});

// ---------------------------------------------------------------------------
// Fixture 2: DNS failure scenario (multi-namespace-retrieval default ns)
//
// Used by the SKIPPED DNS test — loaded here for documentation purposes.
// The full multi-namespace fixture provides signal + noise for DNS queries.
// ---------------------------------------------------------------------------

let dnsFixtureChunks: IndexedChunk[] = [];

beforeAll(async () => {
  const defaultPodsJson = readJson(
    path.join(MULTI_NS_DIR, 'cluster-resources', 'pods', 'default.json'),
  );
  const databaseCmsJson = readJson(
    path.join(MULTI_NS_DIR, 'cluster-resources', 'configmaps', 'database.json'),
  );
  const defaultCmsJson = readJson(
    path.join(MULTI_NS_DIR, 'cluster-resources', 'configmaps', 'default.json'),
  );
  const defaultEventsJson = readJson(
    path.join(MULTI_NS_DIR, 'cluster-resources', 'events', 'default.json'),
  );
  const webAppLogPath = path.join(
    MULTI_NS_DIR,
    'cluster-resources',
    'pods',
    'logs',
    'default',
    'web-app-pod',
    'app.log',
  );

  // Noise: monitoring pods
  const monitoringPodsJson = readJson(
    path.join(MULTI_NS_DIR, 'cluster-resources', 'pods', 'monitoring.json'),
  );

  const defaultPods = parseResourceJson(defaultPodsJson);
  const databaseCms = parseResourceJson(databaseCmsJson);
  const defaultCms = parseResourceJson(defaultCmsJson);
  const defaultEvents = parseEventsJson(defaultEventsJson);
  const webAppLog = await parseLogFile(webAppLogPath);
  const monitoringPods = parseResourceJson(monitoringPodsJson);

  dnsFixtureChunks = buildChunkIndex({
    analyzerResults: [],
    resources: [...defaultPods, ...databaseCms, ...defaultCms, ...monitoringPods],
    events: defaultEvents,
    logs: [webAppLog],
    profile: makeMinimalProfile(),
  });
});

// ---------------------------------------------------------------------------
// Test suite 1: 'missing secret app-credentials'
// ---------------------------------------------------------------------------

describe('lexical retrieval — missing secret app-credentials', () => {
  let index: LexicalSearchIndex;
  let top5: IndexedChunk[];

  beforeAll(() => {
    index = new LexicalSearchIndex();
    index.build(missingSecretChunks);
    top5 = index.search('missing secret app-credentials', 5).map((r) => r.chunk);
  });

  it('fixture has chunks from both signal and noise sources', () => {
    const hasAppPod = missingSecretChunks.some(
      (c) => c.identifiers.includes('app-pod') && c.artifactCategory === 'kubernetes-resource',
    );
    const hasMonitoringPod = missingSecretChunks.some(
      (c) => c.namespace === 'monitoring' && c.artifactCategory === 'kubernetes-resource',
    );
    expect(hasAppPod).toBe(true);
    expect(hasMonitoringPod).toBe(true);
  });

  it('top-5 includes the Pod chunk that references app-credentials', () => {
    const podChunk = top5.find(
      (c) =>
        c.artifactCategory === 'kubernetes-resource' &&
        c.identifiers.includes('app-credentials'),
    );
    expect(podChunk).toBeDefined();
    expect(podChunk!.identifiers).toContain('app-pod');
  });

  it('top-5 includes the FailedMount event chunk for app-pod', () => {
    const failedMountChunk = top5.find(
      (c) =>
        c.artifactCategory === 'event' &&
        c.identifiers.includes('FailedMount') &&
        c.identifiers.includes('app-pod'),
    );
    expect(failedMountChunk).toBeDefined();
  });

  it('top-5 does NOT include the healthy prometheus-pod from monitoring namespace', () => {
    // prometheus-pod is fully healthy (Ready=True) and has no connection to
    // app-credentials, so it must not appear.  grafana-pod is handled in the
    // skipped test below (it leaks in via 'secret' substring expansion until
    // step-10 tightens stop-word handling in content matching).
    const prometheusPod = top5.find(
      (c) =>
        c.namespace === 'monitoring' &&
        c.artifactCategory === 'kubernetes-resource' &&
        c.identifiers.includes('prometheus-pod'),
    );
    expect(prometheusPod).toBeUndefined();
  });

  it('top-5 does NOT include grafana-pod from monitoring namespace', () => {
    // step-10 (2.7): 'secret' in the query 'missing secret app-credentials'
    // must NOT expand via substring to 'secretKeyRef' in grafana-pod's JSON,
    // which would incorrectly surface grafana-pod as a match.
    // After the stop-word fix, substring expansion is suppressed for stop-word
    // query tokens, so only exact-token matches (e.g. in the FailedMount event
    // message "secret app-credentials not found") are returned.
    const grafanaPod = top5.find(
      (c) =>
        c.namespace === 'monitoring' &&
        c.artifactCategory === 'kubernetes-resource' &&
        c.identifiers.includes('grafana-pod'),
    );
    expect(grafanaPod).toBeUndefined();
  });

  it('Pod chunk referencing app-credentials ranks above monitoring pods', () => {
    const podChunkIdx = top5.findIndex(
      (c) => c.artifactCategory === 'kubernetes-resource' && c.identifiers.includes('app-credentials'),
    );
    const monitoringPodIdx = top5.findIndex((c) => c.namespace === 'monitoring');

    // If monitoring pods appear at all, they must rank below the signal pod
    if (monitoringPodIdx !== -1) {
      expect(podChunkIdx).toBeLessThan(monitoringPodIdx);
    }
    // Pod chunk itself must be found
    expect(podChunkIdx).toBeGreaterThanOrEqual(0);
  });

  it('top-5 results all have positive relevance scores', () => {
    const results = index.search('missing secret app-credentials', 5);
    for (const r of results) {
      expect(r.score).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Test suite 2: 'DNS failure wrong-host.internal'
//
// SKIP — depends on:
//   step-10 (2.7): stop-word fix so 'wrong-host' is not over-filtered
//   step-11 (2.9): ConfigMap data VALUE indexing so 'wrong-host.internal'
//                  surfaces the db-config ConfigMap chunk (currently only
//                  KEY names are indexed, not the value)
//
// With the current implementation, the ConfigMap chunk for db-config does NOT
// contain 'wrong-host.internal' in its indexed content — the summarizer
// only emits key names.  The query finds log chunks via content matching
// but cannot find the ConfigMap chunk until step-11 adds value indexing.
// ---------------------------------------------------------------------------

describe('lexical retrieval — DNS failure wrong-host.internal', () => {
  it(
    'top-5 includes the log chunk with DNS error',
    () => {
      const index = new LexicalSearchIndex();
      index.build(dnsFixtureChunks);
      const top5 = index.search('DNS failure wrong-host.internal', 5).map((r) => r.chunk);

      const logChunk = top5.find(
        (c) =>
          c.artifactCategory === 'log' &&
          c.content.includes('wrong-host.internal'),
      );
      expect(logChunk).toBeDefined();
    },
  );

  it(
    // step-11 (2.9): ConfigMap data values are now indexed so querying
    //   'wrong-host.internal' surfaces the db-config ConfigMap chunk.
    //   The chunk content is full JSON (includes DB_HOST value) and
    //   identifiers now include 'wrong-host.internal' extracted from data.
    'top-5 includes the ConfigMap chunk with DB_HOST: wrong-host.internal',
    () => {
      const index = new LexicalSearchIndex();
      index.build(dnsFixtureChunks);
      const top5 = index.search('DNS failure wrong-host.internal', 5).map((r) => r.chunk);

      const configMapChunk = top5.find(
        (c) =>
          c.artifactCategory === 'kubernetes-resource' &&
          c.identifiers.includes('db-config') &&
          // 'wrong-host.internal' appears in identifiers (step-11) and content (JSON)
          (c.content.includes('wrong-host.internal') ||
            c.identifiers.some((id) => id.includes('wrong-host'))),
      );
      expect(configMapChunk).toBeDefined();
    },
  );

  it(
    'top-5 does NOT include unrelated healthy monitoring pods',
    () => {
      const index = new LexicalSearchIndex();
      index.build(dnsFixtureChunks);
      const top5 = index.search('DNS failure wrong-host.internal', 5).map((r) => r.chunk);

      const healthyMonitoringPod = top5.find(
        (c) =>
          c.namespace === 'monitoring' &&
          c.identifiers.includes('prometheus-pod'),
      );
      expect(healthyMonitoringPod).toBeUndefined();
    },
  );
});

// ---------------------------------------------------------------------------
// Test suite 3: 'CrashLoopBackOff app-pod'
// ---------------------------------------------------------------------------

describe('lexical retrieval — CrashLoopBackOff app-pod', () => {
  let index: LexicalSearchIndex;
  let results: Array<{ chunk: IndexedChunk; score: number }>;

  beforeAll(() => {
    index = new LexicalSearchIndex();
    index.build(missingSecretChunks);
    results = index.search('CrashLoopBackOff app-pod', 10);
  });

  it('app-pod crash chunk ranks #1', () => {
    const top = results[0];
    expect(top).toBeDefined();
    expect(top!.chunk.identifiers).toContain('app-pod');
    expect(top!.chunk.identifiers).toContain('CrashLoopBackOff');
  });

  it('crash pod chunk has the highest score', () => {
    const crashScore = results[0]!.score;
    expect(crashScore).toBeGreaterThan(0);
    // Crash pod has TWO identifier matches (CrashLoopBackOff + app-pod) ≥ 6.0
    // so it must outrank any single-identifier match
    expect(crashScore).toBeGreaterThanOrEqual(6.0);
  });

  it('healthy monitoring pods (same app label structure) do NOT appear in top-5', () => {
    const top5 = results.slice(0, 5).map((r) => r.chunk);
    const healthyMonitoringPods = top5.filter(
      (c) =>
        c.namespace === 'monitoring' &&
        (c.identifiers.includes('prometheus-pod') ||
          c.identifiers.includes('grafana-pod') ||
          c.identifiers.includes('alertmanager-pod')),
    );
    expect(healthyMonitoringPods).toHaveLength(0);
  });

  it('crash pod chunk outscores any monitoring pod chunk', () => {
    const crashResult = results.find(
      (r) =>
        r.chunk.identifiers.includes('app-pod') &&
        r.chunk.identifiers.includes('CrashLoopBackOff'),
    );
    expect(crashResult).toBeDefined();

    const monitoringResults = results.filter((r) => r.chunk.namespace === 'monitoring');
    for (const monResult of monitoringResults) {
      expect(crashResult!.score).toBeGreaterThan(monResult.score);
    }
  });

  it('top results have strictly positive scores', () => {
    for (const r of results) {
      expect(r.score).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Test suite 4: BM25 scoring quality gate
//
// BM25 normalises term frequency by document length so that long chunks
// (e.g. full JSON resources) don't dominate short, precise error messages.
// ---------------------------------------------------------------------------

describe('lexical retrieval — BM25 scoring', () => {
  it(
    'ranks a short dense match above a long sparse match',
    () => {
      const shortDenseChunk: IndexedChunk = {
        id: 'test:bm25-short-dense',
        artifactId: 'events/short.txt',
        artifactCategory: 'event',
        startLine: 1,
        endLine: 1,
        summary: 'Short dense match',
        identifiers: [],
        content: 'app-credentials app-credentials mount failed',
      };
      const longSparseChunk: IndexedChunk = {
        id: 'test:bm25-long-sparse',
        artifactId: 'resources/long.json',
        artifactCategory: 'kubernetes-resource',
        startLine: 1,
        endLine: 1,
        summary: 'Long sparse match',
        identifiers: [],
        content: `app-credentials ${'unrelated configuration '.repeat(250)}`,
      };
      const index = new LexicalSearchIndex();
      index.build([longSparseChunk, shortDenseChunk]);

      const results = index.search('app-credentials', 2);
      expect(results.map((result) => result.chunk.id)).toEqual([
        shortDenseChunk.id,
        longSparseChunk.id,
      ]);
      expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
    },
  );
});
