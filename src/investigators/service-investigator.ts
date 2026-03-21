import type { Finding, FindingSeverity, Evidence, GraphEdge } from '../types/index.js';
import type { InvestigatorContext, InvestigatorResult, InvestigationSeed } from './types.js';
import type { K8sResource } from '../types/index.js';
import type { LogFile } from '../parsers/index.js';
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
  return `finding:service:${type}:${counter.value++}`;
}

function nextEdgeId(type: string, counter: Counter): string {
  return `edge:service:${type}:${counter.value++}`;
}

// ---------------------------------------------------------------------------
// Bundle file-path conventions
// ---------------------------------------------------------------------------

function serviceFilePath(name: string, namespace: string): string {
  return `cluster-resources/services/${namespace}/${name}.yaml`;
}

function endpointsFilePath(name: string, namespace: string): string {
  return `cluster-resources/endpoints/${namespace}/${name}.yaml`;
}

function podFilePath(name: string, namespace: string): string {
  return `cluster-resources/pods/${namespace}/${name}.yaml`;
}

// ---------------------------------------------------------------------------
// Confidence constants  [0, 1]
// ---------------------------------------------------------------------------

/**
 * Service exists but its Endpoints object has 0 ready addresses.
 * High confidence — this is a structural Kubernetes condition that is clearly
 * observable from the cluster state.
 */
const CONF_SERVICE_NO_ENDPOINTS = 0.85;

/**
 * Additional confidence boost when DNS failure log lines corroborate that
 * the service is unreachable.  The total confidence is capped at 0.97.
 */
const CONF_DNS_BOOST = 0.07;

// ---------------------------------------------------------------------------
// Env-var service reference helpers (re-used from config-investigator logic)
// ---------------------------------------------------------------------------

const SERVICE_HOST_KEY_RE = /_(HOST|SERVICE_HOST|SVC_HOST|ADDR|ADDRESS|ENDPOINT)$/i;

interface ServiceReference {
  serviceName: string;
  namespace?: string;
}

