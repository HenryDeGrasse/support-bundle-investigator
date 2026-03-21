import type { Evidence, K8sEvent, K8sResource } from '../types/index.js';
import type { LogFile } from '../parsers/index.js';
import type { InvestigatorContext } from './types.js';
import type { EvidenceAssessment, Hypothesis, HypothesisCategory } from './hypothesis-types.js';
import type { EvidenceRule } from './hypothesis-templates.js';
import { cleanEvidencePath } from '../reporters/display-helpers.js';

// ---------------------------------------------------------------------------
// Bundle file-path helpers (mirrors conventions in kubernetes-investigator)
// ---------------------------------------------------------------------------

// Real Troubleshoot bundles store resources in flat namespace JSON list files
// (e.g. cluster-resources/pods/default.json containing a PodList), NOT in
// per-resource files like cluster-resources/pods/default/app-pod.yaml.
// Evidence paths must use the real format so grounding checks in the AI
// investigator can match them against the chunk index (which uses actual
// source file paths from the bundle manifest).

function podFilePath(namespace: string): string {
  return `cluster-resources/pods/${namespace}.json`;
}

function secretFilePath(namespace: string): string {
  return `cluster-resources/secrets/${namespace}.json`;
}

function serviceFilePath(namespace: string): string {
  return `cluster-resources/services/${namespace}.json`;
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

/** Adds an evidence item only when an identical path+note+artifactType is absent. */
function pushUniqueEvidence(items: Evidence[], evidence: Evidence): void {
  const exists = items.some(
    (item) =>
      item.path === evidence.path &&
      item.note === evidence.note &&
      item.artifactType === evidence.artifactType,
  );
  if (!exists) items.push(evidence);
}

/** Merges an evidence assessment into another without duplicating exact evidence items. */
function mergeAssessmentInto(target: EvidenceAssessment, addition: EvidenceAssessment): void {
  for (const evidence of addition.supporting) {
    pushUniqueEvidence(target.supporting, evidence);
  }
  for (const evidence of addition.contradicting) {
    pushUniqueEvidence(target.contradicting, evidence);
  }
  for (const gap of addition.missingDecisive) {
    if (!target.missingDecisive.includes(gap)) {
      target.missingDecisive.push(gap);
    }
  }
}

/**
 * Merges supplemental evidence conservatively.
 *
 * Template rules should augment dedicated collectors, but they should not
 * double-count the same underlying artifact that a structured collector has
 * already covered. For supplements, treat an existing item with the same
 * `path` + `artifactType` as already represented even when the note differs.
 */
function mergeSupplementalAssessmentInto(
  target: EvidenceAssessment,
  addition: EvidenceAssessment,
): void {
  const pushSupplementalEvidence = (items: Evidence[], evidence: Evidence): void => {
    const exists = items.some(
      (item) => item.path === evidence.path && item.artifactType === evidence.artifactType,
    );
    if (!exists) items.push(evidence);
  };

  for (const evidence of addition.supporting) {
    pushSupplementalEvidence(target.supporting, evidence);
  }
  for (const evidence of addition.contradicting) {
    pushSupplementalEvidence(target.contradicting, evidence);
  }
  for (const gap of addition.missingDecisive) {
    if (!target.missingDecisive.includes(gap)) {
      target.missingDecisive.push(gap);
    }
  }
}

/** Retains only symptom-/finding-derived evidence items from a template assessment. */
function selectSymptomTemplateEvidence(
  assessment: EvidenceAssessment,
  hypothesis: Hypothesis,
): EvidenceAssessment {
  const findingPaths = new Set(hypothesis.sourceFindings);
  findingPaths.add(hypothesis.id);

  return {
    supporting: assessment.supporting.filter((e) => findingPaths.has(e.path)),
    contradicting: assessment.contradicting.filter((e) => findingPaths.has(e.path)),
    missingDecisive: assessment.missingDecisive,
  };
}

/**
 * Returns the best-effort real bundle path for a Kubernetes resource.
 *
 * Prefers `context.resourceSourceFiles` when available so evidence points to
 * the exact file parsed from the bundle. Falls back to the flat namespace JSON
 * conventions used by Troubleshoot bundles for common namespaced resources.
 */
function resourceEvidencePath(resource: K8sResource, context: InvestigatorContext): string {
  const mappedPath = context.resourceSourceFiles?.get(resource);
  if (mappedPath != null && mappedPath.length > 0) return mappedPath;

  const namespace = resource.metadata.namespace ?? 'default';
  switch (resource.kind) {
    case 'Pod':
      return podFilePath(namespace);
    case 'Secret':
      return secretFilePath(namespace);
    case 'Service':
      return serviceFilePath(namespace);
    default: {
      const pluralKind = `${resource.kind.toLowerCase()}s`;
      if (resource.metadata.namespace != null) {
        return `cluster-resources/${pluralKind}/${namespace}/${resource.metadata.name}.yaml`;
      }
      return `cluster-resources/${pluralKind}/${resource.metadata.name}.yaml`;
    }
  }
}

/** Returns a concise snippet around the first regex match in `text`. */
function extractMatchSnippet(text: string, pattern: RegExp): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const match = normalized.match(pattern);
  if (match?.[0] != null) {
    return match[0].slice(0, 180);
  }
  return normalized.slice(0, 180);
}

