import { describe, it, expect, beforeEach } from 'vitest';
import { LexicalSearchIndex } from '../lexical-search.js';
import type { ScoredChunk } from '../lexical-search.js';
import type { IndexedChunk } from '../chunk-indexer.js';
import type { ArtifactCategory } from '../../types/index.js';

// ---------------------------------------------------------------------------
// Minimal IndexedChunk factory
// ---------------------------------------------------------------------------

let _idCounter = 0;

function makeChunk(overrides: Partial<IndexedChunk> & { id?: string }): IndexedChunk {
  _idCounter++;
  return {
    id: overrides.id ?? `chunk-${_idCounter}`,
    artifactId: overrides.artifactId ?? '/test/resource.json',
    content: overrides.content ?? 'some content',
    startLine: overrides.startLine ?? 1,
    endLine: overrides.endLine ?? 5,
    summary: overrides.summary ?? 'Test chunk summary',
    identifiers: overrides.identifiers ?? [],
    namespace: overrides.namespace,
    artifactCategory: overrides.artifactCategory ?? ('kubernetes-resource' as ArtifactCategory),
    timestamp: overrides.timestamp,
  };
}

/** A pod resource chunk for a named pod in a given namespace. */
function makePodChunk(name: string, namespace = 'default'): IndexedChunk {
  return makeChunk({
    id: `pod:${namespace}:${name}`,
    artifactId: `cluster-resources/pods/${namespace}/${name}.json`,
    content: `apiVersion: v1\nkind: Pod\nmetadata:\n  name: ${name}\n  namespace: ${namespace}\nstatus:\n  phase: Running`,
    identifiers: [name, namespace, 'app', 'Running'],
    namespace,
    artifactCategory: 'kubernetes-resource',
    summary: `Pod ${name} in namespace ${namespace}`,
  });
}

/** A pod chunk with CrashLoopBackOff in identifiers and content. */
function makeCrashPodChunk(name: string, namespace = 'default'): IndexedChunk {
  return makeChunk({
    id: `pod:${namespace}:${name}:crash`,
    artifactId: `cluster-resources/pods/${namespace}/${name}.json`,
    content: `apiVersion: v1\nkind: Pod\nmetadata:\n  name: ${name}\n  namespace: ${namespace}\nstatus:\n  containerStatuses:\n    - state:\n        waiting:\n          reason: CrashLoopBackOff`,
    identifiers: [name, namespace, 'CrashLoopBackOff', 'ContainersNotReady'],
    namespace,
    artifactCategory: 'kubernetes-resource',
    summary: `Pod ${name} in CrashLoopBackOff`,
  });
}

/** A log chunk that mentions a pod name only in content, not in identifiers. */
function makeLogChunk(content: string, path = '/logs/app.log'): IndexedChunk {
  return makeChunk({
    id: `log:${path}:1`,
    artifactId: path,
    content,
    identifiers: ['ERROR', 'FATAL'],
    artifactCategory: 'log',
    summary: `Log chunk from ${path}`,
  });
}

/** An analyzer result chunk. */
function makeAnalyzerChunk(name: string, message: string): IndexedChunk {
  return makeChunk({
    id: `analyzer:${name}`,
    artifactId: 'analyzer/results.json',
    content: `Analyzer: ${name}\nMessage: ${message}`,
    identifiers: [name, 'error'],
    artifactCategory: 'analyzer',
    summary: `Analyzer: ${name}`,
  });
}

