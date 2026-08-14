import * as fsp from 'fs/promises';
import * as path from 'path';
import type { Finding, FindingSeverity } from '../types/index.js';
import type {
  InvestigationDiagnostics,
  InvestigationReport,
  SpecRecommendation,
} from './types.js';
import { isAIFinding } from './report-builder.js';
import {
  cleanEvidencePath,
  humanizeTitle,
  humanizeReasoning,
  collapseEvidence,
  formatSummaryCard,
} from './display-helpers.js';

// ---------------------------------------------------------------------------
// Severity helpers
// ---------------------------------------------------------------------------

/**
 * Maps a {@link FindingSeverity} to a Markdown-renderable badge string.
 * Uses text-only markers (no emoji) for maximum terminal compatibility.
 */
function severityBadge(severity: FindingSeverity): string {
  const labels: Record<FindingSeverity, string> = {
    critical: '[!!] CRITICAL',
    high: '[!] HIGH',
    medium: '[~] MEDIUM',
    low: '[-] LOW',
    info: '[i] INFO',
  };
  return `**${labels[severity]}**`;
}

/**
 * Returns a confidence percentage string with an optional quality indicator.
 * e.g. `0.87` with quality `'strong'` → `"87% (strong)"`.
 * Clamps the value to [0, 1] before formatting.
 */
function formatConfidence(confidence: number, quality?: Finding['confidenceQuality']): string {
  const clamped = Math.min(1, Math.max(0, confidence));
  const pct = `${Math.round(clamped * 100)}%`;
  if (quality === undefined) return pct;
  return `${pct} (${quality})`;
}

// ---------------------------------------------------------------------------
// Section renderers
// ---------------------------------------------------------------------------

/**
 * Renders the top-level H1 title and executive summary.
 */
function renderExecutiveSummary(report: InvestigationReport): string {
  const lines: string[] = [];
  lines.push('# Investigation Report');
  lines.push('');

  // "Start here" card for the top finding
  if (report.findings.length > 0) {
    lines.push(formatSummaryCard(report.findings[0]!, report.findings.length));
    lines.push('');
  }

  lines.push('## Executive Summary');
  lines.push('');
  lines.push(report.executiveSummary);
  lines.push('');

  if (report.rootCause !== null) {
    lines.push(`**Root Cause:** ${humanizeReasoning(report.rootCause)}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Renders the evidence table for a single finding.
 *
 * | Path | Note |
 * |------|------|
 * | …   | …   |
 */
function renderEvidenceTable(finding: Finding): string {
  if (finding.evidence.length === 0) {
    return '_No evidence recorded._\n';
  }

  const collapsed = collapseEvidence(finding.evidence);
  const rows = collapsed.map((ev) => {
    const cleanedPath = cleanEvidencePath(ev.path);
    const escapedPath = cleanedPath
      .replace(/\\/g, '\\\\')
      .replace(/\|/g, '\\|')
      .replace(/\r?\n|\r/g, ' ');
    const escapedNote = ev.note
      .replace(/\\/g, '\\\\')
      .replace(/\|/g, '\\|')
      .replace(/\r?\n|\r/g, ' ');
    return `| \`${escapedPath}\` | ${escapedNote} |`;
  });

  return ['| Path | Note |', '|------|------|', ...rows].join('\n') + '\n';
}

/**
 * Renders all findings as numbered H3 subsections, sorted by their position
 * in the supplied `findings` array (callers are responsible for ordering).
 */
