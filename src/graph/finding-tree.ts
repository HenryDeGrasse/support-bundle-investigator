import type { Finding, GraphEdge, FindingTreeNode } from '../types/index.js';

// ---------------------------------------------------------------------------
// buildFindingTree
// ---------------------------------------------------------------------------

/**
 * Builds a finding tree structure from a flat list of {@link Finding}s and
 * {@link GraphEdge}s.
 *
 * Only edges with `type === 'causes'` are used to establish parent→child
 * relationships: the *source* node is the parent (cause) and the *target*
 * node is the child (effect / symptom).
 *
 * The returned array contains the constructed node objects keyed from the
 * original flat finding list. Call {@link getRootCauses} to obtain just the
 * top-level root nodes for forest-style traversal/serialization.
 */
export function buildFindingTree(findings: Finding[], edges: GraphEdge[]): FindingTreeNode[] {
  const nodeMap = new Map<string, FindingTreeNode>();

  for (const finding of findings) {
    nodeMap.set(finding.id, { finding, children: [] });
  }

  for (const edge of edges) {
    if (edge.type !== 'causes') continue;

    const parent = nodeMap.get(edge.source);
    const child = nodeMap.get(edge.target);

    if (parent && child) {
      child.parent = edge.source;
      parent.children.push(child);
    }
  }

  return Array.from(nodeMap.values());
}

// ---------------------------------------------------------------------------
// Traversal
// ---------------------------------------------------------------------------

/**
 * Pre-order depth-first traversal starting at `root`.
 *
 * The visitor is called for each node before its children.
 */
export function traverseDFS(
  root: FindingTreeNode,
  visitor: (node: FindingTreeNode) => void,
): void {
  visitor(root);
  for (const child of root.children) {
    traverseDFS(child, visitor);
  }
}

/**
 * Breadth-first traversal starting at `root`.
 *
 * Visits `root`, then all its children left-to-right, then grandchildren, etc.
 */
export function traverseBFS(
  root: FindingTreeNode,
  visitor: (node: FindingTreeNode) => void,
): void {
  const queue: FindingTreeNode[] = [root];

  while (queue.length > 0) {
    const node = queue.shift()!;
    visitor(node);
    queue.push(...node.children);
  }
}

// ---------------------------------------------------------------------------
// Root-cause / leaf helpers
// ---------------------------------------------------------------------------

/**
 * Returns the top-level nodes in a tree forest — those with no parent set.
 */
export function getRootCauses(tree: FindingTreeNode[]): FindingTreeNode[] {
  return tree.filter((n) => n.parent === undefined);
}

/**
 * Returns all leaf nodes (no children) reachable from `node` (including
 * `node` itself when it has no children).
 */
export function getEvidenceLeaves(node: FindingTreeNode): FindingTreeNode[] {
  if (node.children.length === 0) return [node];
  return node.children.flatMap((child) => getEvidenceLeaves(child));
}

// ---------------------------------------------------------------------------
// Ancestor / descendant helpers
// ---------------------------------------------------------------------------

/**
 * Returns all ancestors of `node` in root-first order.
 *
 * Requires the full flat `allNodes` list so that parent ids can be resolved
 * to `FindingTreeNode` references.
 */
export function getAncestors(
  node: FindingTreeNode,
  allNodes: FindingTreeNode[],
): FindingTreeNode[] {
  const lookup = new Map<string, FindingTreeNode>(
    allNodes.map((n) => [n.finding.id, n]),
  );

  const result: FindingTreeNode[] = [];
  let current: FindingTreeNode | undefined = node;

  while (current?.parent) {
    const parent = lookup.get(current.parent);
    if (!parent) break;
    result.unshift(parent); // prepend so result is root-first
    current = parent;
  }

  return result;
}

/**
 * Returns all descendants of `node` (pre-order, children before
 * grandchildren within each branch).
 */
export function getDescendants(node: FindingTreeNode): FindingTreeNode[] {
  const result: FindingTreeNode[] = [];
  for (const child of node.children) {
    result.push(child);
    result.push(...getDescendants(child));
  }
  return result;
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

export interface SerializedFindingTreeNode {
  finding: Finding;
  parent?: string;
  children: SerializedFindingTreeNode[];
}

/**
 * Serializes a flat tree list to a plain JSON-safe structure.
 *
 * Circular references are avoided because parent is stored as an id string,
 * not a reference.
 */
export function findingTreeToJSON(tree: FindingTreeNode[]): SerializedFindingTreeNode[] {
  function nodeToObj(node: FindingTreeNode): SerializedFindingTreeNode {
    return {
      finding: node.finding,
      ...(node.parent !== undefined ? { parent: node.parent } : {}),
      children: node.children.map(nodeToObj),
    };
  }
  return tree.map(nodeToObj);
}

/** Alias matching the step wording for trace serialization helpers. */
export const toJSON = findingTreeToJSON;
