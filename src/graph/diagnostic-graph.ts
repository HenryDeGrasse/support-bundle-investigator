import type { K8sResource, K8sEvent } from '../types/index.js';
import type { ResourceNode, ResourceEdge, ResourceRelationshipGraph, RelationshipType } from './resource-graph.js';
import type { IndexedChunk } from '../ai/chunk-indexer.js';
import { sortEventsByTime, getEventWindow, correlateEventsWithPod } from '../parsers/timeline.js';

// ---------------------------------------------------------------------------
// Node types
// ---------------------------------------------------------------------------

/**
 * All node categories supported by the unified {@link DiagnosticGraph}.
 *
 * | Type | Description |
 * |---|---|
 * | `resource` | A Kubernetes resource (Pod, Deployment, Secret, ConfigMap, …) |
 * | `event` | A Kubernetes Event |
 * | `log-chunk` | A slice of a log file (produced by the chunker) |
 * | `analyzer` | An analyzer result / bundle analyzer entry |
 * | `finding` | An investigation finding produced by an investigator |
 * | `workload-group` | A logical grouping of workloads (hierarchy middle layer) |
 * | `application-component` | Top-level application component derived from community detection (4.7 top layer) |
 */
export type DiagnosticNodeType =
  | 'resource'
  | 'event'
  | 'log-chunk'
  | 'analyzer'
  | 'finding'
  | 'workload-group'
  | 'application-component';

// ---------------------------------------------------------------------------
// Edge types
// ---------------------------------------------------------------------------

/**
 * All edge types supported by the unified {@link DiagnosticGraph}.
 *
 * ### Structural K8s edges (Phase A — deterministic, from K8s specs)
 * - `owner-reference` — Pod/RS → owning workload via metadata.ownerReferences
 * - `references-secret` — Pod → Secret (volumes, envFrom, env.valueFrom.secretKeyRef)
 * - `references-configmap` — Pod → ConfigMap
 * - `references-pvc` — Pod → PersistentVolumeClaim
 * - `event-target` — Event → involvedObject
 * - `label-selector` — Deployment/StatefulSet/DaemonSet → Pods matching selector
 * - `service-selector` — Service → Pods matching selector
 *
 * ### Causal / semantic edges (Phase B — investigator findings)
 * - `causes` — direct causal relationship (root cause → symptom)
 * - `supports` — evidence supporting a finding/hypothesis
 * - `contradicts` — evidence contradicting a finding/hypothesis
 * - `correlates` — correlated but no established causal direction
 * - `derived-from` — derived artifact (e.g. a finding derived from a log chunk)
 * - `contains` — membership/containment (e.g. application-component contains workload-group)
 *
 * ### Temporal edges (Phase C — temporal analysis)
 * - `temporal-correlation` — two events correlated in time
 * - `temporal-sequence` — one event strictly precedes another
 */
export type DiagnosticEdgeType =
  // Structural K8s edges
  | 'owner-reference'
  | 'references-secret'
  | 'references-configmap'
  | 'references-pvc'
  | 'event-target'
  | 'label-selector'
  | 'service-selector'
  // Causal / semantic edges
  | 'causes'
  | 'supports'
  | 'contradicts'
  | 'correlates'
  | 'derived-from'
  | 'contains'
  // Temporal edges
  | 'temporal-correlation'
  | 'temporal-sequence';

// ---------------------------------------------------------------------------
// DiagnosticGraphNode
// ---------------------------------------------------------------------------

/**
 * A node in the unified {@link DiagnosticGraph}.
 *
 * `data` carries the node-type-specific payload:
 * - `resource` / `event` nodes: `{ kind, name, namespace }` (compatible with {@link ResourceNode})
 * - `log-chunk` nodes: `{ artifactId, startLine, endLine }`
 * - `analyzer` nodes: `{ analyzerName, category? }`
 * - `finding` nodes: `{ title, severity?, confidence? }`
 * - `workload-group` nodes: `{ name, namespace, members? }`
 */
export interface DiagnosticGraphNode<T = unknown> {
  id: string;
  nodeType: DiagnosticNodeType;
  data: T;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// DiagnosticEdge
// ---------------------------------------------------------------------------

/**
 * A directed edge in the unified {@link DiagnosticGraph}.
 */
export interface DiagnosticEdge {
  /** Unique edge identifier. */
  id: string;
  /** Source node id. */
  source: string;
  /** Target node id. */
  target: string;
  /** Semantic type of the relationship. */
  type: DiagnosticEdgeType;
  /**
   * Optional weight in the range [0, 1].
   * Higher weight = stronger / more confident relationship.
   */
  weight?: number;
  /**
   * Traversal direction hint.
   * - `forward` — traverse source → target
   * - `backward` — traverse target → source
   * - `bidirectional` — traverse both directions
   */
  direction?: 'forward' | 'backward' | 'bidirectional';
  /** Human-readable note about this edge. */
  note?: string;
}

// ---------------------------------------------------------------------------
// DiagnosticGraph
// ---------------------------------------------------------------------------

/**
 * Unified diagnostic graph that combines:
 * - **Structural layer** (K8s spec edges from {@link buildDiagnosticGraph})
 * - **Causal layer** (investigator `causes` edges)
 * - **Semantic / temporal layer** (LLM-extracted triples, temporal correlations)
 *
 * All three layers use the same node/edge storage, enabling cross-layer
 * traversal queries.
 *
 * Backward-compatible with the {@link ResourceRelationshipGraph} interface via
 * {@link DiagnosticGraph.toResourceRelationshipGraph} and the standalone
 * {@link asResourceRelationshipGraph} adapter.
 */
export class DiagnosticGraph {
  private readonly _nodes = new Map<string, DiagnosticGraphNode>();
  private readonly _edges: DiagnosticEdge[] = [];

