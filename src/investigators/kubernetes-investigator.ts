import type { Finding, FindingSeverity, Evidence, GraphEdge } from '../types/index.js';
import type { InvestigatorContext, InvestigatorResult, InvestigationSeed } from './types.js';
import type { K8sEvent, K8sResource } from '../types/index.js';
import {
  extractPodStatus,
  getContainerErrors,
  isWorkloadReady,
  filterEventsByObject,
} from '../parsers/index.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Returns the memory limit string for the named container from the pod spec.
 * Returns `undefined` when no limits are configured or the spec is absent.
 */
function getContainerMemoryLimit(resource: K8sResource, containerName: string): string | undefined {
  if (!isRecord(resource.spec)) return undefined;
  const containers = resource.spec['containers'];
  if (!Array.isArray(containers)) return undefined;
  for (const c of containers) {
    if (!isRecord(c)) continue;
    if (c['name'] !== containerName) continue;
    const resources = c['resources'];
    if (!isRecord(resources)) return undefined;
    const limits = resources['limits'];
    if (!isRecord(limits)) return undefined;
    const memory = limits['memory'];
    return typeof memory === 'string' ? memory : undefined;
  }
  return undefined;
}

/**
 * Returns the memory request string for the named container from the pod spec.
 * Returns `undefined` when no requests are configured or the spec is absent.
 */
function getContainerMemoryRequest(
  resource: K8sResource,
  containerName: string,
): string | undefined {
  if (!isRecord(resource.spec)) return undefined;
  const containers = resource.spec['containers'];
  if (!Array.isArray(containers)) return undefined;
  for (const c of containers) {
    if (!isRecord(c)) continue;
    if (c['name'] !== containerName) continue;
    const resources = c['resources'];
    if (!isRecord(resources)) return undefined;
    const requests = resources['requests'];
    if (!isRecord(requests)) return undefined;
    const memory = requests['memory'];
    return typeof memory === 'string' ? memory : undefined;
  }
  return undefined;
}

/**
 * Scans the raw container statuses for containers that were terminated with
 * reason `OOMKilled`.  Checks both the current `state` and the previous
 * `lastState` so that pods currently restarting (CrashLoopBackOff after OOM)
 * are also detected.
 *
 * Returns a descriptor per affected container.
 */
