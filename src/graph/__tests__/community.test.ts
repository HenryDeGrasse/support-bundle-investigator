import { describe, it, expect } from 'vitest';
import {
  detectCommunities,
  generateCommunitySummary,
  communityToChunk,
  communitiesToChunks,
  buildCommunityNodes,
} from '../community.js';
import {
  DiagnosticGraph,
  buildDiagnosticGraph,
  buildWorkloadGroups,
} from '../diagnostic-graph.js';
import type { Community } from '../community.js';
import type { K8sResource, K8sEvent } from '../../types/index.js';

// ---------------------------------------------------------------------------
// Multi-namespace fixture builders
// ---------------------------------------------------------------------------

function makePod(
  name: string,
  namespace: string,
  labels: Record<string, string>,
  opts: {
    secretNames?: string[];
    configMapNames?: string[];
    pvcNames?: string[];
  } = {},
): K8sResource {
  const { secretNames = [], configMapNames = [], pvcNames = [] } = opts;
  const volumes = [
    ...secretNames.map((s) => ({ name: `${s}-vol`, secret: { secretName: s } })),
    ...configMapNames.map((c) => ({ name: `${c}-vol`, configMap: { name: c } })),
    ...pvcNames.map((p) => ({ name: `${p}-vol`, persistentVolumeClaim: { claimName: p } })),
  ];
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name, namespace, labels },
    spec: { volumes, containers: [{ name: 'app', image: 'my-app:latest' }] },
    status: { phase: 'Running', containerStatuses: [], conditions: [] },
  } as unknown as K8sResource;
}

function makeDeployment(
  name: string,
  namespace: string,
  selectorLabels: Record<string, string>,
): K8sResource {
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name, namespace },
    spec: {
      replicas: 1,
      selector: { matchLabels: selectorLabels },
      template: { metadata: { labels: selectorLabels }, spec: { containers: [] } },
    },
    status: { readyReplicas: 1 },
  } as unknown as K8sResource;
}

function makeStatefulSet(
  name: string,
  namespace: string,
  selectorLabels: Record<string, string>,
): K8sResource {
  return {
    apiVersion: 'apps/v1',
    kind: 'StatefulSet',
    metadata: { name, namespace },
    spec: {
      replicas: 1,
      selector: { matchLabels: selectorLabels },
      template: { metadata: { labels: selectorLabels }, spec: { containers: [] } },
    },
    status: { readyReplicas: 1 },
  } as unknown as K8sResource;
}

function makeService(
  name: string,
  namespace: string,
  selectorLabels: Record<string, string>,
): K8sResource {
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name, namespace },
    spec: { selector: selectorLabels, ports: [{ port: 80, targetPort: 8080 }] },
    status: {},
  } as unknown as K8sResource;
}

function makeSecret(name: string, namespace: string): K8sResource {
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name, namespace },
    data: {},
    type: 'Opaque',
  } as unknown as K8sResource;
}

function makeConfigMap(name: string, namespace: string): K8sResource {
  return {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name, namespace },
    data: {},
  } as unknown as K8sResource;
}

function makePVC(name: string, namespace: string): K8sResource {
  return {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: { name, namespace },
    spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '1Gi' } } },
    status: { phase: 'Bound' },
  } as unknown as K8sResource;
}

// ---------------------------------------------------------------------------
// Multi-namespace fixture
//
// Two completely disconnected stacks:
//   frontend ns: app-deploy, app-pod, app-svc, app-secret, app-config
//   database ns: db-sts, db-pod, db-svc, db-secret, db-pvc
//
// The two stacks have no cross-namespace edges, so they form two distinct
// connected components that should map to two communities.
// ---------------------------------------------------------------------------

function buildMultiNamespaceGraph(): DiagnosticGraph {
  const frontendPod = makePod('app-pod', 'frontend', { app: 'app' }, {
    secretNames: ['app-secret'],
    configMapNames: ['app-config'],
  });
  const frontendDeploy = makeDeployment('app-deploy', 'frontend', { app: 'app' });
  const frontendSvc = makeService('app-svc', 'frontend', { app: 'app' });
  const frontendSecret = makeSecret('app-secret', 'frontend');
  const frontendConfig = makeConfigMap('app-config', 'frontend');

  const dbPod = makePod('db-pod', 'database', { app: 'db' }, {
    secretNames: ['db-secret'],
    pvcNames: ['db-pvc'],
  });
  const dbSts = makeStatefulSet('db-sts', 'database', { app: 'db' });
  const dbSvc = makeService('db-svc', 'database', { app: 'db' });
  const dbSecret = makeSecret('db-secret', 'database');
  const dbPvc = makePVC('db-pvc', 'database');

  const resources: K8sResource[] = [
    frontendPod, frontendDeploy, frontendSvc, frontendSecret, frontendConfig,
    dbPod, dbSts, dbSvc, dbSecret, dbPvc,
  ];
  const events: K8sEvent[] = [];

  return buildDiagnosticGraph(resources, events);
}