  // -------------------------------------------------------------------------
  // Mutation
  // -------------------------------------------------------------------------

  /** Add (or overwrite) a node. */
  addNode(node: DiagnosticGraphNode): void {
    this._nodes.set(node.id, node);
  }

  /** Append a directed edge. */
  addEdge(edge: DiagnosticEdge): void {
    this._edges.push(edge);
  }

  // -------------------------------------------------------------------------
  // Lookup
  // -------------------------------------------------------------------------

  /** Retrieve a node by id, or `undefined` if absent. */
  getNode(id: string): DiagnosticGraphNode | undefined {
    return this._nodes.get(id);
  }

  /** All nodes keyed by id. */
  get nodes(): Map<string, DiagnosticGraphNode> {
    return this._nodes;
  }

  /** All edges (read-only view). */
  get edges(): readonly DiagnosticEdge[] {
    return this._edges;
  }

  // -------------------------------------------------------------------------
  // Edge queries
  // -------------------------------------------------------------------------

  /** Returns all outgoing edges from `nodeId`. */
  getEdgesFrom(nodeId: string): DiagnosticEdge[] {
    return this._edges.filter((e) => e.source === nodeId);
  }

  /** Returns all incoming edges to `nodeId`. */
  getEdgesTo(nodeId: string): DiagnosticEdge[] {
    return this._edges.filter((e) => e.target === nodeId);
  }

  // -------------------------------------------------------------------------
  // Neighbor queries
  // -------------------------------------------------------------------------

  /**
   * Returns nodes reachable via outgoing edges from `nodeId`.
   * Nodes whose target id is absent in the graph are silently ignored.
   */
  getNeighbors(nodeId: string): DiagnosticGraphNode[] {
    return this.getEdgesFrom(nodeId)
      .map((e) => this._nodes.get(e.target))
      .filter((n): n is DiagnosticGraphNode => n !== undefined);
  }

  // -------------------------------------------------------------------------
  // Backward-compatibility adapter
  // -------------------------------------------------------------------------

