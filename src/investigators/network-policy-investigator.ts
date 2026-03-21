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
  return `finding:netpol:${type}:${counter.value++}`;
}

function nextEdgeId(type: string, counter: Counter): string {
  return `edge:netpol:${type}:${counter.value++}`;
}

// ---------------------------------------------------------------------------
// Bundle file-path conventions
// ---------------------------------------------------------------------------

function networkPolicyFilePath(name: string, namespace: string): string {
  return `cluster-resources/networkpolicies/${namespace}/${name}.yaml`;
}

function podFilePath(name: string, namespace: string): string {
  return `cluster-resources/pods/${namespace}/${name}.yaml`;
}

function serviceFilePath(name: string, namespace: string): string {
  return `cluster-resources/services/${namespace}/${name}.yaml`;
}

// ---------------------------------------------------------------------------
// Confidence constants  [0, 1]
// ---------------------------------------------------------------------------

/**
 * Confidence when a NetworkPolicy definitively blocks all egress/ingress
 * (empty rule list with policyTypes declared).
 */
const CONF_BLOCK_ALL = 0.88;

/**
 * Confidence when a NetworkPolicy restricts egress/ingress to specific ports
 * and a service's port is not in the allowed set.
 */
const CONF_PORT_BLOCK = 0.82;

/**
 * Confidence when a NetworkPolicy blocks ingress to a pod that has a service.
 */
const CONF_INGRESS_BLOCK = 0.80;

// ---------------------------------------------------------------------------
// Label-selector matching
// ---------------------------------------------------------------------------

/**
 * Returns true when all key-value pairs in `selector` are present in `labels`.
 * An empty `selector` (`{}`) matches ALL pods (Kubernetes semantics).
 */
function matchesLabelSelector(
  labels: Record<string, string>,
  selector: Record<string, string>,
): boolean {
  for (const [key, value] of Object.entries(selector)) {
    if (labels[key] !== value) return false;
  }
  return true;
}

/**
 * Extracts `matchLabels` from a Kubernetes label selector object.
 * Returns an empty object when the selector is absent or has no matchLabels,
 * which — per Kubernetes semantics — selects ALL pods.
 */
function extractMatchLabels(selector: unknown): Record<string, string> {
  if (!isRecord(selector)) return {};
  const matchLabels = selector['matchLabels'];
  if (!isRecord(matchLabels)) return {};
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(matchLabels)) {
    if (typeof v === 'string') result[k] = v;
  }
  return result;
}

// ---------------------------------------------------------------------------
// NetworkPolicy rule types
// ---------------------------------------------------------------------------

interface PolicyPortSpec {
  port?: number | string;
  protocol?: string;
}

interface ParsedNetworkPolicy {
  name: string;
  namespace: string;
  podSelector: Record<string, string>;
  policyTypes: string[];
  ingressRules: unknown[];
  egressRules: unknown[];
  resource: K8sResource;
}

interface ServicePortSpec {
  port: number;
  protocol?: string;
}

