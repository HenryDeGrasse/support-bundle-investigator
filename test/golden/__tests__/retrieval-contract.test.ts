// ---------------------------------------------------------------------------
// Priority 1: Retrieval Contract Tests
// ---------------------------------------------------------------------------
//
// Tests that the retrieval pipeline (graph traversal + lexical search)
// delivers the RIGHT context for real scenarios. No LLM calls — this tests
// whether the evidence the LLM would receive is correct and complete.
//
// These are the single most valuable tests: if retrieval is wrong,
// everything downstream is wrong regardless of LLM quality.

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { analyzeBundlePipeline } from '../../../src/pipeline/analyze.js';
import type { PipelineResult } from '../../../src/pipeline/analyze.js';
import { buildChunkIndex } from '../../../src/ai/chunk-indexer.js';
import type { IndexedChunk } from '../../../src/ai/chunk-indexer.js';
import { LexicalSearchIndex } from '../../../src/ai/lexical-search.js';
import { buildResourceGraph, getRelatedChunks } from '../../../src/graph/resource-graph.js';
import { generateSeeds } from '../../../src/investigators/seed-generator.js';
import type { InvestigatorContext } from '../../../src/investigators/types.js';
import { createTestBundle, getFixturePath } from '../../helpers/create-test-bundle.js';

// ---------------------------------------------------------------------------
// Setup — build bundles and run pipeline once per scenario
// ---------------------------------------------------------------------------

let tmpDir: string;

interface ScenarioData {
  result: PipelineResult;
  chunks: IndexedChunk[];
  lexicalIndex: LexicalSearchIndex;
  resourceGraph: ReturnType<typeof buildResourceGraph>;
  context: InvestigatorContext;
}

const scenarios: Record<string, ScenarioData> = {};

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbi-retrieval-'));

  for (const scenario of ['bad-image-tag', 'missing-secret-crashloop', 'wrong-db-endpoint']) {
    const bundlePath = await createTestBundle(
      getFixturePath(scenario),
      path.join(tmpDir, `${scenario}.tar.gz`),
    );
    const result = await analyzeBundlePipeline(bundlePath, { noAi: true });

    const context: InvestigatorContext = {
      analyzerResults: result.analyzerResults,
      resources: result.resources,
      events: result.events,
      logs: result.logs,
      profile: result.profile,
    };

    const chunks = buildChunkIndex(context);
    const lexicalIndex = new LexicalSearchIndex();
    lexicalIndex.build(chunks);
    const resourceGraph = buildResourceGraph(result.resources, result.events);

    scenarios[scenario] = { result, chunks, lexicalIndex, resourceGraph, context };
  }
});

// ===========================================================================
// Bad Image Tag — graph retrieval
// ===========================================================================

