import type { GraphEdge } from '../types/index.js';
import type { K8sEvent, K8sResource } from '../types/index.js';
import type { Finding } from '../types/index.js';

// ---------------------------------------------------------------------------
// CausalChainStep
// ---------------------------------------------------------------------------

/**
 * A single step in an abstract causal chain.
 *
 * `nodeType` differentiates whether the step represents an investigator-produced
 * finding or a raw Kubernetes event observed in the bundle.
 */
export interface CausalChainStep {
  /** Whether this step is a finding (investigator-produced) or a raw K8s event. */
  nodeType: 'finding' | 'event';
  /**
   * Abstract category identifier.
   *
   * For findings: matches the segment of the finding ID produced by investigators,
   * e.g. `'missing-secret'`, `'crashloop'`, `'imagepull'`, `'pending'`, `'notready'`.
   *
   * For events: matches the Kubernetes event `reason` field,
   * e.g. `'FailedMount'`, `'ErrImagePull'`, `'ProvisioningFailed'`.
   */
  category: string;
  /** Human-readable description of this step in the failure chain. */
  description: string;
}

// ---------------------------------------------------------------------------
// CausalTemplate
// ---------------------------------------------------------------------------

/**
 * Defines an abstract causal chain from root cause to final observable symptom.
 *
 * Templates are matched against concrete findings, events, and resources by
 * {@link matchCausalTemplate} to produce {@link CausalTemplateInstance}s with
 * concrete node IDs and `causes` graph edges.
 */
export interface CausalTemplate {
  /** Unique identifier for this template (kebab-case). */
  id: string;
  /** Short human-readable label describing the full causal chain. */
  name: string;
  /** Detailed explanation of the failure mode this template describes. */
  description: string;
  /**
   * Ordered sequence of steps from root cause (index 0) to final symptom
   * (last index).
   */
  chain: CausalChainStep[];
}

// ---------------------------------------------------------------------------
// CausalTemplateInstance
// ---------------------------------------------------------------------------

/**
 * A concrete instantiation of a {@link CausalTemplate} against actual bundle
 * data.
 *
 * Contains concrete node IDs and the `causes` edges that should be added to
 * the diagnostic graph to represent the discovered causal chain.
 */
export interface CausalTemplateInstance {
  /** ID of the matched {@link CausalTemplate}. */
  templateId: string;
  /** Human-readable name of the matched template. */
  templateName: string;
  /**
   * Concrete node IDs from cause (index 0) to final symptom (last index).
   *
   * Some IDs may be *synthetic* — they represent inferred root-cause nodes
   * that do not correspond to actual `Finding` objects in the findings array
   * (e.g. `finding:missing-secret:app-credentials:default`).  The graph
   * builder is responsible for adding these as nodes when it processes the
   * returned edges.
   */
  nodeIds: string[];
  /**
   * Directed `causes` edges connecting consecutive nodes in {@link nodeIds}.
   * `edges[i].source === nodeIds[i]`, `edges[i].target === nodeIds[i+1]`.
   */
  edges: GraphEdge[];
}

// ---------------------------------------------------------------------------
// CAUSAL_TEMPLATES — the template library
// ---------------------------------------------------------------------------

/**
 * The canonical causal template library.
 *
 * Templates are ordered from most-specific to most-general so that matchers
 * can use first-match semantics when desired.
 *
 * Templates:
 * 1. MissingSecret → FailedMount → CrashLoopBackOff → DeploymentUnhealthy
 * 2. BadImageTag → ErrImagePull → ImagePullBackOff
 * 3. DNSFailure → ConnectionTimeout → ReadinessProbeFailure → PodNotReady
 * 4. OOMKill → ContainerRestart → CrashLoopBackOff
 * 5. ConfigMapTypo → AuthFailure → PodNotReady
 * 6. MissingStorageClass → ProvisioningFailed → FailedMount → PodPending
 */
