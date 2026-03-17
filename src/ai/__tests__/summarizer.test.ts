import { describe, it, expect } from 'vitest';
import { summarizeResource, summarizeEvent, summarizeAnalyzer } from '../summarizer.js';
import type { K8sResource, K8sEvent, AnalyzerResult } from '../../types/index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCrashLoopPod(): K8sResource {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: 'api-server-abc123',
      namespace: 'production',
      ownerReferences: [{ kind: 'ReplicaSet', name: 'api-server-rs-xyz', apiVersion: 'apps/v1' }],
    } as unknown as K8sResource['metadata'],
    spec: {
      volumes: [
        { name: 'db-creds', secret: { secretName: 'db-credentials' } },
        { name: 'app-config', configMap: { name: 'app-config-map' } },
        { name: 'data', persistentVolumeClaim: { claimName: 'data-pvc' } },
      ],
      containers: [
        {
          name: 'api',
          image: 'myrepo/api-server:v1.2.3',
          envFrom: [{ secretRef: { name: 'extra-secret' } }],
          env: [
            { name: 'DB_USER', valueFrom: { secretKeyRef: { name: 'db-secret', key: 'user' } } },
            { name: 'FEATURE_FLAG', valueFrom: { configMapKeyRef: { name: 'feature-flags', key: 'enabled' } } },
          ],
        },
      ],
    },
    status: {
      phase: 'Running',
      conditions: [{ type: 'Ready', status: 'False', reason: 'ContainersNotReady', message: 'containers not ready' }],
      containerStatuses: [
        {
          name: 'api',
          ready: false,
          restartCount: 8,
          state: { waiting: { reason: 'CrashLoopBackOff', message: 'back-off 5m0s restarting' } },
        },
      ],
    },
  };
}

function makeDeployment(): K8sResource {
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: 'api-deploy', namespace: 'default' },
    spec: {
      replicas: 3,
      template: {
        spec: {
          volumes: [
            { name: 'config', configMap: { name: 'api-config' } },
            { name: 'creds', secret: { secretName: 'api-secret' } },
            { name: 'data', persistentVolumeClaim: { claimName: 'api-pvc' } },
          ],
          containers: [
            {
              name: 'api',
              image: 'myrepo/api:v2.0.0',
              envFrom: [{ secretRef: { name: 'env-secret' } }],
              env: [{ name: 'SETTINGS', valueFrom: { configMapKeyRef: { name: 'env-config', key: 'MODE' } } }],
            },
            { name: 'sidecar', image: 'envoyproxy/envoy:v1.28.0' },
          ],
          initContainers: [{ name: 'init-db', image: 'busybox:1.36' }],
        },
      },
    },
    status: { readyReplicas: 2, availableReplicas: 2 },
  };
}

function makeConfigMap(): K8sResource {
  return {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name: 'app-config', namespace: 'default' },
    data: {
      DB_HOST: 'postgres.svc.cluster.local',
      DB_USER: 'amdin', // intentional typo for demo
      DB_PORT: '5432',
    },
  } as unknown as K8sResource;
}

function makeSecret(): K8sResource {
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: 'db-credentials', namespace: 'default' },
    type: 'Opaque',
    data: { password: 'aGVsbG8=', username: 'dXNlcg==' },
  } as unknown as K8sResource;
}

function makeWarningEvent(): K8sEvent {
  return {
    type: 'Warning',
    reason: 'BackOff',
    message: 'Back-off restarting failed container api in pod api-server-abc123_production',
    involvedObject: { kind: 'Pod', name: 'api-server-abc123', namespace: 'production' },
    firstTimestamp: '2024-01-15T10:00:00Z',
    lastTimestamp: '2024-01-15T10:05:00Z',
    count: 12,
  };
}

function makeAnalyzerError(): AnalyzerResult {
  return {
    name: 'secret-exists',
    title: 'Secret "db-credentials" does not exist',
    message: 'The Secret "db-credentials" referenced in Pod "api-server" spec.volumes does not exist in namespace "production".',
    severity: 'error',
    isPass: false,
    isFail: true,
    isWarn: false,
    uri: 'https://troubleshoot.sh/docs/analyze/secret',
  };
}

