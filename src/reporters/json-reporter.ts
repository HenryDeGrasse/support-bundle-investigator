import * as fsp from 'fs/promises';
import * as path from 'path';
import type { InvestigationReport } from './types.js';
import { cleanEvidencePath, humanizeTitle } from './display-helpers.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Identifies the schema version of the JSON output.  Increment on breaking changes. */
const REPORT_SCHEMA_VERSION = '1.0.0';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface JsonReportOptions {
  includeProvenance?: boolean;
}

/**
 * Serializes an {@link InvestigationReport} to a well-structured JSON string.
 *
 * The output includes:
 * - Report metadata: `schemaVersion` and `generatedAt` (ISO-8601 timestamp).
 * - All top-level report fields: `executiveSummary`, `rootCause`,
 *   `evidenceReferences`, `contradictions`, `nextSteps`, `missingEvidence`,
 *   and `specRecommendations`.
 * - A `findings` array where every finding is serialized with its full set of
 *   fields: `id`, `title`, `severity`, `confidence`, `affectedComponents`,
 *   `reasoningSummary`, `evidence`, `contradictionsChecked`,
 *   `recommendedAction`, and `missingEvidence`.
 *
 * The JSON is formatted with 2-space indentation for human readability.  The
 * output is safe for `JSON.parse` round-tripping — no circular references, no
 * class instances, no functions.
 *
 * @param report - The investigation report to serialize.
 * @returns A JSON string representing the full investigation report.
 */
export function generateJsonReport(
  report: InvestigationReport,
  options: JsonReportOptions = {},
): string {
  const output = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    executiveSummary: report.executiveSummary,
    rootCause: report.rootCause,
    findings: report.findings.map((finding) => {
      const base = {
        id: finding.id,
        title: humanizeTitle(finding.title),
        severity: finding.severity,
        confidence: finding.confidence,
        affectedComponents: finding.affectedComponents.map(cleanEvidencePath),
        reasoningSummary: finding.reasoningSummary,
        evidence: finding.evidence.map((ev) => {
          const evOut: Record<string, unknown> = {
            path: cleanEvidencePath(ev.path),
            note: ev.note,
          };
          if (ev.artifactType !== undefined) {
            evOut['artifactType'] = ev.artifactType;
          }
          if (ev.timestamp !== undefined) {
            evOut['timestamp'] = ev.timestamp;
          }
          return evOut;
        }),
        contradictionsChecked: finding.contradictionsChecked,
        recommendedAction: finding.recommendedAction,
        missingEvidence: finding.missingEvidence,
        ...(finding.confidenceQuality !== undefined
          ? { confidenceQuality: finding.confidenceQuality }
          : {}),
        ...(options.includeProvenance === true && finding.provenance !== undefined
          ? { provenance: finding.provenance }
          : {}),
      };
      return base;
    }),
    evidenceReferences: report.evidenceReferences.map((ev) => ({
      path: cleanEvidencePath(ev.path),
      note: ev.note,
    })),
    contradictions: report.contradictions,
    nextSteps: report.nextSteps,
    missingEvidence: report.missingEvidence,
    specRecommendations: report.specRecommendations,
  };

  return JSON.stringify(output, null, 2);
}

/**
 * Writes an {@link InvestigationReport} as a JSON file to disk.
 *
 * The report is written to `findings.json` inside `outputDir`.  The directory
 * is created recursively if it does not already exist.
 *
 * @param report    - The investigation report to write.
 * @param outputDir - Directory where `findings.json` will be created.
 * @returns The absolute path of the written file.
 */
export async function writeJsonReport(
  report: InvestigationReport,
  outputDir: string,
  options: JsonReportOptions = {},
): Promise<string> {
  const resolvedOutputDir = path.resolve(outputDir);
  await fsp.mkdir(resolvedOutputDir, { recursive: true });
  const outFile = path.join(resolvedOutputDir, 'findings.json');
  await fsp.writeFile(outFile, generateJsonReport(report, options), 'utf-8');
  return outFile;
}
