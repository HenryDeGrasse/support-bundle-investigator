import type { Evidence } from '../types/index.js';
import type { Hypothesis } from './hypothesis-types.js';

// ---------------------------------------------------------------------------
// Scoring constants
// ---------------------------------------------------------------------------

/** Each supporting evidence item contributes this much to the base score. */
const SUPPORTING_PER_ITEM = 0.15;
/** Maximum total base score from supporting evidence alone. */
const SUPPORTING_CAP = 0.60;

/**
 * Each *specific* supporting evidence item (containing an exact diagnostic
 * signal rather than a generic status observation) adds this bonus.
 */
const SPECIFICITY_PER_ITEM = 0.15;
/** Maximum total specificity bonus. */
const SPECIFICITY_CAP = 0.30;

/** Bonus when supporting evidence spans two or more artifact types. */
const CROSS_SOURCE_BONUS = 0.10;

/** Additional bonus when supporting evidence spans three or more artifact types. */
const EVIDENCE_DIVERSITY_BONUS = 0.05;

/**
 * Bonus when supporting evidence confirms a cross-namespace service match
 * (e.g. the referenced service exists in a different namespace). This is
 * treated as confirmed root-cause evidence and deserves a large boost.
 */
const CROSS_NAMESPACE_BONUS = 0.15;

/**
 * Matches evidence notes that confirm a service exists in a different
 * namespace than the one referenced — produced by the DNS failure evidence
 * collector when a cross-namespace service is found during step-2 look-up.
 */
