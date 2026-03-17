import type { Finding, Evidence, FindingSeverity } from '../types/index.js';
import type { InvestigatorContext } from './types.js';
import { extractPodStatus, isWorkloadReady } from '../parsers/index.js';

// ---------------------------------------------------------------------------
// Contradiction-detection helpers
// ---------------------------------------------------------------------------

/** Patterns that indicate a successful connection or DNS resolution in log text */
const SUCCESSFUL_CONNECTION_PATTERNS: RegExp[] = [
  /successfully connected/i,
  /connection established/i,
  /connected to\s+\S+/i,
  /successfully resolved/i,
  /resolved.*address/i,
  /dns.*success/i,
  /lookup.*success/i,
];

// ---------------------------------------------------------------------------
// Component-parsing utilities
// ---------------------------------------------------------------------------

/** Parses a `Pod/namespace/name` string into its parts, or `undefined`. */
function parsePodComponent(
  component: string,
): { namespace: string; name: string } | undefined {
  const match = component.match(/^Pod\/([^/]+)\/(.+)$/);
  if (!match) return undefined;
  return { namespace: match[1]!, name: match[2]! };
}

/** Parses a `{Kind}/namespace/name` workload string, or `undefined`. */
function parseWorkloadComponent(
  component: string,
): { kind: string; namespace: string; name: string } | undefined {
  const match = component.match(
    /^(Deployment|StatefulSet|DaemonSet|ReplicaSet)\/([^/]+)\/(.+)$/,
  );
  if (!match) return undefined;
  return { kind: match[1]!, namespace: match[2]!, name: match[3]! };
}

/** Returns true when a finding title describes pod-health degradation. */
function isPodHealthFinding(title: string): boolean {
  const lower = title.toLowerCase();
  return (
    lower.includes('crashloop') ||
    lower.includes('imagepull') ||
    lower.includes('image pull') ||
    lower.includes('not ready') ||
    (lower.includes('unhealthy') && lower.includes('pod'))
  );
}

/** Returns true when a finding title describes workload-health degradation. */
function isWorkloadHealthFinding(title: string): boolean {
  const lower = title.toLowerCase();
  return lower.includes('unhealthy workload');
}

/** Returns the first affected component with the given prefix, if any. */
function findComponentWithPrefix(
  components: string[],
  prefix: string,
): string | undefined {
  return components.find((component) => component.startsWith(prefix));
}

// ---------------------------------------------------------------------------
// Contradiction check 1: Pod health
// ---------------------------------------------------------------------------

/**
 * For a finding referencing a `Pod/namespace/name` component, checks whether
 * the pod resource in the context is actually healthy (Ready=True or
 * restartCount=0 for a CrashLoop finding).
 *
 * Returns contradiction strings to add to `contradictionsChecked[]`.
 */
function checkPodHealthContradictions(
  finding: Finding,
  context: InvestigatorContext,
): string[] {
  const contradictions: string[] = [];
  const titleLower = finding.title.toLowerCase();

  if (!isPodHealthFinding(finding.title)) {
    return contradictions;
  }

  const podRefs = finding.affectedComponents
    .map(parsePodComponent)
    .filter((p): p is { namespace: string; name: string } => p !== undefined);

  for (const podRef of podRefs) {
    const podResource = context.resources.find(
      (r) =>
        r.kind === 'Pod' &&
        r.metadata.name === podRef.name &&
        (r.metadata.namespace ?? 'default') === podRef.namespace,
    );
    if (!podResource) continue;

    const podStatus = extractPodStatus(podResource);
    if (!podStatus) continue;

    // If the pod is now Ready=True, this contradicts unhealthy/not-ready findings
    const readyCond = podStatus.conditions.find((c) => c.type === 'Ready');
    if (readyCond?.status === 'True') {
      contradictions.push(
        `Pod '${podRef.name}' in namespace '${podRef.namespace}' shows Ready=True in current status — pod may have recovered`,
      );
    }

    // If finding is CrashLoop but pod reports zero restarts, hypothesis is weakened
    if (titleLower.includes('crashloop') && podStatus.restartCount === 0) {
      contradictions.push(
        `Pod '${podRef.name}' reports restartCount=0 in current pod status — weakens CrashLoopBackOff hypothesis`,
      );
    }
  }

  return contradictions;
}

