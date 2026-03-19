import { describe, it, expect } from 'vitest';
import { traverse, traverseForChunks } from '../traversal.js';
import { DiagnosticGraph, buildDiagnosticGraph } from '../diagnostic-graph.js';
import { getRelatedChunks, buildResourceGraph } from '../resource-graph.js';
import { asResourceRelationshipGraph } from '../diagnostic-graph.js';
import type { IndexedChunk } from '../../ai/chunk-indexer.js';
import type { K8sResource } from '../../types/index.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** Build a linear causal chain: A ─causes─► B ─causes─► C */
function buildCausalChain(): DiagnosticGraph {
  const graph = new DiagnosticGraph();
  graph.addNode({ id: 'A', nodeType: 'finding', data: { name: 'finding-a' } });
  graph.addNode({ id: 'B', nodeType: 'finding', data: { name: 'finding-b' } });
  graph.addNode({ id: 'C', nodeType: 'finding', data: { name: 'finding-c' } });
  graph.addEdge({ id: 'e1', source: 'A', target: 'B', type: 'causes', weight: 1.0 });
  graph.addEdge({ id: 'e2', source: 'B', target: 'C', type: 'causes', weight: 1.0 });
  return graph;
}

function makeChunk(
  id: string,
  identifiers: string[],
  namespace?: string,
  metadata?: Record<string, unknown>,
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
    metadata,
  };
}

function makePod(
  name: string,
  namespace = 'default',
  labels?: Record<string, string>,
): K8sResource {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name, namespace, labels } as unknown as K8sResource['metadata'],
    spec: { containers: [{ name: 'app', image: 'my-app:latest' }] },
    status: { phase: 'Running', containerStatuses: [], conditions: [] },
  };
}

// ---------------------------------------------------------------------------
// traverse — forward direction
// ---------------------------------------------------------------------------

