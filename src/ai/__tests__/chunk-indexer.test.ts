import { describe, it, expect } from 'vitest';
import { buildChunkIndex, identifiersFromHelmRelease } from '../chunk-indexer.js';
import type { InvestigatorContext } from '../../investigators/types.js';
import type { K8sResource, K8sEvent, AnalyzerResult } from '../../types/index.js';
import type { LogFile, HelmRelease } from '../../parsers/index.js';
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
// ConfigMap data value indexing (step-11 / issue 2.9)
// ---------------------------------------------------------------------------

describe('ConfigMap data value network identifier indexing', () => {
  it('ConfigMap identifiers include hostname values from data', () => {
    const cm = {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: 'db-config', namespace: 'database' },
      data: { DB_HOST: 'wrong-host.internal' },
    } as unknown as K8sResource;
    const ctx = makeContext({ resources: [cm] });
    const chunks = buildChunkIndex(ctx);
    const chunk = chunks.find((c) => c.artifactCategory === 'kubernetes-resource');
    expect(chunk).toBeDefined();
    expect(chunk!.identifiers).toContain('wrong-host.internal');
  });

  it('ConfigMap identifiers still include key names alongside values', () => {
    const cm = {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: 'db-config', namespace: 'database' },
      data: { DB_HOST: 'wrong-host.internal', DB_PORT: '5432' },
    } as unknown as K8sResource;
    const ctx = makeContext({ resources: [cm] });
    const chunks = buildChunkIndex(ctx);
    const chunk = chunks.find((c) => c.artifactCategory === 'kubernetes-resource');
    expect(chunk!.identifiers).toContain('DB_HOST');
    expect(chunk!.identifiers).toContain('DB_PORT');
    expect(chunk!.identifiers).toContain('wrong-host.internal');
    // Plain port number is NOT a network identifier
    expect(chunk!.identifiers).not.toContain('5432');
  });

  it('ConfigMap URL values yield the extracted hostname', () => {
    const cm = {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: 'api-config', namespace: 'default' },
      data: { API_URL: 'https://api.example.com' },
    } as unknown as K8sResource;
    const ctx = makeContext({ resources: [cm] });
    const chunks = buildChunkIndex(ctx);
    const chunk = chunks.find((c) => c.artifactCategory === 'kubernetes-resource');
    expect(chunk!.identifiers).toContain('api.example.com');
  });

  it('ConfigMap hostname:port values yield the extracted hostname', () => {
    const cm = {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: 'svc-config', namespace: 'default' },
      data: { REDIS_ADDR: 'cache-pod.default.svc.cluster.local:6379' },
    } as unknown as K8sResource;
    const ctx = makeContext({ resources: [cm] });
    const chunks = buildChunkIndex(ctx);
    const chunk = chunks.find((c) => c.artifactCategory === 'kubernetes-resource');
    expect(chunk!.identifiers).toContain('cache-pod.default.svc.cluster.local');
  });

  it('ConfigMap non-network values (plain strings, numbers) are NOT added', () => {
    const cm = {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: 'app-config', namespace: 'default' },
      data: { APP_ENV: 'production', MAX_CONN: '100', LOG_LEVEL: 'info' },
    } as unknown as K8sResource;
    const ctx = makeContext({ resources: [cm] });
    const chunks = buildChunkIndex(ctx);
    const chunk = chunks.find((c) => c.artifactCategory === 'kubernetes-resource');
    expect(chunk!.identifiers).not.toContain('production');
    expect(chunk!.identifiers).not.toContain('100');
    expect(chunk!.identifiers).not.toContain('info');
  });
});

// ---------------------------------------------------------------------------
// Pod env literal value indexing (step-11 / issue 2.9)
// ---------------------------------------------------------------------------

