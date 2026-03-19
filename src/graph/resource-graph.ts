import type { K8sResource, K8sEvent } from '../types/index.js';
import type { IndexedChunk } from '../ai/chunk-indexer.js';
import type { InvestigationSeed } from '../investigators/types.js';

// ---------------------------------------------------------------------------
// Entity name extraction (mirrors extractQueryIdentifiers in lexical-search.ts)
// ---------------------------------------------------------------------------

/** Known K8s error reasons used for entity extraction from free text. */
const GRAPH_K8S_ERROR_REASONS: readonly string[] = [
  'CrashLoopBackOff', 'ImagePullBackOff', 'ErrImagePull', 'OOMKilled',
  'ContainerCannotRun', 'DeadlineExceeded', 'Evicted', 'BackOff',
  'ContainersNotReady', 'Unschedulable', 'RunContainerError',
  'CreateContainerError', 'InvalidImageName', 'CreateContainerConfigError',
  'FailedScheduling', 'FailedMount', 'FailedAttachVolume', 'NodeNotReady',
];

const GRAPH_K8S_ERROR_REASONS_LOWER = new Map(
  GRAPH_K8S_ERROR_REASONS.map((reason) => [reason.toLowerCase(), reason]),
);

/**
 * Stop words filtered from RFC-1123 name token extraction.
 * Mirrors RFC1123_STOP_WORDS in lexical-search.ts — intentionally omits
 * diagnostic terms like 'secret', 'configmap', 'missing', 'failed', etc.
 */
const GRAPH_ENTITY_STOP_WORDS: ReadonlySet<string> = new Set([
  // English connectives
  'in', 'is', 'are', 'the', 'a', 'an', 'of', 'for', 'with', 'and', 'or',
  'not', 'has', 'have', 'been', 'being', 'to', 'from', 'on', 'at', 'by',
  'due', 'via',
  // K8s structural keywords (non-diagnostic)
  'pod', 'pods', 'log', 'logs', 'file', 'files', 'check', 'status', 'state',
  'phase', 'reason', 'message', 'type', 'name', 'namespace', 'container',
  'containers', 'image', 'images', 'event', 'events', 'resource', 'resources',
  'cluster', 'node', 'nodes', 'deployment', 'deployments',
  'running', 'pending',
  // Common severity / level words
  'high', 'low', 'medium', 'critical', 'severity', 'info', 'warn', 'error',
  'warning',
  // K8s lifecycle verbs (non-diagnostic)
  'restart', 'restarts', 'back', 'off', 'loop', 'crash', 'crashloop',
  'invalid', 'wrong',
]);

/**
 * Extracts K8s entity names from free text.
 *
 * Applies the same extraction pipeline as
 * `LexicalSearchIndex.extractQueryIdentifiers`:
 * 1. Known K8s error reasons (canonical casing).
 * 2. RFC-1123 resource-name tokens (lowercase, 2–63 chars), filtered through
 *    {@link GRAPH_ENTITY_STOP_WORDS}.
 *
 * Used by {@link getRelatedChunks} to resolve entity names mentioned in
 * analyzer messages or seed hypotheses to graph nodes.
 */
function extractEntityNamesFromText(text: string): string[] {
  const ids = new Set<string>();
  const lowerText = text.toLowerCase();

  // Step 1: known K8s error reasons
  for (const [lowerReason, canonicalReason] of GRAPH_K8S_ERROR_REASONS_LOWER) {
    if (lowerText.includes(lowerReason)) {
      ids.add(canonicalReason);
    }
  }

  // Step 2: RFC-1123 resource names (allow hyphens, 2–63 chars total)
  const k8sNamePattern = /\b([a-z][a-z0-9-]{1,62})\b/g;
  for (const match of lowerText.matchAll(k8sNamePattern)) {
    const token = match[1]!;
    if (!GRAPH_ENTITY_STOP_WORDS.has(token)) {
      ids.add(token);
    }
  }

  return [...ids];
}

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

/**
 * A chunk retrieved from the graph neighborhood, paired with a hop-distance
 * score that reflects proximity to the seed resource.
 *
 * Scores:
 * - `1.0` — direct resource (depth 0) or exact seed match (log/analyzer/event)
 * - `0.7` — depth-1 neighbor
 * - `0.4` — depth-2 neighbor
 */
