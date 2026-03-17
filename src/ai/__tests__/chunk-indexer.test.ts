import { describe, it, expect } from 'vitest';
import { buildChunkIndex } from '../chunk-indexer.js';
import type { InvestigatorContext } from '../../investigators/types.js';
import type { K8sResource, K8sEvent, AnalyzerResult } from '../../types/index.js';
import type { LogFile } from '../../parsers/index.js';
import type { BundleProfile } from '../../types/index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const EMPTY_PROFILE: BundleProfile = {
  manifest: {
    bundlePath: '/test',
    extractedPath: '/test/extracted',
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
  artifactsByCategory: {
    analyzer: 0,
    log: 0,
    'kubernetes-resource': 0,
    event: 0,
    config: 0,
    'cluster-info': 0,
    'helm-release': 0,
    unknown: 0,
  },
};

function makePodResource(name: string, namespace = 'default'): K8sResource {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name, namespace },
    spec: {
      volumes: [
        { name: 'secret-vol', secret: { secretName: 'my-secret' } },
        { name: 'cm-vol', configMap: { name: 'my-config' } },
      ],
      containers: [
        {
          name: 'app',
          image: 'myrepo/app:v1.0.0',
          env: [
            { name: 'DB_PASS', valueFrom: { secretKeyRef: { name: 'db-secret', key: 'password' } } },
          ],
        },
      ],
    },
    status: {
      phase: 'Running',
      conditions: [{ type: 'Ready', status: 'True' }],
      containerStatuses: [{ name: 'app', ready: true, restartCount: 0, state: { running: {} } }],
    },
  };
}

function makeCrashPodResource(name: string, namespace = 'default'): K8sResource {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name, namespace },
    spec: {
      containers: [{ name: 'app', image: 'myrepo/app:v2.0.0' }],
    },
    status: {
      phase: 'Running',
      conditions: [{ type: 'Ready', status: 'False', reason: 'ContainersNotReady' }],
      containerStatuses: [
        {
          name: 'app',
          ready: false,
          restartCount: 5,
          state: { waiting: { reason: 'CrashLoopBackOff', message: 'back-off 5m0s' } },
        },
      ],
    },
  };
}

function makeConfigMapResource(name: string, namespace = 'default'): K8sResource {
  return {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name, namespace },
    data: { DB_HOST: 'localhost', DB_PORT: '5432' },
  } as unknown as K8sResource;
}

function makeDeploymentResource(name: string, namespace = 'default'): K8sResource {
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name, namespace },
    spec: {
      replicas: 2,
      template: {
        spec: {
          volumes: [
            { name: 'config', configMap: { name: 'app-config' } },
            { name: 'creds', secret: { secretName: 'app-secret' } },
          ],
          containers: [
            {
              name: 'app',
              image: 'myrepo/deploy:v3.1.4',
              envFrom: [{ secretRef: { name: 'env-secret' } }],
              env: [{ name: 'SETTINGS', valueFrom: { configMapKeyRef: { name: 'env-config', key: 'MODE' } } }],
            },
          ],
        },
      },
    },
    status: { readyReplicas: 1, availableReplicas: 1 },
  };
}

function makeEvent(reason: string, podName: string, namespace = 'default'): K8sEvent {
  return {
    type: 'Warning',
    reason,
    message: `${reason} on pod ${podName}`,
    involvedObject: { kind: 'Pod', name: podName, namespace },
    firstTimestamp: '2024-01-15T10:00:00Z',
    lastTimestamp: '2024-01-15T10:05:00Z',
    count: 3,
  };
}

function makeLogFile(path: string, errorLines = 0): LogFile {
  const lines = [
    { lineNumber: 1, content: '2024-01-15T10:00:00Z INFO starting app', level: 'info' as const },
    { lineNumber: 2, content: '2024-01-15T10:00:01Z INFO connected to database', level: 'info' as const },
    ...Array.from({ length: errorLines }, (_, i) => ({
      lineNumber: 3 + i,
      content: `2024-01-15T10:0${i}:02Z ERROR connection refused: postgres:5432`,
      level: 'error' as const,
    })),
  ];
  return {
    path,
    lines,
    errorCount: errorLines,
    warningCount: 0,
    importance: errorLines > 0 ? 0.5 : 0,
  };
}

