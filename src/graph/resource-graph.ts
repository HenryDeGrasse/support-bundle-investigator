import type { K8sResource, K8sEvent } from '../types/index.js';
import type { IndexedChunk } from '../ai/chunk-indexer.js';
import type { InvestigationSeed } from '../investigators/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RelationshipType =
  | 'owner-reference'
  | 'references-secret'
  | 'references-configmap'
  | 'references-pvc'
  | 'event-target';

export interface ResourceNode {
  kind: string;
  name: string;
  namespace: string;
}

export interface ResourceEdge {
  sourceKind: string;
  sourceName: string;
  sourceNamespace: string;
  targetKind: string;
  targetName: string;
  targetNamespace: string;
  relationshipType: RelationshipType;
}

export interface ResourceRelationshipGraph {
  /** Nodes keyed by canonical id: `{Kind}:{namespace}/{name}` */
  nodes: Map<string, ResourceNode>;
  edges: ResourceEdge[];
}

// ---------------------------------------------------------------------------
// Internal type guards
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function getArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

// ---------------------------------------------------------------------------
// Graph node id helper
// ---------------------------------------------------------------------------

function nodeId(kind: string, namespace: string, name: string): string {
  return `${kind}:${namespace}/${name}`;
}

function addNode(graph: ResourceRelationshipGraph, kind: string, namespace: string, name: string): void {
  const id = nodeId(kind, namespace, name);
  if (!graph.nodes.has(id)) {
    graph.nodes.set(id, { kind, name, namespace });
  }
}

function addEdge(
  graph: ResourceRelationshipGraph,
  edge: ResourceEdge,
): void {
  graph.edges.push(edge);
}

// ---------------------------------------------------------------------------
// Edge extractors
// ---------------------------------------------------------------------------

/**
 * Extracts edges from metadata.ownerReferences for any resource kind.
 */
function extractOwnerReferenceEdges(
  resource: K8sResource,
  graph: ResourceRelationshipGraph,
): void {
  const rawMeta = resource.metadata as unknown as Record<string, unknown>;
  const ownerRefs = getArray(rawMeta['ownerReferences']);
  const ns = resource.metadata.namespace ?? 'default';

  for (const ref of ownerRefs) {
    if (!isRecord(ref)) continue;
    const ownerKind = getString(ref['kind']);
    const ownerName = getString(ref['name']);
    if (!ownerKind || !ownerName) continue;

    // Only K8s workload owner kinds
    const workloadKinds = new Set(['Deployment', 'StatefulSet', 'ReplicaSet', 'DaemonSet', 'Job', 'CronJob']);
    if (!workloadKinds.has(ownerKind)) continue;

    addNode(graph, ownerKind, ns, ownerName);
    addEdge(graph, {
      sourceKind: resource.kind,
      sourceName: resource.metadata.name,
      sourceNamespace: ns,
      targetKind: ownerKind,
      targetName: ownerName,
      targetNamespace: ns,
      relationshipType: 'owner-reference',
    });
  }
}

/**
 * Extracts Secret, ConfigMap, and PVC reference edges from a Pod spec.
 */