const CROSS_NAMESPACE_PATTERN = /exists in namespace .* \(not /i;

/** Each contradicting evidence item reduces confidence by this amount. */
const CONTRADICTION_PER_ITEM = 0.15;
/** Maximum total contradiction penalty. */
const CONTRADICTION_CAP = 0.40;

/** Each missing-decisive evidence item reduces confidence by this amount. */
const MISSING_PER_ITEM = 0.10;
/** Maximum total missing-evidence penalty. */
const MISSING_CAP = 0.30;

/**
 * When *all* supporting evidence is generic symptom-only (e.g. "pod not
 * ready" without a specific diagnostic signal), confidence is capped here to
 * prevent overconfidence from volume alone.
 */
const GENERIC_ONLY_CAP = 0.50;

/**
 * Category-specific decisive bonuses reward exact root-cause evidence more
 * than broad symptom-adjacent evidence. For example, an exact `no such host`
 * signal should outrank a generic timeout when both are present in the same
 * scenario because it narrows the diagnosis to DNS rather than connectivity.
 */
const CATEGORY_DECISIVE_BONUS: Partial<Record<Hypothesis['category'], { perItem: number; cap: number; patterns: RegExp[] }>> = {
  'dns-failure': {
    perItem: 0.07,
    cap: 0.21,
    patterns: [/no such host/i, /nxdomain/i, /lookup.*fail/i, /dns resolution failure/i],
  },
  'missing-secret': {
    perItem: 0.07,
    cap: 0.21,
    patterns: [/failedmount/i, /secret.*not\s+found/i, /referenced secret .* absent/i],
  },
  'image-pull-failure': {
    perItem: 0.07,
    cap: 0.21,
    patterns: [/errimagepull/i, /imagepullbackoff/i, /failed to pull image/i],
  },
  'readiness-failure': {
    perItem: 0.05,
    cap: 0.15,
    patterns: [/readiness probe failed/i, /unhealthy event/i, /probe.*misconfig/i],
  },
  'connectivity-failure': {
    perItem: 0.03,
    cap: 0.09,
    patterns: [/connection refused/i, /context deadline exceeded/i, /connection timed out/i, /i\/o timeout/i],
  },
};

// ---------------------------------------------------------------------------
// Helpers — evidence classification
// ---------------------------------------------------------------------------

/**
 * Patterns that indicate an evidence note carries a *specific* diagnostic
 * signal (an exact error message, error code, or resource identifier) rather
 * than a generic status observation.
 *
 * These patterns are matched against `evidence.note` case-insensitively.
 */
const SPECIFIC_PATTERNS: RegExp[] = [
  /no such host/i,
  /nxdomain/i,
  /lookup.*fail/i,
  /errimagepull/i,
  /imagepullbackoff/i,
  /failed to pull image/i,
  /back-off.*pulling image/i,
  /oomkill/i,
  /oom.*kill/i,
  /out of memory/i,
  /crashloopbackoff/i,
  /crashloop/i,
  /failedmount/i,
  /mountvolume.*failed/i,
  /secret.*not\s+found/i,
  /not\s+found.*secret/i,
  /connection refused/i,
  /context deadline exceeded/i,
  /connection timed out/i,
  /i\/o timeout/i,
  /dial tcp/i,
  /readiness probe failed/i,
  /unhealthy.*readiness/i,
  /readiness.*unhealthy/i,
  /references secret .* absent/i,
  /referenced secret .* not present/i,
  /maps to missing service/i,
  /references in-cluster hostname/i,
  /dns-related failure/i,
  /configuration error/i,
  /resource not-found error/i,
  /no endpoints resources found/i,
  /unhealthy event/i,
  /readiness probe configured/i,
  // Notes synthesised by the evidence collector often embed the raw log line
  // or event message, making them specific by nature.
  /log line show/i,
  /log line indicates/i,
  /event indicates/i,
  /waiting with reason/i,
];

/**
 * Patterns that indicate an evidence note carries only a *generic* symptom
 * observation (e.g. "pod is not ready") without a specific diagnostic signal.
 *
 * A note is considered generic only when it matches one of these patterns AND
 * does NOT match any of the {@link SPECIFIC_PATTERNS}.
 */
const GENERIC_PATTERNS: RegExp[] = [
  /pod.*not\s+ready/i,
  /running but not ready/i,
  /pod\s+is\s+unhealthy/i,
  /is\s+unhealthy/i,
  /container.*not\s+ready/i,
  /pod status/i,
];

/**
 * Returns `true` when the evidence note contains a specific diagnostic signal
 * (an exact error message, error code, or precise resource reference) rather
 * than a generic status observation.
 */
function isSpecificEvidence(evidence: Evidence): boolean {
  return SPECIFIC_PATTERNS.some((p) => p.test(evidence.note));
}

/**
 * Returns `true` when the evidence note describes only a generic symptom
 * observation (e.g. "pod is not ready") and does NOT contain any specific
 * diagnostic signal.
 */
function isGenericEvidence(evidence: Evidence): boolean {
  if (isSpecificEvidence(evidence)) return false;
  return GENERIC_PATTERNS.some((p) => p.test(evidence.note));
}

function getCategoryDecisiveBonus(hypothesis: Hypothesis): number {
  const config = CATEGORY_DECISIVE_BONUS[hypothesis.category];
  if (config == null) return 0;

  const matchCount = hypothesis.evidenceAssessment.supporting.filter((evidence) =>
    config.patterns.some((pattern) => pattern.test(evidence.note)),
  ).length;

  return Math.min(matchCount * config.perItem, config.cap);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Computes a calibrated confidence score in **[0, 1]** for a single
 * hypothesis based on its evidence assessment.
 *
 * The score is derived from:
 * 1. **Base** — `min(n_supporting × 0.15, 0.60)`.
 * 2. **Specificity bonus** — up to `+0.30` when evidence notes contain exact
 *    diagnostic signals (e.g., `"no such host"`, `"ErrImagePull"`).
 * 3. **Cross-source bonus** — `+0.10` when supporting evidence spans two or
 *    more artifact types (e.g., `log` + `kubernetes-resource`).
 * 4. **Evidence diversity bonus** — additional `+0.05` when supporting
 *    evidence spans three or more distinct artifact types.
 * 5. **Cross-namespace corroboration bonus** — `+0.15` when any supporting
 *    evidence note confirms a cross-namespace service match (confirmed root
 *    cause; pattern: `/exists in namespace .* \(not /i`).
 * 6. **Contradiction penalty** — `min(n_contradicting × 0.15, 0.40)`.
 * 7. **Missing decisive penalty** — `min(n_missing × 0.10, 0.30)`.
 * 8. **Generic-only cap** — if every supporting item is a generic symptom
 *    observation (no specific signal), the final score is capped at `0.50`.
 *
 * The result is always clamped to `[0, 1]`.
 */
export function scoreHypothesis(hypothesis: Hypothesis): number {
  const { supporting, contradicting, missingDecisive } = hypothesis.evidenceAssessment;

  // 1. Base score from supporting evidence count
  const baseScore = Math.min(supporting.length * SUPPORTING_PER_ITEM, SUPPORTING_CAP);

  // 2. Specificity bonus
  const specificCount = supporting.filter(isSpecificEvidence).length;
  const specificityBonus = Math.min(specificCount * SPECIFICITY_PER_ITEM, SPECIFICITY_CAP);
  const categoryDecisiveBonus = getCategoryDecisiveBonus(hypothesis);

  // 3. Cross-source bonus (requires 2+ distinct non-null artifact types)
  const artifactTypes = new Set(
    supporting.map((e) => e.artifactType).filter((t): t is NonNullable<typeof t> => t != null),
  );
  const crossSourceBonus = artifactTypes.size >= 2 ? CROSS_SOURCE_BONUS : 0.0;

  // 4. Evidence diversity bonus: additional +0.05 for 3+ distinct artifact types
  const diversityBonus = artifactTypes.size >= 3 ? EVIDENCE_DIVERSITY_BONUS : 0.0;

  // 5. Cross-namespace corroboration bonus: +0.15 when any supporting evidence
  //    note confirms a cross-namespace service match (confirmed root cause)
  const hasCrossNamespace = supporting.some((e) => CROSS_NAMESPACE_PATTERN.test(e.note));
  const crossNamespaceBonus = hasCrossNamespace ? CROSS_NAMESPACE_BONUS : 0.0;

  // 6. Contradiction penalty
  const contradictionPenalty = Math.min(
    contradicting.length * CONTRADICTION_PER_ITEM,
    CONTRADICTION_CAP,
  );

  // 7. Missing decisive evidence penalty
  const missingPenalty = Math.min(missingDecisive.length * MISSING_PER_ITEM, MISSING_CAP);

  // 8. Raw score
  let score =
    baseScore +
    specificityBonus +
    categoryDecisiveBonus +
    crossSourceBonus +
    diversityBonus +
    crossNamespaceBonus -
    contradictionPenalty -
    missingPenalty;

  // 9. Evidence sufficiency floor — cap generic-only hypotheses at GENERIC_ONLY_CAP
  const hasSupporting = supporting.length > 0;
  const allGeneric = hasSupporting && supporting.every((e) => isGenericEvidence(e));
  if (allGeneric) {
    score = Math.min(score, GENERIC_ONLY_CAP);
  }

  // 10. Clamp to [0, 1] and round away floating-point noise so calibrated
  // confidence thresholds remain stable in tests and downstream ranking.
  const clamped = Math.max(0.0, Math.min(1.0, score));
  return Math.round(clamped * 10000) / 10000;
}

/**
 * Returns a human-readable explanation of how the confidence score was
 * derived from the hypothesis's evidence assessment.
 *
 * The rationale mentions: supporting item count, specificity signals, cross-
 * source diversity, contradiction count, missing-evidence count, and the
 * generic-only cap when applicable.
 */
export function buildConfidenceRationale(hypothesis: Hypothesis): string {
  const { supporting, contradicting, missingDecisive } = hypothesis.evidenceAssessment;
  const score = scoreHypothesis(hypothesis);

  const parts: string[] = [];

  if (supporting.length === 0) {
    parts.push('no supporting evidence found');
  } else {
    const n = supporting.length;
    parts.push(`${n} supporting evidence item${n === 1 ? '' : 's'}`);

    const specificCount = supporting.filter(isSpecificEvidence).length;
    if (specificCount > 0) {
      parts.push(
        `${specificCount} specific diagnostic signal${specificCount === 1 ? '' : 's'} (exact error / code)`,
      );
    }

    const decisiveBonus = getCategoryDecisiveBonus(hypothesis);
    if (decisiveBonus > 0) {
      parts.push(`category-specific decisive evidence bonus (+${decisiveBonus.toFixed(2)})`);
    }

    const artifactTypes = new Set(
      supporting.map((e) => e.artifactType).filter((t): t is NonNullable<typeof t> => t != null),
    );
    if (artifactTypes.size >= 2) {
      const typeList = [...artifactTypes].join(', ');
      parts.push(`cross-source evidence from ${typeList}`);
    }
    if (artifactTypes.size >= 3) {
      parts.push(`evidence diversity bonus (+${EVIDENCE_DIVERSITY_BONUS.toFixed(2)}) — ${artifactTypes.size} distinct artifact types`);
    }

    const hasCrossNamespace = supporting.some((e) => CROSS_NAMESPACE_PATTERN.test(e.note));
    if (hasCrossNamespace) {
      parts.push(`cross-namespace corroboration bonus (+${CROSS_NAMESPACE_BONUS.toFixed(2)}) — service confirmed in different namespace`);
    }
  }

  if (contradicting.length > 0) {
    const n = contradicting.length;
    parts.push(`${n} contradicting item${n === 1 ? '' : 's'} reducing confidence`);
  }

  if (missingDecisive.length > 0) {
    const n = missingDecisive.length;
    parts.push(`${n} missing decisive evidence item${n === 1 ? '' : 's'} limiting confidence`);
  }

  const hasSupporting = supporting.length > 0;
  const allGeneric = hasSupporting && supporting.every((e) => isGenericEvidence(e));
  if (allGeneric) {
    parts.push(`confidence capped at ${GENERIC_ONLY_CAP.toFixed(2)} — only generic symptom evidence available`);
  }

  const scoreStr = score.toFixed(2);
  return `Confidence ${scoreStr}: ${parts.join('; ')}.`;
}

/**
 * Scores and ranks an array of hypotheses by confidence (descending), and
 * updates each hypothesis's `confidence` and `confidenceRationale` fields
 * with freshly computed values.
 *
 * Returns a **new** array of hypothesis objects — the input array and its
 * objects are not mutated.
 */
export function rankHypotheses(hypotheses: Hypothesis[]): Hypothesis[] {
  const scored = hypotheses.map((h) => ({
    ...h,
    confidence: scoreHypothesis(h),
    confidenceRationale: buildConfidenceRationale(h),
  }));
  return scored.sort((a, b) => b.confidence - a.confidence);
}

/**
 * Identifies bundle spec-gap recommendations for a hypothesis when missing
 * decisive evidence prevents the hypothesis from being confirmed or ruled out.
 *
 * Each entry in `evidenceAssessment.missingDecisive` is transformed into an
 * actionable spec-gap recommendation suitable for inclusion in
 * {@link Hypothesis.specGapRecommendations}.
 *
 * Returns an **empty array** when no decisive evidence is missing.
 */
export function identifySpecGaps(hypothesis: Hypothesis): string[] {
  const { missingDecisive } = hypothesis.evidenceAssessment;
  if (missingDecisive.length === 0) return [];

  return missingDecisive.map(
    (gap) => `Spec gap [${hypothesis.category}]: ${gap}`,
  );
}