function makeAnalyzerResult(name: string, severity: AnalyzerResult['severity']): AnalyzerResult {
  return {
    name,
    title: `Check: ${name}`,
    message: `Result for ${name}`,
    severity,
    isPass: severity === 'pass',
    isFail: severity === 'error',
    isWarn: severity === 'warn',
  };
}

function makeContext(overrides: Partial<InvestigatorContext> = {}): InvestigatorContext {
  return {
    analyzerResults: [],
    resources: [],
    events: [],
    logs: [],
    profile: EMPTY_PROFILE,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildChunkIndex — basic structure
// ---------------------------------------------------------------------------

describe('buildChunkIndex', () => {
  it('returns empty array for empty context', () => {
    const chunks = buildChunkIndex(makeContext());
    expect(chunks).toHaveLength(0);
  });

  it('produces one chunk per K8s resource', () => {
    const ctx = makeContext({
      resources: [makePodResource('pod-1'), makePodResource('pod-2')],
    });
    const chunks = buildChunkIndex(ctx);
    const resourceChunks = chunks.filter((c) => c.artifactCategory === 'kubernetes-resource');
    expect(resourceChunks).toHaveLength(2);
  });

  it('produces one chunk per event', () => {
    const ctx = makeContext({
      events: [
        makeEvent('BackOff', 'pod-1'),
        makeEvent('BackOff', 'pod-2'),
        makeEvent('Killing', 'pod-1'),
      ],
    });
    const chunks = buildChunkIndex(ctx);
    const eventChunks = chunks.filter((c) => c.artifactCategory === 'event');
    expect(eventChunks).toHaveLength(3);
  });

  it('produces one chunk per analyzer result', () => {
    const ctx = makeContext({
      analyzerResults: [
        makeAnalyzerResult('check-1', 'error'),
        makeAnalyzerResult('check-2', 'warn'),
        makeAnalyzerResult('check-3', 'pass'),
      ],
    });
    const chunks = buildChunkIndex(ctx);
    const analyzerChunks = chunks.filter((c) => c.artifactCategory === 'analyzer');
    expect(analyzerChunks).toHaveLength(3);
  });

  it('produces multiple log chunks for large log files', () => {
    // 55 lines → should produce 2 chunks with chunkSize=50, overlap=10
    const lines = Array.from({ length: 55 }, (_, i) => ({
      lineNumber: i + 1,
      content: `Line ${i + 1}`,
      level: 'info' as const,
    }));
    const logFile: LogFile = { path: '/logs/app.log', lines, errorCount: 0, warningCount: 0, importance: 0 };
    const ctx = makeContext({ logs: [logFile] });
    const chunks = buildChunkIndex(ctx);
    const logChunks = chunks.filter((c) => c.artifactCategory === 'log');
    expect(logChunks.length).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// IndexedChunk metadata completeness
// ---------------------------------------------------------------------------

describe('IndexedChunk citation metadata', () => {
  it('every chunk has a non-empty stable id', () => {
    const ctx = makeContext({
      resources: [makePodResource('my-pod')],
      events: [makeEvent('BackOff', 'my-pod')],
      logs: [makeLogFile('/logs/app.log', 1)],
      analyzerResults: [makeAnalyzerResult('check-x', 'error')],
    });
    const chunks = buildChunkIndex(ctx);
    for (const chunk of chunks) {
      expect(chunk.id).toBeTruthy();
      expect(typeof chunk.id).toBe('string');
    }
  });

  it('every chunk has a non-empty artifactId (file path)', () => {
    const ctx = makeContext({
      resources: [makePodResource('my-pod')],
      events: [makeEvent('BackOff', 'my-pod')],
      analyzerResults: [makeAnalyzerResult('check-x', 'error')],
    });
    const chunks = buildChunkIndex(ctx);
    for (const chunk of chunks) {
      expect(chunk.artifactId).toBeTruthy();
    }
  });

  it('every chunk has a valid line range (startLine >= 1, endLine >= startLine)', () => {
    const ctx = makeContext({
      resources: [makePodResource('my-pod')],
      events: [makeEvent('BackOff', 'my-pod')],
      analyzerResults: [makeAnalyzerResult('check-x', 'error')],
      logs: [makeLogFile('/logs/app.log', 2)],
    });
    const chunks = buildChunkIndex(ctx);
    for (const chunk of chunks) {
      expect(chunk.startLine).toBeGreaterThanOrEqual(1);
      expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine);
    }
  });

  it('every chunk has an artifactCategory', () => {
    const ctx = makeContext({
      resources: [makePodResource('my-pod')],
      events: [makeEvent('BackOff', 'my-pod')],
      analyzerResults: [makeAnalyzerResult('check-x', 'error')],
      logs: [makeLogFile('/logs/app.log')],
    });
    const chunks = buildChunkIndex(ctx);
    const categories = new Set(chunks.map((c) => c.artifactCategory));
    expect(categories.has('kubernetes-resource')).toBe(true);
    expect(categories.has('event')).toBe(true);
    expect(categories.has('analyzer')).toBe(true);
    expect(categories.has('log')).toBe(true);
  });

  it('every chunk has a non-empty summary', () => {
    const ctx = makeContext({
      resources: [makePodResource('my-pod')],
      events: [makeEvent('BackOff', 'my-pod')],
      analyzerResults: [makeAnalyzerResult('check-x', 'error')],
      logs: [makeLogFile('/logs/app.log')],
    });
    const chunks = buildChunkIndex(ctx);
    for (const chunk of chunks) {
      expect(chunk.summary).toBeTruthy();
      expect(typeof chunk.summary).toBe('string');
    }
  });
});

// ---------------------------------------------------------------------------
// Identifier extraction
// ---------------------------------------------------------------------------

describe('IndexedChunk identifiers', () => {
  it('resource chunk identifiers include pod name', () => {
    const ctx = makeContext({ resources: [makePodResource('my-pod', 'staging')] });
    const chunks = buildChunkIndex(ctx);
    const chunk = chunks.find((c) => c.artifactCategory === 'kubernetes-resource');
    expect(chunk).toBeDefined();
    expect(chunk!.identifiers).toContain('my-pod');
  });

  it('resource chunk identifiers include namespace', () => {
    const ctx = makeContext({ resources: [makePodResource('my-pod', 'staging')] });
    const chunks = buildChunkIndex(ctx);
    const chunk = chunks.find((c) => c.artifactCategory === 'kubernetes-resource');
    expect(chunk!.identifiers).toContain('staging');
  });

  it('resource chunk identifiers include referenced secret names', () => {
    const ctx = makeContext({ resources: [makePodResource('my-pod')] });
    const chunks = buildChunkIndex(ctx);
    const chunk = chunks.find((c) => c.artifactCategory === 'kubernetes-resource');
    expect(chunk!.identifiers).toContain('my-secret');
    expect(chunk!.identifiers).toContain('db-secret');
  });

  it('resource chunk identifiers include image tags', () => {
    const ctx = makeContext({ resources: [makePodResource('my-pod')] });
    const chunks = buildChunkIndex(ctx);
    const chunk = chunks.find((c) => c.artifactCategory === 'kubernetes-resource');
    expect(chunk!.identifiers).toContain('myrepo/app:v1.0.0');
  });

  it('resource chunk identifiers include container error reasons', () => {
    const ctx = makeContext({ resources: [makeCrashPodResource('crash-pod')] });
    const chunks = buildChunkIndex(ctx);
    const chunk = chunks.find((c) => c.artifactCategory === 'kubernetes-resource');
    expect(chunk!.identifiers).toContain('crash-pod');
    expect(chunk!.identifiers).toContain('CrashLoopBackOff');
    expect(chunk!.identifiers).toContain('ContainersNotReady');
  });

  it('workload resource identifiers include template secret and configmap references', () => {
    const ctx = makeContext({ resources: [makeDeploymentResource('api-deploy', 'production')] });
    const chunks = buildChunkIndex(ctx);
    const chunk = chunks.find((c) => c.artifactCategory === 'kubernetes-resource');
    expect(chunk!.identifiers).toContain('app-secret');
    expect(chunk!.identifiers).toContain('env-secret');
    expect(chunk!.identifiers).toContain('app-config');
    expect(chunk!.identifiers).toContain('env-config');
    expect(chunk!.identifiers).toContain('myrepo/deploy:v3.1.4');
  });

  it('log chunk identifiers include error reasons found in content', () => {
    const lines = [
      { lineNumber: 1, content: 'INFO starting', level: 'info' as const },
      { lineNumber: 2, content: 'ERROR CrashLoopBackOff detected', level: 'error' as const },
    ];
    const logFile: LogFile = { path: '/logs/app.log', lines, errorCount: 1, warningCount: 0, importance: 0.5 };
    const ctx = makeContext({ logs: [logFile] });
    const chunks = buildChunkIndex(ctx);
    const logChunk = chunks.find((c) => c.artifactCategory === 'log');
    expect(logChunk!.identifiers).toContain('CrashLoopBackOff');
  });

  it('event chunk identifiers include involved object name', () => {
    const ctx = makeContext({ events: [makeEvent('BackOff', 'my-pod', 'default')] });
    const chunks = buildChunkIndex(ctx);
    const eventChunk = chunks.find((c) => c.artifactCategory === 'event');
    expect(eventChunk!.identifiers).toContain('my-pod');
    expect(eventChunk!.identifiers).toContain('BackOff');
  });

  it('event chunk has namespace set', () => {
    const ctx = makeContext({ events: [makeEvent('BackOff', 'my-pod', 'production')] });
    const chunks = buildChunkIndex(ctx);
    const eventChunk = chunks.find((c) => c.artifactCategory === 'event');
    expect(eventChunk!.namespace).toBe('production');
  });

  it('event chunk has timestamp from lastTimestamp', () => {
    const ctx = makeContext({ events: [makeEvent('BackOff', 'my-pod')] });
    const chunks = buildChunkIndex(ctx);
    const eventChunk = chunks.find((c) => c.artifactCategory === 'event');
    expect(eventChunk!.timestamp).toBe('2024-01-15T10:05:00Z');
  });

  it('log chunk timestamp is extracted from first log line', () => {
    const ctx = makeContext({ logs: [makeLogFile('/logs/app.log')] });
    const chunks = buildChunkIndex(ctx);
    const logChunk = chunks.find((c) => c.artifactCategory === 'log');
    expect(logChunk!.timestamp).toContain('2024-01-15');
  });
});

// ---------------------------------------------------------------------------
// Chunk IDs are stable and unique
// ---------------------------------------------------------------------------

describe('chunk IDs uniqueness', () => {
  it('all chunk IDs within a context are unique', () => {
    const ctx = makeContext({
      resources: [makePodResource('pod-1'), makePodResource('pod-2'), makeConfigMapResource('cm-1')],
      events: [makeEvent('BackOff', 'pod-1'), makeEvent('BackOff', 'pod-2')],
      analyzerResults: [makeAnalyzerResult('check-a', 'error'), makeAnalyzerResult('check-b', 'warn')],
      logs: [makeLogFile('/logs/app.log'), makeLogFile('/logs/system.log')],
    });
    const chunks = buildChunkIndex(ctx);
    const ids = chunks.map((c) => c.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });
});
