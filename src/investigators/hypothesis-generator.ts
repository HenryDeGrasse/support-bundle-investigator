import type { Evidence, Finding, FindingSeverity } from '../types/index.js';
import type { InvestigatorContext } from './types.js';
import type {
  EvidenceAssessment,
  Hypothesis,
  HypothesisCategory,
  HypothesisSet,
} from './hypothesis-types.js';
import { matchTemplate } from './hypothesis-templates.js';
import type { EvidenceRule, HypothesisTemplate } from './hypothesis-templates.js';

// ---------------------------------------------------------------------------
// Helpers — symptom detection (now template-driven)
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
 * Finds the matching template for a group of findings by building a combined
 * text corpus and matching against the template registry.
 */
function detectTemplate(findings: Finding[]): HypothesisTemplate {
  for (const finding of findings) {
    const corpus = findingTextCorpus(finding);
    const template = matchTemplate(corpus);
    // If we got a non-generic match, use it immediately (first match wins)
    if (template.id !== 'generic') {
      return template;
    }
  }
  // No specific match found — return the generic fallback
  return matchTemplate('');
}

// ---------------------------------------------------------------------------
// Helpers — symptom key / description derivation (template-driven)
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
 * Builds a concise, stable symptom key from a component identifier and
 * the matched template.
 *
 * Format: `{symptomKeyPrefix}:{namespace}/{name}` or `{symptomKeyPrefix}:{name}`,
 * e.g. `pod-crashloop:default/app-pod`.
 */
function buildSymptomKey(componentKey: string, template: HypothesisTemplate): string {
  // Extract the meaningful suffix from a component path like "Pod/default/app-pod"
  const slashIdx = componentKey.indexOf('/');
  const suffix = slashIdx !== -1 ? componentKey.slice(slashIdx + 1) : componentKey;
  return `${template.symptomKeyPrefix}:${suffix}`;
}

/**
 * Builds a human-readable description of the symptom using the template's
 * description template string with placeholder substitution.
 */
function buildSymptomDescription(
  componentKey: string,
  template: HypothesisTemplate,
  findings: Finding[],
): string {
  // Try to parse "Kind/namespace/name" → namespace + name
  const parts = componentKey.split('/');
  const name = parts[parts.length - 1] ?? componentKey;
  const namespace = parts.length >= 3 ? parts[parts.length - 2] : 'unknown';

  const descTemplate = template.symptomDescriptionTemplate;

  // For the generic template, the {title} placeholder falls back to finding title
  if (descTemplate === '{title}') {
    return findings[0]?.title ?? componentKey;
  }

  return descTemplate
    .replace(/\{name\}/g, name)
    .replace(/\{namespace\}/g, namespace);
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
// Helpers — hypothesis builder (template-driven)
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
  evidenceRules?: EvidenceRule[],
): Hypothesis {
  return {
    id,
    symptom,
    rootCause,
    category,
    evidenceAssessment: emptyEvidenceAssessment(),
    evidenceRules,
    confidence: 0.0,
    confidenceRationale: 'Not yet scored',
    specGapRecommendations: [],
    sourceFindings,
  };
}

/**
 * Generates hypotheses from a matched template.
 *
 * This single function replaces all the per-symptom procedural generator
 * functions (generateCrashLoopHypotheses, generateImagePullHypotheses, etc.).
 * The template data drives hypothesis construction — no code changes needed
 * to add new symptom types.
 */