function getOOMKilledContainers(
  resource: K8sResource,
): Array<{ containerName: string; fromLastState: boolean }> {
  if (!isRecord(resource.status)) return [];
  const rawContainerStatuses = resource.status['containerStatuses'];
  if (!Array.isArray(rawContainerStatuses)) return [];

  const result: Array<{ containerName: string; fromLastState: boolean }> = [];

  for (const rawCs of rawContainerStatuses) {
    if (!isRecord(rawCs)) continue;
    const name = typeof rawCs['name'] === 'string' ? rawCs['name'] : '';
    if (!name) continue;

    // 1. Check current state (terminated)
    const currentState = rawCs['state'];
    if (isRecord(currentState)) {
      const terminated = currentState['terminated'];
      if (isRecord(terminated) && terminated['reason'] === 'OOMKilled') {
        result.push({ containerName: name, fromLastState: false });
        continue; // Don't also inspect lastState for the same container
      }
    }

    // 2. Check last state (previous termination — most common OOM-loop pattern)
    const lastState = rawCs['lastState'];
    if (isRecord(lastState)) {
      const terminated = lastState['terminated'];
      if (isRecord(terminated) && terminated['reason'] === 'OOMKilled') {
        result.push({ containerName: name, fromLastState: true });
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Node-condition helpers
// ---------------------------------------------------------------------------

/** Canonical path of a node resource file within a support bundle. */
function nodeFilePath(name: string): string {
  return `cluster-resources/nodes/${name}.yaml`;
}

interface RawNodeCondition {
  type: string;
  status: string;
  reason: string;
  message: string;
}

interface RawNodeTaint {
  key: string;
  value?: string;
  effect: string;
}

/**
 * Reads `status.conditions` from a Node resource.
 *
 * Returns an empty array for non-Node resources or nodes whose status lacks a
 * conditions array.
 */
function getNodeConditions(resource: K8sResource): RawNodeCondition[] {
  if (resource.kind !== 'Node') return [];
  if (!isRecord(resource.status)) return [];

  const rawConditions = resource.status['conditions'];
  if (!Array.isArray(rawConditions)) return [];

  const conditions: RawNodeCondition[] = [];
  for (const rawCond of rawConditions) {
    if (!isRecord(rawCond)) continue;
    conditions.push({
      type: typeof rawCond['type'] === 'string' ? rawCond['type'] : '',
      status: typeof rawCond['status'] === 'string' ? rawCond['status'] : '',
      reason: typeof rawCond['reason'] === 'string' ? rawCond['reason'] : '',
      message: typeof rawCond['message'] === 'string' ? rawCond['message'] : '',
    });
  }
  return conditions;
}

/** Reads `spec.taints` from a Node resource. */
function getNodeTaints(resource: K8sResource): RawNodeTaint[] {
  if (resource.kind !== 'Node') return [];
  if (!isRecord(resource.spec)) return [];

  const rawTaints = resource.spec['taints'];
  if (!Array.isArray(rawTaints)) return [];

  const taints: RawNodeTaint[] = [];
  for (const rawTaint of rawTaints) {
    if (!isRecord(rawTaint)) continue;
    const key = typeof rawTaint['key'] === 'string' ? rawTaint['key'] : '';
    const effect = typeof rawTaint['effect'] === 'string' ? rawTaint['effect'] : '';
    if (!key || !effect) continue;
    taints.push({
      key,
      value: typeof rawTaint['value'] === 'string' ? rawTaint['value'] : undefined,
      effect,
    });
  }
  return taints;
}

/** Parses a Kubernetes memory quantity string into bytes. Returns `undefined` on failure. */
function parseMemoryQuantity(value: string): number | undefined {
  const match = value.trim().match(/^([0-9]+(?:\.[0-9]+)?)([KMGTEP]i?|)$/);
  if (!match?.[1]) return undefined;

  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return undefined;

  const unit = match[2] ?? '';
  const multipliers: Record<string, number> = {
    '': 1,
    K: 1_000,
    M: 1_000_000,
    G: 1_000_000_000,
    T: 1_000_000_000_000,
    P: 1_000_000_000_000_000,
    Ki: 1024,
    Mi: 1024 ** 2,
    Gi: 1024 ** 3,
    Ti: 1024 ** 4,
    Pi: 1024 ** 5,
  };

  const multiplier = multipliers[unit];
  if (multiplier == null) return undefined;
  return amount * multiplier;
}

function getNodeMemoryRatio(resource: K8sResource): number | undefined {
  if (resource.kind !== 'Node' || !isRecord(resource.status)) return undefined;

  const capacity = resource.status['capacity'];
  const allocatable = resource.status['allocatable'];
  if (!isRecord(capacity) || !isRecord(allocatable)) return undefined;

  const capacityMemory = typeof capacity['memory'] === 'string' ? capacity['memory'] : undefined;
  const allocatableMemory = typeof allocatable['memory'] === 'string' ? allocatable['memory'] : undefined;
  if (capacityMemory == null || allocatableMemory == null) return undefined;

  const capacityBytes = parseMemoryQuantity(capacityMemory);
  const allocatableBytes = parseMemoryQuantity(allocatableMemory);
  if (capacityBytes == null || allocatableBytes == null || capacityBytes <= 0) return undefined;

  return allocatableBytes / capacityBytes;
}

function getPendingPods(resources: K8sResource[]): K8sResource[] {
  return resources.filter((resource) => {
    if (resource.kind !== 'Pod' || !isRecord(resource.status)) return false;
    return resource.status['phase'] === 'Pending';
  });
}

function podToleratesTaint(pod: K8sResource, taint: RawNodeTaint): boolean {
  if (!isRecord(pod.spec)) return false;
  const rawTolerations = pod.spec['tolerations'];
  if (!Array.isArray(rawTolerations)) return false;

  for (const rawTol of rawTolerations) {
    if (!isRecord(rawTol)) continue;

    const key = typeof rawTol['key'] === 'string' ? rawTol['key'] : '';
    const operator = typeof rawTol['operator'] === 'string' ? rawTol['operator'] : 'Equal';
    const effect = typeof rawTol['effect'] === 'string' ? rawTol['effect'] : undefined;
    const value = typeof rawTol['value'] === 'string' ? rawTol['value'] : undefined;

    if (effect != null && effect !== taint.effect) continue;

    // operator=Exists with an empty key tolerates all taint keys for the
    // matching effect; with a populated key it tolerates that specific key.
    if (operator === 'Exists' && (key === '' || key === taint.key)) return true;
    if (operator === 'Equal' && key === taint.key && (value ?? '') === (taint.value ?? '')) {
      return true;
    }
  }

  return false;
}

function failedSchedulingEventMentionsTaint(event: K8sEvent, taint: RawNodeTaint): boolean {
  const message = event.message.toLowerCase();
  if (!/taint|untolerated/.test(message)) return false;
  if (!message.includes(taint.key.toLowerCase())) return false;
  if (taint.value != null && taint.value.length > 0 && !message.includes(taint.value.toLowerCase())) {
    return false;
  }
  return true;
}

/**
 * Attempts to extract a Kubernetes Secret name from a FailedMount event message.
 *
 * Handles patterns such as:
 * - `secret "app-credentials" not found`
 * - `secret 'app-credentials' not found`
 * - `secret app-credentials not found`
 * - `for volume "vol": secret "app-credentials" not found`
 */
function extractSecretNameFromFailedMount(message: string): string | undefined {
  const dq = message.match(/secret\s+"([^"]+)"\s+not\s+found/i);
  if (dq?.[1]) return dq[1];
  const sq = message.match(/secret\s+'([^']+)'\s+not\s+found/i);
  if (sq?.[1]) return sq[1];
  const bare = message.match(/secret\s+([a-z0-9][a-z0-9-]*)\s+not\s+found/i);
  if (bare?.[1]) return bare[1];
  return undefined;
}

/**
 * Extracts the container image string from a Pod spec for the named container.
 *
 * Returns `undefined` if the spec is absent or the container is not found.
 */
function getContainerImage(resource: K8sResource, containerName: string): string | undefined {
  if (!isRecord(resource.spec)) return undefined;
  const containers = resource.spec['containers'];
  if (!Array.isArray(containers)) return undefined;
  for (const c of containers) {
    if (isRecord(c) && c['name'] === containerName) {
      return typeof c['image'] === 'string' ? c['image'] : undefined;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Bundle file-path conventions
// ---------------------------------------------------------------------------

/** Canonical path of a pod resource file within a support bundle. */
function podFilePath(name: string, namespace: string): string {
  return `cluster-resources/pods/${namespace}/${name}.yaml`;
}

/** Canonical path of a workload resource file within a support bundle. */
function workloadFilePath(kind: string, name: string, namespace: string): string {
  return `cluster-resources/${kind.toLowerCase()}s/${namespace}/${name}.yaml`;
}

/** Canonical path of a namespace events file within a support bundle. */
function eventsFilePath(namespace: string): string {
  return `cluster-resources/events/${namespace}.json`;
}

/** Canonical path of a PVC resource file within a support bundle. */
function pvcFilePath(name: string, namespace: string): string {
  return `cluster-resources/persistentvolumeclaims/${namespace}/${name}.yaml`;
}

// ---------------------------------------------------------------------------
// Confidence constants  [0, 1]
// ---------------------------------------------------------------------------

/** CrashLoopBackOff with corroborating events AND high restart count. */
const CONF_CRASHLOOP_FULL = 0.95;
/** CrashLoopBackOff with corroborating events only. */
const CONF_CRASHLOOP_EVENTS = 0.85;
/** CrashLoopBackOff inferred from pod status only (no events). */
const CONF_CRASHLOOP_BASE = 0.75;

/** ImagePullBackOff with corroborating events. */
const CONF_IMAGE_PULL_FULL = 0.95;
/** ImagePullBackOff inferred from pod status only (no events). */
const CONF_IMAGE_PULL_BASE = 0.80;

/** Not-ready pod with Unhealthy events. */
const CONF_NOT_READY_EVENTS = 0.75;
/** Not-ready pod — no corroborating events. */
const CONF_NOT_READY_BASE = 0.60;

/** Unhealthy workload (Deployment, StatefulSet, etc.). */
const CONF_WORKLOAD_BASE = 0.70;

/** Pending pod with ProvisioningFailed events (strongest signal). */
const CONF_PENDING_PROVISIONING = 0.90;
/** Pending pod with FailedMount or FailedScheduling events. */
const CONF_PENDING_EVENTS = 0.80;
/** Pending pod with no corroborating events. */
const CONF_PENDING_BASE = 0.65;

/** Container terminated with OOMKilled in the current state — highest certainty. */
const CONF_OOM_CURRENT_STATE = 0.95;
/** Container OOMKilled in the previous (last) terminated state — high certainty. */
const CONF_OOM_LAST_STATE = 0.85;

/** Node condition is unhealthy — e.g. NotReady, MemoryPressure, DiskPressure. */
const CONF_NODE_NOT_READY = 0.90;
const CONF_NODE_PRESSURE = 0.80;

// ---------------------------------------------------------------------------
// Workload kinds handled by isWorkloadReady
// ---------------------------------------------------------------------------

const WORKLOAD_KINDS = new Set(['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet']);

// ---------------------------------------------------------------------------
// Shared counter type
// ---------------------------------------------------------------------------

interface Counter {
  value: number;
}

function nextFindingId(prefix: string, counter: Counter): string {
  return `finding:k8s:${prefix}:${counter.value++}`;
}

function nextEdgeId(counter: Counter): string {
  return `edge:k8s:${counter.value++}`;
}

function filterPodEventsByNamespace(
  events: K8sEvent[],
  podName: string,
  namespace: string,
): K8sEvent[] {
  return filterEventsByObject(events, 'Pod', podName).filter(
    (event) => (event.involvedObject.namespace ?? 'default') === namespace,
  );
}

// ---------------------------------------------------------------------------
// 1. CrashLoopBackOff investigation
// ---------------------------------------------------------------------------

/**
 * Produces a `critical` {@link Finding} for every Pod whose container is in
 * `CrashLoopBackOff`.
 *
 * Evidence includes:
 * - The pod resource file (restart count + container state)
 * - BackOff events corroborating the restart loop
 * - FailedMount events indicating a missing Secret or ConfigMap
 */
function investigateCrashLoopPods(
  context: InvestigatorContext,
  counter: Counter,
): { findings: Finding[]; edges: GraphEdge[] } {
  const findings: Finding[] = [];
  const edges: GraphEdge[] = [];

  for (const resource of context.resources) {
    if (resource.kind !== 'Pod') continue;

    const containerErrors = getContainerErrors(resource);
    const crashLoop = containerErrors.find((e) => e.reason === 'CrashLoopBackOff');
    if (!crashLoop) continue;

    const podName = resource.metadata.name;
    const namespace = resource.metadata.namespace ?? 'default';
    const podStatus = extractPodStatus(resource);
    const restartCount = podStatus?.restartCount ?? 0;

    // Corroborating events
    const podEvents = filterPodEventsByNamespace(context.events, podName, namespace);
    const backOffEvents = podEvents.filter((e) => e.reason === 'BackOff');
    const failedMountEvents = podEvents.filter((e) => e.reason === 'FailedMount');

    // Evidence array
    const evidence: Evidence[] = [];
    const podPath = podFilePath(podName, namespace);
    const evPath = eventsFilePath(namespace);

    evidence.push({
      path: podPath,
      note: `Container '${crashLoop.container}' is in CrashLoopBackOff with ${restartCount} restarts`,
      artifactType: 'kubernetes-resource',
    });

    if (backOffEvents.length > 0) {
      const totalCount = backOffEvents.reduce((s, e) => s + (e.count ?? 1), 0);
      evidence.push({
        path: evPath,
        note: `BackOff events (total count: ${totalCount}): ${backOffEvents[0]!.message.slice(0, 120)}`,
        artifactType: 'event',
        timestamp: backOffEvents[0]!.firstTimestamp,
      });
    }

    if (failedMountEvents.length > 0) {
      evidence.push({
        path: evPath,
        note: `FailedMount events — missing Secret or ConfigMap: ${failedMountEvents[0]!.message.slice(0, 120)}`,
        artifactType: 'event',
        timestamp: failedMountEvents[0]!.firstTimestamp,
      });
    }

    // Confidence
    const hasEvents = backOffEvents.length > 0 || failedMountEvents.length > 0;
    let confidence: number;
    if (hasEvents && restartCount > 5) {
      confidence = CONF_CRASHLOOP_FULL;
    } else if (hasEvents) {
      confidence = CONF_CRASHLOOP_EVENTS;
    } else {
      confidence = CONF_CRASHLOOP_BASE;
    }

    // Recommended action
    let recommendedAction: string;
    if (failedMountEvents.length > 0) {
      recommendedAction =
        `A required Secret or ConfigMap appears to be missing in namespace '${namespace}'. ` +
        `Review FailedMount events, identify the missing resource, and create it. ` +
        `The container will resume once all required volumes and secrets are available.`;
    } else {
      recommendedAction =
        `Container '${crashLoop.container}' exits immediately on startup. ` +
        `Inspect the container logs with \`kubectl logs ${podName} -n ${namespace} --previous\` ` +
        `to find the root cause. Verify required environment variables, secrets, and configuration are present.`;
    }

    const findingId = nextFindingId('crashloop', counter);

    findings.push({
      id: findingId,
      title: `CrashLoopBackOff: Pod '${podName}' in namespace '${namespace}'`,
      severity: 'critical' as FindingSeverity,
      confidence,
      affectedComponents: [
        `Pod/${namespace}/${podName}`,
        `Container/${crashLoop.container}`,
      ],
      reasoningSummary:
        `Pod '${podName}' container '${crashLoop.container}' is in CrashLoopBackOff ` +
        `with ${restartCount} restarts.` +
        (backOffEvents.length > 0 ? ` BackOff events corroborate the restart loop.` : '') +
        (failedMountEvents.length > 0
          ? ` FailedMount events indicate a missing Secret or ConfigMap.`
          : ''),
      evidence,
      contradictionsChecked: [
        `Container '${crashLoop.container}' is not in a Running state — confirmed waiting in CrashLoopBackOff`,
        `Restart count is ${restartCount} (non-zero, confirming repeated crashes)`,
      ],
      recommendedAction,
      missingEvidence:
        backOffEvents.length === 0
          ? [`BackOff events for pod '${podName}' in namespace '${namespace}'`]
          : [],
    });

    // Graph edges: each evidence node supports the finding
    for (const ev of evidence) {
      edges.push({
        id: nextEdgeId(counter),
        source: `evidence:${ev.path}`,
        target: findingId,
        type: 'supports',
        weight: confidence,
      });
    }

    // Correlate BackOff ↔ FailedMount (same file, distinct event types)
    if (backOffEvents.length > 0 && failedMountEvents.length > 0) {
      edges.push({
        id: nextEdgeId(counter),
        source: `evidence:${evPath}:BackOff`,
        target: `evidence:${evPath}:FailedMount`,
        type: 'correlates',
        note: 'BackOff events correlate with FailedMount events, suggesting a missing resource causes container exits',
      });
    }

    // Causal chain: MissingSecret → FailedMount → CrashLoopBackOff
    // When FailedMount events mention a specific Secret, encode the root-cause chain.
    if (failedMountEvents.length > 0) {
      let secretAdded = false;
      for (const evt of failedMountEvents) {
        const secretName = extractSecretNameFromFailedMount(evt.message);
        if (secretName && !secretAdded) {
          const missingSecretNodeId = `finding:missing-secret:${secretName}:${namespace}`;
          const failedMountNodeId = `event:FailedMount:${podName}:${namespace}`;
          edges.push({
            id: nextEdgeId(counter),
            source: missingSecretNodeId,
            target: failedMountNodeId,
            type: 'causes',
            weight: 0.9,
            note: `Missing Secret '${secretName}' causes FailedMount on Pod '${podName}'`,
          });
          edges.push({
            id: nextEdgeId(counter),
            source: failedMountNodeId,
            target: findingId,
            type: 'causes',
            weight: 0.9,
            note: `FailedMount causes CrashLoopBackOff on Pod '${podName}'`,
          });
          secretAdded = true;
        }
      }
    }
  }

  return { findings, edges };
}

// ---------------------------------------------------------------------------
// 2. ImagePullBackOff investigation
// ---------------------------------------------------------------------------

/**
 * Produces a `critical` {@link Finding} for every Pod whose container is in
 * `ImagePullBackOff` or `ErrImagePull`.
 *
 * Evidence includes:
 * - The pod resource file (container state + image tag from spec)
 * - ErrImagePull events
 * - Failed (pull) events
 */
function investigateImagePullPods(
  context: InvestigatorContext,
  counter: Counter,
): { findings: Finding[]; edges: GraphEdge[] } {
  const findings: Finding[] = [];
  const edges: GraphEdge[] = [];

  for (const resource of context.resources) {
    if (resource.kind !== 'Pod') continue;

    const containerErrors = getContainerErrors(resource);
    const imagePullError = containerErrors.find(
      (e) => e.reason === 'ImagePullBackOff' || e.reason === 'ErrImagePull',
    );
    if (!imagePullError) continue;

    const podName = resource.metadata.name;
    const namespace = resource.metadata.namespace ?? 'default';
    const imageTag = getContainerImage(resource, imagePullError.container);

    // Corroborating events
    const podEvents = filterPodEventsByNamespace(context.events, podName, namespace);
    const errImagePullEvents = podEvents.filter((e) => e.reason === 'ErrImagePull');
    const failedPullEvents = podEvents.filter((e) => e.reason === 'Failed');

    // Evidence array
    const evidence: Evidence[] = [];
    const podPath = podFilePath(podName, namespace);
    const evPath = eventsFilePath(namespace);

    evidence.push({
      path: podPath,
      note:
        `Container '${imagePullError.container}' is in ${imagePullError.reason}` +
        (imageTag ? ` for image '${imageTag}'` : ''),
      artifactType: 'kubernetes-resource',
    });

    if (errImagePullEvents.length > 0) {
      evidence.push({
        path: evPath,
        note: `ErrImagePull events: ${errImagePullEvents[0]!.message.slice(0, 120)}`,
        artifactType: 'event',
        timestamp: errImagePullEvents[0]!.firstTimestamp,
      });
    }

    if (failedPullEvents.length > 0) {
      evidence.push({
        path: evPath,
        note: `Failed pull events: ${failedPullEvents[0]!.message.slice(0, 120)}`,
        artifactType: 'event',
        timestamp: failedPullEvents[0]!.firstTimestamp,
      });
    }

    // Confidence
    const hasEvents = errImagePullEvents.length > 0 || failedPullEvents.length > 0;
    const confidence = hasEvents ? CONF_IMAGE_PULL_FULL : CONF_IMAGE_PULL_BASE;

    const findingId = nextFindingId('imagepull', counter);

    findings.push({
      id: findingId,
      title:
        `ImagePullBackOff: Pod '${podName}' in namespace '${namespace}'` +
        (imageTag ? ` (image: ${imageTag})` : ''),
      severity: 'critical' as FindingSeverity,
      confidence,
      affectedComponents: [
        `Pod/${namespace}/${podName}`,
        `Container/${imagePullError.container}`,
        ...(imageTag ? [`Image/${imageTag}`] : []),
      ],
      reasoningSummary:
        `Pod '${podName}' container '${imagePullError.container}' cannot pull image` +
        (imageTag ? ` '${imageTag}'` : '') +
        `.` +
        (errImagePullEvents.length > 0 ? ` ErrImagePull events corroborate the failure.` : '') +
        (failedPullEvents.length > 0 ? ` Failed events confirm the image is not found.` : ''),
      evidence,
      contradictionsChecked: [
        `Container is not in Running state — confirmed waiting in ${imagePullError.reason}`,
        `Image${imageTag ? ` '${imageTag}'` : ''} cannot be retrieved from registry (confirmed by container waiting state)`,
      ],
      recommendedAction:
        `Verify image tag${imageTag ? ` '${imageTag}'` : ''} exists in the container registry. ` +
        `Check for typos in the image name or tag. ` +
        `If using a private registry, verify imagePullSecrets are configured correctly. ` +
        `Update the deployment to reference a valid image tag.`,
      missingEvidence:
        errImagePullEvents.length === 0 && failedPullEvents.length === 0
          ? [`ErrImagePull or Failed pull events for pod '${podName}'`]
          : [],
    });

    // Graph edges
    for (const ev of evidence) {
      edges.push({
        id: nextEdgeId(counter),
        source: `evidence:${ev.path}`,
        target: findingId,
        type: 'supports',
        weight: confidence,
      });
    }

    // Correlate ErrImagePull ↔ Failed events
    if (errImagePullEvents.length > 0 && failedPullEvents.length > 0) {
      edges.push({
        id: nextEdgeId(counter),
        source: `evidence:${evPath}:ErrImagePull`,
        target: `evidence:${evPath}:Failed`,
        type: 'correlates',
        note: 'ErrImagePull correlates with Failed pull events, indicating the image tag does not exist in the registry',
      });
    }

    // Causal chain: BadImageTag → ErrImagePull → ImagePullBackOff
    if (errImagePullEvents.length > 0 && imageTag) {
      const safeTag = imageTag.replace(/[^a-zA-Z0-9._:-]/g, '-');
      const badImageNodeId = `finding:bad-image-tag:${safeTag}:${namespace}`;
      const errImagePullNodeId = `event:ErrImagePull:${podName}:${namespace}`;
      edges.push({
        id: nextEdgeId(counter),
        source: badImageNodeId,
        target: errImagePullNodeId,
        type: 'causes',
        weight: 0.9,
        note: `Bad image tag '${imageTag}' causes ErrImagePull on Pod '${podName}'`,
      });
      edges.push({
        id: nextEdgeId(counter),
        source: errImagePullNodeId,
        target: findingId,
        type: 'causes',
        weight: 0.9,
        note: `ErrImagePull causes ImagePullBackOff on Pod '${podName}'`,
      });
    }
  }

  return { findings, edges };
}

// ---------------------------------------------------------------------------
// 3. Not-ready pod investigation (Running phase only)
// ---------------------------------------------------------------------------

/**
 * Produces a `high` {@link Finding} for pods that are in Running phase but
 * whose `Ready` condition is `False`, excluding pods already handled by the
 * CrashLoopBackOff or ImagePullBackOff detectors.
 *
 * Evidence includes:
 * - The pod resource file (conditions)
 * - Unhealthy events (readiness probe failures)
 */
function investigateNotReadyPods(
  context: InvestigatorContext,
  counter: Counter,
): { findings: Finding[]; edges: GraphEdge[] } {
  const findings: Finding[] = [];
  const edges: GraphEdge[] = [];

  for (const resource of context.resources) {
    if (resource.kind !== 'Pod') continue;

    const podStatus = extractPodStatus(resource);
    if (!podStatus) continue;
    if (podStatus.phase !== 'Running') continue;

    // Skip pods already handled by dedicated detectors
    const containerErrors = getContainerErrors(resource);
    const hasCriticalWaitState = containerErrors.some(
      (e) =>
        e.reason === 'CrashLoopBackOff' ||
        e.reason === 'ImagePullBackOff' ||
        e.reason === 'ErrImagePull',
    );
    if (hasCriticalWaitState) continue;

    // Only proceed when Ready=False
    const readyCond = podStatus.conditions.find((c) => c.type === 'Ready');
    if (!readyCond || readyCond.status !== 'False') continue;

    const podName = resource.metadata.name;
    const namespace = resource.metadata.namespace ?? 'default';

    // Corroborating events
    const podEvents = filterPodEventsByNamespace(context.events, podName, namespace);
    const unhealthyEvents = podEvents.filter((e) => e.reason === 'Unhealthy');

    // Evidence array
    const evidence: Evidence[] = [];
    const podPath = podFilePath(podName, namespace);
    const evPath = eventsFilePath(namespace);

    const readinessMsg = readyCond.message ?? 'Readiness condition is False';
    evidence.push({
      path: podPath,
      note: `Pod is Running but not Ready: ${readinessMsg}`,
      artifactType: 'kubernetes-resource',
    });

    if (unhealthyEvents.length > 0) {
      const totalCount = unhealthyEvents.reduce((s, e) => s + (e.count ?? 1), 0);
      evidence.push({
        path: evPath,
        note: `Unhealthy events — readiness probe failures (total count: ${totalCount}): ${unhealthyEvents[0]!.message.slice(0, 120)}`,
        artifactType: 'event',
        timestamp: unhealthyEvents[0]!.firstTimestamp,
      });
    }

    // Confidence
    const confidence = unhealthyEvents.length > 0 ? CONF_NOT_READY_EVENTS : CONF_NOT_READY_BASE;

    const findingId = nextFindingId('notready', counter);

    findings.push({
      id: findingId,
      title: `Not Ready Pod: '${podName}' in namespace '${namespace}' (Running but not Ready)`,
      severity: 'high' as FindingSeverity,
      confidence,
      affectedComponents: [`Pod/${namespace}/${podName}`],
      reasoningSummary:
        `Pod '${podName}' is in Running phase but the Ready condition is False.` +
        (unhealthyEvents.length > 0
          ? ` Unhealthy events confirm readiness probe failures.`
          : ` No Unhealthy events found — the pod may be initialising or have a dependency issue.`),
      evidence,
      contradictionsChecked: [
        `Pod phase is 'Running' — confirmed (not Pending or Completed)`,
        `Container is not in CrashLoopBackOff or ImagePullBackOff — handled by dedicated detectors`,
      ],
      recommendedAction:
        `Check the readiness probe configuration for pod '${podName}'. ` +
        `Inspect application logs for startup errors or dependency failures. ` +
        `Verify the application is listening on the expected port and path. ` +
        `If a dependency (e.g. database, cache) is unavailable, resolve that first.`,
      missingEvidence:
        unhealthyEvents.length === 0
          ? [`Unhealthy/readiness probe failure events for pod '${podName}'`]
          : [],
    });

    // Graph edges
    for (const ev of evidence) {
      edges.push({
        id: nextEdgeId(counter),
        source: `evidence:${ev.path}`,
        target: findingId,
        type: 'supports',
        weight: confidence,
      });
    }
  }

  return { findings, edges };
}

// ---------------------------------------------------------------------------
// 4. Pending Pod investigation
// ---------------------------------------------------------------------------

/**
 * Extracts the PVC claim names from a Pod's spec volumes.
 */
function getPodPvcClaimNames(resource: K8sResource): string[] {
  if (!isRecord(resource.spec)) return [];
  const volumes = resource.spec['volumes'];
  if (!Array.isArray(volumes)) return [];

  const claimNames: string[] = [];
  for (const volume of volumes) {
    if (!isRecord(volume)) continue;
    const pvc = volume['persistentVolumeClaim'];
    if (isRecord(pvc) && typeof pvc['claimName'] === 'string') {
      claimNames.push(pvc['claimName']);
    }
  }
  return claimNames;
}

/**
 * Produces a `critical` {@link Finding} for every Pod that is stuck in
 * `Pending` or `ContainerCreating` state, excluding pods already handled by
 * the CrashLoopBackOff or ImagePullBackOff detectors.
 *
 * Evidence includes:
 * - The pod resource file
 * - FailedMount, FailedScheduling events for the pod
 * - ProvisioningFailed events for any PVC referenced by the pod's volumes
 * - The PVC resource file if applicable
 */
function investigatePendingPods(
  context: InvestigatorContext,
  counter: Counter,
): { findings: Finding[]; edges: GraphEdge[] } {
  const findings: Finding[] = [];
  const edges: GraphEdge[] = [];

  for (const resource of context.resources) {
    if (resource.kind !== 'Pod') continue;

    const podStatus = extractPodStatus(resource);
    if (!podStatus) continue;

    // Check if pod is pending or a container is in ContainerCreating
    const containerErrors = getContainerErrors(resource);
    const isContainerCreating = containerErrors.some((e) => e.reason === 'ContainerCreating');
    const isPending = podStatus.phase === 'Pending';

    if (!isPending && !isContainerCreating) continue;

    // Skip pods already handled by dedicated detectors
    const hasCriticalWaitState = containerErrors.some(
      (e) =>
        e.reason === 'CrashLoopBackOff' ||
        e.reason === 'ImagePullBackOff' ||
        e.reason === 'ErrImagePull',
    );
    if (hasCriticalWaitState) continue;

    const podName = resource.metadata.name;
    const namespace = resource.metadata.namespace ?? 'default';
    const podPath = podFilePath(podName, namespace);
    const evPath = eventsFilePath(namespace);

    // Corroborating events for this pod
    const podEvents = filterPodEventsByNamespace(context.events, podName, namespace);
    const failedMountEvents = podEvents.filter((e) => e.reason === 'FailedMount');
    const failedSchedulingEvents = podEvents.filter((e) => e.reason === 'FailedScheduling');

    // ProvisioningFailed events for referenced PVCs
    const pvcClaimNames = getPodPvcClaimNames(resource);
    const provisioningFailedEvents: K8sEvent[] = [];
    for (const claimName of pvcClaimNames) {
      const pvcEvents = filterEventsByObject(context.events, 'PersistentVolumeClaim', claimName)
        .filter((e) => (e.involvedObject.namespace ?? 'default') === namespace)
        .filter((e) => e.reason === 'ProvisioningFailed');
      provisioningFailedEvents.push(...pvcEvents);
    }

    // Find first ProvisioningFailed message to extract StorageClass info
    const firstProvFailEvent = provisioningFailedEvents[0];
    let storageClassHint: string | undefined;
    if (firstProvFailEvent) {
      const scMatch = firstProvFailEvent.message.match(/["']([^"']+)['"]\s+not\s+found/i);
      storageClassHint = scMatch?.[1];
    }

    // Resolve the most relevant PVC name for titles/evidence.
    // Prefer the PVC named directly by a ProvisioningFailed event, then fall
    // back to the first referenced claim from the pod spec.
    let failedPvcName: string | undefined;
    if (firstProvFailEvent?.involvedObject.name != null) {
      failedPvcName = firstProvFailEvent.involvedObject.name;
    } else if (pvcClaimNames.length > 0) {
      failedPvcName = pvcClaimNames[0];
    }

    // Evidence array
    const evidence: Evidence[] = [];

    const containerCreating = containerErrors.find((e) => e.reason === 'ContainerCreating');
    evidence.push({
      path: podPath,
      note: containerCreating
        ? `Container '${containerCreating.container}' is waiting in ContainerCreating — volume not yet available`
        : `Pod '${podName}' is in Pending phase`,
      artifactType: 'kubernetes-resource',
    });

    if (failedMountEvents.length > 0) {
      const totalCount = failedMountEvents.reduce((s, e) => s + (e.count ?? 1), 0);
      evidence.push({
        path: evPath,
        note: `FailedMount events (total count: ${totalCount}): ${failedMountEvents[0]!.message.slice(0, 120)}`,
        artifactType: 'event',
        timestamp: failedMountEvents[0]!.firstTimestamp,
      });
    }

    if (failedSchedulingEvents.length > 0) {
      evidence.push({
        path: evPath,
        note: `FailedScheduling events: ${failedSchedulingEvents[0]!.message.slice(0, 120)}`,
        artifactType: 'event',
        timestamp: failedSchedulingEvents[0]!.firstTimestamp,
      });
    }

    if (provisioningFailedEvents.length > 0) {
      const totalCount = provisioningFailedEvents.reduce((s, e) => s + (e.count ?? 1), 0);
      evidence.push({
        path: evPath,
        note: `ProvisioningFailed events on PVC (total count: ${totalCount}): ${provisioningFailedEvents[0]!.message.slice(0, 120)}`,
        artifactType: 'event',
        timestamp: provisioningFailedEvents[0]!.firstTimestamp,
      });
    }

    // Include PVC resource file if applicable
    if (failedPvcName != null) {
      evidence.push({
        path: pvcFilePath(failedPvcName, namespace),
        note: `PVC '${failedPvcName}' referenced by pod '${podName}' — check its status and storageClassName`,
        artifactType: 'kubernetes-resource',
      });
    }

    // Confidence
    let confidence: number;
    if (provisioningFailedEvents.length > 0) {
      confidence = CONF_PENDING_PROVISIONING;
    } else if (failedMountEvents.length > 0 || failedSchedulingEvents.length > 0) {
      confidence = CONF_PENDING_EVENTS;
    } else {
      confidence = CONF_PENDING_BASE;
    }

    // Build a descriptive title
    let title: string;
    if (firstProvFailEvent != null && failedPvcName != null && storageClassHint != null) {
      title = `Pending Pod: '${podName}' in namespace '${namespace}' — PVC '${failedPvcName}' cannot provision (StorageClass '${storageClassHint}' not found)`;
    } else if (firstProvFailEvent != null && failedPvcName != null) {
      title = `Pending Pod: '${podName}' in namespace '${namespace}' — PVC '${failedPvcName}' cannot provision`;
    } else if (failedMountEvents.length > 0) {
      title = `Pending Pod: '${podName}' in namespace '${namespace}' — volume mount failure`;
    } else if (failedSchedulingEvents.length > 0) {
      title = `Pending Pod: '${podName}' in namespace '${namespace}' — scheduling failure`;
    } else {
      title = `Pending Pod: '${podName}' in namespace '${namespace}' — stuck in Pending/ContainerCreating`;
    }

    const affectedComponents: string[] = [`Pod/${namespace}/${podName}`];
    if (failedPvcName != null) {
      affectedComponents.push(`PersistentVolumeClaim/${namespace}/${failedPvcName}`);
    }

    const missingEvidence: string[] = [];
    if (provisioningFailedEvents.length === 0 && pvcClaimNames.length > 0) {
      missingEvidence.push(
        `ProvisioningFailed events for PVC '${pvcClaimNames[0]}' in namespace '${namespace}'`,
      );
    }
    if (provisioningFailedEvents.length === 0 && failedMountEvents.length === 0) {
      missingEvidence.push(
        `FailedMount or ProvisioningFailed events for pod '${podName}' in namespace '${namespace}'`,
      );
    }

    let recommendedAction: string;
    if (storageClassHint != null) {
      recommendedAction =
        `StorageClass '${storageClassHint}' referenced by PVC does not exist. ` +
        `Create the StorageClass or update the PVC to reference an available StorageClass. ` +
        `Check available storage classes with \`kubectl get storageclass\`.`;
    } else {
      recommendedAction =
        `Pod '${podName}' is stuck in Pending/ContainerCreating due to a volume issue. ` +
        `Check PVC status with \`kubectl get pvc -n ${namespace}\`, ` +
        `verify StorageClass availability, and inspect provisioner logs.`;
    }

    const findingId = nextFindingId('pending', counter);

    findings.push({
      id: findingId,
      title,
      severity: 'critical' as FindingSeverity,
      confidence,
      affectedComponents,
      reasoningSummary:
        `Pod '${podName}' is stuck in Pending/ContainerCreating in namespace '${namespace}'.` +
        (provisioningFailedEvents.length > 0
          ? ` ProvisioningFailed events confirm the PVC cannot be provisioned.`
          : '') +
        (failedMountEvents.length > 0
          ? ` FailedMount events indicate a volume cannot be attached or mounted.`
          : '') +
        (failedSchedulingEvents.length > 0
          ? ` FailedScheduling events indicate the pod cannot be scheduled.`
          : '') +
        (storageClassHint != null
          ? ` StorageClass '${storageClassHint}' is referenced but does not exist.`
          : ''),
      evidence,
      contradictionsChecked: [
        `Pod phase is '${podStatus.phase}' — confirmed (not Running or Completed)`,
        `Container is not in CrashLoopBackOff or ImagePullBackOff — handled by dedicated detectors`,
      ],
      recommendedAction,
      missingEvidence,
    });

    // Graph edges
    for (const ev of evidence) {
      edges.push({
        id: nextEdgeId(counter),
        source: `evidence:${ev.path}`,
        target: findingId,
        type: 'supports',
        weight: confidence,
      });
    }

    // Correlate FailedMount ↔ ProvisioningFailed
    if (failedMountEvents.length > 0 && provisioningFailedEvents.length > 0) {
      edges.push({
        id: nextEdgeId(counter),
        source: `evidence:${evPath}:FailedMount`,
        target: `evidence:${evPath}:ProvisioningFailed`,
        type: 'correlates',
        note: 'FailedMount events correlate with ProvisioningFailed events, indicating PVC cannot be provisioned',
      });
    }

    // Causal chain: MissingStorageClass → ProvisioningFailed → FailedMount → PodPending
    if (provisioningFailedEvents.length > 0 && storageClassHint != null && failedPvcName != null) {
      const missingScNodeId = `finding:missing-storage-class:${storageClassHint}:${namespace}`;
      const provisioningFailedNodeId = `event:ProvisioningFailed:${failedPvcName}:${namespace}`;
      const failedMountNodeId = `event:FailedMount:${podName}:${namespace}`;
      edges.push({
        id: nextEdgeId(counter),
        source: missingScNodeId,
        target: provisioningFailedNodeId,
        type: 'causes',
        weight: 0.9,
        note: `Missing StorageClass '${storageClassHint}' causes ProvisioningFailed for PVC '${failedPvcName}'`,
      });
      edges.push({
        id: nextEdgeId(counter),
        source: provisioningFailedNodeId,
        target: failedMountNodeId,
        type: 'causes',
        weight: 0.9,
        note: `ProvisioningFailed causes FailedMount on Pod '${podName}'`,
      });
      edges.push({
        id: nextEdgeId(counter),
        source: failedMountNodeId,
        target: findingId,
        type: 'causes',
        weight: 0.9,
        note: `FailedMount causes Pod '${podName}' to be stuck in Pending`,
      });
    }
  }

  return { findings, edges };
}

// ---------------------------------------------------------------------------
// 5. Unhealthy workload investigation
// ---------------------------------------------------------------------------

/**
 * Produces a `high` {@link Finding} for every workload (Deployment,
 * StatefulSet, DaemonSet, ReplicaSet) where {@link isWorkloadReady} returns
 * `false`.
 */
function investigateWorkloads(
  context: InvestigatorContext,
  counter: Counter,
): { findings: Finding[]; edges: GraphEdge[] } {
  const findings: Finding[] = [];
  const edges: GraphEdge[] = [];

  for (const resource of context.resources) {
    if (!WORKLOAD_KINDS.has(resource.kind)) continue;
    if (isWorkloadReady(resource)) continue;

    const name = resource.metadata.name;
    const namespace = resource.metadata.namespace ?? 'default';
    const kind = resource.kind;

    const wPath = workloadFilePath(kind, name, namespace);
    const evidence: Evidence[] = [
      {
        path: wPath,
        note: `${kind} '${name}' in namespace '${namespace}' does not have enough ready replicas`,
        artifactType: 'kubernetes-resource',
      },
    ];

    const findingId = nextFindingId('workload', counter);

    findings.push({
      id: findingId,
      title: `Unhealthy Workload: ${kind} '${name}' in namespace '${namespace}'`,
      severity: 'high' as FindingSeverity,
      confidence: CONF_WORKLOAD_BASE,
      affectedComponents: [`${kind}/${namespace}/${name}`],
      reasoningSummary:
        `${kind} '${name}' does not have the expected number of ready replicas. ` +
        `This may indicate underlying pod failures.`,
      evidence,
      contradictionsChecked: [
        `${kind} '${name}' status fields confirm insufficient ready replicas`,
      ],
      recommendedAction:
        `Inspect the pods belonging to ${kind} '${name}' in namespace '${namespace}'. ` +
        `Check for pod failures, resource constraints, or scheduling issues. ` +
        `Review deployment events for rollout failures. ` +
        `Use \`kubectl describe ${kind.toLowerCase()} ${name} -n ${namespace}\` for details.`,
      missingEvidence: [],
    });

    edges.push({
      id: nextEdgeId(counter),
      source: `evidence:${wPath}`,
      target: findingId,
      type: 'supports',
      weight: CONF_WORKLOAD_BASE,
    });
  }

  return { findings, edges };
}

// ---------------------------------------------------------------------------
// 6. OOM investigation
// ---------------------------------------------------------------------------

/**
 * Produces a `high` {@link Finding} for every container that was terminated
 * with reason `OOMKilled` — either in the current state or the previous
 * (last) terminated state.
 *
 * Evidence includes:
 * - The pod resource file with configured memory limit and request
 *
 * Causal edges created when the pod is also in `CrashLoopBackOff`:
 * - OOM finding → `event:ContainerRestart` → CrashLoopBackOff finding
 *
 * @param crashloopFindingByPod Maps `"namespace/podName"` to the CrashLoopBackOff
 *   finding ID so causal edges can be linked across detectors.
 */
function investigateOOMPods(
  context: InvestigatorContext,
  counter: Counter,
  crashloopFindingByPod: Map<string, string>,
): { findings: Finding[]; edges: GraphEdge[]; findingIdsByNode: Map<string, string[]> } {
  const findings: Finding[] = [];
  const edges: GraphEdge[] = [];
  const findingIdsByNode = new Map<string, string[]>();

  for (const resource of context.resources) {
    if (resource.kind !== 'Pod') continue;

    const oomContainers = getOOMKilledContainers(resource);
    if (oomContainers.length === 0) continue;

    const podName = resource.metadata.name;
    const namespace = resource.metadata.namespace ?? 'default';
    const podPath = podFilePath(podName, namespace);

    for (const { containerName, fromLastState } of oomContainers) {
      const memoryLimit = getContainerMemoryLimit(resource, containerName);
      const memoryRequest = getContainerMemoryRequest(resource, containerName);
      const confidence = fromLastState ? CONF_OOM_LAST_STATE : CONF_OOM_CURRENT_STATE;

      const limitSuffix = memoryLimit ? ` (limit: ${memoryLimit})` : '';
      const title = `Container '${containerName}' in Pod '${podName}' was OOMKilled${limitSuffix}`;

      const evidence: Evidence[] = [
        {
          path: podPath,
          note:
            `Container '${containerName}' was terminated with OOMKilled` +
            (memoryLimit ? ` — memory limit: ${memoryLimit}` : ' — no memory limit configured'),
          artifactType: 'kubernetes-resource',
        },
      ];

      // If both request and limit are known, include a comparison note
      if (memoryRequest && memoryLimit) {
        evidence.push({
          path: podPath,
          note: `Memory request: ${memoryRequest}, limit: ${memoryLimit} — container exceeded its limit; consider increasing or profiling usage`,
          artifactType: 'kubernetes-resource',
        });
      }

      const findingId = nextFindingId('oom', counter);
      const nodeName =
        isRecord(resource.spec) && typeof resource.spec['nodeName'] === 'string'
          ? resource.spec['nodeName']
          : undefined;
      if (nodeName) {
        const existing = findingIdsByNode.get(nodeName) ?? [];
        existing.push(findingId);
        findingIdsByNode.set(nodeName, existing);
      }

      findings.push({
        id: findingId,
        title,
        severity: 'high' as FindingSeverity,
        confidence,
        affectedComponents: [`Pod/${namespace}/${podName}`, `Container/${containerName}`],
        reasoningSummary:
          `Container '${containerName}' in pod '${podName}' (namespace '${namespace}') was OOMKilled.` +
          (memoryLimit ? ` Memory limit is ${memoryLimit}.` : ' No memory limit is configured.') +
          (fromLastState
            ? ` The container is currently restarting (OOMKilled detected in last terminated state).`
            : ` The container is in a terminated OOMKilled state.`),
        evidence,
        contradictionsChecked: [
          `OOMKilled exit reason confirmed in container ${fromLastState ? 'last state' : 'current state'}`,
          memoryLimit
            ? `Memory limit ${memoryLimit} was insufficient for the container's working set`
            : 'No memory limit configured — container consumed unbounded memory until killed',
        ],
        recommendedAction:
          `Container '${containerName}' ran out of memory` +
          (memoryLimit ? ` (limit: ${memoryLimit})` : '') +
          `. ` +
          `Inspect application memory usage and increase the container memory limit. ` +
          `Check for memory leaks or unbounded caching in the application. ` +
          `Consider setting both requests and limits to prevent resource contention.`,
        missingEvidence: [],
      });

      // Graph edge: evidence supports finding
      edges.push({
        id: nextEdgeId(counter),
        source: `evidence:${podPath}`,
        target: findingId,
        type: 'supports',
        weight: confidence,
      });

      // Causal chain when OOMKill caused a CrashLoopBackOff restart cycle:
      // OOM finding → event:ContainerRestart → CrashLoopBackOff finding
      if (fromLastState) {
        const containerRestartNodeId = `event:ContainerRestart:${containerName}:${podName}:${namespace}`;

        // OOM finding → ContainerRestart event node
        edges.push({
          id: nextEdgeId(counter),
          source: findingId,
          target: containerRestartNodeId,
          type: 'causes',
          weight: 0.9,
          note: `OOMKill caused container restart for '${containerName}' in pod '${podName}'`,
        });

        // ContainerRestart event node → CrashLoopBackOff finding (if present)
        const podKey = `${namespace}/${podName}`;
        const crashloopFindingId = crashloopFindingByPod.get(podKey);
        if (crashloopFindingId) {
          edges.push({
            id: nextEdgeId(counter),
            source: containerRestartNodeId,
            target: crashloopFindingId,
            type: 'causes',
            weight: 0.9,
            note: `Container restart (from OOMKill) led to CrashLoopBackOff for pod '${podName}'`,
          });
        }
      }
    }
  }

  return { findings, edges, findingIdsByNode };
}

// ---------------------------------------------------------------------------
// 7. Node resource / taint investigation
// ---------------------------------------------------------------------------

/**
 * Produces findings for node-level resource constraints and unschedulable taints.
 *
 * - Allocatable memory < 80% of capacity → medium finding about node memory reservation
 * - `NoSchedule` / `NoExecute` taints that block pending pods lacking tolerations
 *   → high finding plus causal edges to FailedScheduling event nodes
 */
function investigateNodeResources(
  context: InvestigatorContext,
  counter: Counter,
): { findings: Finding[]; edges: GraphEdge[] } {
  const findings: Finding[] = [];
  const edges: GraphEdge[] = [];
  const pendingPods = getPendingPods(context.resources);
  const failedSchedulingByPodKey = new Map<string, K8sEvent[]>();

  for (const event of context.events) {
    if (event.reason !== 'FailedScheduling' || event.involvedObject.kind !== 'Pod') continue;
    const namespace = event.involvedObject.namespace ?? 'default';
    const key = `${namespace}/${event.involvedObject.name}`;
    const bucket = failedSchedulingByPodKey.get(key) ?? [];
    bucket.push(event);
    failedSchedulingByPodKey.set(key, bucket);
  }

  for (const resource of context.resources) {
    if (resource.kind !== 'Node') continue;

    const nodeName = resource.metadata.name;
    const nodePath = nodeFilePath(nodeName);

    const memoryRatio = getNodeMemoryRatio(resource);
    if (memoryRatio != null && memoryRatio < 0.8 && isRecord(resource.status)) {
      const capacity = isRecord(resource.status['capacity'])
        ? resource.status['capacity']
        : undefined;
      const allocatable = isRecord(resource.status['allocatable'])
        ? resource.status['allocatable']
        : undefined;
      const capacityMemory = typeof capacity?.['memory'] === 'string' ? capacity['memory'] : 'unknown';
      const allocatableMemory = typeof allocatable?.['memory'] === 'string'
        ? allocatable['memory']
        : 'unknown';
      const findingId = nextFindingId('node-resource', counter);
      const percentage = Math.round(memoryRatio * 100);

      findings.push({
        id: findingId,
        title:
          `Node '${nodeName}' has constrained allocatable memory ` +
          `(${allocatableMemory} allocatable of ${capacityMemory} capacity)`,
        severity: 'medium',
        confidence: 0.75,
        affectedComponents: [`Node/${nodeName}`],
        reasoningSummary:
          `Node '${nodeName}' exposes only ${percentage}% of its memory capacity as allocatable ` +
          `(${allocatableMemory} of ${capacityMemory}). This can indicate heavy kube/system reservation ` +
          `or node-level resource pressure that reduces scheduling headroom for workloads.`,
        evidence: [
          {
            path: nodePath,
            note:
              `Node allocatable memory is ${allocatableMemory} while capacity is ${capacityMemory} ` +
              `(${percentage}% allocatable)`,
            artifactType: 'kubernetes-resource',
          },
        ],
        contradictionsChecked: [
          `Node '${nodeName}' capacity/allocatable memory values were present in node status`,
        ],
        recommendedAction:
          `Review reservations and workload density on node '${nodeName}'. Compare kube-reserved/system-reserved ` +
          `settings with actual node usage and consider rebalancing workloads or adding capacity.`,
        missingEvidence: [],
      });

      edges.push({
        id: nextEdgeId(counter),
        source: `evidence:${nodePath}:allocatable-memory`,
        target: findingId,
        type: 'supports',
        weight: 0.75,
      });
    }

    const blockingTaints = getNodeTaints(resource).filter(
      (taint) => taint.effect === 'NoSchedule' || taint.effect === 'NoExecute',
    );
    for (const taint of blockingTaints) {
      const blockedPods = pendingPods.filter((pod) => !podToleratesTaint(pod, taint));
      if (blockedPods.length === 0) continue;

      const taintLabel = taint.value ? `${taint.key}=${taint.value}` : taint.key;
      const findingId = nextFindingId('node-taint', counter);
      const blockedPodNames = blockedPods.map((pod) => pod.metadata.name);

      findings.push({
        id: findingId,
        title:
          `Node '${nodeName}' taint '${taintLabel}:${taint.effect}' may block pending pods from scheduling`,
        severity: 'high',
        confidence: 0.8,
        affectedComponents: [
          `Node/${nodeName}`,
          ...blockedPods.map((pod) => `Pod/${pod.metadata.namespace ?? 'default'}/${pod.metadata.name}`),
        ],
        reasoningSummary:
          `Node '${nodeName}' has taint '${taintLabel}:${taint.effect}'. Pending pods ` +
          `${blockedPodNames.join(', ')} do not declare a matching toleration, so the taint may explain ` +
          `their scheduling failures.`,
        evidence: [
          {
            path: nodePath,
            note: `Node taint '${taintLabel}' with effect '${taint.effect}' is present`,
            artifactType: 'kubernetes-resource',
          },
          ...blockedPods.map((pod) => ({
            path: podFilePath(pod.metadata.name, pod.metadata.namespace ?? 'default'),
            note:
              `Pending pod '${pod.metadata.name}' does not tolerate taint '${taintLabel}:${taint.effect}'`,
            artifactType: 'kubernetes-resource' as const,
          })),
        ],
        contradictionsChecked: [
          `Blocked pods were checked for tolerations matching taint '${taintLabel}:${taint.effect}'`,
        ],
        recommendedAction:
          `If these pods are meant to run on node '${nodeName}', add a matching toleration for ` +
          `'${taintLabel}:${taint.effect}' or remove/relax the taint. Otherwise schedule the pods onto ` +
          'nodes without this taint.',
        missingEvidence: [],
      });

      edges.push({
        id: nextEdgeId(counter),
        source: `evidence:${nodePath}:taint:${taintLabel}:${taint.effect}`,
        target: findingId,
        type: 'supports',
        weight: 0.8,
      });

      for (const pod of blockedPods) {
        const namespace = pod.metadata.namespace ?? 'default';
        const podKey = `${namespace}/${pod.metadata.name}`;
        const schedulingEvents = (failedSchedulingByPodKey.get(podKey) ?? []).filter((event) =>
          failedSchedulingEventMentionsTaint(event, taint),
        );
        for (let i = 0; i < schedulingEvents.length; i += 1) {
          edges.push({
            id: nextEdgeId(counter),
            source: findingId,
            target: `event:FailedScheduling:${pod.metadata.name}:${namespace}`,
            type: 'causes',
            weight: 0.8,
            note:
              `Node taint '${taintLabel}:${taint.effect}' on '${nodeName}' may have caused FailedScheduling ` +
              `for pod '${pod.metadata.name}'`,
          });
        }
      }
    }
  }

  return { findings, edges };
}

// ---------------------------------------------------------------------------
// 8. Node condition investigation
// ---------------------------------------------------------------------------

/**
 * Produces findings for Node resources with unhealthy conditions:
 *
 * - `Ready=False`         → `critical` finding: NodeNotReady
 * - `MemoryPressure=True` → `high` finding: node memory pressure
 * - `DiskPressure=True`   → `high` finding: node disk pressure
 * - `PIDPressure=True`    → `high` finding: node PID pressure
 *
 * For `NotReady` nodes, causal edges are also created linking the node
 * finding to any `FailedScheduling` pod events, encoding the relationship
 * "node X being not-ready may explain why these pods cannot be scheduled."
 */
function investigateNodeConditions(
  context: InvestigatorContext,
  counter: Counter,
  oomFindingIdsByNode: Map<string, string[]>,
): { findings: Finding[]; edges: GraphEdge[] } {
  const findings: Finding[] = [];
  const edges: GraphEdge[] = [];

  // Collect FailedScheduling events for later correlation with NotReady nodes
  const failedSchedulingEvents = context.events.filter(
    (e) => e.type === 'Warning' && e.reason === 'FailedScheduling' && e.involvedObject.kind === 'Pod',
  );

  for (const resource of context.resources) {
    if (resource.kind !== 'Node') continue;

    const nodeName = resource.metadata.name;
    const nodePath = nodeFilePath(nodeName);
    const conditions = getNodeConditions(resource);
    if (conditions.length === 0) continue;

    for (const cond of conditions) {
      if (!cond.type) continue;

      let isUnhealthy = false;
      let findingTitle = '';
      let findingReasoning = '';
      let severity: FindingSeverity = 'high';
      let confidence = CONF_NODE_PRESSURE;
      let conditionDescription = '';
      let recommendedAction = '';

      if (cond.type === 'Ready' && cond.status === 'False') {
        isUnhealthy = true;
        findingTitle = `Node '${nodeName}' is NotReady`;
        conditionDescription =
          cond.message || `Node '${nodeName}' condition Ready=False`;
        findingReasoning =
          `Node '${nodeName}' has Ready=False condition.` +
          (cond.reason ? ` Reason: ${cond.reason}.` : '') +
          ` Pods cannot be scheduled on — or will be evicted from — this node.`;
        severity = 'critical';
        confidence = CONF_NODE_NOT_READY;
        recommendedAction =
          `Node '${nodeName}' is not ready. ` +
          `Check node status with \`kubectl describe node ${nodeName}\`. ` +
          `Inspect kubelet logs on the node. ` +
          `Common causes: kubelet crash, network partition, resource exhaustion.`;
      } else if (cond.type === 'MemoryPressure' && cond.status === 'True') {
        isUnhealthy = true;
        findingTitle = `Node '${nodeName}' is under MemoryPressure`;
        conditionDescription =
          cond.message || `Node '${nodeName}' condition MemoryPressure=True`;
        findingReasoning =
          `Node '${nodeName}' has MemoryPressure=True condition.` +
          (cond.reason ? ` Reason: ${cond.reason}.` : '') +
          ` Pods on this node may be throttled or evicted to free memory.`;
        recommendedAction =
          `Node '${nodeName}' has memory pressure. ` +
          `Free memory by removing unused workloads, evicting low-priority pods, ` +
          `or adding more nodes to the cluster.`;
      } else if (cond.type === 'DiskPressure' && cond.status === 'True') {
        isUnhealthy = true;
        findingTitle = `Node '${nodeName}' is under DiskPressure`;
        conditionDescription =
          cond.message || `Node '${nodeName}' condition DiskPressure=True`;
        findingReasoning =
          `Node '${nodeName}' has DiskPressure=True condition.` +
          (cond.reason ? ` Reason: ${cond.reason}.` : '') +
          ` Pods on this node may fail to start due to insufficient disk space.`;
        recommendedAction =
          `Node '${nodeName}' has disk pressure. ` +
          `Free disk space by removing unused images, log files, or volumes, ` +
          `or add nodes with more storage.`;
      } else if (cond.type === 'PIDPressure' && cond.status === 'True') {
        isUnhealthy = true;
        findingTitle = `Node '${nodeName}' is under PIDPressure`;
        conditionDescription =
          cond.message || `Node '${nodeName}' condition PIDPressure=True`;
        findingReasoning =
          `Node '${nodeName}' has PIDPressure=True condition.` +
          (cond.reason ? ` Reason: ${cond.reason}.` : '') +
          ` The node is running too many processes; new processes may fail to start.`;
        recommendedAction =
          `Node '${nodeName}' has PID pressure. ` +
          `Reduce the number of processes by scaling down workloads or adding more nodes.`;
      }

      if (!isUnhealthy) continue;

      const findingId = nextFindingId(`node-${cond.type.toLowerCase()}`, counter);

      findings.push({
        id: findingId,
        title: findingTitle,
        severity,
        confidence,
        affectedComponents: [`Node/${nodeName}`],
        reasoningSummary: findingReasoning,
        evidence: [
          {
            path: nodePath,
            note: conditionDescription,
            artifactType: 'kubernetes-resource',
          },
        ],
        contradictionsChecked: [
          `Node '${nodeName}' condition '${cond.type}' confirmed with status '${cond.status}'`,
        ],
        recommendedAction,
        missingEvidence: [],
      });

      // Graph edge: evidence supports finding
      edges.push({
        id: nextEdgeId(counter),
        source: `evidence:${nodePath}:${cond.type}`,
        target: findingId,
        type: 'supports',
        weight: confidence,
      });

      // For NotReady nodes: create causal edges to FailedScheduling pod events.
      // A NotReady node is a likely cause of pods failing to schedule.
      if (cond.type === 'Ready') {
        for (const event of failedSchedulingEvents) {
          const eventPodName = event.involvedObject.name;
          const eventNamespace = event.involvedObject.namespace ?? 'default';
          const failedSchedulingNodeId = `event:FailedScheduling:${eventPodName}:${eventNamespace}`;

          edges.push({
            id: nextEdgeId(counter),
            source: findingId,
            target: failedSchedulingNodeId,
            type: 'causes',
            weight: 0.7,
            note: `Node '${nodeName}' NotReady may have caused FailedScheduling for Pod '${eventPodName}'`,
          });
        }
      }

      // For MemoryPressure nodes: link the node-pressure finding to OOMKilled
      // findings for pods assigned to the same node.
      if (cond.type === 'MemoryPressure') {
        const oomFindingIds = oomFindingIdsByNode.get(nodeName) ?? [];
        for (const oomFindingId of oomFindingIds) {
          edges.push({
            id: nextEdgeId(counter),
            source: findingId,
            target: oomFindingId,
            type: 'causes',
            weight: 0.75,
            note: `Node '${nodeName}' MemoryPressure may have contributed to OOMKilled workload on the same node`,
          });
        }
      }
    }
  }

  return { findings, edges };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Targeted Kubernetes investigator.
 *
 * Inspects the context for seven common failure patterns and produces
 * evidence-backed {@link Finding} objects with graph edges linking
 * evidence nodes to finding nodes:
 *
 * 1. **CrashLoopBackOff pods** — correlated with BackOff and FailedMount events
 * 2. **ImagePullBackOff pods** — correlated with ErrImagePull and Failed events
 * 3. **Not-ready pods (Running phase)** — correlated with Unhealthy events
 * 4. **Pending / ContainerCreating pods** — correlated with FailedMount, FailedScheduling, and ProvisioningFailed events
 * 5. **Unhealthy workloads** — checked via {@link isWorkloadReady}
 * 6. **OOMKilled containers** — detected via current or last terminated state; cross-referenced with resource limits
 * 7. **Node resources / taints** — allocatable-vs-capacity analysis and unschedulable taints correlated with pending pods
 * 8. **Node conditions** — NotReady, MemoryPressure, DiskPressure, PIDPressure; correlated with FailedScheduling and OOM findings
 *
 * @param context - All parsed bundle data.
 * @param seeds   - Investigation seeds (used as context hints; all resources
 *                  are inspected regardless of seed content).
 */
export function investigateKubernetes(
  context: InvestigatorContext,
  seeds: InvestigationSeed[],
): InvestigatorResult {
  // Seeds are available for future prioritisation; all resources are examined
  void seeds;

  const counter: Counter = { value: 0 };

  // Run CrashLoopBackOff first so the OOM detector can link to its findings
  const crashLoop = investigateCrashLoopPods(context, counter);

  // Build a map from "namespace/podName" → CrashLoopBackOff finding ID so the
  // OOM detector can complete the causal chain OOMKill→ContainerRestart→CrashLoop
  const crashloopFindingByPod = new Map<string, string>();
  for (const finding of crashLoop.findings) {
    const podComp = finding.affectedComponents.find((c) => c.startsWith('Pod/'));
    if (podComp) {
      const parts = podComp.split('/');
      if (parts.length === 3) {
        crashloopFindingByPod.set(`${parts[1]}/${parts[2]}`, finding.id);
      }
    }
  }

  const imagePull = investigateImagePullPods(context, counter);
  const notReady = investigateNotReadyPods(context, counter);
  const pending = investigatePendingPods(context, counter);
  const workloads = investigateWorkloads(context, counter);
  const oom = investigateOOMPods(context, counter, crashloopFindingByPod);
  const nodeResources = investigateNodeResources(context, counter);
  const nodeHealth = investigateNodeConditions(context, counter, oom.findingIdsByNode);

  return {
    findings: [
      ...crashLoop.findings,
      ...imagePull.findings,
      ...notReady.findings,
      ...pending.findings,
      ...workloads.findings,
      ...oom.findings,
      ...nodeResources.findings,
      ...nodeHealth.findings,
    ],
    edges: [
      ...crashLoop.edges,
      ...imagePull.edges,
      ...notReady.edges,
      ...pending.edges,
      ...workloads.edges,
      ...oom.edges,
      ...nodeResources.edges,
      ...nodeHealth.edges,
    ],
  };
}
