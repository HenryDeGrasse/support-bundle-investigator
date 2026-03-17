import type { K8sEvent, K8sResource } from '../types/index.js';
import type { LogFile } from '../parsers/index.js';
import type { InvestigatorContext } from './types.js';
import type { EvidenceAssessment, Hypothesis, HypothesisCategory } from './hypothesis-types.js';

// ---------------------------------------------------------------------------
// Bundle file-path helpers (mirrors conventions in kubernetes-investigator)
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

function eventsFilePath(namespace: string): string {
  return `cluster-resources/events/${namespace}.json`;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Returns true when `value` is a plain object (not null, not array). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Returns a fresh, empty {@link EvidenceAssessment}.
 */
function emptyAssessment(): EvidenceAssessment {
  return { supporting: [], contradicting: [], missingDecisive: [] };
}

/**
 * Searches all log files for lines matching `pattern`.
 *
 * @returns Matching lines together with their source log file.
 */
function findInLogs(
  logs: LogFile[],
  pattern: RegExp,
): Array<{ logFile: LogFile; lineContent: string }> {
  const results: Array<{ logFile: LogFile; lineContent: string }> = [];
  for (const logFile of logs) {
    for (const line of logFile.lines) {
      if (pattern.test(line.content)) {
        results.push({ logFile, lineContent: line.content });
      }
    }
  }
  return results;
}

/**
 * Searches all events for those matching `reason` (case-insensitive) and
 * optionally `messagePattern`.
 */
function findEvents(
  events: K8sEvent[],
  reason: RegExp,
  messagePattern?: RegExp,
): K8sEvent[] {
  return events.filter(
    (ev) =>
      reason.test(ev.reason) &&
      (messagePattern == null || messagePattern.test(ev.message)),
  );
}

/**
 * Finds resources of a given `kind` in the context, optionally filtered by
 * namespace.
 */
function findResources(
  resources: K8sResource[],
  kind: string,
  namespace?: string,
): K8sResource[] {
  return resources.filter(
    (r) =>
      r.kind.toLowerCase() === kind.toLowerCase() &&
      (namespace == null || r.metadata.namespace === namespace),
  );
}

/** Indexes resource names by namespace for a given Kubernetes kind. */
function indexResourceNamesByNamespace(
  resources: K8sResource[],
  kind: string,
): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();

  for (const resource of resources) {
    if (resource.kind.toLowerCase() !== kind.toLowerCase()) continue;

    const namespace = resource.metadata.namespace ?? 'default';
    let names = index.get(namespace);
    if (names == null) {
      names = new Set<string>();
      index.set(namespace, names);
    }
    names.add(resource.metadata.name);
  }

  return index;
}

interface PodSecretReference {
  podName: string;
  namespace: string;
  secretName: string;
  location: string;
}

interface PodServiceReference {
  podName: string;
  namespace: string;
  hostValue: string;
  serviceName: string;
  serviceNamespace: string;
  location: string;
}

/**
 * Extracts Secret references from pod specs.
 *
 * Checks volume mounts, envFrom.secretRef, env.valueFrom.secretKeyRef, and
 * imagePullSecrets so the collector can compare referenced secrets against the
 * actual Secret inventory in the bundle.
 */
