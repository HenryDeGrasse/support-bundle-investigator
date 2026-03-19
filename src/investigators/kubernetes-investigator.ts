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
// Public API
// ---------------------------------------------------------------------------

/**
 * Targeted Kubernetes investigator.
 *
 * Inspects the context for five common failure patterns and produces
 * evidence-backed {@link Finding} objects with graph edges linking
 * evidence nodes to finding nodes:
 *
 * 1. **CrashLoopBackOff pods** — correlated with BackOff and FailedMount events
 * 2. **ImagePullBackOff pods** — correlated with ErrImagePull and Failed events
 * 3. **Not-ready pods (Running phase)** — correlated with Unhealthy events
 * 4. **Pending / ContainerCreating pods** — correlated with FailedMount, FailedScheduling, and ProvisioningFailed events
 * 5. **Unhealthy workloads** — checked via {@link isWorkloadReady}
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

  const crashLoop = investigateCrashLoopPods(context, counter);
  const imagePull = investigateImagePullPods(context, counter);
  const notReady = investigateNotReadyPods(context, counter);
  const pending = investigatePendingPods(context, counter);
  const workloads = investigateWorkloads(context, counter);

  return {
    findings: [
      ...crashLoop.findings,
      ...imagePull.findings,
      ...notReady.findings,
      ...pending.findings,
      ...workloads.findings,
    ],
    edges: [
      ...crashLoop.edges,
      ...imagePull.edges,
      ...notReady.edges,
      ...pending.edges,
      ...workloads.edges,
    ],
  };
}
