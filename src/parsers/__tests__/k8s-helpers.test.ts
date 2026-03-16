import { describe, it, expect } from 'vitest';
import type { K8sResource } from '../../types/index.js';
import {
  isPodHealthy,
  getRestartCount,
  getPodConditions,
  isWorkloadReady,
  getContainerErrors,
  getUnreadyContainers,
  extractPodStatus,
} from '../k8s-helpers.js';

// ---------------------------------------------------------------------------
// Test resource factories
// ---------------------------------------------------------------------------

function makePod(overrides: Partial<Record<string, unknown>> = {}): K8sResource {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name: 'test-pod', namespace: 'default' },
    spec: { containers: [{ name: 'app', image: 'img:1' }] },
    ...overrides,
  };
}

/** A healthy Running pod with all containers ready */
const HEALTHY_POD: K8sResource = makePod({
  status: {
    phase: 'Running',
    conditions: [
      { type: 'Ready', status: 'True', lastTransitionTime: '2024-01-15T10:00:00Z' },
      { type: 'ContainersReady', status: 'True', lastTransitionTime: '2024-01-15T10:00:00Z' },
      { type: 'PodScheduled', status: 'True', lastTransitionTime: '2024-01-15T10:00:00Z' },
    ],
    containerStatuses: [
      {
        name: 'app',
        ready: true,
        restartCount: 0,
        state: { running: { startedAt: '2024-01-15T10:00:05Z' } },
      },
    ],
  },
});

/** CrashLoopBackOff pod (phase Running but container waiting) */
const CRASHLOOP_POD: K8sResource = makePod({
  status: {
    phase: 'Running',
    conditions: [
      {
        type: 'Ready',
        status: 'False',
        reason: 'ContainersNotReady',
        message: 'containers with unready status: [app]',
        lastTransitionTime: '2024-01-15T13:30:05Z',
      },
      {
        type: 'ContainersReady',
        status: 'False',
        reason: 'ContainersNotReady',
        message: 'containers with unready status: [app]',
        lastTransitionTime: '2024-01-15T13:30:05Z',
      },
      { type: 'PodScheduled', status: 'True', lastTransitionTime: '2024-01-15T13:30:01Z' },
    ],
    containerStatuses: [
      {
        name: 'app',
        ready: false,
        restartCount: 8,
        state: {
          waiting: {
            reason: 'CrashLoopBackOff',
            message: 'back-off 5m0s restarting failed container=app pod=test-pod_default',
          },
        },
      },
    ],
  },
});

/** ImagePullBackOff pod (phase Pending) */
const IMAGE_PULL_POD: K8sResource = makePod({
  status: {
    phase: 'Pending',
    conditions: [
      { type: 'PodScheduled', status: 'True', lastTransitionTime: '2024-01-15T16:00:02Z' },
      {
        type: 'ContainersReady',
        status: 'False',
        reason: 'ContainersNotReady',
        message: 'containers with unready status: [app]',
        lastTransitionTime: '2024-01-15T16:00:02Z',
      },
      {
        type: 'Ready',
        status: 'False',
        reason: 'ContainersNotReady',
        message: 'containers with unready status: [app]',
        lastTransitionTime: '2024-01-15T16:00:02Z',
      },
    ],
    containerStatuses: [
      {
        name: 'app',
        ready: false,
        restartCount: 0,
        state: {
          waiting: {
            reason: 'ImagePullBackOff',
            message: 'Back-off pulling image "myapp:v999.99.99"',
          },
        },
      },
    ],
  },
});

/** Pending pod — not yet scheduled / container not started */
const PENDING_POD: K8sResource = makePod({
  status: {
    phase: 'Pending',
    conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable' }],
    containerStatuses: [],
  },
});

/** Pod with multiple containers — some restarted */
const MULTI_CONTAINER_POD: K8sResource = makePod({
  status: {
    phase: 'Running',
    conditions: [
      { type: 'Ready', status: 'False', reason: 'ContainersNotReady' },
    ],
    containerStatuses: [
      {
        name: 'main',
        ready: true,
        restartCount: 3,
        state: { running: { startedAt: '2024-01-15T10:00:05Z' } },
      },
      {
        name: 'sidecar',
        ready: false,
        restartCount: 5,
        state: {
          waiting: {
            reason: 'CrashLoopBackOff',
            message: 'container failed to start',
          },
        },
      },
    ],
  },
});

