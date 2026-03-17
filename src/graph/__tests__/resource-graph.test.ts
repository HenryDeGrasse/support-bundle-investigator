import { describe, it, expect } from 'vitest';
import {
  buildResourceGraph,
  getNeighborhood,
  getRelatedChunks,
  parseSeedSource,
} from '../resource-graph.js';
import type { K8sResource, K8sEvent } from '../../types/index.js';
import type { IndexedChunk } from '../../ai/chunk-indexer.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makePod(
  name: string,
  namespace = 'default',
  opts: {
    secretNames?: string[];
    configMapNames?: string[];
    pvcNames?: string[];
    ownerKind?: string;
    ownerName?: string;
    envSecrets?: string[];
    envConfigMaps?: string[];
  } = {},
): K8sResource {
  const {
    secretNames = [],
    configMapNames = [],
    pvcNames = [],
    ownerKind,
    ownerName,
    envSecrets = [],
    envConfigMaps = [],
  } = opts;

  const volumes = [
    ...secretNames.map((s) => ({ name: `${s}-vol`, secret: { secretName: s } })),
    ...configMapNames.map((c) => ({ name: `${c}-vol`, configMap: { name: c } })),
    ...pvcNames.map((p) => ({ name: `${p}-vol`, persistentVolumeClaim: { claimName: p } })),
  ];

  const env = [
    ...envSecrets.map((s) => ({
      name: `SECRET_${s.toUpperCase()}`,
      valueFrom: { secretKeyRef: { name: s, key: 'value' } },
    })),
    ...envConfigMaps.map((c) => ({
      name: `CM_${c.toUpperCase()}`,
      valueFrom: { configMapKeyRef: { name: c, key: 'value' } },
    })),
  ];

  const metadata = { name, namespace } as unknown as K8sResource['metadata'];
  if (ownerKind && ownerName) {
    (metadata as unknown as Record<string, unknown>)['ownerReferences'] = [
      { kind: ownerKind, name: ownerName, apiVersion: 'apps/v1' },
    ];
  }

  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata,
    spec: {
      volumes,
      containers: [
        {
          name: 'app',
          image: 'my-app:latest',
          env,
        },
      ],
    },
    status: { phase: 'Running', containerStatuses: [], conditions: [] },
  };
}

function makeDeployment(name: string, namespace = 'default'): K8sResource {
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name, namespace },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: name } },
      template: {
        metadata: { labels: { app: name } },
        spec: {
          containers: [{ name: 'app', image: 'my-app:latest' }],
        },
      },
    },
    status: { readyReplicas: 1 },
  };
}

function makeSecret(name: string, namespace = 'default'): K8sResource {
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name, namespace },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: { key: 'dmFsdWU=' } as any,
    type: 'Opaque',
  } as unknown as K8sResource;
}

function makeEvent(
  reason: string,
  objKind: string,
  objName: string,
  namespace = 'default',
  eventType = 'Warning',
): K8sEvent {
  return {
    type: eventType,
    reason,
    message: `${reason} on ${objKind}/${objName}`,
    involvedObject: { kind: objKind, name: objName, namespace },
    firstTimestamp: '2024-01-01T00:00:00Z',
    lastTimestamp: '2024-01-01T00:01:00Z',
    count: 3,
  };
}

// ---------------------------------------------------------------------------
// buildResourceGraph
// ---------------------------------------------------------------------------