function collectPodSecretReferences(resources: K8sResource[]): PodSecretReference[] {
  const refs: PodSecretReference[] = [];

  for (const resource of resources) {
    if (resource.kind !== 'Pod' || !isRecord(resource.spec)) continue;

    const podName = resource.metadata.name;
    const namespace = resource.metadata.namespace ?? 'default';

    const volumes = resource.spec['volumes'];
    if (Array.isArray(volumes)) {
      for (const volume of volumes) {
        if (!isRecord(volume)) continue;
        const secret = volume['secret'];
        if (isRecord(secret) && typeof secret['secretName'] === 'string') {
          refs.push({
            podName,
            namespace,
            secretName: secret['secretName'],
            location: `volume '${String(volume['name'] ?? 'unknown')}'`,
          });
        }
      }
    }

    const imagePullSecrets = resource.spec['imagePullSecrets'];
    if (Array.isArray(imagePullSecrets)) {
      for (const imagePullSecret of imagePullSecrets) {
        if (!isRecord(imagePullSecret) || typeof imagePullSecret['name'] !== 'string') {
          continue;
        }
        refs.push({
          podName,
          namespace,
          secretName: imagePullSecret['name'],
          location: 'imagePullSecrets',
        });
      }
    }

    const containerGroups = [resource.spec['initContainers'], resource.spec['containers']];
    for (const containers of containerGroups) {
      if (!Array.isArray(containers)) continue;

      for (const container of containers) {
        if (!isRecord(container)) continue;
        const containerName = String(container['name'] ?? 'unknown');

        const envFrom = container['envFrom'];
        if (Array.isArray(envFrom)) {
          for (const entry of envFrom) {
            if (!isRecord(entry)) continue;
            const secretRef = entry['secretRef'];
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

        const env = container['env'];
        if (!Array.isArray(env)) continue;

        for (const envVar of env) {
          if (!isRecord(envVar)) continue;
          const valueFrom = envVar['valueFrom'];
          if (!isRecord(valueFrom)) continue;
          const secretKeyRef = valueFrom['secretKeyRef'];
          if (isRecord(secretKeyRef) && typeof secretKeyRef['name'] === 'string') {
            const envName = typeof envVar['name'] === 'string' ? envVar['name'] : 'unknown';
            refs.push({
              podName,
              namespace,
              secretName: secretKeyRef['name'],
              location: `container '${containerName}' env '${envName}' secretKeyRef`,
            });
          }
        }
      }
    }
  }

  return refs;
}

/**
 * Extracts in-cluster Service host references from pod specs.
 *
 * This currently inspects container environment variables whose values look
 * like hostnames, URLs, or host:port pairs. The collector uses these refs to
 * compare declared dependencies against the captured Service inventory.
 */
function collectPodServiceReferences(resources: K8sResource[]): PodServiceReference[] {
  const refs: PodServiceReference[] = [];

  for (const resource of resources) {
    if (resource.kind !== 'Pod' || !isRecord(resource.spec)) continue;

    const podName = resource.metadata.name;
    const namespace = resource.metadata.namespace ?? 'default';
    const containerGroups = [resource.spec['initContainers'], resource.spec['containers']];

    for (const containers of containerGroups) {
      if (!Array.isArray(containers)) continue;

      for (const container of containers) {
        if (!isRecord(container)) continue;
        const containerName = String(container['name'] ?? 'unknown');
        const env = container['env'];
        if (!Array.isArray(env)) continue;

        for (const envVar of env) {
          if (!isRecord(envVar) || typeof envVar['value'] !== 'string') continue;

          const envValue = envVar['value'];
          const serviceRef = extractInClusterServiceRef(envValue);
          if (serviceRef == null) continue;

          const envName = typeof envVar['name'] === 'string' ? envVar['name'] : 'unknown';
          refs.push({
            podName,
            namespace,
            hostValue: envValue,
            serviceName: serviceRef.serviceName,
            serviceNamespace: serviceRef.namespace ?? namespace,
            location: `container '${containerName}' env '${envName}'`,
          });
        }
      }
    }
  }

  return refs;
}

function extractSecretNameFromText(content: string): string | undefined {
  const match = content.match(
    /secret[s]?\s+["']?([a-z0-9][a-z0-9-]*)["']?\s+not\s+found/i,
  );
  return match?.[1];
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

interface ServiceReference {
  serviceName: string;
  namespace?: string;
}

function extractInClusterServiceRef(value: string): ServiceReference | undefined {
  const host = extractHostCandidate(value);
  if (!host || isIpv4Address(host)) {
    return undefined;
  }

  // Numeric-only values are ports, not hostnames / Service names.
  if (/^\d+$/.test(host)) {
    return undefined;
  }

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

function extractHostnameFromText(content: string): string | undefined {
  const lookupMatch = content.match(/lookup\s+([a-z0-9][a-z0-9.-]*)/i);
  if (lookupMatch?.[1]) return lookupMatch[1];

  const resolveMatch = content.match(/resolv(?:e|ing)\s+([a-z0-9][a-z0-9.-]*)/i);
  if (resolveMatch?.[1]) return resolveMatch[1];

  const hostMatch = content.match(/no such host:?\s+([a-z0-9][a-z0-9.-]*)/i);
  if (hostMatch?.[1]) return hostMatch[1];

  return undefined;
}

// ---------------------------------------------------------------------------
// Category-specific collectors
// ---------------------------------------------------------------------------

/**
 * Collects evidence for a `missing-secret` hypothesis.
 *
 * Supporting:
 *   - FailedMount / secret-not-found events
 *   - Pod specs reference a Secret that is absent from the captured Secret inventory
 *
 * Contradicting:
 *   - The referenced Secret exists in the bundle context
 *
 * Missing decisive:
 *   - Pod logs showing a secret-related startup error
 */
function collectMissingSecretEvidence(context: InvestigatorContext): EvidenceAssessment {
  const assessment = emptyAssessment();
  const secretsByNamespace = indexResourceNamesByNamespace(context.resources, 'Secret');
  const podSecretRefs = collectPodSecretReferences(context.resources);
  const explicitTargets = new Set<string>();

  // Supporting: FailedMount events
  const failedMountEvents = findEvents(
    context.events,
    /FailedMount|MountVolume|failed.*mount/i,
  );
  for (const ev of failedMountEvents) {
    const ns = ev.involvedObject.namespace ?? 'default';
    const secretName = extractSecretNameFromText(ev.message);
    if (secretName) explicitTargets.add(`${ns}/${secretName}`);
    assessment.supporting.push({
      path: eventsFilePath(ns),
      note: `FailedMount event for '${ev.involvedObject.name}': ${ev.message}`,
      artifactType: 'event',
    });
  }

  // Supporting: explicit "secret not found" events
  const secretNotFoundEvents = findEvents(
    context.events,
    /Failed|Warning/i,
    /secret.*not\s+found|not\s+found.*secret/i,
  );
  for (const ev of secretNotFoundEvents) {
    const ns = ev.involvedObject.namespace ?? 'default';
    const secretName = extractSecretNameFromText(ev.message);
    if (secretName) explicitTargets.add(`${ns}/${secretName}`);
    assessment.supporting.push({
      path: eventsFilePath(ns),
      note: `Event indicates missing secret: ${ev.message}`,
      artifactType: 'event',
    });
  }

  // Structural support/contradiction from actual pod secret references.
  for (const ref of podSecretRefs) {
    const secretsInNamespace = secretsByNamespace.get(ref.namespace);
    if (secretsInNamespace == null) continue;

    if (secretsInNamespace.has(ref.secretName)) {
      assessment.contradicting.push({
        path: secretFilePath(ref.secretName, ref.namespace),
        note: `Referenced secret '${ref.secretName}' exists in namespace '${ref.namespace}' (referenced by pod '${ref.podName}' via ${ref.location})`,
        artifactType: 'kubernetes-resource',
      });
      continue;
    }

    assessment.supporting.push({
      path: podFilePath(ref.podName, ref.namespace),
      note: `Pod '${ref.podName}' references secret '${ref.secretName}' via ${ref.location}, but that secret is absent from captured resources in namespace '${ref.namespace}'`,
      artifactType: 'kubernetes-resource',
    });
    assessment.supporting.push({
      path: secretFilePath(ref.secretName, ref.namespace),
      note: `Referenced secret '${ref.secretName}' is not present in namespace '${ref.namespace}'`,
      artifactType: 'kubernetes-resource',
    });
    explicitTargets.add(`${ref.namespace}/${ref.secretName}`);
  }

  // Supporting: log lines mentioning secret not found
  const secretLogMatches = findInLogs(
    context.logs,
    /secret.*not\s+found|no\s+secret|missing.*secret/i,
  );
  for (const { logFile, lineContent } of secretLogMatches) {
    assessment.supporting.push({
      path: logFile.path,
      note: `Log line indicates missing secret: "${lineContent.trim()}"`,
      artifactType: 'log',
    });
  }

  for (const target of explicitTargets) {
    const [namespace, secretName] = target.split('/');
    const secretsInNamespace = secretsByNamespace.get(namespace);
    if (namespace == null || secretName == null || secretsInNamespace == null) continue;

    if (secretsInNamespace.has(secretName)) {
      assessment.contradicting.push({
        path: secretFilePath(secretName, namespace),
        note: `Secret '${secretName}' exists in namespace '${namespace}' despite missing-secret symptoms`,
        artifactType: 'kubernetes-resource',
      });
    }
  }

  // Fallback contradiction when we cannot infer a specific secret target.
  if (explicitTargets.size === 0 && podSecretRefs.length === 0) {
    const secretResources = findResources(context.resources, 'Secret');
    for (const secret of secretResources) {
      const ns = secret.metadata.namespace ?? 'default';
      assessment.contradicting.push({
        path: secretFilePath(secret.metadata.name, ns),
        note: `Secret '${secret.metadata.name}' exists in namespace '${ns}' — secret inventory is present, which weakens a generic missing-secret hypothesis`,
        artifactType: 'kubernetes-resource',
      });
    }
  }

  // Missing decisive: pod logs showing secret-related error
  if (secretLogMatches.length === 0) {
    assessment.missingDecisive.push(
      'Pod application logs showing a secret or credential error at startup would decisively confirm this hypothesis',
    );
  }

  return assessment;
}

/**
 * Collects evidence for a `dns-failure` hypothesis.
 *
 * Supporting:
 *   - Application log lines matching DNS failure patterns ('no such host', NXDOMAIN, etc.)
 *   - Events mentioning DNS lookup failures
 *   - Pod spec references to in-cluster hostnames whose Service is missing
 *
 * Contradicting:
 *   - Log lines showing successful later connection
 *   - The failing hostname maps to a Service that exists
 *
 * Missing decisive:
 *   - Application logs, Kubernetes events, pod spec host configuration, and
 *     CoreDNS / kube-dns logs when absent from the bundle
 */
function collectDnsFailureEvidence(context: InvestigatorContext): EvidenceAssessment {
  const assessment = emptyAssessment();
  const servicesByNamespace = indexResourceNamesByNamespace(context.resources, 'Service');
  const podServiceRefs = collectPodServiceReferences(context.resources);
  const referencedServices = new Set<string>();

  const dnsFailurePattern =
    /no such host|lookup\s+failed|name\s+resolution\s+fail|NXDOMAIN|could not resolve|dns.*fail/i;

  // Supporting: DNS failure log patterns
  const dnsMatches = findInLogs(context.logs, dnsFailurePattern);
  for (const { logFile, lineContent } of dnsMatches) {
    assessment.supporting.push({
      path: logFile.path,
      note: `Log line shows DNS resolution failure: "${lineContent.trim()}"`,
      artifactType: 'log',
    });

    const hostname = extractHostnameFromText(lineContent);
    const serviceRef = hostname ? extractInClusterServiceRef(hostname) : undefined;
    if (serviceRef != null) {
      const namespace = serviceRef.namespace ?? 'default';
      referencedServices.add(`${namespace}/${serviceRef.serviceName}`);
    }
  }

  // Supporting: DNS-related events provide a second signal independent of logs.
  const dnsEvents = findEvents(
    context.events,
    /Warning|Failed|Unhealthy|BackOff/i,
    /no such host|lookup\s+.*failed|name\s+resolution\s+fail|NXDOMAIN|could not resolve|dns/i,
  );
  for (const ev of dnsEvents) {
    const ns = ev.involvedObject.namespace ?? 'default';
    assessment.supporting.push({
      path: eventsFilePath(ns),
      note: `Event indicates DNS-related failure for '${ev.involvedObject.name}': ${ev.message}`,
      artifactType: 'event',
    });

    const hostname = extractHostnameFromText(ev.message);
    const serviceRef = hostname ? extractInClusterServiceRef(hostname) : undefined;
    if (serviceRef != null) {
      const namespace = serviceRef.namespace ?? ns;
      referencedServices.add(`${namespace}/${serviceRef.serviceName}`);
    }
  }

  // Supporting: pod spec references the failing in-cluster hostname/service.
  for (const ref of podServiceRefs) {
    referencedServices.add(`${ref.serviceNamespace}/${ref.serviceName}`);
    assessment.supporting.push({
      path: podFilePath(ref.podName, ref.namespace),
      note: `Pod '${ref.podName}' references in-cluster hostname '${ref.hostValue}' via ${ref.location}, which could fail if DNS cannot resolve Service '${ref.serviceName}' in namespace '${ref.serviceNamespace}'`,
      artifactType: 'kubernetes-resource',
    });
  }

  // Supporting/contradicting: actual referenced Service existence.
  for (const target of referencedServices) {
    const [namespace, serviceName] = target.split('/');
    const servicesInNamespace = servicesByNamespace.get(namespace);
    if (namespace == null || serviceName == null || servicesInNamespace == null) continue;

    if (servicesInNamespace.has(serviceName)) {
      assessment.contradicting.push({
        path: serviceFilePath(serviceName, namespace),
        note: `Referenced Service '${serviceName}' exists in namespace '${namespace}' — pure DNS absence is less likely`,
        artifactType: 'kubernetes-resource',
      });
      continue;
    }

    assessment.supporting.push({
      path: serviceFilePath(serviceName, namespace),
      note: `Dependency hostname maps to missing Service '${serviceName}' in namespace '${namespace}'`,
      artifactType: 'kubernetes-resource',
    });
  }

  // Conservative fallback when hostnames are known but the bundle contains no Service inventory.
  if (
    context.resources.length > 0 &&
    findResources(context.resources, 'Service').length === 0 &&
    referencedServices.size > 0
  ) {
    assessment.supporting.push({
      path: 'cluster-resources/services/',
      note: 'No Service resources were captured in the bundle, so service-existence checks for referenced dependency hostnames remain unresolved',
      artifactType: 'kubernetes-resource',
    });
  }

  // Contradicting: successful connection log lines.
  const successPattern =
    /connected.*success|successfully connected|connection.*established|ready to serve|server.*ready/i;
  const successMatches = findInLogs(context.logs, successPattern);
  for (const { logFile, lineContent } of successMatches) {
    assessment.contradicting.push({
      path: logFile.path,
      note: `Log line shows successful connection (contradicts DNS failure): "${lineContent.trim()}"`,
      artifactType: 'log',
    });
  }

  // Missing decisive: the absence of any one evidence source should be surfaced explicitly.
  if (dnsMatches.length === 0) {
    assessment.missingDecisive.push(
      'Pod application logs showing DNS lookup failures for the dependency hostname would decisively confirm this hypothesis',
    );
  }

  if (dnsEvents.length === 0) {
    assessment.missingDecisive.push(
      'Kubernetes events showing readiness, startup, or backoff failures caused by DNS errors would strengthen this hypothesis',
    );
  }

  if (podServiceRefs.length === 0) {
    assessment.missingDecisive.push(
      'The Pod spec or container environment showing the dependency hostname would confirm which service name is failing DNS resolution',
    );
  }

  const hasCoreDnsLogs = context.logs.some((l) => /coredns|kube-dns/i.test(l.path));
  if (!hasCoreDnsLogs) {
    assessment.missingDecisive.push(
      'CoreDNS or kube-dns pod logs would decisively confirm DNS resolution failures cluster-wide',
    );
  }

  return assessment;
}

/**
 * Collects evidence for an `image-pull-failure` hypothesis.
 *
 * Supporting:
 *   - ErrImagePull / ImagePullBackOff / Back-off pulling image events
 *   - Pod container status showing ErrImagePull or ImagePullBackOff waiting state
 *
 * Contradicting:
 *   - Container status shows running state (image was successfully pulled)
 *
 * Missing decisive:
 *   - Container registry access logs
 */
function collectImagePullEvidence(context: InvestigatorContext): EvidenceAssessment {
  const assessment = emptyAssessment();

  // Supporting: image pull events
  const imagePullEvents = findEvents(
    context.events,
    /Failed|BackOff|Warning/i,
    /ErrImagePull|ImagePullBackOff|failed to pull image|Back-off pulling image|not found/i,
  );
  for (const ev of imagePullEvents) {
    const ns = ev.involvedObject.namespace ?? 'default';
    assessment.supporting.push({
      path: eventsFilePath(ns),
      note: `Event indicates image pull failure for '${ev.involvedObject.name}': ${ev.message}`,
      artifactType: 'event',
    });
  }

  // Supporting / Contradicting: pod container status
  const podResources = findResources(context.resources, 'Pod');
  for (const pod of podResources) {
    if (!isRecord(pod.status)) continue;

    const containerStatuses = pod.status['containerStatuses'];
    if (!Array.isArray(containerStatuses)) continue;

    for (const cs of containerStatuses) {
      if (!isRecord(cs)) continue;

      const state = cs['state'];
      if (isRecord(state)) {
        const waiting = state['waiting'];
        if (isRecord(waiting)) {
          const reason = String(waiting['reason'] ?? '');
          if (/ErrImagePull|ImagePullBackOff/i.test(reason)) {
            const ns = pod.metadata.namespace ?? 'default';
            assessment.supporting.push({
              path: podFilePath(pod.metadata.name, ns),
              note: `Container '${String(cs['name'] ?? 'unknown')}' waiting with reason '${reason}' — image pull failed`,
              artifactType: 'kubernetes-resource',
            });
          }
        }

        const running = state['running'];
        if (isRecord(running) || running != null) {
          // Container is (or was) running — image was successfully pulled
          const ns = pod.metadata.namespace ?? 'default';
          assessment.contradicting.push({
            path: podFilePath(pod.metadata.name, ns),
            note: `Container '${String(cs['name'] ?? 'unknown')}' is in running state — image was pulled successfully`,
            artifactType: 'kubernetes-resource',
          });
        }
      }
    }
  }

  // Missing decisive: registry access logs
  assessment.missingDecisive.push(
    'Container registry access logs or docker daemon logs would confirm whether the image tag exists and credentials are valid',
  );

  return assessment;
}

/**
 * Collects evidence for a `config-error` hypothesis.
 *
 * Supporting:
 *   - Log lines showing environment variable / config not-found errors
 *   - Log lines showing bad config values
 *
 * Contradicting:
 *   - ConfigMap resources exist and appear populated
 *
 * Missing decisive:
 *   - Application config file or ConfigMap data
 */
function collectConfigErrorEvidence(context: InvestigatorContext): EvidenceAssessment {
  const assessment = emptyAssessment();

  // Supporting: log lines showing config / env-var errors
  const configErrorPattern =
    /environment variable.*not found|env.*not\s+found|missing.*config|config.*not\s+found|missing.*env|cannot find.*config|failed to load.*config/i;
  const configMatches = findInLogs(context.logs, configErrorPattern);
  for (const { logFile, lineContent } of configMatches) {
    assessment.supporting.push({
      path: logFile.path,
      note: `Log line indicates configuration error: "${lineContent.trim()}"`,
      artifactType: 'log',
    });
  }

  // Supporting: general "not found" errors that could be config-related
  const notFoundPattern = /not found|no such file/i;
  const notFoundMatches = findInLogs(context.logs, notFoundPattern);
  for (const { logFile, lineContent } of notFoundMatches) {
    // Avoid duplicating lines already captured above
    if (!configErrorPattern.test(lineContent)) {
      assessment.supporting.push({
        path: logFile.path,
        note: `Log line shows resource not-found error (possible config issue): "${lineContent.trim()}"`,
        artifactType: 'log',
      });
    }
  }

  // Contradicting: ConfigMap resources exist
  const configMaps = findResources(context.resources, 'ConfigMap');
  for (const cm of configMaps) {
    const ns = cm.metadata.namespace ?? 'default';
    assessment.contradicting.push({
      path: `cluster-resources/configmaps/${ns}/${cm.metadata.name}.yaml`,
      note: `ConfigMap '${cm.metadata.name}' exists in namespace '${ns}' — configuration may be present`,
      artifactType: 'kubernetes-resource',
    });
  }

  // Missing decisive: application config file (always decisive — even if we found
  // error logs, we cannot confirm the exact bad value without the config itself)
  assessment.missingDecisive.push(
    'Application config file or ConfigMap data would confirm whether required environment variables and config keys are present and correct',
  );

  return assessment;
}

/**
 * Collects evidence for a `connectivity-failure` hypothesis.
 *
 * Supporting:
 *   - Log lines showing connection timeouts or refused connections
 *   - Missing Endpoints resources
 *
 * Contradicting:
 *   - Log lines showing successful later connections
 *
 * Missing decisive:
 *   - NetworkPolicy resources or Endpoints data
 */
function collectConnectivityEvidence(context: InvestigatorContext): EvidenceAssessment {
  const assessment = emptyAssessment();
  const podServiceRefs = collectPodServiceReferences(context.resources);

  // Supporting: connection timeout/refused patterns in logs
  const timeoutPattern =
    /connection refused|context deadline exceeded|connection timed out|i\/o timeout|read.*timeout|dial tcp.*timeout/i;
  const timeoutMatches = findInLogs(context.logs, timeoutPattern);
  for (const { logFile, lineContent } of timeoutMatches) {
    assessment.supporting.push({
      path: logFile.path,
      note: `Log line shows connection failure: "${lineContent.trim()}"`,
      artifactType: 'log',
    });
  }

  // Supporting: missing Endpoints resources only when the pod spec actually
  // references one or more in-cluster services. Otherwise the absence of an
  // Endpoints inventory is merely a bundle coverage gap, not positive support
  // for a connectivity failure hypothesis.
  const endpointsResources = findResources(context.resources, 'Endpoints');
  if (endpointsResources.length === 0 && podServiceRefs.length > 0) {
    const referencedServices = Array.from(
      new Set(
        podServiceRefs.map(
          (ref) => `${ref.serviceName}.${ref.serviceNamespace}`,
        ),
      ),
    );

    assessment.supporting.push({
      path: 'cluster-resources/endpoints/',
      note:
        referencedServices.length > 0
          ? `No Endpoints resources found in bundle for referenced service(s): ${referencedServices.join(', ')} — service backends may be unavailable`
          : 'No Endpoints resources found in bundle — service endpoints may be unavailable',
      artifactType: 'kubernetes-resource',
    });
  }

  // Contradicting: successful connection log lines
  const successPattern =
    /successfully connected|connection.*established|connected to|server.*ready|ready to serve/i;
  const successMatches = findInLogs(context.logs, successPattern);
  for (const { logFile, lineContent } of successMatches) {
    assessment.contradicting.push({
      path: logFile.path,
      note: `Log line shows successful connection (contradicts connectivity failure): "${lineContent.trim()}"`,
      artifactType: 'log',
    });
  }

  // Missing decisive: NetworkPolicy / Endpoints data
  assessment.missingDecisive.push(
    'NetworkPolicy resources and Endpoints data would confirm whether the network path is blocked or service backends are absent',
  );

  return assessment;
}

/**
 * Collects evidence for a `readiness-failure` hypothesis.
 *
 * Supporting:
 *   - Unhealthy events (readiness probe failed)
 *   - Probe configuration in pod spec
 *
 * Contradicting:
 *   - Pod Ready condition is True (pod later became ready)
 *   - Container in running state and ready
 *
 * Missing decisive:
 *   - Detailed probe response output
 */
function collectReadinessFailureEvidence(context: InvestigatorContext): EvidenceAssessment {
  const assessment = emptyAssessment();

  // Supporting: Unhealthy events
  const unhealthyEvents = findEvents(
    context.events,
    /Unhealthy/i,
    /readiness|probe/i,
  );
  for (const ev of unhealthyEvents) {
    const ns = ev.involvedObject.namespace ?? 'default';
    assessment.supporting.push({
      path: eventsFilePath(ns),
      note: `Unhealthy event for '${ev.involvedObject.name}': ${ev.message}`,
      artifactType: 'event',
    });
  }

  // Supporting: generic Unhealthy events (no message filter)
  const genericUnhealthyEvents = findEvents(context.events, /Unhealthy/i);
  for (const ev of genericUnhealthyEvents) {
    if (!unhealthyEvents.includes(ev)) {
      const ns = ev.involvedObject.namespace ?? 'default';
      assessment.supporting.push({
        path: eventsFilePath(ns),
        note: `Unhealthy event for '${ev.involvedObject.name}': ${ev.message}`,
        artifactType: 'event',
      });
    }
  }

  // Supporting: pod spec has readiness probe configured
  const podResources = findResources(context.resources, 'Pod');
  for (const pod of podResources) {
    const ns = pod.metadata.namespace ?? 'default';

    // Check spec for readiness probe configuration
    if (isRecord(pod.spec)) {
      const containers = pod.spec['containers'];
      if (Array.isArray(containers)) {
        for (const c of containers) {
          if (!isRecord(c)) continue;
          if (c['readinessProbe'] != null) {
            assessment.supporting.push({
              path: podFilePath(pod.metadata.name, ns),
              note: `Container '${String(c['name'] ?? 'unknown')}' has a readiness probe configured — misconfiguration may cause persistent failure`,
              artifactType: 'kubernetes-resource',
            });
          }
        }
      }
    }

    // Contradicting: pod is Ready (checked independently of spec)
    if (isRecord(pod.status)) {
      const conditions = pod.status['conditions'];
      if (Array.isArray(conditions)) {
        for (const cond of conditions) {
          if (
            isRecord(cond) &&
            cond['type'] === 'Ready' &&
            cond['status'] === 'True'
          ) {
            assessment.contradicting.push({
              path: podFilePath(pod.metadata.name, ns),
              note: `Pod '${pod.metadata.name}' has Ready condition True — it became ready, probe may be transient`,
              artifactType: 'kubernetes-resource',
            });
          }
        }
      }

      // Contradicting: container is ready
      const containerStatuses = pod.status['containerStatuses'];
      if (Array.isArray(containerStatuses)) {
        for (const cs of containerStatuses) {
          if (isRecord(cs) && cs['ready'] === true) {
            assessment.contradicting.push({
              path: podFilePath(pod.metadata.name, ns),
              note: `Container '${String(cs['name'] ?? 'unknown')}' reports ready=true — readiness probe ultimately passed`,
              artifactType: 'kubernetes-resource',
            });
          }
        }
      }
    }
  }

  // Missing decisive: detailed probe output
  assessment.missingDecisive.push(
    'Detailed readiness probe response output (HTTP status code, body, or exec command output) would confirm whether the probe endpoint is broken or misconfigured',
  );

  return assessment;
}

// ---------------------------------------------------------------------------
// Dispatch table
// ---------------------------------------------------------------------------

type CategoryCollector = (context: InvestigatorContext) => EvidenceAssessment;

const CATEGORY_COLLECTORS: Partial<Record<HypothesisCategory, CategoryCollector>> = {
  'missing-secret': collectMissingSecretEvidence,
  'dns-failure': collectDnsFailureEvidence,
  'image-pull-failure': collectImagePullEvidence,
  'config-error': collectConfigErrorEvidence,
  'connectivity-failure': collectConnectivityEvidence,
  'readiness-failure': collectReadinessFailureEvidence,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Collects supporting, contradicting, and missing-decisive evidence for a
 * single {@link Hypothesis} from the bundle data in `context`.
 *
 * The function dispatches to a category-specific internal collector based on
 * `hypothesis.category`.  Categories without a dedicated collector return an
 * assessment with only a generic missing-decisive entry.
 *
 * Evidence items are populated with real bundle paths (following the
 * `cluster-resources/…` and `logs/…` conventions used throughout this
 * codebase) and descriptive notes.
 *
 * @param hypothesis - The hypothesis to assess.
 * @param context    - The full bundle context containing resources, events, and logs.
 * @returns An {@link EvidenceAssessment} with `supporting`, `contradicting`,
 *   and `missingDecisive` fields populated.
 */
export function collectEvidenceForHypothesis(
  hypothesis: Hypothesis,
  context: InvestigatorContext,
): EvidenceAssessment {
  const collector = CATEGORY_COLLECTORS[hypothesis.category];

  if (collector != null) {
    return collector(context);
  }

  // Fallback for categories without a dedicated collector
  const assessment = emptyAssessment();
  assessment.missingDecisive.push(
    `No dedicated evidence collector for category '${hypothesis.category}' — manual investigation required`,
  );
  return assessment;
}
