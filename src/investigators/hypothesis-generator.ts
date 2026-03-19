import type { Finding } from '../types/index.js';
import type { InvestigatorContext } from './types.js';
import type {
  EvidenceAssessment,
  Hypothesis,
  HypothesisCategory,
  HypothesisSet,
} from './hypothesis-types.js';

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** Broad classification of an observed symptom, used to select hypothesis templates. */
type SymptomType = 'crashloop' | 'imagepull' | 'not-ready' | 'pending' | 'generic';

// ---------------------------------------------------------------------------
// Helpers — symptom detection
// ---------------------------------------------------------------------------

/**
 * Returns a lower-cased text corpus for a finding, combining the title,
 * reasoning summary, and evidence notes so symptom detection remains robust
 * even when different investigators phrase the same issue differently.
 */
function findingTextCorpus(finding: Finding): string {
  return [
    finding.title,
    finding.reasoningSummary,
    ...finding.evidence.map((e) => e.note),
    ...finding.missingEvidence,
  ]
    .join(' ')
    .toLowerCase();
}

/**
 * Infers the {@link SymptomType} from the findings in a group.
 *
 * Detection considers titles, reasoning summaries, and evidence notes.
 * The first matching finding wins; if no pattern matches, `'generic'` is
 * returned.
 */
function detectSymptomType(findings: Finding[]): SymptomType {
  for (const finding of findings) {
    const lower = findingTextCorpus(finding);

    if (
      lower.includes('crashloopbackoff') ||
      lower.includes('crashloop') ||
      lower.includes('back-off restarting failed container')
    ) {
      return 'crashloop';
    }

    if (
      lower.includes('imagepullbackoff') ||
      lower.includes('errimagepull') ||
      lower.includes('image pull') ||
      lower.includes('failed to pull image') ||
      lower.includes('back-off pulling image')
    ) {
      return 'imagepull';
    }

    if (
      lower.includes('not ready') ||
      lower.includes('notready') ||
      lower.includes('readiness probe failed') ||
      lower.includes('readiness condition is false')
    ) {
      return 'not-ready';
    }

    if (
      lower.includes('pending pod') ||
      lower.includes('containercreating') ||
      lower.includes('volume mount failure') ||
      lower.includes('failed to mount') ||
      lower.includes('failedmount') ||
      lower.includes('failedscheduling') ||
      lower.includes('provisionfailed') ||
      lower.includes('provisioningfailed')
    ) {
      return 'pending';
    }
  }

  return 'generic';
}

// ---------------------------------------------------------------------------
// Helpers — symptom key / description derivation
// ---------------------------------------------------------------------------

/**
 * Extracts the primary affected component from a finding.
 *
 * Prefers a `Pod/namespace/name` component, then any workload component,
 * then falls back to the first component or the finding id.
 */
