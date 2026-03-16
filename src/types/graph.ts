import type { Finding } from './finding.js';

export type GraphNodeType = 'finding' | 'evidence' | 'artifact' | 'hypothesis' | 'symptom';

export type GraphEdgeType = 'supports' | 'contradicts' | 'causes' | 'correlates' | 'derived-from';

export interface GraphNode<T> {
  id: string;
  type: GraphNodeType;
  data: T;
  metadata?: Record<string, unknown>;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: GraphEdgeType;
  weight?: number;
  note?: string;
}

export interface InvestigationGraph {
  nodes: Map<string, GraphNode<unknown>>;
  edges: GraphEdge[];
}

export interface FindingTreeNode {
  finding: Finding;
  children: FindingTreeNode[];
  parent?: string;
}