describe('Retrieval Contract: bad-image-tag', () => {
  describe('graph retrieval for ImagePullBackOff seed', () => {
    it('graph retrieval for pod seed includes the pod chunk', () => {
      const { chunks, resourceGraph } = scenarios['bad-image-tag']!;
      const seeds = generateSeeds(scenarios['bad-image-tag']!.context);
      const podSeed = seeds.find((s) => s.source.startsWith('pod:'));
      expect(podSeed).toBeDefined();

      const graphChunks = getRelatedChunks(resourceGraph, podSeed!, chunks);
      const podChunk = graphChunks.find(
        (c) => c.artifactCategory === 'kubernetes-resource' && c.identifiers.includes('app-pod'),
      );
      expect(podChunk).toBeDefined();
    });

    it('graph retrieval for pod seed includes event chunks', () => {
      const { chunks, resourceGraph } = scenarios['bad-image-tag']!;
      const seeds = generateSeeds(scenarios['bad-image-tag']!.context);
      const podSeed = seeds.find((s) => s.source.startsWith('pod:'));

      const graphChunks = getRelatedChunks(resourceGraph, podSeed!, chunks);
      const eventChunks = graphChunks.filter((c) => c.artifactCategory === 'event');
      expect(eventChunks.length).toBeGreaterThan(0);
    });

    it('graph retrieval spans multiple artifact types', () => {
      const { chunks, resourceGraph } = scenarios['bad-image-tag']!;
      const seeds = generateSeeds(scenarios['bad-image-tag']!.context);
      const podSeed = seeds.find((s) => s.source.startsWith('pod:'));

      const graphChunks = getRelatedChunks(resourceGraph, podSeed!, chunks);
      const categories = new Set(graphChunks.map((c) => c.artifactCategory));
      expect(categories.size).toBeGreaterThanOrEqual(2);
    });
  });

  describe('lexical retrieval for ImagePullBackOff', () => {
    it('searching "ImagePullBackOff" returns pod status chunk', () => {
      const { lexicalIndex } = scenarios['bad-image-tag']!;
      const results = lexicalIndex.search('ImagePullBackOff', 10);
      const podHit = results.find((r) =>
        r.chunk.identifiers.includes('ImagePullBackOff'),
      );
      expect(podHit).toBeDefined();
    });

    it('searching "myapp:v999.99.99" returns chunks referencing the image tag', () => {
      const { lexicalIndex } = scenarios['bad-image-tag']!;
      const results = lexicalIndex.search('myapp:v999.99.99', 10);
      expect(results.length).toBeGreaterThan(0);
      const hasImageRef = results.some((r) =>
        r.chunk.content.includes('v999.99.99') || r.chunk.identifiers.includes('myapp:v999.99.99'),
      );
      expect(hasImageRef).toBe(true);
    });

    it('searching "ErrImagePull" returns event chunks', () => {
      const { lexicalIndex } = scenarios['bad-image-tag']!;
      const results = lexicalIndex.search('ErrImagePull', 10);
      const eventHit = results.find((r) => r.chunk.artifactCategory === 'event');
      expect(eventHit).toBeDefined();
    });
  });

  describe('merged context completeness', () => {
    it('merged graph + lexical context contains evidence from >= 3 artifact types', () => {
      const { chunks, resourceGraph, lexicalIndex } = scenarios['bad-image-tag']!;
      const seeds = generateSeeds(scenarios['bad-image-tag']!.context);
      const podSeed = seeds.find((s) => s.source.startsWith('pod:'));

      const graphChunks = getRelatedChunks(resourceGraph, podSeed!, chunks);
      const lexicalResults = lexicalIndex.search(podSeed!.hypothesis, 10);
      const lexicalChunks = lexicalResults.map((r) => r.chunk);

      // Merge and dedup
      const seen = new Set<string>();
      const merged: IndexedChunk[] = [];
      for (const c of [...graphChunks, ...lexicalChunks]) {
        if (!seen.has(c.id)) {
          seen.add(c.id);
          merged.push(c);
        }
      }

      const categories = new Set(merged.map((c) => c.artifactCategory));
      expect(categories.size).toBeGreaterThanOrEqual(3);
    });

    it('merged context includes the bad image tag string', () => {
      const { chunks, resourceGraph, lexicalIndex } = scenarios['bad-image-tag']!;
      const seeds = generateSeeds(scenarios['bad-image-tag']!.context);
      const podSeed = seeds.find((s) => s.source.startsWith('pod:'));

      const graphChunks = getRelatedChunks(resourceGraph, podSeed!, chunks);
      const lexicalResults = lexicalIndex.search(podSeed!.hypothesis, 10);
      const allContent = [...graphChunks, ...lexicalResults.map((r) => r.chunk)]
        .map((c) => c.content)
        .join('\n');

      expect(allContent).toContain('v999.99.99');
    });
  });
});

// ===========================================================================
// Missing Secret CrashLoop — graph retrieval
// ===========================================================================