function extractPodSpecEdges(
  resource: K8sResource,
  graph: ResourceRelationshipGraph,
): void {
  if (resource.kind !== 'Pod') return;

  const ns = resource.metadata.namespace ?? 'default';
  const podName = resource.metadata.name;

  if (!isRecord(resource.spec)) return;
  const spec = resource.spec as Record<string, unknown>;

  // ── spec.volumes ──────────────────────────────────────────────────────────
  for (const vol of getArray(spec['volumes'])) {
    if (!isRecord(vol)) continue;

    // volume.secret.secretName
    if (isRecord(vol['secret'])) {
      const secretName = getString(vol['secret']['secretName']);
      if (secretName) {
        addNode(graph, 'Secret', ns, secretName);
        addEdge(graph, {
          sourceKind: 'Pod',
          sourceName: podName,
          sourceNamespace: ns,
          targetKind: 'Secret',
          targetName: secretName,
          targetNamespace: ns,
          relationshipType: 'references-secret',
        });
      }
    }

    // volume.configMap.name
    if (isRecord(vol['configMap'])) {
      const cmName = getString(vol['configMap']['name']);
      if (cmName) {
        addNode(graph, 'ConfigMap', ns, cmName);
        addEdge(graph, {
          sourceKind: 'Pod',
          sourceName: podName,
          sourceNamespace: ns,
          targetKind: 'ConfigMap',
          targetName: cmName,
          targetNamespace: ns,
          relationshipType: 'references-configmap',
        });
      }
    }

    // volume.persistentVolumeClaim.claimName
    if (isRecord(vol['persistentVolumeClaim'])) {
      const pvcName = getString(vol['persistentVolumeClaim']['claimName']);
      if (pvcName) {
        addNode(graph, 'PersistentVolumeClaim', ns, pvcName);
        addEdge(graph, {
          sourceKind: 'Pod',
          sourceName: podName,
          sourceNamespace: ns,
          targetKind: 'PersistentVolumeClaim',
          targetName: pvcName,
          targetNamespace: ns,
          relationshipType: 'references-pvc',
        });
      }
    }
  }

  // ── spec.containers / initContainers ─────────────────────────────────────
  const allContainers = [
    ...getArray(spec['containers']),
    ...getArray(spec['initContainers']),
  ];

  for (const container of allContainers) {
    if (!isRecord(container)) continue;

    // container.envFrom
    for (const envFrom of getArray(container['envFrom'])) {
      if (!isRecord(envFrom)) continue;

      if (isRecord(envFrom['secretRef'])) {
        const secretName = getString(envFrom['secretRef']['name']);
        if (secretName) {
          addNode(graph, 'Secret', ns, secretName);
          addEdge(graph, {
            sourceKind: 'Pod',
            sourceName: podName,
            sourceNamespace: ns,
            targetKind: 'Secret',
            targetName: secretName,
            targetNamespace: ns,
            relationshipType: 'references-secret',
          });
        }
      }

      if (isRecord(envFrom['configMapRef'])) {
        const cmName = getString(envFrom['configMapRef']['name']);
        if (cmName) {
          addNode(graph, 'ConfigMap', ns, cmName);
          addEdge(graph, {
            sourceKind: 'Pod',
            sourceName: podName,
            sourceNamespace: ns,
            targetKind: 'ConfigMap',
            targetName: cmName,
            targetNamespace: ns,
            relationshipType: 'references-configmap',
          });
        }
      }
    }

    // container.env[].valueFrom
    for (const envVar of getArray(container['env'])) {
      if (!isRecord(envVar)) continue;
      if (!isRecord(envVar['valueFrom'])) continue;

      const vf = envVar['valueFrom'] as Record<string, unknown>;

      if (isRecord(vf['secretKeyRef'])) {
        const secretName = getString(vf['secretKeyRef']['name']);
        if (secretName) {
          addNode(graph, 'Secret', ns, secretName);
          addEdge(graph, {
            sourceKind: 'Pod',
            sourceName: podName,
            sourceNamespace: ns,
            targetKind: 'Secret',
            targetName: secretName,
            targetNamespace: ns,
            relationshipType: 'references-secret',
          });
        }
      }

      if (isRecord(vf['configMapKeyRef'])) {
        const cmName = getString(vf['configMapKeyRef']['name']);
        if (cmName) {
          addNode(graph, 'ConfigMap', ns, cmName);
          addEdge(graph, {
            sourceKind: 'Pod',
            sourceName: podName,
            sourceNamespace: ns,
            targetKind: 'ConfigMap',
            targetName: cmName,
            targetNamespace: ns,
            relationshipType: 'references-configmap',
          });
        }
      }
    }
  }
}

/**
 * Adds an Event→InvolvedObject edge.
 */
function extractEventEdge(
  event: K8sEvent,
  graph: ResourceRelationshipGraph,
): void {
  const { kind, name, namespace } = event.involvedObject;
  const ns = namespace ?? 'default';
  const eventId = `Event:${ns}/${event.reason}:${name}`;

  // Ensure the involved object node exists
  addNode(graph, kind, ns, name);

  // Add the event node with a synthetic id
  if (!graph.nodes.has(eventId)) {
    graph.nodes.set(eventId, { kind: 'Event', name: `${event.reason}:${name}`, namespace: ns });
  }

  addEdge(graph, {
    sourceKind: 'Event',
    sourceName: `${event.reason}:${name}`,
    sourceNamespace: ns,
    targetKind: kind,
    targetName: name,
    targetNamespace: ns,
    relationshipType: 'event-target',
  });
}

// ---------------------------------------------------------------------------
// buildResourceGraph
// ---------------------------------------------------------------------------