export interface GraphScoredChunk {
  chunk: IndexedChunk;
  score: number;
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
// Hop-distance scoring helper
// ---------------------------------------------------------------------------

/**
 * Returns the retrieval score for a given hop depth:
 * - depth 0 (direct resource): `1.0`
 * - depth 1 (one hop away): `0.7`
 * - depth ≥ 2 (two or more hops): `0.4`
 */
function scoreForDepth(depth: number): number {
  if (depth === 0) return 1.0;
  if (depth === 1) return 0.7;
  return 0.4;
}

// ---------------------------------------------------------------------------
// getNeighborhoodWithDepth
// ---------------------------------------------------------------------------

/**
 * Returns all {@link ResourceNode}s reachable within `depth` hops from the
 * specified resource, along with their exact hop distance from the start node
 * (undirected traversal — follows edges in both directions).
 *
 * The source node itself is returned with depth `0`.
 */
export function getNeighborhoodWithDepth(
  graph: ResourceRelationshipGraph,
  kind: string,
  name: string,
  namespace: string,
  depth = 2,
): Array<{ node: ResourceNode; depth: number }> {
  const startId = nodeId(kind, namespace, name);
  // Track visited nodes with their assigned depth to prevent revisiting
  const visitedDepth = new Map<string, number>();
  visitedDepth.set(startId, 0);
  const result: Array<{ node: ResourceNode; depth: number }> = [];

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

  // BFS tracking current depth
  const queue: Array<[string, number]> = [[startId, 0]];

  while (queue.length > 0) {
    const [current, currentDepth] = queue.shift()!;
    const node = graph.nodes.get(current);
    if (node) result.push({ node, depth: currentDepth });

    if (currentDepth >= depth) continue;

    for (const neighbor of adj.get(current) ?? []) {
      if (!visitedDepth.has(neighbor)) {
        visitedDepth.set(neighbor, currentDepth + 1);
        queue.push([neighbor, currentDepth + 1]);
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// getNeighborhood
// ---------------------------------------------------------------------------

/**
 * Returns all {@link ResourceNode}s reachable within `depth` hops from the
 * specified resource (undirected traversal — follows edges in both directions).
 *
 * The source node itself is included at depth 0.
 *
 * @see {@link getNeighborhoodWithDepth} for the depth-aware variant.
 */
export function getNeighborhood(
  graph: ResourceRelationshipGraph,
  kind: string,
  name: string,
  namespace: string,
  depth = 2,
): ResourceNode[] {
  return getNeighborhoodWithDepth(graph, kind, name, namespace, depth).map(({ node }) => node);
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
 * {@link GraphScoredChunk}s that are relevant to the seed's target resource
 * and its graph neighborhood, scored by hop distance.
 *
 * Scoring:
 * - Log / Analyzer / exact-event chunks: `1.0` (direct seed match)
 * - K8s resource chunks at depth 0 (the seed resource itself): `1.0`
 * - K8s resource chunks at depth 1 (direct graph neighbors): `0.7`
 * - K8s resource chunks at depth 2 (two-hop graph neighbors): `0.4`
 *
 * When a chunk qualifies via multiple matching paths (e.g. both node-id match
 * and name match), the highest score (lowest depth) wins.
 *
 * Strategy:
 * 1. Parse the seed source into (kind, namespace, name).
 * 2. Walk the resource graph neighborhood (depth=2) for K8s resources,
 *    building `nodeIdToMinDepth` and `nameToMinDepth` maps.
 * 3. Collect chunks whose identifiers or node-id overlap with any neighborhood
 *    resource, assigning scores from the maps.
 * 4. Log and Analyzer seeds use direct path/name matching → score 1.0.
 */
export function getRelatedChunks(
  graph: ResourceRelationshipGraph,
  seed: InvestigationSeed,
  chunkIndex: IndexedChunk[],
): GraphScoredChunk[] {
  const parsed = parseSeedSource(seed.source);
  if (!parsed) return [];

  const { kind, namespace, name } = parsed;

  // Maps for hop-distance lookup during chunk scoring
  const nodeIdToMinDepth = new Map<string, number>();
  const nameToMinDepth = new Map<string, number>();
  const seen = new Set<string>();
  const matched: GraphScoredChunk[] = [];

  /**
   * Runs BFS from the given node and populates `nodeIdToMinDepth` /
   * `nameToMinDepth` with the minimum depth seen for each node / name.
   */
  const addNeighborhoodWithDepth = (nodeKind: string, nodeName: string, nodeNamespace: string): void => {
    for (const { node, depth } of getNeighborhoodWithDepth(graph, nodeKind, nodeName, nodeNamespace, 2)) {
      const id = nodeId(node.kind, node.namespace, node.name);
      const existingDepth = nodeIdToMinDepth.get(id);
      if (existingDepth === undefined || depth < existingDepth) {
        nodeIdToMinDepth.set(id, depth);
      }
      const lowerName = node.name.toLowerCase();
      const existingNameDepth = nameToMinDepth.get(lowerName);
      if (existingNameDepth === undefined || depth < existingNameDepth) {
        nameToMinDepth.set(lowerName, depth);
      }
    }
  };

  if (kind === 'Pod') {
    addNeighborhoodWithDepth(kind, name, namespace || 'default');
  }

  // ── Analyzer seed: extract entity names → walk graph neighborhoods ────────
  if (kind === 'Analyzer') {
    // Find the matching analyzer chunk(s) in the index
    const analyzerChunks = chunkIndex.filter(
      (chunk) =>
        chunk.artifactCategory === 'analyzer' &&
        (chunk.artifactId === name ||
          (isRecord(chunk.metadata) && getString(chunk.metadata['name']) === name) ||
          chunk.identifiers.some((id) => id === name)),
    );

    // Extract entity names from hypothesis AND analyzer chunk content
    const textParts: string[] = [seed.hypothesis];
    for (const ac of analyzerChunks) {
      textParts.push(ac.content);
    }
    const entityNames = extractEntityNamesFromText(textParts.join(' '));

    // Resolve entity names to graph nodes and walk neighborhoods
    let foundAnyNodes = false;
    for (const entityName of entityNames) {
      for (const [, node] of graph.nodes) {
        if (node.name === entityName) {
          addNeighborhoodWithDepth(node.kind, node.name, node.namespace);
          foundAnyNodes = true;
        }
      }
    }

    // Fallback: if no entity names resolved to nodes, find unhealthy pods
    if (!foundAnyNodes) {
      const unhealthyPodNames = new Set<string>();
      for (const chunk of chunkIndex) {
        if (
          chunk.artifactCategory === 'kubernetes-resource' &&
          (chunk.identifiers.includes('CrashLoopBackOff') ||
            chunk.identifiers.includes('ImagePullBackOff'))
        ) {
          for (const id of chunk.identifiers) {
            unhealthyPodNames.add(id);
          }
        }
      }
      for (const [, node] of graph.nodes) {
        if (node.kind === 'Pod' && unhealthyPodNames.has(node.name)) {
          addNeighborhoodWithDepth('Pod', node.name, node.namespace);
        }
      }
    }
  }

  // ── Log seed: resolve pod from path → walk graph neighborhood ─────────────
  if (kind === 'Log') {
    // Parse log path to extract pod name using same heuristics as
    // resolveLogPodComponent: filename-without-extension first, then
    // parent directory (for container-scoped logs like pods/logs/ns/pod/ctr.log)
    const logPathSegments = name.split('/');
    const logFilename = logPathSegments[logPathSegments.length - 1] ?? '';
    const dotIdx = logFilename.lastIndexOf('.');
    const logBasename = dotIdx !== -1 ? logFilename.slice(0, dotIdx) : logFilename;
    const logParentDir = logPathSegments[logPathSegments.length - 2];

    const podNamesToCheck = new Set<string>();
    if (logBasename) podNamesToCheck.add(logBasename);
    if (logParentDir) podNamesToCheck.add(logParentDir);

    for (const [, node] of graph.nodes) {
      if (node.kind === 'Pod' && podNamesToCheck.has(node.name)) {
        addNeighborhoodWithDepth('Pod', node.name, node.namespace);
      }
    }
  }

  let eventReason = '';
  let eventObjectName = '';
  if (kind === 'Event') {
    const eventParts = name.split(':');
    eventObjectName = eventParts.pop() ?? name;
    eventReason = eventParts.join(':');

    // The event reason and involved-object name are depth-0 from the event seed
    nameToMinDepth.set(eventObjectName.toLowerCase(), 0);
    if (eventReason) nameToMinDepth.set(eventReason.toLowerCase(), 0);

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
        nodeIdToMinDepth.set(nodeId('Event', eventNamespace, `${eventReason}:${eventObjectName}`), 0);
        addNeighborhoodWithDepth(eventKind, eventObjectName, eventNamespace);
      }
    } else {
      addNeighborhoodWithDepth('Pod', eventObjectName, namespace || 'default');
    }
  }

  for (const chunk of chunkIndex) {
    if (seen.has(chunk.id)) continue;

    // ── Direct Log match ───────────────────────────────────────────────────
    if (kind === 'Log' && chunk.artifactId === name) {
      matched.push({ chunk, score: 1.0 });
      seen.add(chunk.id);
      continue;
    }

    // ── Direct Analyzer match ──────────────────────────────────────────────
    if (
      kind === 'Analyzer' &&
      (chunk.artifactId === name ||
        (isRecord(chunk.metadata) && getString(chunk.metadata['name']) === name) ||
        chunk.identifiers.some((identifier) => identifier === name))
    ) {
      matched.push({ chunk, score: 1.0 });
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

    // ── Exact event match → always depth-0 score ──────────────────────────
    const exactEventMatch =
      kind === 'Event' &&
      chunk.artifactCategory === 'event' &&
      metadata !== undefined &&
      getString(metadata['reason']).toLowerCase() === eventReason.toLowerCase() &&
      getString(metadata['name']).toLowerCase() === eventObjectName.toLowerCase();

    if (exactEventMatch) {
      matched.push({ chunk, score: 1.0 });
      seen.add(chunk.id);
      continue;
    }

    // ── Hop-distance scoring via graph node id and/or name match ──────────
    let bestDepth: number | undefined;

    if (chunkNodeId !== '' && nodeIdToMinDepth.has(chunkNodeId)) {
      const d = nodeIdToMinDepth.get(chunkNodeId)!;
      if (bestDepth === undefined || d < bestDepth) bestDepth = d;
    }

    for (const identifier of chunk.identifiers) {
      const lowerIdentifier = identifier.toLowerCase();
      if (nameToMinDepth.has(lowerIdentifier)) {
        const d = nameToMinDepth.get(lowerIdentifier)!;
        if (bestDepth === undefined || d < bestDepth) bestDepth = d;
      }
    }

    if (bestDepth !== undefined) {
      matched.push({ chunk, score: scoreForDepth(bestDepth) });
      seen.add(chunk.id);
    }
  }

  return matched;
}
