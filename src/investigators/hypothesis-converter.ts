import type { Evidence, Finding, FindingSeverity } from '../types/index.js';
import type { HypothesisCategory, Hypothesis, HypothesisSet } from './hypothesis-types.js';
import { computeConfidenceQuality } from './verifier.js';

// ---------------------------------------------------------------------------
// Severity mapping
// ---------------------------------------------------------------------------

/** Ordered severity levels from lowest to highest. */
const SEVERITY_LEVELS: FindingSeverity[] = ['info', 'low', 'medium', 'high', 'critical'];

/** Numeric index for each severity level (used for arithmetic downgrade). */
const SEVERITY_INDEX: Record<FindingSeverity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

/**
 * Base severity for each hypothesis category, reflecting the worst-case impact
 * when the hypothesis is confirmed.
 */
const BASE_SEVERITY_BY_CATEGORY: Record<HypothesisCategory, FindingSeverity> = {
  'missing-secret': 'critical',
  'oom-kill': 'critical',
  'image-pull-failure': 'critical',
  'volume-mount-failure': 'critical',
  'dns-failure': 'high',
  'connectivity-failure': 'high',
  'bad-db-endpoint': 'high',
  'config-error': 'medium',
  'readiness-failure': 'medium',
  'missing-service': 'medium',
  'generic-crash': 'medium',
};

/**
 * Category-specific recommended actions to help engineers resolve the issue.
 */
const RECOMMENDED_ACTION_BY_CATEGORY: Record<HypothesisCategory, string> = {
  'missing-secret':
    'Create the missing Kubernetes Secret and ensure all required keys are present in the namespace referenced by the Pod spec.',
  'bad-db-endpoint':
    'Verify the database connection string: check the hostname, port, credentials, and database name. Ensure the endpoint is reachable from the cluster.',
  'dns-failure':
    'Investigate DNS resolution failures: check CoreDNS pod logs, verify that the required Service resources exist, and confirm kube-dns configuration.',
  'image-pull-failure':
    'Verify the container image tag exists in the registry, ensure imagePullSecrets are correctly configured, and confirm registry network accessibility from the cluster.',
  'config-error':
    'Review ConfigMap data and environment variable configuration for missing or incorrect values. Check envFrom and env references in the Pod spec.',
  'oom-kill':
    'Increase the container memory limit in the Pod spec, or profile the application to reduce its peak memory usage.',
  'connectivity-failure':
    'Investigate network connectivity: verify NetworkPolicy rules, check Endpoints resources for service backends, and test pod-to-service connectivity.',
  'readiness-failure':
    'Review the readiness probe configuration: verify the correct port, path, initialDelaySeconds, and periodSeconds are set for the application startup time.',
  'missing-service':
    'Create the missing Kubernetes Service with correct selectors, or verify that the existing Service selector matches the Pod labels.',
  'generic-crash':
    'Review application logs to identify the root crash reason. Check for panics, unhandled exceptions, or fatal errors at startup.',
  'volume-mount-failure':
    'Check PVC status with `kubectl get pvc -n <namespace>`, verify that the referenced StorageClass exists with `kubectl get storageclass`, and confirm the storage provisioner is running and healthy. Create the missing StorageClass or update the PVC to reference an available one.',
};

/** Maximum number of supporting evidence items rendered for one hypothesis finding. */
const MAX_SUPPORTING_EVIDENCE_ITEMS = 8;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derives the {@link FindingSeverity} for a hypothesis finding based on:
 * - The category's base severity (worst-case impact if confirmed)
 * - The confidence score (downgrade by 1 level if < 0.2, 2 levels if < 0.1)
 *
 * This ensures that low-confidence hypotheses do not alarm engineers with
 * inflated severity labels.
 */
function deriveSeverity(category: HypothesisCategory, confidence: number): FindingSeverity {
  const baseIndex = SEVERITY_INDEX[BASE_SEVERITY_BY_CATEGORY[category]] ?? 2;
  let drop = 0;
  if (confidence < 0.1) {
    drop = 2;
  } else if (confidence < 0.2) {
    drop = 1;
  }
  const finalIndex = Math.max(0, baseIndex - drop);
  return SEVERITY_LEVELS[finalIndex] ?? 'info';
}