describe('Pod env literal value network identifier indexing', () => {
  it('Pod identifiers include hostname extracted from URL env value', () => {
    const pod = {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: 'api-pod', namespace: 'default' },
      spec: {
        containers: [
          {
            name: 'api',
            image: 'myrepo/api:v1.0.0',
            env: [{ name: 'API_URL', value: 'https://api.example.com' }],
          },
        ],
      },
    } as unknown as K8sResource;
    const ctx = makeContext({ resources: [pod] });
    const chunks = buildChunkIndex(ctx);
    const chunk = chunks.find((c) => c.artifactCategory === 'kubernetes-resource');
    expect(chunk).toBeDefined();
    expect(chunk!.identifiers).toContain('api.example.com');
  });

  it('Pod identifiers include bare hostname from literal env value', () => {
    const pod = {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: 'db-pod', namespace: 'default' },
      spec: {
        containers: [
          {
            name: 'app',
            image: 'myrepo/app:v1.0.0',
            env: [{ name: 'DB_HOST', value: 'db.internal.example.com' }],
          },
        ],
      },
    } as unknown as K8sResource;
    const ctx = makeContext({ resources: [pod] });
    const chunks = buildChunkIndex(ctx);
    const chunk = chunks.find((c) => c.artifactCategory === 'kubernetes-resource');
    expect(chunk!.identifiers).toContain('db.internal.example.com');
  });

  it('Pod plain port number env value is NOT added as identifier', () => {
    const pod = {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: 'db-pod', namespace: 'default' },
      spec: {
        containers: [
          {
            name: 'app',
            image: 'myrepo/app:v1.0.0',
            env: [{ name: 'DB_PORT', value: '5432' }],
          },
        ],
      },
    } as unknown as K8sResource;
    const ctx = makeContext({ resources: [pod] });
    const chunks = buildChunkIndex(ctx);
    const chunk = chunks.find((c) => c.artifactCategory === 'kubernetes-resource');
    expect(chunk!.identifiers).not.toContain('5432');
  });

  it('Pod valueFrom references are still indexed alongside literal values', () => {
    const pod = {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: 'mixed-pod', namespace: 'default' },
      spec: {
        containers: [
          {
            name: 'app',
            image: 'myrepo/app:v1.0.0',
            env: [
              { name: 'API_URL', value: 'https://api.example.com' },
              { name: 'DB_PASS', valueFrom: { secretKeyRef: { name: 'db-secret', key: 'password' } } },
            ],
          },
        ],
      },
    } as unknown as K8sResource;
    const ctx = makeContext({ resources: [pod] });
    const chunks = buildChunkIndex(ctx);
    const chunk = chunks.find((c) => c.artifactCategory === 'kubernetes-resource');
    expect(chunk!.identifiers).toContain('api.example.com');
    expect(chunk!.identifiers).toContain('db-secret');
  });
});

// ---------------------------------------------------------------------------
// Log chunk path-based pod name extraction (issue 1.3)
// ---------------------------------------------------------------------------