interface ParsedService {
  name: string;
  namespace: string;
  selector: Record<string, string>;
  ports: ServicePortSpec[];
  resource: K8sResource;
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

function parseNetworkPolicies(resources: K8sResource[]): ParsedNetworkPolicy[] {
  const policies: ParsedNetworkPolicy[] = [];
  for (const resource of resources) {
    if (resource.kind !== 'NetworkPolicy') continue;
    if (!isRecord(resource.spec)) continue;

    const namespace = resource.metadata.namespace ?? 'default';
    const podSelector = extractMatchLabels(resource.spec['podSelector']);

    const policyTypes: string[] = [];
    const rawPolicyTypes = resource.spec['policyTypes'];
    if (Array.isArray(rawPolicyTypes)) {
      for (const pt of rawPolicyTypes) {
        if (typeof pt === 'string') policyTypes.push(pt);
      }
    }

    const ingressRules: unknown[] = Array.isArray(resource.spec['ingress'])
      ? (resource.spec['ingress'] as unknown[])
      : [];

    const egressRules: unknown[] = Array.isArray(resource.spec['egress'])
      ? (resource.spec['egress'] as unknown[])
      : [];

    policies.push({
      name: resource.metadata.name,
      namespace,
      podSelector,
      policyTypes,
      ingressRules,
      egressRules,
      resource,
    });
  }
  return policies;
}

function parseServices(resources: K8sResource[]): ParsedService[] {
  const services: ParsedService[] = [];
  for (const resource of resources) {
    if (resource.kind !== 'Service') continue;
    if (!isRecord(resource.spec)) continue;

    const namespace = resource.metadata.namespace ?? 'default';
    const selector = extractMatchLabels(resource.spec['selector']);

    const ports: ServicePortSpec[] = [];
    const rawPorts = resource.spec['ports'];
    if (Array.isArray(rawPorts)) {
      for (const p of rawPorts) {
        if (!isRecord(p)) continue;
        const portNum = typeof p['port'] === 'number' ? p['port'] : parseInt(String(p['port']), 10);
        if (!isNaN(portNum)) {
          ports.push({
            port: portNum,
            protocol: typeof p['protocol'] === 'string' ? p['protocol'] : 'TCP',
          });
        }
      }
    }

    services.push({
      name: resource.metadata.name,
      namespace,
      selector,
      ports,
      resource,
    });
  }
  return services;
}

// ---------------------------------------------------------------------------
// Egress rule analysis
// ---------------------------------------------------------------------------

/**
 * Extracts ports from a NetworkPolicy egress or ingress rule.
 * Returns an empty array when the rule has no port restrictions (allows all ports).
 */
function extractRulePorts(rule: unknown): PolicyPortSpec[] {
  if (!isRecord(rule)) return [];
  const rawPorts = rule['ports'];
  if (!Array.isArray(rawPorts)) return [];

  const ports: PolicyPortSpec[] = [];
  for (const p of rawPorts) {
    if (!isRecord(p)) continue;
    const port = p['port'];
    const protocol = typeof p['protocol'] === 'string' ? p['protocol'] : undefined;
    if (port !== undefined) {
      ports.push({
        port: typeof port === 'number' ? port : parseInt(String(port), 10),
        protocol,
      });
    }
  }
  return ports;
}

/**
 * Returns true when the given `servicePort` is allowed by the set of egress
 * rules in a NetworkPolicy.
 *
 * A port is allowed when:
 * 1. There are no egress rules at all AND policyTypes doesn't include 'Egress'
 *    (policy is not managing egress) — but the caller already handles this case.
 * 2. At least one rule has no port restrictions (allows all ports).
 * 3. At least one rule explicitly allows the service port.
 */
function isPortAllowedByEgressRules(
  egressRules: unknown[],
  servicePort: number,
  serviceProtocol: string,
): boolean {
  if (egressRules.length === 0) {
    // Empty egress rules + 'Egress' in policyTypes = DENY ALL
    return false;
  }

  for (const rule of egressRules) {
    const rulePorts = extractRulePorts(rule);
    if (rulePorts.length === 0) {
      // Rule with no port restriction = allow all ports
      return true;
    }
    for (const rulePort of rulePorts) {
      const portNum = typeof rulePort.port === 'number' ? rulePort.port : NaN;
      const protocolMatch =
        !rulePort.protocol ||
        !serviceProtocol ||
        rulePort.protocol.toUpperCase() === serviceProtocol.toUpperCase();
      if (portNum === servicePort && protocolMatch) {
        return true;
      }
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Finding builder helpers
// ---------------------------------------------------------------------------

interface EgressBlockFinding {
  type: 'egress-block';
  policy: ParsedNetworkPolicy;
  pod: K8sResource;
  service: ParsedService;
  blockedPorts: number[];
}

interface IngressBlockFinding {
  type: 'ingress-block';
  policy: ParsedNetworkPolicy;
  pod: K8sResource;
  service: ParsedService;
}

function buildEgressBlockFinding(
  scenario: EgressBlockFinding,
  counter: Counter,
): { finding: Finding; edges: GraphEdge[] } {
  const { policy, pod, service, blockedPorts } = scenario;
  const namespace = policy.namespace;
  const portList = blockedPorts.length > 0 ? blockedPorts.join(', ') : 'all ports';
  const isBlockAll = policy.egressRules.length === 0;

  const findingId = nextFindingId('egress-block', counter);
  const confidence = isBlockAll ? CONF_BLOCK_ALL : CONF_PORT_BLOCK;

  const title = isBlockAll
    ? `NetworkPolicy '${policy.name}' blocks all egress from Pod '${pod.metadata.name}' — cannot reach Service '${service.name}'`
    : `NetworkPolicy '${policy.name}' blocks egress from Pod '${pod.metadata.name}' to Service '${service.name}' on port ${portList}`;

  const evidence: Evidence[] = [
    {
      path: networkPolicyFilePath(policy.name, namespace),
      note: isBlockAll
        ? `NetworkPolicy '${policy.name}' declares 'Egress' policyType with no egress rules — all outbound traffic is denied`
        : `NetworkPolicy '${policy.name}' allows egress only on specific ports; port ${portList} (required by Service '${service.name}') is not in the allow list`,
      artifactType: 'kubernetes-resource',
    },
    {
      path: podFilePath(pod.metadata.name, pod.metadata.namespace ?? namespace),
      note: `Pod '${pod.metadata.name}' has labels that match NetworkPolicy '${policy.name}' podSelector`,
      artifactType: 'kubernetes-resource',
    },
    {
      path: serviceFilePath(service.name, service.namespace),
      note: `Service '${service.name}' exposes port ${portList} in namespace '${namespace}'`,
      artifactType: 'kubernetes-resource',
    },
  ];

  const finding: Finding = {
    id: findingId,
    title,
    severity: 'high' as FindingSeverity,
    confidence,
    affectedComponents: [
      `NetworkPolicy/${namespace}/${policy.name}`,
      `Pod/${pod.metadata.namespace ?? namespace}/${pod.metadata.name}`,
      `Service/${service.namespace}/${service.name}`,
    ],
    reasoningSummary:
      `NetworkPolicy '${policy.name}' in namespace '${namespace}' selects Pod '${pod.metadata.name}' ` +
      `(via podSelector labels) and ${isBlockAll ? 'denies ALL egress traffic' : `restricts egress to specific ports, blocking port ${portList}`}. ` +
      `Service '${service.name}' is reachable on port ${portList}, which ${isBlockAll ? 'is blocked by this policy' : `is not in the allowed port list`}. ` +
      `The pod cannot establish outbound connections to '${service.name}' on the required port.`,
    evidence,
    contradictionsChecked: [
      `NetworkPolicy '${policy.name}' policyTypes includes 'Egress'`,
      `Pod '${pod.metadata.name}' labels match policy podSelector`,
      `Service '${service.name}' has port ${portList}`,
    ],
    recommendedAction:
      `To allow '${pod.metadata.name}' to reach Service '${service.name}' on port ${portList}: ` +
      `(1) Add an egress rule to NetworkPolicy '${policy.name}' that permits port ${portList}: ` +
      `\`kubectl edit networkpolicy ${policy.name} -n ${namespace}\`. ` +
      `(2) Alternatively, create a separate NetworkPolicy that allows the specific egress traffic. ` +
      `(3) Verify the Service selector matches the target pods: \`kubectl describe service ${service.name} -n ${namespace}\`.`,
    missingEvidence: [
      `Pod logs for '${pod.metadata.name}' — would show connection refused/timeout errors to '${service.name}'`,
    ],
  };

  const edges: GraphEdge[] = [];

  // supports edges: evidence → finding
  for (const ev of evidence) {
    edges.push({
      id: nextEdgeId('supports', counter),
      source: `evidence:${ev.path}`,
      target: findingId,
      type: 'supports',
      weight: confidence,
    });
  }

  // causes edge: finding → downstream pod effect
  edges.push({
    id: nextEdgeId('causes', counter),
    source: findingId,
    target: `resource:Pod/${pod.metadata.namespace ?? namespace}/${pod.metadata.name}`,
    type: 'causes',
    weight: confidence,
    note: `NetworkPolicy '${policy.name}' blocks egress → Pod '${pod.metadata.name}' cannot reach '${service.name}' on port ${portList}`,
  });

  return { finding, edges };
}

function buildIngressBlockFinding(
  scenario: IngressBlockFinding,
  counter: Counter,
): { finding: Finding; edges: GraphEdge[] } {
  const { policy, pod, service } = scenario;
  const namespace = policy.namespace;
  const servicePorts = service.ports.map((p) => p.port).join(', ') || 'all';

  const findingId = nextFindingId('ingress-block', counter);
  const confidence = CONF_INGRESS_BLOCK;

  const title = `NetworkPolicy '${policy.name}' blocks all ingress to Pod '${pod.metadata.name}' — Service '${service.name}' cannot route traffic`;

  const evidence: Evidence[] = [
    {
      path: networkPolicyFilePath(policy.name, namespace),
      note: `NetworkPolicy '${policy.name}' declares 'Ingress' policyType with no ingress rules — all inbound traffic to selected pods is denied`,
      artifactType: 'kubernetes-resource',
    },
    {
      path: podFilePath(pod.metadata.name, pod.metadata.namespace ?? namespace),
      note: `Pod '${pod.metadata.name}' has labels that match NetworkPolicy '${policy.name}' podSelector`,
      artifactType: 'kubernetes-resource',
    },
    {
      path: serviceFilePath(service.name, service.namespace),
      note: `Service '${service.name}' targets Pod '${pod.metadata.name}' on port ${servicePorts} — all inbound traffic is blocked by the policy`,
      artifactType: 'kubernetes-resource',
    },
  ];

  const finding: Finding = {
    id: findingId,
    title,
    severity: 'high' as FindingSeverity,
    confidence,
    affectedComponents: [
      `NetworkPolicy/${namespace}/${policy.name}`,
      `Pod/${pod.metadata.namespace ?? namespace}/${pod.metadata.name}`,
      `Service/${service.namespace}/${service.name}`,
    ],
    reasoningSummary:
      `NetworkPolicy '${policy.name}' in namespace '${namespace}' selects Pod '${pod.metadata.name}' ` +
      `(via podSelector labels) and denies ALL ingress traffic. ` +
      `Service '${service.name}' selects this pod and exposes port ${servicePorts}, ` +
      `but all inbound connections to the pod are blocked by this policy. ` +
      `No traffic can reach '${pod.metadata.name}' through Service '${service.name}'.`,
    evidence,
    contradictionsChecked: [
      `NetworkPolicy '${policy.name}' policyTypes includes 'Ingress'`,
      `Pod '${pod.metadata.name}' labels match policy podSelector`,
      `Service '${service.name}' selects Pod '${pod.metadata.name}'`,
    ],
    recommendedAction:
      `To allow inbound traffic to '${pod.metadata.name}' through Service '${service.name}': ` +
      `(1) Add an ingress rule to NetworkPolicy '${policy.name}' that permits traffic on port ${servicePorts}: ` +
      `\`kubectl edit networkpolicy ${policy.name} -n ${namespace}\`. ` +
      `(2) Alternatively, create a separate NetworkPolicy that allows the specific ingress traffic. ` +
      `(3) Verify the Service selector: \`kubectl describe service ${service.name} -n ${namespace}\`.`,
    missingEvidence: [
      `Network traces showing dropped packets to '${pod.metadata.name}'`,
      `Client logs showing connection timeouts to Service '${service.name}'`,
    ],
  };

  const edges: GraphEdge[] = [];

  // supports edges: evidence → finding
  for (const ev of evidence) {
    edges.push({
      id: nextEdgeId('supports', counter),
      source: `evidence:${ev.path}`,
      target: findingId,
      type: 'supports',
      weight: confidence,
    });
  }

  // causes edge: finding → pod
  edges.push({
    id: nextEdgeId('causes', counter),
    source: findingId,
    target: `resource:Pod/${pod.metadata.namespace ?? namespace}/${pod.metadata.name}`,
    type: 'causes',
    weight: confidence,
    note: `NetworkPolicy '${policy.name}' blocks all ingress → Pod '${pod.metadata.name}' unreachable via Service '${service.name}'`,
  });

  return { finding, edges };
}

// ---------------------------------------------------------------------------
// Main investigator
// ---------------------------------------------------------------------------

/**
 * Investigates NetworkPolicy resources to detect when policies block traffic
 * between pods and services they're trying to reach (or services trying to
 * reach them).
 *
 * For each NetworkPolicy in the bundle:
 * 1. Identifies pods in the same namespace whose labels match the policy's
 *    pod selector.
 * 2. For **egress** policies: checks whether any Service in the namespace is
 *    reachable on its declared ports. When egress rules block all traffic
 *    (empty rule list) or don't allow the service's port, a `high`-severity
 *    finding is emitted.
 * 3. For **ingress** policies: when all ingress is denied (empty rule list),
 *    checks whether any Service targets the selected pods. If so, a finding
 *    is emitted because the service cannot route traffic to the pod.
 * 4. Creates causal edges:
 *    - `supports` edges from evidence items to the finding.
 *    - `causes` edges from the finding to the affected pod resource node.
 *
 * @param context - All parsed bundle data.
 * @param _seeds  - Investigation seeds (unused; present for API consistency).
 * @returns {@link InvestigatorResult} with findings and edges.
 */
export function investigateNetworkPolicies(
  context: InvestigatorContext,
  _seeds: InvestigationSeed[],
): InvestigatorResult {
  const findings: Finding[] = [];
  const edges: GraphEdge[] = [];
  const counter: Counter = { value: 0 };

  const policies = parseNetworkPolicies(context.resources);
  if (policies.length === 0) return { findings, edges };

  const services = parseServices(context.resources);

  // Index services by namespace for quick lookup
  const servicesByNamespace = new Map<string, ParsedService[]>();
  for (const svc of services) {
    const existing = servicesByNamespace.get(svc.namespace) ?? [];
    existing.push(svc);
    servicesByNamespace.set(svc.namespace, existing);
  }

  // Dedup key tracking to avoid duplicate findings for the same (policy, pod, service) triple
  const seenKeys = new Set<string>();

  for (const policy of policies) {
    const namespace = policy.namespace;

    // Find pods in the same namespace that match the policy's pod selector
    const matchingPods = context.resources.filter((r): r is K8sResource => {
      if (r.kind !== 'Pod') return false;
      if ((r.metadata.namespace ?? 'default') !== namespace) return false;
      const podLabels = r.metadata.labels ?? {};
      return matchesLabelSelector(podLabels, policy.podSelector);
    });

    if (matchingPods.length === 0) continue;

    const nsServices = servicesByNamespace.get(namespace) ?? [];

    // ── Egress analysis ─────────────────────────────────────────────────────
    if (policy.policyTypes.includes('Egress')) {
      for (const pod of matchingPods) {
        for (const svc of nsServices) {
          // Skip self-selection: pods whose labels match the service selector
          // receiving a finding for their own service is noise.
          // (The main value is finding cross-service blocking.)
          // Actually we still want to detect when a pod can't reach a service
          // in the same namespace, including its own backing service if it
          // also needs to initiate connections to another replica.
          // So no skip here — all services are candidates.

          const blockedPorts: number[] = [];

          for (const svcPort of svc.ports) {
            const portAllowed = isPortAllowedByEgressRules(
              policy.egressRules,
              svcPort.port,
              svcPort.protocol ?? 'TCP',
            );
            if (!portAllowed) {
              blockedPorts.push(svcPort.port);
            }
          }

          // Also flag when the service has no declared ports but egress is block-all
          const blockAll = policy.egressRules.length === 0;
          const hasBlockedPorts = blockedPorts.length > 0;

          if (!blockAll && !hasBlockedPorts) continue;

          // Dedup check
          const dedupeKey = `egress:${policy.name}:${pod.metadata.name}:${svc.name}`;
          if (seenKeys.has(dedupeKey)) continue;
          seenKeys.add(dedupeKey);

          const scenario: EgressBlockFinding = {
            type: 'egress-block',
            policy,
            pod,
            service: svc,
            blockedPorts: blockAll ? svc.ports.map((p) => p.port) : blockedPorts,
          };

          const { finding, edges: scenarioEdges } = buildEgressBlockFinding(scenario, counter);
          findings.push(finding);
          edges.push(...scenarioEdges);
        }

        // When the pod cannot reach ANY service and there are no services in
        // the namespace, still flag the block-all condition if services exist
        // in the bundle but not in this namespace.
        if (nsServices.length === 0 && policy.egressRules.length === 0) {
          const dedupeKey = `egress-noservice:${policy.name}:${pod.metadata.name}`;
          if (!seenKeys.has(dedupeKey)) {
            seenKeys.add(dedupeKey);
            const findingId = nextFindingId('egress-block', counter);
            const evidence: Evidence[] = [
              {
                path: networkPolicyFilePath(policy.name, namespace),
                note: `NetworkPolicy '${policy.name}' blocks all egress from Pod '${pod.metadata.name}' (no egress rules)`,
                artifactType: 'kubernetes-resource',
              },
              {
                path: podFilePath(pod.metadata.name, pod.metadata.namespace ?? namespace),
                note: `Pod '${pod.metadata.name}' is selected by NetworkPolicy '${policy.name}'`,
                artifactType: 'kubernetes-resource',
              },
            ];
            findings.push({
              id: findingId,
              title: `NetworkPolicy '${policy.name}' blocks all egress from Pod '${pod.metadata.name}'`,
              severity: 'high' as FindingSeverity,
              confidence: CONF_BLOCK_ALL,
              affectedComponents: [
                `NetworkPolicy/${namespace}/${policy.name}`,
                `Pod/${pod.metadata.namespace ?? namespace}/${pod.metadata.name}`,
              ],
              reasoningSummary:
                `NetworkPolicy '${policy.name}' in namespace '${namespace}' selects Pod '${pod.metadata.name}' ` +
                `and denies ALL egress traffic (policyType 'Egress' with no egress rules). ` +
                `The pod cannot initiate any outbound connections.`,
              evidence,
              contradictionsChecked: [
                `NetworkPolicy '${policy.name}' policyTypes includes 'Egress'`,
                `Pod '${pod.metadata.name}' labels match policy podSelector`,
              ],
              recommendedAction:
                `Add egress rules to NetworkPolicy '${policy.name}' in namespace '${namespace}' to allow ` +
                `the required outbound traffic. Run: \`kubectl edit networkpolicy ${policy.name} -n ${namespace}\`.`,
              missingEvidence: [
                `Pod logs for '${pod.metadata.name}' — would show connection timeouts`,
                `Services in namespace '${namespace}' — would identify blocked connection targets`,
              ],
            });
            for (const ev of evidence) {
              edges.push({
                id: nextEdgeId('supports', counter),
                source: `evidence:${ev.path}`,
                target: findingId,
                type: 'supports',
                weight: CONF_BLOCK_ALL,
              });
            }
            edges.push({
              id: nextEdgeId('causes', counter),
              source: findingId,
              target: `resource:Pod/${pod.metadata.namespace ?? namespace}/${pod.metadata.name}`,
              type: 'causes',
              weight: CONF_BLOCK_ALL,
              note: `NetworkPolicy '${policy.name}' blocks all egress → Pod '${pod.metadata.name}' cannot reach any service`,
            });
          }
        }
      }
    }

    // ── Ingress analysis ────────────────────────────────────────────────────
    if (policy.policyTypes.includes('Ingress') && policy.ingressRules.length === 0) {
      // Empty ingress rules + 'Ingress' in policyTypes = deny ALL ingress

      for (const pod of matchingPods) {
        // Find services that target this pod (service selector matches pod labels)
        const podLabels = pod.metadata.labels ?? {};
        const targetingServices = nsServices.filter((svc) => {
          if (Object.keys(svc.selector).length === 0) return false; // skip no-selector services
          return matchesLabelSelector(podLabels, svc.selector);
        });

        for (const svc of targetingServices) {
          const dedupeKey = `ingress:${policy.name}:${pod.metadata.name}:${svc.name}`;
          if (seenKeys.has(dedupeKey)) continue;
          seenKeys.add(dedupeKey);

          const scenario: IngressBlockFinding = {
            type: 'ingress-block',
            policy,
            pod,
            service: svc,
          };

          const { finding, edges: scenarioEdges } = buildIngressBlockFinding(scenario, counter);
          findings.push(finding);
          edges.push(...scenarioEdges);
        }

        // When no service is found but ingress is blocked, still emit a finding
        // for the pod itself (it can't receive any traffic).
        if (targetingServices.length === 0) {
          const dedupeKey = `ingress-noservice:${policy.name}:${pod.metadata.name}`;
          if (!seenKeys.has(dedupeKey)) {
            seenKeys.add(dedupeKey);
            const findingId = nextFindingId('ingress-block', counter);
            const evidence: Evidence[] = [
              {
                path: networkPolicyFilePath(policy.name, namespace),
                note: `NetworkPolicy '${policy.name}' blocks all ingress to Pod '${pod.metadata.name}' (no ingress rules)`,
                artifactType: 'kubernetes-resource',
              },
              {
                path: podFilePath(pod.metadata.name, pod.metadata.namespace ?? namespace),
                note: `Pod '${pod.metadata.name}' is selected by NetworkPolicy '${policy.name}'`,
                artifactType: 'kubernetes-resource',
              },
            ];
            findings.push({
              id: findingId,
              title: `NetworkPolicy '${policy.name}' blocks all ingress to Pod '${pod.metadata.name}'`,
              severity: 'medium' as FindingSeverity,
              confidence: CONF_INGRESS_BLOCK,
              affectedComponents: [
                `NetworkPolicy/${namespace}/${policy.name}`,
                `Pod/${pod.metadata.namespace ?? namespace}/${pod.metadata.name}`,
              ],
              reasoningSummary:
                `NetworkPolicy '${policy.name}' in namespace '${namespace}' selects Pod '${pod.metadata.name}' ` +
                `and denies ALL ingress traffic (policyType 'Ingress' with no ingress rules). ` +
                `No inbound connections can reach this pod.`,
              evidence,
              contradictionsChecked: [
                `NetworkPolicy '${policy.name}' policyTypes includes 'Ingress'`,
                `Pod '${pod.metadata.name}' labels match policy podSelector`,
              ],
              recommendedAction:
                `Add ingress rules to NetworkPolicy '${policy.name}' in namespace '${namespace}' to allow ` +
                `inbound traffic. Run: \`kubectl edit networkpolicy ${policy.name} -n ${namespace}\`.`,
              missingEvidence: [
                `Services targeting Pod '${pod.metadata.name}' — would identify traffic sources affected`,
              ],
            });
            for (const ev of evidence) {
              edges.push({
                id: nextEdgeId('supports', counter),
                source: `evidence:${ev.path}`,
                target: findingId,
                type: 'supports',
                weight: CONF_INGRESS_BLOCK,
              });
            }
            edges.push({
              id: nextEdgeId('causes', counter),
              source: findingId,
              target: `resource:Pod/${pod.metadata.namespace ?? namespace}/${pod.metadata.name}`,
              type: 'causes',
              weight: CONF_INGRESS_BLOCK,
              note: `NetworkPolicy '${policy.name}' blocks all ingress → Pod '${pod.metadata.name}' cannot receive any traffic`,
            });
          }
        }
      }
    }
  }

  return {
    findings: applyBatchFindingProvenance(findings, { investigator: 'network-policy' }),
    edges,
  };
}
