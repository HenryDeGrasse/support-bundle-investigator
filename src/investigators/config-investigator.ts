import type { Finding, FindingSeverity, Evidence, GraphEdge } from '../types/index.js';
import type { InvestigatorContext, InvestigatorResult, InvestigationSeed } from './types.js';
import type { K8sResource } from '../types/index.js';
import { applyBatchFindingProvenance } from './finding-provenance.js';

// ---------------------------------------------------------------------------
// Internal utilities
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface Counter {
  value: number;
}

function nextFindingId(type: string, counter: Counter): string {
  return `finding:config:${type}:${counter.value++}`;
}

function nextEdgeId(counter: Counter): string {
  return `edge:config:${counter.value++}`;
}

// ---------------------------------------------------------------------------
// Bundle file-path conventions (mirrors kubernetes-investigator)
// ---------------------------------------------------------------------------

function podFilePath(name: string, namespace: string): string {
  return `cluster-resources/pods/${namespace}/${name}.yaml`;
}

function secretFilePath(name: string, namespace: string): string {
  return `cluster-resources/secrets/${namespace}/${name}.yaml`;
}

function serviceFilePath(name: string, namespace: string): string {
  return `cluster-resources/services/${namespace}/${name}.yaml`;
}

function workloadFilePath(kind: string, name: string, namespace: string): string {
  return `cluster-resources/${kind.toLowerCase()}s/${namespace}/${name}.yaml`;
}

// ---------------------------------------------------------------------------
// Confidence constants  [0, 1]
// ---------------------------------------------------------------------------

/**
 * Secret referenced in a pod spec but absent from Secret resources in the
 * same namespace.  High confidence because this is a structural assertion —
 * if there are other secrets in the namespace and this one isn't there, it
 * is genuinely missing.
 */
const CONF_MISSING_SECRET = 0.90;

/**
 * Env var key matches a service-host pattern and its value looks like a
 * Kubernetes service name that doesn't exist in the namespace.  Somewhat
 * lower because the value might be an external DNS name we can't verify,
 * or the service could reside in a different namespace.
 */
const CONF_MISSING_SERVICE_ENV_REF = 0.80;

/**
 * Container spec image differs from the running image recorded in pod status.
 * Very specific comparison — mismatches are almost always real.
 */
const CONF_IMAGE_TAG_MISMATCH = 0.85;

// ---------------------------------------------------------------------------
// Helpers: resource index builders
// ---------------------------------------------------------------------------

/**
 * Returns a map of namespace → Set<serviceName> built from all Service
 * resources in the context.
 */
function indexServicesByNamespace(resources: K8sResource[]): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const r of resources) {
    if (r.kind !== 'Service') continue;
    const ns = r.metadata.namespace ?? 'default';
    let set = index.get(ns);
    if (!set) {
      set = new Set();
      index.set(ns, set);
    }
    set.add(r.metadata.name);
  }
  return index;
}

/**
 * Returns a map of namespace → Set<secretName> built from all Secret
 * resources in the context.
 */
function indexSecretsByNamespace(resources: K8sResource[]): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const r of resources) {
    if (r.kind !== 'Secret') continue;
    const ns = r.metadata.namespace ?? 'default';
    let set = index.get(ns);
    if (!set) {
      set = new Set();
      index.set(ns, set);
    }
    set.add(r.metadata.name);
  }
  return index;
}

// ---------------------------------------------------------------------------
// 1. Env var references to non-existent services
// ---------------------------------------------------------------------------

/**
 * Env var key patterns that strongly suggest the value is an in-cluster
 * service hostname.  Examples: `DB_HOST`, `API_ENDPOINT`, `CACHE_ADDR`.
 */
const SERVICE_HOST_KEY_RE = /_(HOST|SERVICE_HOST|SVC_HOST|ADDR|ADDRESS|ENDPOINT)$/i;

/**
 * Parsed in-cluster service reference extracted from an env var value.
 *
 * `namespace` is omitted when the reference is relative to the pod's own
 * namespace (for example `redis` or `http://redis:6379`).
 */
interface ServiceReference {
  serviceName: string;
  namespace?: string;
}