/**
 * Builds a {@link ResourceRelationshipGraph} from K8s resources and events.
 *
 * Deterministic edges encoded:
 * - Pod → owner (Deployment/StatefulSet/ReplicaSet/DaemonSet) via ownerReferences
 * - Pod → Secret (volumes, envFrom, env.valueFrom.secretKeyRef)
 * - Pod → ConfigMap (volumes, envFrom, env.valueFrom.configMapKeyRef)
 * - Pod → PVC (volumes)
 * - Event → involvedObject
 */
export function buildResourceGraph(
  resources: K8sResource[],
  events: K8sEvent[],
): ResourceRelationshipGraph {
  const graph: ResourceRelationshipGraph = {
    nodes: new Map(),
    edges: [],
  };

  // Add all resources as nodes first
  for (const r of resources) {
    const ns = r.metadata.namespace ?? 'default';
    addNode(graph, r.kind, ns, r.metadata.name);
  }

  // Extract relationship edges from each resource
  for (const r of resources) {
    extractOwnerReferenceEdges(r, graph);
    if (r.kind === 'Pod') {
      extractPodSpecEdges(r, graph);
    }
  }

  // Extract event edges
  for (const e of events) {
    extractEventEdge(e, graph);
  }

  return graph;
}

// ---------------------------------------------------------------------------
// getNeighborhood
// ---------------------------------------------------------------------------

/**
 * Returns all {@link ResourceNode}s reachable within `depth` hops from the
 * specified resource (undirected traversal — follows edges in both directions).
 *
 * The source node itself is included at depth 0.
 */