function generateHypothesesFromTemplateData(
  template: HypothesisTemplate,
  symptomKey: string,
  symptomDescription: string,
  findings: Finding[],
): Hypothesis[] {
  const sourceIds = findings.map((f) => f.id);
  // For the generic template, de-duplicate source IDs
  const ids = template.id === 'generic'
    ? Array.from(new Set(sourceIds))
    : sourceIds;

  return template.hypotheses.map((def) =>
    buildHypothesis(
      `${symptomKey}:${def.idSuffix}`,
      symptomDescription,
      def.rootCause,
      def.category,
      ids,
      def.evidenceRules,
    ),
  );
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
    // Skip findings whose primary component is a Service, Endpoints, or other
    // non-workload resource.  Hypothesis templates (crashloop, not-ready,
    // pending, imagepull) are all Pod-centric.  Allowing e.g. a
    // "Service has 0 ready endpoints" finding to enter the hypothesis pipeline
    // produces a false "pod-not-ready:default/web-app-service" symptom key
    // because "0 ready endpoints" matches the "not ready" template.
    const key = primaryComponentKey(finding);
    if (/^(Service|Endpoints|EndpointSlice|ConfigMap|Secret)\//.test(key)) {
      continue;
    }

    const group = groups.get(key) ?? [];
    group.push(finding);
    groups.set(key, group);
  }

  return groups;
}

/**
 * Generates all competing hypotheses for a single symptom group.
 *
 * Uses the declarative template registry to select the matching template and
 * generate hypothesis candidates. Each hypothesis starts with
 * `confidence: 0.0` and empty evidence assessments — the scorer (step 4)
 * will fill these in after the evidence collector (step 3) runs.
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

  const template = detectTemplate(findings);

  // Build the description from the first finding when the key is external
  // (called directly from tests); for internal use, buildSymptomDescription
  // provides a richer version derived from the component key.
  const symptomDescription = findings[0]?.title ?? symptomKey;

  return generateHypothesesFromTemplateData(template, symptomKey, symptomDescription, findings);
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
  _context: InvestigatorContext,
): HypothesisSet[] {
  if (findings.length === 0) return [];

  const groups = groupFindingsBySymptom(findings);
  const sets: HypothesisSet[] = [];

  for (const [componentKey, groupFindings] of groups) {
    const template = detectTemplate(groupFindings);
    const symptomKey = buildSymptomKey(componentKey, template);
    const symptomDescription = buildSymptomDescription(
      componentKey,
      template,
      groupFindings,
    );

    // Generate hypotheses using the matched template data
    const hypotheses = generateHypothesesFromTemplateData(
      template,
      symptomKey,
      symptomDescription,
      groupFindings,
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
// Cross-symptom hypothesis correlation (7.5)
// ---------------------------------------------------------------------------

/**
 * Minimum number of symptom sets that must converge on the same root-cause
 * category and namespace before a cluster-wide meta-finding is emitted.
 */
const MIN_CONVERGENCE_COUNT = 2;

/**
 * Confidence boost applied per additional converging symptom set beyond the
 * first. Capped at {@link MAX_CONVERGENCE_BOOST}.
 *
 * With `CONVERGENCE_BOOST_PER_SET = 0.08`:
 * - 2 sets → +0.08
 * - 3 sets → +0.16
 * - 4 sets → +0.24
 * - 5+ sets → capped at +0.25
 */
const CONVERGENCE_BOOST_PER_SET = 0.08;

/** Maximum total confidence boost applied by convergence. */
const MAX_CONVERGENCE_BOOST = 0.25;

/**
 * Human-readable label for each hypothesis category, used in meta-finding
 * titles produced by {@link correlateAcrossSymptoms}.
 */
const CATEGORY_READABLE: Record<HypothesisCategory, string> = {
  'dns-failure': 'DNS failure',
  'missing-secret': 'missing secret',
  'config-error': 'configuration error',
  'oom-kill': 'OOM kill',
  'image-pull-failure': 'image pull failure',
  'connectivity-failure': 'connectivity failure',
  'bad-db-endpoint': 'bad database endpoint',
  'readiness-failure': 'readiness probe failure',
  'generic-crash': 'application crash',
  'missing-service': 'missing service',
  'volume-mount-failure': 'volume mount failure',
};

/**
 * Base severity for each hypothesis category, reflected in cluster-wide
 * meta-findings produced by {@link correlateAcrossSymptoms}.
 */
