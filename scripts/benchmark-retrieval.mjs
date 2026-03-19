#!/usr/bin/env node
/**
 * scripts/benchmark-retrieval.mjs
 *
 * Retrieval quality benchmark — regression gate for retrieval refactors.
 *
 * For each diagnostic scenario, runs the lexical and graph retrieval pipelines
 * against hand-crafted seed queries, compares the results against a ground-
 * truth relevance oracle, and reports precision@5, recall@5, and MRR.
 *
 * Usage (requires a prior build):
 *   npm run build
 *   node scripts/benchmark-retrieval.mjs
 *
 * Output: per-seed stats table + per-scenario summary + overall macro-averages.
 *
 * NOTE — this script imports from dist/index.mjs (the compiled bundle).
 *        Run `npm run build` before executing it.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const distEntry = path.join(repoRoot, 'dist', 'index.mjs');

// ---------------------------------------------------------------------------
// Guard: require a build
// ---------------------------------------------------------------------------

if (!fs.existsSync(distEntry)) {
  console.error(
    `Build output not found at dist/index.mjs.\nRun \`npm run build\` first.`,
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Dynamic imports from the compiled bundle
// ---------------------------------------------------------------------------

const {
  buildChunkIndex,
  LexicalSearchIndex,
  computeRetrievalMetrics,
  aggregateRetrievalMetrics,
  buildResourceGraph,
  getRelatedChunks,
  parseResourceJson,
  parseEventsJson,
  parseLogFile,
} = await import(distEntry);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Minimal BundleProfile required by buildChunkIndex.
 * None of the retrieval functions inspect profile fields beyond shape checks.
 */
function makeMinimalProfile() {
  const cats = {
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

/**
 * Reads and parses all resource JSON files in the given directory.
 * Returns a flat array of K8sResource objects.
 */
function loadResources(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  const files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.json'));
  const resources = [];
  for (const f of files) {
    try {
      const raw = fs.readFileSync(path.join(dirPath, f), 'utf-8');
      resources.push(...parseResourceJson(raw));
    } catch {
      // ignore parse errors for individual files
    }
  }
  return resources;
}

/**
 * Reads and parses all event JSON files in the given directory.
 */
function loadEvents(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  const files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.json'));
  const events = [];
  for (const f of files) {
    try {
      const raw = fs.readFileSync(path.join(dirPath, f), 'utf-8');
      events.push(...parseEventsJson(raw));
    } catch {
      // ignore parse errors
    }
  }
  return events;
}

/**
 * Recursively finds all .log files under a directory.
 */
function findLogFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...findLogFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.log')) {
      result.push(full);
    }
  }
  return result;
}

/** Formats a float as a right-aligned fixed-decimal string. */
function fmt(value, width = 6, decimals = 3) {
  return value.toFixed(decimals).padStart(width);
}

// ---------------------------------------------------------------------------
// Scenario definitions
// ---------------------------------------------------------------------------
//
// Each scenario defines:
//   - `name`  — directory name under test/fixtures/scenarios/
//   - `seeds` — array of seed queries to evaluate
//
// Each seed defines:
//   - `description` — human-readable label
//   - `query`        — the hypothesis text used for lexical search
//   - `source`       — seed source string used by graph retrieval (kind:ns/name)
//   - `relevanceOracle` — function(chunk): boolean — true when a chunk is
//                         "ground-truth relevant" for this seed

const SCENARIOS_DIR = path.join(repoRoot, 'test', 'fixtures', 'scenarios');

