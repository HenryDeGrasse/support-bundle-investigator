import type { Evidence } from '../types/index.js';

// ---------------------------------------------------------------------------
// HypothesisCategory
// ---------------------------------------------------------------------------

/**
 * The broad root-cause class that a hypothesis belongs to.
 *
 * - `missing-secret`       — A required Kubernetes Secret or key is absent
 * - `bad-db-endpoint`      — A database connection string or endpoint is wrong
 * - `dns-failure`          — DNS resolution is failing for a service or host
 * - `image-pull-failure`   — A container image cannot be pulled (auth, tag, registry)
 * - `config-error`         — A ConfigMap value or environment variable is misconfigured
 * - `oom-kill`             — The container was killed due to memory limits being exceeded
 * - `connectivity-failure` — A network path between services or to an external endpoint is broken
 * - `readiness-failure`    — A Pod is not passing its readiness probe
 * - `generic-crash`        — The application crashed for an unclassified reason
 * - `missing-service`      — A required Kubernetes Service is absent or has no endpoints
 */
export type HypothesisCategory =
  | 'missing-secret'
  | 'bad-db-endpoint'
  | 'dns-failure'
  | 'image-pull-failure'
  | 'config-error'
  | 'oom-kill'
  | 'connectivity-failure'
  | 'readiness-failure'
  | 'generic-crash'
  | 'missing-service';

// ---------------------------------------------------------------------------
// EvidenceAssessment
// ---------------------------------------------------------------------------

/**
 * A structured breakdown of all evidence gathered for a single hypothesis.
 *
 * - `supporting`       — Evidence items that increase confidence in the hypothesis
 * - `contradicting`    — Evidence items that lower confidence or rule out the hypothesis
 * - `missingDecisive`  — Descriptions of evidence that would be decisive but is absent,
 *                        used to drive spec-gap recommendations
 */
export interface EvidenceAssessment {
  /** Evidence items that support the hypothesis being the root cause. */
  supporting: Evidence[];
  /** Evidence items that contradict or weaken the hypothesis. */
  contradicting: Evidence[];
  /**
   * Human-readable descriptions of evidence that would decisively confirm or
   * refute the hypothesis but is not present in the bundle.
   */
  missingDecisive: string[];
}

// ---------------------------------------------------------------------------
// Hypothesis
// ---------------------------------------------------------------------------

/**
 * A single candidate root-cause hypothesis for an observed symptom.
 *
 * Each hypothesis is independently assessed with supporting, contradicting, and
 * missing evidence before a calibrated confidence score is assigned. This
 * models the differential-diagnosis pattern used by support engineers.
 */
export interface Hypothesis {
  /** Unique identifier for this hypothesis within its {@link HypothesisSet}. */
  id: string;
  /** The observed symptom string that this hypothesis attempts to explain. */
  symptom: string;
  /** Human-readable statement of the proposed root cause. */
  rootCause: string;
  /** Broad classification of the root-cause class. */
  category: HypothesisCategory;
  /** Structured evidence gathered for and against this hypothesis. */
  evidenceAssessment: EvidenceAssessment;
  /**
   * Calibrated confidence that this hypothesis is the true root cause,
   * in the range [0, 1]. Penalised when decisive evidence is missing.
   */
  confidence: number;
  /**
   * Free-text explanation of how the confidence score was derived from the
   * supporting, contradicting, and missing evidence.
   */
  confidenceRationale: string;
  /**
   * Actionable recommendations to fill evidence gaps identified in
   * {@link EvidenceAssessment.missingDecisive}. Emitted as spec-gap guidance
   * when a hypothesis cannot be confirmed or ruled out.
   */
  specGapRecommendations: string[];
  /**
   * IDs of the raw {@link Finding} objects whose evidence contributed to
   * this hypothesis.
   */
  sourceFindings: string[];
}

// ---------------------------------------------------------------------------
// HypothesisSet
// ---------------------------------------------------------------------------

/**
 * All candidate hypotheses generated for a single symptom, together with the
 * top-ranked hypothesis (or `null` when no hypothesis reaches a useful
 * confidence threshold).
 */
export interface HypothesisSet {
  /**
   * A short stable key identifying the symptom (e.g. `"pod-crashloop:api"`)
   * used for deduplication and cross-referencing.
   */
  symptomKey: string;
  /** Full human-readable description of the observed symptom. */
  symptomDescription: string;
  /**
   * All candidate hypotheses ranked from highest confidence to lowest.
   * An empty array means no hypotheses could be generated for this symptom.
   */
  hypotheses: Hypothesis[];
  /**
   * The highest-ranked hypothesis after scoring, or `null` when `hypotheses`
   * is empty.
   */
  topHypothesis: Hypothesis | null;
}

// ---------------------------------------------------------------------------
// HypothesisVerificationResult
// ---------------------------------------------------------------------------

/**
 * The top-level result produced by the hypothesis verification layer.
 *
 * Contains one {@link HypothesisSet} per unique symptom detected across the
 * bundle, together with aggregate metadata suitable for tracing and reporting.
 */
export interface HypothesisVerificationResult {
  /** One entry per unique symptom analysed. */
  hypothesisSets: HypothesisSet[];
  /** Aggregate counters for tracing and reporting. */
  metadata: {
    /** Total number of hypotheses generated across all symptom sets. */
    totalHypotheses: number;
    /** Total number of distinct symptoms that were analysed. */
    totalSymptomsAnalyzed: number;
  };
}
