import { describe, it, expect } from 'vitest';
import type { K8sEvent } from '../../types/index.js';
import type { Finding } from '../../types/index.js';
import {
  CAUSAL_TEMPLATES,
  matchCausalTemplate,
  extractFindingCategory,
} from '../causal-templates.js';
import type { CausalTemplate, CausalChainStep, CausalTemplateInstance } from '../causal-templates.js';

// ---------------------------------------------------------------------------
// Template library structure
// ---------------------------------------------------------------------------

describe('CAUSAL_TEMPLATES library', () => {
  it('exports the expected 6 templates', () => {
    expect(CAUSAL_TEMPLATES).toHaveLength(6);
  });

  it('each template has a unique id', () => {
    const ids = CAUSAL_TEMPLATES.map((t) => t.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it('contains all 6 expected template ids', () => {
    const ids = CAUSAL_TEMPLATES.map((t) => t.id);
    expect(ids).toContain('missing-secret-crashloop');
    expect(ids).toContain('bad-image-tag');
    expect(ids).toContain('dns-failure-connection-timeout');
    expect(ids).toContain('oom-kill-crashloop');
    expect(ids).toContain('configmap-auth-failure');
    expect(ids).toContain('missing-storage-class-pending');
  });

  it('each template has a non-empty name and description', () => {
    for (const template of CAUSAL_TEMPLATES) {
      expect(template.name.length).toBeGreaterThan(0);
      expect(template.description.length).toBeGreaterThan(0);
    }
  });

  it('each template chain has at least 2 steps', () => {
    for (const template of CAUSAL_TEMPLATES) {
      expect(template.chain.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('each chain step has nodeType of finding or event', () => {
    for (const template of CAUSAL_TEMPLATES) {
      for (const step of template.chain) {
        expect(['finding', 'event']).toContain(step.nodeType);
      }
    }
  });

  it('each chain step has a non-empty category and description', () => {
    for (const template of CAUSAL_TEMPLATES) {
      for (const step of template.chain) {
        expect(step.category.length).toBeGreaterThan(0);
        expect(step.description.length).toBeGreaterThan(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Individual template chain structure
// ---------------------------------------------------------------------------

describe('MissingSecret → FailedMount → CrashLoopBackOff → DeploymentUnhealthy', () => {
  const template = CAUSAL_TEMPLATES.find((t) => t.id === 'missing-secret-crashloop')!;

  it('template is defined', () => {
    expect(template).toBeDefined();
  });

  it('chain has exactly 4 steps', () => {
    expect(template.chain).toHaveLength(4);
  });

  it('step 0 is finding:missing-secret (root cause)', () => {
    expect(template.chain[0]?.nodeType).toBe('finding');
    expect(template.chain[0]?.category).toBe('missing-secret');
  });

  it('step 1 is event:FailedMount', () => {
    expect(template.chain[1]?.nodeType).toBe('event');
    expect(template.chain[1]?.category).toBe('FailedMount');
  });

  it('step 2 is finding:crashloop', () => {
    expect(template.chain[2]?.nodeType).toBe('finding');
    expect(template.chain[2]?.category).toBe('crashloop');
  });

  it('step 3 is finding:workload-unhealthy (final symptom)', () => {
    expect(template.chain[3]?.nodeType).toBe('finding');
    expect(template.chain[3]?.category).toBe('workload-unhealthy');
  });
});

describe('BadImageTag → ErrImagePull → ImagePullBackOff', () => {
  const template = CAUSAL_TEMPLATES.find((t) => t.id === 'bad-image-tag')!;

  it('template is defined', () => {
    expect(template).toBeDefined();
  });

  it('chain has exactly 3 steps', () => {
    expect(template.chain).toHaveLength(3);
  });

  it('step 0 is finding:bad-image-tag', () => {
    expect(template.chain[0]?.nodeType).toBe('finding');
    expect(template.chain[0]?.category).toBe('bad-image-tag');
  });

  it('step 1 is event:ErrImagePull', () => {
    expect(template.chain[1]?.nodeType).toBe('event');
    expect(template.chain[1]?.category).toBe('ErrImagePull');
  });

  it('step 2 is finding:imagepull', () => {
    expect(template.chain[2]?.nodeType).toBe('finding');
    expect(template.chain[2]?.category).toBe('imagepull');
  });
});

describe('DNSFailure → ConnectionTimeout → ReadinessProbeFailure → PodNotReady', () => {
  const template = CAUSAL_TEMPLATES.find((t) => t.id === 'dns-failure-connection-timeout')!;

  it('template is defined', () => {
    expect(template).toBeDefined();
  });

  it('chain has exactly 3 steps', () => {
    expect(template.chain).toHaveLength(3);
  });

  it('step 0 is finding:dns-failure', () => {
    expect(template.chain[0]?.nodeType).toBe('finding');
    expect(template.chain[0]?.category).toBe('dns-failure');
  });

  it('step 1 is finding:connection-timeout', () => {
    expect(template.chain[1]?.nodeType).toBe('finding');
    expect(template.chain[1]?.category).toBe('connection-timeout');
  });

  it('step 2 is finding:notready', () => {
    expect(template.chain[2]?.nodeType).toBe('finding');
    expect(template.chain[2]?.category).toBe('notready');
  });
});

describe('OOMKill → ContainerRestart → CrashLoopBackOff', () => {
  const template = CAUSAL_TEMPLATES.find((t) => t.id === 'oom-kill-crashloop')!;

  it('template is defined', () => {
    expect(template).toBeDefined();
  });

  it('chain has exactly 3 steps', () => {
    expect(template.chain).toHaveLength(3);
  });

  it('step 0 is finding:oom-kill', () => {
    expect(template.chain[0]?.nodeType).toBe('finding');
    expect(template.chain[0]?.category).toBe('oom-kill');
  });

  it('step 1 is event:OOMKilling', () => {
    expect(template.chain[1]?.nodeType).toBe('event');
    expect(template.chain[1]?.category).toBe('OOMKilling');
  });

  it('step 2 is finding:crashloop', () => {
    expect(template.chain[2]?.nodeType).toBe('finding');
    expect(template.chain[2]?.category).toBe('crashloop');
  });
});

describe('ConfigMapTypo → AuthFailure → PodNotReady', () => {
  const template = CAUSAL_TEMPLATES.find((t) => t.id === 'configmap-auth-failure')!;

  it('template is defined', () => {
    expect(template).toBeDefined();
  });

  it('chain has exactly 3 steps', () => {
    expect(template.chain).toHaveLength(3);
  });

  it('step 0 is finding:configmap-error', () => {
    expect(template.chain[0]?.nodeType).toBe('finding');
    expect(template.chain[0]?.category).toBe('configmap-error');
  });

  it('step 1 is finding:auth-failure', () => {
    expect(template.chain[1]?.nodeType).toBe('finding');
    expect(template.chain[1]?.category).toBe('auth-failure');
  });

  it('step 2 is finding:notready', () => {
    expect(template.chain[2]?.nodeType).toBe('finding');
    expect(template.chain[2]?.category).toBe('notready');
  });
});

describe('MissingStorageClass → ProvisioningFailed → FailedMount → PodPending', () => {
  const template = CAUSAL_TEMPLATES.find((t) => t.id === 'missing-storage-class-pending')!;

  it('template is defined', () => {
    expect(template).toBeDefined();
  });

  it('chain has exactly 4 steps', () => {
    expect(template.chain).toHaveLength(4);
  });

  it('step 0 is finding:missing-storage-class', () => {
    expect(template.chain[0]?.nodeType).toBe('finding');
    expect(template.chain[0]?.category).toBe('missing-storage-class');
  });

  it('step 1 is event:ProvisioningFailed', () => {
    expect(template.chain[1]?.nodeType).toBe('event');
    expect(template.chain[1]?.category).toBe('ProvisioningFailed');
  });

  it('step 2 is event:FailedMount', () => {
    expect(template.chain[2]?.nodeType).toBe('event');
    expect(template.chain[2]?.category).toBe('FailedMount');
  });

  it('step 3 is finding:pending', () => {
    expect(template.chain[3]?.nodeType).toBe('finding');
    expect(template.chain[3]?.category).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// extractFindingCategory helper
// ---------------------------------------------------------------------------

describe('extractFindingCategory', () => {
  it('extracts crashloop from finding:k8s:crashloop:0', () => {
    expect(extractFindingCategory('finding:k8s:crashloop:0')).toBe('crashloop');
  });

  it('extracts imagepull from finding:k8s:imagepull:1', () => {
    expect(extractFindingCategory('finding:k8s:imagepull:1')).toBe('imagepull');
  });

  it('extracts dns from finding:log:dns:0', () => {
    expect(extractFindingCategory('finding:log:dns:0')).toBe('dns');
  });

  it('extracts connection-timeout from finding:log:connection-timeout:1', () => {
    expect(extractFindingCategory('finding:log:connection-timeout:1')).toBe('connection-timeout');
  });

  it('extracts missing-resource from finding:log:missing-resource:2', () => {
    expect(extractFindingCategory('finding:log:missing-resource:2')).toBe('missing-resource');
  });

  it('extracts pending from finding:k8s:pending:0', () => {
    expect(extractFindingCategory('finding:k8s:pending:0')).toBe('pending');
  });

  it('extracts notready from finding:k8s:notready:0', () => {
    expect(extractFindingCategory('finding:k8s:notready:0')).toBe('notready');
  });
});

// ---------------------------------------------------------------------------
// matchCausalTemplate — no match scenarios
// ---------------------------------------------------------------------------

describe('matchCausalTemplate — empty inputs', () => {
  it('returns an empty array for empty inputs', () => {
    const result = matchCausalTemplate([], [], []);
    expect(result).toEqual([]);
  });

  it('returns an empty array when findings have no matching patterns', () => {
    const finding: Finding = {
      id: 'finding:k8s:workload:0',
      title: 'Unhealthy Deployment',
      severity: 'high',
      confidence: 0.7,
      affectedComponents: ['Deployment/default/app'],
      reasoningSummary: 'low ready replicas',
      evidence: [],
      contradictionsChecked: [],
      recommendedAction: '',
      missingEvidence: [],
    };
    const result = matchCausalTemplate([finding], [], []);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// matchCausalTemplate — MissingSecret pattern
// ---------------------------------------------------------------------------

describe('matchCausalTemplate — MissingSecret → FailedMount → CrashLoopBackOff', () => {
  const crashloopFinding: Finding = {
    id: 'finding:k8s:crashloop:0',
    title: "CrashLoopBackOff: Pod 'app-pod' in namespace 'default'",
    severity: 'critical',
    confidence: 0.95,
    affectedComponents: ['Pod/default/app-pod', 'Container/app'],
    reasoningSummary: 'CrashLoopBackOff with 8 restarts. FailedMount events indicate missing Secret.',
    evidence: [],
    contradictionsChecked: [],
    recommendedAction: '',
    missingEvidence: [],
  };

  const failedMountEvent: K8sEvent = {
    type: 'Warning',
    reason: 'FailedMount',
    message: 'MountVolume.SetUp failed for volume "app-credentials": secret "app-credentials" not found',
    involvedObject: { kind: 'Pod', name: 'app-pod', namespace: 'default' },
    count: 8,
    firstTimestamp: '2024-01-15T13:30:10Z',
    lastTimestamp: '2024-01-15T13:55:10Z',
  };

  it('returns exactly one template instance', () => {
    const result = matchCausalTemplate([crashloopFinding], [failedMountEvent], []);
    expect(result).toHaveLength(1);
  });

  it('matched instance has templateId missing-secret-crashloop', () => {
    const result = matchCausalTemplate([crashloopFinding], [failedMountEvent], []);
    expect(result[0]?.templateId).toBe('missing-secret-crashloop');
  });

  it('matched instance has templateName', () => {
    const result = matchCausalTemplate([crashloopFinding], [failedMountEvent], []);
    expect(result[0]?.templateName).toContain('MissingSecret');
  });

  it('nodeIds starts with synthetic missing-secret node', () => {
    const result = matchCausalTemplate([crashloopFinding], [failedMountEvent], []);
    const instance = result[0]!;
    expect(instance.nodeIds[0]).toBe('finding:missing-secret:app-credentials:default');
  });

  it('nodeIds includes FailedMount event node', () => {
    const result = matchCausalTemplate([crashloopFinding], [failedMountEvent], []);
    const instance = result[0]!;
    expect(instance.nodeIds[1]).toBe('event:FailedMount:app-pod:default');
  });

  it('nodeIds ends with the concrete crashloop finding ID', () => {
    const result = matchCausalTemplate([crashloopFinding], [failedMountEvent], []);
    const instance = result[0]!;
    expect(instance.nodeIds[instance.nodeIds.length - 1]).toBe(crashloopFinding.id);
  });

  it('produces 2 causes edges', () => {
    const result = matchCausalTemplate([crashloopFinding], [failedMountEvent], []);
    const instance = result[0]!;
    expect(instance.edges).toHaveLength(2);
    expect(instance.edges.every((e) => e.type === 'causes')).toBe(true);
  });

  it('first edge: missing-secret → FailedMount', () => {
    const result = matchCausalTemplate([crashloopFinding], [failedMountEvent], []);
    const edge = result[0]!.edges[0]!;
    expect(edge.source).toBe('finding:missing-secret:app-credentials:default');
    expect(edge.target).toBe('event:FailedMount:app-pod:default');
  });

  it('second edge: FailedMount → crashloop finding', () => {
    const result = matchCausalTemplate([crashloopFinding], [failedMountEvent], []);
    const edge = result[0]!.edges[1]!;
    expect(edge.source).toBe('event:FailedMount:app-pod:default');
    expect(edge.target).toBe(crashloopFinding.id);
  });

  it('all edges have non-empty ids and weight ≥ 0', () => {
    const result = matchCausalTemplate([crashloopFinding], [failedMountEvent], []);
    for (const edge of result[0]!.edges) {
      expect(edge.id).toBeTruthy();
      expect(edge.weight).toBeGreaterThanOrEqual(0);
    }
  });

  it('does not match when FailedMount event is in a different namespace', () => {
    const otherNsEvent: K8sEvent = {
      ...failedMountEvent,
      involvedObject: { ...failedMountEvent.involvedObject, namespace: 'prod' },
    };
    const result = matchCausalTemplate([crashloopFinding], [otherNsEvent], []);
    expect(result).toHaveLength(0);
  });

  it('does not match when FailedMount event is for a different pod', () => {
    const otherPodEvent: K8sEvent = {
      ...failedMountEvent,
      involvedObject: { ...failedMountEvent.involvedObject, name: 'other-pod' },
    };
    const result = matchCausalTemplate([crashloopFinding], [otherPodEvent], []);
    expect(result).toHaveLength(0);
  });

  it('does not match when FailedMount event message has no secret name', () => {
    const noSecretEvent: K8sEvent = {
      ...failedMountEvent,
      message: 'FailedMount: some volume issue without a secret name',
    };
    const result = matchCausalTemplate([crashloopFinding], [noSecretEvent], []);
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// matchCausalTemplate — BadImageTag pattern
// ---------------------------------------------------------------------------

describe('matchCausalTemplate — BadImageTag → ErrImagePull → ImagePullBackOff', () => {
  const imagePullFinding: Finding = {
    id: 'finding:k8s:imagepull:0',
    title: "ImagePullBackOff: Pod 'app-pod' in namespace 'default' (image: myapp:v999.99.99)",
    severity: 'critical',
    confidence: 0.95,
    affectedComponents: ['Pod/default/app-pod', 'Container/app', 'Image/myapp:v999.99.99'],
    reasoningSummary: 'ImagePullBackOff for image myapp:v999.99.99.',
    evidence: [],
    contradictionsChecked: [],
    recommendedAction: '',
    missingEvidence: [],
  };

  const errImagePullEvent: K8sEvent = {
    type: 'Warning',
    reason: 'ErrImagePull',
    message: 'rpc error: code = NotFound desc = failed to pull image "myapp:v999.99.99": not found',
    involvedObject: { kind: 'Pod', name: 'app-pod', namespace: 'default' },
    count: 5,
    firstTimestamp: '2024-01-15T16:00:12Z',
    lastTimestamp: '2024-01-15T16:05:12Z',
  };

  it('returns exactly one template instance', () => {
    const result = matchCausalTemplate([imagePullFinding], [errImagePullEvent], []);
    expect(result).toHaveLength(1);
  });

  it('matched instance has templateId bad-image-tag', () => {
    const result = matchCausalTemplate([imagePullFinding], [errImagePullEvent], []);
    expect(result[0]?.templateId).toBe('bad-image-tag');
  });

  it('nodeIds[0] is a synthetic bad-image-tag node', () => {
    const result = matchCausalTemplate([imagePullFinding], [errImagePullEvent], []);
    expect(result[0]?.nodeIds[0]).toContain('finding:bad-image-tag:');
  });

  it('nodeIds[1] is an ErrImagePull event node for app-pod', () => {
    const result = matchCausalTemplate([imagePullFinding], [errImagePullEvent], []);
    expect(result[0]?.nodeIds[1]).toBe('event:ErrImagePull:app-pod:default');
  });

  it('nodeIds[2] is the concrete imagepull finding ID', () => {
    const result = matchCausalTemplate([imagePullFinding], [errImagePullEvent], []);
    expect(result[0]?.nodeIds[2]).toBe(imagePullFinding.id);
  });

  it('produces 2 causes edges', () => {
    const result = matchCausalTemplate([imagePullFinding], [errImagePullEvent], []);
    expect(result[0]?.edges).toHaveLength(2);
    expect(result[0]?.edges.every((e) => e.type === 'causes')).toBe(true);
  });

  it('does not match when no ErrImagePull events are present', () => {
    const result = matchCausalTemplate([imagePullFinding], [], []);
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// matchCausalTemplate — DNSFailure → ConnectionTimeout pattern
// ---------------------------------------------------------------------------

describe('matchCausalTemplate — DNSFailure → ConnectionTimeout (log findings)', () => {
  const dnsFinding: Finding = {
    id: 'finding:log:dns:0',
    title: 'DNS Resolution Failures in logs/app-pod.log',
    severity: 'high',
    confidence: 0.85,
    affectedComponents: ['Pod/default/app-pod', 'DNS/db.internal'],
    reasoningSummary: 'DNS failure for db.internal',
    evidence: [],
    contradictionsChecked: [],
    recommendedAction: '',
    missingEvidence: [],
  };

  const connFinding: Finding = {
    id: 'finding:log:connection-timeout:0',
    title: 'Connection Timeout/Refused in logs/app-pod.log',
    severity: 'high',
    confidence: 0.80,
    affectedComponents: ['Pod/default/app-pod'],
    reasoningSummary: 'Connection timed out',
    evidence: [],
    contradictionsChecked: [],
    recommendedAction: '',
    missingEvidence: [],
  };

  it('returns one instance when dns and connection-timeout are both present', () => {
    const result = matchCausalTemplate([dnsFinding, connFinding], [], []);
    expect(result).toHaveLength(1);
    expect(result[0]?.templateId).toBe('dns-failure-connection-timeout');
  });

  it('nodeIds[0] is the DNS finding ID', () => {
    const result = matchCausalTemplate([dnsFinding, connFinding], [], []);
    expect(result[0]?.nodeIds[0]).toBe(dnsFinding.id);
  });

  it('nodeIds[1] is the connection-timeout finding ID', () => {
    const result = matchCausalTemplate([dnsFinding, connFinding], [], []);
    expect(result[0]?.nodeIds[1]).toBe(connFinding.id);
  });

  it('produces at least 1 causes edge', () => {
    const result = matchCausalTemplate([dnsFinding, connFinding], [], []);
    expect(result[0]?.edges.length).toBeGreaterThanOrEqual(1);
    expect(result[0]?.edges.every((e) => e.type === 'causes')).toBe(true);
  });

  it('does not match when pods are in different namespaces', () => {
    const connFindingOtherNs: Finding = {
      ...connFinding,
      affectedComponents: ['Pod/prod/app-pod'],
    };
    const result = matchCausalTemplate([dnsFinding, connFindingOtherNs], [], []);
    expect(result).toHaveLength(0);
  });

  it('does not match when pods have different names', () => {
    const connFindingOtherPod: Finding = {
      ...connFinding,
      affectedComponents: ['Pod/default/other-pod'],
    };
    const result = matchCausalTemplate([dnsFinding, connFindingOtherPod], [], []);
    expect(result).toHaveLength(0);
  });

  it('includes notready step when a matching notready finding is present', () => {
    const notReadyFinding: Finding = {
      id: 'finding:k8s:notready:0',
      title: 'Not Ready Pod: app-pod',
      severity: 'high',
      confidence: 0.75,
      affectedComponents: ['Pod/default/app-pod'],
      reasoningSummary: 'Pod not ready',
      evidence: [],
      contradictionsChecked: [],
      recommendedAction: '',
      missingEvidence: [],
    };
    const result = matchCausalTemplate(
      [dnsFinding, connFinding, notReadyFinding],
      [],
      [],
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.nodeIds).toContain(notReadyFinding.id);
    expect(result[0]?.edges.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// matchCausalTemplate — MissingStorageClass pattern
// ---------------------------------------------------------------------------

describe('matchCausalTemplate — MissingStorageClass → ProvisioningFailed → FailedMount → PodPending', () => {
  const pendingFinding: Finding = {
    id: 'finding:k8s:pending:0',
    title: "Pending Pod: 'db-pod' in namespace 'default' — PVC 'data-pvc' cannot provision (StorageClass 'fast-ssd' not found)",
    severity: 'critical',
    confidence: 0.90,
    affectedComponents: ['Pod/default/db-pod', 'PersistentVolumeClaim/default/data-pvc'],
    reasoningSummary: 'Pod stuck in Pending. ProvisioningFailed events.',
    evidence: [],
    contradictionsChecked: [],
    recommendedAction: '',
    missingEvidence: [],
  };

  const provisioningFailedEvent: K8sEvent = {
    type: 'Warning',
    reason: 'ProvisioningFailed',
    message: 'storageclass.storage.k8s.io "fast-ssd" not found',
    involvedObject: { kind: 'PersistentVolumeClaim', name: 'data-pvc', namespace: 'default' },
    count: 8,
    firstTimestamp: '2024-01-15T10:00:00Z',
    lastTimestamp: '2024-01-15T10:05:00Z',
  };

  it('returns exactly one template instance', () => {
    const result = matchCausalTemplate([pendingFinding], [provisioningFailedEvent], []);
    expect(result).toHaveLength(1);
  });

  it('matched instance has templateId missing-storage-class-pending', () => {
    const result = matchCausalTemplate([pendingFinding], [provisioningFailedEvent], []);
    expect(result[0]?.templateId).toBe('missing-storage-class-pending');
  });

  it('nodeIds[0] is a synthetic missing-storage-class node with fast-ssd', () => {
    const result = matchCausalTemplate([pendingFinding], [provisioningFailedEvent], []);
    expect(result[0]?.nodeIds[0]).toBe('finding:missing-storage-class:fast-ssd:default');
  });

  it('nodeIds[1] is a ProvisioningFailed event node for data-pvc', () => {
    const result = matchCausalTemplate([pendingFinding], [provisioningFailedEvent], []);
    expect(result[0]?.nodeIds[1]).toBe('event:ProvisioningFailed:data-pvc:default');
  });

  it('nodeIds[2] is a FailedMount event node for db-pod', () => {
    const result = matchCausalTemplate([pendingFinding], [provisioningFailedEvent], []);
    expect(result[0]?.nodeIds[2]).toBe('event:FailedMount:db-pod:default');
  });

  it('nodeIds[3] is the concrete pending finding ID', () => {
    const result = matchCausalTemplate([pendingFinding], [provisioningFailedEvent], []);
    expect(result[0]?.nodeIds[3]).toBe(pendingFinding.id);
  });

  it('produces 3 causes edges', () => {
    const result = matchCausalTemplate([pendingFinding], [provisioningFailedEvent], []);
    expect(result[0]?.edges).toHaveLength(3);
    expect(result[0]?.edges.every((e) => e.type === 'causes')).toBe(true);
  });

  it('does not match when no ProvisioningFailed events are present', () => {
    const result = matchCausalTemplate([pendingFinding], [], []);
    expect(result).toHaveLength(0);
  });

  it('does not match when ProvisioningFailed message lacks a quoted name', () => {
    const noNameEvent: K8sEvent = {
      ...provisioningFailedEvent,
      message: 'provisioning failed for some reason',
    };
    const result = matchCausalTemplate([pendingFinding], [noNameEvent], []);
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// matchCausalTemplate — multiple templates in one call
// ---------------------------------------------------------------------------

describe('matchCausalTemplate — multiple patterns simultaneously', () => {
  const crashloopFinding: Finding = {
    id: 'finding:k8s:crashloop:0',
    title: 'CrashLoopBackOff',
    severity: 'critical',
    confidence: 0.95,
    affectedComponents: ['Pod/default/app-pod', 'Container/app'],
    reasoningSummary: '',
    evidence: [],
    contradictionsChecked: [],
    recommendedAction: '',
    missingEvidence: [],
  };

  const imagePullFinding: Finding = {
    id: 'finding:k8s:imagepull:0',
    title: 'ImagePullBackOff',
    severity: 'critical',
    confidence: 0.95,
    affectedComponents: ['Pod/default/other-pod', 'Image/myapp:v999'],
    reasoningSummary: '',
    evidence: [],
    contradictionsChecked: [],
    recommendedAction: '',
    missingEvidence: [],
  };

  const failedMountEvent: K8sEvent = {
    type: 'Warning',
    reason: 'FailedMount',
    message: 'secret "app-credentials" not found',
    involvedObject: { kind: 'Pod', name: 'app-pod', namespace: 'default' },
    count: 1,
    firstTimestamp: '2024-01-15T13:30:10Z',
    lastTimestamp: '2024-01-15T13:30:10Z',
  };

  const errImagePullEvent: K8sEvent = {
    type: 'Warning',
    reason: 'ErrImagePull',
    message: 'failed to pull image "myapp:v999": not found',
    involvedObject: { kind: 'Pod', name: 'other-pod', namespace: 'default' },
    count: 1,
    firstTimestamp: '2024-01-15T16:00:12Z',
    lastTimestamp: '2024-01-15T16:00:12Z',
  };

  it('returns instances from both matched templates', () => {
    const result = matchCausalTemplate(
      [crashloopFinding, imagePullFinding],
      [failedMountEvent, errImagePullEvent],
      [],
    );
    const templateIds = result.map((i) => i.templateId);
    expect(templateIds).toContain('missing-secret-crashloop');
    expect(templateIds).toContain('bad-image-tag');
  });

  it('all returned edges have unique ids', () => {
    const result = matchCausalTemplate(
      [crashloopFinding, imagePullFinding],
      [failedMountEvent, errImagePullEvent],
      [],
    );
    const edgeIds = result.flatMap((i) => i.edges.map((e) => e.id));
    const uniqueIds = new Set(edgeIds);
    expect(uniqueIds.size).toBe(edgeIds.length);
  });
});

// ---------------------------------------------------------------------------
// Type guard: CausalTemplate and CausalChainStep are well-typed
// ---------------------------------------------------------------------------

describe('type contracts', () => {
  it('CausalTemplate has required shape', () => {
    const t: CausalTemplate = {
      id: 'test',
      name: 'Test',
      description: 'Test',
      chain: [{ nodeType: 'finding', category: 'foo', description: 'bar' }],
    };
    expect(t.id).toBe('test');
    expect(t.chain[0]?.nodeType).toBe('finding');
  });

  it('CausalChainStep accepts both nodeTypes', () => {
    const findingStep: CausalChainStep = { nodeType: 'finding', category: 'crashloop', description: 'x' };
    const eventStep: CausalChainStep = { nodeType: 'event', category: 'FailedMount', description: 'y' };
    expect(findingStep.nodeType).toBe('finding');
    expect(eventStep.nodeType).toBe('event');
  });

  it('CausalTemplateInstance has required shape', () => {
    const instance: CausalTemplateInstance = {
      templateId: 'test',
      templateName: 'Test',
      nodeIds: ['a', 'b'],
      edges: [{ id: 'e1', source: 'a', target: 'b', type: 'causes', weight: 0.9 }],
    };
    expect(instance.edges[0]?.type).toBe('causes');
  });
});