export function getNeighborhood(
  graph: ResourceRelationshipGraph,
  kind: string,
  name: string,
  namespace: string,
  depth = 2,
): ResourceNode[] {
  const startId = nodeId(kind, namespace, name);
  const visited = new Set<string>([startId]);
  const result: ResourceNode[] = [];

  // Queue entries: [nodeId, remaining depth]
  const queue: Array<[string, number]> = [[startId, depth]];

  // Build adjacency for fast lookup (undirected)
  const adj = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    const sId = nodeId(edge.sourceKind, edge.sourceNamespace, edge.sourceName);
    const tId = nodeId(edge.targetKind, edge.targetNamespace, edge.targetName);

    if (!adj.has(sId)) adj.set(sId, new Set());
    if (!adj.has(tId)) adj.set(tId, new Set());
    adj.get(sId)!.add(tId);
    adj.get(tId)!.add(sId);
  }

  while (queue.length > 0) {
    const [current, remaining] = queue.shift()!;
    const node = graph.nodes.get(current);
    if (node) result.push(node);

    if (remaining <= 0) continue;

    for (const neighbor of adj.get(current) ?? []) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push([neighbor, remaining - 1]);
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// parseSeedSource
// ---------------------------------------------------------------------------

/**
 * Parses a seed `source` string into kind, namespace, and name components.
 *
 * Formats supported:
 * - `pod:{namespace}/{name}` → `{ kind: 'Pod', namespace, name }`
 * - `analyzer:{name}` → `{ kind: 'Analyzer', namespace: '', name }`
 * - `log:{path}` → `{ kind: 'Log', namespace: '', name: path }`
 * - `event:{reason}:{name}` → `{ kind: 'Event', namespace: '', name: '{reason}:{name}' }`
 *
 * Returns `null` when the format is unrecognised.
 */
export function parseSeedSource(source: string): { kind: string; namespace: string; name: string } | null {
  if (!source) return null;

  const colonIdx = source.indexOf(':');
  if (colonIdx === -1) return null;

  const prefix = source.slice(0, colonIdx).toLowerCase();
  const rest = source.slice(colonIdx + 1);

  switch (prefix) {
    case 'pod': {
      const slashIdx = rest.indexOf('/');
      if (slashIdx === -1) return { kind: 'Pod', namespace: 'default', name: rest };
      return {
        kind: 'Pod',
        namespace: rest.slice(0, slashIdx),
        name: rest.slice(slashIdx + 1),
      };
    }
    case 'analyzer':
      return { kind: 'Analyzer', namespace: '', name: rest };
    case 'log':
      return { kind: 'Log', namespace: '', name: rest };
    case 'event': {
      // Format: event:{reason}:{objectName}
      return { kind: 'Event', namespace: '', name: rest };
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// getRelatedChunks
// ---------------------------------------------------------------------------

/**
 * Given a seed's source string and a flat chunk index, returns all
 * {@link IndexedChunk}s that are relevant to the seed's target resource and
 * its graph neighborhood.
 *
 * Strategy:
 * 1. Parse the seed source into (kind, namespace, name).
 * 2. Walk the resource graph neighborhood (depth=2) for K8s resources.
 * 3. Collect chunks whose identifiers overlap with any neighborhood resource
 *    name or namespace.
 * 4. Also always include the direct resource's chunks by exact artifact match.
 */
export function getRelatedChunks(
  graph: ResourceRelationshipGraph,
  seed: InvestigationSeed,
  chunkIndex: IndexedChunk[],
): IndexedChunk[] {
  const parsed = parseSeedSource(seed.source);
  if (!parsed) return [];

  const { kind, namespace, name } = parsed;
  const relevantNames = new Set<string>();
  const relevantNodeIds = new Set<string>();
  const seen = new Set<string>();
  const matched: IndexedChunk[] = [];

  const addNodeNeighborhood = (nodeKind: string, nodeName: string, nodeNamespace: string): void => {
    for (const neighbor of getNeighborhood(graph, nodeKind, nodeName, nodeNamespace, 2)) {
      relevantNodeIds.add(nodeId(neighbor.kind, neighbor.namespace, neighbor.name));
      relevantNames.add(neighbor.name.toLowerCase());
    }
  };

  if (kind === 'Pod') {
    relevantNodeIds.add(nodeId(kind, namespace || 'default', name));
    relevantNames.add(name.toLowerCase());
    addNodeNeighborhood(kind, name, namespace || 'default');
  }

  let eventReason = '';
  let eventObjectName = '';
  if (kind === 'Event') {
    const eventParts = name.split(':');
    eventObjectName = eventParts.pop() ?? name;
    eventReason = eventParts.join(':');
    relevantNames.add(eventObjectName.toLowerCase());
    if (eventReason) relevantNames.add(eventReason.toLowerCase());

    const matchingEventChunks = chunkIndex.filter((chunk) => {
      if (chunk.artifactCategory !== 'event' || !isRecord(chunk.metadata)) return false;
      const metaReason = getString(chunk.metadata['reason']).toLowerCase();
      const metaName = getString(chunk.metadata['name']).toLowerCase();
      return metaReason === eventReason.toLowerCase() && metaName === eventObjectName.toLowerCase();
    });

    if (matchingEventChunks.length > 0) {
      for (const chunk of matchingEventChunks) {
        const eventNamespace =
          (isRecord(chunk.metadata) ? getString(chunk.metadata['namespace']) : '') ||
          chunk.namespace ||
          'default';
        const eventKind =
          (isRecord(chunk.metadata) ? getString(chunk.metadata['kind']) : '') ||
          'Pod';
        relevantNodeIds.add(nodeId('Event', eventNamespace, `${eventReason}:${eventObjectName}`));
        addNodeNeighborhood(eventKind, eventObjectName, eventNamespace);
      }
    } else {
      addNodeNeighborhood('Pod', eventObjectName, namespace || 'default');
    }
  }

  for (const chunk of chunkIndex) {
    if (seen.has(chunk.id)) continue;

    if (kind === 'Log' && chunk.artifactId === name) {
      matched.push(chunk);
      seen.add(chunk.id);
      continue;
    }

    if (
      kind === 'Analyzer' &&
      (chunk.artifactId === name ||
        (isRecord(chunk.metadata) && getString(chunk.metadata['name']) === name) ||
        chunk.identifiers.some((identifier) => identifier === name))
    ) {
      matched.push(chunk);
      seen.add(chunk.id);
      continue;
    }

    const metadata = isRecord(chunk.metadata) ? chunk.metadata : undefined;
    const metaKind = metadata ? getString(metadata['kind']) : '';
    const metaName = metadata ? getString(metadata['name']) : '';
    const metaNamespace = metadata ? getString(metadata['namespace']) : '';
    const chunkNodeId =
      metaKind && metaName
        ? nodeId(metaKind, metaNamespace || chunk.namespace || 'default', metaName)
        : '';

    const exactGraphMatch = chunkNodeId !== '' && relevantNodeIds.has(chunkNodeId);
    const exactEventMatch =
      kind === 'Event' &&
      chunk.artifactCategory === 'event' &&
      metadata !== undefined &&
      getString(metadata['reason']).toLowerCase() === eventReason.toLowerCase() &&
      getString(metadata['name']).toLowerCase() === eventObjectName.toLowerCase();

    const hasNameMatch = chunk.identifiers.some((identifier) => relevantNames.has(identifier.toLowerCase()));

    if (exactGraphMatch || exactEventMatch || hasNameMatch) {
      matched.push(chunk);
      seen.add(chunk.id);
    }
  }

  return matched;
}