// ---------------------------------------------------------------------------
// summarizeResource — Pod
// ---------------------------------------------------------------------------

describe('summarizeResource (Pod)', () => {
  it('includes pod name and namespace', () => {
    const summary = summarizeResource(makeCrashLoopPod());
    expect(summary).toContain('api-server-abc123');
    expect(summary).toContain('production');
  });

  it('includes container name and image', () => {
    const summary = summarizeResource(makeCrashLoopPod());
    expect(summary).toContain('api');
    expect(summary).toContain('myrepo/api-server:v1.2.3');
  });

  it('includes owner reference', () => {
    const summary = summarizeResource(makeCrashLoopPod());
    expect(summary).toContain('api-server-rs-xyz');
  });

  it('includes referenced secret names', () => {
    const summary = summarizeResource(makeCrashLoopPod());
    expect(summary).toContain('db-credentials');
    expect(summary).toContain('extra-secret');
    expect(summary).toContain('db-secret');
  });

  it('includes referenced configmap names', () => {
    const summary = summarizeResource(makeCrashLoopPod());
    expect(summary).toContain('app-config-map');
    expect(summary).toContain('feature-flags');
  });

  it('includes phase and restart count', () => {
    const summary = summarizeResource(makeCrashLoopPod());
    expect(summary).toContain('Running');
    expect(summary).toContain('8');
  });

  it('includes container error reason', () => {
    const summary = summarizeResource(makeCrashLoopPod());
    expect(summary).toContain('CrashLoopBackOff');
  });

  it('includes not-ready condition info', () => {
    const summary = summarizeResource(makeCrashLoopPod());
    expect(summary).toContain('ContainersNotReady');
  });
});

// ---------------------------------------------------------------------------
// summarizeResource — Deployment
// ---------------------------------------------------------------------------

describe('summarizeResource (Deployment)', () => {
  it('includes deployment name and kind', () => {
    const summary = summarizeResource(makeDeployment());
    expect(summary).toContain('Deployment');
    expect(summary).toContain('api-deploy');
  });

  it('includes replica counts', () => {
    const summary = summarizeResource(makeDeployment());
    expect(summary).toContain('3');
    expect(summary).toContain('2');
  });

  it('includes container images', () => {
    const summary = summarizeResource(makeDeployment());
    expect(summary).toContain('myrepo/api:v2.0.0');
    expect(summary).toContain('busybox:1.36');
  });

  it('includes referenced secrets, configmaps, and pvcs from the pod template', () => {
    const summary = summarizeResource(makeDeployment());
    expect(summary).toContain('api-secret');
    expect(summary).toContain('env-secret');
    expect(summary).toContain('api-config');
    expect(summary).toContain('env-config');
    expect(summary).toContain('api-pvc');
  });
});

// ---------------------------------------------------------------------------
// summarizeResource — ConfigMap
// ---------------------------------------------------------------------------

describe('summarizeResource (ConfigMap)', () => {
  it('includes configmap name and namespace', () => {
    const summary = summarizeResource(makeConfigMap());
    expect(summary).toContain('app-config');
    expect(summary).toContain('default');
  });

  it('includes data keys', () => {
    const summary = summarizeResource(makeConfigMap());
    expect(summary).toContain('DB_HOST');
    expect(summary).toContain('DB_USER');
  });

  it('does not include actual data values', () => {
    const summary = summarizeResource(makeConfigMap());
    // values are postgres.svc.cluster.local, amdin, 5432
    expect(summary).not.toContain('amdin');
    expect(summary).not.toContain('postgres.svc.cluster.local');
  });
});

// ---------------------------------------------------------------------------
// summarizeResource — Secret
// ---------------------------------------------------------------------------

describe('summarizeResource (Secret)', () => {
  it('includes secret name and namespace', () => {
    const summary = summarizeResource(makeSecret());
    expect(summary).toContain('db-credentials');
    expect(summary).toContain('default');
  });

  it('includes key names but not values', () => {
    const summary = summarizeResource(makeSecret());
    expect(summary).toContain('password');
    expect(summary).toContain('username');
    // Base64 values should not appear
    expect(summary).not.toContain('aGVsbG8=');
  });

  it('includes secret type', () => {
    const summary = summarizeResource(makeSecret());
    expect(summary).toContain('Opaque');
  });
});