function extractHostCandidate(value: string): string | undefined {
  const trimmed = value.trim();

  const urlMatch = trimmed.match(/^https?:\/\/([^/?#:]+)(?::\d+)?(?:[/?#].*)?$/i);
  if (urlMatch?.[1]) return urlMatch[1].toLowerCase();

  const hostPortMatch = trimmed.match(/^([^:/?#]+):\d+$/);
  if (hostPortMatch?.[1]) return hostPortMatch[1].toLowerCase();

  if (/^[^\s/]+$/.test(trimmed)) return trimmed.toLowerCase();

  return undefined;
}

function isIpv4Address(value: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value);
}

function extractInClusterServiceRef(value: string): ServiceReference | undefined {
  const host = extractHostCandidate(value);
  if (!host || isIpv4Address(host)) return undefined;

  if (/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(host) && !host.includes('.')) {
    return { serviceName: host.toLowerCase() };
  }

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

// ---------------------------------------------------------------------------
// Endpoint health helpers
// ---------------------------------------------------------------------------

/**
 * Returns the count of ready endpoint addresses for the given Endpoints
 * resource.
 *
 * Kubernetes Endpoints have `subsets[].addresses` (ready) and
 * `subsets[].notReadyAddresses` (not ready).  We only count
 * `addresses` as ready.
 */
function countReadyEndpointAddresses(endpoints: K8sResource): number {
  // Handle both top-level `subsets` and `spec.subsets` layouts
  const subsets = (endpoints as unknown as Record<string, unknown>)['subsets'] ??
    (isRecord(endpoints.spec) ? endpoints.spec['subsets'] : undefined);
  if (!Array.isArray(subsets)) return 0;

  let count = 0;
  for (const subset of subsets) {
    if (!isRecord(subset)) continue;
    const addresses = subset['addresses'];
    if (Array.isArray(addresses)) count += addresses.length;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Service → pods that reference it via env vars
// ---------------------------------------------------------------------------

interface ServiceEnvRef {
  podName: string;
  namespace: string;
  containerName: string;
  envKey: string;
  envValue: string;
}

/**
 * Finds all pods that reference `serviceName` in `namespace` via env vars
 * whose key matches the service-host pattern (e.g. `DB_HOST`, `API_ENDPOINT`).
 */
function findPodsReferencingService(
  resources: K8sResource[],
  serviceName: string,
  namespace: string,
): ServiceEnvRef[] {
  const results: ServiceEnvRef[] = [];

  for (const resource of resources) {
    if (resource.kind !== 'Pod') continue;
    if (!isRecord(resource.spec)) continue;
    const podNamespace = resource.metadata.namespace ?? 'default';

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

        const targetNamespace = serviceRef.namespace ?? podNamespace;
        if (
          serviceRef.serviceName === serviceName.toLowerCase() &&
          targetNamespace === namespace
        ) {
          results.push({
            podName: resource.metadata.name,
            namespace: podNamespace,
            containerName,
            envKey,
            envValue,
          });
        }
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// DNS failure log cross-reference
// ---------------------------------------------------------------------------

const DNS_FAILURE_PATTERNS = [
  /no such host/i,
  /lookup\s+failed/i,
  /NXDOMAIN/i,
  /could not resolve/i,
  /dns.*fail/i,
  /connection refused/i,
];

/**
 * Returns log evidence lines where the service name appears in a DNS failure
 * or connection-refused context.
 */
function findDnsFailureLogs(
  logs: LogFile[],
  serviceName: string,
): { path: string; line: string }[] {
  const results: { path: string; line: string }[] = [];

  for (const logFile of logs) {
    for (const logLine of logFile.lines) {
      const content = logLine.content;
      if (!content.toLowerCase().includes(serviceName.toLowerCase())) continue;

      for (const pattern of DNS_FAILURE_PATTERNS) {
        if (pattern.test(content)) {
          results.push({ path: logFile.path, line: content.trim() });
          break;
        }
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Pod readiness check
// ---------------------------------------------------------------------------

function isPodNotReady(resource: K8sResource): boolean {
  if (!isRecord(resource.status)) return false;
  const conditions = resource.status['conditions'];
  if (!Array.isArray(conditions)) return false;
  for (const cond of conditions) {
    if (isRecord(cond) && cond['type'] === 'Ready' && cond['status'] === 'False') {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Main investigator
// ---------------------------------------------------------------------------

/**
 * Investigates whether Services referenced by pod env vars have matching
 * Endpoints with ready addresses.
 *
 * For each Service in a namespace:
 * 1. Checks if the Service exists in the bundle resources.
 * 2. Looks up the corresponding Endpoints object.
 * 3. If the Endpoints object has 0 ready addresses (or is absent), emits a
 *    high-severity finding.
 * 4. Cross-references with DNS failure log lines — when logs show a DNS
 *    failure for the service name, confidence is boosted.
 * 5. Creates causal graph edges:
 *    - `supports` edges from evidence items to the finding
 *    - `causes` edges: finding → downstream pod-not-ready (when a referencing
 *      pod is not ready)
 *
 * Only Services in namespaces that **have at least one Service** in the
 * bundle are evaluated — this avoids false positives where the bundle simply
 * didn't capture the namespace's services.
 *
 * @param context - All parsed bundle data.
 * @param _seeds  - Investigation seeds (unused by this investigator; present
 *                  for API consistency with other investigators).
 * @returns {@link InvestigatorResult} with findings and edges.
 */
export function investigateServices(
  context: InvestigatorContext,
  _seeds: InvestigationSeed[],
): InvestigatorResult {
  const findings: Finding[] = [];
  const edges: GraphEdge[] = [];

  const counter: Counter = { value: 0 };

  // ── Index services and endpoints by namespace+name ────────────────────────

  /** namespace → serviceName → K8sResource */
  const servicesByNs = new Map<string, Map<string, K8sResource>>();
  for (const resource of context.resources) {
    if (resource.kind !== 'Service') continue;
    const ns = resource.metadata.namespace ?? 'default';
    let nsMap = servicesByNs.get(ns);
    if (!nsMap) { nsMap = new Map(); servicesByNs.set(ns, nsMap); }
    nsMap.set(resource.metadata.name, resource);
  }

  /** namespace → endpointsName → K8sResource */
  const endpointsByNs = new Map<string, Map<string, K8sResource>>();
  for (const resource of context.resources) {
    if (resource.kind !== 'Endpoints') continue;
    const ns = resource.metadata.namespace ?? 'default';
    let nsMap = endpointsByNs.get(ns);
    if (!nsMap) { nsMap = new Map(); endpointsByNs.set(ns, nsMap); }
    nsMap.set(resource.metadata.name, resource);
  }

  // ── Collect all services we need to check ────────────────────────────────
  //
  // Strategy: only check services that are referenced by at least one pod
  // via env vars, or that have an Endpoints object explicitly captured in
  // the bundle.  This keeps findings grounded in actual observed usage.

  // Build the set of (namespace, serviceName) pairs referenced by pods
  const referencedServices = new Set<string>();

  // Walk all pods and collect their env-var service references
  for (const resource of context.resources) {
    if (resource.kind !== 'Pod') continue;
    if (!isRecord(resource.spec)) continue;
    const podNamespace = resource.metadata.namespace ?? 'default';
    const containers = resource.spec['containers'];
    if (!Array.isArray(containers)) continue;

    for (const container of containers) {
      if (!isRecord(container)) continue;
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
        const targetNs = serviceRef.namespace ?? podNamespace;
        referencedServices.add(`${targetNs}/${serviceRef.serviceName}`);
      }
    }
  }

  // Also include any service that already has an Endpoints resource in the bundle
  // (they may not be in pod env vars but we have data on them)
  for (const [ns, nsMap] of endpointsByNs) {
    for (const [name] of nsMap) {
      referencedServices.add(`${ns}/${name}`);
    }
  }

  // ── Evaluate each referenced service ─────────────────────────────────────

  for (const key of referencedServices) {
    const slashIdx = key.indexOf('/');
    const namespace = key.slice(0, slashIdx);
    const serviceName = key.slice(slashIdx + 1);

    // Only investigate if the service actually exists in the bundle.
    // If we have no Service resource for this namespace, we can't make
    // structural assertions (bundle coverage gap).
    const nsServices = servicesByNs.get(namespace);
    if (!nsServices) continue;
    if (!nsServices.has(serviceName)) continue;

    // Check endpoint health
    const nsEndpoints = endpointsByNs.get(namespace);
    const endpointsResource = nsEndpoints?.get(serviceName);
    const readyCount = endpointsResource
      ? countReadyEndpointAddresses(endpointsResource)
      : -1; // -1 = Endpoints resource absent from bundle

    // Service has ready endpoints — no finding
    if (readyCount > 0) continue;

    // ── Build evidence ──────────────────────────────────────────────────────

    const evidence: Evidence[] = [];

    // Service resource itself
    evidence.push({
      path: serviceFilePath(serviceName, namespace),
      note: `Service '${serviceName}' exists in namespace '${namespace}' but has no ready endpoints`,
      artifactType: 'kubernetes-resource',
    });

    // Endpoints object (or its absence)
    if (endpointsResource) {
      evidence.push({
        path: endpointsFilePath(serviceName, namespace),
        note:
          readyCount === 0
            ? `Endpoints object for '${serviceName}' exists but has 0 ready addresses`
            : `Endpoints object for '${serviceName}' has no ready addresses`,
        artifactType: 'kubernetes-resource',
      });
    } else {
      evidence.push({
        path: endpointsFilePath(serviceName, namespace),
        note: `No Endpoints object found for Service '${serviceName}' in namespace '${namespace}' — no backends are registered`,
        artifactType: 'kubernetes-resource',
      });
    }

    // Find pods that reference this service via env vars (for evidence + causal edges)
    const referencingPods = findPodsReferencingService(
      context.resources,
      serviceName,
      namespace,
    );

    for (const ref of referencingPods) {
      evidence.push({
        path: podFilePath(ref.podName, ref.namespace),
        note: `Pod '${ref.podName}' references '${serviceName}' via env var ${ref.envKey}=${ref.envValue}`,
        artifactType: 'kubernetes-resource',
      });
    }

    // DNS failure log cross-reference
    const dnsFailureLogs = findDnsFailureLogs(context.logs, serviceName);
    let dnsBoost = 0;
    for (const { path, line } of dnsFailureLogs) {
      evidence.push({
        path,
        note: `DNS/connection failure log line referencing '${serviceName}': "${line}"`,
        artifactType: 'log',
      });
      dnsBoost = CONF_DNS_BOOST;
    }

    // ── Compute confidence ──────────────────────────────────────────────────

    const confidence = Math.min(0.97, CONF_SERVICE_NO_ENDPOINTS + dnsBoost);

    // ── Assemble the finding ────────────────────────────────────────────────

    const findingId = nextFindingId('no-endpoints', counter);

    const endpointsDescription =
      readyCount === -1
        ? 'No Endpoints resource was captured in the support bundle'
        : `The Endpoints object has ${readyCount} ready addresses`;

    findings.push({
      id: findingId,
      title: `Service '${serviceName}' has 0 ready endpoints — pods cannot connect`,
      severity: 'high' as FindingSeverity,
      confidence,
      affectedComponents: [
        `Service/${namespace}/${serviceName}`,
        ...referencingPods.map((ref) => `Pod/${ref.namespace}/${ref.podName}`),
      ],
      reasoningSummary:
        `Service '${serviceName}' in namespace '${namespace}' exists but has no ready backend endpoints. ` +
        `${endpointsDescription}. ` +
        (referencingPods.length > 0
          ? `${referencingPods.length} pod(s) reference this service via env vars and may be unable to connect. `
          : '') +
        (dnsFailureLogs.length > 0
          ? `Log evidence shows DNS/connection failures for '${serviceName}', confirming the service is unreachable. `
          : ''),
      evidence,
      contradictionsChecked: [
        `Service '${serviceName}' in namespace '${namespace}' — exists in bundle resources`,
        `Endpoints for '${serviceName}' — ${readyCount === -1 ? 'absent from bundle' : `${readyCount} ready addresses`}`,
      ],
      recommendedAction:
        `Investigate why Service '${serviceName}' has no ready endpoints: ` +
        `(1) Check if the pods backing the Service are running: \`kubectl get pods -n ${namespace} -l <service-selector>\`. ` +
        `(2) Verify the Service selector matches the pod labels: \`kubectl describe service ${serviceName} -n ${namespace}\`. ` +
        `(3) Check endpoint health: \`kubectl get endpoints ${serviceName} -n ${namespace}\`. ` +
        `(4) Ensure the backing pods pass readiness probes.`,
      missingEvidence: [
        `Pod logs for pods matching the Service '${serviceName}' selector — would show why pods are not ready`,
      ],
    });

    // ── Build edges ─────────────────────────────────────────────────────────

    // supports edges: evidence items → finding
    for (const ev of evidence) {
      edges.push({
        id: nextEdgeId('supports', counter),
        source: `evidence:${ev.path}`,
        target: findingId,
        type: 'supports',
        weight: confidence,
      });
    }

    // causes edges: finding → downstream pod-not-ready effects
    // We create a causal edge for each referencing pod that is not ready,
    // encoding the ServiceNoEndpoints → PodNotReady causal path.
    for (const ref of referencingPods) {
      const podResource = context.resources.find(
        (r) => r.kind === 'Pod' && r.metadata.name === ref.podName && r.metadata.namespace === ref.namespace,
      );
      if (podResource && isPodNotReady(podResource)) {
        const podNodeId = `finding:k8s:notready:${namespace}/${ref.podName}`;
        edges.push({
          id: nextEdgeId('causes', counter),
          source: findingId,
          target: podNodeId,
          type: 'causes',
          weight: confidence,
          note: `Service '${serviceName}' has no ready endpoints → Pod '${ref.podName}' cannot connect → PodNotReady`,
        });
      } else {
        // Even if the pod is currently ready (or we can't determine status),
        // emit a generic causal edge to the pod's endpoint component so the
        // graph shows the dependency path.
        edges.push({
          id: nextEdgeId('causes', counter),
          source: findingId,
          target: `resource:Pod/${ref.namespace}/${ref.podName}`,
          type: 'causes',
          weight: confidence * 0.7,
          note: `Service '${serviceName}' has no ready endpoints → Pod '${ref.podName}' dependency unavailable`,
        });
      }
    }

    // If no referencing pods found but Endpoints is empty, create a generic
    // causal edge to the ServiceNoEndpoints → ConnectionFailure pattern
    if (referencingPods.length === 0) {
      edges.push({
        id: nextEdgeId('causes', counter),
        source: findingId,
        target: `finding:service:connection-failure:${namespace}/${serviceName}`,
        type: 'causes',
        weight: confidence,
        note: `Service '${serviceName}' has no ready endpoints → ConnectionFailure for any consumer`,
      });
    }
  }

  return {
    findings: applyBatchFindingProvenance(findings, { investigator: 'service' }),
    edges,
  };
}
