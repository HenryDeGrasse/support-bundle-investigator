import { describe, it, expect } from 'vitest';
import {
  DiagnosticGraph,
  buildDiagnosticGraph,
  asResourceRelationshipGraph,
  addTemporalCorrelationEdges,
  addTemporalSequenceEdges,
  buildWorkloadGroups,
} from '../diagnostic-graph.js';
import { buildResourceGraph, getRelatedChunks } from '../resource-graph.js';
import { traverse } from '../traversal.js';
import type { K8sResource, K8sEvent } from '../../types/index.js';
import type {
  DiagnosticNodeType,
  DiagnosticEdgeType,
  DiagnosticGraphNode,
} from '../diagnostic-graph.js';
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
    labels?: Record<string, string>;
  } = {},
): K8sResource {
  const { secretNames = [], configMapNames = [], pvcNames = [], ownerKind, ownerName, labels } = opts;

  const volumes = [
    ...secretNames.map((s) => ({ name: `${s}-vol`, secret: { secretName: s } })),
    ...configMapNames.map((c) => ({ name: `${c}-vol`, configMap: { name: c } })),
    ...pvcNames.map((p) => ({ name: `${p}-vol`, persistentVolumeClaim: { claimName: p } })),
  ];

  const metadata = { name, namespace, labels } as unknown as K8sResource['metadata'];
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
      containers: [{ name: 'app', image: 'my-app:latest' }],
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
        spec: { containers: [{ name: 'app', image: 'my-app:latest' }] },
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
    data: {},
    type: 'Opaque',
  } as unknown as K8sResource;
}

function makeEvent(
  reason: string,
  objKind: string,
  objName: string,
  namespace = 'default',
): K8sEvent {
  return {
    type: 'Warning',
    reason,
    message: `${reason} on ${objKind}/${objName}`,
    involvedObject: { kind: objKind, name: objName, namespace },
    firstTimestamp: '2024-01-01T00:00:00Z',
    lastTimestamp: '2024-01-01T00:01:00Z',
    count: 3,
  };
}

function makeDeploymentWithSelector(
  name: string,
  selectorLabels: Record<string, string>,
  namespace = 'default',
): K8sResource {
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name, namespace },
    spec: {
      replicas: 1,
      selector: { matchLabels: selectorLabels },
      template: {
        metadata: { labels: selectorLabels },
        spec: { containers: [{ name: 'app', image: 'my-app:latest' }] },
      },
    },
    status: { readyReplicas: 1 },
  };
}

function makeStatefulSetWithSelector(
  name: string,
  selectorLabels: Record<string, string>,
  namespace = 'default',
): K8sResource {
  return {
    apiVersion: 'apps/v1',
    kind: 'StatefulSet',
    metadata: { name, namespace },
    spec: {
      replicas: 1,
      selector: { matchLabels: selectorLabels },
      template: {
        metadata: { labels: selectorLabels },
        spec: { containers: [{ name: 'app', image: 'my-app:latest' }] },
      },
    },
    status: { readyReplicas: 1 },
  };
}

function makeDaemonSetWithSelector(
  name: string,
  selectorLabels: Record<string, string>,
  namespace = 'default',
): K8sResource {
  return {
    apiVersion: 'apps/v1',
    kind: 'DaemonSet',
    metadata: { name, namespace },
    spec: {
      selector: { matchLabels: selectorLabels },
      template: {
        metadata: { labels: selectorLabels },
        spec: { containers: [{ name: 'app', image: 'my-app:latest' }] },
      },
    },
    status: {},
  };
}

function makeServiceWithSelector(
  name: string,
  selectorLabels: Record<string, string> | null,
  namespace = 'default',
): K8sResource {
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name, namespace },
    spec: {
      ...(selectorLabels !== null ? { selector: selectorLabels } : {}),
      ports: [{ port: 80, targetPort: 8080 }],
    },
    status: {},
  };
}

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

// ---------------------------------------------------------------------------
// DiagnosticGraph — node types
// ---------------------------------------------------------------------------