// ---------------------------------------------------------------------------
// Contradiction check 2: Workload health
// ---------------------------------------------------------------------------

/**
 * For a finding referencing a workload component (Deployment, StatefulSet,
 * etc.), checks whether the workload is actually healthy via
 * {@link isWorkloadReady}.
 */
function checkWorkloadContradictions(
  finding: Finding,
  context: InvestigatorContext,
): string[] {
  const contradictions: string[] = [];

  if (!isWorkloadHealthFinding(finding.title)) {
    return contradictions;
  }

  for (const component of finding.affectedComponents) {
    const workload = parseWorkloadComponent(component);
    if (!workload) continue;

    const resource = context.resources.find(
      (r) =>
        r.kind === workload.kind &&
        r.metadata.name === workload.name &&
        (r.metadata.namespace ?? 'default') === workload.namespace,
    );
    if (!resource) continue;

    if (isWorkloadReady(resource)) {
      contradictions.push(
        `${workload.kind} '${workload.name}' reports sufficient ready replicas in current status — workload may have recovered`,
      );
    }
  }

  return contradictions;
}

// ---------------------------------------------------------------------------
// Contradiction check 3: Log-based (DNS / connection failures)
// ---------------------------------------------------------------------------

/**
 * For findings about DNS or connection failures, checks whether the referenced
 * log file also contains successful-connection patterns that would indicate the
 * failure is intermittent rather than persistent.
 */
function checkLogContradictions(
  finding: Finding,
  context: InvestigatorContext,
): string[] {
  const contradictions: string[] = [];
  const titleLower = finding.title.toLowerCase();

  const isDnsOrConnection =
    titleLower.includes('dns') ||
    titleLower.includes('resolution') ||
    titleLower.includes('connection') ||
    titleLower.includes('timeout');

  if (!isDnsOrConnection) return contradictions;

  for (const ev of finding.evidence) {
    if (ev.artifactType !== 'log') continue;

    const logFile = context.logs.find((l) => l.path === ev.path);
    if (!logFile) continue;

    const hasSuccessLines = logFile.lines.some((line) =>
      SUCCESSFUL_CONNECTION_PATTERNS.some((p) => p.test(line.content)),
    );

    if (hasSuccessLines) {
      contradictions.push(
        `Log file '${ev.path}' also contains successful connection patterns — failure may be intermittent, not persistent`,
      );
    }
  }

  return contradictions;
}

// ---------------------------------------------------------------------------
// Confidence adjustment
// ---------------------------------------------------------------------------

/**
 * Computes a confidence delta to apply to a finding based on:
 * - Number of new contradictions found (each reduces confidence by 0.15)
 * - Number of independent evidence paths (multiple paths boost confidence)
 * - Thin evidence (single item, no corroboration reduces confidence by 0.05)
 *
 * The result is clamped before application — the caller is responsible for
 * `Math.min(1.0, Math.max(0.0, confidence + delta))`.
 */
function computeConfidenceDelta(
  finding: Finding,
  newContradictions: string[],
): number {
  let delta = 0;

  // Penalty for each new contradiction (capped at −0.30)
  if (newContradictions.length > 0) {
    delta -= Math.min(newContradictions.length * 0.15, 0.30);
  }

  // Boost for multiple independent evidence paths
  const uniquePaths = new Set(finding.evidence.map((e) => e.path));
  if (uniquePaths.size >= 3) {
    delta += 0.10;
  } else if (uniquePaths.size === 2) {
    delta += 0.05;
  }

  // Penalty for thin evidence (single item only)
  if (finding.evidence.length === 1) {
    delta -= 0.05;
  }

  return delta;
}

// ---------------------------------------------------------------------------
// Missing evidence detection
// ---------------------------------------------------------------------------

/**
 * Detects expected supporting evidence that is absent from the context.
 *
 * - **CrashLoopBackOff findings**: expects log files for the crashing pod to
 *   be present in the context (needed to identify the crash reason).
 * - **Not-ready / unhealthy pod findings**: expects Kubernetes events for the
 *   pod's namespace to be present so readiness probe failures can be confirmed.
 *
 * Only adds entries that are not already recorded in the finding's
 * `missingEvidence` array.
 */