const META_SEVERITY_BY_CATEGORY: Record<HypothesisCategory, FindingSeverity> = {
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
 * Recommended actions for cluster-wide meta-findings, tailored to namespace-
 * scope investigation.
 */
const META_RECOMMENDED_ACTION: Record<HypothesisCategory, string> = {
  'dns-failure':
    'Investigate namespace-wide DNS resolution. Check CoreDNS pod logs (`kubectl logs -n kube-system -l k8s-app=kube-dns`), verify Service resources exist for all referenced hostnames, and confirm kube-dns ConfigMap is correct.',
  'missing-secret':
    'A shared Secret is missing or was deleted from this namespace. Check `kubectl get secrets -n <namespace>` and verify the Secret is defined in the deployment manifest or Helm chart.',
  'config-error':
    'A shared ConfigMap or environment variable is misconfigured in this namespace. Review all ConfigMap data and Pod environment variable references for incorrect or missing values.',
  'oom-kill':
    'Multiple pods are being OOM-killed. Review container memory limits for pods in this namespace. Consider increasing memory limits or profiling application memory usage.',
  'image-pull-failure':
    'Multiple pods cannot pull their container images. Verify imagePullSecrets, registry credentials, and image tag availability for all affected pods in this namespace.',
  'connectivity-failure':
    'Multiple pods are experiencing connectivity failures. Check NetworkPolicy resources, Endpoints health, and network infrastructure for this namespace.',
  'bad-db-endpoint':
    'Multiple pods cannot reach the database endpoint. Verify the connection string, hostname resolution, and database service availability in this namespace.',
  'readiness-failure':
    'Multiple pods are failing readiness probes. Review readiness probe configuration (port, path, timing) and application startup dependencies shared across pods in this namespace.',
  'generic-crash':
    'Multiple pods are crashing. Review application logs across all affected pods to identify a shared root cause (shared library, shared ConfigMap, shared dependency).',
  'missing-service':
    'Multiple pods reference a missing Service. Verify that the required Service is defined in this namespace and that its selector matches the correct pod labels.',
  'volume-mount-failure':
    'Multiple pods cannot mount their volumes. Check PVC status (`kubectl get pvc -n <namespace>`), StorageClass availability, and storage provisioner health in this namespace.',
};

/**
 * Extracts the namespace portion from a symptom key.
 *
 * Symptom keys have the format `{symptom-type}:{namespace}/{name}`, e.g.
 * `"pod-crashloop:default/app-pod"`. Returns `null` when the key does not
 * include a namespace/name pair (no slash after the colon).
 */
function extractNamespaceFromSymptomKey(symptomKey: string): string | null {
  const colonIdx = symptomKey.indexOf(':');
  if (colonIdx === -1) return null;
  const suffix = symptomKey.slice(colonIdx + 1); // e.g. "default/app-pod"
  const slashIdx = suffix.indexOf('/');
  if (slashIdx === -1) return null;
  return suffix.slice(0, slashIdx); // e.g. "default"
}

/**
 * Extracts the resource-name portion from a symptom key.
 *
 * Returns the segment after the namespace separator, or the full suffix when
 * no namespace is present.
 */
function extractNameFromSymptomKey(symptomKey: string): string {
  const colonIdx = symptomKey.indexOf(':');
  if (colonIdx === -1) return symptomKey;
  const suffix = symptomKey.slice(colonIdx + 1); // e.g. "default/app-pod"
  const slashIdx = suffix.indexOf('/');
  if (slashIdx === -1) return suffix;
  return suffix.slice(slashIdx + 1); // e.g. "app-pod"
}

/**
 * Detects when N symptom groups converge on the same root-cause category in
 * the same namespace and produces a cluster-wide meta-finding for each such
 * convergence.
 *
 * A convergence group is formed when two or more {@link HypothesisSet}s with
 * a non-null, positive-confidence `topHypothesis` share the same
 * `topHypothesis.category` **and** belong to the same Kubernetes namespace
 * (extracted from the `symptomKey`).
 *
 * The meta-finding's confidence is boosted proportionally to the number of
 * converging symptom groups: each additional set beyond the first adds
 * {@link CONVERGENCE_BOOST_PER_SET} to the base confidence (the average of
 * the individual top-hypothesis confidences), capped at 1.0.
 *
 * @param hypothesisSets - Scored hypothesis sets (from the hypothesis layer,
 *   after ranking). Sets without a `topHypothesis` or with zero confidence
 *   are ignored.
 * @returns An array of meta-findings — one per convergence group — ready to
 *   merge into the final finding list. Returns an empty array when no
 *   convergence is detected.
 */
export function correlateAcrossSymptoms(hypothesisSets: HypothesisSet[]): Finding[] {
  // ── 1. Filter to only scored sets ────────────────────────────────────────
  const scoredSets = hypothesisSets.filter(
    (s) => s.topHypothesis !== null && s.topHypothesis.confidence > 0,
  );

  if (scoredSets.length < MIN_CONVERGENCE_COUNT) return [];

  // ── 2. Group by (namespace, category) ────────────────────────────────────
  const groups = new Map<
    string,
    { namespace: string; category: HypothesisCategory; sets: HypothesisSet[] }
  >();

  for (const set of scoredSets) {
    const namespace = extractNamespaceFromSymptomKey(set.symptomKey);
    if (namespace === null) continue; // Cannot determine namespace — skip

    const category = set.topHypothesis!.category;
    const key = `${namespace}::${category}`;

    const existing = groups.get(key);
    if (existing !== undefined) {
      existing.sets.push(set);
    } else {
      groups.set(key, { namespace, category, sets: [set] });
    }
  }

  // ── 3. Emit a meta-finding for each convergence group ────────────────────
  const metaFindings: Finding[] = [];
  let counter = 0;

  for (const { namespace, category, sets } of groups.values()) {
    if (sets.length < MIN_CONVERGENCE_COUNT) continue;

    const count = sets.length;

    // Compute boosted confidence from the average of individual top hypotheses
    const avgConfidence =
      sets.reduce((sum, s) => sum + s.topHypothesis!.confidence, 0) / count;
    const boost = Math.min(MAX_CONVERGENCE_BOOST, (count - 1) * CONVERGENCE_BOOST_PER_SET);
    const finalConfidence =
      Math.round(Math.min(1.0, avgConfidence + boost) * 10_000) / 10_000;

    // Collect affected pod components (deduplicated)
    const affectedComponents: string[] = [];
    const evidenceItems: Evidence[] = [];

    for (const set of sets) {
      const podName = extractNameFromSymptomKey(set.symptomKey);
      const podComponent = `Pod/${namespace}/${podName}`;
      if (!affectedComponents.includes(podComponent)) {
        affectedComponents.push(podComponent);
      }
      evidenceItems.push({
        path: set.symptomKey,
        note: set.symptomDescription,
        artifactType: 'kubernetes-resource',
      });
    }

    const readableCategory = CATEGORY_READABLE[category] ?? category;
    counter += 1;

    metaFindings.push({
      id: `finding:meta:cluster-wide:${category}:${namespace}:${counter}`,
      title: `Cluster-wide ${readableCategory} affecting ${count} pods in namespace '${namespace}'`,
      severity: META_SEVERITY_BY_CATEGORY[category] ?? 'medium',
      confidence: finalConfidence,
      affectedComponents,
      reasoningSummary:
        `${count} pods in namespace '${namespace}' independently converge on the same root cause: ` +
        `${readableCategory}. Cross-symptom convergence across ${count} independent symptom groups ` +
        `significantly increases diagnostic confidence (base avg: ${Math.round(avgConfidence * 100)}%, ` +
        `convergence boost: +${Math.round(boost * 100)}%). ` +
        `Investigate a namespace-level ${readableCategory} condition shared by all affected pods.`,
      evidence: evidenceItems,
      contradictionsChecked: [
        `No cross-namespace contradictions found — all ${count} affected pods are in namespace '${namespace}'`,
      ],
      recommendedAction:
        META_RECOMMENDED_ACTION[category] ??
        `Investigate the cluster-wide ${readableCategory} condition affecting all pods in namespace '${namespace}'.`,
      missingEvidence: [],
    });
  }

  return metaFindings;
}