/** A ConfigMap chunk with a specific data key. */
function makeConfigMapChunk(name: string, namespace = 'default', dataKeys: string[] = []): IndexedChunk {
  return makeChunk({
    id: `configmap:${namespace}:${name}`,
    artifactId: `cluster-resources/configmaps/${namespace}/${name}.json`,
    content: `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: ${name}\n  namespace: ${namespace}\ndata:\n${dataKeys.map((k) => `  ${k}: value`).join('\n')}`,
    identifiers: [name, namespace, ...dataKeys],
    namespace,
    artifactCategory: 'kubernetes-resource',
    summary: `ConfigMap ${name} in namespace ${namespace}`,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function chunkIds(results: ScoredChunk[]): string[] {
  return results.map((r) => r.chunk.id);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LexicalSearchIndex — build and structure', () => {
  it('builds without error given an empty chunk array', () => {
    const index = new LexicalSearchIndex();
    expect(() => index.build([])).not.toThrow();
  });

  it('builds without error given a mixed set of chunks', () => {
    const index = new LexicalSearchIndex();
    expect(() =>
      index.build([
        makePodChunk('api-pod', 'default'),
        makeCrashPodChunk('crash-pod', 'default'),
        makeLogChunk('ERROR connection refused'),
        makeAnalyzerChunk('image-check', 'Image tag missing'),
      ]),
    ).not.toThrow();
  });

  it('calling build a second time replaces the previous index', () => {
    const index = new LexicalSearchIndex();
    index.build([makePodChunk('old-pod', 'default')]);
    index.build([makePodChunk('new-pod', 'staging')]);

    // old-pod should no longer be found
    const oldResults = index.search('old-pod', 10);
    expect(oldResults).toHaveLength(0);

    // new-pod should be found
    const newResults = index.search('new-pod', 10);
    expect(newResults.length).toBeGreaterThan(0);
    expect(newResults[0]!.chunk.id).toBe('pod:staging:new-pod');
  });
});

// ---------------------------------------------------------------------------
// Empty-index and no-match edge cases
// ---------------------------------------------------------------------------

describe('LexicalSearchIndex — empty / no-match', () => {
  let index: LexicalSearchIndex;

  beforeEach(() => {
    index = new LexicalSearchIndex();
  });

  it('returns empty array when index is empty', () => {
    expect(index.search('app-pod', 10)).toEqual([]);
  });

  it('returns empty array when topK is 0', () => {
    index.build([makePodChunk('app-pod')]);
    expect(index.search('app-pod', 0)).toEqual([]);
  });

  it('returns empty array when no chunk matches the query', () => {
    index.build([makePodChunk('api-server', 'default')]);
    const results = index.search('zzz-nonexistent-xyzzy', 10);
    expect(results).toEqual([]);
  });

  it('returns at most topK results', () => {
    // 5 pods, each matching 'app'
    index.build([
      makePodChunk('app-1'),
      makePodChunk('app-2'),
      makePodChunk('app-3'),
      makePodChunk('app-4'),
      makePodChunk('app-5'),
    ]);
    const results = index.search('app', 3);
    expect(results.length).toBeLessThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// Exact identifier retrieval
// ---------------------------------------------------------------------------

describe('LexicalSearchIndex — exact identifier retrieval', () => {
  it('searching by exact pod name returns the pod chunk', () => {
    const index = new LexicalSearchIndex();
    index.build([
      makePodChunk('app-pod', 'default'),
      makePodChunk('other-service', 'default'),
      makeLogChunk('2024-01-01 INFO app started'),
    ]);

    const results = index.search('app-pod', 10);
    const ids = chunkIds(results);
    expect(ids).toContain('pod:default:app-pod');
  });

  it('the pod chunk ranks first when searching its exact name', () => {
    const index = new LexicalSearchIndex();
    index.build([
      makePodChunk('api-server', 'default'),
      makeLogChunk('api-server error occurred connecting to endpoint'),
    ]);

    const results = index.search('api-server', 10);
    expect(results[0]!.chunk.id).toBe('pod:default:api-server');
  });

  it('searching CrashLoopBackOff returns crash pod chunk', () => {
    const index = new LexicalSearchIndex();
    index.build([
      makePodChunk('healthy-pod'),
      makeCrashPodChunk('crash-pod', 'default'),
    ]);

    const results = index.search('CrashLoopBackOff', 10);
    const ids = chunkIds(results);
    expect(ids).toContain('pod:default:crash-pod:crash');
    // healthy pod should not appear (or rank much lower)
    if (ids.includes('pod:default:healthy-pod')) {
      const crashScore = results.find((r) => r.chunk.id === 'pod:default:crash-pod:crash')!.score;
      const healthyScore = results.find((r) => r.chunk.id === 'pod:default:healthy-pod')!.score;
      expect(crashScore).toBeGreaterThan(healthyScore);
    }
  });

  it('searching a secret name returns the resource chunk that references it', () => {
    const secretChunk = makeChunk({
      id: 'pod:default:app-pod:secrets',
      content: 'kind: Pod referencing secretName: db-secret',
      identifiers: ['app-pod', 'db-secret', 'default'],
      namespace: 'default',
      artifactCategory: 'kubernetes-resource',
      summary: 'Pod with secret ref',
    });
    const unrelatedChunk = makePodChunk('unrelated-pod');

    const index = new LexicalSearchIndex();
    index.build([secretChunk, unrelatedChunk]);

    const results = index.search('db-secret', 10);
    expect(results[0]!.chunk.id).toBe('pod:default:app-pod:secrets');
  });

  it('searching a configmap name returns the configmap chunk', () => {
    const index = new LexicalSearchIndex();
    index.build([
      makeConfigMapChunk('app-config', 'default', ['DB_HOST', 'DB_PORT']),
      makePodChunk('some-pod'),
    ]);

    const results = index.search('app-config', 10);
    expect(results[0]!.chunk.id).toBe('configmap:default:app-config');
  });

  it('searching an image tag returns the chunk referencing that image', () => {
    const imageChunk = makeChunk({
      id: 'pod:default:image-pod',
      content: 'image: myrepo/app:v2.0.0',
      identifiers: ['image-pod', 'myrepo/app:v2.0.0', 'myrepo/app', 'v2.0.0'],
      namespace: 'default',
      artifactCategory: 'kubernetes-resource',
      summary: 'Pod running myrepo/app:v2.0.0',
    });

    const index = new LexicalSearchIndex();
    index.build([imageChunk, makePodChunk('other-pod')]);

    const results = index.search('myrepo/app:v2.0.0', 10);
    expect(results[0]!.chunk.id).toBe('pod:default:image-pod');
  });
});

// ---------------------------------------------------------------------------
// Namespace-scoped filtering
// ---------------------------------------------------------------------------

describe('LexicalSearchIndex — namespace-scoped filtering', () => {
  it('namespace mention boosts chunks from matching namespace above others', () => {
    const index = new LexicalSearchIndex();
    const defaultPod = makePodChunk('app-pod', 'default');
    const stagingPod = makePodChunk('app-pod', 'staging');

    index.build([defaultPod, stagingPod]);

    // Both pods share the same name; "staging" in query should boost staging pod
    const results = index.search('app-pod in staging', 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.chunk.namespace).toBe('staging');
  });

  it('namespace-only query returns chunks from that namespace', () => {
    const index = new LexicalSearchIndex();
    const prodPod = makePodChunk('api-server', 'production');
    const devPod = makePodChunk('api-server', 'development');

    index.build([prodPod, devPod]);

    const results = index.search('production', 10);
    const ids = chunkIds(results);
    expect(ids).toContain('pod:production:api-server');
  });

  it('chunks from non-queried namespace rank lower', () => {
    const index = new LexicalSearchIndex();
    const prodPod = makePodChunk('web-app', 'production');
    const devPod = makePodChunk('web-app', 'development');

    index.build([prodPod, devPod]);
    const results = index.search('web-app production', 10);

    // production pod should appear first
    expect(results[0]!.chunk.namespace).toBe('production');
  });

  it('chunks with matching namespace have higher score than those without', () => {
    const index = new LexicalSearchIndex();
    const nsMatchChunk = makePodChunk('service-x', 'kube-system');
    const noNsChunk = makeLogChunk('service-x error occurred', '/logs/service-x.log');

    index.build([nsMatchChunk, noNsChunk]);

    const results = index.search('service-x kube-system', 10);
    const nsMatch = results.find((r) => r.chunk.id === 'pod:kube-system:service-x');
    expect(nsMatch).toBeDefined();
    expect(nsMatch!.score).toBeGreaterThan(WEIGHT_CONTENT);
  });
});

// ---------------------------------------------------------------------------
// Content token matching
// ---------------------------------------------------------------------------

describe('LexicalSearchIndex — content token matching', () => {
  it('content containing FATAL is returned for FATAL query', () => {
    const index = new LexicalSearchIndex();
    index.build([
      makeLogChunk('2024-01-01T10:00:00Z FATAL password authentication failed for user admin'),
      makePodChunk('healthy-pod'),
    ]);

    const results = index.search('FATAL', 10);
    const ids = chunkIds(results);
    expect(ids.some((id) => id.startsWith('log:'))).toBe(true);
  });

  it('content token matching finds chunks even without identifier overlap', () => {
    const index = new LexicalSearchIndex();
    const logChunk = makeChunk({
      id: 'log:auth:1',
      artifactId: '/logs/auth.log',
      content: 'FATAL: password authentication failed for user amdin',
      identifiers: ['FATAL'],
      artifactCategory: 'log',
      summary: 'Auth log chunk',
    });
    index.build([logChunk]);

    const results = index.search('authentication failed', 10);
    expect(results).toHaveLength(1);
    expect(results[0]!.chunk.id).toBe('log:auth:1');
  });

  it('partial content terms match indexed tokens by substring', () => {
    const index = new LexicalSearchIndex();
    const logChunk = makeChunk({
      id: 'log:substring:1',
      artifactId: '/logs/auth.log',
      content: 'FATAL: password authentication failed for user admin',
      identifiers: [],
      artifactCategory: 'log',
      summary: 'Substring match log',
    });
    index.build([logChunk]);

    const results = index.search('auth', 10);
    expect(results).toHaveLength(1);
    expect(results[0]!.chunk.id).toBe('log:substring:1');
  });

  it('multiple content token matches accumulate score', () => {
    const index = new LexicalSearchIndex();
    const richChunk = makeChunk({
      id: 'log:multi:1',
      content: 'database connection failed: authentication error for database user',
      identifiers: [],
      artifactCategory: 'log',
      summary: 'Rich log',
    });
    const sparseChunk = makeChunk({
      id: 'log:sparse:1',
      content: 'info: all ok',
      identifiers: [],
      artifactCategory: 'log',
      summary: 'Sparse log',
    });

    index.build([richChunk, sparseChunk]);
    const results = index.search('database authentication failed', 10);

    // richChunk matches multiple tokens → higher score
    const richResult = results.find((r) => r.chunk.id === 'log:multi:1');
    expect(richResult).toBeDefined();
    expect(richResult!.score).toBeGreaterThan(WEIGHT_CONTENT);
  });
});

// ---------------------------------------------------------------------------
// Scoring priority: identifier > content
// ---------------------------------------------------------------------------

describe('LexicalSearchIndex — scoring priority', () => {
  it('identifier hit ranks above content-only hit', () => {
    const identifierChunk = makeChunk({
      id: 'resource:identifier-match',
      content: 'kind: Pod metadata name: app-pod',
      identifiers: ['app-pod', 'default'],
      namespace: 'default',
      artifactCategory: 'kubernetes-resource',
      summary: 'Pod app-pod (identifier match)',
    });

    const contentOnlyChunk = makeChunk({
      id: 'log:content-match',
      // app-pod appears in content but NOT in identifiers
      content: 'Error connecting to app-pod service on port 8080',
      identifiers: ['ERROR'],
      artifactCategory: 'log',
      summary: 'Log with app-pod in content',
    });

    const index = new LexicalSearchIndex();
    index.build([contentOnlyChunk, identifierChunk]); // content-only added first

    const results = index.search('app-pod', 10);
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results[0]!.chunk.id).toBe('resource:identifier-match');
    expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
  });

  it('identifier score is strictly greater than the content score for a single-term query', () => {
    const identifierChunk = makeChunk({
      id: 'with-identifier',
      content: 'unrelated yaml',
      identifiers: ['target-name'],
      artifactCategory: 'kubernetes-resource',
      summary: 'Has identifier',
    });
    const contentChunk = makeChunk({
      id: 'with-content',
      content: 'target-name appears here',
      identifiers: [],
      artifactCategory: 'log',
      summary: 'Has content',
    });

    const index = new LexicalSearchIndex();
    index.build([identifierChunk, contentChunk]);

    const results = index.search('target-name', 10);
    const idResult = results.find((r) => r.chunk.id === 'with-identifier')!;
    const ctResult = results.find((r) => r.chunk.id === 'with-content')!;

    // identifier weight (3.0) should be strictly greater than BM25 content score
    expect(idResult.score).toBeGreaterThan(ctResult.score);
  });

  it('namespace match scores between identifier and content', () => {
    const identifierChunk = makeChunk({
      id: 'id-chunk',
      content: 'unrelated',
      identifiers: ['production'],
      artifactCategory: 'kubernetes-resource',
      summary: 'Identifier match',
    });
    const namespaceChunk = makeChunk({
      id: 'ns-chunk',
      content: 'unrelated',
      identifiers: [],
      namespace: 'production',
      artifactCategory: 'kubernetes-resource',
      summary: 'Namespace match',
    });
    const contentChunk = makeChunk({
      id: 'content-chunk',
      content: 'production environment',
      identifiers: [],
      artifactCategory: 'log',
      summary: 'Content match',
    });

    const index = new LexicalSearchIndex();
    index.build([contentChunk, namespaceChunk, identifierChunk]);

    const results = index.search('production', 10);
    const idScore = results.find((r) => r.chunk.id === 'id-chunk')!.score;
    const nsScore = results.find((r) => r.chunk.id === 'ns-chunk')!.score;
    const ctScore = results.find((r) => r.chunk.id === 'content-chunk')!.score;

    expect(idScore).toBeGreaterThan(nsScore);
    expect(nsScore).toBeGreaterThan(ctScore);
  });

  it('all results have positive scores', () => {
    const index = new LexicalSearchIndex();
    index.build([makePodChunk('api-server', 'default'), makeLogChunk('api-server crashed')]);
    const results = index.search('api-server', 10);
    for (const result of results) {
      expect(result.score).toBeGreaterThan(0);
    }
  });

  it('identifier hits rank above content-only hits (tie-break determinism)', () => {
    const identifierChunk = makeChunk({
      id: 'resource:tie-identifier',
      content: 'kind: Pod metadata labels: app',
      identifiers: ['app-pod'],
      artifactCategory: 'kubernetes-resource',
      summary: 'Identifier match winner',
    });
    const contentOnlyChunk = makeChunk({
      id: 'log:tie-content',
      content: 'app-pod error failed',
      identifiers: [],
      artifactCategory: 'log',
      summary: 'Content-only match',
    });

    const index = new LexicalSearchIndex();
    index.build([contentOnlyChunk, identifierChunk]);

    const results = index.search('app-pod error failed', 10);
    // The identifier chunk should rank first regardless of exact scores.
    // (With BM25 content scoring the scores are no longer equal, but
    // the flat 3.0 identifier weight still dominates a typical multi-token
    // BM25 content score for a small corpus.)
    expect(results[0]!.chunk.id).toBe('resource:tie-identifier');
  });
});

// ---------------------------------------------------------------------------
// extractQueryIdentifiers
// ---------------------------------------------------------------------------

describe('LexicalSearchIndex.extractQueryIdentifiers', () => {
  let index: LexicalSearchIndex;

  beforeEach(() => {
    index = new LexicalSearchIndex();
  });

  it('extracts a plain K8s resource name from a single-word query', () => {
    const ids = index.extractQueryIdentifiers('app-pod');
    expect(ids).toContain('app-pod');
  });

  it('extracts pod name from a full hypothesis sentence', () => {
    const ids = index.extractQueryIdentifiers('Pod api-server is in CrashLoopBackOff in namespace default');
    expect(ids).toContain('api-server');
  });

  it('extracts known error reason CrashLoopBackOff', () => {
    const ids = index.extractQueryIdentifiers('Pod api-server is in CrashLoopBackOff');
    expect(ids).toContain('CrashLoopBackOff');
  });

  it('extracts known error reasons case-insensitively with canonical casing', () => {
    const ids = index.extractQueryIdentifiers('pod api-server is in crashloopbackoff');
    expect(ids).toContain('CrashLoopBackOff');
  });

  it('extracts known error reason ImagePullBackOff', () => {
    const ids = index.extractQueryIdentifiers('ImagePullBackOff for pod bad-pod');
    expect(ids).toContain('ImagePullBackOff');
  });

  it('extracts image reference with tag', () => {
    const ids = index.extractQueryIdentifiers('pod running nginx:1.19.0 is failing');
    expect(ids).toContain('nginx:1.19.0');
  });

  it('extracts image reference with repository path', () => {
    const ids = index.extractQueryIdentifiers('image myrepo/app:v2.0.0 cannot be pulled');
    expect(ids).toContain('myrepo/app:v2.0.0');
  });

  it('extracts standalone image tags', () => {
    const ids = index.extractQueryIdentifiers('roll back to tag v2.0.0 for the api image');
    expect(ids).toContain('v2.0.0');
  });

  it('extracts namespace name', () => {
    const ids = index.extractQueryIdentifiers('Pod crash-pod in namespace production');
    expect(ids).toContain('production');
  });

  it('extracts multiple identifiers from a complex hypothesis', () => {
    const ids = index.extractQueryIdentifiers(
      'Pod api-server CrashLoopBackOff in namespace kube-system missing secret db-credentials',
    );
    expect(ids).toContain('api-server');
    expect(ids).toContain('CrashLoopBackOff');
    expect(ids).toContain('kube-system');
    expect(ids).toContain('db-credentials');
  });

  it('does not extract stop words as identifiers', () => {
    const ids = index.extractQueryIdentifiers('Pod is in namespace default');
    // 'pod', 'is', 'in', 'namespace' should be filtered
    expect(ids).not.toContain('pod');
    expect(ids).not.toContain('is');
    expect(ids).not.toContain('in');
    expect(ids).not.toContain('namespace');
    // 'default' is a valid namespace name and should be extracted
    expect(ids).toContain('default');
  });

  it('returns deduplicated identifiers', () => {
    const ids = index.extractQueryIdentifiers('app-pod app-pod CrashLoopBackOff CrashLoopBackOff');
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it('returns empty array for a query with only stop words', () => {
    const ids = index.extractQueryIdentifiers('pod is in namespace');
    // Only stop words — should have very few or no identifiers
    // 'namespace' is a stop word; 'pod' is a stop word; 'is' and 'in' are stop words
    // 'namespace' could be extracted if not in stop words, but it is
    const nonStopIds = ids.filter(
      (id) => !['pod', 'is', 'in', 'namespace'].includes(id),
    );
    expect(nonStopIds).toHaveLength(0);
  });

  it('preserves case for error reasons', () => {
    const ids = index.extractQueryIdentifiers('CrashLoopBackOff detected');
    const reason = ids.find((id) => id.toLowerCase() === 'crashloopbackoff');
    expect(reason).toBe('CrashLoopBackOff'); // original casing preserved
  });

  // ── High-signal diagnostic terms (step-10 / issue 2.7) ──────────────────

  it('extracts "secret" as a searchable identifier (not a stop word)', () => {
    const ids = index.extractQueryIdentifiers('missing secret app-credentials');
    expect(ids).toContain('missing');
    expect(ids).toContain('secret');
    expect(ids).toContain('app-credentials');
  });

  it('extracts "service" as a searchable identifier', () => {
    const ids = index.extractQueryIdentifiers('service api-gateway is unreachable');
    expect(ids).toContain('service');
    expect(ids).toContain('api-gateway');
    expect(ids).toContain('unreachable');
  });

  it('extracts "configmap" as a searchable identifier', () => {
    const ids = index.extractQueryIdentifiers('configmap db-config missing key');
    expect(ids).toContain('configmap');
    expect(ids).toContain('db-config');
  });

  it('extracts "failed" as a searchable identifier', () => {
    const ids = index.extractQueryIdentifiers('failed pod web-server');
    expect(ids).toContain('failed');
    expect(ids).toContain('web-server');
  });
});

// ---------------------------------------------------------------------------
// High-signal stop-word fix: searching 'secret', 'missing', etc.
// ---------------------------------------------------------------------------

describe('LexicalSearchIndex — high-signal diagnostic terms as identifier queries (step-10)', () => {
  it('searching "missing secret" finds chunks with "secret" in identifiers', () => {
    // A chunk whose identifiers explicitly include the literal word "secret"
    // (e.g. a Kubernetes Secret resource or an analyzer result that tags the
    // secret kind as an identifier).
    const secretChunk = makeChunk({
      id: 'resource:secret-tagged',
      content: 'kind: Secret metadata name: my-secret namespace: default',
      identifiers: ['my-secret', 'secret', 'default'],
      namespace: 'default',
      artifactCategory: 'kubernetes-resource',
      summary: 'Secret resource chunk with "secret" in identifiers',
    });
    const unrelatedChunk = makePodChunk('unrelated-pod');

    const idx = new LexicalSearchIndex();
    idx.build([secretChunk, unrelatedChunk]);

    const results = idx.search('missing secret', 10);
    const found = results.find((r) => r.chunk.identifiers.includes('secret'));
    expect(found).toBeDefined();
    expect(found!.chunk.id).toBe('resource:secret-tagged');
  });

  it('searching "missing secret" does NOT find a chunk whose content only contains "secretKeyRef"', () => {
    // Simulate a monitoring pod that has secretKeyRef in its raw JSON but is
    // unrelated to the query.  Before the stop-word fix this chunk was falsely
    // surfaced via substring expansion ('secret' ⊂ 'secretkeyref').
    const noiseChunk = makeChunk({
      id: 'resource:noise-secretkeyref',
      // Raw JSON-like content with secretKeyRef but no standalone 'secret' token
      content: '{"env":[{"name":"GF_DB_PASS","valueFrom":{"secretKeyRef":{"name":"monitoring-credentials","key":"pass"}}}]}',
      identifiers: ['grafana-pod', 'monitoring', 'monitoring-credentials'],
      namespace: 'monitoring',
      artifactCategory: 'kubernetes-resource',
      summary: 'Grafana pod with secretKeyRef (noise)',
    });

    const idx = new LexicalSearchIndex();
    idx.build([noiseChunk]);

    const results = idx.search('missing secret app-credentials', 10);
    // The noise chunk must not appear — 'secret' should not expand to
    // 'secretkeyref' via substring matching.
    expect(results).toHaveLength(0);
  });

  it('searching "failed" finds a chunk with "failed" in identifiers (Helm release)', () => {
    const helmChunk = makeChunk({
      id: 'helm-release:default:my-chart',
      content: 'HelmRelease: my-chart (namespace: default)\nStatus: failed',
      identifiers: ['my-chart', 'default', 'failed'],
      namespace: 'default',
      artifactCategory: 'helm-release',
      summary: 'Helm release my-chart with status failed',
    });
    const unrelatedChunk = makePodChunk('healthy-pod');

    const idx = new LexicalSearchIndex();
    idx.build([helmChunk, unrelatedChunk]);

    const results = idx.search('failed my-chart', 10);
    const helmResult = results.find((r) => r.chunk.id === 'helm-release:default:my-chart');
    expect(helmResult).toBeDefined();
    // Identifier match for both 'failed' and 'my-chart' → score ≥ 6.0
    expect(helmResult!.score).toBeGreaterThanOrEqual(6.0);
  });
});

// ---------------------------------------------------------------------------
// Integration: buildChunkIndex + LexicalSearchIndex
// ---------------------------------------------------------------------------

describe('LexicalSearchIndex — integration with buildChunkIndex fixtures', () => {
  it('builds and searches a mixed chunk set without errors', () => {
    const chunks: IndexedChunk[] = [
      makePodChunk('api-server', 'default'),
      makeCrashPodChunk('backend', 'default'),
      makeLogChunk('FATAL: database connection refused: postgres:5432', '/logs/backend.log'),
      makeAnalyzerChunk('image-tag-check', 'Image tag latest is mutable'),
      makeConfigMapChunk('db-config', 'default', ['DB_HOST', 'DB_USER', 'DB_PASS']),
    ];

    const index = new LexicalSearchIndex();
    index.build(chunks);

    // Should find the crash pod
    const crash = index.search('CrashLoopBackOff backend', 5);
    expect(crash.length).toBeGreaterThan(0);
    expect(crash[0]!.chunk.id).toBe('pod:default:backend:crash');

    // Should find the configmap by name
    const cm = index.search('db-config', 5);
    expect(cm.length).toBeGreaterThan(0);
    expect(cm[0]!.chunk.id).toBe('configmap:default:db-config');

    // Should find the log chunk via content
    const log = index.search('FATAL database', 5);
    expect(log.some((r) => r.chunk.artifactCategory === 'log')).toBe(true);
  });

  it('cross-source correlation: crash pod + log error both returned for hypothesis', () => {
    const crashPod = makeCrashPodChunk('api-server', 'default');
    const logWithError = makeLogChunk(
      'FATAL: password authentication failed for user amdin — api-server cannot connect',
      '/logs/api-server.log',
    );

    const index = new LexicalSearchIndex();
    index.build([crashPod, logWithError]);

    // Hypothesis mentions api-server and CrashLoopBackOff
    const results = index.search('Pod api-server is in CrashLoopBackOff in namespace default', 10);

    const foundIds = chunkIds(results);
    // The crash pod should be found via identifier match
    expect(foundIds).toContain('pod:default:api-server:crash');
    // The log chunk should also be found via content match (api-server in content)
    expect(foundIds.some((id) => id.startsWith('log:'))).toBe(true);
    // Crash pod should rank first (identifier match outranks content match)
    expect(results[0]!.chunk.id).toBe('pod:default:api-server:crash');
  });
});

// ---------------------------------------------------------------------------
// BM25 scoring properties
// ---------------------------------------------------------------------------

describe('LexicalSearchIndex — BM25 scoring', () => {
  /**
   * BM25 saturation test.
   *
   * With raw TF, a chunk containing 'default' 50 times scores 50× a single
   * match, dwarfing a chunk with 2 occurrences of a rare term. BM25 prevents
   * this: the IDF of a term that appears in almost every chunk is near-zero,
   * so even 50 repetitions cannot compensate for the high IDF of the rare term.
   */
  it('BM25 saturation: chunk with 50 occurrences of common term does not outrank chunk with 2 occurrences of rare term', () => {
    // 20 background chunks containing 'default' → df('default') = 21, low IDF
    const background = Array.from({ length: 20 }, (_, i) =>
      makeChunk({
        id: `sat-bg-${i}`,
        content: `pod-${i} running in default namespace with default config`,
        identifiers: [`pod-${i}`],
        namespace: 'default',
        artifactCategory: 'kubernetes-resource',
        summary: `Background ${i}`,
      }),
    );

    // Chunk A: 'default' repeated 50 times — high TF but very low IDF
    const chunkA = makeChunk({
      id: 'sat-chunk-a',
      content: Array(50).fill('default').join(' '),
      identifiers: [],
      artifactCategory: 'kubernetes-resource',
      summary: 'Many defaults',
    });

    // Chunk B: 'app-credentials' appears 2 times — low TF but very high IDF
    // ('app-credentials' appears in no background chunk → df = 1)
    const chunkB = makeChunk({
      id: 'sat-chunk-b',
      content: 'app-credentials secret app-credentials missing',
      identifiers: [],
      artifactCategory: 'kubernetes-resource',
      summary: 'Rare term',
    });

    const index = new LexicalSearchIndex();
    index.build([...background, chunkA, chunkB]);

    // Query touches both terms.  With raw TF, chunkA would dominate (score 50).
    // With BM25, the rare 'app-credentials' in chunkB should score higher.
    const results = index.search('default app-credentials', 10);
    const aResult = results.find((r) => r.chunk.id === 'sat-chunk-a');
    const bResult = results.find((r) => r.chunk.id === 'sat-chunk-b');

    expect(bResult).toBeDefined();
    expect(bResult!.score).toBeGreaterThan(aResult?.score ?? 0);
  });

  /**
   * IDF test.
   *
   * When both chunks contain exactly ONE occurrence of their respective term,
   * the chunk whose term is RARE (appears in few documents) should receive a
   * higher BM25 score than the chunk whose term is COMMON (appears in many
   * documents).
   *
   * topK is set larger than the corpus so both target chunks are always
   * included in results (avoids false passes from topK truncation).
   */
  it('BM25 IDF: common term scores lower per-occurrence than rare term', () => {
    // 15 background chunks all containing 'default' → df('default') = 16, low IDF
    const background = Array.from({ length: 15 }, (_, i) =>
      makeChunk({
        id: `idf-bg-${i}`,
        content: `pod-${i} running in default namespace`,
        identifiers: [`pod-${i}`],
        artifactCategory: 'kubernetes-resource',
        summary: `Background ${i}`,
      }),
    );

    // One occurrence of the common term 'default'
    const commonChunk = makeChunk({
      id: 'idf-common-chunk',
      content: 'pod running in default namespace',
      identifiers: [],
      artifactCategory: 'kubernetes-resource',
      summary: 'Common term chunk',
    });

    // One occurrence of the rare term 'app-credentials' (only in this chunk → df = 1)
    const rareChunk = makeChunk({
      id: 'idf-rare-chunk',
      content: 'secret app-credentials not found',
      identifiers: [],
      artifactCategory: 'kubernetes-resource',
      summary: 'Rare term chunk',
    });

    const index = new LexicalSearchIndex();
    index.build([...background, commonChunk, rareChunk]);

    // topK=50 is larger than the corpus (17 chunks) so the target chunk is
    // always present in results and the score is non-zero when it matches.
    const defaultResults = index.search('default', 50);
    const commonScore =
      defaultResults.find((r) => r.chunk.id === 'idf-common-chunk')?.score ?? 0;

    const rareResults = index.search('app-credentials', 50);
    const rareScore =
      rareResults.find((r) => r.chunk.id === 'idf-rare-chunk')?.score ?? 0;

    // With BM25, the rare term has higher IDF → higher score per occurrence
    // than the common term even though both appear exactly once in their chunk.
    expect(rareScore).toBeGreaterThan(commonScore);
  });

  /**
   * Length normalization test.
   *
   * BM25 penalizes long documents relative to the corpus average. A short chunk
   * with exactly one match should rank above a very long chunk with one match,
   * because the match density is higher in the short chunk.
   */
  it('BM25 length normalization: short chunk with 1 match ranks higher than long chunk with 1 match', () => {
    // Short chunk: 2 tokens, one of which is the target
    const shortChunk = makeChunk({
      id: 'len-short-chunk',
      content: 'crashloopbackoff detected',
      identifiers: [],
      artifactCategory: 'log',
      summary: 'Short chunk',
    });

    // Long chunk: 101 tokens, only the last is the target
    const longChunk = makeChunk({
      id: 'len-long-chunk',
      content: `${Array(100).fill('running').join(' ')} crashloopbackoff`,
      identifiers: [],
      artifactCategory: 'log',
      summary: 'Long chunk',
    });

    const index = new LexicalSearchIndex();
    index.build([shortChunk, longChunk]);

    const results = index.search('crashloopbackoff', 10);
    const shortResult = results.find((r) => r.chunk.id === 'len-short-chunk');
    const longResult = results.find((r) => r.chunk.id === 'len-long-chunk');

    expect(shortResult).toBeDefined();
    expect(longResult).toBeDefined();
    // Short chunk has higher match density → should rank first
    expect(shortResult!.score).toBeGreaterThan(longResult!.score);
  });
});

// ---------------------------------------------------------------------------
// Constant used in tests (re-exported for test readability)
// ---------------------------------------------------------------------------

/** Weight constant for content match — used in score assertions above. */
const WEIGHT_CONTENT = 1.0;