function renderFindings(findings: Finding[]): string {
  if (findings.length === 0) {
    return '## Findings\n\n_No findings recorded._\n';
  }

  const lines: string[] = [];
  lines.push('## Findings');
  lines.push('');

  findings.forEach((finding, idx) => {
    const aiTag = isAIFinding(finding) ? ' [AI-assisted]' : '';
    const displayTitle = humanizeTitle(finding.title);
    lines.push(`### ${idx + 1}. ${displayTitle}${aiTag}`);
    lines.push('');

    // Severity badge + confidence on the same line for scannability
    lines.push(
      `${severityBadge(finding.severity)} · Confidence: **${formatConfidence(finding.confidence, finding.confidenceQuality)}**`,
    );
    lines.push('');

    // Affected components (clean temp paths)
    if (finding.affectedComponents.length > 0) {
      lines.push(
        `**Affected Components:** ${finding.affectedComponents.map((c) => `\`${cleanEvidencePath(c)}\``).join(', ')}`,
      );
      lines.push('');
    }

    // Reasoning
    lines.push('**Reasoning**');
    lines.push('');
    lines.push(humanizeReasoning(finding.reasoningSummary));
    lines.push('');

    // Evidence table
    lines.push('**Evidence**');
    lines.push('');
    lines.push(renderEvidenceTable(finding));

    // Contradictions checked
    if (finding.contradictionsChecked.length > 0) {
      lines.push('**Contradictions Checked**');
      lines.push('');
      for (const contradiction of finding.contradictionsChecked) {
        lines.push(`- ${contradiction}`);
      }
      lines.push('');
    }

    // Recommended action
    lines.push('**Recommended Action**');
    lines.push('');
    lines.push(finding.recommendedAction);
    lines.push('');
  });

  return lines.join('\n');
}

/**
 * Renders the missing evidence section listing all gaps consolidated across
 * all findings.
 */
function renderMissingEvidence(missingEvidence: string[]): string {
  const lines: string[] = [];
  lines.push('## Missing Evidence');
  lines.push('');

  if (missingEvidence.length === 0) {
    lines.push('_No missing evidence identified._');
    lines.push('');
  } else {
    for (const item of missingEvidence) {
      lines.push(`- ${item}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Renders the spec improvement recommendations section.
 */
function renderSpecRecommendations(recommendations: SpecRecommendation[]): string {
  const lines: string[] = [];
  lines.push('## Spec Improvement Recommendations');
  lines.push('');

  if (recommendations.length === 0) {
    lines.push('_No spec improvements recommended._');
    lines.push('');
    return lines.join('\n');
  }

  recommendations.forEach((rec, idx) => {
    const typeLabel =
      rec.type === 'collector'
        ? '[+] Collector'
        : rec.type === 'analyzer'
          ? '[?] Analyzer'
          : '[x] Redaction';

    lines.push(`### ${idx + 1}. ${typeLabel}`);
    lines.push('');
    lines.push(rec.description);
    lines.push('');
    lines.push(`_Rationale: ${rec.rationale}_`);
    lines.push('');
  });

  return lines.join('\n');
}

/**
 * Renders the investigation metadata footer.
 */
function renderMetadataFooter(report: InvestigationReport, generatedAt: string): string {
  const lines: string[] = [];
  lines.push('---');
  lines.push('');
  lines.push('## Investigation Metadata');
  lines.push('');
  lines.push(`| Field | Value |`);
  lines.push(`|-------|-------|`);
  lines.push(`| Generated At | ${generatedAt} |`);
  lines.push(`| Total Findings | ${report.findings.length} |`);
  lines.push(`| Evidence References | ${report.evidenceReferences.length} |`);
  lines.push(`| Contradictions Checked | ${report.contradictions.length} |`);
  lines.push(`| Spec Recommendations | ${report.specRecommendations.length} |`);
  lines.push('');

  return lines.join('\n');
}

function renderDiagnostics(diagnostics: InvestigationDiagnostics): string {
  const lines: string[] = [];
  lines.push('## Diagnostics');
  lines.push('');

  lines.push('### Pipeline Step Timings');
  lines.push('');
  lines.push('| Step | Duration (ms) | Artifacts Processed |');
  lines.push('|------|---------------:|--------------------:|');
  for (const step of diagnostics.stepTimings) {
    lines.push(`| ${step.name} | ${step.durationMs} | ${step.artifactsProcessed} |`);
  }
  lines.push('');

  if (diagnostics.seedCategories !== undefined) {
    lines.push('### Seed Count by Category');
    lines.push('');
    lines.push(`Total seeds: ${diagnostics.seedCount ?? 0}`);
    lines.push('');
    for (const [category, count] of Object.entries(diagnostics.seedCategories)) {
      lines.push(`- ${category}: ${count}`);
    }
    lines.push('');
  }

  lines.push('### Finding Confidence Histogram');
  lines.push('');
  lines.push(`- 0-0.5: ${diagnostics.confidenceHistogram['0-0.5']}`);
  lines.push(`- 0.5-0.75: ${diagnostics.confidenceHistogram['0.5-0.75']}`);
  lines.push(`- 0.75-1.0: ${diagnostics.confidenceHistogram['0.75-1.0']}`);
  lines.push('');

  if (diagnostics.hypothesisStats !== undefined) {
    lines.push('### Hypothesis Conversion');
    lines.push('');
    lines.push(`- Generated: ${diagnostics.hypothesisStats.generated}`);
    lines.push(`- Verified: ${diagnostics.hypothesisStats.verified}`);
    lines.push(`- Converted: ${diagnostics.hypothesisStats.converted}`);
    if (diagnostics.hypothesisStats.conversionRate !== undefined) {
      lines.push(`- Conversion Rate: ${(diagnostics.hypothesisStats.conversionRate * 100).toFixed(1)}%`);
    }
    lines.push('');
  }

  if (diagnostics.retrievalStats !== undefined) {
    lines.push('### Retrieval Stats');
    lines.push('');
    lines.push(`- Graph Chunks: ${diagnostics.retrievalStats.graphChunks}`);
    lines.push(`- Lexical Chunks: ${diagnostics.retrievalStats.lexicalChunks}`);
    lines.push(`- Semantic Chunks: ${diagnostics.retrievalStats.semanticChunks}`);
    lines.push(`- Merged Chunks: ${diagnostics.retrievalStats.mergedChunks}`);
    lines.push('');
  }

  if (diagnostics.aiSummary !== undefined && diagnostics.aiSummary.backend !== 'off') {
    lines.push('### AI Call Stats');
    lines.push('');
    lines.push(`- Backend: ${diagnostics.aiSummary.backend}`);
    lines.push(`- Model: ${diagnostics.aiSummary.model}`);
    lines.push(`- Total Calls: ${diagnostics.aiSummary.totalCalls}`);
    lines.push(`- Successful Calls: ${diagnostics.aiSummary.successfulCalls}`);
    lines.push(`- Failed Calls: ${diagnostics.aiSummary.failedCalls}`);
    lines.push(`- Total Latency (ms): ${diagnostics.aiSummary.totalLatencyMs}`);
    lines.push(`- Average Latency (ms): ${diagnostics.aiSummary.avgLatencyMs}`);
    if (diagnostics.aiSummary.totalPromptTokens !== undefined) {
      lines.push(`- Prompt Tokens: ${diagnostics.aiSummary.totalPromptTokens}`);
    }
    if (diagnostics.aiSummary.totalCompletionTokens !== undefined) {
      lines.push(`- Completion Tokens: ${diagnostics.aiSummary.totalCompletionTokens}`);
    }
    if (diagnostics.aiSummary.estimatedCostUsd !== undefined) {
      lines.push(`- Estimated Cost (USD): ${diagnostics.aiSummary.estimatedCostUsd}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

export interface MarkdownReportOptions {
  includeDiagnostics?: boolean;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generates a Markdown document from an {@link InvestigationReport}.
 *
 * The document contains:
 * 1. **Executive summary** — bundle info, top-level diagnosis, and root cause.
 * 2. **Ranked findings** — each finding rendered as a subsection with severity
 *    badge, confidence score, affected components, reasoning paragraph,
 *    evidence table (path + note), contradictions-checked list, and recommended
 *    action.
 * 3. **Missing evidence** — consolidated list of evidence gaps across all findings.
 * 4. **Spec improvement recommendations** — collector, analyzer, and redaction
 *    suggestions categorised and rationale-annotated.
 * 5. **Investigation metadata footer** — counts and timestamp rendered as a
 *    summary table.
 *
 * @param report - The investigation report to render.
 * @returns A UTF-8 Markdown string.
 */
export function generateMarkdownReport(
  report: InvestigationReport,
  options: MarkdownReportOptions = {},
): string {
  const generatedAt = new Date().toISOString();

  const sections = [
    renderExecutiveSummary(report),
    renderFindings(report.findings),
    renderMissingEvidence(report.missingEvidence),
    renderSpecRecommendations(report.specRecommendations),
    ...(report.diagnostics !== undefined && options.includeDiagnostics !== false
      ? [renderDiagnostics(report.diagnostics)]
      : []),
    renderMetadataFooter(report, generatedAt),
  ];

  return sections.join('\n');
}

/**
 * Writes an {@link InvestigationReport} as a Markdown file to disk.
 *
 * The report is written to `findings.md` inside `outputDir`.  The directory
 * is created recursively if it does not already exist.
 *
 * @param report    - The investigation report to write.
 * @param outputDir - Directory where `findings.md` will be created.
 * @returns The absolute path of the written file.
 */
export async function writeMarkdownReport(
  report: InvestigationReport,
  outputDir: string,
): Promise<string> {
  const resolvedOutputDir = path.resolve(outputDir);
  await fsp.mkdir(resolvedOutputDir, { recursive: true });
  const outFile = path.join(resolvedOutputDir, 'findings.md');
  await fsp.writeFile(outFile, generateMarkdownReport(report), 'utf-8');
  return outFile;
}