export const CAUSAL_TEMPLATES: CausalTemplate[] = [
  // -------------------------------------------------------------------
  // 1. MissingSecret → FailedMount → CrashLoopBackOff → DeploymentUnhealthy
  // -------------------------------------------------------------------
  {
    id: 'missing-secret-crashloop',
    name: 'MissingSecret → FailedMount → CrashLoopBackOff → DeploymentUnhealthy',
    description:
      'A required Secret is absent from the namespace. ' +
      'The pod volume mount (or env injection) fails with FailedMount. ' +
      'The container exits immediately on startup, producing CrashLoopBackOff. ' +
      'The owning Deployment has no ready replicas and becomes unavailable.',
    chain: [
      {
        nodeType: 'finding',
        category: 'missing-secret',
        description: 'Required Secret is absent from the namespace',
      },
      {
        nodeType: 'event',
        category: 'FailedMount',
        description: 'Volume mount fails because the Secret does not exist',
      },
      {
        nodeType: 'finding',
        category: 'crashloop',
        description: 'Container exits immediately — CrashLoopBackOff',
      },
      {
        nodeType: 'finding',
        category: 'workload-unhealthy',
        description: 'Owning Deployment has zero ready replicas',
      },
    ],
  },

  // -------------------------------------------------------------------
  // 2. BadImageTag → ErrImagePull → ImagePullBackOff
  // -------------------------------------------------------------------
  {
    id: 'bad-image-tag',
    name: 'BadImageTag → ErrImagePull → ImagePullBackOff',
    description:
      'An image tag that does not exist in the registry is referenced in the pod spec. ' +
      'The kubelet fails to pull the image (ErrImagePull). ' +
      'After repeated failures Kubernetes enters the back-off state (ImagePullBackOff).',
    chain: [
      {
        nodeType: 'finding',
        category: 'bad-image-tag',
        description: 'Image tag does not exist in the container registry',
      },
      {
        nodeType: 'event',
        category: 'ErrImagePull',
        description: 'Image pull fails — tag not found in registry',
      },
      {
        nodeType: 'finding',
        category: 'imagepull',
        description: 'Container is in ImagePullBackOff',
      },
    ],
  },

  // -------------------------------------------------------------------
  // 3. DNSFailure → ConnectionTimeout → ReadinessProbeFailure → PodNotReady
  // -------------------------------------------------------------------
  {
    id: 'dns-failure-connection-timeout',
    name: 'DNSFailure → ConnectionTimeout → ReadinessProbeFailure → PodNotReady',
    description:
      'DNS resolution fails for a service dependency hostname. ' +
      'Network connections time out because the host cannot be resolved. ' +
      'The application fails its readiness probe due to the unreachable dependency. ' +
      'Kubernetes marks the pod as not ready.',
    chain: [
      {
        nodeType: 'finding',
        category: 'dns-failure',
        description: 'DNS resolution fails for a dependency hostname',
      },
      {
        nodeType: 'finding',
        category: 'connection-timeout',
        description: 'Network connection times out due to DNS resolution failure',
      },
      {
        nodeType: 'finding',
        category: 'notready',
        description: 'Readiness probe fails — pod is marked not ready',
      },
    ],
  },

  // -------------------------------------------------------------------
  // 4. OOMKill → ContainerRestart → CrashLoopBackOff
  // -------------------------------------------------------------------
  {
    id: 'oom-kill-crashloop',
    name: 'OOMKill → ContainerRestart → CrashLoopBackOff',
    description:
      'The container exceeds its memory limit and is killed by the Linux OOM killer. ' +
      'Kubernetes restarts the container automatically. ' +
      'Repeated OOM kills cause the restart loop to enter CrashLoopBackOff.',
    chain: [
      {
        nodeType: 'finding',
        category: 'oom-kill',
        description: 'Container is OOM killed — memory limit exceeded',
      },
      {
        nodeType: 'event',
        category: 'OOMKilling',
        description: 'OOM kill event recorded by the kubelet or node',
      },
      {
        nodeType: 'finding',
        category: 'crashloop',
        description: 'Container is in CrashLoopBackOff due to repeated OOM kills',
      },
    ],
  },

  // -------------------------------------------------------------------
  // 5. ConfigMapTypo → AuthFailure → PodNotReady
  // -------------------------------------------------------------------
  {
    id: 'configmap-auth-failure',
    name: 'ConfigMapTypo → AuthFailure → PodNotReady',
    description:
      'A value in a ConfigMap is misconfigured (e.g. wrong credentials, incorrect connection string, typo in hostname). ' +
      'The application fails to authenticate to its dependency. ' +
      'The readiness probe fails and the pod is marked not ready.',
    chain: [
      {
        nodeType: 'finding',
        category: 'configmap-error',
        description: 'ConfigMap contains an incorrect or missing value',
      },
      {
        nodeType: 'finding',
        category: 'auth-failure',
        description: 'Application authentication fails due to wrong configuration',
      },
      {
        nodeType: 'finding',
        category: 'notready',
        description: 'Readiness probe fails — pod is marked not ready',
      },
    ],
  },

  // -------------------------------------------------------------------
  // 6. MissingStorageClass → ProvisioningFailed → FailedMount → PodPending
  // -------------------------------------------------------------------
  {
    id: 'missing-storage-class-pending',
    name: 'MissingStorageClass → ProvisioningFailed → FailedMount → PodPending',
    description:
      'A PVC references a StorageClass that does not exist in the cluster. ' +
      'The PVC provisioner cannot create the backing volume (ProvisioningFailed). ' +
      'The pod volume mount fails (FailedMount) because no volume is available. ' +
      'The pod remains stuck in Pending state.',
    chain: [
      {
        nodeType: 'finding',
        category: 'missing-storage-class',
        description: 'StorageClass referenced by PVC does not exist',
      },
      {
        nodeType: 'event',
        category: 'ProvisioningFailed',
        description: 'PVC volume provisioning fails — StorageClass not found',
      },
      {
        nodeType: 'event',
        category: 'FailedMount',
        description: 'Pod volume mount fails — provisioned volume not available',
      },
      {
        nodeType: 'finding',
        category: 'pending',
        description: 'Pod is stuck in Pending state',
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

let _edgeCounter = 0;

function nextCausalEdgeId(): string {
  return `edge:causal:${++_edgeCounter}`;
}

/**
 * Extracts the category segment from a finding ID produced by investigators.
 *
 * ID formats:
 * - `finding:k8s:crashloop:0`      → `'crashloop'`
 * - `finding:k8s:imagepull:1`      → `'imagepull'`
 * - `finding:log:dns:0`            → `'dns'`
 * - `finding:log:connection-timeout:1` → `'connection-timeout'`
 * - `finding:log:missing-resource:2`   → `'missing-resource'`
 */
export function extractFindingCategory(findingId: string): string {
  const parts = findingId.split(':');
  // format: finding:<source>:<category>:<n>
  // We want the third segment (index 2) which is the category
  return parts[2] ?? '';
}

/**
 * Extracts the pod name and namespace from a finding's `affectedComponents`.
 *
 * Returns `undefined` when no `Pod/<ns>/<name>` component is present.
 */
function extractPodInfo(
  finding: Finding,
): { podName: string; namespace: string } | undefined {
  for (const comp of finding.affectedComponents) {
    if (comp.startsWith('Pod/')) {
      const parts = comp.split('/');
      if (parts.length === 3 && parts[1] && parts[2]) {
        return { namespace: parts[1], podName: parts[2] };
      }
    }
  }
  return undefined;
}

/**
 * Attempts to extract a Kubernetes Secret name from a FailedMount event message.
 *
 * Handles patterns such as:
 * - `secret "app-credentials" not found`
 * - `secret 'app-credentials' not found`
 * - `secret app-credentials not found`
 * - `for volume "app-credentials": secret "app-credentials" not found`
 */
function extractSecretFromFailedMount(message: string): string | undefined {
  const dq = message.match(/secret\s+"([^"]+)"\s+not\s+found/i);
  if (dq?.[1]) return dq[1];
  const sq = message.match(/secret\s+'([^']+)'\s+not\s+found/i);
  if (sq?.[1]) return sq[1];
  const bare = message.match(/secret\s+([a-z0-9][a-z0-9-]*)\s+not\s+found/i);
  if (bare?.[1]) return bare[1];
  return undefined;
}

/**
 * Extracts a container image name from an ErrImagePull event message.
 *
 * Handles patterns such as:
 * - `failed to pull image "myapp:v999":`
 * - `pulling image "myapp:v999" failed`
 */
function extractImageFromErrImagePull(message: string): string | undefined {
  const dq = message.match(/(?:pull|pulling)\s+image\s+"([^"]+)"/i);
  if (dq?.[1]) return dq[1];
  const dq2 = message.match(/image\s+"([^"]+)"/i);
  if (dq2?.[1]) return dq2[1];
  return undefined;
}