function extractHostCandidate(value: string): string | undefined {
  const trimmed = value.trim();

  const urlMatch = trimmed.match(/^https?:\/\/([^/?#:]+)(?::\d+)?(?:[/?#].*)?$/i);
  if (urlMatch?.[1]) {
    return urlMatch[1].toLowerCase();
  }

  const hostPortMatch = trimmed.match(/^([^:/?#]+):\d+$/);
  if (hostPortMatch?.[1]) {
    return hostPortMatch[1].toLowerCase();
  }

  if (/^[^\s/]+$/.test(trimmed)) {
    return trimmed.toLowerCase();
  }

  return undefined;
}

function isIpv4Address(value: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value);
}

/**
 * Extracts a Kubernetes service reference from an env var value, or
 * `undefined` if the value doesn't look like an in-cluster service reference.
 *
 * Handles:
 * - Plain service name: `my-service`
 * - host:port: `my-service:5432`
 * - URL with optional port and path: `http://my-service:8080/path`
 * - In-cluster FQDN: `my-service.default.svc.cluster.local`
 */
function extractInClusterServiceRef(value: string): ServiceReference | undefined {
  const host = extractHostCandidate(value);
  if (!host || isIpv4Address(host)) {
    return undefined;
  }

  // Plain service name in the current namespace.
  if (/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(host) && !host.includes('.')) {
    return { serviceName: host.toLowerCase() };
  }

  // Fully-qualified in-cluster service host, e.g. service.ns.svc.cluster.local
  const fqdnMatch = host.match(
    /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.svc(?:\.cluster\.local)?$/i,
  );
  if (fqdnMatch?.[1] && fqdnMatch[2]) {
    return {
      serviceName: fqdnMatch[1].toLowerCase(),
      namespace: fqdnMatch[2].toLowerCase(),
    };
  }

  return undefined;
}

interface EnvServiceMismatch {
  podName: string;
  namespace: string;
  containerName: string;
  envKey: string;
  envValue: string;
  referencedService: string;
  referencedNamespace: string;
}

/**
 * Finds env vars in pod container specs whose names match a service-host
 * pattern and whose values point to service names that don't exist in the
 * namespace.
 *
 * Only namespaces that have **at least one** Service resource captured in
 * the bundle are checked — this avoids false positives in namespaces where
 * the bundle didn't include Service resources.
 */
function findEnvServiceMismatches(
  resources: K8sResource[],
  servicesByNs: Map<string, Set<string>>,
): EnvServiceMismatch[] {
  const result: EnvServiceMismatch[] = [];

  for (const resource of resources) {
    if (resource.kind !== 'Pod') continue;
    if (!isRecord(resource.spec)) continue;

    const podName = resource.metadata.name;
    const namespace = resource.metadata.namespace ?? 'default';

    // Skip kube-system pods — system components (kindnet, kube-proxy, etcd,
    // etc.) use env vars like CONTROL_PLANE_ENDPOINT that reference hostnames,
    // not K8s Service names. Checking them produces noisy false positives.
    if (namespace === 'kube-system') continue;

    const containers = resource.spec['containers'];
    if (!Array.isArray(containers)) continue;

    for (const container of containers) {
      if (!isRecord(container)) continue;
      const containerName =
        typeof container['name'] === 'string' ? container['name'] : 'unknown';
      const env = container['env'];
      if (!Array.isArray(env)) continue;

      for (const envVar of env) {
        if (!isRecord(envVar)) continue;
        const envKey = typeof envVar['name'] === 'string' ? envVar['name'] : '';
        const envValue = typeof envVar['value'] === 'string' ? envVar['value'] : '';

        if (!envKey || !envValue) continue;
        if (!SERVICE_HOST_KEY_RE.test(envKey)) continue;

        const serviceRef = extractInClusterServiceRef(envValue);
        if (!serviceRef) continue;

        const targetNamespace = serviceRef.namespace ?? namespace;
        const targetServices = servicesByNs.get(targetNamespace);
        if (!targetServices) continue;

        // Skip if the service exists in the resolved namespace
        if (targetServices.has(serviceRef.serviceName)) continue;

        result.push({
          podName,
          namespace,
          containerName,
          envKey,
          envValue,
          referencedService: serviceRef.serviceName,
          referencedNamespace: targetNamespace,
        });
      }
    }
  }

  return result;
}

/**
 * Produces a `high` {@link Finding} for every Pod whose env vars reference
 * an in-cluster service name that doesn't exist in the available Service
 * resources.
 *
 * Evidence includes:
 * - The pod resource file (listing the problematic env var key=value pairs)
 * - A virtual path for the missing Service (confirming its absence)
 */
function investigateEnvVarServiceRefs(
  context: InvestigatorContext,
  counter: Counter,
): { findings: Finding[]; edges: GraphEdge[] } {
  const findings: Finding[] = [];
  const edges: GraphEdge[] = [];

  const servicesByNs = indexServicesByNamespace(context.resources);
  const mismatches = findEnvServiceMismatches(context.resources, servicesByNs);

  // Group mismatches by pod so multiple env vars produce a single finding
  const byPod = new Map<string, EnvServiceMismatch[]>();
  for (const m of mismatches) {
    const key = `${m.namespace}/${m.podName}`;
    let arr = byPod.get(key);
    if (!arr) {
      arr = [];
      byPod.set(key, arr);
    }
    arr.push(m);
  }

  for (const [, podMismatches] of byPod) {
    const first = podMismatches[0]!;
    const { podName, namespace } = first;

    const podPath = podFilePath(podName, namespace);
    const uniqueServiceRefs = [
      ...new Set(
        podMismatches.map((m) => `${m.referencedNamespace}/${m.referencedService}`),
      ),
    ];
    const envVarList = podMismatches.map((m) => `${m.envKey}=${m.envValue}`).join(', ');
    const serviceList = uniqueServiceRefs.join(', ');

    const evidence: Evidence[] = [
      // Evidence 1: the referencing resource (pod spec with the env var)
      {
        path: podPath,
        note: `Pod spec references service name(s) via env var(s): ${envVarList}`,
        artifactType: 'kubernetes-resource',
      },
    ];

    // Evidence 2: absence of each referenced service
    for (const ref of uniqueServiceRefs) {
      const [serviceNamespace, serviceName] = ref.split('/');
      if (!serviceNamespace || !serviceName) continue;
      evidence.push({
        path: serviceFilePath(serviceName, serviceNamespace),
        note: `Service '${serviceName}' not found in namespace '${serviceNamespace}'`,
        artifactType: 'kubernetes-resource',
      });
    }

    const findingId = nextFindingId('env-service-ref', counter);

    findings.push({
      id: findingId,
      title: `Missing Service Reference: Pod '${podName}' env var(s) reference non-existent service(s)`,
      severity: 'high' as FindingSeverity,
      confidence: CONF_MISSING_SERVICE_ENV_REF,
      affectedComponents: [
        `Pod/${namespace}/${podName}`,
        ...uniqueServiceRefs.map((ref) => {
          const [serviceNamespace, serviceName] = ref.split('/');
          return `Service/${serviceNamespace}/${serviceName}`;
        }),
      ],
      reasoningSummary:
        `Pod '${podName}' in namespace '${namespace}' has environment variable(s) ` +
        `(${podMismatches.map((m) => m.envKey).join(', ')}) whose values reference ` +
        `in-cluster service name(s) '${serviceList}', but no matching Service resource(s) ` +
        `were found in the referenced namespace(s). This may prevent the pod from reaching its dependencies.`,
      evidence,
      contradictionsChecked: [
        `Service resource(s) '${serviceList}' not found in the referenced namespace(s)`,
        `Env var key(s) match service-host naming pattern — cross-referenced against available Service names`,
      ],
      recommendedAction:
        `Create or restore the missing Service resource(s): ${serviceList}. ` +
        `Alternatively, verify the environment variable values are correct ` +
        `and that services are deployed in the intended namespace. ` +
        `Use \`kubectl get services -A\` to list available services across namespaces.`,
      missingEvidence: [],
    });

    for (const ev of evidence) {
      edges.push({
        id: nextEdgeId(counter),
        source: `evidence:${ev.path}`,
        target: findingId,
        type: 'supports',
        weight: CONF_MISSING_SERVICE_ENV_REF,
      });
    }
  }

  return { findings, edges };
}

// ---------------------------------------------------------------------------
// 2. Secret references that don't exist
// ---------------------------------------------------------------------------

interface SecretRef {
  podName: string;
  namespace: string;
  secretName: string;
  /** Human-readable description of where the reference appears in the spec. */
  location: string;
}

/**
 * Collects all secret references from a pod spec, checking three locations:
 *
 * 1. `spec.volumes[].secret.secretName` (volume secret mounts)
 * 2. `spec.containers[].envFrom[].secretRef.name` (env injection)
 * 3. `spec.containers[].env[].valueFrom.secretKeyRef.name` (individual keys)
 */
function collectPodSecretRefs(resource: K8sResource): SecretRef[] {
  if (!isRecord(resource.spec)) return [];

  const podName = resource.metadata.name;
  const namespace = resource.metadata.namespace ?? 'default';
  const refs: SecretRef[] = [];

  // (a) spec.volumes[].secret.secretName
  const volumes = resource.spec['volumes'];
  if (Array.isArray(volumes)) {
    for (const volume of volumes) {
      if (!isRecord(volume)) continue;
      const secret = volume['secret'];
      if (isRecord(secret) && typeof secret['secretName'] === 'string') {
        const volName = typeof volume['name'] === 'string' ? volume['name'] : '';
        refs.push({
          podName,
          namespace,
          secretName: secret['secretName'],
          location: volName ? `volume '${volName}' (secret mount)` : 'volume (secret mount)',
        });
      }
    }
  }

  const containers = resource.spec['containers'];
  if (Array.isArray(containers)) {
    for (const container of containers) {
      if (!isRecord(container)) continue;
      const containerName =
        typeof container['name'] === 'string' ? container['name'] : 'unknown';

      // (b) spec.containers[].envFrom[].secretRef.name
      const envFrom = container['envFrom'];
      if (Array.isArray(envFrom)) {
        for (const ef of envFrom) {
          if (!isRecord(ef)) continue;
          const secretRef = ef['secretRef'];
          if (isRecord(secretRef) && typeof secretRef['name'] === 'string') {
            refs.push({
              podName,
              namespace,
              secretName: secretRef['name'],
              location: `container '${containerName}' envFrom.secretRef`,
            });
          }
        }
      }

      // (c) spec.containers[].env[].valueFrom.secretKeyRef.name
      const env = container['env'];
      if (Array.isArray(env)) {
        for (const envVar of env) {
          if (!isRecord(envVar)) continue;
          const varName = typeof envVar['name'] === 'string' ? envVar['name'] : '';
          const valueFrom = envVar['valueFrom'];
          if (!isRecord(valueFrom)) continue;
          const secretKeyRef = valueFrom['secretKeyRef'];
          if (isRecord(secretKeyRef) && typeof secretKeyRef['name'] === 'string') {
            refs.push({
              podName,
              namespace,
              secretName: secretKeyRef['name'],
              location: varName
                ? `container '${containerName}' env '${varName}' secretKeyRef`
                : `container '${containerName}' secretKeyRef`,
            });
          }
        }
      }
    }
  }

  return refs;
}

/**
 * Produces a `critical` {@link Finding} for every Pod that references a
 * Secret not present in the bundle's Secret resources.
 *
 * Only namespaces that have **at least one** Secret resource in the bundle
 * are checked — this avoids false positives when secrets simply weren't
 * captured.
 *
 * Evidence includes:
 * - The pod resource file (the referencing spec location)
 * - A virtual path for each missing Secret (confirming its absence)
 */
function investigateMissingSecrets(
  context: InvestigatorContext,
  counter: Counter,
): { findings: Finding[]; edges: GraphEdge[] } {
  const findings: Finding[] = [];
  const edges: GraphEdge[] = [];

  const secretsByNs = indexSecretsByNamespace(context.resources);

  // Collect all secret refs from pods and filter to missing ones
  const missingRefs: SecretRef[] = [];
  for (const resource of context.resources) {
    if (resource.kind !== 'Pod') continue;
    for (const ref of collectPodSecretRefs(resource)) {
      const secrets = secretsByNs.get(ref.namespace);
      // Only check namespaces where secrets are captured in the bundle
      if (!secrets) continue;
      if (!secrets.has(ref.secretName)) {
        missingRefs.push(ref);
      }
    }
  }

  // Group missing refs by pod for consolidated findings
  const byPod = new Map<string, SecretRef[]>();
  for (const ref of missingRefs) {
    const key = `${ref.namespace}/${ref.podName}`;
    let arr = byPod.get(key);
    if (!arr) {
      arr = [];
      byPod.set(key, arr);
    }
    arr.push(ref);
  }

  for (const [, podRefs] of byPod) {
    const first = podRefs[0]!;
    const { podName, namespace } = first;

    const podPath = podFilePath(podName, namespace);
    const uniqueSecretNames = [...new Set(podRefs.map((r) => r.secretName))];
    const refDesc = podRefs.map((r) => `${r.secretName} (via ${r.location})`).join(', ');
    const secretList = uniqueSecretNames.join(', ');

    const evidence: Evidence[] = [
      // Evidence 1: the referencing resource (pod spec)
      {
        path: podPath,
        note: `Pod spec references missing secret(s): ${refDesc}`,
        artifactType: 'kubernetes-resource',
      },
    ];

    // Evidence 2: absence of each missing secret
    for (const secretName of uniqueSecretNames) {
      evidence.push({
        path: secretFilePath(secretName, namespace),
        note: `Secret '${secretName}' not found in namespace '${namespace}'`,
        artifactType: 'kubernetes-resource',
      });
    }

    const findingId = nextFindingId('missing-secret', counter);

    findings.push({
      id: findingId,
      title: `Missing Secret: Pod '${podName}' references non-existent secret(s) in namespace '${namespace}'`,
      severity: 'critical' as FindingSeverity,
      confidence: CONF_MISSING_SECRET,
      affectedComponents: [
        `Pod/${namespace}/${podName}`,
        ...uniqueSecretNames.map((s) => `Secret/${namespace}/${s}`),
      ],
      reasoningSummary:
        `Pod '${podName}' in namespace '${namespace}' references secret(s) '${secretList}' ` +
        `via ${podRefs.map((r) => r.location).join(', ')}, ` +
        `but no matching Secret resource(s) exist in the namespace. ` +
        `This will cause the pod to fail to start or crash on secret lookup.`,
      evidence,
      contradictionsChecked: [
        `Secret resource(s) '${secretList}' not found in namespace '${namespace}'`,
        `References confirmed in pod spec (volume secret mount, envFrom.secretRef, or env.valueFrom.secretKeyRef)`,
      ],
      recommendedAction:
        `Create the missing Secret resource(s) in namespace '${namespace}': ${secretList}. ` +
        `Use \`kubectl create secret generic <name> -n ${namespace} --from-literal=key=value\` ` +
        `or apply a Secret manifest. ` +
        `Ensure all required secrets are deployed before starting pods that depend on them.`,
      missingEvidence: [],
    });

    for (const ev of evidence) {
      edges.push({
        id: nextEdgeId(counter),
        source: `evidence:${ev.path}`,
        target: findingId,
        type: 'supports',
        weight: CONF_MISSING_SECRET,
      });
    }
  }

  return { findings, edges };
}

// ---------------------------------------------------------------------------
// 3. Image tag mismatches
// ---------------------------------------------------------------------------

interface WorkloadImageSource {
  kind: string;
  name: string;
  namespace: string;
  selector: Record<string, string>;
  containerImages: Map<string, string>;
}

interface ImageMismatch {
  podName: string;
  namespace: string;
  containerName: string;
  specImage: string;
  statusImage: string;
  sourceKind: string;
  sourceName: string;
}

const WORKLOAD_IMAGE_KINDS = new Set([
  'Deployment',
  'StatefulSet',
  'DaemonSet',
  'ReplicaSet',
]);

/**
 * Normalizes an image reference for comparison.
 *
 * Handles:
 * 1. Strips digest suffixes: `myapp:v1.2.3@sha256:abc123` → `myapp:v1.2.3`
 * 2. Strips default Docker registry prefix: `docker.io/library/busybox` → `busybox`
 *    and `docker.io/hashicorp/http-echo` → `hashicorp/http-echo`
 * 3. Strips architecture suffixes that container runtimes append on multi-arch
 *    images: `registry.k8s.io/kube-proxy-arm64:v1.35.0` → `registry.k8s.io/kube-proxy:v1.35.0`
 *
 * This avoids false-positive mismatches when comparing spec images against
 * the runtime-resolved images in pod status.
 */
function normalizeImageRef(image: string): string {
  // 1. Strip digest suffix
  let normalized = image.split('@')[0]!.trim();

  // 2. Strip default Docker Hub registry prefixes
  // docker.io/library/busybox:tag → busybox:tag
  normalized = normalized.replace(/^docker\.io\/library\//, '');
  // docker.io/org/image:tag → org/image:tag
  normalized = normalized.replace(/^docker\.io\//, '');

  // 3. Strip architecture suffixes from image name (before the tag)
  // registry.k8s.io/kube-proxy-arm64:v1.35.0 → registry.k8s.io/kube-proxy:v1.35.0
  // This handles -arm64, -amd64, -s390x, -ppc64le suffixes
  normalized = normalized.replace(
    /-(arm64|amd64|s390x|ppc64le)(:|$)/,
    '$2',
  );

  return normalized;
}

function extractStringMap(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;

  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') return undefined;
    result[key] = entry;
  }

  return result;
}

function getContainerImageMapFromPodSpec(resource: K8sResource): Map<string, string> {
  if (!isRecord(resource.spec)) return new Map();

  const containers = resource.spec['containers'];
  if (!Array.isArray(containers)) return new Map();

  const images = new Map<string, string>();
  for (const container of containers) {
    if (!isRecord(container)) continue;
    const name = typeof container['name'] === 'string' ? container['name'] : '';
    const image = typeof container['image'] === 'string' ? container['image'] : '';
    if (!name || !image) continue;
    images.set(name, image);
  }

  return images;
}

function getContainerImageMapFromWorkload(resource: K8sResource): Map<string, string> {
  if (!isRecord(resource.spec)) return new Map();
  const template = resource.spec['template'];
  if (!isRecord(template)) return new Map();
  const templateSpec = template['spec'];
  if (!isRecord(templateSpec)) return new Map();

  const containers = templateSpec['containers'];
  if (!Array.isArray(containers)) return new Map();

  const images = new Map<string, string>();
  for (const container of containers) {
    if (!isRecord(container)) continue;
    const name = typeof container['name'] === 'string' ? container['name'] : '';
    const image = typeof container['image'] === 'string' ? container['image'] : '';
    if (!name || !image) continue;
    images.set(name, image);
  }

  return images;
}

function getStatusImageMap(resource: K8sResource): Map<string, string> {
  if (!isRecord(resource.status)) return new Map();
  const containerStatuses = resource.status['containerStatuses'];
  if (!Array.isArray(containerStatuses)) return new Map();

  const images = new Map<string, string>();
  for (const status of containerStatuses) {
    if (!isRecord(status)) continue;
    const name = typeof status['name'] === 'string' ? status['name'] : '';
    const image = typeof status['image'] === 'string' ? status['image'] : '';
    if (!name || !image) continue;
    images.set(name, image);
  }

  return images;
}

function extractWorkloadSelector(resource: K8sResource): Record<string, string> | undefined {
  if (!isRecord(resource.spec)) return undefined;
  const selector = resource.spec['selector'];
  if (!isRecord(selector)) return undefined;
  return extractStringMap(selector['matchLabels']);
}

function matchesSelector(
  podLabels: Record<string, string> | undefined,
  selector: Record<string, string>,
): boolean {
  if (!podLabels) return false;
  return Object.entries(selector).every(([key, value]) => podLabels[key] === value);
}

function buildWorkloadImageSources(resources: K8sResource[]): WorkloadImageSource[] {
  const sources: WorkloadImageSource[] = [];

  for (const resource of resources) {
    if (!WORKLOAD_IMAGE_KINDS.has(resource.kind)) continue;

    const selector = extractWorkloadSelector(resource);
    const containerImages = getContainerImageMapFromWorkload(resource);
    if (!selector || Object.keys(selector).length === 0 || containerImages.size === 0) {
      continue;
    }

    sources.push({
      kind: resource.kind,
      name: resource.metadata.name,
      namespace: resource.metadata.namespace ?? 'default',
      selector,
      containerImages,
    });
  }

  return sources;
}

function findBestMatchingWorkload(
  pod: K8sResource,
  workloadSources: WorkloadImageSource[],
): WorkloadImageSource | undefined {
  const namespace = pod.metadata.namespace ?? 'default';
  const podLabels = pod.metadata.labels;

  return workloadSources
    .filter(
      (source) =>
        source.namespace === namespace && matchesSelector(podLabels, source.selector),
    )
    .sort((a, b) => Object.keys(b.selector).length - Object.keys(a.selector).length)[0];
}

/**
 * Finds containers in pods where the desired workload/pod image differs from
 * the image recorded in pod status.
 *
 * Preference order for the desired image source:
 * 1. Matching workload template spec (Deployment/StatefulSet/DaemonSet/ReplicaSet)
 * 2. Pod spec image for standalone pods
 */
function findImageTagMismatches(resources: K8sResource[]): ImageMismatch[] {
  const mismatches: ImageMismatch[] = [];
  const workloadSources = buildWorkloadImageSources(resources);

  for (const resource of resources) {
    if (resource.kind !== 'Pod') continue;

    const statusImages = getStatusImageMap(resource);
    if (statusImages.size === 0) continue;

    const podName = resource.metadata.name;
    const namespace = resource.metadata.namespace ?? 'default';
    const matchedWorkload = findBestMatchingWorkload(resource, workloadSources);

    const desiredImages = matchedWorkload
      ? matchedWorkload.containerImages
      : getContainerImageMapFromPodSpec(resource);
    const sourceKind = matchedWorkload?.kind ?? 'Pod';
    const sourceName = matchedWorkload?.name ?? podName;

    for (const [containerName, specImage] of desiredImages.entries()) {
      const statusImage = statusImages.get(containerName);
      if (!statusImage) continue;

      if (normalizeImageRef(specImage) !== normalizeImageRef(statusImage)) {
        mismatches.push({
          podName,
          namespace,
          containerName,
          specImage,
          statusImage,
          sourceKind,
          sourceName,
        });
      }
    }
  }

  return mismatches;
}

/**
 * Produces a `medium` {@link Finding} for every Pod container whose desired
 * image tag differs from the image recorded in pod status.
 *
 * When a pod matches a workload selector, the workload template image is used
 * as the desired source of truth. Standalone pods fall back to their own pod
 * spec image.
 *
 * Evidence includes:
 * - The workload or pod resource that declares the desired image
 * - The pod resource that reports the running image in status
 */
function investigateImageTagMismatches(
  context: InvestigatorContext,
  counter: Counter,
): { findings: Finding[]; edges: GraphEdge[] } {
  const findings: Finding[] = [];
  const edges: GraphEdge[] = [];

  const mismatches = findImageTagMismatches(context.resources);

  for (const mismatch of mismatches) {
    const {
      podName,
      namespace,
      containerName,
      specImage,
      statusImage,
      sourceKind,
      sourceName,
    } = mismatch;
    const podPath = podFilePath(podName, namespace);
    const sourcePath =
      sourceKind === 'Pod'
        ? podPath
        : workloadFilePath(sourceKind, sourceName, namespace);

    const evidence: Evidence[] =
      sourceKind === 'Pod'
        ? [
            {
              path: podPath,
              note: `Container '${containerName}': spec image '${specImage}' differs from running image '${statusImage}'`,
              artifactType: 'kubernetes-resource',
            },
          ]
        : [
            {
              path: sourcePath,
              note: `${sourceKind} '${sourceName}' specifies image '${specImage}' for container '${containerName}'`,
              artifactType: 'kubernetes-resource',
            },
            {
              path: podPath,
              note: `Pod '${podName}' reports running image '${statusImage}' for container '${containerName}'`,
              artifactType: 'kubernetes-resource',
            },
          ];

    const findingId = nextFindingId('image-mismatch', counter);
    const desiredComponent = `${sourceKind}/${namespace}/${sourceName}`;
    const recommendedAction =
      sourceKind === 'Pod'
        ? `Investigate whether pod '${podName}' has been restarted since its image was updated. ` +
          `If this pod is managed by a higher-level workload, inspect that rollout. ` +
          `If the mismatch is unexpected, recreate or restart the pod so it converges to '${specImage}'.`
        : `Investigate whether the ${sourceKind.toLowerCase()} rollout completed successfully. ` +
          `If '${statusImage}' is the old version, check if the rollout is stalled. ` +
          `Use \`kubectl rollout status ${sourceKind.toLowerCase()} ${sourceName} -n ${namespace}\` to check rollout state. ` +
          `If the mismatch is unexpected, trigger a new rollout or restart the pod.`;

    findings.push({
      id: findingId,
      title: `Image Tag Mismatch: Container '${containerName}' in pod '${podName}' (namespace '${namespace}')`,
      severity: 'medium' as FindingSeverity,
      confidence: CONF_IMAGE_TAG_MISMATCH,
      affectedComponents: [
        desiredComponent,
        `Pod/${namespace}/${podName}`,
        `Container/${containerName}`,
        `Image/spec:${specImage}`,
        `Image/status:${statusImage}`,
      ],
      reasoningSummary:
        `Container '${containerName}' in pod '${podName}' (namespace '${namespace}') ` +
        `has a mismatch between the desired image '${specImage}' declared by ${sourceKind} '${sourceName}' ` +
        `and the running image '${statusImage}' reported in pod status. ` +
        `This typically indicates a rollout that is in progress or stalled, ` +
        `or a pod that has not yet converged to the desired image.`,
      evidence,
      contradictionsChecked: [
        `Desired image '${specImage}' and status image '${statusImage}' differ after digest normalisation`,
        `Container name '${containerName}' matched between desired spec and pod status containerStatuses`,
      ],
      recommendedAction,
      missingEvidence: [],
    });

    for (const ev of evidence) {
      edges.push({
        id: nextEdgeId(counter),
        source: `evidence:${ev.path}`,
        target: findingId,
        type: 'supports',
        weight: CONF_IMAGE_TAG_MISMATCH,
      });
    }
  }

  return { findings, edges };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Targeted configuration investigator.
 *
 * Analyses pod and workload configurations for three categories of issues,
 * each producing evidence-backed {@link Finding} objects with graph edges:
 *
 * 1. **Env var service references** — env var keys matching patterns like
 *    `*_HOST`, `*_ENDPOINT`, `*_ADDR` whose values look like in-cluster
 *    Kubernetes service names that don't exist in the namespace.  Only
 *    namespaces where at least one Service resource is present in the bundle
 *    are checked to avoid false positives.
 *
 * 2. **Missing secret references** — pod `spec.volumes[].secret`,
 *    `envFrom.secretRef`, and `env.valueFrom.secretKeyRef` that reference
 *    Secret resources absent from the bundle.  Only namespaces with at least
 *    one Secret resource captured are checked.
 *
 * 3. **Image tag mismatches** — workload template images (Deployment,
 *    StatefulSet, DaemonSet, ReplicaSet) compared against matching pod
 *    `status.containerStatuses[].image`; standalone pods fall back to their
 *    own `spec.containers[].image`. This identifies pods running an image
 *    different from the desired spec (e.g. stalled rollout or image update
 *    not yet reflected). Digest suffixes are stripped before comparison.
 *
 * Each finding includes evidence from both the referencing resource (the pod
 * spec) and the missing or mismatched target (absent Secret/Service or the
 * running image).
 *
 * @param context - All parsed bundle data.
 * @param seeds   - Investigation seeds (available for future prioritisation;
 *                  all resources are examined regardless of seed content).
 */
export function investigateConfig(
  context: InvestigatorContext,
  seeds: InvestigationSeed[],
): InvestigatorResult {
  void seeds;

  const counter: Counter = { value: 0 };

  const envServiceResult = investigateEnvVarServiceRefs(context, counter);
  const secretResult = investigateMissingSecrets(context, counter);
  const imageMismatchResult = investigateImageTagMismatches(context, counter);

  const findings = applyBatchFindingProvenance(
    [
      ...envServiceResult.findings,
      ...secretResult.findings,
      ...imageMismatchResult.findings,
    ],
    {
      investigator: 'config',
    },
  );

  return {
    findings,
    edges: [
      ...envServiceResult.edges,
      ...secretResult.edges,
      ...imageMismatchResult.edges,
    ],
  };
}