describe('traverse — forward direction', () => {
  it('follows causes edges forward A → B → C', () => {
    const graph = buildCausalChain();
    const results = traverse(graph, {
      start: 'A',
      direction: 'forward',
      edgeTypes: ['causes'],
      maxDepth: 5,
    });
    const ids = results.map((r) => r.nodeId);
    expect(ids).toContain('A');
    expect(ids).toContain('B');
    expect(ids).toContain('C');
  });

  it('does NOT follow non-causes edges when edgeTypes is ["causes"]', () => {
    const graph = buildCausalChain();
    graph.addNode({ id: 'D', nodeType: 'resource', data: { name: 'resource-d' } });
    graph.addEdge({ id: 'e3', source: 'A', target: 'D', type: 'supports', weight: 1.0 });

    const results = traverse(graph, {
      start: 'A',
      direction: 'forward',
      edgeTypes: ['causes'],
      maxDepth: 5,
    });
    const ids = results.map((r) => r.nodeId);
    expect(ids).not.toContain('D'); // supports edge not followed
    expect(ids).toContain('B');
    expect(ids).toContain('C');
  });

  it('does NOT walk backward when direction is forward', () => {
    const graph = buildCausalChain();
    // Start at B: forward only → should reach C but NOT A
    const results = traverse(graph, {
      start: 'B',
      direction: 'forward',
      edgeTypes: ['causes'],
      maxDepth: 5,
    });
    const ids = results.map((r) => r.nodeId);
    expect(ids).toContain('B');
    expect(ids).toContain('C');
    expect(ids).not.toContain('A');
  });

  it('returns empty array when start node does not exist', () => {
    const graph = buildCausalChain();
    const results = traverse(graph, {
      start: 'nonexistent-node-id',
      direction: 'forward',
      edgeTypes: ['causes'],
    });
    expect(results).toHaveLength(0);
  });

  it('returns only the start node when no matching edges exist', () => {
    const graph = new DiagnosticGraph();
    graph.addNode({ id: 'solo', nodeType: 'finding', data: {} });
    const results = traverse(graph, {
      start: 'solo',
      direction: 'forward',
      edgeTypes: ['causes'],
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.nodeId).toBe('solo');
  });
});

// ---------------------------------------------------------------------------
// traverse — backward direction (root-cause search)
// ---------------------------------------------------------------------------

describe('traverse — backward direction', () => {
  it('walks backward along causes edges: C → B → A', () => {
    const graph = buildCausalChain();
    const results = traverse(graph, {
      start: 'C',
      direction: 'backward',
      edgeTypes: ['causes'],
      maxDepth: 5,
    });
    const ids = results.map((r) => r.nodeId);
    expect(ids).toContain('C');
    expect(ids).toContain('B');
    expect(ids).toContain('A');
  });

  it('does NOT walk forward when direction is backward', () => {
    const graph = buildCausalChain();
    // Start at B: backward only → A but NOT C
    const results = traverse(graph, {
      start: 'B',
      direction: 'backward',
      edgeTypes: ['causes'],
      maxDepth: 5,
    });
    const ids = results.map((r) => r.nodeId);
    expect(ids).toContain('B');
    expect(ids).toContain('A');
    expect(ids).not.toContain('C');
  });

  it('backward traversal assigns correct depths', () => {
    const graph = buildCausalChain();
    const results = traverse(graph, {
      start: 'C',
      direction: 'backward',
      edgeTypes: ['causes'],
      maxDepth: 5,
    });
    const byId = new Map(results.map((r) => [r.nodeId, r]));
    expect(byId.get('C')?.depth).toBe(0);
    expect(byId.get('B')?.depth).toBe(1);
    expect(byId.get('A')?.depth).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// traverse — both directions
// ---------------------------------------------------------------------------

describe('traverse — both directions', () => {
  it('walks both forward and backward from the middle of a chain', () => {
    const graph = buildCausalChain();
    // Start at B: both → should reach A (backward) and C (forward)
    const results = traverse(graph, {
      start: 'B',
      direction: 'both',
      edgeTypes: ['causes'],
      maxDepth: 5,
    });
    const ids = results.map((r) => r.nodeId);
    expect(ids).toContain('A');
    expect(ids).toContain('B');
    expect(ids).toContain('C');
  });

  it('walks multiple edge types when specified', () => {
    const graph = new DiagnosticGraph();
    graph.addNode({ id: 'root', nodeType: 'finding', data: { name: 'root' } });
    graph.addNode({ id: 'cause', nodeType: 'finding', data: { name: 'cause' } });
    graph.addNode({ id: 'evidence', nodeType: 'resource', data: { name: 'evidence' } });
    graph.addEdge({ id: 'e1', source: 'cause', target: 'root', type: 'causes', weight: 1.0 });
    graph.addEdge({ id: 'e2', source: 'evidence', target: 'root', type: 'supports', weight: 1.0 });

    const results = traverse(graph, {
      start: 'root',
      direction: 'both',
      edgeTypes: ['causes', 'supports'],
      maxDepth: 2,
    });
    const ids = results.map((r) => r.nodeId);
    expect(ids).toContain('root');
    expect(ids).toContain('cause');
    expect(ids).toContain('evidence');
  });

  it('traverses structural K8s edges in both directions', () => {
    // Use a custom graph for precise control over the edges present
    const g2 = new DiagnosticGraph();
    g2.addNode({ id: 'Pod:default/app-pod', nodeType: 'resource', data: { kind: 'Pod', name: 'app-pod', namespace: 'default' } });
    g2.addNode({ id: 'Secret:default/db-secret', nodeType: 'resource', data: { kind: 'Secret', name: 'db-secret', namespace: 'default' } });
    g2.addEdge({ id: 'e1', source: 'Pod:default/app-pod', target: 'Secret:default/db-secret', type: 'references-secret', weight: 1.0 });

    const results = traverse(g2, {
      start: 'Secret:default/db-secret',
      direction: 'both',
      edgeTypes: ['references-secret'],
      maxDepth: 2,
    });
    const ids = results.map((r) => r.nodeId);
    expect(ids).toContain('Pod:default/app-pod');
    expect(ids).toContain('Secret:default/db-secret');
  });
});

// ---------------------------------------------------------------------------
// traverse — scoring: score = edge_weight × decay^depth
// ---------------------------------------------------------------------------

describe('traverse — scoring: score = edge_weight × decay^depth', () => {
  it('start node always has score 1.0', () => {
    const graph = buildCausalChain();
    const results = traverse(graph, { start: 'A', direction: 'forward', edgeTypes: ['causes'] });
    const startResult = results.find((r) => r.nodeId === 'A');
    expect(startResult?.score).toBe(1.0);
    expect(startResult?.depth).toBe(0);
  });

  it('depth-1 node: score = edge_weight × decay^1 with default decay=0.7', () => {
    const graph = buildCausalChain(); // edges weight=1.0
    const results = traverse(graph, { start: 'A', direction: 'forward', edgeTypes: ['causes'] });
    const r = results.find((r) => r.nodeId === 'B');
    expect(r?.depth).toBe(1);
    // 1.0 × 0.7^1 = 0.7
    expect(r?.score).toBeCloseTo(0.7);
  });

  it('depth-2 node: score = edge_weight × decay^2 with default decay=0.7', () => {
    const graph = buildCausalChain(); // edges weight=1.0
    const results = traverse(graph, { start: 'A', direction: 'forward', edgeTypes: ['causes'] });
    const r = results.find((r) => r.nodeId === 'C');
    expect(r?.depth).toBe(2);
    // 1.0 × 0.7^2 = 0.49
    expect(r?.score).toBeCloseTo(0.49);
  });

  it('uses edge weight in score: depth-1 via weight=0.8 edge gives 0.8 × 0.7 = 0.56', () => {
    const graph = new DiagnosticGraph();
    graph.addNode({ id: 'start', nodeType: 'finding', data: {} });
    graph.addNode({ id: 'target', nodeType: 'resource', data: {} });
    graph.addEdge({ id: 'e1', source: 'start', target: 'target', type: 'causes', weight: 0.8 });

    const results = traverse(graph, { start: 'start', direction: 'forward', edgeTypes: ['causes'] });
    const r = results.find((r) => r.nodeId === 'target');
    expect(r?.depth).toBe(1);
    // 0.8 × 0.7^1 = 0.56
    expect(r?.score).toBeCloseTo(0.56);
  });

  it('respects custom scoreDecay parameter', () => {
    const graph = buildCausalChain();
    const results = traverse(graph, {
      start: 'A',
      direction: 'forward',
      edgeTypes: ['causes'],
      scoreDecay: 0.5,
    });
    const d1 = results.find((r) => r.nodeId === 'B');
    const d2 = results.find((r) => r.nodeId === 'C');
    // decay=0.5: 1.0 × 0.5^1 = 0.5
    expect(d1?.score).toBeCloseTo(0.5);
    // 1.0 × 0.5^2 = 0.25
    expect(d2?.score).toBeCloseTo(0.25);
  });

  it('edges without explicit weight default to 1.0', () => {
    const graph = new DiagnosticGraph();
    graph.addNode({ id: 'X', nodeType: 'finding', data: {} });
    graph.addNode({ id: 'Y', nodeType: 'finding', data: {} });
    // No weight on edge
    graph.addEdge({ id: 'e1', source: 'X', target: 'Y', type: 'causes' });

    const results = traverse(graph, { start: 'X', direction: 'forward', edgeTypes: ['causes'] });
    const r = results.find((r) => r.nodeId === 'Y');
    // default weight = 1.0: 1.0 × 0.7 = 0.7
    expect(r?.score).toBeCloseTo(0.7);
  });

  it('when multiple paths reach a node, the highest score wins', () => {
    // A --0.9--> B --1.0--> D
    //        \--1.0--> C --1.0--> D
    const graph = new DiagnosticGraph();
    graph.addNode({ id: 'A', nodeType: 'finding', data: {} });
    graph.addNode({ id: 'B', nodeType: 'finding', data: {} });
    graph.addNode({ id: 'C', nodeType: 'finding', data: {} });
    graph.addNode({ id: 'D', nodeType: 'finding', data: {} });
    graph.addEdge({ id: 'e1', source: 'A', target: 'B', type: 'causes', weight: 0.9 });
    graph.addEdge({ id: 'e2', source: 'A', target: 'C', type: 'causes', weight: 1.0 });
    graph.addEdge({ id: 'e3', source: 'B', target: 'D', type: 'causes', weight: 1.0 });
    graph.addEdge({ id: 'e4', source: 'C', target: 'D', type: 'causes', weight: 1.0 });

    const results = traverse(graph, { start: 'A', direction: 'forward', edgeTypes: ['causes'] });
    const rD = results.find((r) => r.nodeId === 'D');
    expect(rD).toBeDefined();
    // D is at depth 2 via both paths; best score = 1.0 × 0.7^2 = 0.49 (via C edge weight 1.0)
    expect(rD?.score).toBeCloseTo(0.49);
  });
});

// ---------------------------------------------------------------------------
// traverse — maxDepth
// ---------------------------------------------------------------------------

describe('traverse — maxDepth', () => {
  it('stops at maxDepth=1: reaches B but not C', () => {
    const graph = buildCausalChain();
    const results = traverse(graph, {
      start: 'A',
      direction: 'forward',
      edgeTypes: ['causes'],
      maxDepth: 1,
    });
    const ids = results.map((r) => r.nodeId);
    expect(ids).toContain('A');
    expect(ids).toContain('B');
    expect(ids).not.toContain('C');
  });

  it('stops at maxDepth=0: only the start node is returned', () => {
    const graph = buildCausalChain();
    const results = traverse(graph, {
      start: 'A',
      direction: 'forward',
      edgeTypes: ['causes'],
      maxDepth: 0,
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.nodeId).toBe('A');
  });

  it('traverses full chain when maxDepth >= chain length', () => {
    const graph = buildCausalChain();
    const results = traverse(graph, {
      start: 'A',
      direction: 'forward',
      edgeTypes: ['causes'],
      maxDepth: 10,
    });
    const ids = results.map((r) => r.nodeId);
    expect(ids).toContain('C');
  });
});

// ---------------------------------------------------------------------------
// traverse — minWeight
// ---------------------------------------------------------------------------

describe('traverse — minWeight', () => {
  it('skips edges with weight below minWeight', () => {
    const graph = new DiagnosticGraph();
    graph.addNode({ id: 'start', nodeType: 'finding', data: {} });
    graph.addNode({ id: 'strong', nodeType: 'resource', data: {} });
    graph.addNode({ id: 'weak', nodeType: 'resource', data: {} });
    graph.addEdge({ id: 'e1', source: 'start', target: 'strong', type: 'causes', weight: 0.9 });
    graph.addEdge({ id: 'e2', source: 'start', target: 'weak', type: 'causes', weight: 0.3 });

    const results = traverse(graph, {
      start: 'start',
      direction: 'forward',
      edgeTypes: ['causes'],
      minWeight: 0.5,
    });
    const ids = results.map((r) => r.nodeId);
    expect(ids).toContain('strong'); // weight 0.9 >= 0.5
    expect(ids).not.toContain('weak'); // weight 0.3 < 0.5
  });

  it('follows edges without explicit weight when minWeight=0 (default)', () => {
    const graph = new DiagnosticGraph();
    graph.addNode({ id: 'A', nodeType: 'finding', data: {} });
    graph.addNode({ id: 'B', nodeType: 'finding', data: {} });
    graph.addEdge({ id: 'e1', source: 'A', target: 'B', type: 'causes' }); // no weight

    const results = traverse(graph, {
      start: 'A',
      direction: 'forward',
      edgeTypes: ['causes'],
      minWeight: 0,
    });
    const ids = results.map((r) => r.nodeId);
    expect(ids).toContain('B');
  });
});

// ---------------------------------------------------------------------------
// traverse — cycle safety
// ---------------------------------------------------------------------------

describe('traverse — cycle safety', () => {
  it('handles cyclic graphs without infinite loop', () => {
    const graph = new DiagnosticGraph();
    graph.addNode({ id: 'X', nodeType: 'finding', data: {} });
    graph.addNode({ id: 'Y', nodeType: 'finding', data: {} });
    // X → Y and Y → X (cycle)
    graph.addEdge({ id: 'e1', source: 'X', target: 'Y', type: 'causes', weight: 1.0 });
    graph.addEdge({ id: 'e2', source: 'Y', target: 'X', type: 'causes', weight: 1.0 });

    expect(() => {
      traverse(graph, { start: 'X', direction: 'forward', edgeTypes: ['causes'], maxDepth: 10 });
    }).not.toThrow();

    const results = traverse(graph, {
      start: 'X',
      direction: 'forward',
      edgeTypes: ['causes'],
      maxDepth: 10,
    });
    // Each node appears at most once
    const ids = results.map((r) => r.nodeId);
    expect(ids.filter((id) => id === 'X').length).toBe(1);
    expect(ids.filter((id) => id === 'Y').length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// traverseForChunks
// ---------------------------------------------------------------------------

describe('traverseForChunks', () => {
  it('returns scored chunks for graph-reached nodes', () => {
    const graph = new DiagnosticGraph();
    graph.addNode({
      id: 'Pod:default/app-pod',
      nodeType: 'resource',
      data: { kind: 'Pod', name: 'app-pod', namespace: 'default' },
    });
    graph.addNode({
      id: 'Secret:default/db-secret',
      nodeType: 'resource',
      data: { kind: 'Secret', name: 'db-secret', namespace: 'default' },
    });
    graph.addEdge({
      id: 'e1',
      source: 'Pod:default/app-pod',
      target: 'Secret:default/db-secret',
      type: 'references-secret',
      weight: 1.0,
    });

    const chunks: IndexedChunk[] = [
      makeChunk('chunk-pod', ['app-pod', 'default']),
      makeChunk('chunk-secret', ['db-secret', 'default']),
      makeChunk('chunk-unrelated', ['other-pod']),
    ];

    const results = traverseForChunks(
      graph,
      {
        start: 'Pod:default/app-pod',
        direction: 'both',
        edgeTypes: ['references-secret'],
        maxDepth: 2,
      },
      chunks,
    );

    const chunkIds = results.map((r) => r.chunk.id);
    expect(chunkIds).toContain('chunk-pod'); // start node
    expect(chunkIds).toContain('chunk-secret'); // neighbor
    expect(chunkIds).not.toContain('chunk-unrelated');
  });

  it('scores start-node chunks 1.0 and depth-1 chunks ~0.7', () => {
    const graph = new DiagnosticGraph();
    graph.addNode({
      id: 'Pod:default/app-pod',
      nodeType: 'resource',
      data: { kind: 'Pod', name: 'app-pod', namespace: 'default' },
    });
    graph.addNode({
      id: 'Secret:default/db-secret',
      nodeType: 'resource',
      data: { kind: 'Secret', name: 'db-secret', namespace: 'default' },
    });
    graph.addEdge({
      id: 'e1',
      source: 'Pod:default/app-pod',
      target: 'Secret:default/db-secret',
      type: 'references-secret',
      weight: 1.0,
    });

    const chunks: IndexedChunk[] = [
      makeChunk('chunk-pod', ['app-pod']),
      makeChunk('chunk-secret', ['db-secret']),
    ];

    const results = traverseForChunks(
      graph,
      { start: 'Pod:default/app-pod', direction: 'forward', edgeTypes: ['references-secret'] },
      chunks,
    );

    const podResult = results.find((r) => r.chunk.id === 'chunk-pod');
    const secretResult = results.find((r) => r.chunk.id === 'chunk-secret');
    expect(podResult?.score).toBe(1.0); // depth 0
    expect(secretResult?.score).toBeCloseTo(0.7); // depth 1, weight 1.0, decay 0.7
  });

  it('matches chunks via metadata-based node ID', () => {
    const graph = new DiagnosticGraph();
    graph.addNode({
      id: 'Pod:default/app-pod',
      nodeType: 'resource',
      data: { kind: 'Pod', name: 'app-pod', namespace: 'default' },
    });

    const chunk: IndexedChunk = {
      id: 'chunk-with-metadata',
      artifactId: 'cluster-resources/pods.json',
      content: 'pod content',
      startLine: 1,
      endLine: 10,
      summary: 'Pod chunk',
      identifiers: [],
      namespace: 'default',
      artifactCategory: 'kubernetes-resource',
      metadata: { kind: 'Pod', name: 'app-pod', namespace: 'default' },
    };

    const results = traverseForChunks(
      graph,
      { start: 'Pod:default/app-pod', direction: 'forward' },
      [chunk],
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.chunk.id).toBe('chunk-with-metadata');
    expect(results[0]?.score).toBe(1.0);
  });

  it('returns empty array when start node does not exist', () => {
    const graph = new DiagnosticGraph();
    const chunks: IndexedChunk[] = [makeChunk('chunk1', ['pod1'])];
    const results = traverseForChunks(graph, { start: 'nonexistent' }, chunks);
    expect(results).toHaveLength(0);
  });

  it('returns empty array when chunkIndex is empty', () => {
    const graph = new DiagnosticGraph();
    graph.addNode({ id: 'A', nodeType: 'finding', data: {} });
    const results = traverseForChunks(graph, { start: 'A', direction: 'forward' }, []);
    expect(results).toHaveLength(0);
  });

  it('does not return duplicate chunks when a chunk matches multiple nodes', () => {
    const graph = new DiagnosticGraph();
    graph.addNode({
      id: 'Pod:default/app-pod',
      nodeType: 'resource',
      data: { kind: 'Pod', name: 'app-pod', namespace: 'default' },
    });
    graph.addNode({
      id: 'Secret:default/db-secret',
      nodeType: 'resource',
      data: { kind: 'Secret', name: 'db-secret', namespace: 'default' },
    });
    graph.addEdge({
      id: 'e1',
      source: 'Pod:default/app-pod',
      target: 'Secret:default/db-secret',
      type: 'references-secret',
      weight: 1.0,
    });

    // Chunk has identifiers for BOTH nodes
    const ambiguousChunk = makeChunk('multi-chunk', ['app-pod', 'db-secret']);

    const results = traverseForChunks(
      graph,
      { start: 'Pod:default/app-pod', direction: 'both', edgeTypes: ['references-secret'] },
      [ambiguousChunk],
    );

    // Should appear only once, with the highest score (depth 0 = 1.0)
    expect(results.filter((r) => r.chunk.id === 'multi-chunk')).toHaveLength(1);
    expect(results.find((r) => r.chunk.id === 'multi-chunk')?.score).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// traverse replaces getNeighborhoodWithDepth BFS — equivalence tests
// ---------------------------------------------------------------------------

describe('traverse replaces getNeighborhoodWithDepth BFS', () => {
  it('covers the same neighborhood as undirected BFS for structural edges', () => {
    const graph = new DiagnosticGraph();
    graph.addNode({
      id: 'Pod:default/app-pod',
      nodeType: 'resource',
      data: { kind: 'Pod', name: 'app-pod', namespace: 'default' },
    });
    graph.addNode({
      id: 'Secret:default/db-secret',
      nodeType: 'resource',
      data: { kind: 'Secret', name: 'db-secret', namespace: 'default' },
    });
    graph.addNode({
      id: 'Deployment:default/app-deploy',
      nodeType: 'resource',
      data: { kind: 'Deployment', name: 'app-deploy', namespace: 'default' },
    });
    graph.addEdge({
      id: 'e1',
      source: 'Pod:default/app-pod',
      target: 'Secret:default/db-secret',
      type: 'references-secret',
      weight: 1.0,
    });
    graph.addEdge({
      id: 'e2',
      source: 'Pod:default/app-pod',
      target: 'Deployment:default/app-deploy',
      type: 'owner-reference',
      weight: 1.0,
    });

    const results = traverse(graph, {
      start: 'Pod:default/app-pod',
      direction: 'both',
      edgeTypes: [
        'owner-reference',
        'references-secret',
        'references-configmap',
        'references-pvc',
        'event-target',
      ],
      maxDepth: 2,
    });

    const ids = results.map((r) => r.nodeId);
    expect(ids).toContain('Pod:default/app-pod');
    expect(ids).toContain('Secret:default/db-secret');
    expect(ids).toContain('Deployment:default/app-deploy');
  });

  it('depth-0=1.0, depth-1=0.7, depth-2≈0.49 with unit-weight edges', () => {
    const graph = new DiagnosticGraph();
    graph.addNode({ id: 'A', nodeType: 'resource', data: { name: 'a' } });
    graph.addNode({ id: 'B', nodeType: 'resource', data: { name: 'b' } });
    graph.addNode({ id: 'C', nodeType: 'resource', data: { name: 'c' } });
    graph.addEdge({ id: 'e1', source: 'A', target: 'B', type: 'references-secret', weight: 1.0 });
    graph.addEdge({ id: 'e2', source: 'B', target: 'C', type: 'references-secret', weight: 1.0 });

    const results = traverse(graph, {
      start: 'A',
      direction: 'forward',
      edgeTypes: ['references-secret'],
      maxDepth: 2,
    });

    const byId = new Map(results.map((r) => [r.nodeId, r]));
    expect(byId.get('A')?.score).toBe(1.0);
    expect(byId.get('B')?.score).toBeCloseTo(0.7);
    expect(byId.get('C')?.score).toBeCloseTo(0.49);
  });
});

// ---------------------------------------------------------------------------
// getRelatedChunks with DiagnosticGraph input (wired traversal backend)
// ---------------------------------------------------------------------------

describe('getRelatedChunks — DiagnosticGraph input uses traversal engine', () => {
  it('returns chunks for Pod seed via DiagnosticGraph traversal', () => {
    // Build DiagnosticGraph with pod→secret edge
    const dg = new DiagnosticGraph();
    dg.addNode({ id: 'Pod:default/app-pod', nodeType: 'resource', data: { kind: 'Pod', name: 'app-pod', namespace: 'default' } });
    dg.addNode({ id: 'Secret:default/db-secret', nodeType: 'resource', data: { kind: 'Secret', name: 'db-secret', namespace: 'default' } });
    dg.addEdge({ id: 'e1', source: 'Pod:default/app-pod', target: 'Secret:default/db-secret', type: 'references-secret', weight: 1.0 });

    const chunkIndex: IndexedChunk[] = [
      makeChunk('chunk-pod', ['app-pod', 'default']),
      makeChunk('chunk-secret', ['db-secret', 'default']),
      makeChunk('chunk-unrelated', ['other-pod']),
    ];

    const seed = {
      id: 'seed:pod:0',
      hypothesis: 'Pod app-pod is crashing',
      source: 'pod:default/app-pod',
      category: 'kubernetes' as const,
      priority: 90,
    };

    const result = getRelatedChunks(dg, seed, chunkIndex);
    const ids = result.map((c) => c.chunk.id);
    expect(ids).toContain('chunk-pod');
    expect(ids).toContain('chunk-secret'); // reachable via references-secret
    expect(ids).not.toContain('chunk-unrelated');
  });

  it('DiagnosticGraph result is equivalent to ResourceRelationshipGraph result', () => {
    const pod = makePod('app-pod', 'default');
    // Add secret to pod spec so buildDiagnosticGraph creates references-secret edge
    (pod.spec as Record<string, unknown>)['volumes'] = [
      { name: 'secret-vol', secret: { secretName: 'db-secret' } },
    ];

    const dg = buildDiagnosticGraph([pod], []);

    const chunkIndex: IndexedChunk[] = [
      makeChunk('chunk-pod', ['app-pod', 'default']),
      makeChunk('chunk-secret', ['db-secret', 'default']),
    ];

    const seed = {
      id: 'seed:pod:0',
      hypothesis: 'Pod app-pod is crashing',
      source: 'pod:default/app-pod',
      category: 'kubernetes' as const,
      priority: 90,
    };

    const resultDG = getRelatedChunks(dg, seed, chunkIndex);
    const resultRRG = getRelatedChunks(asResourceRelationshipGraph(dg), seed, chunkIndex);

    // Both should find the same chunks
    const idsDG = new Set(resultDG.map((r) => r.chunk.id));
    const idsRRG = new Set(resultRRG.map((r) => r.chunk.id));
    for (const id of idsRRG) {
      expect(idsDG.has(id)).toBe(true);
    }
  });

  it('ResourceRelationshipGraph input still works (backward compat)', () => {
    const pod = makePod('app-pod');
    (pod.spec as Record<string, unknown>)['volumes'] = [
      { name: 'secret-vol', secret: { secretName: 'db-secret' } },
    ];
    const rrg = buildResourceGraph([pod], []);

    const chunkIndex: IndexedChunk[] = [
      makeChunk('chunk-pod', ['app-pod', 'default']),
      makeChunk('chunk-secret', ['db-secret', 'default']),
    ];

    const seed = {
      id: 'seed:pod:0',
      hypothesis: 'Pod app-pod is crashing',
      source: 'pod:default/app-pod',
      category: 'kubernetes' as const,
      priority: 90,
    };

    const result = getRelatedChunks(rrg, seed, chunkIndex);
    const ids = result.map((r) => r.chunk.id);
    expect(ids).toContain('chunk-pod');
    expect(ids).toContain('chunk-secret');
  });

  it('DiagnosticGraph traversal also follows label-selector and service-selector edges', () => {
    // These new edge types are not in ResourceRelationshipGraph — the traversal engine
    // should follow them when they are present in the DiagnosticGraph
    const graph = new DiagnosticGraph();
    graph.addNode({ id: 'Deployment:default/myapp', nodeType: 'resource', data: { kind: 'Deployment', name: 'myapp', namespace: 'default' } });
    graph.addNode({ id: 'Pod:default/myapp-pod', nodeType: 'resource', data: { kind: 'Pod', name: 'myapp-pod', namespace: 'default' } });
    graph.addNode({ id: 'Service:default/myapp-svc', nodeType: 'resource', data: { kind: 'Service', name: 'myapp-svc', namespace: 'default' } });
    graph.addEdge({ id: 'e1', source: 'Deployment:default/myapp', target: 'Pod:default/myapp-pod', type: 'label-selector', weight: 1.0 });
    graph.addEdge({ id: 'e2', source: 'Service:default/myapp-svc', target: 'Pod:default/myapp-pod', type: 'service-selector', weight: 1.0 });

    const chunkIndex: IndexedChunk[] = [
      makeChunk('chunk-deploy', ['myapp']),
      makeChunk('chunk-pod', ['myapp-pod']),
      makeChunk('chunk-svc', ['myapp-svc']),
    ];

    const seed = {
      id: 'seed:pod:0',
      hypothesis: 'Pod myapp-pod is failing',
      source: 'pod:default/myapp-pod',
      category: 'kubernetes' as const,
      priority: 90,
    };

    const result = getRelatedChunks(graph, seed, chunkIndex);
    const ids = result.map((r) => r.chunk.id);
    // The pod itself + its label-selector parent (Deployment) + service-selector parent (Service)
    expect(ids).toContain('chunk-pod');
    expect(ids).toContain('chunk-deploy'); // via label-selector
    expect(ids).toContain('chunk-svc'); // via service-selector
  });
});