function detectMissingEvidence(
  finding: Finding,
  context: InvestigatorContext,
): string[] {
  const newMissing: string[] = [];
  const titleLower = finding.title.toLowerCase();
  const existingSet = new Set(finding.missingEvidence);

  const podRefs = finding.affectedComponents
    .map(parsePodComponent)
    .filter((p): p is { namespace: string; name: string } => p !== undefined);

  // CrashLoopBackOff: expect at least one log file path that references the pod
  if (titleLower.includes('crashloop')) {
    for (const podRef of podRefs) {
      const podLogPattern = new RegExp(
        `(pods|containers|pod)[/\\\\].*${podRef.namespace}[/\\\\].*${podRef.name}|${podRef.name}[._-]`,
        'i',
      );
      const hasLogFile = context.logs.some((l) => podLogPattern.test(l.path));

      if (!hasLogFile) {
        const entry = `Container log files for pod '${podRef.name}' in namespace '${podRef.namespace}' — needed to determine the root crash reason`;
        if (!existingSet.has(entry)) {
          newMissing.push(entry);
        }
      }
    }
  }

  // Not-ready or unhealthy pod: expect Kubernetes events for the pod
  if (titleLower.includes('not ready') || titleLower.includes('unhealthy')) {
    for (const podRef of podRefs) {
      const hasEvents = context.events.some(
        (e) =>
          e.involvedObject.name === podRef.name &&
          (e.involvedObject.namespace ?? 'default') === podRef.namespace,
      );

      if (!hasEvents) {
        const entry = `Kubernetes events for pod '${podRef.name}' in namespace '${podRef.namespace}'`;
        if (!existingSet.has(entry)) {
          newMissing.push(entry);
        }
      }
    }
  }

  return newMissing;
}

// ---------------------------------------------------------------------------
// Deduplication: canonical key
// ---------------------------------------------------------------------------

/** Maps a finding title to a compact issue-type string for grouping. */
function extractIssueType(title: string): string {
  const lower = title.toLowerCase();

  if (lower.includes('crashloop')) return 'crashloop';
  if (lower.includes('imagepull') || lower.includes('image pull')) return 'imagepull';
  if (lower.includes('not ready')) return 'not-ready';
  if (lower.includes('dns') || lower.includes('resolution fail')) return 'dns-failure';
  if (
    lower.includes('connection') &&
    (lower.includes('timeout') || lower.includes('refused'))
  ) {
    return 'connection-failure';
  }
  if (lower.includes('missing') && lower.includes('secret')) return 'missing-secret';
  if (lower.includes('missing') && lower.includes('service')) return 'missing-service';
  if (lower.includes('image') && lower.includes('mismatch')) return 'image-mismatch';
  if (lower.includes('unhealthy')) return 'unhealthy';

  // Fallback: first 40 chars, normalised
  return lower.slice(0, 40).replace(/\s+/g, '-');
}

/**
 * Picks the most stable root component for cross-investigator deduplication.
 *
 * Different investigators often order `affectedComponents` differently
 * (for example, log findings usually lead with a log path, while Kubernetes
 * findings lead with a pod). This selector prefers the component that best
 * represents the underlying issue so related findings converge reliably.
 */