/** A pod with a terminated (error) container */
const TERMINATED_ERROR_POD: K8sResource = makePod({
  status: {
    phase: 'Running',
    conditions: [
      { type: 'Ready', status: 'False', reason: 'ContainersNotReady' },
    ],
    containerStatuses: [
      {
        name: 'app',
        ready: false,
        restartCount: 2,
        state: {
          terminated: {
            reason: 'Error',
            exitCode: 1,
            message: 'process exited with status 1',
          },
        },
      },
    ],
  },
});

/** Ready deployment */
const READY_DEPLOYMENT: K8sResource = {
  apiVersion: 'apps/v1',
  kind: 'Deployment',
  metadata: { name: 'my-deployment', namespace: 'default' },
  spec: { replicas: 3 },
  status: { replicas: 3, readyReplicas: 3, availableReplicas: 3 },
};

/** Deployment rolling out — replicas not yet ready */
const ROLLING_DEPLOYMENT: K8sResource = {
  apiVersion: 'apps/v1',
  kind: 'Deployment',
  metadata: { name: 'rolling-deployment', namespace: 'default' },
  spec: { replicas: 3 },
  status: { replicas: 3, readyReplicas: 1, availableReplicas: 1 },
};

/** Deployment with 0 available (degraded) */
const DEGRADED_DEPLOYMENT: K8sResource = {
  apiVersion: 'apps/v1',
  kind: 'Deployment',
  metadata: { name: 'degraded-deployment', namespace: 'default' },
  spec: { replicas: 1 },
  status: { replicas: 1, readyReplicas: 0, availableReplicas: 0 },
};

// ---------------------------------------------------------------------------
// isPodHealthy
// ---------------------------------------------------------------------------