function primaryComponentKey(finding: Finding): string {
  const podComp = finding.affectedComponents.find((c) => /^Pod\//.test(c));
  if (podComp) return podComp;

  const workloadComp = finding.affectedComponents.find((c) =>
    /^(Deployment|StatefulSet|DaemonSet|ReplicaSet)\//.test(c),
  );
  if (workloadComp) return workloadComp;

  return finding.affectedComponents[0] ?? finding.id;
}

/**
 * Builds a concise, stable symptom key from a component identifier and the
 * inferred symptom type.
 *
 * Format: `{symptom-type}:{namespace}/{name}` or `{symptom-type}:{name}`,
 * e.g. `pod-crashloop:default/app-pod`.
 */
function buildSymptomKey(componentKey: string, symptomType: SymptomType): string {
  // Extract the meaningful suffix from a component path like "Pod/default/app-pod"
  const slashIdx = componentKey.indexOf('/');
  const suffix = slashIdx !== -1 ? componentKey.slice(slashIdx + 1) : componentKey;

  switch (symptomType) {
    case 'crashloop':
      return `pod-crashloop:${suffix}`;
    case 'imagepull':
      return `pod-imagepull:${suffix}`;
    case 'not-ready':
      return `pod-not-ready:${suffix}`;
    case 'pending':
      return `pod-pending:${suffix}`;
    default:
      return `symptom:${suffix}`;
  }
}

/**
 * Builds a human-readable description of the symptom.
 */
function buildSymptomDescription(
  componentKey: string,
  symptomType: SymptomType,
  findings: Finding[],
): string {
  // Try to parse "Kind/namespace/name" → namespace + name
  const parts = componentKey.split('/');
  const name = parts[parts.length - 1] ?? componentKey;
  const namespace = parts.length >= 3 ? parts[parts.length - 2] : 'unknown';

  switch (symptomType) {
    case 'crashloop':
      return `Pod '${name}' is in CrashLoopBackOff in namespace '${namespace}'`;
    case 'imagepull':
      return `Pod '${name}' cannot pull its container image in namespace '${namespace}'`;
    case 'not-ready':
      return `Pod '${name}' is running but not ready in namespace '${namespace}'`;
    case 'pending':
      return `Pod '${name}' is stuck in Pending/ContainerCreating in namespace '${namespace}'`;
    default:
      // Fall back to the first finding's title as the description
      return findings[0]?.title ?? componentKey;
  }
}

// ---------------------------------------------------------------------------
// Helpers — empty evidence assessment
// ---------------------------------------------------------------------------

/** Returns a fresh, empty {@link EvidenceAssessment} (hypotheses start unscored). */
function emptyEvidenceAssessment(): EvidenceAssessment {
  return {
    supporting: [],
    contradicting: [],
    missingDecisive: [],
  };
}

// ---------------------------------------------------------------------------
// Helpers — hypothesis builder
// ---------------------------------------------------------------------------

/**
 * Constructs a single {@link Hypothesis} with all mutable fields initialised
 * to their zero/empty state.  Confidence will be filled by the scorer in a
 * later step.
 */
function buildHypothesis(
  id: string,
  symptom: string,
  rootCause: string,
  category: HypothesisCategory,
  sourceFindings: string[],
): Hypothesis {
  return {
    id,
    symptom,
    rootCause,
    category,
    evidenceAssessment: emptyEvidenceAssessment(),
    confidence: 0.0,
    confidenceRationale: 'Not yet scored',
    specGapRecommendations: [],
    sourceFindings,
  };
}

/** Returns stable, de-duplicated source finding ids for a symptom group. */
function sourceFindingIds(findings: Finding[]): string[] {
  return Array.from(new Set(findings.map((finding) => finding.id)));
}

// ---------------------------------------------------------------------------
// Hypothesis templates per symptom type
// ---------------------------------------------------------------------------

/**
 * Generates the full set of competing hypotheses for a CrashLoopBackOff
 * symptom.  Five candidates are returned:
 * 1. `missing-secret`  — a required Secret/key is absent
 * 2. `config-error`    — a ConfigMap or env-var is misconfigured
 * 3. `dns-failure`     — startup depends on a hostname that cannot be resolved
 * 4. `oom-kill`        — the container exceeds its memory limit
 * 5. `generic-crash`   — unclassified application bug
 */
function generateCrashLoopHypotheses(
  symptomKey: string,
  symptomDescription: string,
  findings: Finding[],
): Hypothesis[] {
  const sourceIds = findings.map((f) => f.id);

  return [
    buildHypothesis(
      `${symptomKey}:missing-secret`,
      symptomDescription,
      'A required Kubernetes Secret or key is absent, causing the container to fail on startup',
      'missing-secret',
      sourceIds,
    ),
    buildHypothesis(
      `${symptomKey}:config-error`,
      symptomDescription,
      'A ConfigMap value or environment variable is misconfigured, causing the application to exit at startup',
      'config-error',
      sourceIds,
    ),
    buildHypothesis(
      `${symptomKey}:dns-failure`,
      symptomDescription,
      'A dependency hostname required during startup cannot be resolved, causing the application to fail and restart',
      'dns-failure',
      sourceIds,
    ),
    buildHypothesis(
      `${symptomKey}:oom-kill`,
      symptomDescription,
      'The container is being killed by the OOM killer because it exceeds its memory limit',
      'oom-kill',
      sourceIds,
    ),
    buildHypothesis(
      `${symptomKey}:generic-crash`,
      symptomDescription,
      'The application has an unclassified bug causing it to crash immediately on startup',
      'generic-crash',
      sourceIds,
    ),
  ];
}

/**
 * Generates the full set of competing hypotheses for an ImagePullBackOff
 * symptom.  Three candidates are returned:
 * 1. `image-pull-failure` (bad-tag)            — image tag not found in registry
 * 2. `image-pull-failure` (auth-failure)       — imagePullSecret missing/invalid
 * 3. `image-pull-failure` (registry-unavailable) — registry unreachable from cluster
 */
function generateImagePullHypotheses(
  symptomKey: string,
  symptomDescription: string,
  findings: Finding[],
): Hypothesis[] {
  const sourceIds = findings.map((f) => f.id);

  return [
    buildHypothesis(
      `${symptomKey}:image-pull-failure:bad-tag`,
      symptomDescription,
      'The image tag does not exist in the container registry (wrong, misspelled, or deleted tag)',
      'image-pull-failure',
      sourceIds,
    ),
    buildHypothesis(
      `${symptomKey}:image-pull-failure:auth-failure`,
      symptomDescription,
      'Registry authentication failure — pull credentials are invalid, expired, or have insufficient registry permissions',
      'image-pull-failure',
      sourceIds,
    ),
    buildHypothesis(
      `${symptomKey}:image-pull-failure:registry-unavailable`,
      symptomDescription,
      'The container registry is unavailable or unreachable from the cluster network',
      'image-pull-failure',
      sourceIds,
    ),
  ];
}

/**
 * Generates the full set of competing hypotheses for a not-ready symptom.
 * Three candidates are returned:
 * 1. `connectivity-failure` — a required dependency is unavailable
 * 2. `dns-failure`          — DNS resolution is failing
 * 3. `readiness-failure`    — the readiness probe is misconfigured
 */
function generateNotReadyHypotheses(
  symptomKey: string,
  symptomDescription: string,
  findings: Finding[],
): Hypothesis[] {
  const sourceIds = findings.map((f) => f.id);

  return [
    buildHypothesis(
      `${symptomKey}:connectivity-failure`,
      symptomDescription,
      'A required dependency (database, cache, or external service) is unavailable, blocking readiness',
      'connectivity-failure',
      sourceIds,
    ),
    buildHypothesis(
      `${symptomKey}:dns-failure`,
      symptomDescription,
      'DNS resolution is failing for a hostname the application depends on, preventing startup',
      'dns-failure',
      sourceIds,
    ),
    buildHypothesis(
      `${symptomKey}:readiness-failure`,
      symptomDescription,
      'The readiness probe is misconfigured — wrong port, path, or timing parameters cause it to always fail',
      'readiness-failure',
      sourceIds,
    ),
  ];
}

/**
 * Generates the full set of competing hypotheses for a Pending Pod symptom.
 * Three candidates are returned:
 * 1. `volume-mount-failure` — PVC cannot provision because StorageClass is missing
 * 2. `missing-secret`      — A volume or secret referenced in the pod spec is absent
 * 3. `config-error`        — Pod spec has a misconfigured volume reference
 */
function generatePendingPodHypotheses(
  symptomKey: string,
  symptomDescription: string,
  findings: Finding[],
): Hypothesis[] {
  const sourceIds = findings.map((f) => f.id);

  return [
    buildHypothesis(
      `${symptomKey}:volume-mount-failure`,
      symptomDescription,
      'A PersistentVolumeClaim cannot be provisioned because the referenced StorageClass is missing or the storage provisioner is unavailable',
      'volume-mount-failure',
      sourceIds,
    ),
    buildHypothesis(
      `${symptomKey}:missing-secret`,
      symptomDescription,
      'A volume, Secret, or ConfigMap referenced in the pod spec is absent, preventing the container from starting',
      'missing-secret',
      sourceIds,
    ),
    buildHypothesis(
      `${symptomKey}:config-error`,
      symptomDescription,
      'The pod spec has a misconfigured volume reference, resource request, or node selector that prevents scheduling',
      'config-error',
      sourceIds,
    ),
  ];
}

/**
 * Generates a minimal set of generic hypotheses when no specific symptom type
 * can be detected from the finding titles.
 */
function generateGenericHypotheses(
  symptomKey: string,
  symptomDescription: string,
  findings: Finding[],
): Hypothesis[] {
  const sourceIds = sourceFindingIds(findings);

  return [
    buildHypothesis(
      `${symptomKey}:generic-crash`,
      symptomDescription,
      'The application has an unclassified bug or configuration issue causing degraded behaviour',
      'generic-crash',
      sourceIds,
    ),
    buildHypothesis(
      `${symptomKey}:config-error`,
      symptomDescription,
      'A configuration value or environment variable is incorrect or missing',
      'config-error',
      sourceIds,
    ),
  ];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Groups a flat list of {@link Finding} objects by their primary affected
 * component so that all findings about the same Kubernetes object are analysed
 * together as a single symptom.
 *
 * The map key is the normalised component identifier, e.g.
 * `"Pod/default/app-pod"`.
 *
 * @param findings - Raw findings from all investigators.
 * @returns A map from component key → findings sharing that component.
 */
export function groupFindingsBySymptom(findings: Finding[]): Map<string, Finding[]> {
  const groups = new Map<string, Finding[]>();

  for (const finding of findings) {
    const key = primaryComponentKey(finding);
    const group = groups.get(key) ?? [];
    group.push(finding);
    groups.set(key, group);
  }

  return groups;
}

/**
 * Generates all competing hypotheses for a single symptom group.
 *
 * The symptom type is inferred from the finding titles.  Each hypothesis
 * starts with `confidence: 0.0` and empty evidence assessments — the scorer
 * (step 4) will fill these in after the evidence collector (step 3) runs.
 *
 * @param symptomKey - A short stable key for this symptom, e.g.
 *   `"pod-crashloop:default/app-pod"`.
 * @param findings   - All findings contributing to this symptom.
 * @param _context   - Bundle context (reserved for future evidence pre-fetching).
 * @returns Array of competing hypothesis candidates (never empty unless
 *   `findings` is empty).
 */
export function generateHypothesesForSymptom(
  symptomKey: string,
  findings: Finding[],
  _context: InvestigatorContext,
): Hypothesis[] {
  if (findings.length === 0) return [];

  const symptomType = detectSymptomType(findings);

  // Build the description from the first finding when the key is external
  // (called directly from tests); for internal use, buildSymptomDescription
  // provides a richer version derived from the component key.
  const symptomDescription = findings[0]?.title ?? symptomKey;

  switch (symptomType) {
    case 'crashloop':
      return generateCrashLoopHypotheses(symptomKey, symptomDescription, findings);
    case 'imagepull':
      return generateImagePullHypotheses(symptomKey, symptomDescription, findings);
    case 'not-ready':
      return generateNotReadyHypotheses(symptomKey, symptomDescription, findings);
    case 'pending':
      return generatePendingPodHypotheses(symptomKey, symptomDescription, findings);
    default:
      return generateGenericHypotheses(symptomKey, symptomDescription, findings);
  }
}

/**
 * Top-level function that takes all raw findings from the investigation phase
 * and produces one {@link HypothesisSet} per unique symptom (Kubernetes
 * object) observed.
 *
 * The flow is:
 * 1. Group findings by primary affected component.
 * 2. For each group, infer the symptom type from finding titles.
 * 3. Derive a stable `symptomKey` and human-readable `symptomDescription`.
 * 4. Generate competing hypothesis candidates via
 *    {@link generateHypothesesForSymptom}.
 * 5. Wrap everything in a {@link HypothesisSet} with `topHypothesis: null`
 *    (the scorer fills this in).
 *
 * @param findings - Raw findings from all investigators (post-verification).
 * @param context  - Bundle context passed through to hypothesis generators.
 * @returns One {@link HypothesisSet} per unique symptom, in insertion order.
 */
export function generateAllHypotheses(
  findings: Finding[],
  context: InvestigatorContext,
): HypothesisSet[] {
  if (findings.length === 0) return [];

  const groups = groupFindingsBySymptom(findings);
  const sets: HypothesisSet[] = [];

  for (const [componentKey, groupFindings] of groups) {
    const symptomType = detectSymptomType(groupFindings);
    const symptomKey = buildSymptomKey(componentKey, symptomType);
    const symptomDescription = buildSymptomDescription(
      componentKey,
      symptomType,
      groupFindings,
    );

    // Pass the rich description into hypothesis generation by using a slightly
    // different internal path: override the per-finding title with the
    // component-aware description by wrapping the call.
    const hypotheses = generateHypothesesForSymptomInternal(
      symptomKey,
      symptomDescription,
      groupFindings,
      context,
    );

    sets.push({
      symptomKey,
      symptomDescription,
      hypotheses,
      topHypothesis: null,
    });
  }

  return sets;
}

// ---------------------------------------------------------------------------
// Internal helper — avoids repeating symptom-type detection
// ---------------------------------------------------------------------------

/**
 * Like {@link generateHypothesesForSymptom} but accepts a pre-computed
 * `symptomDescription` so the component-aware description from
 * {@link buildSymptomDescription} is used in the hypothesis `symptom` field.
 */
function generateHypothesesForSymptomInternal(
  symptomKey: string,
  symptomDescription: string,
  findings: Finding[],
  _context: InvestigatorContext,
): Hypothesis[] {
  if (findings.length === 0) return [];

  const symptomType = detectSymptomType(findings);

  switch (symptomType) {
    case 'crashloop':
      return generateCrashLoopHypotheses(symptomKey, symptomDescription, findings);
    case 'imagepull':
      return generateImagePullHypotheses(symptomKey, symptomDescription, findings);
    case 'not-ready':
      return generateNotReadyHypotheses(symptomKey, symptomDescription, findings);
    case 'pending':
      return generatePendingPodHypotheses(symptomKey, symptomDescription, findings);
    default:
      return generateGenericHypotheses(symptomKey, symptomDescription, findings);
  }
}
