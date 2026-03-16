import type {
  K8sResource,
  PodCondition,
  ContainerStatus,
  ContainerState,
  PodStatus,
} from '../types/index.js';

// ---------------------------------------------------------------------------
// Internal type guards / coercions
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function getOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function getNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' ? value : fallback;
}

function getBoolean(value: unknown): boolean {
  return value === true;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function parseContainerState(raw: unknown): ContainerState {
  if (!isRecord(raw)) return {};

  const state: ContainerState = {};

  if (isRecord(raw['running'])) {
    state.running = raw['running'] as Record<string, unknown>;
  }

  if (isRecord(raw['waiting'])) {
    state.waiting = {
      reason: getString(raw['waiting']['reason']),
      message: getOptionalString(raw['waiting']['message']),
    };
  }

  if (isRecord(raw['terminated'])) {
    state.terminated = {
      reason: getString(raw['terminated']['reason']),
      exitCode: getNumber(raw['terminated']['exitCode']),
      message: getOptionalString(raw['terminated']['message']),
    };
  }

  return state;
}

function parseContainerStatus(raw: unknown): ContainerStatus | null {
  if (!isRecord(raw)) return null;

  return {
    name: getString(raw['name']),
    ready: getBoolean(raw['ready']),
    restartCount: getNumber(raw['restartCount']),
    state: parseContainerState(raw['state']),
  };
}

function parsePodCondition(raw: unknown): PodCondition | null {
  if (!isRecord(raw)) return null;

  return {
    type: getString(raw['type']),
    status: getString(raw['status']),
    reason: getOptionalString(raw['reason']),
    message: getOptionalString(raw['message']),
    lastTransitionTime: getOptionalString(raw['lastTransitionTime']),
  };
}

// ---------------------------------------------------------------------------
// extractPodStatus
// ---------------------------------------------------------------------------

/**
 * Extracts a typed {@link PodStatus} from a Pod resource.
 *
 * Returns `null` if the resource is not a Pod or has no status block.
 */
export function extractPodStatus(resource: K8sResource): PodStatus | null {
  if (resource.kind !== 'Pod') return null;

  const rawStatus = resource.status;
  if (!isRecord(rawStatus)) return null;

  const phase = getString(rawStatus['phase']) || 'Unknown';

  const rawConditions = Array.isArray(rawStatus['conditions']) ? rawStatus['conditions'] : [];
  const conditions: PodCondition[] = rawConditions
    .map(parsePodCondition)
    .filter((c): c is PodCondition => c !== null);

  const rawContainerStatuses = Array.isArray(rawStatus['containerStatuses'])
    ? rawStatus['containerStatuses']
    : [];
  const containerStatuses: ContainerStatus[] = rawContainerStatuses
    .map(parseContainerStatus)
    .filter((cs): cs is ContainerStatus => cs !== null);

  const restartCount = containerStatuses.reduce((sum, cs) => sum + cs.restartCount, 0);

  return { phase, conditions, containerStatuses, restartCount };
}

// ---------------------------------------------------------------------------
// isPodHealthy
// ---------------------------------------------------------------------------

/**
 * Returns `true` only if:
 * - The resource is a Pod
 * - The pod phase is `Running`
 * - Every container is `ready`
 * - No container is in a waiting state (which covers CrashLoopBackOff,
 *   ImagePullBackOff, etc.)
 */
export function isPodHealthy(resource: K8sResource): boolean {
  const podStatus = extractPodStatus(resource);
  if (!podStatus) return false;

  if (podStatus.phase !== 'Running') return false;

  if (podStatus.containerStatuses.length === 0) return false;

  for (const cs of podStatus.containerStatuses) {
    if (!cs.ready) return false;
    if (cs.state.waiting) return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// getRestartCount
// ---------------------------------------------------------------------------

/**
 * Returns the total restart count across all containers in a Pod.
 *
 * Returns 0 for non-Pod resources or pods with no container status
 * information.
 */
export function getRestartCount(resource: K8sResource): number {
  const podStatus = extractPodStatus(resource);
  return podStatus?.restartCount ?? 0;
}

// ---------------------------------------------------------------------------
// getPodConditions
// ---------------------------------------------------------------------------

/**
 * Returns the typed list of {@link PodCondition} objects for a Pod.
 *
 * Returns an empty array for non-Pod resources or pods with no conditions.
 */
export function getPodConditions(resource: K8sResource): PodCondition[] {
  const podStatus = extractPodStatus(resource);
  return podStatus?.conditions ?? [];
}

// ---------------------------------------------------------------------------
// isWorkloadReady
// ---------------------------------------------------------------------------

/**
 * Returns `true` if a workload resource reports enough ready replicas for its
 * kind-specific status fields.
 *
 * Supported kinds:
 * - Deployment / ReplicaSet → `spec.replicas` vs `readyReplicas` + `availableReplicas`
 * - StatefulSet → `spec.replicas` vs `readyReplicas`
 * - DaemonSet → `desiredNumberScheduled` vs `numberReady` + `numberAvailable`
 *
 * Returns `false` for non-workload resource kinds.
 */
export function isWorkloadReady(resource: K8sResource): boolean {
  const rawStatus = resource.status;
  if (!isRecord(rawStatus)) return false;

  const rawSpec = isRecord(resource.spec) ? resource.spec : undefined;

  switch (resource.kind) {
    case 'Deployment':
    case 'ReplicaSet': {
      const desiredReplicas = getNumber(rawSpec?.['replicas'], 1);
      const readyReplicas = getNumber(rawStatus['readyReplicas'], 0);
      const availableReplicas = getNumber(rawStatus['availableReplicas'], readyReplicas);

      return readyReplicas >= desiredReplicas && availableReplicas >= desiredReplicas;
    }

    case 'StatefulSet': {
      const desiredReplicas = getNumber(rawSpec?.['replicas'], 1);
      const readyReplicas = getNumber(rawStatus['readyReplicas'], 0);

      return readyReplicas >= desiredReplicas;
    }

    case 'DaemonSet': {
      const desiredScheduled = getNumber(rawStatus['desiredNumberScheduled'], 1);
      const numberReady = getNumber(rawStatus['numberReady'], 0);
      const numberAvailable = getNumber(rawStatus['numberAvailable'], numberReady);

      return numberReady >= desiredScheduled && numberAvailable >= desiredScheduled;
    }

    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// getContainerErrors
// ---------------------------------------------------------------------------

/**
 * Returns a list of container error descriptors for containers that are:
 * - In a **waiting** state (e.g. CrashLoopBackOff, ImagePullBackOff)
 * - In a **terminated** state with a non-zero exit code
 *
 * Returns an empty array for non-Pod resources or healthy pods.
 */
export function getContainerErrors(
  resource: K8sResource,
): Array<{ container: string; reason: string; message?: string }> {
  const podStatus = extractPodStatus(resource);
  if (!podStatus) return [];

  const errors: Array<{ container: string; reason: string; message?: string }> = [];

  for (const cs of podStatus.containerStatuses) {
    if (cs.state.waiting) {
      errors.push({
        container: cs.name,
        reason: cs.state.waiting.reason,
        message: cs.state.waiting.message,
      });
    } else if (cs.state.terminated && cs.state.terminated.exitCode !== 0) {
      errors.push({
        container: cs.name,
        reason: cs.state.terminated.reason,
        message: cs.state.terminated.message,
      });
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// getUnreadyContainers
// ---------------------------------------------------------------------------

/**
 * Returns the {@link ContainerStatus} objects for all containers that are
 * not yet `ready`.
 *
 * Returns an empty array for non-Pod resources or pods where all containers
 * are ready.
 */
export function getUnreadyContainers(resource: K8sResource): ContainerStatus[] {
  const podStatus = extractPodStatus(resource);
  if (!podStatus) return [];
  return podStatus.containerStatuses.filter((cs) => !cs.ready);
}