/**
 * Extracts a StorageClass name from a ProvisioningFailed event message.
 *
 * Handles patterns such as:
 * - `storageclass.storage.k8s.io "fast-ssd" not found`
 */
function extractStorageClassFromProvisioning(message: string): string | undefined {
  const match = message.match(/["']([^"']+)['"]\s+not\s+found/i);
  return match?.[1];
}

/**
 * Builds a `causes` edge between two node IDs.
 */
function causesEdge(source: string, target: string, weight = 0.9): GraphEdge {
  return {
    id: nextCausalEdgeId(),
    source,
    target,
    type: 'causes',
    weight,
  };
}

// ---------------------------------------------------------------------------
// Per-template matchers
// ---------------------------------------------------------------------------

/**
 * Matches the **MissingSecret → FailedMount → CrashLoopBackOff** template.
 *
 * Detection strategy:
 * 1. Find all crashloop findings.
 * 2. For each, look for FailedMount events targeting the same pod that mention
 *    a Secret name in their message.
 * 3. Create the causal chain nodes and edges.
 */
function matchMissingSecretCrashLoop(
  findings: Finding[],
  events: K8sEvent[],
): CausalTemplateInstance[] {
  const template = CAUSAL_TEMPLATES.find((t) => t.id === 'missing-secret-crashloop')!;
  const instances: CausalTemplateInstance[] = [];

  const crashloopFindings = findings.filter(
    (f) => extractFindingCategory(f.id) === 'crashloop',
  );

  for (const crashFinding of crashloopFindings) {
    const podInfo = extractPodInfo(crashFinding);
    if (!podInfo) continue;
    const { podName, namespace } = podInfo;

    const failedMountEvents = events.filter(
      (e) =>
        e.reason === 'FailedMount' &&
        e.involvedObject.name === podName &&
        (e.involvedObject.namespace ?? 'default') === namespace,
    );

    const secretNames = new Set<string>();
    for (const evt of failedMountEvents) {
      const secretName = extractSecretFromFailedMount(evt.message);
      if (secretName) secretNames.add(secretName);
    }

    for (const secretName of secretNames) {
      const missingSecretId = `finding:missing-secret:${secretName}:${namespace}`;
      const failedMountId = `event:FailedMount:${podName}:${namespace}`;
      const crashloopId = crashFinding.id;

      const nodeIds = [missingSecretId, failedMountId, crashloopId];
      const edges: GraphEdge[] = [
        causesEdge(missingSecretId, failedMountId),
        causesEdge(failedMountId, crashloopId),
      ];

      instances.push({
        templateId: template.id,
        templateName: template.name,
        nodeIds,
        edges,
      });
    }
  }

  return instances;
}

/**
 * Matches the **BadImageTag → ErrImagePull → ImagePullBackOff** template.
 *
 * Detection strategy:
 * 1. Find all imagepull findings.
 * 2. For each, look for ErrImagePull events targeting the same pod.
 * 3. Extract the image tag and create the causal chain.
 */
function matchBadImageTag(
  findings: Finding[],
  events: K8sEvent[],
): CausalTemplateInstance[] {
  const template = CAUSAL_TEMPLATES.find((t) => t.id === 'bad-image-tag')!;
  const instances: CausalTemplateInstance[] = [];

  const imagePullFindings = findings.filter(
    (f) => extractFindingCategory(f.id) === 'imagepull',
  );

  for (const ipFinding of imagePullFindings) {
    const podInfo = extractPodInfo(ipFinding);
    if (!podInfo) continue;
    const { podName, namespace } = podInfo;

    const errImagePullEvents = events.filter(
      (e) =>
        e.reason === 'ErrImagePull' &&
        e.involvedObject.name === podName &&
        (e.involvedObject.namespace ?? 'default') === namespace,
    );

    if (errImagePullEvents.length === 0) continue;

    // Extract image name from first ErrImagePull event (or fall back to finding title)
    let imageKey = 'unknown';
    for (const evt of errImagePullEvents) {
      const img = extractImageFromErrImagePull(evt.message);
      if (img) {
        imageKey = img.replace(/[^a-zA-Z0-9._:-]/g, '-');
        break;
      }
    }

    // Also check affectedComponents for an Image/ entry
    for (const comp of ipFinding.affectedComponents) {
      if (comp.startsWith('Image/')) {
        imageKey = comp.slice('Image/'.length).replace(/[^a-zA-Z0-9._:-]/g, '-');
        break;
      }
    }

    const badImageId = `finding:bad-image-tag:${imageKey}:${namespace}`;
    const errImagePullId = `event:ErrImagePull:${podName}:${namespace}`;
    const imagePullId = ipFinding.id;

    const nodeIds = [badImageId, errImagePullId, imagePullId];
    const edges: GraphEdge[] = [
      causesEdge(badImageId, errImagePullId),
      causesEdge(errImagePullId, imagePullId),
    ];

    instances.push({
      templateId: template.id,
      templateName: template.name,
      nodeIds,
      edges,
    });
  }

  return instances;
}

/**
 * Matches the **DNSFailure → ConnectionTimeout → PodNotReady** template.
 *
 * Detection strategy:
 * 1. Find all dns-failure findings.
 * 2. For each, look for connection-timeout findings from the same pod.
 * 3. Optionally look for a notready finding for the same pod.
 * 4. Create the causal chain.
 */
function matchDnsFailureConnectionTimeout(
  findings: Finding[],
): CausalTemplateInstance[] {
  const template = CAUSAL_TEMPLATES.find(
    (t) => t.id === 'dns-failure-connection-timeout',
  )!;
  const instances: CausalTemplateInstance[] = [];

  const dnsFindings = findings.filter(
    (f) => extractFindingCategory(f.id) === 'dns',
  );
  const connFindings = findings.filter(
    (f) => extractFindingCategory(f.id) === 'connection-timeout',
  );
  const notReadyFindings = findings.filter(
    (f) => extractFindingCategory(f.id) === 'notready',
  );

  for (const dnsFinding of dnsFindings) {
    const dnsPod = extractPodInfo(dnsFinding);
    if (!dnsPod) continue;

    for (const connFinding of connFindings) {
      const connPod = extractPodInfo(connFinding);
      if (!connPod) continue;
      if (connPod.podName !== dnsPod.podName || connPod.namespace !== dnsPod.namespace) continue;

      // Optionally include a notready step
      const matchingNotReady = notReadyFindings.find((f) => {
        const np = extractPodInfo(f);
        return (
          np?.podName === dnsPod.podName && np?.namespace === dnsPod.namespace
        );
      });

      const nodeIds: string[] = [dnsFinding.id, connFinding.id];
      const edges: GraphEdge[] = [causesEdge(dnsFinding.id, connFinding.id, 0.8)];

      if (matchingNotReady) {
        nodeIds.push(matchingNotReady.id);
        edges.push(causesEdge(connFinding.id, matchingNotReady.id, 0.75));
      }

      instances.push({
        templateId: template.id,
        templateName: template.name,
        nodeIds,
        edges,
      });
    }
  }

  return instances;
}

/**
 * Matches the **MissingStorageClass → ProvisioningFailed → FailedMount → PodPending** template.
 *
 * Detection strategy:
 * 1. Find all pending findings.
 * 2. For each, look for ProvisioningFailed events for any PVC referenced by the pod.
 * 3. Extract StorageClass name and create the causal chain.
 */
function matchMissingStorageClassPending(
  findings: Finding[],
  events: K8sEvent[],
): CausalTemplateInstance[] {
  const template = CAUSAL_TEMPLATES.find(
    (t) => t.id === 'missing-storage-class-pending',
  )!;
  const instances: CausalTemplateInstance[] = [];

  const pendingFindings = findings.filter(
    (f) => extractFindingCategory(f.id) === 'pending',
  );

  for (const pendingFinding of pendingFindings) {
    const podInfo = extractPodInfo(pendingFinding);
    if (!podInfo) continue;
    const { namespace } = podInfo;

    // Find ProvisioningFailed events — they target PVCs, not Pods
    const provFailEvents = events.filter(
      (e) =>
        e.reason === 'ProvisioningFailed' &&
        e.involvedObject.kind === 'PersistentVolumeClaim' &&
        (e.involvedObject.namespace ?? 'default') === namespace,
    );

    if (provFailEvents.length === 0) continue;

    const firstPF = provFailEvents[0]!;
    const storageClass = extractStorageClassFromProvisioning(firstPF.message);
    if (!storageClass) continue;

    const pvcName = firstPF.involvedObject.name;
    const { podName } = podInfo;

    const missingScId = `finding:missing-storage-class:${storageClass}:${namespace}`;
    const provisioningFailedId = `event:ProvisioningFailed:${pvcName}:${namespace}`;
    const failedMountId = `event:FailedMount:${podName}:${namespace}`;
    const pendingId = pendingFinding.id;

    const nodeIds = [missingScId, provisioningFailedId, failedMountId, pendingId];
    const edges: GraphEdge[] = [
      causesEdge(missingScId, provisioningFailedId),
      causesEdge(provisioningFailedId, failedMountId),
      causesEdge(failedMountId, pendingId),
    ];

    instances.push({
      templateId: template.id,
      templateName: template.name,
      nodeIds,
      edges,
    });
  }

  return instances;
}

// ---------------------------------------------------------------------------
// matchCausalTemplate — public API
// ---------------------------------------------------------------------------

/**
 * Matches all known {@link CAUSAL_TEMPLATES} against the provided findings,
 * events, and resources.
 *
 * Returns an array of {@link CausalTemplateInstance}s, each describing a
 * concrete causal chain discovered in the data with the `causes` edges that
 * should be added to the diagnostic graph.
 *
 * The function is **pure** (no side effects) and can be called multiple times
 * on the same data without accumulating state — edge IDs are unique across
 * calls due to a module-level monotonic counter.
 *
 * @param findings  - All findings produced by all investigators.
 * @param events    - All raw Kubernetes events from the bundle.
 * @param resources - All parsed Kubernetes resources (currently unused but
 *                    reserved for future template matchers that need spec data).
 */
export function matchCausalTemplate(
  findings: Finding[],
  events: K8sEvent[],
  _resources: K8sResource[],
): CausalTemplateInstance[] {
  const instances: CausalTemplateInstance[] = [];

  instances.push(...matchMissingSecretCrashLoop(findings, events));
  instances.push(...matchBadImageTag(findings, events));
  instances.push(...matchDnsFailureConnectionTimeout(findings));
  instances.push(...matchMissingStorageClassPending(findings, events));

  return instances;
}