describe('Retrieval Contract: missing-secret-crashloop', () => {
  describe('graph retrieval for CrashLoopBackOff seed', () => {
    it('graph retrieval for pod seed includes pod, events, and deployment', () => {
      const { chunks, resourceGraph } = scenarios['missing-secret-crashloop']!;
      const seeds = generateSeeds(scenarios['missing-secret-crashloop']!.context);
      const podSeed = seeds.find((s) => s.source.startsWith('pod:'));
      expect(podSeed).toBeDefined();

      const graphChunks = getRelatedChunks(resourceGraph, podSeed!, chunks);
      const categories = new Set(graphChunks.map((c) => c.artifactCategory));
      expect(categories.has('kubernetes-resource')).toBe(true);
      expect(categories.has('event')).toBe(true);
    });

    it('graph retrieval includes chunk referencing "app-credentials"', () => {
      const { chunks, resourceGraph } = scenarios['missing-secret-crashloop']!;
      const seeds = generateSeeds(scenarios['missing-secret-crashloop']!.context);
      const podSeed = seeds.find((s) => s.source.startsWith('pod:'));

      const graphChunks = getRelatedChunks(resourceGraph, podSeed!, chunks);
      const secretRef = graphChunks.some(
        (c) => c.content.includes('app-credentials') || c.identifiers.includes('app-credentials'),
      );
      expect(secretRef).toBe(true);
    });
  });

  describe('lexical retrieval for missing secret', () => {
    it('searching "app-credentials" returns relevant chunks', () => {
      const { lexicalIndex } = scenarios['missing-secret-crashloop']!;
      const results = lexicalIndex.search('app-credentials', 10);
      expect(results.length).toBeGreaterThan(0);
    });

    it('searching "FailedMount" returns event chunk', () => {
      const { lexicalIndex } = scenarios['missing-secret-crashloop']!;
      const results = lexicalIndex.search('FailedMount', 10);
      const eventHit = results.find((r) => r.chunk.artifactCategory === 'event');
      expect(eventHit).toBeDefined();
    });

    it('searching "CrashLoopBackOff" returns pod status chunk', () => {
      const { lexicalIndex } = scenarios['missing-secret-crashloop']!;
      const results = lexicalIndex.search('CrashLoopBackOff', 10);
      expect(results.length).toBeGreaterThan(0);
    });
  });
});

// ===========================================================================
// Wrong DB Endpoint — graph retrieval
// ===========================================================================

describe('Retrieval Contract: wrong-db-endpoint', () => {
  describe('lexical retrieval for DNS failure', () => {
    it('searching "db.internal" returns log or analyzer chunk', () => {
      const { lexicalIndex } = scenarios['wrong-db-endpoint']!;
      const results = lexicalIndex.search('db.internal', 10);
      expect(results.length).toBeGreaterThan(0);
      const hasDbRef = results.some((r) => r.chunk.content.includes('db.internal'));
      expect(hasDbRef).toBe(true);
    });

    it('searching "no such host" returns log chunk with DNS error', () => {
      const { lexicalIndex } = scenarios['wrong-db-endpoint']!;
      const results = lexicalIndex.search('no such host', 10);
      const logHit = results.find((r) => r.chunk.artifactCategory === 'log');
      expect(logHit).toBeDefined();
    });
  });

  describe('chunk index completeness', () => {
    it('chunk index covers all parsed artifact types', () => {
      const { chunks } = scenarios['wrong-db-endpoint']!;
      const categories = new Set(chunks.map((c) => c.artifactCategory));
      expect(categories.has('kubernetes-resource')).toBe(true);
      expect(categories.has('event')).toBe(true);
      expect(categories.has('log')).toBe(true);
      expect(categories.has('analyzer')).toBe(true);
    });

    it('every chunk has a non-empty summary', () => {
      const { chunks } = scenarios['wrong-db-endpoint']!;
      for (const chunk of chunks) {
        expect(chunk.summary.length).toBeGreaterThan(0);
      }
    });

    it('every chunk has at least one identifier', () => {
      const { chunks } = scenarios['wrong-db-endpoint']!;
      for (const chunk of chunks) {
        expect(chunk.identifiers.length).toBeGreaterThan(0);
      }
    });

    it('all chunk IDs are unique', () => {
      const { chunks } = scenarios['wrong-db-endpoint']!;
      const ids = chunks.map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });
});