function extractRootComponent(issueType: string, finding: Finding): string {
  switch (issueType) {
    case 'crashloop':
    case 'not-ready':
      return findComponentWithPrefix(finding.affectedComponents, 'Pod/') ?? finding.affectedComponents[0] ?? finding.id;
    case 'unhealthy':
      return (
        findComponentWithPrefix(finding.affectedComponents, 'Deployment/') ??
        findComponentWithPrefix(finding.affectedComponents, 'StatefulSet/') ??
        findComponentWithPrefix(finding.affectedComponents, 'DaemonSet/') ??
        findComponentWithPrefix(finding.affectedComponents, 'ReplicaSet/') ??
        findComponentWithPrefix(finding.affectedComponents, 'Pod/') ??
        finding.affectedComponents[0] ??
        finding.id
      );
    case 'imagepull':
      return (
        findComponentWithPrefix(finding.affectedComponents, 'Image/') ??
        findComponentWithPrefix(finding.affectedComponents, 'Pod/') ??
        finding.affectedComponents[0] ??
        finding.id
      );
    case 'dns-failure':
      return (
        finding.affectedComponents[0] ??
        findComponentWithPrefix(finding.affectedComponents, 'DNS/') ??
        finding.id
      );
    case 'connection-failure':
      return finding.affectedComponents[0] ?? finding.id;
    case 'missing-secret':
      return (
        findComponentWithPrefix(finding.affectedComponents, 'Secret/') ??
        findComponentWithPrefix(finding.affectedComponents, 'Pod/') ??
        finding.affectedComponents[0] ??
        finding.id
      );
    case 'missing-service':
      return (
        findComponentWithPrefix(finding.affectedComponents, 'Service/') ??
        findComponentWithPrefix(finding.affectedComponents, 'Pod/') ??
        finding.affectedComponents[0] ??
        finding.id
      );
    case 'image-mismatch':
      return (
        findComponentWithPrefix(finding.affectedComponents, 'Container/') ??
        findComponentWithPrefix(finding.affectedComponents, 'Pod/') ??
        finding.affectedComponents[0] ??
        finding.id
      );
    default:
      return finding.affectedComponents[0] ?? finding.id;
  }
}

/**
 * Computes a canonical deduplication key.
 *
 * Findings with the same key (same issue type + same root component) are
 * considered to be about the same underlying issue.
 */
function computeDeduplicationKey(finding: Finding): string {
  const issueType = extractIssueType(finding.title);
  return `${issueType}|${extractRootComponent(issueType, finding)}`;
}

// ---------------------------------------------------------------------------
// Finding merge
// ---------------------------------------------------------------------------

/** Severity order for picking the highest severity when merging. */
const SEVERITY_ORDER: Record<FindingSeverity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
};