describe('log chunk path-based identifier extraction', () => {
  it('extracts pod name from real bundle path pods/logs/<ns>/<pod>/<container>.log', () => {
    const logFile: LogFile = {
      path: 'pods/logs/default/app-pod/app.log',
      lines: [{ lineNumber: 1, content: 'some log content', level: 'info' }],
      errorCount: 0,
      warningCount: 0,
      importance: 0,
    };
    const ctx = makeContext({ logs: [logFile] });
    const chunks = buildChunkIndex(ctx);
    const logChunk = chunks.find((c) => c.artifactCategory === 'log');
    expect(logChunk).toBeDefined();
    expect(logChunk!.identifiers).toContain('app-pod');
  });

  it('extracts pod name from path where filename has .log extension: logs/app/app-pod.log', () => {
    const logFile: LogFile = {
      path: 'logs/app/app-pod.log',
      lines: [{ lineNumber: 1, content: 'some log content', level: 'info' }],
      errorCount: 0,
      warningCount: 0,
      importance: 0,
    };
    const ctx = makeContext({ logs: [logFile] });
    const chunks = buildChunkIndex(ctx);
    const logChunk = chunks.find((c) => c.artifactCategory === 'log');
    expect(logChunk).toBeDefined();
    expect(logChunk!.identifiers).toContain('app-pod');
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

  it('chunk IDs for two resources from the same List file are unique', () => {
    const pod1 = makePodResource('pod-1');
    const pod2 = makePodResource('pod-2');
    const sourceFile = 'cluster-resources/pods/default.json';
    const resourceSourceFiles = new Map<import('../../types/index.js').K8sResource, string>([
      [pod1, sourceFile],
      [pod2, sourceFile],
    ]);
    const ctx = makeContext({ resources: [pod1, pod2], resourceSourceFiles });
    const chunks = buildChunkIndex(ctx);
    const ids = chunks.map((c) => c.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });
});

// ---------------------------------------------------------------------------
// Resource source file path tracking (issue 1.2)
// ---------------------------------------------------------------------------

describe('resource chunk source file paths', () => {
  it('uses artifactId from resourceSourceFiles when provided', () => {
    const pod = makePodResource('app-pod');
    const sourceFile = 'cluster-resources/pods/default.json';
    const resourceSourceFiles = new Map<import('../../types/index.js').K8sResource, string>([
      [pod, sourceFile],
    ]);
    const ctx = makeContext({ resources: [pod], resourceSourceFiles });
    const chunks = buildChunkIndex(ctx);
    const chunk = chunks.find((c) => c.artifactCategory === 'kubernetes-resource');
    expect(chunk).toBeDefined();
    expect(chunk!.artifactId).toBe('cluster-resources/pods/default.json');
  });

  it('chunk id includes resource name as qualifier when source file is provided', () => {
    const pod = makePodResource('app-pod');
    const sourceFile = 'cluster-resources/pods/default.json';
    const resourceSourceFiles = new Map<import('../../types/index.js').K8sResource, string>([
      [pod, sourceFile],
    ]);
    const ctx = makeContext({ resources: [pod], resourceSourceFiles });
    const chunks = buildChunkIndex(ctx);
    const chunk = chunks.find((c) => c.artifactCategory === 'kubernetes-resource');
    expect(chunk).toBeDefined();
    expect(chunk!.id).toBe('cluster-resources/pods/default.json:app-pod:resource');
  });

  it('does NOT use fabricated per-resource path when source file is provided', () => {
    const pod = makePodResource('app-pod');
    const sourceFile = 'cluster-resources/pods/default.json';
    const resourceSourceFiles = new Map<import('../../types/index.js').K8sResource, string>([
      [pod, sourceFile],
    ]);
    const ctx = makeContext({ resources: [pod], resourceSourceFiles });
    const chunks = buildChunkIndex(ctx);
    const chunk = chunks.find((c) => c.artifactCategory === 'kubernetes-resource');
    expect(chunk).toBeDefined();
    // Must NOT be the old fabricated per-resource path
    expect(chunk!.artifactId).not.toContain('pod/default/app-pod');
  });

  it('multiple resources from the same List file share the same artifactId', () => {
    const pod1 = makePodResource('pod-1');
    const pod2 = makePodResource('pod-2');
    const sourceFile = 'cluster-resources/pods/default.json';
    const resourceSourceFiles = new Map<import('../../types/index.js').K8sResource, string>([
      [pod1, sourceFile],
      [pod2, sourceFile],
    ]);
    const ctx = makeContext({ resources: [pod1, pod2], resourceSourceFiles });
    const chunks = buildChunkIndex(ctx).filter((c) => c.artifactCategory === 'kubernetes-resource');
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.artifactId).toBe('cluster-resources/pods/default.json');
    expect(chunks[1]!.artifactId).toBe('cluster-resources/pods/default.json');
    // IDs must still be unique (name qualifier disambiguates)
    expect(chunks[0]!.id).not.toBe(chunks[1]!.id);
  });

  it('falls back to constructed path when resourceSourceFiles is absent', () => {
    const pod = makePodResource('app-pod');
    const ctx = makeContext({ resources: [pod] });
    const chunks = buildChunkIndex(ctx);
    const chunk = chunks.find((c) => c.artifactCategory === 'kubernetes-resource');
    expect(chunk).toBeDefined();
    // Fallback path should still be non-empty and contain relevant info
    expect(chunk!.artifactId).toBeTruthy();
    expect(chunk!.id).toContain('app-pod');
  });
});

// ---------------------------------------------------------------------------
// Helm release helpers
// ---------------------------------------------------------------------------

function makeHelmRelease(overrides: Partial<HelmRelease> = {}): HelmRelease {
  return {
    name: 'my-app',
    namespace: 'default',
    revision: 3,
    status: 'deployed',
    chart: 'my-chart',
    chartVersion: '1.2.3',
    appVersion: '2.0.0',
    updatedAt: '2024-01-15T10:00:00Z',
    values: { replicaCount: 2, image: { tag: 'v2.0.0' } },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// InvestigatorContext helmReleases field (issue 1.6)
// ---------------------------------------------------------------------------

describe('InvestigatorContext helmReleases field', () => {
  it('accepts helmReleases as an optional field', () => {
    const ctx: InvestigatorContext = makeContext({
      helmReleases: [makeHelmRelease()],
    });
    expect(ctx.helmReleases).toHaveLength(1);
  });

  it('is absent when not provided', () => {
    const ctx = makeContext();
    expect(ctx.helmReleases).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Helm release chunk indexing (issue 1.6)
// ---------------------------------------------------------------------------

describe('buildChunkIndex — Helm releases', () => {
  it('produces no Helm chunks when helmReleases is absent', () => {
    const ctx = makeContext({ resources: [makePodResource('pod-1')] });
    const chunks = buildChunkIndex(ctx);
    const helmChunks = chunks.filter((c) => c.artifactCategory === 'helm-release');
    expect(helmChunks).toHaveLength(0);
  });

  it('produces one chunk per Helm release', () => {
    const ctx = makeContext({
      helmReleases: [
        makeHelmRelease({ name: 'app-1', namespace: 'default' }),
        makeHelmRelease({ name: 'app-2', namespace: 'staging' }),
      ],
    });
    const chunks = buildChunkIndex(ctx);
    const helmChunks = chunks.filter((c) => c.artifactCategory === 'helm-release');
    expect(helmChunks).toHaveLength(2);
  });

  it('Helm release chunk has artifactCategory = helm-release', () => {
    const ctx = makeContext({ helmReleases: [makeHelmRelease()] });
    const chunks = buildChunkIndex(ctx);
    const helmChunk = chunks.find((c) => c.artifactCategory === 'helm-release');
    expect(helmChunk).toBeDefined();
    expect(helmChunk!.artifactCategory).toBe('helm-release');
  });

  it('Helm release chunk identifiers include release name', () => {
    const ctx = makeContext({ helmReleases: [makeHelmRelease({ name: 'my-app' })] });
    const chunks = buildChunkIndex(ctx);
    const helmChunk = chunks.find((c) => c.artifactCategory === 'helm-release');
    expect(helmChunk!.identifiers).toContain('my-app');
  });

  it('Helm release chunk identifiers include namespace', () => {
    const ctx = makeContext({ helmReleases: [makeHelmRelease({ namespace: 'production' })] });
    const chunks = buildChunkIndex(ctx);
    const helmChunk = chunks.find((c) => c.artifactCategory === 'helm-release');
    expect(helmChunk!.identifiers).toContain('production');
  });

  it('Helm release chunk identifiers include chart name', () => {
    const ctx = makeContext({ helmReleases: [makeHelmRelease({ chart: 'my-chart' })] });
    const chunks = buildChunkIndex(ctx);
    const helmChunk = chunks.find((c) => c.artifactCategory === 'helm-release');
    expect(helmChunk!.identifiers).toContain('my-chart');
  });

  it('Helm release chunk identifiers include chart version', () => {
    const ctx = makeContext({ helmReleases: [makeHelmRelease({ chartVersion: '1.2.3' })] });
    const chunks = buildChunkIndex(ctx);
    const helmChunk = chunks.find((c) => c.artifactCategory === 'helm-release');
    expect(helmChunk!.identifiers).toContain('1.2.3');
  });

  it('Helm release chunk identifiers include status', () => {
    const ctx = makeContext({ helmReleases: [makeHelmRelease({ status: 'deployed' })] });
    const chunks = buildChunkIndex(ctx);
    const helmChunk = chunks.find((c) => c.artifactCategory === 'helm-release');
    expect(helmChunk!.identifiers).toContain('deployed');
  });

  it('failed release has "failed" in identifiers', () => {
    const ctx = makeContext({
      helmReleases: [makeHelmRelease({ name: 'broken-app', status: 'failed' })],
    });
    const chunks = buildChunkIndex(ctx);
    const helmChunk = chunks.find((c) => c.artifactCategory === 'helm-release');
    expect(helmChunk!.identifiers).toContain('failed');
  });

  it('pending-install release has "pending-install" in identifiers', () => {
    const ctx = makeContext({
      helmReleases: [makeHelmRelease({ status: 'pending-install' })],
    });
    const chunks = buildChunkIndex(ctx);
    const helmChunk = chunks.find((c) => c.artifactCategory === 'helm-release');
    expect(helmChunk!.identifiers).toContain('pending-install');
  });

  it('Helm release chunk has non-empty summary', () => {
    const ctx = makeContext({ helmReleases: [makeHelmRelease()] });
    const chunks = buildChunkIndex(ctx);
    const helmChunk = chunks.find((c) => c.artifactCategory === 'helm-release');
    expect(helmChunk!.summary).toBeTruthy();
    expect(helmChunk!.summary).toContain('my-app');
    expect(helmChunk!.summary).toContain('my-chart');
    expect(helmChunk!.summary).toContain('deployed');
  });

  it('Helm release chunk has namespace set', () => {
    const ctx = makeContext({ helmReleases: [makeHelmRelease({ namespace: 'staging' })] });
    const chunks = buildChunkIndex(ctx);
    const helmChunk = chunks.find((c) => c.artifactCategory === 'helm-release');
    expect(helmChunk!.namespace).toBe('staging');
  });

  it('Helm release chunk artifactId contains namespace and name', () => {
    const ctx = makeContext({ helmReleases: [makeHelmRelease({ name: 'my-app', namespace: 'default' })] });
    const chunks = buildChunkIndex(ctx);
    const helmChunk = chunks.find((c) => c.artifactCategory === 'helm-release');
    expect(helmChunk!.artifactId).toBe('helm/default/my-app');
  });

  it('Helm release chunk id is stable and unique', () => {
    const ctx = makeContext({
      helmReleases: [
        makeHelmRelease({ name: 'app-1', namespace: 'default' }),
        makeHelmRelease({ name: 'app-2', namespace: 'default' }),
      ],
    });
    const chunks = buildChunkIndex(ctx).filter((c) => c.artifactCategory === 'helm-release');
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.id).not.toBe(chunks[1]!.id);
    expect(chunks[0]!.id).toBe('helm-release:default:app-1');
    expect(chunks[1]!.id).toBe('helm-release:default:app-2');
  });

  it('Helm release chunk has valid line range', () => {
    const ctx = makeContext({ helmReleases: [makeHelmRelease()] });
    const chunks = buildChunkIndex(ctx);
    const helmChunk = chunks.find((c) => c.artifactCategory === 'helm-release');
    expect(helmChunk!.startLine).toBeGreaterThanOrEqual(1);
    expect(helmChunk!.endLine).toBeGreaterThanOrEqual(helmChunk!.startLine);
  });
});

// ---------------------------------------------------------------------------
// identifiersFromHelmRelease helper
// ---------------------------------------------------------------------------

describe('identifiersFromHelmRelease', () => {
  it('returns name', () => {
    const ids = identifiersFromHelmRelease(makeHelmRelease({ name: 'my-release' }));
    expect(ids).toContain('my-release');
  });

  it('returns namespace', () => {
    const ids = identifiersFromHelmRelease(makeHelmRelease({ namespace: 'kube-system' }));
    expect(ids).toContain('kube-system');
  });

  it('returns chart name', () => {
    const ids = identifiersFromHelmRelease(makeHelmRelease({ chart: 'nginx-ingress' }));
    expect(ids).toContain('nginx-ingress');
  });

  it('returns chart version', () => {
    const ids = identifiersFromHelmRelease(makeHelmRelease({ chartVersion: '4.5.0' }));
    expect(ids).toContain('4.5.0');
  });

  it('returns status', () => {
    const ids = identifiersFromHelmRelease(makeHelmRelease({ status: 'failed' }));
    expect(ids).toContain('failed');
  });

  it('returns appVersion when set', () => {
    const ids = identifiersFromHelmRelease(makeHelmRelease({ appVersion: '3.0.0' }));
    expect(ids).toContain('3.0.0');
  });

  it('does not include empty strings', () => {
    const ids = identifiersFromHelmRelease(makeHelmRelease({ appVersion: '', chartVersion: '' }));
    expect(ids).not.toContain('');
  });
});
