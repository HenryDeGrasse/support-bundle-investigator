import type { PipelineResult } from '../pipeline/analyze.js';
import type { Finding } from '../types/index.js';
import type { InvestigationReport } from './types.js';
import { generateSpecRecommendations } from './spec-recommender.js';
import { cleanEvidencePath, humanizeTitle } from './display-helpers.js';

// ---------------------------------------------------------------------------
// AI finding helpers
// ---------------------------------------------------------------------------

/**
 * Returns `true` when a finding was produced by the AI investigator.
 *
 * AI findings carry IDs prefixed with `finding:ai:`, assigned by
 * `convertAIFindings` in the AI investigator.
 */
export function isAIFinding(finding: Finding): boolean {
  return finding.id.startsWith('finding:ai:');
}

/**
 * Returns the number of distinct `artifactType` values across all evidence
 * items in a finding.
 *
 * A value of 2 or more means the finding corroborates evidence from at least
 * two different artifact categories (e.g., log + kubernetes-resource), which
 * indicates cross-source correlation.
 */
function countDistinctArtifactTypes(finding: Finding): number {
  const types = new Set<string>();
  for (const ev of finding.evidence) {
    if (ev.artifactType !== undefined && ev.artifactType.trim().length > 0) {
      types.add(ev.artifactType);
    }
  }
  return types.size;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Generates a concise, human-readable executive summary from the ranked list
 * of findings and the bundle profile.
 *
 * When no findings are present the summary states that no significant issues
 * were detected.  When findings are present the summary names the top finding,
 * states the overall count and highest severity level, and quotes the
 * recommended action so a reader can act immediately.
 *
 * When AI-augmented findings are present, the summary appends a sentence
 * noting AI analysis was used along with the count of AI findings.
 */
function generateExecutiveSummary(findings: Finding[]): string {
  if (findings.length === 0) {
    return (
      'No significant issues were identified in this support bundle. ' +
      'All investigated conditions appear normal.'
    );
  }

  const topFinding = findings[0]!;
  const criticalCount = findings.filter((f) => f.severity === 'critical').length;
  const highCount = findings.filter((f) => f.severity === 'high').length;

  const severitySummary =
    criticalCount > 0
      ? `${criticalCount} critical issue${criticalCount > 1 ? 's' : ''} require${criticalCount === 1 ? 's' : ''} immediate attention.`
      : highCount > 0
        ? `${highCount} high-severity issue${highCount > 1 ? 's' : ''} ${highCount === 1 ? 'was' : 'were'} found.`
        : '';

  const confidencePct = Math.round(topFinding.confidence * 100);

  const aiFindings = findings.filter(isAIFinding);
  const aiFindingCount = aiFindings.length;
  const crossSourceAIFindingCount = aiFindings.filter(
    (finding) => countDistinctArtifactTypes(finding) >= 2,
  ).length;
  const aiNote =
    aiFindingCount > 0
      ? crossSourceAIFindingCount > 0
        ? `AI-augmented analysis contributed ${aiFindingCount} finding${aiFindingCount > 1 ? 's' : ''}, including ${crossSourceAIFindingCount} with cross-source evidence correlation.`
        : `AI-augmented analysis contributed ${aiFindingCount} finding${aiFindingCount > 1 ? 's' : ''}.`
      : '';

  return [
    `Investigation identified ${findings.length} finding${findings.length > 1 ? 's' : ''}.`,
    severitySummary,
    `Most significant: ${humanizeTitle(topFinding.title)} (confidence: ${confidencePct}%).`,
    `Recommended action: ${topFinding.recommendedAction}`,
    aiNote,
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * Derives a root-cause string from the verified findings list.
 *
 * Selection logic (in priority order):
 * 1. AI findings with evidence spanning 2+ distinct `artifactType` values
 *    (cross-source correlation — most trustworthy causal explanation).
 * 2. All other findings (first by severity+confidence ordering, which callers
 *    are expected to preserve before passing findings here).
 *
 * Returns `null` when there are no findings.
 */
function deriveRootCause(findings: Finding[]): string | null {
  if (findings.length === 0) return null;

  // Prefer cross-source AI findings (evidence from 2+ distinct artifact types)
  const crossSourceAI = findings.filter(
    (f) => isAIFinding(f) && countDistinctArtifactTypes(f) >= 2,
  );
  if (crossSourceAI.length > 0) {
    return crossSourceAI[0]!.reasoningSummary;
  }

  // Fall back to the highest-ranked finding (callers sort by severity desc, confidence desc)
  return findings[0]!.reasoningSummary;
}

/**
 * Collects all evidence references across findings, deduplicating by path.
 * The first note encountered for a given path is retained.
 */
function collectEvidenceReferences(
  findings: Finding[],
): Array<{ path: string; note: string }> {
  const seen = new Set<string>();
  const refs: Array<{ path: string; note: string }> = [];

  for (const finding of findings) {
    for (const ev of finding.evidence) {
      const cleanedPath = cleanEvidencePath(ev.path);
      if (!seen.has(cleanedPath)) {
        seen.add(cleanedPath);
        refs.push({ path: cleanedPath, note: ev.note });
      }
    }
  }

  return refs;
}

/**
 * Generic helper: flattens a string field from every finding, deduplicating
 * by exact string equality while preserving insertion order.
 */
function collectDeduped(
  getItems: (finding: Finding) => string[],
  findings: Finding[],
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const finding of findings) {
    for (const item of getItems(finding)) {
      if (!seen.has(item)) {
        seen.add(item);
        result.push(item);
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Assembles an {@link InvestigationReport} from a completed
 * {@link PipelineResult}.
 *
 * The function:
 * 1. Generates an **executive summary** naming the most critical finding,
 *    the total finding count, and the recommended immediate action.
 * 2. Passes the already-ranked `findings[]` through unchanged (the
 *    orchestrator sorts them by severity then confidence).
 * 3. Derives the **root cause** from the highest-ranked finding's
 *    `reasoningSummary`.
 * 4. Collects deduplicated **evidence references**, **contradictions**,
 *    **next steps**, and **missing evidence** across all findings.
 * 5. Calls {@link generateSpecRecommendations} to produce collector,
 *    analyzer, and redaction suggestions from evidence gaps and the bundle
 *    profile's coverage gaps.
 *
 * All fields in the returned report are serialisation-safe (no class
 * instances, no functions) so the result can be passed directly to any of
 * the three reporters.
 *
 * @param result - The completed pipeline result containing findings, profile,
 *                 and all parsed bundle data.
 * @returns A fully assembled {@link InvestigationReport}.
 */
export function buildReport(result: PipelineResult): InvestigationReport {
  const { findings, profile } = result;

  const executiveSummary = generateExecutiveSummary(findings);
  const rootCause = deriveRootCause(findings);
  const specRecommendations = generateSpecRecommendations(findings, profile);
  const evidenceReferences = collectEvidenceReferences(findings);
  const contradictions = collectDeduped((f) => f.contradictionsChecked, findings);
  const nextSteps = collectDeduped((f) => [f.recommendedAction], findings);
  const missingEvidence = collectDeduped((f) => f.missingEvidence, findings);

  return {
    executiveSummary,
    findings,
    rootCause,
    evidenceReferences,
    contradictions,
    nextSteps,
    missingEvidence,
    specRecommendations,
    aiSummary: result.trace.aiSummary,
  };
}
