import type { ArtifactCategory } from './bundle.js';

export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

/**
 * Qualitative indicator of how well-supported the confidence score is.
 *
 * - `'strong'`   — ≥3 evidence items from ≥2 distinct source types, 0 missing decisive
 * - `'moderate'` — 2 evidence items OR exactly 1 missing decisive item
 * - `'weak'`     — 1 evidence item OR ≥2 missing decisive items
 *
 * Displayed alongside the numeric percentage so the user knows whether `80%`
 * represents a well-grounded conclusion or a tentative estimate that could
 * shift significantly with additional evidence.
 */
export type ConfidenceQuality = 'strong' | 'moderate' | 'weak';

export interface Evidence {
  path: string;
  note: string;
  artifactType?: ArtifactCategory;
  timestamp?: string;
}

export interface Finding {
  id: string;
  title: string;
  severity: FindingSeverity;
  /** Confidence score in the range [0, 1] */
  confidence: number;
  affectedComponents: string[];
  reasoningSummary: string;
  evidence: Evidence[];
  contradictionsChecked: string[];
  recommendedAction: string;
  missingEvidence: string[];
  /**
   * Qualitative confidence indicator — set by the verifier after all evidence
   * has been collected and contradiction checks run.  `undefined` when the
   * finding has not yet been through the verification pass.
   */
  confidenceQuality?: ConfidenceQuality;
}
