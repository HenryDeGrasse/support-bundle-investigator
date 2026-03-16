import { describe, it, expect, beforeEach } from 'vitest';
import { InvestigationGraphImpl } from '../investigation-graph.js';
import type { GraphNode, GraphEdge, GraphEdgeType, GraphNodeType } from '../../types/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNode(id: string, type: GraphNodeType = 'finding'): GraphNode<{ value: string }> {
  return { id, type, data: { value: id } };
}

function makeEdge(
  source: string,
  target: string,
  type: GraphEdgeType = 'supports',
  id?: string,
): GraphEdge {
  return { id: id ?? `${source}->${target}`, source, target, type };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('InvestigationGraphImpl', () => {
  let graph: InvestigationGraphImpl;

  beforeEach(() => {
    graph = new InvestigationGraphImpl();
  });

  // -------------------------------------------------------------------------
  // addNode / getNode
  // -------------------------------------------------------------------------

  it('addNode() adds a node and retrieves it by id', () => {
    const node = makeNode('n1');
    graph.addNode(node);
    expect(graph.getNode('n1')).toEqual(node);
  });

  it('getNode() returns undefined for a missing id', () => {
    expect(graph.getNode('does-not-exist')).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // addEdge / getEdgesFrom / getEdgesTo
  // -------------------------------------------------------------------------

  it('addEdge() creates a directed edge between nodes', () => {
    graph.addNode(makeNode('a'));
    graph.addNode(makeNode('b'));
    const edge = makeEdge('a', 'b');
    graph.addEdge(edge);
    expect(graph.getEdgesFrom('a')).toContainEqual(edge);
  });

  it('getEdgesFrom() returns outgoing edges from a node', () => {
    graph.addNode(makeNode('x'));
    graph.addNode(makeNode('y'));
    graph.addNode(makeNode('z'));
    graph.addEdge(makeEdge('x', 'y'));
    graph.addEdge(makeEdge('x', 'z'));
    graph.addEdge(makeEdge('y', 'z'));

    const out = graph.getEdgesFrom('x');
    expect(out).toHaveLength(2);
    expect(out.map((e) => e.target)).toEqual(expect.arrayContaining(['y', 'z']));
  });

  it('getEdgesTo() returns incoming edges to a node', () => {
    graph.addNode(makeNode('x'));
    graph.addNode(makeNode('y'));
    graph.addNode(makeNode('z'));
    graph.addEdge(makeEdge('x', 'z'));
    graph.addEdge(makeEdge('y', 'z'));
    graph.addEdge(makeEdge('x', 'y'));

    const incoming = graph.getEdgesTo('z');
    expect(incoming).toHaveLength(2);
    expect(incoming.map((e) => e.source)).toEqual(expect.arrayContaining(['x', 'y']));
  });

  // -------------------------------------------------------------------------
  // getNeighbors
  // -------------------------------------------------------------------------

  it('getNeighbors() returns connected nodes via outgoing edges', () => {
    graph.addNode(makeNode('a'));
    graph.addNode(makeNode('b'));
    graph.addNode(makeNode('c'));
    graph.addEdge(makeEdge('a', 'b'));
    graph.addEdge(makeEdge('a', 'c'));

    const neighbors = graph.getNeighbors('a');
    expect(neighbors).toHaveLength(2);
    expect(neighbors.map((n) => n.id)).toEqual(expect.arrayContaining(['b', 'c']));
  });

  it('getNeighbors() returns empty array for isolated node', () => {
    graph.addNode(makeNode('alone'));
    expect(graph.getNeighbors('alone')).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // getSupportingEvidence / getContradictions
  // -------------------------------------------------------------------------

  it("getSupportingEvidence() returns nodes connected by 'supports' edges pointing to a node", () => {
    graph.addNode(makeNode('evidence1', 'evidence'));
    graph.addNode(makeNode('evidence2', 'evidence'));
    graph.addNode(makeNode('hypothesis', 'hypothesis'));
    graph.addEdge(makeEdge('evidence1', 'hypothesis', 'supports'));
    graph.addEdge(makeEdge('evidence2', 'hypothesis', 'supports'));

    const supporting = graph.getSupportingEvidence('hypothesis');
    expect(supporting).toHaveLength(2);
    expect(supporting.map((n) => n.id)).toEqual(
      expect.arrayContaining(['evidence1', 'evidence2']),
    );
  });

  it("getContradictions() returns nodes connected by 'contradicts' edges pointing to a node", () => {
    graph.addNode(makeNode('f1'));
    graph.addNode(makeNode('f2'));
    graph.addNode(makeNode('f3'));
    graph.addEdge(makeEdge('f2', 'f1', 'contradicts'));
    graph.addEdge(makeEdge('f3', 'f1', 'contradicts'));
    graph.addEdge(makeEdge('f2', 'f3', 'supports'));

    const contradictions = graph.getContradictions('f1');
    expect(contradictions).toHaveLength(2);
    expect(contradictions.map((n) => n.id)).toEqual(expect.arrayContaining(['f2', 'f3']));
  });

  // -------------------------------------------------------------------------
  // findPath (BFS)
  // -------------------------------------------------------------------------

  it('findPath() finds a path between two directly connected nodes', () => {
    graph.addNode(makeNode('start'));
    graph.addNode(makeNode('end'));
    graph.addEdge(makeEdge('start', 'end'));
    expect(graph.findPath('start', 'end')).toEqual(['start', 'end']);
  });

  it('findPath() finds a multi-hop path', () => {
    graph.addNode(makeNode('a'));
    graph.addNode(makeNode('b'));
    graph.addNode(makeNode('c'));
    graph.addEdge(makeEdge('a', 'b'));
    graph.addEdge(makeEdge('b', 'c'));
    expect(graph.findPath('a', 'c')).toEqual(['a', 'b', 'c']);
  });

  it('findPath() returns null when no path exists', () => {
    graph.addNode(makeNode('a'));
    graph.addNode(makeNode('b'));
    // No edge between a and b
    expect(graph.findPath('a', 'b')).toBeNull();
  });

  it('findPath() returns single-element path when from === to', () => {
    graph.addNode(makeNode('self'));
    expect(graph.findPath('self', 'self')).toEqual(['self']);
  });

  // -------------------------------------------------------------------------
  // getSubgraph
  // -------------------------------------------------------------------------

  it('getSubgraph() returns the connected component containing a node', () => {
    // Component 1: a - b - c
    graph.addNode(makeNode('a'));
    graph.addNode(makeNode('b'));
    graph.addNode(makeNode('c'));
    graph.addEdge(makeEdge('a', 'b'));
    graph.addEdge(makeEdge('b', 'c'));

    // Component 2: x - y (isolated from component 1)
    graph.addNode(makeNode('x'));
    graph.addNode(makeNode('y'));
    graph.addEdge(makeEdge('x', 'y'));

    const sub = graph.getSubgraph('a');
    expect(sub.getNode('a')).toBeDefined();
    expect(sub.getNode('b')).toBeDefined();
    expect(sub.getNode('c')).toBeDefined();
    expect(sub.getNode('x')).toBeUndefined();
    expect(sub.getNode('y')).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // toJSON / fromJSON
  // -------------------------------------------------------------------------

  it('toJSON() serializes graph — nodes and edges are present', () => {
    graph.addNode(makeNode('n1'));
    graph.addNode(makeNode('n2'));
    graph.addEdge(makeEdge('n1', 'n2', 'causes'));

    const json = graph.toJSON();
    expect(json.nodes).toHaveLength(2);
    expect(json.edges).toHaveLength(1);
    expect(json.edges[0]).toMatchObject({ source: 'n1', target: 'n2', type: 'causes' });
  });

  it('fromJSON() deserializes a graph and restores nodes and edges', () => {
    graph.addNode(makeNode('a'));
    graph.addNode(makeNode('b'));
    graph.addEdge(makeEdge('a', 'b', 'correlates'));

    const json = graph.toJSON();
    const restored = InvestigationGraphImpl.fromJSON(json);

    expect(restored.getNode('a')).toEqual(makeNode('a'));
    expect(restored.getNode('b')).toEqual(makeNode('b'));
    expect(restored.getEdgesFrom('a')).toHaveLength(1);
    expect(restored.getEdgesFrom('a')[0]).toMatchObject({ source: 'a', target: 'b' });
  });

  it('toJSON() / fromJSON() round-trip preserves full graph fidelity', () => {
    graph.addNode(makeNode('p', 'hypothesis'));
    graph.addNode(makeNode('q', 'evidence'));
    graph.addEdge(makeEdge('q', 'p', 'supports', 'edge-qp'));

    const restored = InvestigationGraphImpl.fromJSON(graph.toJSON());

    expect(restored.getNode('p')?.type).toBe('hypothesis');
    expect(restored.getNode('q')?.type).toBe('evidence');
    expect(restored.getSupportingEvidence('p')).toHaveLength(1);
  });
});
