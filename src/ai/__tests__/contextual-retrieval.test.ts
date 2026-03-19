import { describe, it, expect } from 'vitest';
import {
  generateChunkContext,
  contextualizeChunks,
  buildDocumentContext,
} from '../contextual-retrieval.js';
import type { DocumentContext } from '../contextual-retrieval.js';
import type { IndexedChunk } from '../chunk-indexer.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Creates a minimal IndexedChunk for testing. */
function makeChunk(overrides: Partial<IndexedChunk> = {}): IndexedChunk {
  return {
    id: 'test-chunk',
    artifactId: 'test-artifact',
    content: 'test content',
    startLine: 1,
    endLine: 5,
    summary: 'test summary',
    identifiers: [],
    artifactCategory: 'kubernetes-resource',
    metadata: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// generateChunkContext — Pod
// ---------------------------------------------------------------------------

describe('generateChunkContext — Pod', () => {
  it('returns a non-empty string', () => {
    const doc: DocumentContext = {
      category: 'kubernetes-resource',
      kind: 'Pod',
      name: 'app-pod',
      namespace: 'default',
    };
    const ctx = generateChunkContext(doc, 'container env: DB_HOST');
    expect(typeof ctx).toBe('string');
    expect(ctx.length).toBeGreaterThan(0);
  });

  it('context sentence starts with "This chunk is from"', () => {
    const doc: DocumentContext = {
      category: 'kubernetes-resource',
      kind: 'Pod',
      name: 'app-pod',
      namespace: 'default',
    };
    const ctx = generateChunkContext(doc, 'container environment variables');
    expect(ctx).toMatch(/^This chunk is from/);
  });

  it('includes Pod kind', () => {
    const doc: DocumentContext = {
      category: 'kubernetes-resource',
      kind: 'Pod',
      name: 'app-pod',
      namespace: 'default',
    };
    const ctx = generateChunkContext(doc, 'container spec');
    expect(ctx).toContain('Pod');
  });

  it('includes pod name', () => {
    const doc: DocumentContext = {
      category: 'kubernetes-resource',
      kind: 'Pod',
      name: 'app-pod',
      namespace: 'default',
    };
    const ctx = generateChunkContext(doc, 'container spec');
    expect(ctx).toContain('app-pod');
  });

  it('includes namespace', () => {
    const doc: DocumentContext = {
      category: 'kubernetes-resource',
      kind: 'Pod',
      name: 'app-pod',
      namespace: 'default',
    };
    const ctx = generateChunkContext(doc, 'container spec');
    expect(ctx).toContain('default');
  });

  it('matches example format — Pod spec with env vars', () => {
    const doc: DocumentContext = {
      category: 'kubernetes-resource',
      kind: 'Pod',
      name: 'app-pod',
      namespace: 'default',
    };
    const ctx = generateChunkContext(doc, 'env:\n- name: DB_PASSWORD\n  valueFrom:\n    secretKeyRef:\n      name: app-credentials');
    // Should contain Pod, name, namespace and describe the content
    expect(ctx).toContain('Pod');
    expect(ctx).toContain('app-pod');
    expect(ctx).toContain('default');
    // Should mention what the content describes
    expect(ctx.length).toBeGreaterThan(30);
  });
});

// ---------------------------------------------------------------------------
// generateChunkContext — ConfigMap
// ---------------------------------------------------------------------------

describe('generateChunkContext — ConfigMap', () => {
  it('includes ConfigMap kind', () => {
    const doc: DocumentContext = {
      category: 'kubernetes-resource',
      kind: 'ConfigMap',
      name: 'app-config',
      namespace: 'default',
    };
    const ctx = generateChunkContext(doc, 'DB_HOST: localhost\nDB_PORT: 5432');
    expect(ctx).toContain('ConfigMap');
  });

  it('includes ConfigMap name', () => {
    const doc: DocumentContext = {
      category: 'kubernetes-resource',
      kind: 'ConfigMap',
      name: 'app-config',
      namespace: 'default',
    };
    const ctx = generateChunkContext(doc, 'DB_HOST: localhost');
    expect(ctx).toContain('app-config');
  });

  it('includes namespace', () => {
    const doc: DocumentContext = {
      category: 'kubernetes-resource',
      kind: 'ConfigMap',
      name: 'app-config',
      namespace: 'production',
    };
    const ctx = generateChunkContext(doc, 'DB_HOST: localhost');
    expect(ctx).toContain('production');
  });

  it('starts with "This chunk is from"', () => {
    const doc: DocumentContext = {
      category: 'kubernetes-resource',
      kind: 'ConfigMap',
      name: 'db-config',
      namespace: 'default',
    };
    const ctx = generateChunkContext(doc, 'DB_HOST: wrong-host.internal');
    expect(ctx).toMatch(/^This chunk is from/);
  });
});

// ---------------------------------------------------------------------------
// generateChunkContext — Event
// ---------------------------------------------------------------------------

describe('generateChunkContext — Event', () => {
  it('starts with "This chunk is from"', () => {
    const doc: DocumentContext = {
      category: 'event',
      name: 'app-pod',
      namespace: 'default',
      reason: 'BackOff',
    };
    const ctx = generateChunkContext(doc, '[Warning] BackOff on Pod/app-pod');
    expect(ctx).toMatch(/^This chunk is from/);
  });

  it('includes the word "event"', () => {
    const doc: DocumentContext = {
      category: 'event',
      name: 'app-pod',
      namespace: 'default',
      reason: 'CrashLoopBackOff',
    };
    const ctx = generateChunkContext(doc, '[Warning] CrashLoopBackOff on Pod/app-pod');
    expect(ctx.toLowerCase()).toContain('event');
  });

  it('includes involved object name', () => {
    const doc: DocumentContext = {
      category: 'event',
      name: 'my-pod',
      namespace: 'staging',
    };
    const ctx = generateChunkContext(doc, '[Warning] BackOff on my-pod');
    expect(ctx).toContain('my-pod');
  });

  it('includes namespace', () => {
    const doc: DocumentContext = {
      category: 'event',
      name: 'app-pod',
      namespace: 'staging',
    };
    const ctx = generateChunkContext(doc, '[Warning] BackOff');
    expect(ctx).toContain('staging');
  });

  it('includes reason when provided', () => {
    const doc: DocumentContext = {
      category: 'event',
      name: 'app-pod',
      namespace: 'default',
      reason: 'FailedMount',
    };
    const ctx = generateChunkContext(doc, 'Unable to attach or mount volumes');
    expect(ctx).toContain('FailedMount');
  });
});

// ---------------------------------------------------------------------------
// generateChunkContext — Log
// ---------------------------------------------------------------------------

describe('generateChunkContext — Log', () => {
  it('starts with "This chunk is from"', () => {
    const doc: DocumentContext = {
      category: 'log',
      path: 'pods/logs/default/app-pod/app.log',
      startLine: 100,
      endLine: 150,
    };
    const ctx = generateChunkContext(doc, 'ERROR: connection refused');
    expect(ctx).toMatch(/^This chunk is from/);
  });

  it('includes the word "log"', () => {
    const doc: DocumentContext = {
      category: 'log',
      path: '/logs/app.log',
    };
    const ctx = generateChunkContext(doc, 'INFO starting up');
    expect(ctx.toLowerCase()).toContain('log');
  });

  it('includes file path', () => {
    const doc: DocumentContext = {
      category: 'log',
      path: 'pods/logs/default/app-pod/app.log',
    };
    const ctx = generateChunkContext(doc, 'ERROR: disk full');
    expect(ctx).toContain('pods/logs/default/app-pod/app.log');
  });

  it('includes line range when provided', () => {
    const doc: DocumentContext = {
      category: 'log',
      path: '/logs/app.log',
      startLine: 145,
      endLine: 195,
    };
    const ctx = generateChunkContext(doc, 'ERROR: DNS failure');
    // Should mention the line numbers
    expect(ctx).toContain('145');
    expect(ctx).toContain('195');
  });

  it('describes error content for error logs', () => {
    const doc: DocumentContext = {
      category: 'log',
      path: '/logs/app.log',
    };
    const ctx = generateChunkContext(doc, 'ERROR: connection refused to db.internal:5432\nERROR: retry attempt 3 failed');
    // Should mention error content (some form of "error")
    expect(ctx.toLowerCase()).toContain('error');
  });
});

// ---------------------------------------------------------------------------
// generateChunkContext — Analyzer
// ---------------------------------------------------------------------------

describe('generateChunkContext — Analyzer', () => {
  it('starts with "This chunk is from"', () => {
    const doc: DocumentContext = {
      category: 'analyzer',
      name: 'check-pod-status',
      severity: 'error',
    };
    const ctx = generateChunkContext(doc, '[ERROR] Pod status check failed');
    expect(ctx).toMatch(/^This chunk is from/);
  });

  it('includes the word "analyzer"', () => {
    const doc: DocumentContext = {
      category: 'analyzer',
      name: 'check-1',
    };
    const ctx = generateChunkContext(doc, '[WARN] Pod has high restart count');
    expect(ctx.toLowerCase()).toContain('analyzer');
  });

  it('includes analyzer name', () => {
    const doc: DocumentContext = {
      category: 'analyzer',
      name: 'pod-restart-check',
      severity: 'warn',
    };
    const ctx = generateChunkContext(doc, '[WARN] 5 restarts in last hour');
    expect(ctx).toContain('pod-restart-check');
  });

  it('includes severity when provided', () => {
    const doc: DocumentContext = {
      category: 'analyzer',
      name: 'check-1',
      severity: 'error',
    };
    const ctx = generateChunkContext(doc, '[ERROR] CrashLoopBackOff detected');
    expect(ctx).toContain('error');
  });
});

// ---------------------------------------------------------------------------
// generateChunkContext — all categories return strings
// ---------------------------------------------------------------------------

describe('generateChunkContext — universal guarantees', () => {
  it('returns a non-empty string for all artifact categories', () => {
    const testCases: Array<{ doc: DocumentContext; content: string }> = [
      {
        doc: { category: 'kubernetes-resource', kind: 'Pod', name: 'pod-1', namespace: 'default' },
        content: 'container spec',
      },
      {
        doc: { category: 'kubernetes-resource', kind: 'ConfigMap', name: 'cm-1', namespace: 'default' },
        content: 'DB_HOST: localhost',
      },
      {
        doc: { category: 'event', name: 'pod-1', namespace: 'default', reason: 'BackOff' },
        content: '[Warning] BackOff',
      },
      {
        doc: { category: 'log', path: '/logs/app.log', startLine: 1, endLine: 50 },
        content: 'INFO starting',
      },
      {
        doc: { category: 'analyzer', name: 'check-1', severity: 'warn' },
        content: '[WARN] high restart count',
      },
      {
        doc: { category: 'helm-release', name: 'my-app', namespace: 'default' },
        content: 'deployed',
      },
    ];

    for (const { doc, content } of testCases) {
      const ctx = generateChunkContext(doc, content);
      expect(typeof ctx).toBe('string');
      expect(ctx.length).toBeGreaterThan(0);
    }
  });

  it('each context sentence is shorter than 300 characters (concise)', () => {
    const doc: DocumentContext = {
      category: 'kubernetes-resource',
      kind: 'Pod',
      name: 'app-pod',
      namespace: 'default',
    };
    const ctx = generateChunkContext(doc, 'some content');
    expect(ctx.length).toBeLessThan(300);
  });
});

// ---------------------------------------------------------------------------
// contextualizeChunks — structure
// ---------------------------------------------------------------------------

describe('contextualizeChunks — chunk structure', () => {
  it('returns the same number of chunks', () => {
    const chunks = [
      makeChunk({
        id: 'c1',
        artifactCategory: 'kubernetes-resource',
        namespace: 'default',
        metadata: { kind: 'Pod', name: 'pod-1', namespace: 'default' },
      }),
      makeChunk({
        id: 'c2',
        artifactCategory: 'event',
        namespace: 'default',
        metadata: { reason: 'BackOff', name: 'pod-1', namespace: 'default' },
      }),
    ];
    const docs: DocumentContext[] = [
      { category: 'kubernetes-resource', kind: 'Pod', name: 'pod-1', namespace: 'default' },
      { category: 'event', name: 'pod-1', namespace: 'default', reason: 'BackOff' },
    ];
    const result = contextualizeChunks(chunks, docs);
    expect(result).toHaveLength(2);
  });

  it('each returned chunk has a contextualizedContent field', () => {
    const chunks = [
      makeChunk({
        id: 'c1',
        artifactCategory: 'kubernetes-resource',
        content: 'container env vars',
        metadata: { kind: 'Pod', name: 'pod-1', namespace: 'default' },
      }),
    ];
    const docs: DocumentContext[] = [
      { category: 'kubernetes-resource', kind: 'Pod', name: 'pod-1', namespace: 'default' },
    ];
    const result = contextualizeChunks(chunks, docs);
    expect(result[0]!.contextualizedContent).toBeDefined();
    expect(typeof result[0]!.contextualizedContent).toBe('string');
  });

  it('contextualizedContent is not empty', () => {
    const chunks = [
      makeChunk({
        id: 'c1',
        artifactCategory: 'kubernetes-resource',
        content: 'container env vars',
        metadata: { kind: 'Pod', name: 'pod-1', namespace: 'default' },
      }),
    ];
    const docs: DocumentContext[] = [
      { category: 'kubernetes-resource', kind: 'Pod', name: 'pod-1', namespace: 'default' },
    ];
    const result = contextualizeChunks(chunks, docs);
    expect(result[0]!.contextualizedContent!.length).toBeGreaterThan(0);
  });

  it('contextualizedContent includes the original content', () => {
    const originalContent = 'image: myapp:v1.0.0\nenv:\n- name: DB_HOST\n  value: localhost';
    const chunks = [
      makeChunk({
        id: 'c1',
        artifactCategory: 'kubernetes-resource',
        content: originalContent,
        metadata: { kind: 'Pod', name: 'pod-1', namespace: 'default' },
      }),
    ];
    const docs: DocumentContext[] = [
      { category: 'kubernetes-resource', kind: 'Pod', name: 'pod-1', namespace: 'default' },
    ];
    const result = contextualizeChunks(chunks, docs);
    expect(result[0]!.contextualizedContent).toContain(originalContent);
  });

  it('contextualizedContent starts with the context prefix', () => {
    const chunks = [
      makeChunk({
        id: 'c1',
        artifactCategory: 'kubernetes-resource',
        content: 'image: myapp:v1.0.0',
        metadata: { kind: 'Pod', name: 'pod-1', namespace: 'default' },
      }),
    ];
    const docs: DocumentContext[] = [
      { category: 'kubernetes-resource', kind: 'Pod', name: 'pod-1', namespace: 'default' },
    ];
    const result = contextualizeChunks(chunks, docs);
    expect(result[0]!.contextualizedContent).toMatch(/^This chunk is from/);
  });

  it('contextualizedContent = context prefix + separator + original content', () => {
    const originalContent = 'DB_HOST: localhost';
    const chunks = [
      makeChunk({
        id: 'c1',
        artifactCategory: 'kubernetes-resource',
        content: originalContent,
        metadata: { kind: 'ConfigMap', name: 'app-config', namespace: 'default' },
      }),
    ];
    const docs: DocumentContext[] = [
      { category: 'kubernetes-resource', kind: 'ConfigMap', name: 'app-config', namespace: 'default' },
    ];
    const result = contextualizeChunks(chunks, docs);
    const ctx = result[0]!.contextualizedContent!;
    // Must have context prefix before the content
    const contentIdx = ctx.indexOf(originalContent);
    expect(contentIdx).toBeGreaterThan(0);
    // Prefix (before content) must be non-trivial
    const prefix = ctx.slice(0, contentIdx).trim();
    expect(prefix.length).toBeGreaterThan(10);
  });
});

// ---------------------------------------------------------------------------
// contextualizeChunks — raw content preservation
// ---------------------------------------------------------------------------

describe('contextualizeChunks — raw content preservation', () => {
  it('original content field is unchanged', () => {
    const originalContent = 'original log line\nanother log line';
    const chunks = [
      makeChunk({
        id: 'c1',
        artifactCategory: 'log',
        content: originalContent,
        artifactId: '/logs/app.log',
        metadata: { path: '/logs/app.log', startLine: 1, endLine: 2 },
      }),
    ];
    const docs: DocumentContext[] = [{ category: 'log', path: '/logs/app.log' }];
    const result = contextualizeChunks(chunks, docs);
    expect(result[0]!.content).toBe(originalContent);
  });

  it('all other chunk fields are preserved', () => {
    const chunk = makeChunk({
      id: 'original-id',
      artifactId: 'original-artifact',
      summary: 'original summary',
      identifiers: ['pod-1', 'default'],
      namespace: 'default',
      artifactCategory: 'event',
      timestamp: '2024-01-15T10:00:00Z',
      startLine: 5,
      endLine: 10,
      metadata: { reason: 'BackOff', name: 'pod-1', namespace: 'default' },
    });
    const docs: DocumentContext[] = [{ category: 'event', name: 'pod-1', namespace: 'default' }];
    const result = contextualizeChunks([chunk], docs);
    const out = result[0]!;

    expect(out.id).toBe('original-id');
    expect(out.artifactId).toBe('original-artifact');
    expect(out.summary).toBe('original summary');
    expect(out.identifiers).toEqual(['pod-1', 'default']);
    expect(out.namespace).toBe('default');
    expect(out.artifactCategory).toBe('event');
    expect(out.timestamp).toBe('2024-01-15T10:00:00Z');
    expect(out.startLine).toBe(5);
    expect(out.endLine).toBe(10);
  });

  it('handles empty chunks array', () => {
    const result = contextualizeChunks([], []);
    expect(result).toHaveLength(0);
  });

  it('does not mutate the original chunk objects', () => {
    const original = makeChunk({
      id: 'c1',
      content: 'original content',
      artifactCategory: 'analyzer',
      metadata: { name: 'check-1', severity: 'error' },
    });
    const originalId = original.id;
    const originalContent = original.content;

    const docs: DocumentContext[] = [{ category: 'analyzer', name: 'check-1', severity: 'error' }];
    contextualizeChunks([original], docs);

    // Original must be untouched
    expect(original.id).toBe(originalId);
    expect(original.content).toBe(originalContent);
    expect((original as IndexedChunk).contextualizedContent).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// contextualizeChunks — per-category context prefixes
// ---------------------------------------------------------------------------

describe('contextualizeChunks — per-category context prefix correctness', () => {
  it('Pod chunk contextualizedContent contains Pod name', () => {
    const chunks = [
      makeChunk({
        id: 'c1',
        artifactCategory: 'kubernetes-resource',
        content: 'containers: [app]',
        metadata: { kind: 'Pod', name: 'app-pod', namespace: 'default' },
      }),
    ];
    const docs: DocumentContext[] = [
      { category: 'kubernetes-resource', kind: 'Pod', name: 'app-pod', namespace: 'default' },
    ];
    const result = contextualizeChunks(chunks, docs);
    expect(result[0]!.contextualizedContent).toContain('app-pod');
  });

  it('ConfigMap chunk contextualizedContent contains ConfigMap name', () => {
    const chunks = [
      makeChunk({
        id: 'c1',
        artifactCategory: 'kubernetes-resource',
        content: 'DB_HOST: localhost',
        metadata: { kind: 'ConfigMap', name: 'db-config', namespace: 'default' },
      }),
    ];
    const docs: DocumentContext[] = [
      { category: 'kubernetes-resource', kind: 'ConfigMap', name: 'db-config', namespace: 'default' },
    ];
    const result = contextualizeChunks(chunks, docs);
    expect(result[0]!.contextualizedContent).toContain('db-config');
  });

  it('Event chunk contextualizedContent contains event reason', () => {
    const chunks = [
      makeChunk({
        id: 'c1',
        artifactCategory: 'event',
        namespace: 'default',
        content: '[Warning] FailedMount on app-pod',
        metadata: { reason: 'FailedMount', name: 'app-pod', namespace: 'default' },
      }),
    ];
    const docs: DocumentContext[] = [
      { category: 'event', name: 'app-pod', namespace: 'default', reason: 'FailedMount' },
    ];
    const result = contextualizeChunks(chunks, docs);
    expect(result[0]!.contextualizedContent).toContain('FailedMount');
  });

  it('Log chunk contextualizedContent contains file path', () => {
    const chunks = [
      makeChunk({
        id: 'c1',
        artifactCategory: 'log',
        artifactId: 'pods/logs/default/app-pod/app.log',
        content: 'ERROR: DNS failure for db.internal',
        startLine: 100,
        endLine: 110,
        metadata: { path: 'pods/logs/default/app-pod/app.log', startLine: 100, endLine: 110 },
      }),
    ];
    const docs: DocumentContext[] = [
      { category: 'log', path: 'pods/logs/default/app-pod/app.log', startLine: 100, endLine: 110 },
    ];
    const result = contextualizeChunks(chunks, docs);
    expect(result[0]!.contextualizedContent).toContain('pods/logs/default/app-pod/app.log');
  });

  it('Analyzer chunk contextualizedContent contains analyzer name', () => {
    const chunks = [
      makeChunk({
        id: 'c1',
        artifactCategory: 'analyzer',
        content: '[ERROR] Pod is in CrashLoopBackOff',
        metadata: { name: 'pod-status-check', severity: 'error' },
      }),
    ];
    const docs: DocumentContext[] = [
      { category: 'analyzer', name: 'pod-status-check', severity: 'error' },
    ];
    const result = contextualizeChunks(chunks, docs);
    expect(result[0]!.contextualizedContent).toContain('pod-status-check');
  });
});

// ---------------------------------------------------------------------------
// buildDocumentContext — derives context from chunk metadata
// ---------------------------------------------------------------------------

describe('buildDocumentContext', () => {
  it('returns the correct category for kubernetes-resource chunk', () => {
    const chunk = makeChunk({
      artifactCategory: 'kubernetes-resource',
      namespace: 'default',
      metadata: { kind: 'Pod', name: 'app-pod', namespace: 'default' },
    });
    const doc = buildDocumentContext(chunk);
    expect(doc.category).toBe('kubernetes-resource');
  });

  it('extracts kind and name from kubernetes-resource metadata', () => {
    const chunk = makeChunk({
      artifactCategory: 'kubernetes-resource',
      namespace: 'default',
      metadata: { kind: 'Pod', name: 'app-pod', namespace: 'default' },
    });
    const doc = buildDocumentContext(chunk);
    expect(doc.kind).toBe('Pod');
    expect(doc.name).toBe('app-pod');
    expect(doc.namespace).toBe('default');
  });

  it('extracts ConfigMap kind and name', () => {
    const chunk = makeChunk({
      artifactCategory: 'kubernetes-resource',
      namespace: 'staging',
      metadata: { kind: 'ConfigMap', name: 'db-config', namespace: 'staging' },
    });
    const doc = buildDocumentContext(chunk);
    expect(doc.kind).toBe('ConfigMap');
    expect(doc.name).toBe('db-config');
    expect(doc.namespace).toBe('staging');
  });

  it('extracts event reason from event chunk', () => {
    const chunk = makeChunk({
      artifactCategory: 'event',
      namespace: 'default',
      metadata: { reason: 'CrashLoopBackOff', name: 'my-pod', namespace: 'default', kind: 'Pod' },
    });
    const doc = buildDocumentContext(chunk);
    expect(doc.category).toBe('event');
    expect(doc.reason).toBe('CrashLoopBackOff');
    expect(doc.name).toBe('my-pod');
  });

  it('extracts path from log chunk metadata', () => {
    const chunk = makeChunk({
      artifactCategory: 'log',
      artifactId: 'pods/logs/default/app-pod/app.log',
      startLine: 100,
      endLine: 150,
      metadata: {
        path: 'pods/logs/default/app-pod/app.log',
        startLine: 100,
        endLine: 150,
      },
    });
    const doc = buildDocumentContext(chunk);
    expect(doc.category).toBe('log');
    expect(doc.path).toBe('pods/logs/default/app-pod/app.log');
    expect(doc.startLine).toBe(100);
    expect(doc.endLine).toBe(150);
  });

  it('falls back to artifactId for log path when metadata.path is missing', () => {
    const chunk = makeChunk({
      artifactCategory: 'log',
      artifactId: '/logs/app.log',
      startLine: 1,
      endLine: 20,
      metadata: {},
    });
    const doc = buildDocumentContext(chunk);
    expect(doc.path).toBe('/logs/app.log');
  });

  it('extracts name and severity from analyzer chunk', () => {
    const chunk = makeChunk({
      artifactCategory: 'analyzer',
      metadata: { name: 'pod-check', severity: 'warn' },
    });
    const doc = buildDocumentContext(chunk);
    expect(doc.category).toBe('analyzer');
    expect(doc.name).toBe('pod-check');
    expect(doc.severity).toBe('warn');
  });

  it('extracts name and namespace from helm-release chunk', () => {
    const chunk = makeChunk({
      artifactCategory: 'helm-release',
      namespace: 'production',
      metadata: { name: 'my-app', namespace: 'production' },
    });
    const doc = buildDocumentContext(chunk);
    expect(doc.category).toBe('helm-release');
    expect(doc.name).toBe('my-app');
    expect(doc.namespace).toBe('production');
  });

  it('includes startLine and endLine from chunk', () => {
    const chunk = makeChunk({
      artifactCategory: 'log',
      startLine: 45,
      endLine: 95,
      artifactId: '/logs/test.log',
      metadata: { path: '/logs/test.log' },
    });
    const doc = buildDocumentContext(chunk);
    expect(doc.startLine).toBe(45);
    expect(doc.endLine).toBe(95);
  });
});

// ---------------------------------------------------------------------------
// Integration: buildChunkIndex produces contextualizedContent
// ---------------------------------------------------------------------------

describe('buildChunkIndex contextualizedContent integration', () => {
  it('all chunks from buildChunkIndex have contextualizedContent', async () => {
    const { buildChunkIndex } = await import('../chunk-indexer.js');
    // Minimal context with one resource and one event
    const resource = {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: 'test-pod', namespace: 'default' },
      spec: { containers: [{ name: 'app', image: 'myapp:v1' }] },
      status: { phase: 'Running' },
    };
    const event = {
      type: 'Warning',
      reason: 'BackOff',
      message: 'Back-off pulling image',
      involvedObject: { kind: 'Pod', name: 'test-pod', namespace: 'default' },
      firstTimestamp: '2024-01-15T10:00:00Z',
      lastTimestamp: '2024-01-15T10:05:00Z',
      count: 3,
    };
    const analyzerResult = {
      name: 'pod-status',
      title: 'Pod Status',
      message: 'Pod is not ready',
      severity: 'error' as const,
      isPass: false,
      isFail: true,
      isWarn: false,
    };

    const ctx = {
      resources: [resource],
      events: [event],
      logs: [],
      analyzerResults: [analyzerResult],
      profile: {
        manifest: {
          bundlePath: '/test',
          extractedPath: '/test',
          files: [],
          totalSize: 0,
          extractedAt: new Date(),
        },
        analyzerCount: 1,
        logFileCount: 0,
        resourceCount: 1,
        eventCount: 1,
        namespaces: ['default'],
        workloads: [],
        coverageGaps: [],
        artifactsByCategory: {
          analyzer: 1,
          log: 0,
          'kubernetes-resource': 1,
          event: 1,
          'cluster-info': 0,
          'helm-release': 0,
          unknown: 0,
        },
      },
    };

    const chunks = buildChunkIndex(ctx);
    expect(chunks.length).toBeGreaterThan(0);

    for (const chunk of chunks) {
      expect(chunk.contextualizedContent).toBeDefined();
      expect(typeof chunk.contextualizedContent).toBe('string');
      expect(chunk.contextualizedContent!.length).toBeGreaterThan(0);
    }
  });

  it('contextualizedContent starts with context prefix for all chunk categories', async () => {
    const { buildChunkIndex } = await import('../chunk-indexer.js');
    const resource = {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: 'test-pod', namespace: 'default' },
      spec: { containers: [{ name: 'app', image: 'myapp:v1' }] },
      status: { phase: 'Running' },
    };
    const ctx = {
      resources: [resource],
      events: [],
      logs: [],
      analyzerResults: [],
      profile: {
        manifest: {
          bundlePath: '/test',
          extractedPath: '/test',
          files: [],
          totalSize: 0,
          extractedAt: new Date(),
        },
        analyzerCount: 0,
        logFileCount: 0,
        resourceCount: 1,
        eventCount: 0,
        namespaces: ['default'],
        workloads: [],
        coverageGaps: [],
        artifactsByCategory: {
          analyzer: 0,
          log: 0,
          'kubernetes-resource': 1,
          event: 0,
          'cluster-info': 0,
          'helm-release': 0,
          unknown: 0,
        },
      },
    };
    const chunks = buildChunkIndex(ctx);
    for (const chunk of chunks) {
      expect(chunk.contextualizedContent).toMatch(/^This chunk is from/);
    }
  });

  it('contextualizedContent for Pod chunk includes pod name', async () => {
    const { buildChunkIndex } = await import('../chunk-indexer.js');
    const resource = {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: 'crash-pod', namespace: 'default' },
      spec: { containers: [{ name: 'app', image: 'myapp:v1' }] },
      status: { phase: 'Running' },
    };
    const ctx = {
      resources: [resource],
      events: [],
      logs: [],
      analyzerResults: [],
      profile: {
        manifest: {
          bundlePath: '/test',
          extractedPath: '/test',
          files: [],
          totalSize: 0,
          extractedAt: new Date(),
        },
        analyzerCount: 0,
        logFileCount: 0,
        resourceCount: 1,
        eventCount: 0,
        namespaces: ['default'],
        workloads: [],
        coverageGaps: [],
        artifactsByCategory: {
          analyzer: 0,
          log: 0,
          'kubernetes-resource': 1,
          event: 0,
          'cluster-info': 0,
          'helm-release': 0,
          unknown: 0,
        },
      },
    };
    const chunks = buildChunkIndex(ctx);
    const podChunk = chunks.find((c) => c.artifactCategory === 'kubernetes-resource');
    expect(podChunk).toBeDefined();
    expect(podChunk!.contextualizedContent).toContain('crash-pod');
  });

  it('raw content is preserved after contextualization in buildChunkIndex', async () => {
    const { buildChunkIndex } = await import('../chunk-indexer.js');
    const resource = {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: 'test-pod', namespace: 'default' },
      spec: { containers: [{ name: 'app', image: 'myapp:v1' }] },
      status: { phase: 'Running' },
    };
    const ctx = {
      resources: [resource],
      events: [],
      logs: [],
      analyzerResults: [],
      profile: {
        manifest: {
          bundlePath: '/test',
          extractedPath: '/test',
          files: [],
          totalSize: 0,
          extractedAt: new Date(),
        },
        analyzerCount: 0,
        logFileCount: 0,
        resourceCount: 1,
        eventCount: 0,
        namespaces: ['default'],
        workloads: [],
        coverageGaps: [],
        artifactsByCategory: {
          analyzer: 0,
          log: 0,
          'kubernetes-resource': 1,
          event: 0,
          'cluster-info': 0,
          'helm-release': 0,
          unknown: 0,
        },
      },
    };
    const chunks = buildChunkIndex(ctx);
    for (const chunk of chunks) {
      // content must still be set (raw, unchanged)
      expect(chunk.content).toBeTruthy();
      // contextualizedContent must contain content
      expect(chunk.contextualizedContent).toContain(chunk.content);
    }
  });
});