/**
 * Heuristic guard against false-positive contradicting-rule matches.
 *
 * Many template contradicting rules look for success/existence words such as
 * `found`, `exists`, or `healthy`. A naive regex can accidentally match
 * negated phrases like `not found` or `Unhealthy`, which would invert the
 * meaning. Skip those obviously negated matches.
 */
function shouldSkipTemplateRuleMatch(
  rule: EvidenceRule,
  pattern: RegExp,
  text: string,
): boolean {
  if (rule.type !== 'contradicting') return false;

  const match = new RegExp(pattern.source, pattern.flags).exec(text);
  if (match?.[0] == null || match.index == null) return false;

  const matchedText = match[0].toLowerCase();
  const prefix = text.slice(Math.max(0, match.index - 12), match.index).toLowerCase();

  if (/\b(?:not|no|missing|failed|failure|error|unable|cannot|can't|without|denied|invalid|unavailable|refused|timeout|timed\s+out)\b/i.test(matchedText)) {
    return true;
  }

  if (/\b(?:not|no)\s*$/i.test(prefix)) {
    return true;
  }

  if (prefix.endsWith('un')) {
    return true;
  }

  return false;
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

    // Skip kube-system pods — system components use env vars with hostnames
    // that are not K8s Service names (e.g. CONTROL_PLANE_ENDPOINT).
    if (namespace === 'kube-system') continue;

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

/**
 * Common short env var values that look like RFC-1123 names but are clearly
 * NOT Kubernetes service names. Prevents `LOG_LEVEL=info`, `DEBUG=true`,
 * `NODE_ENV=production` etc. from being treated as service references.
 */
const ENV_VALUE_STOP_WORDS: ReadonlySet<string> = new Set([
  // Log levels
  'info', 'debug', 'warn', 'warning', 'error', 'fatal', 'trace', 'verbose',
  // Booleans
  'true', 'false', 'yes', 'no', 'on', 'off', 'enabled', 'disabled',
  // Environments
  'production', 'development', 'staging', 'test', 'testing', 'local',
  // Common generic values
  'none', 'default', 'auto', 'always', 'never', 'json', 'text', 'yaml',
  'http', 'https', 'tcp', 'udp', 'grpc',
]);

/**
 * Common Internet TLDs that superficially match the two-part
 * `<service>.<namespace>` DNS short-form pattern but are clearly external
 * domain suffixes rather than Kubernetes namespace names.  When the second
 * segment of a dot-separated two-part hostname matches one of these, the
 * hostname is treated as an external domain and excluded from in-cluster
 * Service resolution.
 */
const COMMON_TLDS: ReadonlySet<string> = new Set([
  'com', 'org', 'net', 'io', 'co', 'edu', 'gov', 'dev', 'app', 'run',
  'cloud', 'ai', 'me', 'uk', 'eu', 'info', 'biz', 'xyz',
]);

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
    // Filter out common config values that look like RFC-1123 names but
    // are clearly not Kubernetes Service names.
    if (ENV_VALUE_STOP_WORDS.has(host.toLowerCase())) {
      return undefined;
    }
    return { serviceName: host.toLowerCase() };
  }

  // Two-part short-form: <service>.<namespace>  (e.g. api-service.staging)
  // Kubernetes resolves these within the cluster by appending the remaining
  // DNS search-domain suffix.  Reject any pair whose second segment is a
  // well-known Internet TLD — those are external domains, not namespaces.
  const twoPartMatch = host.match(
    /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)$/i,
  );
  if (twoPartMatch?.[1] && twoPartMatch[2]) {
    const secondSegment = twoPartMatch[2].toLowerCase();
    if (!COMMON_TLDS.has(secondSegment)) {
      return {
        serviceName: twoPartMatch[1].toLowerCase(),
        namespace: secondSegment,
      };
    }
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
        path: secretFilePath(ref.namespace),
        note: `Referenced secret '${ref.secretName}' exists in namespace '${ref.namespace}' (referenced by pod '${ref.podName}' via ${ref.location})`,
        artifactType: 'kubernetes-resource',
      });
      continue;
    }

    assessment.supporting.push({
      path: podFilePath(ref.namespace),
      note: `Pod '${ref.podName}' references secret '${ref.secretName}' via ${ref.location}, but that secret is absent from captured resources in namespace '${ref.namespace}'`,
      artifactType: 'kubernetes-resource',
    });
    assessment.supporting.push({
      path: secretFilePath(ref.namespace),
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
      path: cleanEvidencePath(logFile.path),
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
        path: secretFilePath(namespace),
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
        path: secretFilePath(ns),
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
      path: cleanEvidencePath(logFile.path),
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
      path: podFilePath(ref.namespace),
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
        path: serviceFilePath(namespace),
        note: `Referenced Service '${serviceName}' exists in namespace '${namespace}' — pure DNS absence is less likely`,
        artifactType: 'kubernetes-resource',
      });
      continue;
    }

    assessment.supporting.push({
      path: serviceFilePath(namespace),
      note: `Dependency hostname maps to missing Service '${serviceName}' in namespace '${namespace}'`,
      artifactType: 'kubernetes-resource',
    });
  }

  // --------------------------------------------------------------------------
  // Cross-namespace service correlation: when a service is missing from its
  // target namespace but found in another namespace, surface a "did you mean?"
  // suggestion with the corrected URL fix.
  // --------------------------------------------------------------------------

  // Build the set of services that were NOT found in their target namespace.
  const missingServices = new Set<string>();
  for (const target of referencedServices) {
    const slash = target.indexOf('/');
    if (slash === -1) continue;
    const targetNs = target.slice(0, slash);
    const svcName = target.slice(slash + 1);
    const svcsInNs = servicesByNamespace.get(targetNs);
    if (svcsInNs == null || !svcsInNs.has(svcName)) {
      missingServices.add(target);
    }
  }

  let crossNamespaceMatchFound = false;
  for (const target of missingServices) {
    const slash = target.indexOf('/');
    const targetNamespace = target.slice(0, slash);
    const serviceName = target.slice(slash + 1);

    for (const [foundNamespace, svcsInFoundNs] of servicesByNamespace) {
      if (foundNamespace === targetNamespace || !svcsInFoundNs.has(serviceName)) continue;

      // A cross-namespace match was found!
      crossNamespaceMatchFound = true;

      // Locate pod env var references that point to this service in the wrong namespace.
      const matchingRefs = podServiceRefs.filter(
        (ref) => ref.serviceName === serviceName && ref.serviceNamespace === targetNamespace,
      );

      let envNote = '';
      if (matchingRefs.length > 0) {
        const envNames: string[] = [];
        for (const ref of matchingRefs) {
          const m = ref.location.match(/env '([^']+)'/);
          if (m?.[1] != null && !envNames.includes(m[1])) envNames.push(m[1]);
        }
        if (envNames.length > 0) {
          const exRef = matchingRefs[0]!;
          const correctedUrl = exRef.hostValue.replace(
            `${serviceName}.${targetNamespace}`,
            `${serviceName}.${foundNamespace}`,
          );
          const portM = exRef.hostValue.match(/:(\d+)/);
          const shortUrl =
            portM?.[1] != null
              ? `http://${serviceName}:${portM[1]}`
              : `http://${serviceName}`;
          const envLabel =
            envNames.length === 1
              ? `The env var ${envNames[0]}`
              : `The env vars ${envNames.join(', ')}`;
          const verbStr = envNames.length === 1 ? 'likely points' : 'likely point';
          const updateStr =
            envNames.length === 1
              ? `Update ${envNames[0]}`
              : `Update ${envNames.join(', ')}`;
          envNote =
            ` ${envLabel} ${verbStr} to the wrong namespace.` +
            ` ${updateStr} from ${exRef.hostValue} to ${correctedUrl}` +
            ` or ${shortUrl} if the pod runs in the ${foundNamespace} namespace.`;
        }
      }

      assessment.supporting.push({
        path: serviceFilePath(foundNamespace),
        note: `Service '${serviceName}' exists in namespace '${foundNamespace}' (not '${targetNamespace}').${envNote}`,
        artifactType: 'kubernetes-resource',
      });
      break; // Report only the first cross-namespace match per missing service.
    }
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
      path: cleanEvidencePath(logFile.path),
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
  // When a cross-namespace match is confirmed, the root cause is a wrong-namespace
  // reference rather than a DNS infrastructure issue, so CoreDNS logs are no
  // longer a decisive missing evidence gap.
  if (!hasCoreDnsLogs && !crossNamespaceMatchFound) {
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
              path: podFilePath(ns),
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
            path: podFilePath(ns),
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
      path: cleanEvidencePath(logFile.path),
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
        path: cleanEvidencePath(logFile.path),
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
      path: cleanEvidencePath(logFile.path),
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
      path: cleanEvidencePath(logFile.path),
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

// ---------------------------------------------------------------------------
// Readiness-failure scoping helpers
// ---------------------------------------------------------------------------

/**
 * Namespaces that host Kubernetes system components (CoreDNS, etcd, etc.).
 * Pods in these namespaces are excluded from readiness-probe evidence unless
 * explicitly referenced by an Unhealthy event in the bundle.
 */
const SYSTEM_NAMESPACES: ReadonlySet<string> = new Set([
  'kube-system',
  'kube-public',
  'kube-node-lease',
]);

/**
 * Returns `true` when a pod is NOT in a fully healthy state.
 *
 * A pod is considered unhealthy when ANY of the following is true:
 *   (a) Its status phase is not `'Running'` or `'Succeeded'`.
 *   (b) It has no `Ready=True` condition.
 *   (c) At least one container status has `ready: false`.
 *
 * Pods with no `status` field (i.e. status not yet populated) are also
 * considered unhealthy — the absence of status cannot confirm healthy state.
 */
function isPodUnhealthy(pod: K8sResource): boolean {
  if (!isRecord(pod.status)) {
    // No status information at all — cannot confirm healthy.
    return true;
  }

  // (a) Phase is present but is neither Running nor Succeeded.
  const phase = pod.status['phase'];
  if (typeof phase === 'string' && phase !== 'Running' && phase !== 'Succeeded') {
    return true;
  }

  // (b) Conditions exist but none is Ready=True.
  const conditions = pod.status['conditions'];
  if (Array.isArray(conditions)) {
    const hasReadyTrue = conditions.some(
      (c) => isRecord(c) && c['type'] === 'Ready' && c['status'] === 'True',
    );
    if (!hasReadyTrue) return true;
  } else {
    // No conditions array — cannot confirm Ready=True.
    return true;
  }

  // (c) Any container status explicitly reports ready: false.
  const containerStatuses = pod.status['containerStatuses'];
  if (Array.isArray(containerStatuses)) {
    if (containerStatuses.some((cs) => isRecord(cs) && cs['ready'] === false)) {
      return true;
    }
  }

  return false;
}

/**
 * Collects evidence for a `readiness-failure` hypothesis.
 *
 * Supporting:
 *   - Unhealthy events (readiness probe failed)
 *   - Probe configuration in pod spec (scoped to relevant pods only)
 *
 * Contradicting:
 *   - Pod Ready condition is True (pod later became ready)
 *   - Container in running state and ready
 *   (Both contradicting checks are also scoped to relevant pods.)
 *
 * Missing decisive:
 *   - Detailed probe response output
 *
 * Scoping rules for pod-level evidence:
 *   A pod's probe configuration (and associated contradicting evidence) is
 *   included only when:
 *     1. The pod's namespace appears in the set of affected namespaces derived
 *        from Unhealthy events collected earlier in this function, OR
 *     2. The pod is unhealthy (per {@link isPodUnhealthy}) AND the pod does
 *        NOT belong to a {@link SYSTEM_NAMESPACES} namespace.
 *   This prevents healthy kube-system pods (CoreDNS, etcd, …) from appearing
 *   as evidence for a user-workload readiness misconfiguration.
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

  // Build the set of affected namespaces from all Unhealthy events so that
  // the pod-level filter below can include pods in those namespaces even when
  // a given pod currently looks healthy (e.g. it recovered after the event).
  const allUnhealthyEvents = [
    ...unhealthyEvents,
    ...genericUnhealthyEvents.filter((ev) => !unhealthyEvents.includes(ev)),
  ];
  const affectedNamespaces = new Set<string>(
    allUnhealthyEvents.map((ev) => ev.involvedObject.namespace ?? 'default'),
  );

  // Supporting / Contradicting: pod-level probe config and readiness status.
  // Only process pods that are relevant to the failure: pods in an affected
  // namespace, or unhealthy pods outside system namespaces.
  const podResources = findResources(context.resources, 'Pod');
  for (const pod of podResources) {
    const ns = pod.metadata.namespace ?? 'default';

    const isInAffectedNamespace = affectedNamespaces.has(ns);
    const isSystemPod = SYSTEM_NAMESPACES.has(ns);
    const podUnhealthy = isPodUnhealthy(pod);

    // Skip pods that are neither in an affected namespace nor unhealthy
    // outside system namespaces — they are irrelevant to this hypothesis.
    if (!isInAffectedNamespace && !(podUnhealthy && !isSystemPod)) {
      continue;
    }

    // Check spec for readiness probe configuration
    if (isRecord(pod.spec)) {
      const containers = pod.spec['containers'];
      if (Array.isArray(containers)) {
        for (const c of containers) {
          if (!isRecord(c)) continue;
          if (c['readinessProbe'] != null) {
            assessment.supporting.push({
              path: podFilePath(ns),
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
              path: podFilePath(ns),
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
              path: podFilePath(ns),
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
// volume-mount-failure collector
// ---------------------------------------------------------------------------

/** Canonical path of a PVC resource file within a support bundle. */
function pvcFilePath(name: string, namespace: string): string {
  return `cluster-resources/persistentvolumeclaims/${namespace}/${name}.yaml`;
}

/** Canonical path of a StorageClass resource file within a support bundle. */
function storageClassFilePath(name: string): string {
  return `cluster-resources/storageclasses/${name}.yaml`;
}

/**
 * Extracts PersistentVolumeClaim references from pod spec volumes.
 */
interface PodPvcReference {
  podName: string;
  namespace: string;
  volumeName: string;
  claimName: string;
}

function collectPodPvcReferences(resources: K8sResource[]): PodPvcReference[] {
  const refs: PodPvcReference[] = [];

  for (const resource of resources) {
    if (resource.kind !== 'Pod' || !isRecord(resource.spec)) continue;

    const podName = resource.metadata.name;
    const namespace = resource.metadata.namespace ?? 'default';
    const volumes = resource.spec['volumes'];

    if (!Array.isArray(volumes)) continue;

    for (const volume of volumes) {
      if (!isRecord(volume)) continue;
      const pvc = volume['persistentVolumeClaim'];
      if (!isRecord(pvc) || typeof pvc['claimName'] !== 'string') continue;

      refs.push({
        podName,
        namespace,
        volumeName: String(volume['name'] ?? 'unknown'),
        claimName: pvc['claimName'],
      });
    }
  }

  return refs;
}

/**
 * Collects evidence for a `volume-mount-failure` hypothesis.
 *
 * Supporting:
 *   - FailedMount, FailedScheduling events for pods
 *   - ProvisioningFailed events on PVCs referenced by the pod
 *   - PVC in Pending phase
 *   - Referenced StorageClass is absent from bundle resources
 *
 * Contradicting:
 *   - PVC is in Bound phase
 *   - Referenced StorageClass exists in the bundle
 *
 * Missing decisive:
 *   - Storage provisioner pod logs when absent
 */
function collectVolumeFailureEvidence(context: InvestigatorContext): EvidenceAssessment {
  const assessment = emptyAssessment();
  const podPvcRefs = collectPodPvcReferences(context.resources);

  // Supporting: FailedMount events on pods
  const failedMountEvents = findEvents(
    context.events,
    /FailedMount/i,
  );
  for (const ev of failedMountEvents) {
    const ns = ev.involvedObject.namespace ?? 'default';
    assessment.supporting.push({
      path: eventsFilePath(ns),
      note: `FailedMount event for '${ev.involvedObject.name}': ${ev.message.slice(0, 160)}`,
      artifactType: 'event',
      timestamp: ev.firstTimestamp,
    });
  }

  // Supporting: FailedScheduling events on pods (often co-occurs with PVC not bound)
  const failedSchedulingEvents = findEvents(
    context.events,
    /FailedScheduling/i,
  );
  for (const ev of failedSchedulingEvents) {
    const ns = ev.involvedObject.namespace ?? 'default';
    assessment.supporting.push({
      path: eventsFilePath(ns),
      note: `FailedScheduling event for '${ev.involvedObject.name}': ${ev.message.slice(0, 160)}`,
      artifactType: 'event',
      timestamp: ev.firstTimestamp,
    });
  }

  // Supporting: ProvisioningFailed events on PVCs
  const provisioningFailedEvents = findEvents(
    context.events,
    /ProvisioningFailed|ProvisioningFailed/i,
  );
  for (const ev of provisioningFailedEvents) {
    const ns = ev.involvedObject.namespace ?? 'default';
    assessment.supporting.push({
      path: eventsFilePath(ns),
      note: `ProvisioningFailed event for PVC '${ev.involvedObject.name}': ${ev.message.slice(0, 160)}`,
      artifactType: 'event',
      timestamp: ev.firstTimestamp,
    });
  }

  // Analyse each PVC referenced by pods
  const storageClassNames = new Set<string>();
  for (const ref of podPvcRefs) {
    // Find the actual PVC resource
    const pvcResource = context.resources.find(
      (r) =>
        r.kind === 'PersistentVolumeClaim' &&
        r.metadata.name === ref.claimName &&
        (r.metadata.namespace ?? 'default') === ref.namespace,
    );

    if (pvcResource == null) {
      assessment.supporting.push({
        path: pvcFilePath(ref.claimName, ref.namespace),
        note: `PVC '${ref.claimName}' referenced by pod '${ref.podName}' volume '${ref.volumeName}' is not present in the bundle`,
        artifactType: 'kubernetes-resource',
      });
      continue;
    }

    // Check PVC phase
    const pvcPhase = isRecord(pvcResource.status)
      ? String(pvcResource.status['phase'] ?? '')
      : '';

    if (pvcPhase === 'Pending') {
      assessment.supporting.push({
        path: pvcFilePath(ref.claimName, ref.namespace),
        note: `PVC '${ref.claimName}' is in Pending phase — volume has not been provisioned`,
        artifactType: 'kubernetes-resource',
      });
    } else if (pvcPhase === 'Bound') {
      assessment.contradicting.push({
        path: pvcFilePath(ref.claimName, ref.namespace),
        note: `PVC '${ref.claimName}' is Bound — volume provisioning succeeded, mount failure has another cause`,
        artifactType: 'kubernetes-resource',
      });
    }

    // Collect StorageClass name from PVC spec
    if (isRecord(pvcResource.spec)) {
      const scName = pvcResource.spec['storageClassName'];
      if (typeof scName === 'string' && scName.length > 0) {
        storageClassNames.add(scName);
      }
    }
  }

  // Check whether each referenced StorageClass exists in the bundle
  for (const scName of storageClassNames) {
    const scExists = context.resources.some(
      (r) => r.kind === 'StorageClass' && r.metadata.name === scName,
    );

    if (scExists) {
      assessment.contradicting.push({
        path: storageClassFilePath(scName),
        note: `StorageClass '${scName}' exists in the bundle — provisioning failure may be due to a provisioner issue rather than a missing StorageClass`,
        artifactType: 'kubernetes-resource',
      });
    } else {
      assessment.supporting.push({
        path: storageClassFilePath(scName),
        note: `StorageClass '${scName}' referenced by PVC is absent from the bundle — this is the likely cause of ProvisioningFailed`,
        artifactType: 'kubernetes-resource',
      });
    }
  }

  // Missing decisive: storage provisioner logs
  const hasProvisionerLogs = context.logs.some((l) =>
    /provisioner|storage.*controller|csi.*provisioner/i.test(l.path),
  );
  if (!hasProvisionerLogs) {
    assessment.missingDecisive.push(
      'Storage provisioner pod logs would confirm the exact provisioning failure reason',
    );
  }

  if (podPvcRefs.length === 0) {
    assessment.missingDecisive.push(
      'Pod spec volume configuration showing PVC references would confirm the volume mount failure path',
    );
  }

  return assessment;
}

// ---------------------------------------------------------------------------
// Regex helpers
// ---------------------------------------------------------------------------

/**
 * Escapes all regex special characters in a string so it can be used inside a
 * `new RegExp(…)` constructor without unintended meta-character semantics.
 */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Attempts to extract the container registry hostname from an image reference
 * or free-text string.  Returns the hostname in lower-case, or `undefined`
 * when no registry-shaped hostname can be found.
 *
 * Matches patterns like:
 *   - `"myregistry.io/image:tag"` (quoted)
 *   - `myregistry.io/image:tag`   (unquoted)
 *   - `gcr.io/project/image:tag`
 */
function extractRegistryFromImageRef(text: string): string | undefined {
  // Quoted image reference first — more specific
  const quotedMatch = text.match(/"([a-z0-9][a-z0-9.-]*\.[a-z]{2,})\/[^"]+"/i);
  if (quotedMatch?.[1]) return quotedMatch[1].toLowerCase();

  // Unquoted image reference
  const unquotedMatch = text.match(
    /\b([a-z0-9][a-z0-9.-]*\.[a-z]{2,})\/[a-z0-9][a-z0-9._/-]*/i,
  );
  if (unquotedMatch?.[1]) return unquotedMatch[1].toLowerCase();

  return undefined;
}

// ---------------------------------------------------------------------------
// Active falsification collectors (7.6)
// ---------------------------------------------------------------------------

/**
 * Actively looks for evidence that would DISPROVE a `dns-failure` hypothesis.
 *
 * Strategy: extract every hostname mentioned in DNS-failure log lines, then
 * search for log lines that show a *successful* resolution or connection to
 * **that same hostname**.  Generic success patterns elsewhere in the logs are
 * not enough — only hostname-specific successes count.
 */
function collectDnsFalsifyingEvidence(
  hypothesis: Hypothesis,
  context: InvestigatorContext,
): EvidenceAssessment {
  const assessment = emptyAssessment();

  const dnsFailurePattern =
    /no such host|lookup\s+failed|name\s+resolution\s+fail|NXDOMAIN|could not resolve|dns.*fail/i;

  // Collect failing hostnames from logs
  const failedHostnames = new Set<string>();
  for (const logFile of context.logs) {
    for (const line of logFile.lines) {
      if (dnsFailurePattern.test(line.content)) {
        const hostname = extractHostnameFromText(line.content);
        if (hostname) failedHostnames.add(hostname.toLowerCase());
      }
    }
  }

  // Also extract from hypothesis text (symptom + rootCause)
  const hypothesisText = `${hypothesis.symptom} ${hypothesis.rootCause}`;
  const hostnameFromHypothesis = extractHostnameFromText(hypothesisText);
  if (hostnameFromHypothesis) failedHostnames.add(hostnameFromHypothesis.toLowerCase());

  // For each failing hostname, search for successful connections to THAT hostname
  for (const hostname of failedHostnames) {
    const escaped = escapeRegex(hostname);
    // Matches: "successfully connected to <host>", "connected to <host> successfully",
    // "resolved <host>", "<host> connection established", etc.
    const successForHostPattern = new RegExp(
      `(successfully\\s+(?:connected|resolved)|connected.*successfully|connection\\s+established|resolved).*${escaped}` +
        `|${escaped}.*(successfully\\s+(?:connected|resolved)|connected.*successfully|connection\\s+established)`,
      'i',
    );

    const successMatches = findInLogs(context.logs, successForHostPattern);
    for (const { logFile, lineContent } of successMatches) {
      assessment.contradicting.push({
        path: cleanEvidencePath(logFile.path),
        note: `Log line shows successful DNS resolution/connection for hostname '${hostname}' — directly contradicts the DNS failure hypothesis: "${lineContent.trim()}"`,
        artifactType: 'log',
      });
    }
  }

  return assessment;
}

/**
 * Actively looks for evidence that would DISPROVE a `missing-secret`
 * hypothesis.
 *
 * Strategy: extract the specific secret name(s) mentioned in events, log
 * lines, and the hypothesis text, then check whether that secret *actually
 * exists* in the captured Kubernetes resources.  Finding the secret in the
 * cluster inventory directly falsifies the "secret is missing" claim.
 */
function collectMissingSecretFalsifyingEvidence(
  hypothesis: Hypothesis,
  context: InvestigatorContext,
): EvidenceAssessment {
  const assessment = emptyAssessment();
  const secretsByNamespace = indexResourceNamesByNamespace(context.resources, 'Secret');

  const namedSecrets = new Set<string>();

  // Extract from events
  for (const ev of context.events) {
    const name = extractSecretNameFromText(ev.message);
    if (name) namedSecrets.add(name);
  }

  // Extract from logs
  for (const logFile of context.logs) {
    for (const line of logFile.lines) {
      const name = extractSecretNameFromText(line.content);
      if (name) namedSecrets.add(name);
    }
  }

  // Extract from hypothesis text
  const hypothesisText = `${hypothesis.symptom} ${hypothesis.rootCause}`;
  const nameFromHypothesis = extractSecretNameFromText(hypothesisText);
  if (nameFromHypothesis) namedSecrets.add(nameFromHypothesis);

  // Actively check: is the explicitly named secret actually present?
  for (const secretName of namedSecrets) {
    for (const [namespace, names] of secretsByNamespace) {
      if (names.has(secretName)) {
        assessment.contradicting.push({
          path: secretFilePath(namespace),
          note: `Secret '${secretName}' is actually present in namespace '${namespace}' — this directly contradicts the missing-secret hypothesis`,
          artifactType: 'kubernetes-resource',
        });
      }
    }
  }

  return assessment;
}

/**
 * Actively looks for evidence that would DISPROVE an `image-pull-failure`
 * hypothesis where the suspected cause is registry authentication.
 *
 * Strategy: extract the container registry hostname from the failing image
 * reference, then search for successful image pulls **from that same
 * registry** in events and logs.  A successful pull from the same registry
 * suggests auth is not the root cause.
 */
function collectImagePullFalsifyingEvidence(
  hypothesis: Hypothesis,
  context: InvestigatorContext,
): EvidenceAssessment {
  const assessment = emptyAssessment();

  // Collect registries from pull-failure events
  const failingRegistries = new Set<string>();

  for (const ev of context.events) {
    if (/ErrImagePull|ImagePullBackOff|failed.*pull|pull.*fail/i.test(ev.message)) {
      const registry = extractRegistryFromImageRef(ev.message);
      if (registry) failingRegistries.add(registry);
    }
  }

  // Also from hypothesis text
  const hypothesisText = `${hypothesis.symptom} ${hypothesis.rootCause}`;
  const registryFromHypothesis = extractRegistryFromImageRef(hypothesisText);
  if (registryFromHypothesis) failingRegistries.add(registryFromHypothesis);

  // For each failing registry, search for successful pulls from THAT registry
  for (const registry of failingRegistries) {
    const escaped = escapeRegex(registry);
    const successPattern = new RegExp(
      `(successfully\\s+pulled|pulled\\s+image.*success|pulling.*done).*${escaped}` +
        `|${escaped}.*(successfully\\s+pulled|pulled\\s+image.*success)`,
      'i',
    );

    // Check events
    const successEvents = context.events.filter(
      (ev) =>
        /Pulled|successfully\s+pulled/i.test(`${ev.reason} ${ev.message}`) &&
        successPattern.test(ev.message),
    );
    for (const ev of successEvents) {
      const ns = ev.involvedObject.namespace ?? 'default';
      assessment.contradicting.push({
        path: eventsFilePath(ns),
        note: `Event shows successful image pull from registry '${registry}' — suggests registry auth is not the cause: ${ev.message}`,
        artifactType: 'event',
      });
    }

    // Check logs
    const logSuccessMatches = findInLogs(context.logs, successPattern);
    for (const { logFile, lineContent } of logSuccessMatches) {
      assessment.contradicting.push({
        path: cleanEvidencePath(logFile.path),
        note: `Log shows successful image pull from registry '${registry}' — contradicts registry auth failure hypothesis: "${lineContent.trim()}"`,
        artifactType: 'log',
      });
    }
  }

  return assessment;
}

// ---------------------------------------------------------------------------
// Template-driven evidence rules (7.11a)
// ---------------------------------------------------------------------------

/**
 * Applies declarative template evidence rules attached to a hypothesis.
 *
 * Rules are searched against:
 * - log lines
 * - Kubernetes events (`reason` + `message`)
 * - Kubernetes resources (serialized resource payloads, including container status)
 * - the hypothesis symptom text, which is derived from the source finding title
 *
 * Supporting rules populate `assessment.supporting`; contradicting rules
 * populate `assessment.contradicting`.
 */
function collectTemplateRuleEvidence(
  hypothesis: Hypothesis,
  context: InvestigatorContext,
): EvidenceAssessment {
  const assessment = emptyAssessment();
  const rules = hypothesis.evidenceRules ?? [];

  for (const rule of rules) {
    let pattern: RegExp;
    try {
      pattern = new RegExp(rule.pattern, 'i');
    } catch {
      continue;
    }

    const target =
      rule.type === 'supporting'
        ? assessment.supporting
        : assessment.contradicting;

    collectTemplateRuleMatchesFromLogs(target, rule, pattern, context.logs);
    collectTemplateRuleMatchesFromEvents(target, rule, pattern, context.events);
    collectTemplateRuleMatchesFromResources(target, rule, pattern, context.resources, context);
    collectTemplateRuleMatchesFromSymptom(target, rule, pattern, hypothesis);
  }

  return assessment;
}

function collectTemplateRuleMatchesFromLogs(
  target: Evidence[],
  rule: EvidenceRule,
  pattern: RegExp,
  logs: LogFile[],
): void {
  for (const { logFile, lineContent } of findInLogs(logs, pattern)) {
    if (shouldSkipTemplateRuleMatch(rule, pattern, lineContent)) continue;

    pushUniqueEvidence(target, {
      path: cleanEvidencePath(logFile.path),
      note: `Template rule '${rule.label}' matched log line: "${lineContent.trim()}"`,
      artifactType: 'log',
    });
  }
}

function collectTemplateRuleMatchesFromEvents(
  target: Evidence[],
  rule: EvidenceRule,
  pattern: RegExp,
  events: K8sEvent[],
): void {
  for (const event of events) {
    const eventText = `${event.reason} ${event.message}`;
    if (!pattern.test(eventText) || shouldSkipTemplateRuleMatch(rule, pattern, eventText)) {
      continue;
    }

    const namespace = event.involvedObject.namespace ?? 'default';
    pushUniqueEvidence(target, {
      path: eventsFilePath(namespace),
      note:
        `Template rule '${rule.label}' matched event '${event.reason}' for ` +
        `'${event.involvedObject.name}': ${event.message}`,
      artifactType: 'event',
      timestamp: event.firstTimestamp,
    });
  }
}

function collectTemplateRuleMatchesFromResources(
  target: Evidence[],
  rule: EvidenceRule,
  pattern: RegExp,
  resources: K8sResource[],
  context: InvestigatorContext,
): void {
  for (const resource of resources) {
    const resourceText = JSON.stringify(resource);
    if (!pattern.test(resourceText) || shouldSkipTemplateRuleMatch(rule, pattern, resourceText)) {
      continue;
    }

    pushUniqueEvidence(target, {
      path: resourceEvidencePath(resource, context),
      note:
        `Template rule '${rule.label}' matched ${resource.kind} ` +
        `'${resource.metadata.name}': ${extractMatchSnippet(resourceText, pattern)}`,
      artifactType: 'kubernetes-resource',
    });
  }
}

function collectTemplateRuleMatchesFromSymptom(
  target: Evidence[],
  rule: EvidenceRule,
  pattern: RegExp,
  hypothesis: Hypothesis,
): void {
  if (!pattern.test(hypothesis.symptom) || shouldSkipTemplateRuleMatch(rule, pattern, hypothesis.symptom)) {
    return;
  }

  pushUniqueEvidence(target, {
    path: hypothesis.sourceFindings[0] ?? hypothesis.id,
    note: `Template rule '${rule.label}' matched symptom text: "${hypothesis.symptom}"`,
  });
}

// ---------------------------------------------------------------------------
// Dispatch table
// ---------------------------------------------------------------------------

type CategoryCollector = (context: InvestigatorContext) => EvidenceAssessment;

// Fallback chain:
//   1. Dedicated category collector (when present)
//   2. Declarative template evidence rules attached to the hypothesis
//   3. Generic missing-decisive fallback when neither of the above yields evidence
const CATEGORY_COLLECTORS: Partial<Record<HypothesisCategory, CategoryCollector>> = {
  'missing-secret': collectMissingSecretEvidence,
  'dns-failure': collectDnsFailureEvidence,
  'image-pull-failure': collectImagePullEvidence,
  'config-error': collectConfigErrorEvidence,
  'connectivity-failure': collectConnectivityEvidence,
  'readiness-failure': collectReadinessFailureEvidence,
  'volume-mount-failure': collectVolumeFailureEvidence,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Actively searches for evidence that would *disprove* (falsify) a
 * hypothesis, based on its category.
 *
 * Unlike the category-specific collectors which gather both supporting and
 * contradicting evidence broadly, this function focuses exclusively on finding
 * evidence that would directly negate the hypothesis:
 *
 * - `dns-failure`         — successful DNS resolution/connection to the **same hostname**
 *   that was failing
 * - `missing-secret`      — the **explicitly named** Secret is actually present in the
 *   cluster resource inventory
 * - `image-pull-failure`  — a successful pull from the **same container registry** that
 *   experienced the pull failure (contradicts registry auth as the cause)
 *
 * The returned {@link EvidenceAssessment} populates only `contradicting`;
 * `supporting` and `missingDecisive` are always empty.
 *
 * This function is wired into {@link collectEvidenceForHypothesis} and its
 * results are merged into the final assessment's `contradicting` array.
 *
 * @param hypothesis - The hypothesis to actively attempt to falsify.
 * @param context    - The full bundle context (resources, events, logs).
 * @returns An {@link EvidenceAssessment} whose `contradicting` array contains
 *   any found falsifying evidence.
 */
export function collectFalsifyingEvidence(
  hypothesis: Hypothesis,
  context: InvestigatorContext,
): EvidenceAssessment {
  switch (hypothesis.category) {
    case 'dns-failure':
      return collectDnsFalsifyingEvidence(hypothesis, context);
    case 'missing-secret':
      return collectMissingSecretFalsifyingEvidence(hypothesis, context);
    case 'image-pull-failure':
      return collectImagePullFalsifyingEvidence(hypothesis, context);
    default:
      return emptyAssessment();
  }
}

/**
 * Collects supporting, contradicting, and missing-decisive evidence for a
 * single {@link Hypothesis} from the bundle data in `context`.
 *
 * The function follows a three-stage fallback chain:
 * 1. Run a dedicated category collector when one exists.
 * 2. Supplement the result with declarative template evidence rules attached
 *    to `hypothesis.evidenceRules`.
 * 3. When no dedicated collector exists and template rules yield no evidence,
 *    add a generic missing-decisive entry.
 *
 * After that, {@link collectFalsifyingEvidence} is called to actively search
 * for evidence that would *disprove* the hypothesis; any found contradicting
 * items are merged into the final assessment.
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
  const assessment = collector != null ? collector(context) : emptyAssessment();
  const hasDedicatedEvidence =
    assessment.supporting.length > 0 || assessment.contradicting.length > 0;
  const templateAssessment = collectTemplateRuleEvidence(hypothesis, context);

  // Declarative template rules are always collected. For categories without a
  // dedicated collector they are the primary evidence source. For categories
  // with a structured collector:
  //   - when the dedicated collector found no direct evidence, use the full
  //     template assessment as the fallback source;
  //   - otherwise merge only symptom-/finding-derived template evidence as a
  //     conservative supplement, avoiding score inflation from re-counting the
  //     same logs/events/resources the structured collector already examined.
  if (collector == null || !hasDedicatedEvidence) {
    mergeAssessmentInto(assessment, templateAssessment);
  } else {
    mergeSupplementalAssessmentInto(
      assessment,
      selectSymptomTemplateEvidence(templateAssessment, hypothesis),
    );
  }

  if (
    collector == null &&
    assessment.supporting.length === 0 &&
    assessment.contradicting.length === 0
  ) {
    assessment.missingDecisive.push(
      `No dedicated evidence collector for category '${hypothesis.category}' — manual investigation required`,
    );
  }

  // Actively collect falsifying evidence and merge contradicting items.
  mergeAssessmentInto(assessment, collectFalsifyingEvidence(hypothesis, context));

  return assessment;
}
