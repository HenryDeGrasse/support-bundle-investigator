import type { GraphNode, GraphEdge, GraphEdgeType } from '../types/index.js';

// ---------------------------------------------------------------------------
// Serialized form used by toJSON / fromJSON
// ---------------------------------------------------------------------------

export interface SerializedGraph {
  nodes: Array<GraphNode<unknown>>;
  edges: GraphEdge[];
}

// ---------------------------------------------------------------------------
// InvestigationGraphImpl
// ---------------------------------------------------------------------------

/**
 * Mutable, in-memory directed graph that tracks investigation nodes
 * (findings, evidence, artifacts, hypotheses, symptoms) and their
 * typed relationships.
 */
export class InvestigationGraphImpl {
  private readonly _nodes = new Map<string, GraphNode<unknown>>();
  private readonly _edges: GraphEdge[] = [];

  // -------------------------------------------------------------------------
  // Mutation
  // -------------------------------------------------------------------------

  /** Add (or overwrite) a node. */
  addNode(node: GraphNode<unknown>): void {
    this._nodes.set(node.id, node);
  }

  /** Add a directed edge. */
  addEdge(edge: GraphEdge): void {
    this._edges.push(edge);
  }

  // -------------------------------------------------------------------------
  // Lookup
  // -------------------------------------------------------------------------

  /** Retrieve a node by id, or `undefined` if absent. */
  getNode(id: string): GraphNode<unknown> | undefined {
    return this._nodes.get(id);
  }

  /** All nodes in the graph. */
  get nodes(): Map<string, GraphNode<unknown>> {
    return this._nodes;
  }

  /** All edges in the graph. */
  get edges(): ReadonlyArray<GraphEdge> {
    return this._edges;
  }

  // -------------------------------------------------------------------------
  // Edge queries
  // -------------------------------------------------------------------------

  /** Returns outgoing edges from `nodeId`. */
  getEdgesFrom(nodeId: string): GraphEdge[] {
    return this._edges.filter((e) => e.source === nodeId);
  }

  /** Returns incoming edges to `nodeId`. */
  getEdgesTo(nodeId: string): GraphEdge[] {
    return this._edges.filter((e) => e.target === nodeId);
  }

  // -------------------------------------------------------------------------
  // Neighbour queries
  // -------------------------------------------------------------------------

  /**
   * Returns nodes reachable via outgoing edges from `nodeId`.
   * Unknown target ids are silently ignored.
   */
  getNeighbors(nodeId: string): GraphNode<unknown>[] {
    return this.getEdgesFrom(nodeId)
      .map((e) => this._nodes.get(e.target))
      .filter((n): n is GraphNode<unknown> => n !== undefined);
  }

  // -------------------------------------------------------------------------
  // Semantic queries
  // -------------------------------------------------------------------------

  /**
   * Returns all nodes that have a `supports` edge pointing **to** `nodeId`
   * (i.e. sources of incoming 'supports' edges).
   */
  getSupportingEvidence(nodeId: string): GraphNode<unknown>[] {
    return this._getSourcesByEdgeType(nodeId, 'supports');
  }

  /**
   * Returns all nodes that have a `contradicts` edge pointing **to** `nodeId`
   * (i.e. sources of incoming 'contradicts' edges).
   */
  getContradictions(nodeId: string): GraphNode<unknown>[] {
    return this._getSourcesByEdgeType(nodeId, 'contradicts');
  }

  private _getSourcesByEdgeType(nodeId: string, type: GraphEdgeType): GraphNode<unknown>[] {
    return this._edges
      .filter((e) => e.target === nodeId && e.type === type)
      .map((e) => this._nodes.get(e.source))
      .filter((n): n is GraphNode<unknown> => n !== undefined);
  }

  // -------------------------------------------------------------------------
  // Traversal
  // -------------------------------------------------------------------------

  /**
   * BFS to find the shortest directed path from `from` to `to`.
   *
   * Returns an ordered array of node ids, or `null` if no path exists.
   */
  findPath(from: string, to: string): string[] | null {
    if (from === to) return [from];

    const visited = new Set<string>([from]);
    const queue: Array<{ id: string; path: string[] }> = [{ id: from, path: [from] }];

    while (queue.length > 0) {
      const item = queue.shift()!;

      for (const edge of this.getEdgesFrom(item.id)) {
        if (visited.has(edge.target)) continue;

        const newPath = [...item.path, edge.target];
        if (edge.target === to) return newPath;

        visited.add(edge.target);
        queue.push({ id: edge.target, path: newPath });
      }
    }

    return null;
  }

  /**
   * Returns the connected component (treating edges as undirected) that
   * contains `nodeId` as a new `InvestigationGraphImpl` instance.
   */
  getSubgraph(nodeId: string): InvestigationGraphImpl {
    const visited = new Set<string>();
    const queue: string[] = [nodeId];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);

      for (const edge of this._edges) {
        if (edge.source === current && !visited.has(edge.target)) {
          queue.push(edge.target);
        }
        if (edge.target === current && !visited.has(edge.source)) {
          queue.push(edge.source);
        }
      }
    }

    const sub = new InvestigationGraphImpl();
    for (const id of visited) {
      const node = this._nodes.get(id);
      if (node) sub.addNode(node);
    }
    for (const edge of this._edges) {
      if (visited.has(edge.source) && visited.has(edge.target)) {
        sub.addEdge(edge);
      }
    }
    return sub;
  }

  // -------------------------------------------------------------------------
  // Serialization
  // -------------------------------------------------------------------------

  /** Serializes the graph to a plain object suitable for JSON.stringify. */
  toJSON(): SerializedGraph {
    return {
      nodes: Array.from(this._nodes.values()),
      edges: [...this._edges],
    };
  }

  /** Deserializes a graph from a plain {@link SerializedGraph} object. */
  static fromJSON(data: SerializedGraph): InvestigationGraphImpl {
    const graph = new InvestigationGraphImpl();
    for (const node of data.nodes) {
      graph.addNode(node);
    }
    for (const edge of data.edges) {
      graph.addEdge(edge);
    }
    return graph;
  }
}