describe('buildResourceGraph', () => {
  it('adds all resources as nodes', () => {
    const resources = [
      makePod('my-pod'),
      makeDeployment('my-deploy'),
      makeSecret('my-secret'),
    ];
    const graph = buildResourceGraph(resources, []);
    expect(graph.nodes.size).toBe(3);
    expect(graph.nodes.has('Pod:default/my-pod')).toBe(true);
    expect(graph.nodes.has('Deployment:default/my-deploy')).toBe(true);
    expect(graph.nodes.has('Secret:default/my-secret')).toBe(true);
  });

  it('creates edges for volume-mounted secrets', () => {
    const pod = makePod('app-pod', 'default', { secretNames: ['app-secret'] });
    const graph = buildResourceGraph([pod], []);

    const secretEdge = graph.edges.find(
      (e) => e.targetKind === 'Secret' && e.targetName === 'app-secret',
    );
    expect(secretEdge).toBeDefined();
    expect(secretEdge?.sourceKind).toBe('Pod');
    expect(secretEdge?.sourceName).toBe('app-pod');
    expect(secretEdge?.relationshipType).toBe('references-secret');
  });

  it('creates edges for volume-mounted configmaps', () => {
    const pod = makePod('app-pod', 'default', { configMapNames: ['app-config'] });
    const graph = buildResourceGraph([pod], []);

    const cmEdge = graph.edges.find(
      (e) => e.targetKind === 'ConfigMap' && e.targetName === 'app-config',
    );
    expect(cmEdge).toBeDefined();
    expect(cmEdge?.relationshipType).toBe('references-configmap');
  });

  it('creates edges for PVC volume references', () => {
    const pod = makePod('app-pod', 'default', { pvcNames: ['data-pvc'] });
    const graph = buildResourceGraph([pod], []);

    const pvcEdge = graph.edges.find(
      (e) => e.targetKind === 'PersistentVolumeClaim' && e.targetName === 'data-pvc',
    );
    expect(pvcEdge).toBeDefined();
    expect(pvcEdge?.relationshipType).toBe('references-pvc');
  });

  it('creates edges for env.valueFrom.secretKeyRef', () => {
    const pod = makePod('app-pod', 'default', { envSecrets: ['db-secret'] });
    const graph = buildResourceGraph([pod], []);

    const edges = graph.edges.filter(
      (e) => e.targetKind === 'Secret' && e.targetName === 'db-secret',
    );
    expect(edges.length).toBeGreaterThanOrEqual(1);
    expect(edges[0]?.relationshipType).toBe('references-secret');
  });

  it('creates edges for env.valueFrom.configMapKeyRef', () => {
    const pod = makePod('app-pod', 'default', { envConfigMaps: ['db-config'] });
    const graph = buildResourceGraph([pod], []);

    const edges = graph.edges.filter(
      (e) => e.targetKind === 'ConfigMap' && e.targetName === 'db-config',
    );
    expect(edges.length).toBeGreaterThanOrEqual(1);
    expect(edges[0]?.relationshipType).toBe('references-configmap');
  });

  it('creates owner-reference edges from pod to workload', () => {
    const pod = makePod('app-pod-abc', 'default', {
      ownerKind: 'ReplicaSet',
      ownerName: 'app-rs-xyz',
    });
    const graph = buildResourceGraph([pod], []);

    const ownerEdge = graph.edges.find(
      (e) => e.targetKind === 'ReplicaSet' && e.targetName === 'app-rs-xyz',
    );
    expect(ownerEdge).toBeDefined();
    expect(ownerEdge?.relationshipType).toBe('owner-reference');
  });

  it('creates event-target edges from events to involved objects', () => {
    const event = makeEvent('BackOff', 'Pod', 'app-pod');
    const graph = buildResourceGraph([], [event]);

    const eventEdge = graph.edges.find(
      (e) => e.relationshipType === 'event-target' && e.targetName === 'app-pod',
    );
    expect(eventEdge).toBeDefined();
    expect(eventEdge?.targetKind).toBe('Pod');
  });

  it('handles empty inputs without error', () => {
    const graph = buildResourceGraph([], []);
    expect(graph.nodes.size).toBe(0);
    expect(graph.edges).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getNeighborhood
// ---------------------------------------------------------------------------

describe('getNeighborhood', () => {
  it('returns just the source node at depth 0', () => {
    const pod = makePod('my-pod', 'default', { secretNames: ['my-secret'] });
    const graph = buildResourceGraph([pod], []);

    const neighbors = getNeighborhood(graph, 'Pod', 'my-pod', 'default', 0);
    expect(neighbors).toHaveLength(1);
    expect(neighbors[0]?.name).toBe('my-pod');
  });

  it('returns direct neighbors at depth 1', () => {
    const pod = makePod('my-pod', 'default', { secretNames: ['my-secret'] });
    const graph = buildResourceGraph([pod], []);

    const neighbors = getNeighborhood(graph, 'Pod', 'my-pod', 'default', 1);
    const names = neighbors.map((n) => n.name);
    expect(names).toContain('my-pod');
    expect(names).toContain('my-secret');
  });

  it('traverses two hops for owner → pod → secret', () => {
    const pod = makePod('app-pod', 'default', {
      secretNames: ['app-secret'],
      ownerKind: 'ReplicaSet',
      ownerName: 'app-rs',
    });
    const rs = makeDeployment('app-rs'); // use Deployment as stand-in for RS
    rs.kind = 'ReplicaSet';
    const graph = buildResourceGraph([pod, rs], []);

    // From ReplicaSet, depth=2 should reach the Secret via Pod
    const neighbors = getNeighborhood(graph, 'ReplicaSet', 'app-rs', 'default', 2);
    const names = neighbors.map((n) => n.name);
    expect(names).toContain('app-rs');
    expect(names).toContain('app-pod');
    expect(names).toContain('app-secret');
  });

  it('returns empty array for an unknown node', () => {
    const graph = buildResourceGraph([], []);
    const neighbors = getNeighborhood(graph, 'Pod', 'nonexistent', 'default', 2);
    expect(neighbors).toHaveLength(0);
  });

  it('does not revisit nodes (no infinite loops in cycles)', () => {
    // Artificially create a cycle via two separate edges
    const graph = buildResourceGraph([], []);
    graph.nodes.set('Pod:default/pod-a', { kind: 'Pod', name: 'pod-a', namespace: 'default' });
    graph.nodes.set('ConfigMap:default/cm-a', { kind: 'ConfigMap', name: 'cm-a', namespace: 'default' });
    graph.edges.push({
      sourceKind: 'Pod', sourceName: 'pod-a', sourceNamespace: 'default',
      targetKind: 'ConfigMap', targetName: 'cm-a', targetNamespace: 'default',
      relationshipType: 'references-configmap',
    });
    graph.edges.push({
      sourceKind: 'ConfigMap', sourceName: 'cm-a', sourceNamespace: 'default',
      targetKind: 'Pod', targetName: 'pod-a', targetNamespace: 'default',
      relationshipType: 'references-configmap',
    });

    const neighbors = getNeighborhood(graph, 'Pod', 'pod-a', 'default', 10);
    // Should not hang, and should return both nodes exactly once
    const names = neighbors.map((n) => n.name);
    expect(names.filter((n) => n === 'pod-a')).toHaveLength(1);
    expect(names.filter((n) => n === 'cm-a')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// parseSeedSource
// ---------------------------------------------------------------------------

describe('parseSeedSource', () => {
  it('parses pod seed source', () => {
    const result = parseSeedSource('pod:default/app-pod');
    expect(result).toEqual({ kind: 'Pod', namespace: 'default', name: 'app-pod' });
  });

  it('parses pod source without namespace (defaults to default)', () => {
    const result = parseSeedSource('pod:my-pod');
    expect(result).toEqual({ kind: 'Pod', namespace: 'default', name: 'my-pod' });
  });

  it('parses analyzer seed source', () => {
    const result = parseSeedSource('analyzer:check-memory');
    expect(result).toEqual({ kind: 'Analyzer', namespace: '', name: 'check-memory' });
  });

  it('parses log seed source', () => {
    const result = parseSeedSource('log:/var/log/app/app.log');
    expect(result).toEqual({ kind: 'Log', namespace: '', name: '/var/log/app/app.log' });
  });

  it('parses event seed source', () => {
    const result = parseSeedSource('event:BackOff:app-pod');
    expect(result).toEqual({ kind: 'Event', namespace: '', name: 'BackOff:app-pod' });
  });

  it('returns null for empty string', () => {
    expect(parseSeedSource('')).toBeNull();
  });

  it('returns null for unknown prefix', () => {
    expect(parseSeedSource('unknown:something')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getRelatedChunks
// ---------------------------------------------------------------------------

describe('getRelatedChunks', () => {
  function makeIndexedChunk(
    id: string,
    identifiers: string[],
    namespace?: string,
  ): IndexedChunk {
    return {
      id,
      artifactId: `path/to/${id}`,
      content: `content for ${id}`,
      startLine: 1,
      endLine: 5,
      summary: `Summary of ${id}`,
      identifiers,
      namespace,
      artifactCategory: 'kubernetes-resource',
    };
  }

  it('returns chunks matching pod name identifiers', () => {
    const pod = makePod('app-pod', 'default', { secretNames: ['db-secret'] });
    const graph = buildResourceGraph([pod], []);

    const chunkIndex: IndexedChunk[] = [
      makeIndexedChunk('chunk-pod', ['app-pod', 'default']),
      makeIndexedChunk('chunk-secret', ['db-secret', 'default']),
      makeIndexedChunk('chunk-unrelated', ['other-pod', 'kube-system']),
    ];

    const seed = {
      id: 'seed:pod:0',
      hypothesis: 'Pod app-pod is crashing',
      source: 'pod:default/app-pod',
      category: 'kubernetes' as const,
      priority: 90,
    };

    const result = getRelatedChunks(graph, seed, chunkIndex);
    const ids = result.map((c) => c.id);
    expect(ids).toContain('chunk-pod');
    expect(ids).toContain('chunk-secret'); // neighbor via graph edge
    expect(ids).not.toContain('chunk-unrelated');
  });

  it('does not pull in unrelated chunks solely because they share a namespace', () => {
    const pod = makePod('app-pod', 'default', { secretNames: ['db-secret'] });
    const graph = buildResourceGraph([pod], []);

    const chunkIndex: IndexedChunk[] = [
      makeIndexedChunk('chunk-pod', ['app-pod', 'default']),
      makeIndexedChunk('chunk-secret', ['db-secret', 'default']),
      makeIndexedChunk('chunk-same-namespace-noise', ['totally-other-service', 'default']),
    ];

    const seed = {
      id: 'seed:pod:0',
      hypothesis: 'Pod app-pod is crashing',
      source: 'pod:default/app-pod',
      category: 'kubernetes' as const,
      priority: 90,
    };

    const result = getRelatedChunks(graph, seed, chunkIndex);
    const ids = result.map((c) => c.id);
    expect(ids).toContain('chunk-pod');
    expect(ids).toContain('chunk-secret');
    expect(ids).not.toContain('chunk-same-namespace-noise');
  });

  it('returns log chunks by direct path match', () => {
    const graph = buildResourceGraph([], []);
    const logPath = '/var/log/app/app.log';

    const chunkIndex: IndexedChunk[] = [
      {
        id: `${logPath}:1-50`,
        artifactId: logPath,
        content: 'some log content',
        startLine: 1,
        endLine: 50,
        summary: 'Log chunk',
        identifiers: [],
        artifactCategory: 'log',
      },
      makeIndexedChunk('other-chunk', ['other']),
    ];

    const seed = {
      id: 'seed:log:0',
      hypothesis: 'Log file has errors',
      source: `log:${logPath}`,
      category: 'log' as const,
      priority: 45,
    };

    const result = getRelatedChunks(graph, seed, chunkIndex);
    expect(result).toHaveLength(1);
    expect(result[0]?.artifactId).toBe(logPath);
  });

  it('returns empty array for unrecognised seed source', () => {
    const graph = buildResourceGraph([], []);
    const seed = {
      id: 'seed:0',
      hypothesis: 'something',
      source: '',
      category: 'kubernetes' as const,
      priority: 50,
    };
    const result = getRelatedChunks(graph, seed, []);
    expect(result).toHaveLength(0);
  });

  it('deduplicates chunks that match via multiple identifiers', () => {
    const pod = makePod('app-pod', 'default');
    const graph = buildResourceGraph([pod], []);

    const chunkIndex: IndexedChunk[] = [
      makeIndexedChunk('chunk-1', ['app-pod', 'default', 'app-pod']), // duplicate identifier
    ];

    const seed = {
      id: 'seed:pod:0',
      hypothesis: 'Pod app-pod is crashing',
      source: 'pod:default/app-pod',
      category: 'kubernetes' as const,
      priority: 90,
    };

    const result = getRelatedChunks(graph, seed, chunkIndex);
    expect(result).toHaveLength(1);
  });
});
