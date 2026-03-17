// ---------------------------------------------------------------------------
// AI Finding schemas and validation
// ---------------------------------------------------------------------------
//
// Defines the `AIFinding` type that mirrors the existing `Finding` interface
// with AI-specific additions (`rootCauseClass`, `counterevidence`).
//
// `validateAIFindings` sanitises raw LLM output: required fields are checked,
// confidence is clamped to [0, 1], severity is validated, and each finding
// must retain at least one citeable evidence reference with a non-empty path.
// Invalid findings are dropped with a console.warn — never thrown — so the
// pipeline always degrades gracefully.

import type { FindingSeverity } from '../types/index.js';

// ---------------------------------------------------------------------------
// AIFindingEvidence
// ---------------------------------------------------------------------------

/**
 * A single evidence item produced by the LLM.
 *
 * `path` must reference a source path from the context chunks provided to the
 * LLM. `lineRange`, when present, is a [startLine, endLine] tuple.
 */
export interface AIFindingEvidence {
  /** File path inside the support bundle (must be non-empty). */
  path: string;
  /** Specific detail from the file that supports the finding. */
  note: string;
  /** Optional line range within the file. */
  lineRange?: [number, number];
}

// ---------------------------------------------------------------------------
// AIFinding
// ---------------------------------------------------------------------------

/**
 * Structured finding produced by the LLM investigation step.
 *
 * Matches the shape of the existing {@link Finding} interface so it can be
 * merged into the heuristic pipeline without structural changes, with two
 * AI-specific optional additions: `rootCauseClass` and `counterevidence`.
 */
export interface AIFinding {
  title: string;
  severity: FindingSeverity;
  /** Confidence in [0, 1]. Clamped during validation. */
  confidence: number;
  affectedComponents: string[];
  reasoningSummary: string;
  evidence: AIFindingEvidence[];
  contradictionsChecked: string[];
  recommendedAction: string;
  missingEvidence: string[];
  /** Optional classification of the root-cause class (e.g. 'crashloop'). */
  rootCauseClass?: string;
  /** Optional list of evidence items that partially contradict this finding. */
  counterevidence?: string[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const VALID_SEVERITIES: ReadonlySet<string> = new Set<string>([
  'critical',
  'high',
  'medium',
  'low',
  'info',
]);

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && !isNaN(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function clampConfidence(confidence: number): number {
  return Math.min(1, Math.max(0, confidence));
}

// ---------------------------------------------------------------------------
// Evidence validation
// ---------------------------------------------------------------------------

function validateEvidence(rawEvidence: unknown[]): AIFindingEvidence[] {
  return rawEvidence
    .filter(isRecord)
    .filter((item) => isString(item['path']) && (item['path'] as string).trim().length > 0)
    .map((item): AIFindingEvidence => {
      const evidence: AIFindingEvidence = {
        path: (item['path'] as string).trim(),
        note: isString(item['note']) ? item['note'].trim() : '',
      };

      // Validate lineRange: must be a 2-element array of finite numbers with
      // a forward, deterministic span.
      const lr = item['lineRange'];
      if (
        Array.isArray(lr) &&
        lr.length === 2 &&
        isNumber(lr[0]) &&
        isNumber(lr[1]) &&
        Number.isInteger(lr[0]) &&
        Number.isInteger(lr[1]) &&
        lr[0] >= 1 &&
        lr[1] >= lr[0]
      ) {
        evidence.lineRange = [lr[0] as number, lr[1] as number];
      }

      return evidence;
    });
}

// ---------------------------------------------------------------------------
// Single finding validation
// ---------------------------------------------------------------------------

function validateSingleFinding(
  raw: Record<string, unknown>,
  index: number,
): AIFinding | null {
  const { title, severity, confidence, reasoningSummary, recommendedAction } = raw;

  if (!isString(title) || title.trim().length === 0) {
    console.warn(
      `[validateAIFindings] Finding at index ${index} missing or empty 'title' — dropped`,
    );
    return null;
  }

  if (!isString(severity) || !VALID_SEVERITIES.has(severity)) {
    console.warn(
      `[validateAIFindings] Finding at index ${index} has invalid 'severity' '${String(severity)}' — dropped`,
    );
    return null;
  }

  if (!isNumber(confidence)) {
    console.warn(
      `[validateAIFindings] Finding at index ${index} has non-numeric 'confidence' — dropped`,
    );
    return null;
  }

  if (!isString(reasoningSummary)) {
    console.warn(
      `[validateAIFindings] Finding at index ${index} missing 'reasoningSummary' — dropped`,
    );
    return null;
  }

  if (!isString(recommendedAction)) {
    console.warn(
      `[validateAIFindings] Finding at index ${index} missing 'recommendedAction' — dropped`,
    );
    return null;
  }

  const evidence = validateEvidence(getArray(raw['evidence']));
  if (evidence.length === 0) {
    console.warn(
      `[validateAIFindings] Finding at index ${index} has no citeable evidence — dropped`,
    );
    return null;
  }

  const finding: AIFinding = {
    title: title.trim(),
    severity: severity as FindingSeverity,
    confidence: clampConfidence(confidence),
    affectedComponents: getArray(raw['affectedComponents']).filter(isString),
    reasoningSummary,
    evidence,
    contradictionsChecked: getArray(raw['contradictionsChecked']).filter(isString),
    recommendedAction,
    missingEvidence: getArray(raw['missingEvidence']).filter(isString),
  };

  // Optional: rootCauseClass
  if (isString(raw['rootCauseClass']) && raw['rootCauseClass'].trim().length > 0) {
    finding.rootCauseClass = raw['rootCauseClass'].trim();
  }

  // Optional: counterevidence — only include when non-empty
  const counterevidence = getArray(raw['counterevidence']).filter(isString);
  if (counterevidence.length > 0) {
    finding.counterevidence = counterevidence;
  }

  return finding;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validates and sanitises a raw `unknown` value from LLM output into a typed
 * {@link AIFinding}[] array.
 *
 * Validation rules:
 * - Input must be an array (non-array returns []).
 * - Each item must be a plain object.
 * - Required fields: `title` (non-empty string), `severity` (valid
 *   FindingSeverity), `confidence` (number), `reasoningSummary` (string),
 *   `recommendedAction` (string).
 * - `confidence` is clamped to [0, 1].
 * - Findings must retain at least one citeable `evidence` item after
 *   sanitisation; otherwise they are dropped.
 * - `evidence` items with empty/missing `path` are dropped.
 * - Invalid `lineRange` values are silently omitted.
 * - Optional string arrays default to [].
 * - Non-string items in string arrays are filtered out.
 * - Invalid findings are dropped with a `console.warn`, never thrown.
 */
export function validateAIFindings(raw: unknown): AIFinding[] {
  if (!Array.isArray(raw)) {
    if (raw !== undefined && raw !== null) {
      console.warn(
        `[validateAIFindings] Expected array, got ${typeof raw} — returning empty`,
      );
    }
    return [];
  }

  const findings: AIFinding[] = [];

  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!isRecord(item)) {
      console.warn(
        `[validateAIFindings] Item at index ${i} is not an object — dropped`,
      );
      continue;
    }

    const finding = validateSingleFinding(item, i);
    if (finding !== null) {
      findings.push(finding);
    }
  }

  return findings;
}