/**
 * Parses the symptom key embedded in the hypothesis `id` and maps it to a
 * Kubernetes component identifier string suitable for `affectedComponents`.
 *
 * The hypothesis id format is `{symptomKey}:{category}[:{subcategory}]`:
 *   - `"pod-crashloop:default/app-pod:missing-secret"`
 *   - `"pod-imagepull:default/app-pod:image-pull-failure:bad-tag"`
 *   - `"pod-not-ready:default/app-pod:readiness-failure"`
 *   - `"symptom:some-component:generic-crash"`
 *
 * The resulting component uses the Kubernetes component convention, e.g.
 * `"Pod/default/app-pod"`.
 */
function deriveAffectedComponents(hypothesis: Hypothesis): string[] {
  const { id } = hypothesis;

  // All known HypothesisCategory values — used to find where the symptom key ends.
  const categoryNames: HypothesisCategory[] = [
    'missing-secret',
    'bad-db-endpoint',
    'dns-failure',
    'image-pull-failure',
    'config-error',
    'oom-kill',
    'connectivity-failure',
    'readiness-failure',
    'generic-crash',
    'missing-service',
    'volume-mount-failure',
  ];

  // Find the earliest position where a known category appears after a colon.
  let symptomKeyEnd = -1;
  for (const cat of categoryNames) {
    const catIdx = id.indexOf(`:${cat}`);
    if (catIdx !== -1 && (symptomKeyEnd === -1 || catIdx < symptomKeyEnd)) {
      symptomKeyEnd = catIdx;
    }
  }

  const symptomKey = symptomKeyEnd !== -1 ? id.slice(0, symptomKeyEnd) : id;

  // "pod-crashloop:ns/name" | "pod-imagepull:ns/name" | "pod-not-ready:ns/name" | "pod-pending:ns/name"
  // → "Pod/ns/name"
  for (const prefix of ['pod-crashloop', 'pod-imagepull', 'pod-not-ready', 'pod-pending']) {
    if (symptomKey.startsWith(`${prefix}:`)) {
      const suffix = symptomKey.slice(prefix.length + 1); // e.g. "default/app-pod"
      return [`Pod/${suffix}`];
    }
  }

  // "symptom:name" → "name"
  if (symptomKey.startsWith('symptom:')) {
    return [symptomKey.slice('symptom:'.length)];
  }

  // Fallback: use the raw symptom key
  return [symptomKey];
}

/**
 * Builds the reasoning summary for a hypothesis finding.
 *
 * Includes:
 * - The differential-diagnosis rank and root cause statement
 * - The symptom description
 * - The confidence rationale from the scorer
 * - A reference to the source findings that contributed
 */
function formatConfidencePct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function summarizeEvidenceNote(note: string): string {
  const trimmed = note.trim();
  if (trimmed.length <= 140) return trimmed;
  return `${trimmed.slice(0, 137)}...`;
}

function buildRunnerUpComparison(top: Hypothesis, runnerUp: Hypothesis): string {
  const topSpecific = top.evidenceAssessment.supporting.find(
    (e) => !runnerUp.evidenceAssessment.supporting.some((other) => other.note === e.note),
  );

  if (topSpecific != null) {
    return `Preferred over runner-up "${runnerUp.rootCause}" (${formatConfidencePct(runnerUp.confidence)}) because of more direct evidence: ${summarizeEvidenceNote(topSpecific.note)}.`;
  }

  const contradictionDelta =
    runnerUp.evidenceAssessment.contradicting.length -
    top.evidenceAssessment.contradicting.length;
  if (contradictionDelta > 0) {
    return `Preferred over runner-up "${runnerUp.rootCause}" because it has fewer contradictions (${top.evidenceAssessment.contradicting.length} vs ${runnerUp.evidenceAssessment.contradicting.length}) and higher calibrated confidence (${formatConfidencePct(top.confidence)} vs ${formatConfidencePct(runnerUp.confidence)}).`;
  }

  return `Preferred over runner-up "${runnerUp.rootCause}" due to higher calibrated confidence (${formatConfidencePct(top.confidence)} vs ${formatConfidencePct(runnerUp.confidence)}).`;
}