describe('isPodHealthy', () => {
  it('returns true for a Running pod with all containers ready', () => {
    expect(isPodHealthy(HEALTHY_POD)).toBe(true);
  });

  it('returns false for a CrashLoopBackOff pod', () => {
    expect(isPodHealthy(CRASHLOOP_POD)).toBe(false);
  });

  it('returns false for an ImagePullBackOff pod', () => {
    expect(isPodHealthy(IMAGE_PULL_POD)).toBe(false);
  });

  it('returns false for a Pending pod', () => {
    expect(isPodHealthy(PENDING_POD)).toBe(false);
  });

  it('returns false for a non-Pod resource', () => {
    expect(isPodHealthy(READY_DEPLOYMENT)).toBe(false);
  });

  it('returns false when any container is not ready', () => {
    expect(isPodHealthy(MULTI_CONTAINER_POD)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getRestartCount
// ---------------------------------------------------------------------------

describe('getRestartCount', () => {
  it('returns 0 for a healthy pod with no restarts', () => {
    expect(getRestartCount(HEALTHY_POD)).toBe(0);
  });

  it('returns the restart count for a CrashLoopBackOff pod', () => {
    expect(getRestartCount(CRASHLOOP_POD)).toBe(8);
  });

  it('sums restart counts across multiple containers', () => {
    // MULTI_CONTAINER_POD: main=3, sidecar=5 → total 8
    expect(getRestartCount(MULTI_CONTAINER_POD)).toBe(8);
  });

  it('returns 0 for a non-Pod resource', () => {
    expect(getRestartCount(READY_DEPLOYMENT)).toBe(0);
  });

  it('returns 0 for a pod with no containerStatuses', () => {
    expect(getRestartCount(PENDING_POD)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getPodConditions
// ---------------------------------------------------------------------------

describe('getPodConditions', () => {
  it('extracts conditions from a pod and returns typed PodCondition[]', () => {
    const conditions = getPodConditions(CRASHLOOP_POD);

    expect(conditions).toHaveLength(3);
    const readyCond = conditions.find((c) => c.type === 'Ready');
    expect(readyCond).toBeDefined();
    expect(readyCond?.status).toBe('False');
    expect(readyCond?.reason).toBe('ContainersNotReady');
  });

  it('extracts conditions including optional reason and message fields', () => {
    const conditions = getPodConditions(IMAGE_PULL_POD);
    const readyCond = conditions.find((c) => c.type === 'Ready');

    expect(readyCond?.message).toContain('unready status');
    expect(readyCond?.lastTransitionTime).toBe('2024-01-15T16:00:02Z');
  });

  it('returns empty array for a non-Pod resource', () => {
    expect(getPodConditions(READY_DEPLOYMENT)).toHaveLength(0);
  });

  it('returns empty array for a pod with no conditions', () => {
    const pod = makePod({ status: { phase: 'Running', containerStatuses: [] } });
    expect(getPodConditions(pod)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// isWorkloadReady
// ---------------------------------------------------------------------------

describe('isWorkloadReady', () => {
  it('returns true for a fully available deployment', () => {
    expect(isWorkloadReady(READY_DEPLOYMENT)).toBe(true);
  });

  it('returns false for a deployment that is still rolling out', () => {
    expect(isWorkloadReady(ROLLING_DEPLOYMENT)).toBe(false);
  });

  it('returns false for a degraded deployment with 0 available replicas', () => {
    expect(isWorkloadReady(DEGRADED_DEPLOYMENT)).toBe(false);
  });

  it('returns false for a Pod resource (not a workload)', () => {
    expect(isWorkloadReady(HEALTHY_POD)).toBe(false);
  });

  it('returns true for a StatefulSet with desired ready replicas even without availableReplicas', () => {
    const statefulSet: K8sResource = {
      apiVersion: 'apps/v1',
      kind: 'StatefulSet',
      metadata: { name: 'my-ss', namespace: 'default' },
      spec: { replicas: 2 },
      status: { readyReplicas: 2 },
    };
    expect(isWorkloadReady(statefulSet)).toBe(true);
  });

  it('returns true for a ready DaemonSet using daemonset-specific status fields', () => {
    const daemonSet: K8sResource = {
      apiVersion: 'apps/v1',
      kind: 'DaemonSet',
      metadata: { name: 'node-agent', namespace: 'kube-system' },
      status: {
        desiredNumberScheduled: 3,
        numberReady: 3,
        numberAvailable: 3,
      },
    };

    expect(isWorkloadReady(daemonSet)).toBe(true);
  });

  it('returns false for a DaemonSet when ready pods are below desired scheduled count', () => {
    const daemonSet: K8sResource = {
      apiVersion: 'apps/v1',
      kind: 'DaemonSet',
      metadata: { name: 'node-agent', namespace: 'kube-system' },
      status: {
        desiredNumberScheduled: 3,
        numberReady: 2,
        numberAvailable: 2,
      },
    };

    expect(isWorkloadReady(daemonSet)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getContainerErrors
// ---------------------------------------------------------------------------

describe('getContainerErrors', () => {
  it('extracts waiting reason for a CrashLoopBackOff container', () => {
    const errors = getContainerErrors(CRASHLOOP_POD);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.container).toBe('app');
    expect(errors[0]?.reason).toBe('CrashLoopBackOff');
    expect(errors[0]?.message).toContain('back-off');
  });

  it('extracts waiting reason for an ImagePullBackOff container', () => {
    const errors = getContainerErrors(IMAGE_PULL_POD);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.container).toBe('app');
    expect(errors[0]?.reason).toBe('ImagePullBackOff');
  });

  it('extracts terminated reason with non-zero exit code', () => {
    const errors = getContainerErrors(TERMINATED_ERROR_POD);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.container).toBe('app');
    expect(errors[0]?.reason).toBe('Error');
    expect(errors[0]?.message).toContain('exited');
  });

  it('returns empty array for a healthy pod', () => {
    expect(getContainerErrors(HEALTHY_POD)).toHaveLength(0);
  });

  it('returns errors from multiple containers', () => {
    const errors = getContainerErrors(MULTI_CONTAINER_POD);

    // sidecar is in CrashLoopBackOff; main is Running (not an error)
    expect(errors).toHaveLength(1);
    expect(errors[0]?.container).toBe('sidecar');
    expect(errors[0]?.reason).toBe('CrashLoopBackOff');
  });

  it('returns empty array for a non-Pod resource', () => {
    expect(getContainerErrors(READY_DEPLOYMENT)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getUnreadyContainers
// ---------------------------------------------------------------------------

describe('getUnreadyContainers', () => {
  it('returns empty array for a healthy pod', () => {
    expect(getUnreadyContainers(HEALTHY_POD)).toHaveLength(0);
  });

  it('returns unready containers for a CrashLoopBackOff pod', () => {
    const unready = getUnreadyContainers(CRASHLOOP_POD);

    expect(unready).toHaveLength(1);
    expect(unready[0]?.name).toBe('app');
    expect(unready[0]?.ready).toBe(false);
  });

  it('returns only unready containers from a multi-container pod', () => {
    const unready = getUnreadyContainers(MULTI_CONTAINER_POD);

    // main is ready; sidecar is not
    expect(unready).toHaveLength(1);
    expect(unready[0]?.name).toBe('sidecar');
  });

  it('returns empty array for a non-Pod resource', () => {
    expect(getUnreadyContainers(READY_DEPLOYMENT)).toHaveLength(0);
  });

  it('preserves ContainerStatus shape for unready containers', () => {
    const unready = getUnreadyContainers(CRASHLOOP_POD);
    const cs = unready[0]!;

    expect(cs.name).toBe('app');
    expect(cs.ready).toBe(false);
    expect(cs.restartCount).toBe(8);
    expect(cs.state.waiting?.reason).toBe('CrashLoopBackOff');
  });
});

// ---------------------------------------------------------------------------
// extractPodStatus
// ---------------------------------------------------------------------------

describe('extractPodStatus', () => {
  it('returns null for a non-Pod resource', () => {
    expect(extractPodStatus(READY_DEPLOYMENT)).toBeNull();
  });

  it('returns null for a Pod with no status', () => {
    const pod = makePod({ status: undefined });
    expect(extractPodStatus(pod)).toBeNull();
  });

  it('extracts phase from pod status', () => {
    const status = extractPodStatus(CRASHLOOP_POD);
    expect(status?.phase).toBe('Running');
  });

  it('extracts containerStatuses with full ContainerStatus shape', () => {
    const status = extractPodStatus(CRASHLOOP_POD);
    expect(status).not.toBeNull();
    expect(status!.containerStatuses).toHaveLength(1);
    const cs = status!.containerStatuses[0]!;

    expect(cs.name).toBe('app');
    expect(cs.ready).toBe(false);
    expect(cs.restartCount).toBe(8);
    expect(cs.state.waiting?.reason).toBe('CrashLoopBackOff');
  });

  it('computes restartCount as sum of all container restart counts', () => {
    const status = extractPodStatus(MULTI_CONTAINER_POD);
    expect(status?.restartCount).toBe(8); // main=3 + sidecar=5
  });

  it('extracts conditions with all optional fields', () => {
    const status = extractPodStatus(CRASHLOOP_POD);
    const ready = status?.conditions.find((c) => c.type === 'Ready');

    expect(ready?.type).toBe('Ready');
    expect(ready?.status).toBe('False');
    expect(ready?.reason).toBe('ContainersNotReady');
    expect(ready?.message).toContain('unready status');
    expect(ready?.lastTransitionTime).toBe('2024-01-15T13:30:05Z');
  });

  it('handles running state for a healthy container', () => {
    const status = extractPodStatus(HEALTHY_POD);
    expect(status).not.toBeNull();
    const cs = status!.containerStatuses[0]!;

    expect(cs.state.running).toBeDefined();
    expect(cs.state.waiting).toBeUndefined();
    expect(cs.state.terminated).toBeUndefined();
  });

  it('handles terminated state with exit code', () => {
    const status = extractPodStatus(TERMINATED_ERROR_POD);
    expect(status).not.toBeNull();
    const cs = status!.containerStatuses[0]!;

    expect(cs.state.terminated?.reason).toBe('Error');
    expect(cs.state.terminated?.exitCode).toBe(1);
    expect(cs.state.terminated?.message).toContain('exited');
  });
});