const SCENARIOS = [
  {
    name: 'missing-secret-crashloop',
    seeds: [
      {
        description: 'Pod in CrashLoopBackOff — missing secret app-credentials',
        query: 'Pod app-pod CrashLoopBackOff missing secret app-credentials',
        source: 'pod:default/app-pod',
        /** Expected: pod chunk, FailedMount event, log chunk with secret error */
        relevanceOracle: (chunk) => {
          const ids = chunk.identifiers ?? [];
          const content = chunk.content ?? '';
          // Pod chunk referencing app-credentials
          if (
            chunk.artifactCategory === 'kubernetes-resource' &&
            ids.includes('app-pod') &&
            ids.includes('app-credentials')
          ) return true;
          // FailedMount event targeting app-pod
          if (
            chunk.artifactCategory === 'event' &&
            ids.includes('FailedMount') &&
            ids.includes('app-pod')
          ) return true;
          // Log chunk with secret error
          if (
            chunk.artifactCategory === 'log' &&
            content.includes('app-credentials')
          ) return true;
          return false;
        },
      },
    ],
  },
  {
    name: 'bad-image-tag',
    seeds: [
      {
        description: 'Pod in ErrImagePull — bad image tag myapp:bad-tag-xyz',
        query: 'Pod app-pod ErrImagePull ImagePullBackOff myapp bad-tag-xyz',
        source: 'pod:default/app-pod',
        /** Expected: pod chunk, ErrImagePull event, log chunk with image error */
        relevanceOracle: (chunk) => {
          const ids = chunk.identifiers ?? [];
          const content = chunk.content ?? '';
          // Pod chunk
          if (
            chunk.artifactCategory === 'kubernetes-resource' &&
            ids.includes('app-pod') &&
            (ids.includes('ErrImagePull') || ids.includes('ImagePullBackOff') || ids.includes('myapp:bad-tag-xyz'))
          ) return true;
          // Image pull error events
          if (
            chunk.artifactCategory === 'event' &&
            ids.includes('app-pod') &&
            (ids.includes('ErrImagePull') || ids.includes('Failed'))
          ) return true;
          // Log chunk with image error
          if (
            chunk.artifactCategory === 'log' &&
            (content.includes('ErrImagePull') || content.includes('bad-tag-xyz'))
          ) return true;
          return false;
        },
      },
    ],
  },
  {
    name: 'wrong-db-endpoint',
    seeds: [
      {
        description: 'Pod failing DNS resolution for db.internal',
        query: 'Pod app-pod DNS failure db.internal connection refused',
        source: 'pod:default/app-pod',
        /** Expected: pod chunk, Unhealthy event, log chunk with DNS error */
        relevanceOracle: (chunk) => {
          const ids = chunk.identifiers ?? [];
          const content = chunk.content ?? '';
          // Pod chunk
          if (
            chunk.artifactCategory === 'kubernetes-resource' &&
            ids.includes('app-pod')
          ) return true;
          // Unhealthy or BackOff events for app-pod
          if (
            chunk.artifactCategory === 'event' &&
            ids.includes('app-pod') &&
            (ids.includes('Unhealthy') || ids.includes('BackOff'))
          ) return true;
          // Log chunk with DNS lookup error
          if (
            chunk.artifactCategory === 'log' &&
            (content.includes('no such host') || content.includes('lookup db.internal') || content.includes('db.internal'))
          ) return true;
          return false;
        },
      },
    ],
  },
  {
    name: 'pvc-pending',
    seeds: [
      {
        description: 'Pod stuck pending — PVC not bound (data-pvc)',
        query: 'Pod db-pod pending FailedScheduling volume data-pvc not bound',
        source: 'pod:default/db-pod',
        /** Expected: pod chunk, PVC chunk, FailedMount/ProvisioningFailed events */
        relevanceOracle: (chunk) => {
          const ids = chunk.identifiers ?? [];
          const content = chunk.content ?? '';
          // Pod chunk
          if (
            chunk.artifactCategory === 'kubernetes-resource' &&
            ids.includes('db-pod')
          ) return true;
          // PVC chunk
          if (
            chunk.artifactCategory === 'kubernetes-resource' &&
            ids.includes('data-pvc')
          ) return true;
          // FailedScheduling, FailedMount, ProvisioningFailed events
          if (
            chunk.artifactCategory === 'event' &&
            (ids.includes('FailedMount') || ids.includes('FailedScheduling') || ids.includes('ProvisioningFailed'))
          ) return true;
          // Log chunk with volume error
          if (
            chunk.artifactCategory === 'log' &&
            (content.includes('data-pvc') || content.includes('data directory') || content.includes('volume not available'))
          ) return true;
          return false;
        },
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Run a single scenario
// ---------------------------------------------------------------------------

async function runScenario(scenario) {
  const scenarioDir = path.join(SCENARIOS_DIR, scenario.name);

  // ── Load fixture data ────────────────────────────────────────────────────

  const resourceDirs = [
    path.join(scenarioDir, 'cluster-resources', 'pods'),
    path.join(scenarioDir, 'cluster-resources', 'deployments'),
    path.join(scenarioDir, 'cluster-resources', 'secrets'),
    path.join(scenarioDir, 'cluster-resources', 'configmaps'),
    path.join(scenarioDir, 'cluster-resources', 'persistentvolumeclaims'),
    path.join(scenarioDir, 'cluster-resources', 'storageclasses'),
    path.join(scenarioDir, 'cluster-resources', 'services'),
  ];

  const resources = resourceDirs.flatMap(loadResources);
  const events = loadEvents(path.join(scenarioDir, 'cluster-resources', 'events'));

  const logPaths = findLogFiles(path.join(scenarioDir, 'cluster-resources', 'pods', 'logs'));
  const logs = await Promise.all(logPaths.map((p) => parseLogFile(p)));

  // ── Build chunk index and retrieval structures ───────────────────────────

  const profile = makeMinimalProfile();
  const chunkIndex = buildChunkIndex({ analyzerResults: [], resources, events, logs, profile });
  const resourceGraph = buildResourceGraph(resources, events);

  const lexIndex = new LexicalSearchIndex();
  lexIndex.build(chunkIndex);

  // ── Evaluate each seed ────────────────────────────────────────────────────

  const seedResults = [];

  for (const seed of scenario.seeds) {
    // Ground truth: collect expected chunk IDs from the oracle
    const expectedIds = chunkIndex
      .filter((chunk) => seed.relevanceOracle(chunk))
      .map((chunk) => chunk.id);

    if (expectedIds.length === 0) {
      console.warn(
        `  [WARN] Scenario '${scenario.name}' seed '${seed.description}': ` +
          `relevance oracle matched 0 chunks — check fixture or oracle logic.`,
      );
    }

    // ── Lexical retrieval ──────────────────────────────────────────────────
    const lexResults = lexIndex.search(seed.query, 10);
    const lexIds = lexResults.map((r) => r.chunk.id);
    const lexMetrics = computeRetrievalMetrics(lexIds, expectedIds, 5);

    // ── Graph retrieval ────────────────────────────────────────────────────
    const graphSeed = {
      id: `seed:${seed.source}`,
      hypothesis: seed.query,
      source: seed.source,
      category: 'kubernetes',
      priority: 80,
    };
    const graphResults = getRelatedChunks(resourceGraph, graphSeed, chunkIndex);
    const graphIds = graphResults
      .sort((a, b) => b.score - a.score)
      .map((r) => r.chunk.id);
    const graphMetrics = computeRetrievalMetrics(graphIds, expectedIds, 5);

    seedResults.push({
      description: seed.description,
      expectedCount: expectedIds.length,
      lex: lexMetrics,
      graph: graphMetrics,
    });
  }

  return { name: scenario.name, seeds: seedResults };
}

// ---------------------------------------------------------------------------
// Table rendering
// ---------------------------------------------------------------------------

function padEnd(str, len) {
  return String(str).padEnd(len);
}

function padStart(str, len) {
  return String(str).padStart(len);
}

function printSeedTable(rows) {
  const COL = {
    scenario: 26,
    seed: 44,
    method: 7,
    expected: 8,
    p5: 7,
    r5: 7,
    mrr: 7,
    hits: 5,
  };

  const header = [
    padEnd('scenario', COL.scenario),
    padEnd('seed', COL.seed),
    padEnd('method', COL.method),
    padStart('expected', COL.expected),
    padStart('P@5', COL.p5),
    padStart('R@5', COL.r5),
    padStart('MRR', COL.mrr),
    padStart('hits', COL.hits),
  ].join('  ');

  const sep = '-'.repeat(header.length);

  console.log(header);
  console.log(sep);

  for (const row of rows) {
    for (const [methodLabel, m] of row.methods) {
      console.log(
        [
          padEnd(row.scenario, COL.scenario),
          padEnd(row.seed.slice(0, COL.seed - 3) + (row.seed.length > COL.seed - 3 ? '...' : ''), COL.seed),
          padEnd(methodLabel, COL.method),
          padStart(String(row.expected), COL.expected),
          padStart(m.precisionAtK.toFixed(3), COL.p5),
          padStart(m.recallAtK.toFixed(3), COL.r5),
          padStart(m.mrr.toFixed(3), COL.mrr),
          padStart(String(m.hitsAtK), COL.hits),
        ].join('  '),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  console.log('=== Retrieval Quality Benchmark ===\n');
  console.log(`Scenarios: ${SCENARIOS.map((s) => s.name).join(', ')}`);
  console.log(`Metric cutoff: k=5\n`);

  const allLexMetrics = [];
  const allGraphMetrics = [];
  const tableRows = [];

  for (const scenario of SCENARIOS) {
    let result;
    try {
      result = await runScenario(scenario);
    } catch (err) {
      console.error(`  [ERROR] Scenario '${scenario.name}' failed: ${err.message}`);
      continue;
    }

    for (const seedResult of result.seeds) {
      allLexMetrics.push(seedResult.lex);
      allGraphMetrics.push(seedResult.graph);

      tableRows.push({
        scenario: scenario.name,
        seed: seedResult.description,
        expected: seedResult.expectedCount,
        methods: [
          ['lexical', seedResult.lex],
          ['graph', seedResult.graph],
        ],
      });
    }
  }

  // ── Per-seed table ────────────────────────────────────────────────────────

  console.log('--- Per-seed retrieval metrics ---\n');
  printSeedTable(tableRows);

  // ── Summary report ────────────────────────────────────────────────────────

  const lexAgg = aggregateRetrievalMetrics(allLexMetrics);
  const graphAgg = aggregateRetrievalMetrics(allGraphMetrics);

  console.log('\n--- Summary (macro-averaged across all seeds) ---\n');

  const sumHeader = [
    'method'.padEnd(10),
    'queries'.padStart(8),
    'P@5'.padStart(8),
    'R@5'.padStart(8),
    'MRR'.padStart(8),
    'hits/q'.padStart(8),
  ].join('  ');
  console.log(sumHeader);
  console.log('-'.repeat(sumHeader.length));

  for (const [label, agg] of [['lexical', lexAgg], ['graph', graphAgg]]) {
    console.log(
      [
        label.padEnd(10),
        String(agg.queryCount).padStart(8),
        agg.precisionAtK.toFixed(3).padStart(8),
        agg.recallAtK.toFixed(3).padStart(8),
        agg.mrr.toFixed(3).padStart(8),
        agg.meanHitsAtK.toFixed(2).padStart(8),
      ].join('  '),
    );
  }

  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