function isSuspiciousEvidenceItem(evidence: Evidence): boolean {
  if (/cluster-resources\/services\/[^/]+\/\d+\.ya?ml$/i.test(evidence.path)) {
    return true;
  }

  if (/hostname '\s*\d+\s*'/i.test(evidence.note)) {
    return true;
  }

  if (/service '\s*\d+\s*'/i.test(evidence.note)) {
    return true;
  }

  return false;
}

function sanitizeSupportingEvidence(evidence: Evidence[]): Evidence[] {
  const deduped: Evidence[] = [];
  const seen = new Set<string>();

  for (const item of evidence) {
    if (isSuspiciousEvidenceItem(item)) {
      continue;
    }

    const key = `${item.path}::${item.note}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(item);
  }

  return deduped.slice(0, MAX_SUPPORTING_EVIDENCE_ITEMS);
}

function sanitizeStringList(items: string[]): string[] {
  const deduped: string[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    const normalized = item.trim();
    if (normalized.length === 0 || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    deduped.push(normalized);
  }

  return deduped;
}

function buildReasoningSummary(
  hypothesis: Hypothesis,
  rank: number,
  runnerUp?: Hypothesis,
): string {
  const parts: string[] = [
    `[Differential diagnosis, rank #${rank}] Root cause: ${hypothesis.rootCause}.`,
    `Symptom: ${hypothesis.symptom}.`,
    `Confidence rationale: ${hypothesis.confidenceRationale}`,
  ];

  if (rank === 1 && runnerUp != null) {
    parts.push(buildRunnerUpComparison(hypothesis, runnerUp));
  }

  if (hypothesis.sourceFindings.length > 0) {
    parts.push(
      `Derived from ${hypothesis.sourceFindings.length} raw finding(s): ${hypothesis.sourceFindings.join(', ')}.`,
    );
  }

  return parts.join(' ');
}

/**
 * Normalizes a finding into the issue family used for hypothesis/original
 * merge decisions.
 *
 * Hypothesis findings use their category directly. Original heuristic findings
 * are classified from their title into the nearest comparable hypothesis issue
 * family, but only when the heuristic finding already expresses a concrete
 * root-cause class. Broad symptom findings such as `CrashLoopBackOff` are left
 * as their own family so they are preserved alongside the hypothesis layer.
 */
function normalizeIssueFamily(finding: Finding): string {
  if (finding.id.startsWith('finding:hypothesis:')) {
    return finding.id.split(':')[2] ?? 'unknown';
  }

  const lower = finding.title.toLowerCase();

  // Secret-related: covers "missing secret", "secret not found", "absent secret",
  // "required secret", "secret 'x' not found", etc.
  if (
    lower.includes('secret') &&
    (lower.includes('missing') ||
      lower.includes('not found') ||
      lower.includes('absent') ||
      lower.includes('required') ||
      lower.includes('does not exist'))
  ) {
    return 'missing-secret';
  }

  // Service-related
  if (
    lower.includes('service') &&
    (lower.includes('missing') || lower.includes('not found') || lower.includes('absent'))
  ) {
    return 'missing-service';
  }

  if (lower.includes('dns') || lower.includes('resolution fail') || lower.includes('no such host')) {
    return 'dns-failure';
  }
  if (
    lower.includes('connection') &&
    (lower.includes('timeout') || lower.includes('refused'))
  ) {
    return 'connectivity-failure';
  }
  if (lower.includes('imagepull') || lower.includes('image pull') || lower.includes('errimagepull')) {
    return 'image-pull-failure';
  }
  if (lower.includes('not ready') || lower.includes('readiness')) return 'readiness-failure';
  if (lower.includes('crashloop') || lower.includes('crash loop')) return 'crashloop';
  if (lower.includes('image') && lower.includes('mismatch')) return 'image-mismatch';
  if (lower.includes('unhealthy')) return 'unhealthy';
  if (lower.includes('oom') || lower.includes('out of memory') || lower.includes('memory limit')) {
    return 'oom-kill';
  }

  return lower.slice(0, 40).replace(/\s+/g, '-');
}

/** Returns `true` when two findings touch at least one shared component. */
function hasComponentOverlap(a: Finding, b: Finding): boolean {
  return a.affectedComponents.some((component) => b.affectedComponents.includes(component));
}

// ---------------------------------------------------------------------------
// Cross-namespace action helper
// ---------------------------------------------------------------------------

/**
 * Scans supporting evidence for cross-namespace service match notes and
 * returns a specific recommended action if found.
 *
 * A cross-namespace note has the form:
 *   "Service 'api-service' exists in namespace 'default' (not 'staging'). ..."
 *
 * When such a note is found, the root cause is a wrong-namespace service
 * reference — the generic DNS-failure action should be replaced with the
 * specific env-var fix extracted from the note.
 */
function extractCrossNamespaceAction(hypothesis: Hypothesis): string | undefined {
  for (const item of hypothesis.evidenceAssessment.supporting) {
    if (!/exists in namespace .* \(not /i.test(item.note)) continue;

    // Extract the actionable "Update ... from ... to ..." part from the note.
    const updateMatch = item.note.match(/Update\s+\S+\s+from\s+.+$/s);
    if (updateMatch?.[0] != null) {
      return `Update the environment variable to point to the correct namespace. ${updateMatch[0]}`;
    }

    // Fallback: construct a generic namespace-fix recommendation from the note.
    const nsMatch = item.note.match(
      /Service '([^']+)' exists in namespace '([^']+)' \(not '([^']+)'\)/i,
    );
    if (nsMatch?.[1] != null && nsMatch[2] != null && nsMatch[3] != null) {
      const service = nsMatch[1];
      const foundNs = nsMatch[2];
      const targetNs = nsMatch[3];
      return (
        `The Service '${service}' exists in namespace '${foundNs}', not in '${targetNs}'. ` +
        `Update all environment variable references to use http://${service}.${foundNs} ` +
        `or http://${service} if the consuming pod is in the ${foundNs} namespace.`
      );
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Converts a single scored {@link Hypothesis} into a {@link Finding}.
 *
 * Field mappings:
 * - `id`                    — `finding:hypothesis:{category}:{rank}`
 * - `title`                 — the hypothesis root-cause statement
 * - `severity`              — derived from confidence and category base severity
 * - `confidence`            — taken directly from the scored hypothesis
 * - `evidence`              — union of supporting evidence items
 * - `contradictionsChecked` — notes from contradicting evidence items
 * - `missingEvidence`       — `missingDecisive` entries plus `specGapRecommendations`
 * - `reasoningSummary`      — includes confidence rationale, symptom context,
 *                             and differential-diagnosis detail
 * - `recommendedAction`     — category-specific action string, or a specific
 *                             cross-namespace fix when cross-namespace service
 *                             evidence is present in supporting evidence
 * - `affectedComponents`    — derived from the hypothesis id / symptom key
 *
 * @param hypothesis - A fully scored hypothesis with `confidence` and
 *                     `evidenceAssessment` populated.
 * @param rank       - 1-indexed rank of this hypothesis (1 = highest confidence
 *                     within its {@link HypothesisSet}, or a global rank when
 *                     called from {@link convertHypothesisSetsToFindings}).
 */
export function convertHypothesisToFinding(hypothesis: Hypothesis, rank: number): Finding {
  const evidence = sanitizeSupportingEvidence(hypothesis.evidenceAssessment.supporting);

  // Build the contradictions list from contradicting evidence notes.
  // When no contradicting evidence exists, add a baseline entry so the
  // finding always has at least one contradiction-checked record (required by
  // the pipeline quality contract for all findings).
  const contradictingNotes = sanitizeStringList(
    hypothesis.evidenceAssessment.contradicting.map((e) => e.note),
  );
  const contradictionsChecked =
    contradictingNotes.length > 0
      ? contradictingNotes
      : [
          `No contradicting evidence found for [${hypothesis.category}] hypothesis in the available bundle data — hypothesis could not be ruled out`,
        ];

  // When cross-namespace service evidence is present, use the specific namespace
  // fix as the recommended action instead of the generic category action.
  const crossNamespaceAction = extractCrossNamespaceAction(hypothesis);
  const recommendedAction =
    crossNamespaceAction ?? RECOMMENDED_ACTION_BY_CATEGORY[hypothesis.category];

  const finding: Finding = {
    id: `finding:hypothesis:${hypothesis.category}:${rank}`,
    title: hypothesis.rootCause,
    severity: deriveSeverity(hypothesis.category, hypothesis.confidence),
    confidence: hypothesis.confidence,
    affectedComponents: deriveAffectedComponents(hypothesis),
    reasoningSummary: buildReasoningSummary(hypothesis, rank),
    evidence,
    contradictionsChecked,
    missingEvidence: sanitizeStringList([
      ...hypothesis.evidenceAssessment.missingDecisive,
      ...hypothesis.specGapRecommendations,
    ]),
    recommendedAction,
  };
  finding.confidenceQuality = computeConfidenceQuality(finding);
  return finding;
}

/**
 * Converts all {@link HypothesisSet}s into a flat array of {@link Finding}s.
 *
 * Every hypothesis in every set is converted — including non-top hypotheses —
 * for transparency (engineers can see the full differential-diagnosis output).
 *
 * A global rank counter is used so each finding's `id` is unique across all
 * sets (rank 1 = first hypothesis in the first set, rank 2 = second hypothesis
 * in the first set or first hypothesis of the second set, etc.).
 *
 * @param sets - Scored and ranked hypothesis sets (from the hypothesis ranker).
 */
export function convertHypothesisSetsToFindings(sets: HypothesisSet[]): Finding[] {
  const findings: Finding[] = [];
  let globalRank = 1;

  for (const set of sets) {
    const runnerUp = set.hypotheses[1];

    for (let i = 0; i < set.hypotheses.length; i++) {
      const hypothesis = set.hypotheses[i]!;
      const localRank = i + 1;
      const baseFinding = convertHypothesisToFinding(hypothesis, globalRank);
      const reasoningSummary = buildReasoningSummary(
        hypothesis,
        localRank,
        localRank === 1 ? runnerUp : undefined,
      );

      findings.push({
        ...baseFinding,
        reasoningSummary,
      });
      globalRank += 1;
    }
  }

  return findings;
}

/**
 * Merges hypothesis-layer findings with original heuristic findings.
 *
 * Strategy:
 * - A hypothesis finding replaces an original heuristic finding only when they
 *   describe the same issue family *and* share at least one affected component.
 * - Symptom-level heuristic findings with no hypothesis equivalent are kept so
 *   the observable symptom remains visible alongside the differential diagnosis.
 * - Original findings that have no matching hypothesis are kept as-is.
 *
 * This function does **not** sort the output — callers are responsible for
 * applying the desired sort order (e.g., severity then confidence).
 *
 * @param hypothesisFindings - Findings produced by the hypothesis layer
 *                             (from {@link convertHypothesisSetsToFindings}).
 * @param originalFindings   - Raw heuristic findings from heuristic investigators.
 * @returns Combined findings with hypothesis findings taking precedence only
 *          for equivalent issues on overlapping components.
 */
export function mergeHypothesisFindings(
  hypothesisFindings: Finding[],
  originalFindings: Finding[],
): Finding[] {
  // AI findings always win over hypothesis findings for the same issue.
  // When an AI finding covers the same issue family + component as a hypothesis
  // finding, the hypothesis finding is suppressed in favour of the AI finding.
  // This prevents the hypothesis layer from burying AI-synthesised diagnoses.
  const aiFindingsInOriginal = originalFindings.filter((f) =>
    f.id.startsWith('finding:ai:'),
  );

  const survivingHypothesis = hypothesisFindings.filter((hypothesisFinding) => {
    if (aiFindingsInOriginal.length === 0) return true;
    const hypothesisFamily = normalizeIssueFamily(hypothesisFinding);
    // Suppress this hypothesis finding if any AI finding covers the same issue
    return !aiFindingsInOriginal.some(
      (aiFinding) =>
        normalizeIssueFamily(aiFinding) === hypothesisFamily &&
        hasComponentOverlap(aiFinding, hypothesisFinding),
    );
  });

  // Non-AI original findings that aren't already covered by a hypothesis finding
  const nonAiOriginals = originalFindings.filter((f) => !f.id.startsWith('finding:ai:'));
  const uncoveredOriginals = nonAiOriginals.filter((originalFinding) => {
    const originalIssueFamily = normalizeIssueFamily(originalFinding);
    return !hypothesisFindings.some(
      (hypothesisFinding) =>
        normalizeIssueFamily(hypothesisFinding) === originalIssueFamily &&
        hasComponentOverlap(hypothesisFinding, originalFinding),
    );
  });

  return [...aiFindingsInOriginal, ...survivingHypothesis, ...uncoveredOriginals];
}
