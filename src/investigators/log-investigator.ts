import type { Finding, FindingSeverity, Evidence, GraphEdge } from '../types/index.js';
import type { InvestigatorContext, InvestigatorResult, InvestigationSeed } from './types.js';
import type { LogFile } from '../parsers/index.js';
import type { LogClassification } from '../parsers/index.js';
import { extractErrorWindows, classifyLogs, correlateEventsWithPod, getEventWindow } from '../parsers/index.js';
import type { K8sResource, K8sEvent } from '../types/index.js';
import { cleanEvidencePath } from '../reporters/display-helpers.js';

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface PatternDef {
  pattern: RegExp;
  label: string;
}

interface PatternMatch {
  lineNumber: number;
  content: string;
  patternLabel: string;
  /** True when this line is itself an error-level line (centre of an error window). */
  inErrorContext: boolean;
}

interface Counter {
  value: number;
}

// ---------------------------------------------------------------------------
// Pattern definitions
// ---------------------------------------------------------------------------

/**
 * DNS resolution failure patterns.
 * Ordered most-specific first so the first match wins per line.
 */
const DNS_FAILURE_PATTERNS: PatternDef[] = [
  { pattern: /no such host/i, label: 'no such host' },
  { pattern: /lookup\s+failed/i, label: 'lookup failed' },
  { pattern: /name\s+resolution\s+fail/i, label: 'name resolution failed' },
  { pattern: /NXDOMAIN/i, label: 'NXDOMAIN' },
  { pattern: /could not resolve/i, label: 'could not resolve' },
  { pattern: /dns.*fail/i, label: 'DNS failure' },
];

/** Network connection timeout and refused patterns. */
const CONNECTION_TIMEOUT_PATTERNS: PatternDef[] = [
  { pattern: /connection refused/i, label: 'connection refused' },
  { pattern: /context deadline exceeded/i, label: 'context deadline exceeded' },
  { pattern: /connection timed out/i, label: 'connection timed out' },
  { pattern: /i\/o timeout/i, label: 'I/O timeout' },
  { pattern: /read.*timeout/i, label: 'read timeout' },
  { pattern: /dial tcp.*timeout/i, label: 'dial TCP timeout' },
];

/**
 * Missing Kubernetes resource / secret patterns.
 * More-specific patterns (secret/configmap) are listed first.
 */
const MISSING_RESOURCE_PATTERNS: PatternDef[] = [
  { pattern: /secret.*not\s+found/i, label: 'secret not found' },
  { pattern: /configmap.*not\s+found/i, label: 'configmap not found' },
  { pattern: /no such file or directory/i, label: 'file not found' },
  { pattern: /not\s+found/i, label: 'not found' },
];

