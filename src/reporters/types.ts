import type { Finding } from '../types/index.js';
import type { AIRunSummary } from '../ai/telemetry.js';

// ---------------------------------------------------------------------------
// SpecRecommendation
// ---------------------------------------------------------------------------

/**
 * A recommendation to improve the support bundle specification, generated
 * from evidence gaps and heuristic findings discovered during investigation.
 *
 * - `collector`  — suggests adding or expanding a data collector so future
 *                  bundles contain the missing artifact class.
 * - `analyzer`   — suggests adding a deterministic analyzer to replace a
 *                  heuristic finding (improves precision and repeatability).
 * - `redaction`  — suggests adding a redaction rule when sensitive data paths
 *                  appear in evidence but no existing rule covers them.
 */
export type SpecRecommendationType = 'collector' | 'analyzer' | 'redaction';

export interface SpecRecommendation {
  /** The category of spec improvement being suggested. */
  type: SpecRecommendationType;
  /**
   * Human-readable description of the recommended spec change.
   * Should be concise and actionable (one or two sentences).
   */
  description: string;
  /**
   * Explanation of why this recommendation was generated — which evidence gap
   * or heuristic finding triggered it, so the suggestion is traceable.
   */
  rationale: string;
}

// ---------------------------------------------------------------------------
// ReportOptions
// ---------------------------------------------------------------------------

export type ReportFormat = 'markdown' | 'html' | 'json';

/**
 * Configuration options controlling how a report is written to disk.
 *
 * - `format`        — output format (default: `'markdown'`)
 * - `outputDir`     — directory where the report file will be written
 *                     (default: current working directory)
 * - `includeTrace`  — when `true`, the full investigation trace is appended
 *                     as a separate section / field in the report
 */
export interface ReportOptions {
  format?: ReportFormat;
  outputDir?: string;
  includeTrace?: boolean;
}

// ---------------------------------------------------------------------------
// InvestigationReport
// ---------------------------------------------------------------------------

/**
 * The top-level output of the reporting layer.
 *
 * All fields are serialisation-safe (no class instances, no functions) so the
 * report can be written to JSON, Markdown, or HTML without transformation.
 */
export interface InvestigationReport {
  /**
   * High-level narrative written for a human reader — typically 2–4 sentences
   * summarising the most critical finding, the overall confidence, and the
   * recommended immediate action.
   */
  executiveSummary: string;

  /**
   * Verified, deduplicated findings sorted by severity then confidence
   * (highest first).  This is the primary payload for report consumers.
   */
  findings: Finding[];

  /**
   * The single most likely root cause for the observed symptoms.  Derived
   * from the highest-ranked finding; may be `null` when no findings exist.
   */
  rootCause: string | null;

  /**
   * Flat list of all evidence references cited across every finding, with
   * duplicates removed.  Useful for report sections that list all touched
   * files in one place.
   */
  evidenceReferences: Array<{ path: string; note: string }>;

  /**
   * Union of `contradictionsChecked` strings across all findings, with
   * duplicates removed.  Surfaces the "what we checked and ruled out"
   * narrative for the reader.
   */
  contradictions: string[];

  /**
   * Consolidated recommended next steps drawn from `recommendedAction` on
   * every finding (highest-severity first).  Duplicates are removed.
   */
  nextSteps: string[];

  /**
   * Union of `missingEvidence` strings across all findings, with duplicates
   * removed.  Tells the reader what additional data would improve confidence.
   */
  missingEvidence: string[];

  /**
   * Suggestions for improving the support bundle spec — collectors, analyzers,
   * or redaction rules that should be added to prevent evidence gaps in future
   * bundles.  Empty when the investigation found sufficient coverage.
   */
  specRecommendations: SpecRecommendation[];

  /** Summary of AI model usage, latency, and token/cost telemetry for this run. */
  aiSummary?: AIRunSummary;
}