  /**
   * Returns a {@link ResourceRelationshipGraph} view of this graph.
   *
   * Only `resource` and `event` nodes with `{ kind, name, namespace }` data
   * are included. Only the five legacy structural edge types are included
   * (`owner-reference`, `references-secret`, `references-configmap`,
   * `references-pvc`, `event-target`).
   *
   * Use this adapter to pass a `DiagnosticGraph` to functions that still
   * expect a `ResourceRelationshipGraph` (e.g. {@link getRelatedChunks}).
   */
  toResourceRelationshipGraph(): ResourceRelationshipGraph {
    return asResourceRelationshipGraph(this);
  }
}

// ---------------------------------------------------------------------------
// Internal helpers for buildDiagnosticGraph
// ---------------------------------------------------------------------------

/** Node id format: `{Kind}:{namespace}/{name}` — matches ResourceRelationshipGraph */
function diagNodeId(kind: string, namespace: string, name: string): string {
  return `${kind}:${namespace}/${name}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function getArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function addResourceNode(
  graph: DiagnosticGraph,
  kind: string,
  namespace: string,
  name: string,
  labels?: Record<string, string>,
): void {
  const id = diagNodeId(kind, namespace, name);
  if (!graph.getNode(id)) {
    graph.addNode({
      id,
      nodeType: 'resource',
      data: { kind, name, namespace },
      metadata: { kind, name, namespace, ...(labels ? { labels } : {}) },
    });
  }
}

let _edgeCounter = 0;
function nextEdgeId(type: string): string {
  return `${type}-${++_edgeCounter}`;
}

function addStructuralEdge(
  graph: DiagnosticGraph,
  sourceKind: string,
  sourceName: string,
  sourceNamespace: string,
  targetKind: string,
  targetName: string,
  targetNamespace: string,
  type: DiagnosticEdgeType,
): void {
  const sourceId = diagNodeId(sourceKind, sourceNamespace, sourceName);
  const targetId = diagNodeId(targetKind, targetNamespace, targetName);
  graph.addEdge({
    id: nextEdgeId(type),
    source: sourceId,
    target: targetId,
    type,
  });
}

// ---------------------------------------------------------------------------
// Label-matching helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when `podLabels` is a superset of `selector` (i.e. every
 * key-value pair in `selector` is present in `podLabels`).
 *
 * An empty selector (zero entries) is treated as "no match" to avoid
 * polluting the graph with spurious edges.
 */
function matchesLabelSelector(
  selector: Record<string, string>,
  podLabels: Record<string, string>,
): boolean {
  const entries = Object.entries(selector);
  if (entries.length === 0) return false;
  for (const [key, value] of entries) {
    if (podLabels[key] !== value) return false;
  }
  return true;
}

/**
 * Extracts `label-selector` edges from Deployment / StatefulSet / DaemonSet
 * resources to the Pods whose labels match each workload's
 * `spec.selector.matchLabels`.
 *
 * This works even when the intermediate ReplicaSet is absent from the bundle,
 * because it compares selectors directly against Pod labels rather than
 * relying on ownerReferences.
 */
function extractLabelSelectorEdges(resources: K8sResource[], graph: DiagnosticGraph): void {
  const workloadKinds = new Set(['Deployment', 'StatefulSet', 'DaemonSet']);
  const pods = resources.filter((r) => r.kind === 'Pod');

  for (const workload of resources) {
    if (!workloadKinds.has(workload.kind)) continue;

    const ns = workload.metadata.namespace ?? 'default';

    if (!isRecord(workload.spec)) continue;
    const spec = workload.spec as Record<string, unknown>;
    const selector = spec['selector'];
    if (!isRecord(selector)) continue;

    const matchLabels = selector['matchLabels'];
    if (!isRecord(matchLabels)) continue;
    // Convert to Record<string, string> by coercing values to strings
    const selectorLabels: Record<string, string> = {};
    for (const [k, v] of Object.entries(matchLabels)) {
      selectorLabels[k] = getString(v);
    }

    for (const pod of pods) {
      const podNs = pod.metadata.namespace ?? 'default';
      if (podNs !== ns) continue;
      const podLabels = (pod.metadata.labels as Record<string, string> | undefined) ?? {};
      if (matchesLabelSelector(selectorLabels, podLabels)) {
        addStructuralEdge(
          graph,
          workload.kind,
          workload.metadata.name,
          ns,
          'Pod',
          pod.metadata.name,
          podNs,
          'label-selector',
        );
      }
    }
  }
}

/**
 * Extracts `service-selector` edges from Service resources to the Pods whose
 * labels match the Service's `spec.selector`.
 *
 * Services with no selector (headless / ExternalName) produce no edges.
 */
function extractServiceSelectorEdges(resources: K8sResource[], graph: DiagnosticGraph): void {
  const pods = resources.filter((r) => r.kind === 'Pod');

  for (const service of resources) {
    if (service.kind !== 'Service') continue;

    const ns = service.metadata.namespace ?? 'default';

    if (!isRecord(service.spec)) continue;
    const spec = service.spec as Record<string, unknown>;
    const rawSelector = spec['selector'];
    if (!isRecord(rawSelector)) continue;

    // Convert to Record<string, string>
    const selectorLabels: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawSelector)) {
      selectorLabels[k] = getString(v);
    }

    for (const pod of pods) {
      const podNs = pod.metadata.namespace ?? 'default';
      if (podNs !== ns) continue;
      const podLabels = (pod.metadata.labels as Record<string, string> | undefined) ?? {};
      if (matchesLabelSelector(selectorLabels, podLabels)) {
        addStructuralEdge(
          graph,
          'Service',
          service.metadata.name,
          ns,
          'Pod',
          pod.metadata.name,
          podNs,
          'service-selector',
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Edge extractors (mirrors resource-graph.ts logic)
// ---------------------------------------------------------------------------

function extractOwnerReferenceEdgesDiag(resource: K8sResource, graph: DiagnosticGraph): void {
  const rawMeta = resource.metadata as unknown as Record<string, unknown>;
  const ownerRefs = getArray(rawMeta['ownerReferences']);
  const ns = resource.metadata.namespace ?? 'default';

  for (const ref of ownerRefs) {
    if (!isRecord(ref)) continue;
    const ownerKind = getString(ref['kind']);
    const ownerName = getString(ref['name']);
    if (!ownerKind || !ownerName) continue;

    const workloadKinds = new Set(['Deployment', 'StatefulSet', 'ReplicaSet', 'DaemonSet', 'Job', 'CronJob']);
    if (!workloadKinds.has(ownerKind)) continue;

    addResourceNode(graph, ownerKind, ns, ownerName);
    addStructuralEdge(graph, resource.kind, resource.metadata.name, ns, ownerKind, ownerName, ns, 'owner-reference');
  }
}

function extractPodSpecEdgesDiag(resource: K8sResource, graph: DiagnosticGraph): void {
  if (resource.kind !== 'Pod') return;

  const ns = resource.metadata.namespace ?? 'default';
  const podName = resource.metadata.name;

  if (!isRecord(resource.spec)) return;
  const spec = resource.spec as Record<string, unknown>;

  // spec.volumes
  for (const vol of getArray(spec['volumes'])) {
    if (!isRecord(vol)) continue;

    if (isRecord(vol['secret'])) {
      const secretName = getString(vol['secret']['secretName']);
      if (secretName) {
        addResourceNode(graph, 'Secret', ns, secretName);
        addStructuralEdge(graph, 'Pod', podName, ns, 'Secret', secretName, ns, 'references-secret');
      }
    }

    if (isRecord(vol['configMap'])) {
      const cmName = getString(vol['configMap']['name']);
      if (cmName) {
        addResourceNode(graph, 'ConfigMap', ns, cmName);
        addStructuralEdge(graph, 'Pod', podName, ns, 'ConfigMap', cmName, ns, 'references-configmap');
      }
    }

    if (isRecord(vol['persistentVolumeClaim'])) {
      const pvcName = getString(vol['persistentVolumeClaim']['claimName']);
      if (pvcName) {
        addResourceNode(graph, 'PersistentVolumeClaim', ns, pvcName);
        addStructuralEdge(graph, 'Pod', podName, ns, 'PersistentVolumeClaim', pvcName, ns, 'references-pvc');
      }
    }
  }

  // spec.containers / initContainers
  const allContainers = [
    ...getArray(spec['containers']),
    ...getArray(spec['initContainers']),
  ];

  for (const container of allContainers) {
    if (!isRecord(container)) continue;

    for (const envFrom of getArray(container['envFrom'])) {
      if (!isRecord(envFrom)) continue;

      if (isRecord(envFrom['secretRef'])) {
        const secretName = getString(envFrom['secretRef']['name']);
        if (secretName) {
          addResourceNode(graph, 'Secret', ns, secretName);
          addStructuralEdge(graph, 'Pod', podName, ns, 'Secret', secretName, ns, 'references-secret');
        }
      }

      if (isRecord(envFrom['configMapRef'])) {
        const cmName = getString(envFrom['configMapRef']['name']);
        if (cmName) {
          addResourceNode(graph, 'ConfigMap', ns, cmName);
          addStructuralEdge(graph, 'Pod', podName, ns, 'ConfigMap', cmName, ns, 'references-configmap');
        }
      }
    }

    for (const envVar of getArray(container['env'])) {
      if (!isRecord(envVar)) continue;
      if (!isRecord(envVar['valueFrom'])) continue;

      const vf = envVar['valueFrom'] as Record<string, unknown>;

      if (isRecord(vf['secretKeyRef'])) {
        const secretName = getString(vf['secretKeyRef']['name']);
        if (secretName) {
          addResourceNode(graph, 'Secret', ns, secretName);
          addStructuralEdge(graph, 'Pod', podName, ns, 'Secret', secretName, ns, 'references-secret');
        }
      }

      if (isRecord(vf['configMapKeyRef'])) {
        const cmName = getString(vf['configMapKeyRef']['name']);
        if (cmName) {
          addResourceNode(graph, 'ConfigMap', ns, cmName);
          addStructuralEdge(graph, 'Pod', podName, ns, 'ConfigMap', cmName, ns, 'references-configmap');
        }
      }
    }
  }
}

function extractEventEdgeDiag(event: K8sEvent, graph: DiagnosticGraph): void {
  const { kind, name, namespace } = event.involvedObject;
  const ns = namespace ?? 'default';

  // Ensure the involved object node exists as a resource node
  addResourceNode(graph, kind, ns, name);

  // Event node with the same synthetic id format as resource-graph.ts
  const eventId = `Event:${ns}/${event.reason}:${name}`;
  if (!graph.getNode(eventId)) {
    graph.addNode({
      id: eventId,
      nodeType: 'event',
      data: { kind: 'Event', name: `${event.reason}:${name}`, namespace: ns },
      metadata: {
        kind: 'Event',
        name: `${event.reason}:${name}`,
        namespace: ns,
        reason: event.reason,
        message: event.message,
      },
    });
  }

  graph.addEdge({
    id: nextEdgeId('event-target'),
    source: eventId,
    target: diagNodeId(kind, ns, name),
    type: 'event-target',
  });
}

// ---------------------------------------------------------------------------
// buildDiagnosticGraph
// ---------------------------------------------------------------------------

/**
 * Builds a {@link DiagnosticGraph} from K8s resources and events.
 *
 * The structural edges produced are identical to those from
 * {@link buildResourceGraph}:
 * - Pod → owner (Deployment/StatefulSet/ReplicaSet/DaemonSet) via ownerReferences
 * - Pod → Secret (volumes, envFrom, env.valueFrom.secretKeyRef)
 * - Pod → ConfigMap (volumes, envFrom, env.valueFrom.configMapKeyRef)
 * - Pod → PVC (volumes)
 * - Event → involvedObject
 *
 * Use {@link asResourceRelationshipGraph} or
 * {@link DiagnosticGraph.toResourceRelationshipGraph} to obtain a
 * `ResourceRelationshipGraph` compatible with {@link getRelatedChunks} and
 * other legacy consumers.
 */
export function buildDiagnosticGraph(
  resources: K8sResource[],
  events: K8sEvent[],
): DiagnosticGraph {
  const graph = new DiagnosticGraph();

  // Add all resources as nodes first
  for (const r of resources) {
    const ns = r.metadata.namespace ?? 'default';
    const labels = r.metadata.labels;
    addResourceNode(graph, r.kind, ns, r.metadata.name, labels);
  }

  // Extract edges from resources
  for (const r of resources) {
    extractOwnerReferenceEdgesDiag(r, graph);
    if (r.kind === 'Pod') {
      extractPodSpecEdgesDiag(r, graph);
    }
  }

  // Extract selector-based edges (requires all Pod nodes to already be present)
  extractLabelSelectorEdges(resources, graph);
  extractServiceSelectorEdges(resources, graph);

  // Extract event edges
  for (const e of events) {
    extractEventEdgeDiag(e, graph);
  }

  return graph;
}

// ---------------------------------------------------------------------------
// buildWorkloadGroups — hierarchical graph abstraction (4.7, middle layer)
// ---------------------------------------------------------------------------

/**
 * Workload kinds that generate a {@link WorkloadGroup} node.
 * Each Deployment, StatefulSet, and DaemonSet becomes one virtual aggregation
 * node that groups its constituent Pods and their dependent resources.
 */
const WORKLOAD_GROUP_KINDS = new Set(['Deployment', 'StatefulSet', 'DaemonSet']);

/**
 * Node id format for WorkloadGroup nodes.
 * `workload-group:{namespace}/{name}` — mirrors the pattern used for resource
 * nodes but uses the `workload-group:` prefix to avoid collisions.
 */
function workloadGroupNodeId(namespace: string, name: string): string {
  return `workload-group:${namespace}/${name}`;
}

/**
 * Builds **WorkloadGroup** virtual nodes in the {@link DiagnosticGraph}.
 *
 * A WorkloadGroup is a synthetic aggregation node that represents a
 * Deployment, StatefulSet, or DaemonSet together with all resources reachable
 * from it via structural edges:
 *
 * - Constituent **Pods** — discovered via existing `label-selector` edges
 *   (added by {@link buildDiagnosticGraph}) and, as a fallback, via
 *   `owner-reference` edges that point back to the workload.
 * - **Secrets** and **ConfigMaps** referenced by those pods — discovered via
 *   `references-secret`, `references-configmap`, and `references-pvc` edges.
 *
 * The following edges are added to the graph for each WorkloadGroup:
 *
 * | Edge type | Source | Target | Meaning |
 * |---|---|---|---|
 * | `derived-from` | WorkloadGroup | Deployment/StatefulSet/DaemonSet | WG is derived from this workload |
 * | `label-selector` | WorkloadGroup | Pod (for each constituent pod) | WG selects these pods |
 * | `service-selector` | Service | WorkloadGroup | Service routes to this workload |
 *
 * After calling this function, a traversal **starting at a WorkloadGroup node**
 * can answer "what's wrong with this deployment?" without enumerating individual
 * pods:
 * - Depth 1 forward: constituent Pods (via `label-selector`)
 * - Depth 2 forward: Secrets/ConfigMaps (via `references-secret`/`references-configmap`)
 * - Depth 1 backward: Services that expose the workload (via `service-selector`)
 *
 * @param graph A {@link DiagnosticGraph} that already has structural edges
 *   from {@link buildDiagnosticGraph} (or equivalent). The function mutates
 *   the graph in-place; it is safe to call multiple times (node overwrites are
 *   idempotent due to {@link DiagnosticGraph.addNode} semantics).
 */
export function buildWorkloadGroups(graph: DiagnosticGraph): void {
  // Step 1: Collect all workload nodes (Deployment, StatefulSet, DaemonSet)
  const workloadNodes = [...graph.nodes.values()].filter((n) => {
    if (n.nodeType !== 'resource') return false;
    const data = n.data as { kind?: string };
    return typeof data.kind === 'string' && WORKLOAD_GROUP_KINDS.has(data.kind);
  });

  if (workloadNodes.length === 0) return;

  // Snapshot existing edges to avoid processing newly-added edges during iteration
  const existingEdges = [...graph.edges];

  for (const workloadNode of workloadNodes) {
    const workloadData = workloadNode.data as { kind: string; name: string; namespace: string };
    const { name: workloadName, namespace } = workloadData;
    const wgId = workloadGroupNodeId(namespace, workloadName);

    // -----------------------------------------------------------------------
    // Step 2: Collect constituent Pod node IDs
    // -----------------------------------------------------------------------

    // a) Via label-selector edges: Workload → Pod (added by buildDiagnosticGraph)
    const podIdsFromLabelSelector = existingEdges
      .filter((e) => e.type === 'label-selector' && e.source === workloadNode.id)
      .map((e) => e.target);

    // b) Via owner-reference edges: Pod → Workload (pod is source, workload is target)
    const podIdsFromOwnerRef = existingEdges
      .filter((e) => e.type === 'owner-reference' && e.target === workloadNode.id)
      .map((e) => e.source);

    const allPodIdSet = new Set<string>([...podIdsFromLabelSelector, ...podIdsFromOwnerRef]);
    const allPodIds = [...allPodIdSet];

    // -----------------------------------------------------------------------
    // Step 3: Collect all member resource IDs
    // The members list represents all resources logically "part of" this workload.
    // -----------------------------------------------------------------------
    const memberIds = new Set<string>();
    // The workload itself is a member
    memberIds.add(workloadNode.id);
    // All constituent pods
    for (const podId of allPodIds) {
      memberIds.add(podId);
    }
    // Secrets, ConfigMaps, and PVCs referenced by the constituent pods
    for (const podId of allPodIds) {
      for (const edge of existingEdges) {
        if (edge.source !== podId) continue;
        if (
          edge.type === 'references-secret' ||
          edge.type === 'references-configmap' ||
          edge.type === 'references-pvc'
        ) {
          memberIds.add(edge.target);
        }
      }
    }

    // -----------------------------------------------------------------------
    // Step 4: Create the WorkloadGroup node
    // addNode() is idempotent — calling buildWorkloadGroups a second time
    // will overwrite the node with the same data (no duplication).
    // -----------------------------------------------------------------------
    graph.addNode({
      id: wgId,
      nodeType: 'workload-group',
      data: {
        name: workloadName,
        namespace,
        members: [...memberIds],
      },
      metadata: {
        kind: workloadData.kind,
        name: workloadName,
        namespace,
      },
    });

    // -----------------------------------------------------------------------
    // Step 5: derived-from edge — WorkloadGroup → Workload
    // -----------------------------------------------------------------------
    graph.addEdge({
      id: nextEdgeId('derived-from'),
      source: wgId,
      target: workloadNode.id,
      type: 'derived-from',
    });

    // -----------------------------------------------------------------------
    // Step 6: label-selector edges — WorkloadGroup → Pod (one per pod)
    // -----------------------------------------------------------------------
    for (const podId of allPodIds) {
      graph.addEdge({
        id: nextEdgeId('label-selector'),
        source: wgId,
        target: podId,
        type: 'label-selector',
      });
    }

    // -----------------------------------------------------------------------
    // Step 7: service-selector edges — Service → WorkloadGroup
    //
    // For every existing service-selector edge that points to one of our pods,
    // add a single Service → WorkloadGroup edge (deduplicating per service so
    // that a service selecting multiple pods still produces only one edge).
    // -----------------------------------------------------------------------
    const servicesConnectedToWg = new Set<string>();
    for (const edge of existingEdges) {
      if (edge.type !== 'service-selector') continue;
      if (!allPodIdSet.has(edge.target)) continue;
      if (servicesConnectedToWg.has(edge.source)) continue;
      servicesConnectedToWg.add(edge.source);
      graph.addEdge({
        id: nextEdgeId('service-selector'),
        source: edge.source, // Service node ID
        target: wgId,
        type: 'service-selector',
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Temporal correlation helpers
// ---------------------------------------------------------------------------

/**
 * Time window in milliseconds for temporal correlation between log chunks and
 * K8s events.  A log error within ±60 seconds of an event targeting the same
 * pod is considered temporally correlated.
 */
const TEMPORAL_CORRELATION_WINDOW_MS = 60_000;

/**
 * Known causal-affinity pairs between K8s event reason fields.
 * Format: `"{prior}|{following}"`.
 *
 * These pairs represent event sequences that are causally likely: the first
 * event reason often directly precedes (and causes) the second.  Used by
 * {@link addTemporalSequenceEdges} to filter which consecutive events warrant
 * a `temporal-sequence` edge.
 */
const CAUSAL_AFFINITY_PAIRS = new Set([
  'FailedMount|BackOff',
  'FailedMount|CrashLoopBackOff',
  'OOMKilling|BackOff',
  'ErrImagePull|ImagePullBackOff',
  'Unhealthy|Killing',
  'Killing|BackOff',
  'ProvisioningFailed|FailedMount',
  'Failed|BackOff',
]);

/** Returns true when `reason1` causally precedes `reason2` per the affinity table. */
function hasCausalAffinity(reason1: string, reason2: string): boolean {
  return CAUSAL_AFFINITY_PAIRS.has(`${reason1}|${reason2}`);
}

/**
 * Returns the effective timestamp for an event as milliseconds since epoch,
 * or `undefined` if no parseable timestamp is present.
 *
 * Prefers `firstTimestamp` over `lastTimestamp` for accuracy (mirrors the
 * logic in {@link sortEventsByTime}).
 */
function getEventTimestampMs(event: K8sEvent): number | undefined {
  const ts = event.firstTimestamp ?? event.lastTimestamp;
  if (!ts) return undefined;
  const ms = Date.parse(ts);
  return isNaN(ms) ? undefined : ms;
}

/** Node id format for log-chunk nodes: `log-chunk:{chunkId}` */
function logChunkNodeId(chunkId: string): string {
  return `log-chunk:${chunkId}`;
}

/**
 * Node id format for event nodes: `Event:{namespace}/{reason}:{involvedObject.name}`.
 *
 * Matches the format produced by {@link extractEventEdgeDiag} in
 * {@link buildDiagnosticGraph} so that {@link addTemporalCorrelationEdges}
 * and {@link addTemporalSequenceEdges} reuse nodes already added by the
 * structural builder rather than creating duplicates.
 */
function eventNodeIdForEvent(event: K8sEvent): string {
  const ns = event.involvedObject.namespace ?? 'default';
  return `Event:${ns}/${event.reason}:${event.involvedObject.name}`;
}

/**
 * Extracts the pod name encoded in a log chunk's `artifactId` path.
 *
 * Supports two path conventions:
 * 1. Real Troubleshoot bundle: `cluster-resources/pods/logs/{ns}/{pod}/{container}.log`
 * 2. Simplified test path: `logs/{ns}/{pod}/{container}.log`
 *
 * Returns `undefined` when the path does not match either convention.
 *
 * Callers may also supply an explicit `metadata.podName` string to override
 * path-based extraction (useful for synthetic chunks in tests or pipelines
 * that record pod provenance separately).
 */
function podNameFromChunk(chunk: IndexedChunk): string | undefined {
  // Explicit metadata override
  if (isRecord(chunk.metadata) && typeof chunk.metadata['podName'] === 'string') {
    return chunk.metadata['podName'];
  }
  // Path-based extraction: logs/{ns}/{pod}/{container}.log
  const normalizedPath = chunk.artifactId.replace(/\\/g, '/');
  const match = normalizedPath.match(
    /(?:^|\/)logs\/[^/]+\/([^/]+)\/[^/]+\.(?:log|txt)$/,
  );
  return match?.[1];
}

/**
 * Ensures a K8s event node exists in the graph and returns its id.
 *
 * If the node is already present (added by {@link buildDiagnosticGraph}),
 * it is returned unchanged.  If absent, a minimal `event` node is added.
 */
function ensureEventNode(graph: DiagnosticGraph, event: K8sEvent): string {
  const ns = event.involvedObject.namespace ?? 'default';
  const eventId = eventNodeIdForEvent(event);
  if (!graph.getNode(eventId)) {
    graph.addNode({
      id: eventId,
      nodeType: 'event',
      data: {
        kind: 'Event',
        name: `${event.reason}:${event.involvedObject.name}`,
        namespace: ns,
      },
      metadata: {
        kind: 'Event',
        name: `${event.reason}:${event.involvedObject.name}`,
        namespace: ns,
        reason: event.reason,
        message: event.message,
      },
    });
  }
  return eventId;
}

// ---------------------------------------------------------------------------
// addTemporalCorrelationEdges
// ---------------------------------------------------------------------------

/**
 * Wires the timeline module into the diagnostic graph by adding
 * **temporal-correlation** edges between log-chunk nodes and K8s event nodes.
 *
 * Algorithm (using `getEventWindow` + `correlateEventsWithPod` from
 * {@link parsers/timeline}):
 *
 * For each `logChunk` that carries a `timestamp`:
 * 1. Parse the chunk timestamp.
 * 2. Determine the pod name from the chunk's `artifactId` path (or
 *    `metadata.podName` override).
 * 3. Call `getEventWindow(events, T−60s, T+60s)` to find events within the
 *    ±60-second correlation window.
 * 4. Call `correlateEventsWithPod(windowEvents, podName)` to narrow to events
 *    targeting the same pod.
 * 5. For each matching event, ensure both the log-chunk node and the event
 *    node exist in the graph, then add a `temporal-correlation` edge.
 *
 * **Edge weight** encodes temporal proximity:
 * `weight = 1 − timeDeltaSeconds / 60`
 * so that `weight = 1.0` at zero delta and `weight = 0.0` at the 60-second
 * boundary.  Closer in time = stronger correlation.
 *
 * @param graph      The {@link DiagnosticGraph} to mutate.
 * @param logChunks  Indexed log chunks (must have `timestamp` to participate).
 * @param events     All K8s events from the bundle.
 */
export function addTemporalCorrelationEdges(
  graph: DiagnosticGraph,
  logChunks: IndexedChunk[],
  events: K8sEvent[],
): void {
  if (logChunks.length === 0 || events.length === 0) return;

  // Sort once so getEventWindow can use a binary-search-friendly order
  const sortedEvents = sortEventsByTime(events);

  for (const chunk of logChunks) {
    if (!chunk.timestamp) continue;

    const chunkTsMs = Date.parse(chunk.timestamp);
    if (isNaN(chunkTsMs)) continue;

    const podName = podNameFromChunk(chunk);
    if (!podName) continue;

    const windowStart = new Date(chunkTsMs - TEMPORAL_CORRELATION_WINDOW_MS);
    const windowEnd = new Date(chunkTsMs + TEMPORAL_CORRELATION_WINDOW_MS);

    // Use timeline module to get events in the time window …
    const windowEvents = getEventWindow(sortedEvents, windowStart, windowEnd);
    // … then narrow to events targeting the same pod
    const podEvents = correlateEventsWithPod(windowEvents, podName);

    if (podEvents.length === 0) continue;

    // Ensure the log-chunk node is present in the graph
    const chunkNodeId = logChunkNodeId(chunk.id);
    if (!graph.getNode(chunkNodeId)) {
      graph.addNode({
        id: chunkNodeId,
        nodeType: 'log-chunk',
        data: {
          artifactId: chunk.artifactId,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
        },
        metadata: {
          chunkId: chunk.id,
          artifactId: chunk.artifactId,
          timestamp: chunk.timestamp,
        },
      });
    }

    // Create a temporal-correlation edge for each matching event
    for (const event of podEvents) {
      const eventTsMs = getEventTimestampMs(event);
      if (eventTsMs === undefined) continue;

      const timeDeltaMs = Math.abs(chunkTsMs - eventTsMs);
      const timeDeltaSeconds = timeDeltaMs / 1000;
      // Closer in time = stronger weight (linear decay from 1.0 to 0.0)
      const weight = Math.max(0, 1 - timeDeltaSeconds / 60);

      const evNodeId = ensureEventNode(graph, event);

      graph.addEdge({
        id: nextEdgeId('temporal-correlation'),
        source: chunkNodeId,
        target: evNodeId,
        type: 'temporal-correlation',
        weight,
        note: `time delta: ${timeDeltaSeconds.toFixed(1)}s`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// addTemporalSequenceEdges
// ---------------------------------------------------------------------------

/**
 * Wires the timeline module into the diagnostic graph by adding
 * **temporal-sequence** edges between consecutive K8s events targeting the
 * same pod that exhibit causal affinity.
 *
 * Algorithm (using `sortEventsByTime` + `correlateEventsWithPod` from
 * {@link parsers/timeline}):
 *
 * 1. Filter to events whose `involvedObject.kind === 'Pod'`.
 * 2. Collect unique pod names across those events.
 * 3. For each pod, call `correlateEventsWithPod` and `sortEventsByTime` to
 *    get a chronologically-ordered list of that pod's events.
 * 4. For each consecutive pair `(prior, following)` that both have
 *    timestamps, check {@link hasCausalAffinity} — if true, add a
 *    `temporal-sequence` edge from `prior` → `following`.
 *
 * **Edge weight** encodes recency of sequence:
 * `weight = max(0.1, 1 − timeDeltaSeconds / 300)`
 * so that events ≤5 minutes apart get weight close to 1.0.
 *
 * Known causal-affinity pairs (see {@link CAUSAL_AFFINITY_PAIRS}):
 * - `FailedMount → BackOff`
 * - `FailedMount → CrashLoopBackOff`
 * - `ErrImagePull → ImagePullBackOff`
 * - `OOMKilling → BackOff`
 * - `Unhealthy → Killing`
 * - `Killing → BackOff`
 * - `ProvisioningFailed → FailedMount`
 * - `Failed → BackOff`
 *
 * @param graph  The {@link DiagnosticGraph} to mutate.
 * @param events All K8s events from the bundle.
 */
export function addTemporalSequenceEdges(
  graph: DiagnosticGraph,
  events: K8sEvent[],
): void {
  if (events.length < 2) return;

  // Only process events that target Pods
  const podEvents = events.filter((e) => e.involvedObject.kind === 'Pod');
  if (podEvents.length < 2) return;

  // Collect unique pod names
  const podNames = new Set(podEvents.map((e) => e.involvedObject.name));

  for (const podName of podNames) {
    // Get all events for this specific pod, sorted chronologically
    const podSpecificEvents = correlateEventsWithPod(podEvents, podName);
    const sortedPodEvents = sortEventsByTime(podSpecificEvents);

    // Discard events without a parseable timestamp
    const timestampedEvents = sortedPodEvents.filter(
      (e) => getEventTimestampMs(e) !== undefined,
    );

    if (timestampedEvents.length < 2) continue;

    // Create temporal-sequence edges for consecutive causally-affine pairs
    for (let i = 0; i < timestampedEvents.length - 1; i++) {
      const prior = timestampedEvents[i]!;
      const following = timestampedEvents[i + 1]!;

      if (!hasCausalAffinity(prior.reason, following.reason)) continue;

      const priorTs = getEventTimestampMs(prior)!;
      const followingTs = getEventTimestampMs(following)!;
      const timeDeltaSeconds = (followingTs - priorTs) / 1000;

      // Weight: 1.0 = immediate sequence, decays to 0.1 over 5 minutes
      const weight = Math.max(0.1, 1 - timeDeltaSeconds / 300);

      const priorNodeId = ensureEventNode(graph, prior);
      const followingNodeId = ensureEventNode(graph, following);

      graph.addEdge({
        id: nextEdgeId('temporal-sequence'),
        source: priorNodeId,
        target: followingNodeId,
        type: 'temporal-sequence',
        weight,
        note: `${prior.reason} → ${following.reason} (${timeDeltaSeconds.toFixed(1)}s)`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// asResourceRelationshipGraph — backward-compatibility adapter
// ---------------------------------------------------------------------------

/**
 * Set of {@link DiagnosticEdgeType}s that map 1:1 to legacy
 * {@link RelationshipType} values accepted by {@link ResourceRelationshipGraph}.
 */
const RESOURCE_RELATIONSHIP_EDGE_TYPES = new Set<DiagnosticEdgeType>([
  'owner-reference',
  'references-secret',
  'references-configmap',
  'references-pvc',
  'event-target',
]);

/**
 * Adapts a {@link DiagnosticGraph} to the {@link ResourceRelationshipGraph}
 * interface consumed by legacy callers such as {@link getRelatedChunks}.
 *
 * Only `resource` and `event` nodes are included (since `ResourceNode`
 * requires `{ kind, name, namespace }` data).  Only the five legacy
 * structural edge types are projected into `ResourceEdge[]`.
 */
export function asResourceRelationshipGraph(graph: DiagnosticGraph): ResourceRelationshipGraph {
  const nodes = new Map<string, ResourceNode>();
  const edges: ResourceEdge[] = [];

  // Project resource and event nodes
  for (const [id, node] of graph.nodes) {
    if (node.nodeType !== 'resource' && node.nodeType !== 'event') continue;
    const data = node.data as { kind: string; name: string; namespace: string };
    if (!data.kind || !data.name) continue;
    nodes.set(id, {
      kind: data.kind,
      name: data.name,
      namespace: data.namespace ?? '',
    });
  }

  // Project structural edges
  for (const edge of graph.edges) {
    if (!RESOURCE_RELATIONSHIP_EDGE_TYPES.has(edge.type)) continue;

    const sourceNode = graph.getNode(edge.source);
    const targetNode = graph.getNode(edge.target);
    if (!sourceNode || !targetNode) continue;

    const sData = sourceNode.data as { kind: string; name: string; namespace: string };
    const tData = targetNode.data as { kind: string; name: string; namespace: string };
    if (!sData.kind || !sData.name || !tData.kind || !tData.name) continue;

    edges.push({
      sourceKind: sData.kind,
      sourceName: sData.name,
      sourceNamespace: sData.namespace ?? '',
      targetKind: tData.kind,
      targetName: tData.name,
      targetNamespace: tData.namespace ?? '',
      relationshipType: edge.type as RelationshipType,
    });
  }

  return { nodes, edges };
}