/** Container image pull failure patterns. */
const IMAGE_PULL_PATTERNS: PatternDef[] = [
  { pattern: /ErrImagePull/i, label: 'ErrImagePull' },
  { pattern: /ImagePullBackOff/i, label: 'ImagePullBackOff' },
  { pattern: /failed to pull image/i, label: 'failed to pull image' },
  { pattern: /pulling.*image.*failed/i, label: 'image pull failed' },
  { pattern: /Back-off pulling image/i, label: 'back-off pulling image' },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Scans every line in `logFile` against the given `patterns`, returning one
 * {@link PatternMatch} per matching line (first pattern wins per line).
 *
 * Uses the set of error-line numbers produced by {@link extractErrorWindows}
 * to mark whether each match is in an error-level context.
 */
function findMatchingLines(
  logFile: LogFile,
  patterns: PatternDef[],
  errorLineNums: Set<number>,
): PatternMatch[] {
  const matches: PatternMatch[] = [];

  for (const line of logFile.lines) {
    for (const def of patterns) {
      if (def.pattern.test(line.content)) {
        matches.push({
          lineNumber: line.lineNumber,
          content: line.content,
          patternLabel: def.label,
          inErrorContext: errorLineNums.has(line.lineNumber),
        });
        break; // Only the first matching pattern per line is recorded
      }
    }
  }

  return matches;
}

/**
 * Formats a concise evidence note with line numbers and a content preview.
 *
 * Shows up to `maxLines` matched lines. The note always includes:
 * - "Line N:" or "Lines N, M:" for the line number(s)
 * - A preview of the first matched line (truncated to 150 chars)
 * - A "(+ K more)" suffix when there are additional matches
 */
function formatMatchNote(matches: PatternMatch[], maxLines = 3): string {
  const limited = matches.slice(0, maxLines);
  const lineNums = limited.map((m) => `${m.lineNumber}`).join(', ');
  const preview = limited[0]!.content.slice(0, 150);
  const more = matches.length > maxLines ? ` (+ ${matches.length - maxLines} more)` : '';
  return `Line${limited.length > 1 ? 's' : ''} ${lineNums}: ${preview}${more}`;
}

/**
 * Extracts hostname-like string values from pod container environment variables.
 *
 * Matches values that look like DNS names (contain a dot and a multi-char TLD)
 * or Kubernetes in-cluster service names (*.svc.cluster.local).
 *
 * Used to correlate DNS failure log patterns with configured service endpoints.
 */
function extractEnvVarHostnames(resources: K8sResource[]): string[] {
  const hostnames: string[] = [];

  for (const resource of resources) {
    if (resource.kind !== 'Pod') continue;
    if (!isRecord(resource.spec)) continue;

    const containers = resource.spec['containers'];
    if (!Array.isArray(containers)) continue;

    for (const container of containers) {
      if (!isRecord(container)) continue;
      const env = container['env'];
      if (!Array.isArray(env)) continue;

      for (const envVar of env) {
        if (!isRecord(envVar)) continue;
        const value = envVar['value'];
        if (typeof value !== 'string') continue;

        // A hostname must look like a DNS name (dot-separated, valid TLD) or a
        // k8s in-cluster service FQDN.
        if (
          /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(value) ||
          /^[a-z0-9][a-z0-9-]*\.svc\.cluster\.local$/i.test(value)
        ) {
          hostnames.push(value);
        }
      }
    }
  }

  return hostnames;
}

/**
 * Extracts the names of Kubernetes Secrets referenced by pod specs.
 *
 * Checks two locations in each pod spec:
 * - `spec.volumes[].secret.secretName` (volume mounts)
 * - `spec.containers[].envFrom[].secretRef.name` (environment injection)
 *
 * Used to correlate missing-resource log errors with actual K8s configuration.
 */
function extractReferencedSecretNames(resources: K8sResource[]): string[] {
  const secretNames: string[] = [];

  for (const resource of resources) {
    if (resource.kind !== 'Pod') continue;
    if (!isRecord(resource.spec)) continue;

    // From spec.volumes[].secret.secretName
    const volumes = resource.spec['volumes'];
    if (Array.isArray(volumes)) {
      for (const volume of volumes) {
        if (!isRecord(volume)) continue;
        const secret = volume['secret'];
        if (isRecord(secret) && typeof secret['secretName'] === 'string') {
          secretNames.push(secret['secretName']);
        }
      }
    }

    // From spec.containers[].envFrom[].secretRef.name
    const containers = resource.spec['containers'];
    if (Array.isArray(containers)) {
      for (const container of containers) {
        if (!isRecord(container)) continue;
        const envFrom = container['envFrom'];
        if (!Array.isArray(envFrom)) continue;
        for (const ef of envFrom) {
          if (!isRecord(ef)) continue;
          const secretRef = ef['secretRef'];
          if (isRecord(secretRef) && typeof secretRef['name'] === 'string') {
            secretNames.push(secretRef['name']);
          }
        }
      }
    }
  }

  return secretNames;
}

/**
 * Extracts a hostname from a DNS failure log line.
 *
 * Matches patterns such as:
 * - `lookup db.internal:` → `db.internal`
 * - `resolving db.internal` → `db.internal`
 */
function extractHostnameFromMatch(content: string): string | undefined {
  const lookupMatch = content.match(/lookup\s+([a-z0-9][a-z0-9.-]*)/i);
  if (lookupMatch?.[1]) return lookupMatch[1];
  const resolveMatch = content.match(/resolv(?:e|ing)\s+([a-z0-9][a-z0-9.-]*)/i);
  if (resolveMatch?.[1]) return resolveMatch[1];
  return undefined;
}

/**
 * Extracts a Kubernetes Secret name from a "secret not found" log line.
 *
 * Matches patterns such as:
 * - `secret "app-credentials" not found` → `app-credentials`
 * - `secret app-credentials not found` → `app-credentials`
 */
function extractSecretNameFromMatch(content: string): string | undefined {
  const match = content.match(
    /secret[s]?\s+["']?([a-z0-9][a-z0-9-]*)["']?\s+not\s+found/i,
  );
  return match?.[1];
}

/**
 * Extracts a container image name from an image pull failure log line.
 *
 * Matches patterns such as:
 * - `image "myapp:v999"` → `myapp:v999`
 * - `pulling "myapp:v999"` → `myapp:v999`
 */
function extractImageNameFromMatch(content: string): string | undefined {
  const match =
    content.match(/image\s+["']([^"']+)["']/i) ??
    content.match(/pulling\s+["']([^"']+)["']/i);
  return match?.[1];
}

/**
 * Resolves the affected component string for a log file.
 *
 * Resolution strategy (first match wins):
 * 1. **Filename match** — if the basename (without extension) matches a known
 *    Pod name, returns `['Pod/<ns>/<pod-name>']`.  Covers legacy log paths
 *    such as `logs/app/app-pod.log`.
 * 2. **Parent-directory match** — if the filename match fails (e.g. for init
 *    or sidecar container logs whose filename is the *container* name), the
 *    immediate parent directory is checked against known Pod names.  This
 *    handles the real Troubleshoot bundle layout:
 *    `cluster-resources/pods/logs/<ns>/<pod>/<container>.log`.
 * 3. **Fallback** — returns the bundle-relative cleaned path when neither
 *    heuristic finds a matching Pod resource.
 *
 * @param logFilePath - The path of the log file (may be absolute or relative).
 * @param resources   - All K8s resources in the context, used to look up Pods.
 */
function resolveLogPodComponent(logFilePath: string, resources: K8sResource[]): string[] {
  const segments = logFilePath.split('/');

  // --- 1. Filename-based match (backwards-compatible) ---
  // e.g. 'logs/app/app-pod.log' → basename 'app-pod'
  const filename = segments[segments.length - 1] ?? '';
  const dotIdx = filename.lastIndexOf('.');
  const basename = dotIdx !== -1 ? filename.slice(0, dotIdx) : filename;

  if (basename) {
    for (const resource of resources) {
      if (resource.kind !== 'Pod') continue;
      if (resource.metadata.name === basename) {
        const ns = resource.metadata.namespace ?? 'default';
        return [`Pod/${ns}/${resource.metadata.name}`];
      }
    }
  }

  // --- 2. Parent-directory match (init / sidecar container logs) ---
  // For paths like 'cluster-resources/pods/logs/<ns>/<pod>/<container>.log'
  // the filename is the container name; the pod name is one level up.
  const parentDir = segments[segments.length - 2];
  if (parentDir) {
    for (const resource of resources) {
      if (resource.kind !== 'Pod') continue;
      if (resource.metadata.name === parentDir) {
        const ns = resource.metadata.namespace ?? 'default';
        return [`Pod/${ns}/${resource.metadata.name}`];
      }
    }
  }

  // --- 3. Fallback — no matching Pod found ---
  return [cleanEvidencePath(logFilePath)];
}

// ---------------------------------------------------------------------------
// Temporal correlation helpers
// ---------------------------------------------------------------------------

/**
 * Extracts the pod name from a list of affected component strings.
 *
 * Expects at least one entry in the format `Pod/<namespace>/<name>` and
 * returns the pod name (last segment).  Returns `undefined` when no Pod
 * component is present.
 */
function extractPodNameFromComponents(components: string[]): string | undefined {
  for (const comp of components) {
    if (comp.startsWith('Pod/')) {
      const parts = comp.split('/');
      const name = parts[parts.length - 1];
      if (name) return name;
    }
  }
  return undefined;
}

/**
 * Builds evidence items from K8s events correlated with a pod around the
 * time the log errors occurred.
 *
 * Strategy:
 * 1. Call `correlateEventsWithPod` to get all events for the pod.
 * 2. If the matched log lines carry timestamps, narrow the window to
 *    ±5 minutes around the earliest/latest log error timestamp.
 * 3. Return at most 5 evidence items so findings stay concise.
 */
function buildEventCorrelationEvidence(
  logFile: LogFile,
  matches: PatternMatch[],
  podName: string,
  allEvents: K8sEvent[],
): Evidence[] {
  const podEvents = correlateEventsWithPod(allEvents, podName);
  if (podEvents.length === 0) return [];

  // Build a lineNumber → LogLine map for timestamp lookup
  const lineMap = new Map(logFile.lines.map((l) => [l.lineNumber, l]));

  // Collect parsed timestamps from the matched log lines
  const timestampMs: number[] = [];
  for (const match of matches) {
    const line = lineMap.get(match.lineNumber);
    if (line?.timestamp) {
      const ms = Date.parse(line.timestamp);
      if (!isNaN(ms)) timestampMs.push(ms);
    }
  }

  let windowedEvents: K8sEvent[];
  if (timestampMs.length > 0) {
    const windowStart = new Date(Math.min(...timestampMs) - 5 * 60 * 1000);
    const windowEnd = new Date(Math.max(...timestampMs) + 5 * 60 * 1000);
    windowedEvents = getEventWindow(podEvents, windowStart, windowEnd);
  } else {
    // No timestamps on the matched lines — fall back to all pod events
    windowedEvents = podEvents;
  }

  return windowedEvents.slice(0, 5).map((event) => {
    const ns = event.involvedObject.namespace ?? 'default';
    return {
      path: `events/${ns}/${event.involvedObject.name}/${event.reason}`,
      note: `Event ${event.reason} on pod ${event.involvedObject.name}: ${event.message}`,
      artifactType: 'event' as const,
      timestamp: event.firstTimestamp ?? event.lastTimestamp,
    };
  });
}

function nextFindingId(type: string, counter: Counter): string {
  return `finding:log:${type}:${counter.value++}`;
}

function nextEdgeId(counter: Counter): string {
  return `edge:log:${counter.value++}`;
}

// ---------------------------------------------------------------------------
// 1. DNS resolution failures
// ---------------------------------------------------------------------------

/**
 * Detects DNS resolution failures in log files and correlates them with
 * configured hostnames from pod environment variables.
 *
 * Patterns: `no such host`, `lookup failed`, `NXDOMAIN`, etc.
 * Confidence is elevated (0.85) when the failing hostname matches a pod env var.
 */
function investigateDnsFailures(
  context: InvestigatorContext,
  classificationMap: Map<string, LogClassification>,
  counter: Counter,
): { findings: Finding[]; edges: GraphEdge[] } {
  const findings: Finding[] = [];
  const edges: GraphEdge[] = [];

  const envHostnames = extractEnvVarHostnames(context.resources);

  for (const logFile of context.logs) {
    // Use extractErrorWindows to identify which lines are error-level centres
    const errorWindows = extractErrorWindows(logFile);
    const errorLineNums = new Set(errorWindows.map((w) => w.centerLine));

    const matches = findMatchingLines(logFile, DNS_FAILURE_PATTERNS, errorLineNums);
    if (matches.length === 0) continue;

    // Extract referenced hostnames and correlate with pod env var values
    const mentionedHostnames: string[] = [];
    for (const match of matches) {
      const host = extractHostnameFromMatch(match.content);
      if (host) mentionedHostnames.push(host);
    }

    const uniqueHostnames = [...new Set(mentionedHostnames)];
    const correlatedHostnames = uniqueHostnames.filter((h) =>
      envHostnames.some(
        (envH) =>
          envH === h ||
          h.startsWith(envH) ||
          envH.startsWith(h) ||
          // Also match on the first label (e.g. "db" from "db.internal")
          h.split('.')[0] === envH.split('.')[0],
      ),
    );

    const hasEnvCorrelation = correlatedHostnames.length > 0;
    const inErrorContextCount = matches.filter((m) => m.inErrorContext).length;

    // Confidence tiers:
    //   correlated with env hostnames → 0.85
    //   matches appear in error-level lines → 0.80
    //   matches in non-error lines only   → 0.75
    const confidence = hasEnvCorrelation ? 0.85 : inErrorContextCount > 0 ? 0.80 : 0.75;

    const classification = classificationMap.get(logFile.path);
    const categoryNote = classification ? ` (${classification.category} log)` : '';

    const cleanedPath = cleanEvidencePath(logFile.path);
    const evidence: Evidence[] = [
      {
        path: cleanedPath,
        note: formatMatchNote(matches),
        artifactType: 'log',
      },
    ];

    const affectedComponents = resolveLogPodComponent(logFile.path, context.resources);
    for (const host of uniqueHostnames.slice(0, 3)) {
      affectedComponents.push(`DNS/${host}`);
    }

    // Enrich with temporally correlated K8s events for the affected pod
    if (context.events.length > 0) {
      const podName = extractPodNameFromComponents(affectedComponents);
      if (podName) {
        evidence.push(...buildEventCorrelationEvidence(logFile, matches, podName, context.events));
      }
    }

    const findingId = nextFindingId('dns', counter);

    findings.push({
      id: findingId,
      title: `DNS Resolution Failures in ${cleanedPath}`,
      severity: 'high' as FindingSeverity,
      confidence,
      affectedComponents,
      reasoningSummary:
        `Found ${matches.length} DNS resolution failure${matches.length > 1 ? 's' : ''} ` +
        `in log file '${cleanedPath}'${categoryNote}. ` +
        (uniqueHostnames.length > 0
          ? `Affected hostname(s): ${uniqueHostnames.slice(0, 3).join(', ')}. `
          : '') +
        (hasEnvCorrelation
          ? `Correlated with configured hostnames in pod environment variables: ${correlatedHostnames.join(', ')}.`
          : 'No correlation with pod environment variable hostnames found.'),
      evidence,
      contradictionsChecked: [
        `DNS failure pattern confirmed — 'no such host' or similar pattern matched in log content`,
        `${matches.length} matching line(s) found, ${inErrorContextCount} in error-level context`,
      ],
      recommendedAction:
        `Verify DNS configuration in the cluster. ` +
        (uniqueHostnames.length > 0
          ? `Investigate the following hostname(s): ${uniqueHostnames.slice(0, 3).join(', ')}. `
          : '') +
        `Use \`kubectl exec -it <pod> -- nslookup <hostname>\` to test DNS resolution from within the pod. ` +
        `Check CoreDNS logs and configuration for issues. ` +
        `Verify the service name is correct and exists in the expected namespace.`,
      missingEvidence: hasEnvCorrelation
        ? []
        : envHostnames.length > 0
          ? ['Correlation between failed hostnames and pod environment variable hostnames']
          : ['Pod environment variable configuration to cross-reference DNS names'],
    });

    for (const ev of evidence) {
      edges.push({
        id: nextEdgeId(counter),
        source: `evidence:${ev.path}`,
        target: findingId,
        type: 'supports',
        weight: confidence,
      });
    }
  }

  return { findings, edges };
}

// ---------------------------------------------------------------------------
// 2. Connection timeout patterns
// ---------------------------------------------------------------------------

/**
 * Detects connection timeout and refused errors in log files.
 *
 * Patterns: `connection refused`, `context deadline exceeded`,
 *           `connection timed out`, `i/o timeout`, etc.
 * Confidence is elevated (0.80) when 3 or more occurrences are found,
 * indicating a persistent rather than transient failure.
 */
function investigateConnectionTimeouts(
  context: InvestigatorContext,
  classificationMap: Map<string, LogClassification>,
  counter: Counter,
): { findings: Finding[]; edges: GraphEdge[] } {
  const findings: Finding[] = [];
  const edges: GraphEdge[] = [];

  for (const logFile of context.logs) {
    // Use extractErrorWindows to identify error-level lines
    const errorWindows = extractErrorWindows(logFile);
    const errorLineNums = new Set(errorWindows.map((w) => w.centerLine));

    const matches = findMatchingLines(logFile, CONNECTION_TIMEOUT_PATTERNS, errorLineNums);
    if (matches.length === 0) continue;

    const inErrorContextCount = matches.filter((m) => m.inErrorContext).length;

    // Confidence tiers:
    //   3+ occurrences (persistent issue) → 0.80
    //   matches in error-level lines only → 0.70
    //   single non-error-context match    → 0.65
    const confidence =
      matches.length >= 3 ? 0.80 : inErrorContextCount > 0 ? 0.70 : 0.65;

    const patternLabels = [...new Set(matches.map((m) => m.patternLabel))];

    const classification = classificationMap.get(logFile.path);
    const categoryNote = classification ? ` (${classification.category} log)` : '';

    const cleanedPath = cleanEvidencePath(logFile.path);
    const evidence: Evidence[] = [
      {
        path: cleanedPath,
        note: formatMatchNote(matches),
        artifactType: 'log',
      },
    ];

    const affectedComponents = resolveLogPodComponent(logFile.path, context.resources);

    // Enrich with temporally correlated K8s events for the affected pod
    if (context.events.length > 0) {
      const podName = extractPodNameFromComponents(affectedComponents);
      if (podName) {
        evidence.push(...buildEventCorrelationEvidence(logFile, matches, podName, context.events));
      }
    }

    const findingId = nextFindingId('connection-timeout', counter);

    findings.push({
      id: findingId,
      title: `Connection Timeout/Refused in ${cleanedPath}`,
      severity: 'high' as FindingSeverity,
      confidence,
      affectedComponents,
      reasoningSummary:
        `Found ${matches.length} connection failure${matches.length > 1 ? 's' : ''} ` +
        `in log file '${cleanedPath}'${categoryNote}. ` +
        `Detected pattern(s): ${patternLabels.join(', ')}.`,
      evidence,
      contradictionsChecked: [
        `Connection failure pattern confirmed in log content`,
        `${matches.length} matching line(s) found — ` +
          (matches.length >= 3 ? 'persistent recurring issue' : 'isolated occurrence'),
      ],
      recommendedAction:
        `Investigate network connectivity between this pod and its dependencies. ` +
        `Check if the target service is running and accessible. ` +
        `Verify service endpoints using \`kubectl get endpoints -n <namespace>\`. ` +
        `Review NetworkPolicy configurations that might block traffic. ` +
        `Check if resource limits or timeouts are configured appropriately.`,
      missingEvidence: [],
    });

    for (const ev of evidence) {
      edges.push({
        id: nextEdgeId(counter),
        source: `evidence:${ev.path}`,
        target: findingId,
        type: 'supports',
        weight: confidence,
      });
    }
  }

  return { findings, edges };
}

// ---------------------------------------------------------------------------
// 3. Missing resource / secret errors
// ---------------------------------------------------------------------------

/**
 * Detects missing Kubernetes resource errors in log files and correlates them
 * with secrets referenced by pod specs.
 *
 * Patterns: `secret not found`, `configmap not found`, `no such file`, etc.
 * Confidence is elevated (0.85) when the secret name mentioned in the log
 * matches a secret referenced in a pod's `volumes` or `envFrom` spec.
 */
function investigateMissingResources(
  context: InvestigatorContext,
  classificationMap: Map<string, LogClassification>,
  counter: Counter,
): { findings: Finding[]; edges: GraphEdge[] } {
  const findings: Finding[] = [];
  const edges: GraphEdge[] = [];

  const referencedSecrets = extractReferencedSecretNames(context.resources);

  for (const logFile of context.logs) {
    // Use extractErrorWindows to identify error-level lines
    const errorWindows = extractErrorWindows(logFile);
    const errorLineNums = new Set(errorWindows.map((w) => w.centerLine));

    const matches = findMatchingLines(logFile, MISSING_RESOURCE_PATTERNS, errorLineNums);
    if (matches.length === 0) continue;

    // Extract secret names mentioned in log lines and correlate with K8s resources
    const mentionedSecrets: string[] = [];
    for (const match of matches) {
      const secretName = extractSecretNameFromMatch(match.content);
      if (secretName) mentionedSecrets.push(secretName);
    }

    const uniqueSecrets = [...new Set(mentionedSecrets)];
    const correlatedSecrets = uniqueSecrets.filter((s) =>
      referencedSecrets.some((rs) => rs === s || rs.includes(s) || s.includes(rs)),
    );
    const hasK8sCorrelation = correlatedSecrets.length > 0;

    const inErrorContextCount = matches.filter((m) => m.inErrorContext).length;

    // Confidence tiers:
    //   correlated with K8s secret references → 0.85
    //   matches appear in error-level lines   → 0.75
    //   matches in non-error lines only       → 0.70
    const confidence = hasK8sCorrelation ? 0.85 : inErrorContextCount > 0 ? 0.75 : 0.70;

    const classification = classificationMap.get(logFile.path);
    const categoryNote = classification ? ` (${classification.category} log)` : '';

    const cleanedPath = cleanEvidencePath(logFile.path);
    const affectedComponents = resolveLogPodComponent(logFile.path, context.resources);
    for (const secret of uniqueSecrets.slice(0, 3)) {
      affectedComponents.push(`Secret/${secret}`);
    }

    const evidence: Evidence[] = [
      {
        path: cleanedPath,
        note: formatMatchNote(matches),
        artifactType: 'log',
      },
    ];

    // Enrich with temporally correlated K8s events for the affected pod
    if (context.events.length > 0) {
      const podName = extractPodNameFromComponents(affectedComponents);
      if (podName) {
        evidence.push(...buildEventCorrelationEvidence(logFile, matches, podName, context.events));
      }
    }

    const findingId = nextFindingId('missing-resource', counter);

    findings.push({
      id: findingId,
      title: `Missing Resource Errors in ${cleanedPath}`,
      severity: 'high' as FindingSeverity,
      confidence,
      affectedComponents,
      reasoningSummary:
        `Found ${matches.length} missing resource error${matches.length > 1 ? 's' : ''} ` +
        `in log file '${cleanedPath}'${categoryNote}. ` +
        (uniqueSecrets.length > 0
          ? `Referenced secret(s): ${uniqueSecrets.slice(0, 3).join(', ')}. `
          : '') +
        (hasK8sCorrelation
          ? `Correlated with secrets referenced in Kubernetes pod specs: ${correlatedSecrets.join(', ')}.`
          : 'No correlation with pod spec secret references found.'),
      evidence,
      contradictionsChecked: [
        `Missing resource pattern confirmed — 'not found' or similar pattern matched in log content`,
        `${matches.length} matching line(s) found, ${inErrorContextCount} in error-level context`,
      ],
      recommendedAction:
        `Verify that all required secrets, configmaps, and configuration resources exist in the namespace. ` +
        (uniqueSecrets.length > 0
          ? `Create the missing secret(s): ${uniqueSecrets.slice(0, 3).join(', ')}. `
          : '') +
        `Use \`kubectl get secrets -n <namespace>\` and \`kubectl get configmaps -n <namespace>\` to check. ` +
        `Ensure configuration resources are deployed before starting pods that depend on them.`,
      missingEvidence: hasK8sCorrelation
        ? []
        : uniqueSecrets.length > 0
          ? [`Kubernetes pod spec references for secret(s): ${uniqueSecrets.join(', ')}`]
          : [],
    });

    for (const ev of evidence) {
      edges.push({
        id: nextEdgeId(counter),
        source: `evidence:${ev.path}`,
        target: findingId,
        type: 'supports',
        weight: confidence,
      });
    }
  }

  return { findings, edges };
}

// ---------------------------------------------------------------------------
// 4. Image pull failures in logs
// ---------------------------------------------------------------------------

/**
 * Detects container image pull failures recorded in log files.
 *
 * Patterns: `ErrImagePull`, `ImagePullBackOff`, `failed to pull image`, etc.
 * These patterns are highly specific, so findings carry a fixed confidence
 * of 0.85 regardless of corroborating events (those are handled by the
 * Kubernetes investigator).
 */
function investigateImagePullInLogs(
  context: InvestigatorContext,
  classificationMap: Map<string, LogClassification>,
  counter: Counter,
): { findings: Finding[]; edges: GraphEdge[] } {
  const findings: Finding[] = [];
  const edges: GraphEdge[] = [];

  for (const logFile of context.logs) {
    // Use extractErrorWindows to identify error-level lines
    const errorWindows = extractErrorWindows(logFile);
    const errorLineNums = new Set(errorWindows.map((w) => w.centerLine));

    const matches = findMatchingLines(logFile, IMAGE_PULL_PATTERNS, errorLineNums);
    if (matches.length === 0) continue;

    // Extract image names from log matches
    const mentionedImages: string[] = [];
    for (const match of matches) {
      const imageName = extractImageNameFromMatch(match.content);
      if (imageName) mentionedImages.push(imageName);
    }

    const uniqueImages = [...new Set(mentionedImages)];
    // Image pull patterns are highly specific — confidence is fixed at 0.85
    const confidence = 0.85;

    const classification = classificationMap.get(logFile.path);
    const categoryNote = classification ? ` (${classification.category} log)` : '';

    const cleanedPath = cleanEvidencePath(logFile.path);
    const affectedComponents = resolveLogPodComponent(logFile.path, context.resources);
    for (const image of uniqueImages.slice(0, 3)) {
      affectedComponents.push(`Image/${image}`);
    }

    const evidence: Evidence[] = [
      {
        path: cleanedPath,
        note: formatMatchNote(matches),
        artifactType: 'log',
      },
    ];

    // Enrich with temporally correlated K8s events for the affected pod
    if (context.events.length > 0) {
      const podName = extractPodNameFromComponents(affectedComponents);
      if (podName) {
        evidence.push(...buildEventCorrelationEvidence(logFile, matches, podName, context.events));
      }
    }

    const findingId = nextFindingId('image-pull', counter);

    findings.push({
      id: findingId,
      title: `Image Pull Failures in ${cleanedPath}`,
      severity: 'critical' as FindingSeverity,
      confidence,
      affectedComponents,
      reasoningSummary:
        `Found ${matches.length} image pull failure${matches.length > 1 ? 's' : ''} ` +
        `in log file '${cleanedPath}'${categoryNote}. ` +
        (uniqueImages.length > 0
          ? `Affected image(s): ${uniqueImages.slice(0, 3).join(', ')}.`
          : ''),
      evidence,
      contradictionsChecked: [
        `Image pull failure pattern confirmed — ErrImagePull or ImagePullBackOff detected in log`,
        `${matches.length} matching line(s) found in log file`,
      ],
      recommendedAction:
        `Verify the container image tag exists in the registry. ` +
        (uniqueImages.length > 0
          ? `Check image(s): ${uniqueImages.slice(0, 3).join(', ')}. `
          : '') +
        `If using a private registry, verify imagePullSecrets are configured correctly. ` +
        `Check for typos in image names or tags. ` +
        `Review container registry access from the cluster nodes.`,
      missingEvidence: [],
    });

    for (const ev of evidence) {
      edges.push({
        id: nextEdgeId(counter),
        source: `evidence:${ev.path}`,
        target: findingId,
        type: 'supports',
        weight: confidence,
      });
    }
  }

  return { findings, edges };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Targeted log investigator.
 *
 * Scans every log file in the context for four categories of failure patterns
 * and produces evidence-backed {@link Finding} objects with graph edges:
 *
 * 1. **DNS resolution failures** — `no such host`, `lookup failed`, `NXDOMAIN`,
 *    etc.  Correlated with hostname values from pod environment variables.
 * 2. **Connection timeouts / refused** — `connection refused`,
 *    `context deadline exceeded`, `i/o timeout`, etc.  Confidence is higher
 *    for persistent failures (3+ occurrences).
 * 3. **Missing resources / secrets** — `secret not found`, `configmap not
 *    found`, `not found`, etc.  Correlated with secrets referenced in pod
 *    volume mounts and `envFrom` specs.
 * 4. **Image pull failures** — `ErrImagePull`, `ImagePullBackOff`,
 *    `failed to pull image`, etc.  Image names are extracted and included
 *    in `affectedComponents`.
 *
 * Uses {@link extractErrorWindows} to mark whether each matched line is in
 * an error-level context (adjusting confidence accordingly) and
 * {@link classifyLogs} to classify each log file for richer reporting.
 *
 * @param context - All parsed bundle data.
 * @param seeds   - Investigation seeds (available for future prioritisation;
 *                  all log files are examined regardless of seed content).
 */
export function investigateLog(
  context: InvestigatorContext,
  seeds: InvestigationSeed[],
): InvestigatorResult {
  // Seeds are available for future prioritisation
  void seeds;

  if (context.logs.length === 0) {
    return { findings: [], edges: [] };
  }

  // Classify all log files — results used for category/importance metadata
  // in finding descriptions.
  const classifications = classifyLogs(context.logs);
  const classificationMap = new Map(classifications.map((c) => [c.path, c]));

  const counter: Counter = { value: 0 };

  const dnsResult = investigateDnsFailures(context, classificationMap, counter);
  const connResult = investigateConnectionTimeouts(context, classificationMap, counter);
  const missingResult = investigateMissingResources(context, classificationMap, counter);
  const imagePullResult = investigateImagePullInLogs(context, classificationMap, counter);

  // ---------------------------------------------------------------------------
  // Cross-finding causal edges
  //
  // Encode causal chains that span multiple detection passes.
  // These edges complement the per-finding `supports` edges already produced
  // by each individual detector.
  // ---------------------------------------------------------------------------
  const causalEdges: GraphEdge[] = [];

  // DNSFailure → causes → ConnectionTimeout (same pod)
  for (const dnsFinding of dnsResult.findings) {
    const dnsPod = extractPodNameFromComponents(dnsFinding.affectedComponents);
    if (!dnsPod) continue;

    for (const connFinding of connResult.findings) {
      const connPod = extractPodNameFromComponents(connFinding.affectedComponents);
      if (connPod !== dnsPod) continue;

      causalEdges.push({
        id: nextEdgeId(counter),
        source: dnsFinding.id,
        target: connFinding.id,
        type: 'causes',
        weight: 0.8,
        note: `DNS resolution failure for pod '${dnsPod}' causes connection timeout`,
      });
    }
  }

  // MissingResource → causes → ConnectionTimeout (same pod)
  // A missing secret/configmap can cause the application to fail connecting.
  for (const missFinding of missingResult.findings) {
    const missPod = extractPodNameFromComponents(missFinding.affectedComponents);
    if (!missPod) continue;

    for (const connFinding of connResult.findings) {
      const connPod = extractPodNameFromComponents(connFinding.affectedComponents);
      if (connPod !== missPod) continue;

      causalEdges.push({
        id: nextEdgeId(counter),
        source: missFinding.id,
        target: connFinding.id,
        type: 'causes',
        weight: 0.75,
        note: `Missing resource in pod '${missPod}' may cause connection failure`,
      });
    }
  }

  return {
    findings: [
      ...dnsResult.findings,
      ...connResult.findings,
      ...missingResult.findings,
      ...imagePullResult.findings,
    ],
    edges: [
      ...dnsResult.edges,
      ...connResult.edges,
      ...missingResult.edges,
      ...imagePullResult.edges,
      ...causalEdges,
    ],
  };
}
