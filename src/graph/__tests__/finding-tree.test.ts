import { describe, it, expect } from 'vitest';
import {
  buildFindingTree,
  traverseDFS,
  traverseBFS,
  getRootCauses,
  getEvidenceLeaves,
  getAncestors,
  getDescendants,
  findingTreeToJSON,
  toJSON,
} from '../finding-tree.js';
import type { Finding, GraphEdge, FindingTreeNode } from '../../types/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFinding(id: string, title = `Finding ${id}`): Finding {
  return {
    id,
    title,
    severity: 'high',
    confidence: 0.8,
    affectedComponents: ['test'],
    reasoningSummary: 'test summary',
    evidence: [],
    contradictionsChecked: [],
    recommendedAction: 'none',
    missingEvidence: [],
  };
}

function makeCausesEdge(source: string, target: string): GraphEdge {
  return { id: `${source}->${target}`, source, target, type: 'causes' };
}

// ---------------------------------------------------------------------------
// buildFindingTree
// ---------------------------------------------------------------------------

describe('buildFindingTree', () => {
  it('creates tree nodes for all provided findings', () => {
    const findings = [makeFinding('f1'), makeFinding('f2'), makeFinding('f3')];
    const tree = buildFindingTree(findings, []);
    expect(tree).toHaveLength(3);
    expect(tree.map((n) => n.finding.id)).toEqual(expect.arrayContaining(['f1', 'f2', 'f3']));
  });

  it("wires parent-child relationships via 'causes' edges (source=parent, target=child)", () => {
    const findings = [makeFinding('root'), makeFinding('child1'), makeFinding('child2')];
    const edges = [makeCausesEdge('root', 'child1'), makeCausesEdge('root', 'child2')];

    const tree = buildFindingTree(findings, edges);
    const root = tree.find((n) => n.finding.id === 'root')!;

    expect(root.children).toHaveLength(2);
    expect(root.children.map((c) => c.finding.id)).toEqual(
      expect.arrayContaining(['child1', 'child2']),
    );
  });

  it('sets parent id on child nodes', () => {
    const findings = [makeFinding('parent'), makeFinding('child')];
    const tree = buildFindingTree(findings, [makeCausesEdge('parent', 'child')]);

    const child = tree.find((n) => n.finding.id === 'child')!;
    expect(child.parent).toBe('parent');
  });

  it('ignores non-causes edges', () => {
    const findings = [makeFinding('a'), makeFinding('b')];
    const edges: GraphEdge[] = [{ id: 'e1', source: 'a', target: 'b', type: 'supports' }];

    const tree = buildFindingTree(findings, edges);
    const nodeA = tree.find((n) => n.finding.id === 'a')!;
    expect(nodeA.children).toHaveLength(0);
  });

  it('handles an empty findings array', () => {
    const tree = buildFindingTree([], []);
    expect(tree).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// traverseDFS
// ---------------------------------------------------------------------------

describe('traverseDFS', () => {
  function buildSimpleTree(): FindingTreeNode {
    const root: FindingTreeNode = { finding: makeFinding('root'), children: [] };
    const c1: FindingTreeNode = { finding: makeFinding('c1'), children: [], parent: 'root' };
    const c2: FindingTreeNode = { finding: makeFinding('c2'), children: [], parent: 'root' };
    const gc1: FindingTreeNode = { finding: makeFinding('gc1'), children: [], parent: 'c1' };
    c1.children.push(gc1);
    root.children.push(c1, c2);
    return root;
  }

  it('visits nodes in depth-first order (pre-order)', () => {
    const root = buildSimpleTree();
    const visited: string[] = [];
    traverseDFS(root, (n) => visited.push(n.finding.id));
    // Pre-order DFS: root → c1 → gc1 → c2
    expect(visited).toEqual(['root', 'c1', 'gc1', 'c2']);
  });

  it('visits a single leaf node', () => {
    const leaf: FindingTreeNode = { finding: makeFinding('leaf'), children: [] };
    const visited: string[] = [];
    traverseDFS(leaf, (n) => visited.push(n.finding.id));
    expect(visited).toEqual(['leaf']);
  });
});

// ---------------------------------------------------------------------------
// traverseBFS
// ---------------------------------------------------------------------------

describe('traverseBFS', () => {
  function buildSimpleTree(): FindingTreeNode {
    const root: FindingTreeNode = { finding: makeFinding('root'), children: [] };
    const c1: FindingTreeNode = { finding: makeFinding('c1'), children: [], parent: 'root' };
    const c2: FindingTreeNode = { finding: makeFinding('c2'), children: [], parent: 'root' };
    const gc1: FindingTreeNode = { finding: makeFinding('gc1'), children: [], parent: 'c1' };
    c1.children.push(gc1);
    root.children.push(c1, c2);
    return root;
  }

  it('visits nodes in breadth-first order', () => {
    const root = buildSimpleTree();
    const visited: string[] = [];
    traverseBFS(root, (n) => visited.push(n.finding.id));
    // BFS order: root → c1, c2 → gc1
    expect(visited).toEqual(['root', 'c1', 'c2', 'gc1']);
  });

  it('visits a single leaf node', () => {
    const leaf: FindingTreeNode = { finding: makeFinding('leaf'), children: [] };
    const visited: string[] = [];
    traverseBFS(leaf, (n) => visited.push(n.finding.id));
    expect(visited).toEqual(['leaf']);
  });
});

// ---------------------------------------------------------------------------
// getRootCauses
// ---------------------------------------------------------------------------

describe('getRootCauses', () => {
  it('returns top-level nodes that have no parent', () => {
    const findings = [makeFinding('root1'), makeFinding('root2'), makeFinding('child')];
    const edges = [makeCausesEdge('root1', 'child')];
    const tree = buildFindingTree(findings, edges);

    const roots = getRootCauses(tree);
    expect(roots).toHaveLength(2);
    expect(roots.map((n) => n.finding.id)).toEqual(expect.arrayContaining(['root1', 'root2']));
  });

  it('returns all nodes when there are no edges (everything is a root)', () => {
    const findings = [makeFinding('a'), makeFinding('b')];
    const tree = buildFindingTree(findings, []);
    expect(getRootCauses(tree)).toHaveLength(2);
  });

  it('returns empty array for empty tree', () => {
    expect(getRootCauses([])).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getEvidenceLeaves
// ---------------------------------------------------------------------------

describe('getEvidenceLeaves', () => {
  it('returns leaf nodes (nodes with no children)', () => {
    const root: FindingTreeNode = { finding: makeFinding('root'), children: [] };
    const c1: FindingTreeNode = { finding: makeFinding('c1'), children: [], parent: 'root' };
    const c2: FindingTreeNode = { finding: makeFinding('c2'), children: [], parent: 'root' };
    const gc1: FindingTreeNode = { finding: makeFinding('gc1'), children: [], parent: 'c1' };
    c1.children.push(gc1);
    root.children.push(c1, c2);

    const leaves = getEvidenceLeaves(root);
    expect(leaves).toHaveLength(2);
    expect(leaves.map((n) => n.finding.id)).toEqual(expect.arrayContaining(['gc1', 'c2']));
  });

  it('returns the node itself when it is already a leaf', () => {
    const leaf: FindingTreeNode = { finding: makeFinding('leaf'), children: [] };
    expect(getEvidenceLeaves(leaf)).toEqual([leaf]);
  });
});

// ---------------------------------------------------------------------------
// getAncestors
// ---------------------------------------------------------------------------

describe('getAncestors', () => {
  it('returns all ancestors of a deeply nested finding', () => {
    const findings = [makeFinding('gp'), makeFinding('p'), makeFinding('child')];
    const edges = [makeCausesEdge('gp', 'p'), makeCausesEdge('p', 'child')];
    const tree = buildFindingTree(findings, edges);
    const all = tree; // flat list with parent references set

    const child = tree.find((n) => n.finding.id === 'child')!;
    const ancestors = getAncestors(child, all);

    expect(ancestors).toHaveLength(2);
    expect(ancestors.map((n) => n.finding.id)).toEqual(expect.arrayContaining(['gp', 'p']));
  });

  it('returns empty array for a root node (no parent)', () => {
    const findings = [makeFinding('root')];
    const tree = buildFindingTree(findings, []);
    const root = tree[0]!;
    expect(getAncestors(root, tree)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getDescendants
// ---------------------------------------------------------------------------

describe('getDescendants', () => {
  it('returns all descendants of a finding', () => {
    const root: FindingTreeNode = { finding: makeFinding('root'), children: [] };
    const c1: FindingTreeNode = { finding: makeFinding('c1'), children: [], parent: 'root' };
    const c2: FindingTreeNode = { finding: makeFinding('c2'), children: [], parent: 'root' };
    const gc1: FindingTreeNode = { finding: makeFinding('gc1'), children: [], parent: 'c1' };
    c1.children.push(gc1);
    root.children.push(c1, c2);

    const descendants = getDescendants(root);
    expect(descendants).toHaveLength(3);
    expect(descendants.map((n) => n.finding.id)).toEqual(
      expect.arrayContaining(['c1', 'c2', 'gc1']),
    );
  });

  it('returns empty array for a leaf node', () => {
    const leaf: FindingTreeNode = { finding: makeFinding('leaf'), children: [] };
    expect(getDescendants(leaf)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// findingTreeToJSON
// ---------------------------------------------------------------------------

describe('findingTreeToJSON', () => {
  it('serializes a tree for trace output without circular references', () => {
    const findings = [makeFinding('root'), makeFinding('child')];
    const tree = buildFindingTree(findings, [makeCausesEdge('root', 'child')]);

    const json = findingTreeToJSON(tree);
    // Should be serializable without throwing
    expect(() => JSON.stringify(json)).not.toThrow();

    const parsed = JSON.parse(JSON.stringify(json)) as unknown[];
    expect(parsed).toHaveLength(2);
  });

  it('preserves finding ids and parent references in serialized form', () => {
    const findings = [makeFinding('a'), makeFinding('b')];
    const tree = buildFindingTree(findings, [makeCausesEdge('a', 'b')]);

    const json = findingTreeToJSON(tree) as Array<{
      finding: { id: string };
      parent?: string;
      children: unknown[];
    }>;

    const aJson = json.find((n) => n.finding.id === 'a')!;
    const bJson = json.find((n) => n.finding.id === 'b')!;

    expect(aJson.children).toHaveLength(1);
    expect(bJson.parent).toBe('a');
  });

  it('exports toJSON as an alias of findingTreeToJSON', () => {
    const findings = [makeFinding('root'), makeFinding('child')];
    const tree = buildFindingTree(findings, [makeCausesEdge('root', 'child')]);

    expect(toJSON(tree)).toEqual(findingTreeToJSON(tree));
  });
});

// ---------------------------------------------------------------------------
// Investigator-pattern causes edges (real investigator output simulation)
// ---------------------------------------------------------------------------

describe('buildFindingTree — investigator-pattern causes edges', () => {
  // Simulate the finding IDs and edge patterns that real investigators produce.
  // Investigators emit edges with type 'causes' where source = root-cause
  // finding id and target = symptom finding id.

  it('builds the canonical causal chain: Missing Secret → FailedMount → CrashLoopBackOff → Unhealthy Workload', () => {
    const missingSecret = makeFinding(
      'finding:hypothesis:missing-secret:1',
      'Missing Secret: app-secret not found',
    );
    const failedMount = makeFinding(
      'finding:k8s:failedmount:pod/default/api-6f8d',
      'FailedMount: volume failed to mount',
    );
    const crashLoop = makeFinding(
      'finding:k8s:crashloop:pod/default/api-6f8d',
      'CrashLoopBackOff: container restarting',
    );
    const unhealthyWorkload = makeFinding(
      'finding:k8s:workload:deployment/default/api',
      'Unhealthy Workload: deployment has unavailable replicas',
    );

    const findings = [missingSecret, failedMount, crashLoop, unhealthyWorkload];
    const edges: GraphEdge[] = [
      makeCausesEdge(missingSecret.id, failedMount.id),
      makeCausesEdge(failedMount.id, crashLoop.id),
      makeCausesEdge(crashLoop.id, unhealthyWorkload.id),
    ];

    const tree = buildFindingTree(findings, edges);

    // getRootCauses identifies the top of the chain — Missing Secret has no parent
    const roots = getRootCauses(tree);
    expect(roots).toHaveLength(1);
    expect(roots[0]!.finding.id).toBe(missingSecret.id);

    // The root has exactly one child: FailedMount
    const root = roots[0]!;
    expect(root.children).toHaveLength(1);
    expect(root.children[0]!.finding.id).toBe(failedMount.id);

    // FailedMount → CrashLoopBackOff
    expect(root.children[0]!.children[0]!.finding.id).toBe(crashLoop.id);

    // CrashLoopBackOff → Unhealthy Workload (leaf)
    expect(root.children[0]!.children[0]!.children[0]!.finding.id).toBe(unhealthyWorkload.id);
    expect(root.children[0]!.children[0]!.children[0]!.children).toHaveLength(0);
  });

  it('getRootCauses returns only the root-cause node (no parent) from a causal chain', () => {
    const root = makeFinding('finding:hypothesis:missing-secret:1', 'Missing Secret');
    const mid = makeFinding('finding:k8s:crashloop:pod/ns/p', 'CrashLoopBackOff');
    const leaf = makeFinding('finding:k8s:workload:dep/ns/d', 'Unhealthy Workload');

    const tree = buildFindingTree([root, mid, leaf], [
      makeCausesEdge(root.id, mid.id),
      makeCausesEdge(mid.id, leaf.id),
    ]);

    const roots = getRootCauses(tree);
    expect(roots).toHaveLength(1);
    expect(roots[0]!.finding.id).toBe(root.id);
    // The root has no parent set
    expect(roots[0]!.parent).toBeUndefined();
  });

  it('supports multiple independent causal chains in the same finding set', () => {
    // Chain A: dns-failure → crashloop-a
    // Chain B: missing-secret → crashloop-b
    const dnsFailure = makeFinding('finding:hypothesis:dns-failure:1', 'DNS Failure');
    const crashA = makeFinding('finding:k8s:crashloop:pod/ns/a', 'CrashLoopBackOff pod A');
    const missingSecret = makeFinding('finding:hypothesis:missing-secret:1', 'Missing Secret');
    const crashB = makeFinding('finding:k8s:crashloop:pod/ns/b', 'CrashLoopBackOff pod B');

    const tree = buildFindingTree([dnsFailure, crashA, missingSecret, crashB], [
      makeCausesEdge(dnsFailure.id, crashA.id),
      makeCausesEdge(missingSecret.id, crashB.id),
    ]);

    const roots = getRootCauses(tree);
    expect(roots).toHaveLength(2);
    const rootIds = roots.map((r) => r.finding.id);
    expect(rootIds).toContain(dnsFailure.id);
    expect(rootIds).toContain(missingSecret.id);
  });

  it('DFS pre-order traversal of the causal chain visits most-fundamental cause first', () => {
    const missingSecret = makeFinding('finding:hypothesis:missing-secret:1', 'Missing Secret');
    const failedMount = makeFinding('finding:k8s:failedmount:pod/ns/p', 'FailedMount');
    const crashLoop = makeFinding('finding:k8s:crashloop:pod/ns/p', 'CrashLoopBackOff');

    const tree = buildFindingTree([missingSecret, failedMount, crashLoop], [
      makeCausesEdge(missingSecret.id, failedMount.id),
      makeCausesEdge(failedMount.id, crashLoop.id),
    ]);

    const roots = getRootCauses(tree);
    const visited: string[] = [];
    for (const root of roots) {
      traverseDFS(root, (n) => visited.push(n.finding.title));
    }

    expect(visited).toEqual(['Missing Secret', 'FailedMount', 'CrashLoopBackOff']);
  });
});
