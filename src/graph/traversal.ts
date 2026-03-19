import type { DiagnosticEdgeType } from './diagnostic-graph.js';
import { DiagnosticGraph } from './diagnostic-graph.js';
import type { IndexedChunk } from '../ai/chunk-indexer.js';

// ---------------------------------------------------------------------------
// TraversalQuery
// ---------------------------------------------------------------------------

/**
 * Query parameters for the typed, weighted, directional traversal engine.
 */
export interface TraversalQuery {
  /** Starting node ID in the {@link DiagnosticGraph}. */
  start: string;
  /**
   * Edge traversal direction.
   * - `forward`: follow edges source → target
   * - `backward`: follow edges target → source (root-cause search)
   * - `both`: undirected traversal (default)
   */
  direction?: 'forward' | 'backward' | 'both';
  /**
   * Restrict traversal to these edge types only.
   * When omitted, all edge types are followed.
   */
  edgeTypes?: DiagnosticEdgeType[];
  /** Maximum hop depth. Defaults to 5. */
  maxDepth?: number;
  /**
   * Minimum edge weight to follow. Edges with weight < minWeight are skipped.
   * Edges without an explicit weight are treated as weight 1.0.
   * Defaults to 0 (follow all edges regardless of weight).
   */
  minWeight?: number;
  /**
   * Score decay factor applied per hop depth. Defaults to 0.7.
   *
   * Score formula: `score = edge_weight × decay^depth`
   * - depth 0 (start node): `1.0`
   * - depth 1: `edge_weight × decay`
   * - depth 2: `edge_weight × decay²`
   * - depth 3: `edge_weight × decay³`
   *
   * With default decay=0.7 and unit-weight edges:
   * depth-0=1.0, depth-1=0.7, depth-2=0.49, depth-3=0.343
   */
  scoreDecay?: number;
}

// ---------------------------------------------------------------------------
// TraversalResult
// ---------------------------------------------------------------------------

/**
 * A node reached during traversal, with its hop depth and computed score.
 */
export interface TraversalResult {
  /** Node ID in the {@link DiagnosticGraph}. */
  nodeId: string;
  /** Hop distance from the start node. */
  depth: number;
  /**
   * Traversal score at this node.
   * Formula: `edge_weight × scoreDecay^depth`.
   * The start node always has score `1.0`.
   */
  score: number;
}

// ---------------------------------------------------------------------------
// GraphTraversalChunk
// ---------------------------------------------------------------------------

/**
 * A chunk paired with its relevance score from graph traversal.
 * Returned by {@link traverseForChunks}.
 */
export interface GraphTraversalChunk {
  chunk: IndexedChunk;
  score: number;
}

// ---------------------------------------------------------------------------
// traverse
// ---------------------------------------------------------------------------

/**
 * Typed, weighted, directional BFS over a {@link DiagnosticGraph}.
 *
 * Returns all nodes reachable from `query.start` within `query.maxDepth` hops,
 * following only edges that match the `edgeTypes` filter (when provided) and
 * with weight ≥ `minWeight`.
 *
 * Each reached node is assigned a score:
 * - Start node (depth 0): `1.0`
 * - Node at depth d, reached via edge with weight w: `w × scoreDecay^d`
 *
 * When multiple paths reach the same node, the highest computed score wins.
 * Each node appears at most once in the result.
 *
 * **Use cases:**
 * ```typescript
 * // Root-cause search: from symptom, walk backward along causes edges
 * const causes = traverse(graph, {
 *   start: 'finding:crashloop:app-pod',
 *   direction: 'backward',
 *   edgeTypes: ['causes'],
 *   maxDepth: 5,
 * });
 *
 * // Impact analysis: from root cause, walk forward
 * const impact = traverse(graph, {
 *   start: 'finding:missing-secret:app-credentials',
 *   direction: 'forward',
 *   edgeTypes: ['causes'],
 *   maxDepth: 5,
 * });
 *
 * // Evidence gathering: walk all structural + causal edges
 * const evidence = traverse(graph, {
 *   start: 'finding:crashloop:app-pod',
 *   direction: 'both',
 *   edgeTypes: ['supports', 'references-secret', 'event-target'],
 *   maxDepth: 2,
 * });
 * ```
 */