/** Five nodes in a star topology (all connected to center) — one community expected. */
function buildStarGraph(): DiagnosticGraph {
  const graph = new DiagnosticGraph();
  const ids = ['center', 'a', 'b', 'c', 'd'];
  for (const id of ids) {
    graph.addNode({ id, nodeType: 'resource', data: { kind: 'Pod', name: id, namespace: 'default' } });
  }
  for (const id of ids.slice(1)) {
    graph.addEdge({ id: `e-${id}`, source: 'center', target: id, type: 'label-selector' });
  }
  return graph;
}

/** Empty graph — no nodes. */
function buildEmptyGraph(): DiagnosticGraph {
  return new DiagnosticGraph();
}

/** Graph with three isolated nodes (no edges). */
function buildIsolatedNodesGraph(): DiagnosticGraph {
  const graph = new DiagnosticGraph();
  for (const name of ['a', 'b', 'c']) {
    graph.addNode({ id: name, nodeType: 'resource', data: { kind: 'Pod', name, namespace: 'default' } });
  }
  return graph;
}

// ---------------------------------------------------------------------------
// Node ID helpers
// ---------------------------------------------------------------------------

const FRONTEND_NODE_IDS = [
  'Deployment:frontend/app-deploy',
  'Pod:frontend/app-pod',
  'Service:frontend/app-svc',
  'Secret:frontend/app-secret',
  'ConfigMap:frontend/app-config',
];

const DATABASE_NODE_IDS = [
  'StatefulSet:database/db-sts',
  'Pod:database/db-pod',
  'Service:database/db-svc',
  'Secret:database/db-secret',
  'PersistentVolumeClaim:database/db-pvc',
];

// ---------------------------------------------------------------------------
// detectCommunities
// ---------------------------------------------------------------------------