function roundConfidence(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/**
 * Merges a group of findings that describe the same root issue into a single
 * representative finding.
 *
 * Strategy:
 * - Base finding = the one with the highest individual confidence
 * - `severity`             = highest across all in the group
 * - `confidence`           = max individual confidence + convergence boost
 *                            (+0.05 per additional independent finding, ≤ +0.10)
 * - `evidence`             = union across all, deduplicated by `path|note`
 * - `affectedComponents`   = union across all, deduplicated
 * - `contradictionsChecked`= union across all, deduplicated
 * - `missingEvidence`      = union across all, deduplicated
 * - `reasoningSummary`     = base finding's summary (most trusted)
 * - `recommendedAction`    = base finding's action (most trusted)
 * - `id`, `title`          = base finding's values
 */
function mergeFindings(group: Finding[]): Finding {
  if (group.length === 1) return group[0]!;

  // Sort highest-confidence first so the base finding is the most trusted
  const sorted = [...group].sort((a, b) => b.confidence - a.confidence);
  const base = sorted[0]!;

  // Highest severity in the group
  const highestSeverity = group.reduce<FindingSeverity>((best, f) => {
    return (SEVERITY_ORDER[f.severity] ?? 0) > (SEVERITY_ORDER[best] ?? 0)
      ? f.severity
      : best;
  }, base.severity);

  // Convergence boost: multiple investigators independently found the same issue
  const convergenceBoost = Math.min((group.length - 1) * 0.05, 0.10);
  const maxConfidence = roundConfidence(
    Math.min(1.0, Math.max(...group.map((f) => f.confidence)) + convergenceBoost),
  );

  // Union of evidence (deduplicated by path+note)
  const evidenceMap = new Map<string, Evidence>();
  for (const f of group) {
    for (const ev of f.evidence) {
      const key = `${ev.path}|${ev.note}`;
      if (!evidenceMap.has(key)) {
        evidenceMap.set(key, ev);
      }
    }
  }

  // Union of string arrays (deduplicated)
  function unionStrings(...arrays: string[][]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const arr of arrays) {
      for (const s of arr) {
        if (!seen.has(s)) {
          seen.add(s);
          result.push(s);
        }
      }
    }
    return result;
  }

  return {
    ...base,
    severity: highestSeverity,
    confidence: maxConfidence,
    evidence: Array.from(evidenceMap.values()),
    affectedComponents: unionStrings(...group.map((f) => f.affectedComponents)),
    contradictionsChecked: unionStrings(...group.map((f) => f.contradictionsChecked)),
    missingEvidence: unionStrings(...group.map((f) => f.missingEvidence)),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Verifies a set of raw findings produced by targeted investigators by:
 *
 * 1. **Contradiction checks** — for each finding, inspects the context for
 *    evidence that weakens the hypothesis:
 *    - Pod Ready=True contradicts unhealthy/not-ready findings
 *    - restartCount=0 contradicts CrashLoopBackOff findings
 *    - Workload `readyReplicas == replicas` contradicts unhealthy workload findings
 *    - Successful-connection log lines contradict DNS/connection failure findings
 *    New contradiction strings are appended to `contradictionsChecked[]`.
 *
 * 2. **Confidence adjustment** — adjusts each finding's confidence score:
 *    - −0.15 per new contradiction (capped at −0.30)
 *    - +0.05 / +0.10 when evidence comes from 2 or 3+ independent paths
 *    - −0.05 for thin evidence (single evidence item, no corroboration)
 *
 * 3. **Missing evidence detection** — adds entries to `missingEvidence[]` when
 *    expected corroborating data is absent:
 *    - CrashLoopBackOff: no container log files for the crashing pod
 *    - Not-ready / unhealthy pod: no Kubernetes events for the pod
 *
 * 4. **Deduplication** — groups findings that share the same issue type and
 *    primary affected component (from different investigators) and merges them
 *    into a single representative finding, combining evidence arrays and
 *    applying a convergence confidence boost (+0.05 per additional finding).
 *
 * @param findings - Raw findings from all investigators.
 * @param context  - Bundle context for contradiction and missing-evidence checks.
 * @returns Verified, adjusted, and deduplicated findings, sorted by confidence
 *          descending (highest-confidence finding first).
 */
export function verifyFindings(
  findings: Finding[],
  context: InvestigatorContext,
): Finding[] {
  if (findings.length === 0) return [];

  // ── Step 1–3: per-finding contradiction checks, confidence adjustment,
  //             and missing-evidence detection ──────────────────────────────
  const verified = findings.map((finding): Finding => {
    const podContradictions = checkPodHealthContradictions(finding, context);
    const workloadContradictions = checkWorkloadContradictions(finding, context);
    const logContradictions = checkLogContradictions(finding, context);

    const newContradictions = [
      ...podContradictions,
      ...workloadContradictions,
      ...logContradictions,
    ];

    const newMissing = detectMissingEvidence(finding, context);

    // Append new contradictions (don't replace existing)
    const allContradictions = [...finding.contradictionsChecked, ...newContradictions];

    // Append new missing evidence (deduplicate against existing)
    const existingMissingSet = new Set(finding.missingEvidence);
    const allMissing = [
      ...finding.missingEvidence,
      ...newMissing.filter((m) => !existingMissingSet.has(m)),
    ];

    // Confidence: compute delta against the updated finding for evidence-path
    // counting, and separately track the new contradictions for the penalty
    const delta = computeConfidenceDelta(finding, newContradictions);
    const newConfidence = roundConfidence(
      Math.min(1.0, Math.max(0.0, finding.confidence + delta)),
    );

    return {
      ...finding,
      confidence: newConfidence,
      contradictionsChecked: allContradictions,
      missingEvidence: allMissing,
    };
  });

  // ── Step 4: deduplication ────────────────────────────────────────────────
  const groups = new Map<string, Finding[]>();
  for (const finding of verified) {
    const key = computeDeduplicationKey(finding);
    const group = groups.get(key) ?? [];
    group.push(finding);
    groups.set(key, group);
  }

  const deduplicated = Array.from(groups.values()).map(mergeFindings);

  // Sort by confidence descending (highest first)
  return deduplicated.sort((a, b) => b.confidence - a.confidence);
}