export function traverse(graph: DiagnosticGraph, query: TraversalQuery): TraversalResult[] {
  const {
    start,
    direction = 'both',
    edgeTypes,
    maxDepth = 5,
    minWeight = 0,
    scoreDecay = 0.7,
  } = query;

  if (!graph.getNode(start)) return [];

  // Track the best (highest) score seen for each node to avoid redundant work
  const bestScores = new Map<string, number>();
  bestScores.set(start, 1.0);

  const results: TraversalResult[] = [];

  type QueueEntry = { nodeId: string; depth: number; score: number };
  const queue: QueueEntry[] = [{ nodeId: start, depth: 0, score: 1.0 }];

  while (queue.length > 0) {
    const current = queue.shift()!;

    // Only process this entry if it carries the current best score for this node
    // (a better path may have been found and already processed)
    if (current.score < (bestScores.get(current.nodeId) ?? 0) - Number.EPSILON) continue;

    results.push({ nodeId: current.nodeId, depth: current.depth, score: current.score });

    if (current.depth >= maxDepth) continue;

    // Collect edges to follow, grouped by neighbor to take the best weight
    const bestWeightToNeighbor = new Map<string, number>();

    if (direction === 'forward' || direction === 'both') {
      for (const edge of graph.getEdgesFrom(current.nodeId)) {
        if (edgeTypes !== undefined && !edgeTypes.includes(edge.type)) continue;
        const weight = edge.weight ?? 1.0;
        if (weight < minWeight) continue;
        const existing = bestWeightToNeighbor.get(edge.target);
        if (existing === undefined || weight > existing) {
          bestWeightToNeighbor.set(edge.target, weight);
        }
      }
    }

    if (direction === 'backward' || direction === 'both') {
      for (const edge of graph.getEdgesTo(current.nodeId)) {
        if (edgeTypes !== undefined && !edgeTypes.includes(edge.type)) continue;
        const weight = edge.weight ?? 1.0;
        if (weight < minWeight) continue;
        const existing = bestWeightToNeighbor.get(edge.source);
        if (existing === undefined || weight > existing) {
          bestWeightToNeighbor.set(edge.source, weight);
        }
      }
    }

    for (const [neighborId, weight] of bestWeightToNeighbor) {
      if (!graph.getNode(neighborId)) continue;

      const newDepth = current.depth + 1;
      const newScore = weight * Math.pow(scoreDecay, newDepth);

      const existingBest = bestScores.get(neighborId);
      if (existingBest === undefined || newScore > existingBest) {
        bestScores.set(neighborId, newScore);
        queue.push({ nodeId: neighborId, depth: newDepth, score: newScore });
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Internal helpers for chunk matching
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

// ---------------------------------------------------------------------------
// traverseForChunks
// ---------------------------------------------------------------------------

/**
 * Graph traversal that returns scored {@link IndexedChunk}s corresponding to
 * the nodes reached during traversal.
 *
 * Chunks are matched to graph nodes via two mechanisms:
 * 1. **Metadata node ID**: `{Kind}:{namespace}/{name}` constructed from
 *    `chunk.metadata.kind`, `.namespace`, `.name`.
 * 2. **Identifier name match**: each `chunk.identifier` compared
 *    (case-insensitive) against node names extracted from traversal results.
 *
 * When a chunk matches multiple nodes, the highest traversal score wins.
 * Each chunk appears at most once in the result.
 *
 * @param graph       - The {@link DiagnosticGraph} to traverse.
 * @param query       - Traversal parameters (see {@link TraversalQuery}).
 * @param chunkIndex  - All available chunks to match against.
 * @returns Scored chunks sorted by score descending.
 */
export function traverseForChunks(
  graph: DiagnosticGraph,
  query: TraversalQuery,
  chunkIndex: IndexedChunk[],
): GraphTraversalChunk[] {
  const traversalResults = traverse(graph, query);
  if (traversalResults.length === 0) return [];

  // Build lookup maps for efficient chunk matching
  const nodeIdToScore = new Map<string, number>(
    traversalResults.map((r) => [r.nodeId, r.score]),
  );

  // Build lower-case node name → best traversal score
  const nameToScore = new Map<string, number>();
  for (const { nodeId, score } of traversalResults) {
    const node = graph.getNode(nodeId);
    if (!node) continue;
    const data = node.data as Record<string, unknown>;
    const name = getString(data['name']).toLowerCase();
    if (name) {
      const existing = nameToScore.get(name);
      if (existing === undefined || score > existing) {
        nameToScore.set(name, score);
      }
    }
  }

  const seen = new Set<string>();
  const results: GraphTraversalChunk[] = [];

  for (const chunk of chunkIndex) {
    if (seen.has(chunk.id)) continue;

    let bestScore: number | undefined;

    // 1. Metadata-based node ID matching
    const metadata = isRecord(chunk.metadata) ? chunk.metadata : undefined;
    if (metadata) {
      const metaKind = getString(metadata['kind']);
      const metaName = getString(metadata['name']);
      const metaNamespace = getString(metadata['namespace']);
      if (metaKind && metaName) {
        const ns = metaNamespace || chunk.namespace || 'default';
        const chunkNodeId = `${metaKind}:${ns}/${metaName}`;
        const score = nodeIdToScore.get(chunkNodeId);
        if (score !== undefined && (bestScore === undefined || score > bestScore)) {
          bestScore = score;
        }
      }
    }

    // 2. Identifier-based name matching
    for (const identifier of chunk.identifiers) {
      const score = nameToScore.get(identifier.toLowerCase());
      if (score !== undefined && (bestScore === undefined || score > bestScore)) {
        bestScore = score;
      }
    }

    if (bestScore !== undefined) {
      results.push({ chunk, score: bestScore });
      seen.add(chunk.id);
    }
  }

  // Sort by score descending
  results.sort((a, b) => b.score - a.score);
  return results;
}

// ---------------------------------------------------------------------------
// getRelatedChunksFromDiagnosticGraph
// ---------------------------------------------------------------------------

/**
 * Edge types used when traversing the DiagnosticGraph for chunk retrieval.
 *
 * Includes all structural K8s edge types (matching the ResourceRelationshipGraph
 * BFS) plus the richer graph-only types (label-selector, service-selector)
 * and causal/semantic types that improve recall.
 */
export const RETRIEVAL_EDGE_TYPES: DiagnosticEdgeType[] = [
  // Structural K8s edges
  'owner-reference',
  'references-secret',
  'references-configmap',
  'references-pvc',
  'event-target',
  'label-selector',
  'service-selector',
  // Causal / semantic
  'causes',
  'supports',
  'correlates',
  'derived-from',
];

/**
 * Returns whether a value is a {@link DiagnosticGraph} instance.
 * Used for type discrimination in {@link getRelatedChunks} overloads.
 */
export function isDiagnosticGraph(value: unknown): value is DiagnosticGraph {
  return value instanceof DiagnosticGraph;
}