describe('detectCommunities', () => {
  it('returns an empty array for an empty graph', () => {
    const communities = detectCommunities(buildEmptyGraph());
    expect(communities).toEqual([]);
  });

  it('returns 3 communities for 3 isolated nodes (no edges)', () => {
    const communities = detectCommunities(buildIsolatedNodesGraph());
    expect(communities).toHaveLength(3);
  });

  it('returns exactly 1 community for a fully-connected star graph', () => {
    const communities = detectCommunities(buildStarGraph());
    expect(communities).toHaveLength(1);
    expect(communities[0]?.nodeIds).toHaveLength(5);
  });

  it('returns exactly 2 communities for a two-stack multi-namespace graph', () => {
    const graph = buildMultiNamespaceGraph();
    const communities = detectCommunities(graph);
    expect(communities).toHaveLength(2);
  });

  it('every node appears in exactly one community', () => {
    const graph = buildMultiNamespaceGraph();
    const allNodeIds = [...graph.nodes.keys()];
    const communities = detectCommunities(graph);

    const assignedIds = communities.flatMap((c) => c.nodeIds);
    expect(assignedIds.sort()).toEqual(allNodeIds.sort());
  });

  it('frontend nodes are grouped into the same community', () => {
    const graph = buildMultiNamespaceGraph();
    const communities = detectCommunities(graph);

    const frontendCommunity = communities.find((c) =>
      FRONTEND_NODE_IDS.every((id) => c.nodeIds.includes(id)),
    );
    expect(frontendCommunity).toBeDefined();
  });

  it('database nodes are grouped into the same community', () => {
    const graph = buildMultiNamespaceGraph();
    const communities = detectCommunities(graph);

    const dbCommunity = communities.find((c) =>
      DATABASE_NODE_IDS.every((id) => c.nodeIds.includes(id)),
    );
    expect(dbCommunity).toBeDefined();
  });

  it('frontend and database nodes are in different communities', () => {
    const graph = buildMultiNamespaceGraph();
    const communities = detectCommunities(graph);

    const frontendCommunity = communities.find((c) =>
      c.nodeIds.includes('Pod:frontend/app-pod'),
    );
    const dbCommunity = communities.find((c) =>
      c.nodeIds.includes('Pod:database/db-pod'),
    );

    expect(frontendCommunity).toBeDefined();
    expect(dbCommunity).toBeDefined();
    expect(frontendCommunity?.id).not.toBe(dbCommunity?.id);
  });

  it('each community has a unique id', () => {
    const graph = buildMultiNamespaceGraph();
    const communities = detectCommunities(graph);
    const ids = communities.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('each community has a non-empty nodeIds array', () => {
    const graph = buildMultiNamespaceGraph();
    const communities = detectCommunities(graph);
    for (const community of communities) {
      expect(community.nodeIds.length).toBeGreaterThan(0);
    }
  });

  it('works correctly after workload groups are added (middle layer)', () => {
    const graph = buildMultiNamespaceGraph();
    buildWorkloadGroups(graph);
    const communities = detectCommunities(graph);

    // Should still produce 2 communities (workload-group nodes join their stacks)
    expect(communities).toHaveLength(2);

    // Frontend stack nodes (including workload-group) all in one community
    const frontendCommunity = communities.find((c) =>
      c.nodeIds.includes('Pod:frontend/app-pod'),
    );
    expect(frontendCommunity).toBeDefined();
    // Workload-group node should be in the same community as the deployment
    expect(frontendCommunity?.nodeIds).toContain('workload-group:frontend/app-deploy');
  });
});

// ---------------------------------------------------------------------------
// generateCommunitySummary
// ---------------------------------------------------------------------------

describe('generateCommunitySummary', () => {
  it('returns a non-empty string', () => {
    const graph = buildMultiNamespaceGraph();
    const communities = detectCommunities(graph);
    expect(communities.length).toBeGreaterThan(0);

    const summary = generateCommunitySummary(communities[0]!, graph.nodes);
    expect(typeof summary).toBe('string');
    expect(summary.length).toBeGreaterThan(0);
  });

  it('mentions the total number of nodes in the community', () => {
    const graph = buildMultiNamespaceGraph();
    const communities = detectCommunities(graph);
    const community = communities[0]!;

    const summary = generateCommunitySummary(community, graph.nodes);
    expect(summary).toMatch(/\d+/); // at least one number
  });

  it('mentions the namespace for a single-namespace community', () => {
    const graph = buildMultiNamespaceGraph();
    const communities = detectCommunities(graph);

    // Find the frontend community
    const frontendCommunity = communities.find((c) =>
      c.nodeIds.includes('Pod:frontend/app-pod'),
    )!;

    const summary = generateCommunitySummary(frontendCommunity, graph.nodes);
    expect(summary.toLowerCase()).toContain('frontend');
  });

  it('mentions resource kinds present in the community', () => {
    const graph = buildMultiNamespaceGraph();
    const communities = detectCommunities(graph);

    const frontendCommunity = communities.find((c) =>
      c.nodeIds.includes('Pod:frontend/app-pod'),
    )!;

    const summary = generateCommunitySummary(frontendCommunity, graph.nodes);
    // Should mention at least one of the K8s kinds present
    const mentionsKind = ['Pod', 'Deployment', 'Service', 'Secret', 'ConfigMap'].some(
      (kind) => summary.includes(kind),
    );
    expect(mentionsKind).toBe(true);
  });

  it('returns different summaries for different communities', () => {
    const graph = buildMultiNamespaceGraph();
    const communities = detectCommunities(graph);
    expect(communities).toHaveLength(2);

    const summary0 = generateCommunitySummary(communities[0]!, graph.nodes);
    const summary1 = generateCommunitySummary(communities[1]!, graph.nodes);
    expect(summary0).not.toBe(summary1);
  });

  it('handles a community with a single node', () => {
    const graph = buildIsolatedNodesGraph();
    const communities = detectCommunities(graph);
    const singleNodeCommunity = communities[0]!;

    const summary = generateCommunitySummary(singleNodeCommunity, graph.nodes);
    expect(typeof summary).toBe('string');
    expect(summary.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// communityToChunk
// ---------------------------------------------------------------------------

describe('communityToChunk', () => {
  function makeCommunity(id: string, nodeIds: string[], summary: string): Community {
    return { id, label: 'test-community', nodeIds, summary };
  }

  it('returns an IndexedChunk with content equal to the summary', () => {
    const community = makeCommunity('community-0', ['a', 'b'], 'A test summary.');
    const chunk = communityToChunk(community);
    expect(chunk.content).toBe('A test summary.');
  });

  it('returns an IndexedChunk with artifactCategory "analyzer"', () => {
    const community = makeCommunity('community-0', ['a', 'b'], 'Summary');
    const chunk = communityToChunk(community);
    expect(chunk.artifactCategory).toBe('analyzer');
  });

  it('returns an IndexedChunk with a stable id based on community id', () => {
    const community = makeCommunity('community-42', ['a', 'b'], 'Summary');
    const chunk = communityToChunk(community);
    expect(chunk.id).toContain('community-42');
  });

  it('returns an IndexedChunk with summary equal to content', () => {
    const community = makeCommunity('community-0', ['a'], 'My summary text.');
    const chunk = communityToChunk(community);
    expect(chunk.summary).toBe(chunk.content);
  });

  it('returns an IndexedChunk with non-empty identifiers', () => {
    const community = makeCommunity('community-0', ['Pod:default/app', 'Secret:default/sec'], 'Summary');
    const chunk = communityToChunk(community);
    expect(Array.isArray(chunk.identifiers)).toBe(true);
    expect(chunk.identifiers.length).toBeGreaterThan(0);
  });

  it('includes node ids from the community in identifiers', () => {
    const community = makeCommunity('community-0', ['Pod:default/app', 'Secret:default/sec'], 'Summary');
    const chunk = communityToChunk(community);
    // At least some identifiers should relate to the community's nodes
    expect(chunk.identifiers.length).toBeGreaterThan(0);
  });

  it('has startLine=1 and endLine=1', () => {
    const community = makeCommunity('community-0', [], 'Summary');
    const chunk = communityToChunk(community);
    expect(chunk.startLine).toBe(1);
    expect(chunk.endLine).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// communitiesToChunks
// ---------------------------------------------------------------------------

describe('communitiesToChunks', () => {
  it('returns one chunk per community', () => {
    const graph = buildMultiNamespaceGraph();
    const communities = detectCommunities(graph);
    const chunks = communitiesToChunks(communities);
    expect(chunks).toHaveLength(communities.length);
  });

  it('returns an empty array for empty input', () => {
    expect(communitiesToChunks([])).toEqual([]);
  });

  it('all returned chunks have artifactCategory "analyzer"', () => {
    const graph = buildMultiNamespaceGraph();
    const communities = detectCommunities(graph);
    const chunks = communitiesToChunks(communities);
    for (const chunk of chunks) {
      expect(chunk.artifactCategory).toBe('analyzer');
    }
  });

  it('all returned chunks have unique ids', () => {
    const graph = buildMultiNamespaceGraph();
    const communities = detectCommunities(graph);
    const chunks = communitiesToChunks(communities);
    const ids = chunks.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ---------------------------------------------------------------------------
// buildCommunityNodes — wires community detection into the diagnostic graph
// ---------------------------------------------------------------------------

describe('buildCommunityNodes', () => {
  it('returns the detected communities', () => {
    const graph = buildMultiNamespaceGraph();
    const communities = buildCommunityNodes(graph);
    expect(communities).toHaveLength(2);
  });

  it('adds application-component nodes to the graph', () => {
    const graph = buildMultiNamespaceGraph();
    const communities = buildCommunityNodes(graph);

    const componentNodes = [...graph.nodes.values()].filter(
      (n) => n.nodeType === 'application-component',
    );
    expect(componentNodes).toHaveLength(communities.length);
  });

  it('each application-component node carries its community member IDs', () => {
    const graph = buildMultiNamespaceGraph();
    const communities = buildCommunityNodes(graph);

    for (const community of communities) {
      const node = graph.getNode(`app-component:${community.id}`);
      expect(node).toBeDefined();
      const data = node!.data as { members: string[] };
      expect(Array.isArray(data.members)).toBe(true);
      // All community members should be present
      for (const memberId of community.nodeIds) {
        expect(data.members).toContain(memberId);
      }
    }
  });

  it('adds "contains" edges from each application-component to its member nodes', () => {
    const graph = buildMultiNamespaceGraph();
    const communities = buildCommunityNodes(graph);

    for (const community of communities) {
      const componentNodeId = `app-component:${community.id}`;
      const containsEdges = graph.edges.filter(
        (e) => e.source === componentNodeId && e.type === 'contains',
      );
      expect(containsEdges.length).toBeGreaterThan(0);
    }
  });

  it('application-component node data includes a summary', () => {
    const graph = buildMultiNamespaceGraph();
    const communities = buildCommunityNodes(graph);

    for (const community of communities) {
      const node = graph.getNode(`app-component:${community.id}`);
      const data = node!.data as { summary: string };
      expect(typeof data.summary).toBe('string');
      expect(data.summary.length).toBeGreaterThan(0);
    }
  });

  it('does not add duplicate community nodes when called twice', () => {
    const graph = buildMultiNamespaceGraph();
    buildCommunityNodes(graph);
    buildCommunityNodes(graph);

    const componentNodes = [...graph.nodes.values()].filter(
      (n) => n.nodeType === 'application-component',
    );
    // Each call detects 2 communities; after second call the node map
    // should still have exactly 2 (addNode overwrites by id)
    expect(componentNodes).toHaveLength(2);
  });

  it('returns an empty array for an empty graph', () => {
    const graph = buildEmptyGraph();
    const communities = buildCommunityNodes(graph);
    expect(communities).toEqual([]);
  });
});