describe('DiagnosticGraph — node types', () => {
  it('supports all six node types', () => {
    const graph = new DiagnosticGraph();
    const nodeTypes: DiagnosticNodeType[] = [
      'resource',
      'event',
      'log-chunk',
      'analyzer',
      'finding',
      'workload-group',
    ];

    for (const nodeType of nodeTypes) {
      graph.addNode({ id: `${nodeType}-node`, nodeType, data: {}, metadata: {} });
    }

    for (const nodeType of nodeTypes) {
      const node = graph.getNode(`${nodeType}-node`);
      expect(node, `expected node of type ${nodeType} to be found`).toBeDefined();
      expect(node?.nodeType).toBe(nodeType);
    }
  });

  it('addNode() overwrites an existing node with the same id', () => {
    const graph = new DiagnosticGraph();
    graph.addNode({ id: 'n1', nodeType: 'resource', data: { v: 1 } });
    graph.addNode({ id: 'n1', nodeType: 'finding', data: { v: 2 } });

    const node = graph.getNode('n1');
    expect(node?.nodeType).toBe('finding');
    expect((node?.data as { v: number }).v).toBe(2);
  });

  it('getNode() returns undefined for a missing id', () => {
    const graph = new DiagnosticGraph();
    expect(graph.getNode('does-not-exist')).toBeUndefined();
  });

  it('preserves node metadata', () => {
    const graph = new DiagnosticGraph();
    const metadata = { kind: 'Pod', name: 'app-pod', namespace: 'default', labels: { app: 'frontend' } };
    graph.addNode({ id: 'pod-1', nodeType: 'resource', data: {}, metadata });
    expect(graph.getNode('pod-1')?.metadata).toEqual(metadata);
  });

  it('nodes map exposes all added nodes', () => {
    const graph = new DiagnosticGraph();
    graph.addNode({ id: 'a', nodeType: 'finding', data: {} });
    graph.addNode({ id: 'b', nodeType: 'finding', data: {} });
    expect(graph.nodes.size).toBe(2);
    expect(graph.nodes.has('a')).toBe(true);
    expect(graph.nodes.has('b')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DiagnosticGraph — edge types, weight, direction
// ---------------------------------------------------------------------------

describe('DiagnosticGraph — edge types, weight, direction', () => {
  it('supports all fourteen edge types', () => {
    const graph = new DiagnosticGraph();
    graph.addNode({ id: 'a', nodeType: 'resource', data: {} });
    graph.addNode({ id: 'b', nodeType: 'resource', data: {} });

    const edgeTypes: DiagnosticEdgeType[] = [
      // structural K8s edges
      'owner-reference',
      'references-secret',
      'references-configmap',
      'references-pvc',
      'event-target',
      'label-selector',
      'service-selector',
      // causal / semantic edges
      'causes',
      'supports',
      'contradicts',
      'correlates',
      'derived-from',
      // temporal edges
      'temporal-correlation',
      'temporal-sequence',
    ];

    for (const [i, type] of edgeTypes.entries()) {
      graph.addEdge({ id: `edge-${i}`, source: 'a', target: 'b', type });
    }

    expect(graph.edges).toHaveLength(edgeTypes.length);
    for (const type of edgeTypes) {
      expect(graph.edges.some((e) => e.type === type)).toBe(true);
    }
  });

  it('edges carry optional weight and direction', () => {
    const graph = new DiagnosticGraph();
    graph.addNode({ id: 'a', nodeType: 'finding', data: {} });
    graph.addNode({ id: 'b', nodeType: 'finding', data: {} });

    graph.addEdge({
      id: 'edge-1',
      source: 'a',
      target: 'b',
      type: 'causes',
      weight: 0.9,
      direction: 'forward',
    });

    const edge = graph.getEdgesFrom('a')[0];
    expect(edge).toBeDefined();
    expect(edge?.type).toBe('causes');
    expect(edge?.weight).toBe(0.9);
    expect(edge?.direction).toBe('forward');
  });

  it('edges work without optional weight and direction', () => {
    const graph = new DiagnosticGraph();
    graph.addNode({ id: 'x', nodeType: 'resource', data: {} });
    graph.addNode({ id: 'y', nodeType: 'resource', data: {} });
    graph.addEdge({ id: 'e1', source: 'x', target: 'y', type: 'references-secret' });

    const edge = graph.getEdgesFrom('x')[0];
    expect(edge?.weight).toBeUndefined();
    expect(edge?.direction).toBeUndefined();
  });

  it('getEdgesFrom() returns only outgoing edges from a node', () => {
    const graph = new DiagnosticGraph();
    graph.addNode({ id: 'src', nodeType: 'resource', data: {} });
    graph.addNode({ id: 'tgt1', nodeType: 'resource', data: {} });
    graph.addNode({ id: 'tgt2', nodeType: 'resource', data: {} });
    graph.addNode({ id: 'other', nodeType: 'resource', data: {} });

    graph.addEdge({ id: 'e1', source: 'src', target: 'tgt1', type: 'references-secret' });
    graph.addEdge({ id: 'e2', source: 'src', target: 'tgt2', type: 'references-configmap' });
    graph.addEdge({ id: 'e3', source: 'other', target: 'src', type: 'owner-reference' });

    const out = graph.getEdgesFrom('src');
    expect(out).toHaveLength(2);
    expect(out.map((e) => e.target)).toEqual(expect.arrayContaining(['tgt1', 'tgt2']));
  });

  it('getEdgesTo() returns only incoming edges to a node', () => {
    const graph = new DiagnosticGraph();
    graph.addNode({ id: 'parent', nodeType: 'resource', data: {} });
    graph.addNode({ id: 'child', nodeType: 'resource', data: {} });
    graph.addNode({ id: 'unrelated', nodeType: 'resource', data: {} });

    graph.addEdge({ id: 'e1', source: 'parent', target: 'child', type: 'causes' });
    graph.addEdge({ id: 'e2', source: 'unrelated', target: 'parent', type: 'supports' });

    const incoming = graph.getEdgesTo('child');
    expect(incoming).toHaveLength(1);
    expect(incoming[0]?.source).toBe('parent');
  });

  it('getNeighbors() returns nodes reachable via outgoing edges', () => {
    const graph = new DiagnosticGraph();
    graph.addNode({ id: 'a', nodeType: 'finding', data: {} });
    graph.addNode({ id: 'b', nodeType: 'evidence', data: {} } as unknown as DiagnosticGraphNode);
    graph.addNode({ id: 'c', nodeType: 'resource', data: {} });

    graph.addEdge({ id: 'e1', source: 'a', target: 'b', type: 'supports' });
    graph.addEdge({ id: 'e2', source: 'a', target: 'c', type: 'correlates' });

    const neighbors = graph.getNeighbors('a');
    expect(neighbors).toHaveLength(2);
    expect(neighbors.map((n) => n.id)).toEqual(expect.arrayContaining(['b', 'c']));
  });

  it('edges readonly — can inspect but not mutate via property', () => {
    const graph = new DiagnosticGraph();
    graph.addNode({ id: 'a', nodeType: 'resource', data: {} });
    graph.addNode({ id: 'b', nodeType: 'resource', data: {} });
    graph.addEdge({ id: 'e1', source: 'a', target: 'b', type: 'owner-reference' });

    // edges property returns readonly array
    const { edges } = graph;
    expect(edges).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// buildDiagnosticGraph
// ---------------------------------------------------------------------------

describe('buildDiagnosticGraph', () => {
  it('adds all resources as nodes with nodeType resource', () => {
    const resources = [makePod('my-pod'), makeDeployment('my-deploy'), makeSecret('my-secret')];
    const dg = buildDiagnosticGraph(resources, []);

    expect(dg.nodes.size).toBe(3);

    for (const [, node] of dg.nodes) {
      expect(node.nodeType).toBe('resource');
    }

    expect(dg.getNode('Pod:default/my-pod')).toBeDefined();
    expect(dg.getNode('Deployment:default/my-deploy')).toBeDefined();
    expect(dg.getNode('Secret:default/my-secret')).toBeDefined();
  });

  it('adds event nodes with nodeType event', () => {
    const event = makeEvent('BackOff', 'Pod', 'my-pod');
    const dg = buildDiagnosticGraph([], [event]);

    // The event itself plus the involved Pod node
    const eventNodes = [...dg.nodes.values()].filter((n) => n.nodeType === 'event');
    expect(eventNodes.length).toBeGreaterThanOrEqual(1);
  });

  it('produces owner-reference edges matching buildResourceGraph', () => {
    const pod = makePod('app-pod', 'default', { ownerKind: 'ReplicaSet', ownerName: 'app-rs' });
    const resources = [pod, makeDeployment('app-rs')];
    resources[1]!.kind = 'ReplicaSet';

    const dg = buildDiagnosticGraph(resources, []);
    const rrg = buildResourceGraph(resources, []);

    // Structural edges should be equivalent
    const adapter = asResourceRelationshipGraph(dg);

    const ownerEdgesDG = adapter.edges.filter((e) => e.relationshipType === 'owner-reference');
    const ownerEdgesRRG = rrg.edges.filter((e) => e.relationshipType === 'owner-reference');

    expect(ownerEdgesDG.length).toBe(ownerEdgesRRG.length);
    for (const rrgEdge of ownerEdgesRRG) {
      const match = ownerEdgesDG.find(
        (e) =>
          e.sourceKind === rrgEdge.sourceKind &&
          e.sourceName === rrgEdge.sourceName &&
          e.targetKind === rrgEdge.targetKind &&
          e.targetName === rrgEdge.targetName,
      );
      expect(match, `expected owner-reference edge ${rrgEdge.sourceName}→${rrgEdge.targetName}`).toBeDefined();
    }
  });

  it('produces references-secret edges matching buildResourceGraph', () => {
    const pod = makePod('app-pod', 'default', { secretNames: ['db-secret'] });
    const dg = buildDiagnosticGraph([pod], []);
    const rrg = buildResourceGraph([pod], []);

    const adapter = asResourceRelationshipGraph(dg);

    const dgEdges = adapter.edges.filter((e) => e.relationshipType === 'references-secret');
    const rrgEdges = rrg.edges.filter((e) => e.relationshipType === 'references-secret');

    expect(dgEdges.length).toBe(rrgEdges.length);
    expect(dgEdges[0]?.targetName).toBe('db-secret');
  });

  it('produces references-configmap edges matching buildResourceGraph', () => {
    const pod = makePod('app-pod', 'default', { configMapNames: ['app-config'] });
    const dg = buildDiagnosticGraph([pod], []);
    const rrg = buildResourceGraph([pod], []);

    const adapter = asResourceRelationshipGraph(dg);
    const dgEdges = adapter.edges.filter((e) => e.relationshipType === 'references-configmap');
    const rrgEdges = rrg.edges.filter((e) => e.relationshipType === 'references-configmap');

    expect(dgEdges.length).toBe(rrgEdges.length);
  });

  it('produces references-pvc edges matching buildResourceGraph', () => {
    const pod = makePod('app-pod', 'default', { pvcNames: ['data-pvc'] });
    const dg = buildDiagnosticGraph([pod], []);
    const rrg = buildResourceGraph([pod], []);

    const adapter = asResourceRelationshipGraph(dg);
    const dgEdges = adapter.edges.filter((e) => e.relationshipType === 'references-pvc');
    const rrgEdges = rrg.edges.filter((e) => e.relationshipType === 'references-pvc');

    expect(dgEdges.length).toBe(rrgEdges.length);
  });

  it('produces event-target edges matching buildResourceGraph', () => {
    const event = makeEvent('BackOff', 'Pod', 'app-pod');
    const dg = buildDiagnosticGraph([], [event]);
    const rrg = buildResourceGraph([], [event]);

    const adapter = asResourceRelationshipGraph(dg);
    const dgEdges = adapter.edges.filter((e) => e.relationshipType === 'event-target');
    const rrgEdges = rrg.edges.filter((e) => e.relationshipType === 'event-target');

    expect(dgEdges.length).toBe(rrgEdges.length);
    expect(dgEdges[0]?.targetKind).toBe('Pod');
    expect(dgEdges[0]?.targetName).toBe('app-pod');
  });

  it('nodes map matches buildResourceGraph for a complex scenario', () => {
    const pod = makePod('app-pod', 'default', {
      secretNames: ['db-secret'],
      configMapNames: ['app-config'],
      ownerKind: 'ReplicaSet',
      ownerName: 'app-rs',
    });
    const deploy = makeDeployment('app-rs');
    deploy.kind = 'ReplicaSet';
    const event = makeEvent('BackOff', 'Pod', 'app-pod');

    const resources = [pod, deploy];
    const events = [event];

    const rrg = buildResourceGraph(resources, events);
    const dg = buildDiagnosticGraph(resources, events);
    const adapter = asResourceRelationshipGraph(dg);

    // Same node IDs in both graphs (resources + event-related nodes)
    for (const [id] of rrg.nodes) {
      expect(adapter.nodes.has(id), `expected node ${id} in adapter`).toBe(true);
    }

    // Same total edge count
    expect(adapter.edges.length).toBe(rrg.edges.length);
  });

  it('handles empty inputs without error', () => {
    const dg = buildDiagnosticGraph([], []);
    expect(dg.nodes.size).toBe(0);
    expect(dg.edges).toHaveLength(0);
  });

  it('resource nodes store kind, name, namespace in data', () => {
    const pod = makePod('my-pod', 'staging');
    const dg = buildDiagnosticGraph([pod], []);

    const node = dg.getNode('Pod:staging/my-pod');
    expect(node).toBeDefined();
    expect(node?.nodeType).toBe('resource');
    const data = node?.data as { kind: string; name: string; namespace: string };
    expect(data.kind).toBe('Pod');
    expect(data.name).toBe('my-pod');
    expect(data.namespace).toBe('staging');
  });
});

// ---------------------------------------------------------------------------
// asResourceRelationshipGraph adapter
// ---------------------------------------------------------------------------

describe('asResourceRelationshipGraph', () => {
  it('converts DiagnosticGraph nodes to ResourceRelationshipGraph nodes', () => {
    const dg = new DiagnosticGraph();
    dg.addNode({
      id: 'Pod:default/app-pod',
      nodeType: 'resource',
      data: { kind: 'Pod', name: 'app-pod', namespace: 'default' },
    });
    dg.addNode({
      id: 'Secret:default/db-secret',
      nodeType: 'resource',
      data: { kind: 'Secret', name: 'db-secret', namespace: 'default' },
    });

    const rrg = asResourceRelationshipGraph(dg);

    expect(rrg.nodes.size).toBe(2);
    expect(rrg.nodes.get('Pod:default/app-pod')?.kind).toBe('Pod');
    expect(rrg.nodes.get('Secret:default/db-secret')?.name).toBe('db-secret');
  });

  it('converts structural edges to ResourceEdge format', () => {
    const dg = new DiagnosticGraph();
    dg.addNode({
      id: 'Pod:default/app-pod',
      nodeType: 'resource',
      data: { kind: 'Pod', name: 'app-pod', namespace: 'default' },
    });
    dg.addNode({
      id: 'Secret:default/db-secret',
      nodeType: 'resource',
      data: { kind: 'Secret', name: 'db-secret', namespace: 'default' },
    });
    dg.addEdge({
      id: 'e1',
      source: 'Pod:default/app-pod',
      target: 'Secret:default/db-secret',
      type: 'references-secret',
    });
    // Non-structural edge that should NOT appear in the adapter
    dg.addEdge({
      id: 'e2',
      source: 'Pod:default/app-pod',
      target: 'Secret:default/db-secret',
      type: 'causes',
    });

    const rrg = asResourceRelationshipGraph(dg);

    // Only structural edges are exported
    expect(rrg.edges).toHaveLength(1);
    expect(rrg.edges[0]?.relationshipType).toBe('references-secret');
    expect(rrg.edges[0]?.sourceKind).toBe('Pod');
    expect(rrg.edges[0]?.sourceName).toBe('app-pod');
    expect(rrg.edges[0]?.targetKind).toBe('Secret');
    expect(rrg.edges[0]?.targetName).toBe('db-secret');
  });

  it('excludes non-resource nodes (finding, log-chunk, analyzer, workload-group) from nodes map', () => {
    const dg = new DiagnosticGraph();
    dg.addNode({ id: 'Pod:default/p', nodeType: 'resource', data: { kind: 'Pod', name: 'p', namespace: 'default' } });
    dg.addNode({ id: 'finding:f1', nodeType: 'finding', data: { title: 'test' } });
    dg.addNode({ id: 'log:l1', nodeType: 'log-chunk', data: { artifactId: 'path/to/log' } });

    const rrg = asResourceRelationshipGraph(dg);

    expect(rrg.nodes.size).toBe(1);
    expect(rrg.nodes.has('Pod:default/p')).toBe(true);
    expect(rrg.nodes.has('finding:f1')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Backward-compatibility: getRelatedChunks works via adapter
// ---------------------------------------------------------------------------

describe('backward-compatibility: getRelatedChunks with DiagnosticGraph adapter', () => {
  it('getRelatedChunks returns chunks via adapter from buildDiagnosticGraph', () => {
    const pod = makePod('app-pod', 'default', { secretNames: ['db-secret'] });
    const dg = buildDiagnosticGraph([pod], []);
    const rrg = asResourceRelationshipGraph(dg);

    const chunkIndex: IndexedChunk[] = [
      makeIndexedChunk('chunk-pod', ['app-pod', 'default']),
      makeIndexedChunk('chunk-secret', ['db-secret', 'default']),
      makeIndexedChunk('chunk-unrelated', ['other-pod']),
    ];

    const seed = {
      id: 'seed:pod:0',
      hypothesis: 'Pod app-pod is crashing',
      source: 'pod:default/app-pod',
      category: 'kubernetes' as const,
      priority: 90,
    };

    const result = getRelatedChunks(rrg, seed, chunkIndex);
    const ids = result.map((c) => c.chunk.id);
    expect(ids).toContain('chunk-pod');
    expect(ids).toContain('chunk-secret'); // neighbor via graph edge
    expect(ids).not.toContain('chunk-unrelated');
  });

  it('getRelatedChunks from DiagnosticGraph adapter matches result from buildResourceGraph', () => {
    const pod = makePod('app-pod', 'default', { secretNames: ['db-secret'] });

    const dg = buildDiagnosticGraph([pod], []);
    const rrg = buildResourceGraph([pod], []);

    const chunkIndex: IndexedChunk[] = [
      makeIndexedChunk('chunk-pod', ['app-pod', 'default']),
      makeIndexedChunk('chunk-secret', ['db-secret', 'default']),
    ];

    const seed = {
      id: 'seed:pod:0',
      hypothesis: 'Pod app-pod is crashing',
      source: 'pod:default/app-pod',
      category: 'kubernetes' as const,
      priority: 90,
    };

    const resultFromAdapter = getRelatedChunks(asResourceRelationshipGraph(dg), seed, chunkIndex);
    const resultFromDirect = getRelatedChunks(rrg, seed, chunkIndex);

    // Same chunks, same scores
    const mapAdapter = new Map(resultFromAdapter.map((r) => [r.chunk.id, r.score]));
    const mapDirect = new Map(resultFromDirect.map((r) => [r.chunk.id, r.score]));

    expect(mapAdapter.size).toBe(mapDirect.size);
    for (const [id, score] of mapDirect) {
      expect(mapAdapter.get(id)).toBe(score);
    }
  });

  it('DiagnosticGraph.toResourceRelationshipGraph() method also works', () => {
    const pod = makePod('app-pod', 'default', { secretNames: ['db-secret'] });
    const dg = buildDiagnosticGraph([pod], []);

    // Method on instance
    const rrg = dg.toResourceRelationshipGraph();

    const chunkIndex: IndexedChunk[] = [
      makeIndexedChunk('chunk-pod', ['app-pod', 'default']),
      makeIndexedChunk('chunk-secret', ['db-secret', 'default']),
    ];

    const seed = {
      id: 'seed:pod:0',
      hypothesis: 'Pod app-pod crashing',
      source: 'pod:default/app-pod',
      category: 'kubernetes' as const,
      priority: 90,
    };

    const result = getRelatedChunks(rrg, seed, chunkIndex);
    expect(result.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// buildDiagnosticGraph — label-selector and service-selector edges (4.3)
// ---------------------------------------------------------------------------

describe('buildDiagnosticGraph — label-selector and service-selector edges (4.3)', () => {
  it('creates label-selector edges from Deployment to matching Pods', () => {
    const deploy = makeDeploymentWithSelector('myapp', { app: 'myapp' });
    const pod1 = makePod('myapp-pod-1', 'default', { labels: { app: 'myapp' } });
    // extra label on pod is fine — superset of selector still matches
    const pod2 = makePod('myapp-pod-2', 'default', { labels: { app: 'myapp', version: 'v2' } });
    // different app label — should NOT match
    const pod3 = makePod('other-pod', 'default', { labels: { app: 'other' } });

    const dg = buildDiagnosticGraph([deploy, pod1, pod2, pod3], []);

    const edges = dg.edges.filter((e) => e.type === 'label-selector');
    expect(edges).toHaveLength(2);

    const targets = edges.map((e) => e.target);
    expect(targets).toContain('Pod:default/myapp-pod-1');
    expect(targets).toContain('Pod:default/myapp-pod-2');
    expect(targets).not.toContain('Pod:default/other-pod');

    const sources = new Set(edges.map((e) => e.source));
    expect(sources.has('Deployment:default/myapp')).toBe(true);
  });

  it('creates label-selector edges even when intermediate ReplicaSet is missing', () => {
    const deploy = makeDeploymentWithSelector('myapp', { app: 'myapp' });
    // Pod has NO ownerReferences — simulates bundle where ReplicaSet is absent
    const pod = makePod('myapp-pod', 'default', { labels: { app: 'myapp' } });

    const dg = buildDiagnosticGraph([deploy, pod], []);

    const edges = dg.edges.filter((e) => e.type === 'label-selector');
    expect(edges).toHaveLength(1);
    expect(edges[0]?.source).toBe('Deployment:default/myapp');
    expect(edges[0]?.target).toBe('Pod:default/myapp-pod');
  });

  it('creates service-selector edges from Service to matching Pods', () => {
    const svc = makeServiceWithSelector('myapp-svc', { app: 'myapp' });
    const pod1 = makePod('myapp-pod-1', 'default', { labels: { app: 'myapp' } });
    const pod2 = makePod('other-pod', 'default', { labels: { app: 'other' } }); // no match

    const dg = buildDiagnosticGraph([svc, pod1, pod2], []);

    const edges = dg.edges.filter((e) => e.type === 'service-selector');
    expect(edges).toHaveLength(1);
    expect(edges[0]?.source).toBe('Service:default/myapp-svc');
    expect(edges[0]?.target).toBe('Pod:default/myapp-pod-1');
  });

  it('creates service-selector edges for multiple matching Pods', () => {
    const svc = makeServiceWithSelector('myapp-svc', { app: 'myapp' });
    const pod1 = makePod('myapp-pod-1', 'default', { labels: { app: 'myapp' } });
    const pod2 = makePod('myapp-pod-2', 'default', { labels: { app: 'myapp', tier: 'backend' } });

    const dg = buildDiagnosticGraph([svc, pod1, pod2], []);

    const edges = dg.edges.filter((e) => e.type === 'service-selector');
    expect(edges).toHaveLength(2);
    const targets = edges.map((e) => e.target);
    expect(targets).toContain('Pod:default/myapp-pod-1');
    expect(targets).toContain('Pod:default/myapp-pod-2');
  });

  it('selector matching uses AND semantics — all key-value pairs must match', () => {
    const deploy = makeDeploymentWithSelector('myapp', { app: 'myapp', tier: 'backend' });
    // Has both required labels
    const matchingPod = makePod('matching-pod', 'default', { labels: { app: 'myapp', tier: 'backend' } });
    // Missing 'tier' label — does NOT match
    const partialPod = makePod('partial-pod', 'default', { labels: { app: 'myapp' } });

    const dg = buildDiagnosticGraph([deploy, matchingPod, partialPod], []);

    const edges = dg.edges.filter((e) => e.type === 'label-selector');
    expect(edges).toHaveLength(1);
    expect(edges[0]?.target).toBe('Pod:default/matching-pod');
    expect(edges.map((e) => e.target)).not.toContain('Pod:default/partial-pod');
  });

  it('creates label-selector edges for StatefulSet', () => {
    const sts = makeStatefulSetWithSelector('mydb', { app: 'mydb' });
    const pod = makePod('mydb-0', 'default', { labels: { app: 'mydb' } });

    const dg = buildDiagnosticGraph([sts, pod], []);

    const edges = dg.edges.filter((e) => e.type === 'label-selector');
    expect(edges).toHaveLength(1);
    expect(edges[0]?.source).toBe('StatefulSet:default/mydb');
    expect(edges[0]?.target).toBe('Pod:default/mydb-0');
  });

  it('creates label-selector edges for DaemonSet', () => {
    const ds = makeDaemonSetWithSelector('node-agent', { app: 'node-agent' });
    const pod1 = makePod('node-agent-abc12', 'default', { labels: { app: 'node-agent' } });
    const pod2 = makePod('node-agent-xyz99', 'default', { labels: { app: 'node-agent' } });

    const dg = buildDiagnosticGraph([ds, pod1, pod2], []);

    const edges = dg.edges.filter((e) => e.type === 'label-selector');
    expect(edges).toHaveLength(2);
    const sources = new Set(edges.map((e) => e.source));
    expect(sources.has('DaemonSet:default/node-agent')).toBe(true);
  });

  it('does not create edges when Pod is in a different namespace', () => {
    const deploy = makeDeploymentWithSelector('myapp', { app: 'myapp' }, 'ns-a');
    const pod = makePod('myapp-pod', 'ns-b', { labels: { app: 'myapp' } }); // different namespace

    const dg = buildDiagnosticGraph([deploy, pod], []);

    const edges = dg.edges.filter((e) => e.type === 'label-selector');
    expect(edges).toHaveLength(0);
  });

  it('handles Service with no selector without error (headless / external services)', () => {
    const svc = makeServiceWithSelector('headless-svc', null); // no selector
    const pod = makePod('some-pod', 'default', { labels: { app: 'myapp' } });

    const dg = buildDiagnosticGraph([svc, pod], []);

    const edges = dg.edges.filter((e) => e.type === 'service-selector');
    expect(edges).toHaveLength(0);
  });

  it('handles Deployment with empty matchLabels without error — no edges created', () => {
    const deploy: K8sResource = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'myapp', namespace: 'default' },
      spec: { selector: { matchLabels: {} } },
      status: {},
    };
    const pod = makePod('myapp-pod', 'default', { labels: { app: 'myapp' } });

    expect(() => buildDiagnosticGraph([deploy, pod], [])).not.toThrow();

    const dg = buildDiagnosticGraph([deploy, pod], []);
    const edges = dg.edges.filter((e) => e.type === 'label-selector');
    // Empty matchLabels should not match any Pod (avoids noise)
    expect(edges).toHaveLength(0);
  });

  it('handles Pod with no labels without error — no edges created', () => {
    const deploy = makeDeploymentWithSelector('myapp', { app: 'myapp' });
    // Pod has no labels at all
    const pod = makePod('unlabeled-pod', 'default');

    expect(() => buildDiagnosticGraph([deploy, pod], [])).not.toThrow();

    const dg = buildDiagnosticGraph([deploy, pod], []);
    const edges = dg.edges.filter((e) => e.type === 'label-selector');
    expect(edges).toHaveLength(0);
  });

  it('handles multiple workloads and services with overlapping selectors', () => {
    const deployA = makeDeploymentWithSelector('frontend', { app: 'frontend' });
    const deployB = makeDeploymentWithSelector('backend', { app: 'backend' });
    const svcA = makeServiceWithSelector('frontend-svc', { app: 'frontend' });
    const svcB = makeServiceWithSelector('backend-svc', { app: 'backend' });
    const podA = makePod('frontend-pod', 'default', { labels: { app: 'frontend' } });
    const podB1 = makePod('backend-pod-1', 'default', { labels: { app: 'backend' } });
    const podB2 = makePod('backend-pod-2', 'default', { labels: { app: 'backend' } });

    const dg = buildDiagnosticGraph([deployA, deployB, svcA, svcB, podA, podB1, podB2], []);

    const labelEdges = dg.edges.filter((e) => e.type === 'label-selector');
    expect(labelEdges).toHaveLength(3); // deployA→podA, deployB→podB1, deployB→podB2

    const svcEdges = dg.edges.filter((e) => e.type === 'service-selector');
    expect(svcEdges).toHaveLength(3); // svcA→podA, svcB→podB1, svcB→podB2
  });
});

// ---------------------------------------------------------------------------
// Temporal edge fixtures
// ---------------------------------------------------------------------------

/**
 * Creates an IndexedChunk representing a log chunk with a timestamp and an
 * artifactId path that encodes the pod name in the real bundle path format:
 * `logs/{namespace}/{podName}/{container}.log`
 *
 * This format lets `addTemporalCorrelationEdges` extract the pod name via the
 * grandparent-directory regex, identical to `identifiersFromLogContent`.
 */
function makeLogChunk(
  id: string,
  podName: string,
  namespace: string,
  timestamp: string,
  content = 'ERROR: something failed',
): IndexedChunk {
  return {
    id,
    artifactId: `logs/${namespace}/${podName}/app.log`,
    content,
    startLine: 1,
    endLine: 10,
    summary: `Log chunk from ${podName}`,
    identifiers: [podName, namespace],
    namespace,
    artifactCategory: 'log',
    timestamp,
  };
}

/**
 * Creates a K8s event targeting a specific pod with explicit timestamps,
 * allowing precise control over temporal proximity in tests.
 */
function makeTimedPodEvent(
  reason: string,
  podName: string,
  namespace: string,
  timestamp: string,
): K8sEvent {
  return {
    type: 'Warning',
    reason,
    message: `${reason} on Pod/${podName}`,
    involvedObject: { kind: 'Pod', name: podName, namespace },
    firstTimestamp: timestamp,
    lastTimestamp: timestamp,
    count: 1,
  };
}

// ---------------------------------------------------------------------------
// addTemporalCorrelationEdges (4.6)
// ---------------------------------------------------------------------------

describe('addTemporalCorrelationEdges (4.6)', () => {
  it('creates a temporal-correlation edge when log chunk and event are for the same pod within 60s', () => {
    // Log chunk at 10:00:00, event at 10:00:30 → 30 seconds apart → within window
    const chunk = makeLogChunk(
      'chunk-1',
      'app-pod',
      'default',
      '2024-01-01T10:00:00Z',
    );
    const event = makeTimedPodEvent('FailedMount', 'app-pod', 'default', '2024-01-01T10:00:30Z');

    const graph = new DiagnosticGraph();
    addTemporalCorrelationEdges(graph, [chunk], [event]);

    const tcEdges = graph.edges.filter((e) => e.type === 'temporal-correlation');
    expect(tcEdges).toHaveLength(1);

    const edge = tcEdges[0]!;
    expect(edge.source).toBe('log-chunk:chunk-1');
    expect(edge.target).toBe('Event:default/FailedMount:app-pod');
  });

  it('adds a log-chunk node to the graph for each matched chunk', () => {
    const chunk = makeLogChunk('chunk-dns', 'app-pod', 'default', '2024-01-01T10:00:00Z');
    const event = makeTimedPodEvent('Unhealthy', 'app-pod', 'default', '2024-01-01T10:00:10Z');

    const graph = new DiagnosticGraph();
    addTemporalCorrelationEdges(graph, [chunk], [event]);

    const logNode = graph.getNode('log-chunk:chunk-dns');
    expect(logNode).toBeDefined();
    expect(logNode?.nodeType).toBe('log-chunk');
  });

  it('adds an event node to the graph when the event is not already present', () => {
    const chunk = makeLogChunk('chunk-1', 'app-pod', 'default', '2024-01-01T10:00:00Z');
    const event = makeTimedPodEvent('BackOff', 'app-pod', 'default', '2024-01-01T10:00:15Z');

    const graph = new DiagnosticGraph();
    addTemporalCorrelationEdges(graph, [chunk], [event]);

    const evNode = graph.getNode('Event:default/BackOff:app-pod');
    expect(evNode).toBeDefined();
    expect(evNode?.nodeType).toBe('event');
  });

  it('edge weight is higher when timestamps are closer (closer = stronger)', () => {
    // Two events: one 10s away, one 50s away — the closer one should have higher weight
    const chunk = makeLogChunk('chunk-1', 'app-pod', 'default', '2024-01-01T10:00:00Z');
    const closeEvent = makeTimedPodEvent('FailedMount', 'app-pod', 'default', '2024-01-01T10:00:10Z');  // 10s
    const farEvent = makeTimedPodEvent('BackOff', 'app-pod', 'default', '2024-01-01T10:00:50Z');         // 50s

    const graph = new DiagnosticGraph();
    addTemporalCorrelationEdges(graph, [chunk], [closeEvent, farEvent]);

    const tcEdges = graph.edges.filter((e) => e.type === 'temporal-correlation');
    expect(tcEdges).toHaveLength(2);

    const closeEdge = tcEdges.find((e) => e.target === 'Event:default/FailedMount:app-pod');
    const farEdge = tcEdges.find((e) => e.target === 'Event:default/BackOff:app-pod');

    expect(closeEdge).toBeDefined();
    expect(farEdge).toBeDefined();
    expect(closeEdge!.weight!).toBeGreaterThan(farEdge!.weight!);
  });

  it('weight is approximately 1.0 for events at exactly the same timestamp', () => {
    const ts = '2024-01-01T10:00:00Z';
    const chunk = makeLogChunk('chunk-1', 'app-pod', 'default', ts);
    const event = makeTimedPodEvent('FailedMount', 'app-pod', 'default', ts);

    const graph = new DiagnosticGraph();
    addTemporalCorrelationEdges(graph, [chunk], [event]);

    const edge = graph.edges.find((e) => e.type === 'temporal-correlation');
    expect(edge?.weight).toBeCloseTo(1.0, 5);
  });

  it('weight is 0 for events exactly 60 seconds apart', () => {
    const chunk = makeLogChunk('chunk-1', 'app-pod', 'default', '2024-01-01T10:00:00Z');
    // Exactly 60 seconds later = boundary → weight = 0
    const event = makeTimedPodEvent('Unhealthy', 'app-pod', 'default', '2024-01-01T10:01:00Z');

    const graph = new DiagnosticGraph();
    addTemporalCorrelationEdges(graph, [chunk], [event]);

    const edge = graph.edges.find((e) => e.type === 'temporal-correlation');
    expect(edge?.weight).toBeCloseTo(0, 5);
  });

  it('does NOT create edge when event is more than 60 seconds away from log chunk', () => {
    const chunk = makeLogChunk('chunk-1', 'app-pod', 'default', '2024-01-01T10:00:00Z');
    // 120 seconds later — outside the ±60 second window
    const event = makeTimedPodEvent('FailedMount', 'app-pod', 'default', '2024-01-01T10:02:00Z');

    const graph = new DiagnosticGraph();
    addTemporalCorrelationEdges(graph, [chunk], [event]);

    const tcEdges = graph.edges.filter((e) => e.type === 'temporal-correlation');
    expect(tcEdges).toHaveLength(0);
  });

  it('does NOT create edge when event targets a different pod than the log chunk', () => {
    const chunk = makeLogChunk('chunk-1', 'app-pod', 'default', '2024-01-01T10:00:00Z');
    // Event is for 'other-pod', not 'app-pod'
    const event = makeTimedPodEvent('FailedMount', 'other-pod', 'default', '2024-01-01T10:00:10Z');

    const graph = new DiagnosticGraph();
    addTemporalCorrelationEdges(graph, [chunk], [event]);

    const tcEdges = graph.edges.filter((e) => e.type === 'temporal-correlation');
    expect(tcEdges).toHaveLength(0);
  });

  it('does NOT correlate an event for the same pod name in another namespace', () => {
    const chunk = makeLogChunk(
      'chunk-team-a',
      'app-pod',
      'team-a',
      '2024-01-01T10:00:00Z',
    );
    const event = makeTimedPodEvent(
      'FailedMount',
      'app-pod',
      'team-b',
      '2024-01-01T10:00:10Z',
    );

    const graph = new DiagnosticGraph();
    addTemporalCorrelationEdges(graph, [chunk], [event]);

    expect(graph.edges.filter((edge) => edge.type === 'temporal-correlation')).toHaveLength(0);
  });

  it('skips log chunks without a timestamp', () => {
    // Log chunk with no timestamp field
    const chunk: IndexedChunk = {
      id: 'chunk-no-ts',
      artifactId: 'logs/default/app-pod/app.log',
      content: 'ERROR: something failed',
      startLine: 1,
      endLine: 5,
      summary: 'Log chunk',
      identifiers: ['app-pod'],
      artifactCategory: 'log',
      // timestamp intentionally absent
    };
    const event = makeTimedPodEvent('FailedMount', 'app-pod', 'default', '2024-01-01T10:00:10Z');

    const graph = new DiagnosticGraph();
    expect(() => addTemporalCorrelationEdges(graph, [chunk], [event])).not.toThrow();

    const tcEdges = graph.edges.filter((e) => e.type === 'temporal-correlation');
    expect(tcEdges).toHaveLength(0);
  });

  it('handles empty logChunks or empty events without error', () => {
    const graph = new DiagnosticGraph();
    expect(() => addTemporalCorrelationEdges(graph, [], [])).not.toThrow();
    expect(() =>
      addTemporalCorrelationEdges(
        graph,
        [makeLogChunk('c', 'app-pod', 'default', '2024-01-01T10:00:00Z')],
        [],
      ),
    ).not.toThrow();
    expect(graph.edges).toHaveLength(0);
  });

  it('does not create duplicate log-chunk nodes when called multiple times', () => {
    const chunk = makeLogChunk('chunk-1', 'app-pod', 'default', '2024-01-01T10:00:00Z');
    const event = makeTimedPodEvent('FailedMount', 'app-pod', 'default', '2024-01-01T10:00:20Z');

    const graph = new DiagnosticGraph();
    // Build the diagnostic graph first (adds resources/events normally)
    addTemporalCorrelationEdges(graph, [chunk], [event]);
    // Call again — should not add a second log-chunk node
    addTemporalCorrelationEdges(graph, [chunk], [event]);

    const logNodes = [...graph.nodes.values()].filter((n) => n.nodeType === 'log-chunk');
    expect(logNodes).toHaveLength(1);
  });

  it('uses timeline module — getEventWindow filters correctly (boundary check)', () => {
    // Exactly at boundary: 60s before the chunk timestamp
    const chunk = makeLogChunk('chunk-1', 'app-pod', 'default', '2024-01-01T10:01:00Z');
    const boundaryEvent = makeTimedPodEvent('Unhealthy', 'app-pod', 'default', '2024-01-01T10:00:00Z'); // 60s before
    const outsideEvent = makeTimedPodEvent('FailedMount', 'app-pod', 'default', '2024-01-01T09:59:59Z');  // 61s before

    const graph = new DiagnosticGraph();
    addTemporalCorrelationEdges(graph, [chunk], [boundaryEvent, outsideEvent]);

    const tcEdges = graph.edges.filter((e) => e.type === 'temporal-correlation');
    // Boundary event (exactly 60s) produces weight=0 but still creates edge
    expect(tcEdges).toHaveLength(1);
    expect(tcEdges[0]?.target).toBe('Event:default/Unhealthy:app-pod');
  });
});

// ---------------------------------------------------------------------------
// addTemporalSequenceEdges (4.6)
// ---------------------------------------------------------------------------

describe('addTemporalSequenceEdges (4.6)', () => {
  it('creates temporal-sequence edge for FailedMount → BackOff (canonical causal affinity)', () => {
    const failedMount = makeTimedPodEvent('FailedMount', 'app-pod', 'default', '2024-01-01T10:00:00Z');
    const backOff = makeTimedPodEvent('BackOff', 'app-pod', 'default', '2024-01-01T10:00:30Z');

    const graph = new DiagnosticGraph();
    addTemporalSequenceEdges(graph, [failedMount, backOff]);

    const seqEdges = graph.edges.filter((e) => e.type === 'temporal-sequence');
    expect(seqEdges).toHaveLength(1);

    const edge = seqEdges[0]!;
    // Earlier event is source, later event is target
    expect(edge.source).toBe('Event:default/FailedMount:app-pod');
    expect(edge.target).toBe('Event:default/BackOff:app-pod');
  });

  it('creates temporal-sequence edge for ErrImagePull → ImagePullBackOff', () => {
    const errImagePull = makeTimedPodEvent('ErrImagePull', 'app-pod', 'default', '2024-01-01T10:00:00Z');
    const imagePullBackOff = makeTimedPodEvent('ImagePullBackOff', 'app-pod', 'default', '2024-01-01T10:00:45Z');

    const graph = new DiagnosticGraph();
    addTemporalSequenceEdges(graph, [errImagePull, imagePullBackOff]);

    const seqEdges = graph.edges.filter((e) => e.type === 'temporal-sequence');
    expect(seqEdges).toHaveLength(1);
    expect(seqEdges[0]?.source).toContain('ErrImagePull');
    expect(seqEdges[0]?.target).toContain('ImagePullBackOff');
  });

  it('orders edges chronologically — earlier event is source, later is target', () => {
    // Pass events in reverse order — result must still be chronological
    const backOff = makeTimedPodEvent('BackOff', 'app-pod', 'default', '2024-01-01T10:00:30Z');
    const failedMount = makeTimedPodEvent('FailedMount', 'app-pod', 'default', '2024-01-01T10:00:00Z');

    const graph = new DiagnosticGraph();
    addTemporalSequenceEdges(graph, [backOff, failedMount]);

    const seqEdges = graph.edges.filter((e) => e.type === 'temporal-sequence');
    expect(seqEdges).toHaveLength(1);
    // FailedMount (earlier) → BackOff (later)
    expect(seqEdges[0]?.source).toBe('Event:default/FailedMount:app-pod');
    expect(seqEdges[0]?.target).toBe('Event:default/BackOff:app-pod');
  });

  it('does NOT create edge for events targeting different pods', () => {
    const failedMount = makeTimedPodEvent('FailedMount', 'pod-a', 'default', '2024-01-01T10:00:00Z');
    const backOff = makeTimedPodEvent('BackOff', 'pod-b', 'default', '2024-01-01T10:00:30Z');

    const graph = new DiagnosticGraph();
    addTemporalSequenceEdges(graph, [failedMount, backOff]);

    const seqEdges = graph.edges.filter((e) => e.type === 'temporal-sequence');
    expect(seqEdges).toHaveLength(0);
  });

  it('does NOT create a sequence across same-name pods in different namespaces', () => {
    const failedMount = makeTimedPodEvent(
      'FailedMount',
      'app-pod',
      'team-a',
      '2024-01-01T10:00:00Z',
    );
    const backOff = makeTimedPodEvent(
      'BackOff',
      'app-pod',
      'team-b',
      '2024-01-01T10:00:30Z',
    );

    const graph = new DiagnosticGraph();
    addTemporalSequenceEdges(graph, [failedMount, backOff]);

    expect(graph.edges.filter((edge) => edge.type === 'temporal-sequence')).toHaveLength(0);
  });

  it('does NOT create edge for event pairs without causal affinity', () => {
    // Two events that are not in the known causal affinity table
    const event1 = makeTimedPodEvent('Scheduled', 'app-pod', 'default', '2024-01-01T10:00:00Z');
    const event2 = makeTimedPodEvent('Pulled', 'app-pod', 'default', '2024-01-01T10:00:10Z');

    const graph = new DiagnosticGraph();
    addTemporalSequenceEdges(graph, [event1, event2]);

    const seqEdges = graph.edges.filter((e) => e.type === 'temporal-sequence');
    expect(seqEdges).toHaveLength(0);
  });

  it('handles events without timestamps gracefully', () => {
    const noTsEvent: K8sEvent = {
      type: 'Warning',
      reason: 'FailedMount',
      message: 'no timestamp',
      involvedObject: { kind: 'Pod', name: 'app-pod', namespace: 'default' },
      // no firstTimestamp, no lastTimestamp
      count: 1,
    };
    const timedEvent = makeTimedPodEvent('BackOff', 'app-pod', 'default', '2024-01-01T10:00:30Z');

    const graph = new DiagnosticGraph();
    expect(() => addTemporalSequenceEdges(graph, [noTsEvent, timedEvent])).not.toThrow();

    // No edge should be created since prior event has no timestamp
    const seqEdges = graph.edges.filter((e) => e.type === 'temporal-sequence');
    expect(seqEdges).toHaveLength(0);
  });

  it('handles empty or single-event arrays without error', () => {
    const graph = new DiagnosticGraph();
    expect(() => addTemporalSequenceEdges(graph, [])).not.toThrow();
    expect(() =>
      addTemporalSequenceEdges(graph, [
        makeTimedPodEvent('FailedMount', 'app-pod', 'default', '2024-01-01T10:00:00Z'),
      ]),
    ).not.toThrow();
    expect(graph.edges).toHaveLength(0);
  });

  it('creates edges for multiple pods independently', () => {
    // pod-a: FailedMount → BackOff
    const failedA = makeTimedPodEvent('FailedMount', 'pod-a', 'default', '2024-01-01T10:00:00Z');
    const backOffA = makeTimedPodEvent('BackOff', 'pod-a', 'default', '2024-01-01T10:00:30Z');
    // pod-b: ErrImagePull → ImagePullBackOff
    const errB = makeTimedPodEvent('ErrImagePull', 'pod-b', 'default', '2024-01-01T10:00:00Z');
    const pullBackOffB = makeTimedPodEvent('ImagePullBackOff', 'pod-b', 'default', '2024-01-01T10:00:15Z');

    const graph = new DiagnosticGraph();
    addTemporalSequenceEdges(graph, [failedA, backOffA, errB, pullBackOffB]);

    const seqEdges = graph.edges.filter((e) => e.type === 'temporal-sequence');
    expect(seqEdges).toHaveLength(2);

    const sources = seqEdges.map((e) => e.source);
    expect(sources).toContain('Event:default/FailedMount:pod-a');
    expect(sources).toContain('Event:default/ErrImagePull:pod-b');
  });

  it('adds event nodes to the graph for each sequenced event', () => {
    const failedMount = makeTimedPodEvent('FailedMount', 'app-pod', 'default', '2024-01-01T10:00:00Z');
    const backOff = makeTimedPodEvent('BackOff', 'app-pod', 'default', '2024-01-01T10:00:30Z');

    const graph = new DiagnosticGraph();
    addTemporalSequenceEdges(graph, [failedMount, backOff]);

    expect(graph.getNode('Event:default/FailedMount:app-pod')).toBeDefined();
    expect(graph.getNode('Event:default/BackOff:app-pod')).toBeDefined();
  });

  it('uses sortEventsByTime from timeline module — produces correct order regardless of input order', () => {
    // Input order: BackOff (T+30), then FailedMount (T+0)
    const events = [
      makeTimedPodEvent('BackOff', 'app-pod', 'default', '2024-01-01T10:00:30Z'),
      makeTimedPodEvent('FailedMount', 'app-pod', 'default', '2024-01-01T10:00:00Z'),
    ];

    const graph = new DiagnosticGraph();
    addTemporalSequenceEdges(graph, events);

    const seqEdges = graph.edges.filter((e) => e.type === 'temporal-sequence');
    expect(seqEdges).toHaveLength(1);
    // Regardless of input order, FailedMount (earlier) is always the source
    expect(seqEdges[0]?.source).toBe('Event:default/FailedMount:app-pod');
    expect(seqEdges[0]?.target).toBe('Event:default/BackOff:app-pod');
  });
});

// ---------------------------------------------------------------------------
// buildWorkloadGroups (4.7 — hierarchical graph abstraction, middle layer)
// ---------------------------------------------------------------------------

describe('buildWorkloadGroups (4.7)', () => {
  // -------------------------------------------------------------------------
  // Node creation
  // -------------------------------------------------------------------------

  it('creates a workload-group node for each Deployment', () => {
    const deploy = makeDeploymentWithSelector('myapp', { app: 'myapp' });
    const pod = makePod('myapp-pod', 'default', { labels: { app: 'myapp' } });

    const dg = buildDiagnosticGraph([deploy, pod], []);
    buildWorkloadGroups(dg);

    const wgNode = dg.getNode('workload-group:default/myapp');
    expect(wgNode).toBeDefined();
    expect(wgNode?.nodeType).toBe('workload-group');
  });

  it('creates workload-group nodes for StatefulSet and DaemonSet', () => {
    const sts = makeStatefulSetWithSelector('mydb', { app: 'mydb' });
    const ds = makeDaemonSetWithSelector('node-agent', { app: 'node-agent' });
    const pod1 = makePod('mydb-0', 'default', { labels: { app: 'mydb' } });
    const pod2 = makePod('node-agent-abc', 'default', { labels: { app: 'node-agent' } });

    const dg = buildDiagnosticGraph([sts, ds, pod1, pod2], []);
    buildWorkloadGroups(dg);

    expect(dg.getNode('workload-group:default/mydb')).toBeDefined();
    expect(dg.getNode('workload-group:default/node-agent')).toBeDefined();
  });

  it('WorkloadGroup data contains name and namespace', () => {
    const deploy = makeDeploymentWithSelector('myapp', { app: 'myapp' }, 'production');
    const pod = makePod('myapp-pod', 'production', { labels: { app: 'myapp' } });

    const dg = buildDiagnosticGraph([deploy, pod], []);
    buildWorkloadGroups(dg);

    const wgNode = dg.getNode('workload-group:production/myapp');
    expect(wgNode).toBeDefined();
    const data = wgNode?.data as { name: string; namespace: string; members: string[] };
    expect(data.name).toBe('myapp');
    expect(data.namespace).toBe('production');
  });

  it('creates a derived-from edge from WorkloadGroup to the underlying workload', () => {
    const deploy = makeDeploymentWithSelector('myapp', { app: 'myapp' });
    const pod = makePod('myapp-pod', 'default', { labels: { app: 'myapp' } });

    const dg = buildDiagnosticGraph([deploy, pod], []);
    buildWorkloadGroups(dg);

    const wgId = 'workload-group:default/myapp';
    const derivedEdges = dg.edges.filter((e) => e.type === 'derived-from' && e.source === wgId);
    expect(derivedEdges).toHaveLength(1);
    expect(derivedEdges[0]?.target).toBe('Deployment:default/myapp');
  });

  it('does not create workload-group nodes for plain Pods or Services', () => {
    const svc = makeServiceWithSelector('myapp-svc', { app: 'myapp' });
    const pod = makePod('myapp-pod', 'default', { labels: { app: 'myapp' } });

    const dg = buildDiagnosticGraph([svc, pod], []);
    buildWorkloadGroups(dg);

    // No workload-group node should exist — neither Pod nor Service triggers creation
    const wgNodes = [...dg.nodes.values()].filter((n) => n.nodeType === 'workload-group');
    expect(wgNodes).toHaveLength(0);
  });

  it('handles an empty graph (no workloads) without error', () => {
    const dg = new DiagnosticGraph();
    expect(() => buildWorkloadGroups(dg)).not.toThrow();

    const wgNodes = [...dg.nodes.values()].filter((n) => n.nodeType === 'workload-group');
    expect(wgNodes).toHaveLength(0);
  });

  it('handles a graph with workloads but no matching pods', () => {
    // Deployment with no matching pods — workload-group is still created
    const deploy = makeDeploymentWithSelector('myapp', { app: 'myapp' });
    // Pod has different label — not selected
    const pod = makePod('other-pod', 'default', { labels: { app: 'other' } });

    const dg = buildDiagnosticGraph([deploy, pod], []);
    expect(() => buildWorkloadGroups(dg)).not.toThrow();

    const wgNode = dg.getNode('workload-group:default/myapp');
    expect(wgNode).toBeDefined();
    const data = wgNode?.data as { members: string[] };
    // Members should only include the workload itself (no pods matched)
    expect(data.members).toContain('Deployment:default/myapp');
    expect(data.members).not.toContain('Pod:default/other-pod');
  });

  // -------------------------------------------------------------------------
  // Pod membership
  // -------------------------------------------------------------------------

  it('WorkloadGroup members array contains constituent Pods', () => {
    const deploy = makeDeploymentWithSelector('myapp', { app: 'myapp' });
    const pod1 = makePod('myapp-pod-1', 'default', { labels: { app: 'myapp' } });
    const pod2 = makePod('myapp-pod-2', 'default', { labels: { app: 'myapp' } });

    const dg = buildDiagnosticGraph([deploy, pod1, pod2], []);
    buildWorkloadGroups(dg);

    const wgNode = dg.getNode('workload-group:default/myapp');
    const data = wgNode?.data as { members: string[] };
    expect(data.members).toContain('Pod:default/myapp-pod-1');
    expect(data.members).toContain('Pod:default/myapp-pod-2');
  });

  it('creates label-selector edges from WorkloadGroup to each constituent Pod', () => {
    const deploy = makeDeploymentWithSelector('myapp', { app: 'myapp' });
    const pod1 = makePod('myapp-pod-1', 'default', { labels: { app: 'myapp' } });
    const pod2 = makePod('myapp-pod-2', 'default', { labels: { app: 'myapp' } });

    const dg = buildDiagnosticGraph([deploy, pod1, pod2], []);
    buildWorkloadGroups(dg);

    const wgId = 'workload-group:default/myapp';
    const podEdges = dg.edges.filter((e) => e.type === 'label-selector' && e.source === wgId);
    expect(podEdges).toHaveLength(2);

    const targets = podEdges.map((e) => e.target);
    expect(targets).toContain('Pod:default/myapp-pod-1');
    expect(targets).toContain('Pod:default/myapp-pod-2');
  });

  // -------------------------------------------------------------------------
  // Secret & ConfigMap membership
  // -------------------------------------------------------------------------

  it('WorkloadGroup members array contains Secrets referenced by constituent Pods', () => {
    const deploy = makeDeploymentWithSelector('myapp', { app: 'myapp' });
    const pod = makePod('myapp-pod', 'default', {
      labels: { app: 'myapp' },
      secretNames: ['app-secret', 'db-creds'],
    });

    const dg = buildDiagnosticGraph([deploy, pod], []);
    buildWorkloadGroups(dg);

    const wgNode = dg.getNode('workload-group:default/myapp');
    const data = wgNode?.data as { members: string[] };
    expect(data.members).toContain('Secret:default/app-secret');
    expect(data.members).toContain('Secret:default/db-creds');
  });

  it('WorkloadGroup members array contains ConfigMaps referenced by constituent Pods', () => {
    const deploy = makeDeploymentWithSelector('myapp', { app: 'myapp' });
    const pod = makePod('myapp-pod', 'default', {
      labels: { app: 'myapp' },
      configMapNames: ['app-config'],
    });

    const dg = buildDiagnosticGraph([deploy, pod], []);
    buildWorkloadGroups(dg);

    const wgNode = dg.getNode('workload-group:default/myapp');
    const data = wgNode?.data as { members: string[] };
    expect(data.members).toContain('ConfigMap:default/app-config');
  });

  it('WorkloadGroup members contains both the workload and all dependent resources', () => {
    const deploy = makeDeploymentWithSelector('myapp', { app: 'myapp' });
    const pod = makePod('myapp-pod', 'default', {
      labels: { app: 'myapp' },
      secretNames: ['app-secret'],
      configMapNames: ['app-config'],
      pvcNames: ['app-data'],
    });

    const dg = buildDiagnosticGraph([deploy, pod], []);
    buildWorkloadGroups(dg);

    const wgNode = dg.getNode('workload-group:default/myapp');
    const data = wgNode?.data as { members: string[] };
    // Must contain: the Deployment, the Pod, the Secret, the ConfigMap, the PVC
    expect(data.members).toContain('Deployment:default/myapp');
    expect(data.members).toContain('Pod:default/myapp-pod');
    expect(data.members).toContain('Secret:default/app-secret');
    expect(data.members).toContain('ConfigMap:default/app-config');
    expect(data.members).toContain('PersistentVolumeClaim:default/app-data');
  });

  // -------------------------------------------------------------------------
  // Service connectivity
  // -------------------------------------------------------------------------

  it('adds a service-selector edge from Service to WorkloadGroup', () => {
    const deploy = makeDeploymentWithSelector('myapp', { app: 'myapp' });
    const pod = makePod('myapp-pod', 'default', { labels: { app: 'myapp' } });
    const svc = makeServiceWithSelector('myapp-svc', { app: 'myapp' });

    const dg = buildDiagnosticGraph([deploy, pod, svc], []);
    buildWorkloadGroups(dg);

    const wgId = 'workload-group:default/myapp';
    const svcToWgEdges = dg.edges.filter(
      (e) => e.type === 'service-selector' && e.target === wgId,
    );
    expect(svcToWgEdges).toHaveLength(1);
    expect(svcToWgEdges[0]?.source).toBe('Service:default/myapp-svc');
  });

  it('each Service only gets one service-selector edge to a WorkloadGroup (no duplicates)', () => {
    const deploy = makeDeploymentWithSelector('myapp', { app: 'myapp' });
    // Two pods — Service selects both, but only one edge to WorkloadGroup
    const pod1 = makePod('myapp-pod-1', 'default', { labels: { app: 'myapp' } });
    const pod2 = makePod('myapp-pod-2', 'default', { labels: { app: 'myapp' } });
    const svc = makeServiceWithSelector('myapp-svc', { app: 'myapp' });

    const dg = buildDiagnosticGraph([deploy, pod1, pod2, svc], []);
    buildWorkloadGroups(dg);

    const wgId = 'workload-group:default/myapp';
    const svcToWgEdges = dg.edges.filter(
      (e) => e.type === 'service-selector' && e.source === 'Service:default/myapp-svc' && e.target === wgId,
    );
    expect(svcToWgEdges).toHaveLength(1);
  });

  it('does not add service-selector edges when no Service matches the workload pods', () => {
    const deploy = makeDeploymentWithSelector('myapp', { app: 'myapp' });
    const pod = makePod('myapp-pod', 'default', { labels: { app: 'myapp' } });
    // Service selects a different label set
    const svc = makeServiceWithSelector('other-svc', { app: 'other' });

    const dg = buildDiagnosticGraph([deploy, pod, svc], []);
    buildWorkloadGroups(dg);

    const wgId = 'workload-group:default/myapp';
    const svcToWgEdges = dg.edges.filter(
      (e) => e.type === 'service-selector' && e.target === wgId,
    );
    expect(svcToWgEdges).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Multiple workloads
  // -------------------------------------------------------------------------

  it('creates independent WorkloadGroups for multiple Deployments', () => {
    const deployA = makeDeploymentWithSelector('frontend', { app: 'frontend' });
    const deployB = makeDeploymentWithSelector('backend', { app: 'backend' });
    const podA = makePod('frontend-pod', 'default', { labels: { app: 'frontend' } });
    const podB = makePod('backend-pod', 'default', { labels: { app: 'backend' } });

    const dg = buildDiagnosticGraph([deployA, deployB, podA, podB], []);
    buildWorkloadGroups(dg);

    const wgA = dg.getNode('workload-group:default/frontend');
    const wgB = dg.getNode('workload-group:default/backend');
    expect(wgA).toBeDefined();
    expect(wgB).toBeDefined();

    const dataA = wgA?.data as { members: string[] };
    const dataB = wgB?.data as { members: string[] };

    // Pods are in the correct workload group
    expect(dataA.members).toContain('Pod:default/frontend-pod');
    expect(dataA.members).not.toContain('Pod:default/backend-pod');
    expect(dataB.members).toContain('Pod:default/backend-pod');
    expect(dataB.members).not.toContain('Pod:default/frontend-pod');
  });

  it('Services are connected to the correct WorkloadGroup when selectors differ', () => {
    const deployA = makeDeploymentWithSelector('frontend', { app: 'frontend' });
    const deployB = makeDeploymentWithSelector('backend', { app: 'backend' });
    const podA = makePod('frontend-pod', 'default', { labels: { app: 'frontend' } });
    const podB = makePod('backend-pod', 'default', { labels: { app: 'backend' } });
    const svcA = makeServiceWithSelector('frontend-svc', { app: 'frontend' });
    const svcB = makeServiceWithSelector('backend-svc', { app: 'backend' });

    const dg = buildDiagnosticGraph([deployA, deployB, podA, podB, svcA, svcB], []);
    buildWorkloadGroups(dg);

    const wgAId = 'workload-group:default/frontend';
    const wgBId = 'workload-group:default/backend';

    const edgesForA = dg.edges.filter((e) => e.type === 'service-selector' && e.target === wgAId);
    const edgesForB = dg.edges.filter((e) => e.type === 'service-selector' && e.target === wgBId);

    expect(edgesForA).toHaveLength(1);
    expect(edgesForA[0]?.source).toBe('Service:default/frontend-svc');
    expect(edgesForB).toHaveLength(1);
    expect(edgesForB[0]?.source).toBe('Service:default/backend-svc');
  });

  // -------------------------------------------------------------------------
  // Traversal at workload level (4.7 "answers what's wrong with this deployment?")
  // -------------------------------------------------------------------------

  it('traversal from WorkloadGroup reaches constituent Pods at depth 1', () => {
    const deploy = makeDeploymentWithSelector('myapp', { app: 'myapp' });
    const pod1 = makePod('myapp-pod-1', 'default', { labels: { app: 'myapp' } });
    const pod2 = makePod('myapp-pod-2', 'default', { labels: { app: 'myapp' } });

    const dg = buildDiagnosticGraph([deploy, pod1, pod2], []);
    buildWorkloadGroups(dg);

    const wgId = 'workload-group:default/myapp';
    const results = traverse(dg, {
      start: wgId,
      direction: 'forward',
      edgeTypes: ['label-selector'],
      maxDepth: 1,
    });

    const reachedIds = results.map((r) => r.nodeId);
    expect(reachedIds).toContain('Pod:default/myapp-pod-1');
    expect(reachedIds).toContain('Pod:default/myapp-pod-2');
  });

  it('traversal from WorkloadGroup reaches Secrets via Pods at depth 2', () => {
    const deploy = makeDeploymentWithSelector('myapp', { app: 'myapp' });
    const pod = makePod('myapp-pod', 'default', {
      labels: { app: 'myapp' },
      secretNames: ['app-secret'],
    });

    const dg = buildDiagnosticGraph([deploy, pod], []);
    buildWorkloadGroups(dg);

    const wgId = 'workload-group:default/myapp';
    const results = traverse(dg, {
      start: wgId,
      direction: 'forward',
      edgeTypes: ['label-selector', 'references-secret'],
      maxDepth: 2,
    });

    const reachedIds = results.map((r) => r.nodeId);
    expect(reachedIds).toContain('Pod:default/myapp-pod');   // depth 1
    expect(reachedIds).toContain('Secret:default/app-secret'); // depth 2
  });

  it('traversal (both directions) from WorkloadGroup reaches Services via backward service-selector', () => {
    const deploy = makeDeploymentWithSelector('myapp', { app: 'myapp' });
    const pod = makePod('myapp-pod', 'default', { labels: { app: 'myapp' } });
    const svc = makeServiceWithSelector('myapp-svc', { app: 'myapp' });

    const dg = buildDiagnosticGraph([deploy, pod, svc], []);
    buildWorkloadGroups(dg);

    const wgId = 'workload-group:default/myapp';
    // Backward traversal: Service → WorkloadGroup (service-selector edge points TO wg)
    const results = traverse(dg, {
      start: wgId,
      direction: 'backward',
      edgeTypes: ['service-selector'],
      maxDepth: 1,
    });

    const reachedIds = results.map((r) => r.nodeId);
    expect(reachedIds).toContain('Service:default/myapp-svc');
  });

  it('traversal from WorkloadGroup does not enumerate raw Deployment node at depth 0', () => {
    // The WorkloadGroup IS the starting point — it answers "what's wrong with the workload?"
    // without requiring the user to start at the Deployment
    const deploy = makeDeploymentWithSelector('myapp', { app: 'myapp' });
    const pod = makePod('myapp-pod', 'default', { labels: { app: 'myapp' } });
    const svc = makeServiceWithSelector('myapp-svc', { app: 'myapp' });
    const secret = makeSecret('app-secret');
    const podWithSecret = makePod('myapp-pod-2', 'default', {
      labels: { app: 'myapp' },
      secretNames: ['app-secret'],
    });

    const dg = buildDiagnosticGraph([deploy, pod, podWithSecret, secret, svc], []);
    buildWorkloadGroups(dg);

    const wgId = 'workload-group:default/myapp';
    const results = traverse(dg, {
      start: wgId,
      direction: 'both',
      edgeTypes: ['label-selector', 'references-secret', 'service-selector', 'derived-from'],
      maxDepth: 3,
    });

    const reachedIds = new Set(results.map((r) => r.nodeId));
    // Can reach all components from the WorkloadGroup node
    expect(reachedIds.has(wgId)).toBe(true);                         // self (depth 0)
    expect(reachedIds.has('Pod:default/myapp-pod')).toBe(true);      // depth 1 via label-selector
    expect(reachedIds.has('Pod:default/myapp-pod-2')).toBe(true);    // depth 1 via label-selector
    expect(reachedIds.has('Secret:default/app-secret')).toBe(true);  // depth 2 via references-secret
    expect(reachedIds.has('Service:default/myapp-svc')).toBe(true);  // depth 1 via backward service-selector
    expect(reachedIds.has('Deployment:default/myapp')).toBe(true);   // depth 1 via derived-from
  });

  it('idempotent — calling buildWorkloadGroups twice does not create duplicate nodes', () => {
    const deploy = makeDeploymentWithSelector('myapp', { app: 'myapp' });
    const pod = makePod('myapp-pod', 'default', { labels: { app: 'myapp' } });

    const dg = buildDiagnosticGraph([deploy, pod], []);
    buildWorkloadGroups(dg);
    buildWorkloadGroups(dg);

    // addNode overwrites, so only one node should exist
    const wgNodes = [...dg.nodes.values()].filter((n) => n.nodeType === 'workload-group');
    expect(wgNodes).toHaveLength(1);
  });
});