// ---------------------------------------------------------------------------
// summarizeResource — generic fallback
// ---------------------------------------------------------------------------

describe('summarizeResource (generic)', () => {
  it('returns kind name for unknown resource kinds', () => {
    const pvc: K8sResource = {
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: { name: 'data-pvc', namespace: 'default' },
    };
    const summary = summarizeResource(pvc);
    expect(summary).toContain('PersistentVolumeClaim');
    expect(summary).toContain('data-pvc');
  });
});

// ---------------------------------------------------------------------------
// summarizeEvent
// ---------------------------------------------------------------------------

describe('summarizeEvent', () => {
  it('includes event type and reason', () => {
    const summary = summarizeEvent(makeWarningEvent());
    expect(summary).toContain('Warning');
    expect(summary).toContain('BackOff');
  });

  it('includes the involved object kind and name', () => {
    const summary = summarizeEvent(makeWarningEvent());
    expect(summary).toContain('Pod');
    expect(summary).toContain('api-server-abc123');
  });

  it('includes the event message', () => {
    const summary = summarizeEvent(makeWarningEvent());
    expect(summary).toContain('Back-off restarting');
  });

  it('includes count when > 1', () => {
    const summary = summarizeEvent(makeWarningEvent());
    expect(summary).toContain('12');
  });

  it('includes timestamps', () => {
    const summary = summarizeEvent(makeWarningEvent());
    expect(summary).toContain('2024-01-15T10:00:00Z');
    expect(summary).toContain('2024-01-15T10:05:00Z');
  });

  it('handles event without namespace', () => {
    const event: K8sEvent = {
      type: 'Normal',
      reason: 'Scheduled',
      message: 'Assigned to node-1',
      involvedObject: { kind: 'Pod', name: 'my-pod' },
    };
    const summary = summarizeEvent(event);
    expect(summary).toContain('Scheduled');
    expect(summary).toContain('my-pod');
  });

  it('omits count line when count is 1 or undefined', () => {
    const event: K8sEvent = {
      type: 'Normal',
      reason: 'Pulled',
      message: 'Image pulled',
      involvedObject: { kind: 'Pod', name: 'my-pod', namespace: 'default' },
      count: 1,
    };
    const summary = summarizeEvent(event);
    expect(summary).not.toContain('Count:');
  });
});

// ---------------------------------------------------------------------------
// summarizeAnalyzer
// ---------------------------------------------------------------------------

describe('summarizeAnalyzer', () => {
  it('includes status indicator', () => {
    const summary = summarizeAnalyzer(makeAnalyzerError());
    expect(summary).toContain('FAIL');
  });

  it('includes the title', () => {
    const summary = summarizeAnalyzer(makeAnalyzerError());
    expect(summary).toContain('Secret "db-credentials" does not exist');
  });

  it('includes the analyzer name', () => {
    const summary = summarizeAnalyzer(makeAnalyzerError());
    expect(summary).toContain('secret-exists');
  });

  it('includes the full message', () => {
    const summary = summarizeAnalyzer(makeAnalyzerError());
    expect(summary).toContain('referenced in Pod');
    expect(summary).toContain('production');
  });

  it('includes the reference URI when present', () => {
    const summary = summarizeAnalyzer(makeAnalyzerError());
    expect(summary).toContain('https://troubleshoot.sh/docs/analyze/secret');
  });

  it('handles passing analyzer result', () => {
    const result: AnalyzerResult = {
      name: 'check-memory',
      title: 'Memory limits are set',
      message: 'All containers have memory limits configured.',
      severity: 'pass',
      isPass: true,
      isFail: false,
      isWarn: false,
    };
    const summary = summarizeAnalyzer(result);
    expect(summary).toContain('PASS');
    expect(summary).toContain('Memory limits are set');
  });

  it('handles warning analyzer result', () => {
    const result: AnalyzerResult = {
      name: 'check-cpu',
      title: 'CPU limits not set',
      message: 'Container app has no CPU limit.',
      severity: 'warn',
      isPass: false,
      isFail: false,
      isWarn: true,
    };
    const summary = summarizeAnalyzer(result);
    expect(summary).toContain('WARN');
  });
});
