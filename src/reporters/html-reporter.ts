import * as fsp from 'fs/promises';
import * as path from 'path';
import type { Finding, FindingSeverity } from '../types/index.js';
import type { InvestigationReport, SpecRecommendation } from './types.js';
import { isAIFinding } from './report-builder.js';
import { cleanEvidencePath, humanizeTitle } from './display-helpers.js';

// ---------------------------------------------------------------------------
// Severity helpers
// ---------------------------------------------------------------------------

/**
 * Maps a {@link FindingSeverity} to a CSS class name used for colour-coded
 * styling.  All classes are defined in the embedded stylesheet so no external
 * resources are required.
 */
function severityClass(severity: FindingSeverity): string {
  const classes: Record<FindingSeverity, string> = {
    critical: 'severity-critical',
    high: 'severity-high',
    medium: 'severity-medium',
    low: 'severity-low',
    info: 'severity-info',
  };
  return classes[severity];
}

/**
 * Maps a {@link FindingSeverity} to a human-readable label displayed inside
 * the severity badge element.
 */
function severityLabel(severity: FindingSeverity): string {
  const labels: Record<FindingSeverity, string> = {
    critical: 'CRITICAL',
    high: 'HIGH',
    medium: 'MEDIUM',
    low: 'LOW',
    info: 'INFO',
  };
  return labels[severity];
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

/**
 * Escapes special HTML characters in a plain-text string so the result is
 * safe to embed directly in HTML content or attribute values.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// Embedded stylesheet
// ---------------------------------------------------------------------------

/**
 * Returns the complete embedded CSS as a `<style>` element string.
 *
 * Design goals:
 * - Severity colour-coding: critical=red, high=orange, medium=yellow,
 *   low=blue, info=gray.
 * - Clean, readable typography using system font stack.
 * - Evidence tables with alternating row colours.
 * - Collapsible `<details>` sections styled consistently.
 * - Print-friendly layout (single column, no background colours when printing).
 */
function buildStylesheet(): string {
  return `
  <style>
    /* ── Reset + Base ─────────────────────────────────────────────── */
    *, *::before, *::after { box-sizing: border-box; }

    body {
      margin: 0;
      padding: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
                   "Helvetica Neue", Arial, sans-serif;
      font-size: 15px;
      line-height: 1.6;
      color: #1a1a2e;
      background: #f7f8fc;
    }

    /* ── Layout ───────────────────────────────────────────────────── */
    .report-container {
      max-width: 960px;
      margin: 32px auto;
      background: #ffffff;
      border-radius: 8px;
      box-shadow: 0 2px 12px rgba(0,0,0,0.08);
      overflow: hidden;
    }

    .report-header {
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      color: #ffffff;
      padding: 36px 40px 28px;
    }

    .report-header h1 {
      margin: 0 0 8px;
      font-size: 26px;
      font-weight: 700;
      letter-spacing: -0.3px;
    }

    .report-header .generated-at {
      font-size: 12px;
      opacity: 0.65;
      letter-spacing: 0.4px;
      text-transform: uppercase;
    }

    .report-body {
      padding: 32px 40px;
    }

    /* ── Section ──────────────────────────────────────────────────── */
    .section {
      margin-bottom: 36px;
    }

    .section-title {
      font-size: 18px;
      font-weight: 600;
      color: #1a1a2e;
      border-bottom: 2px solid #e8eaf0;
      padding-bottom: 8px;
      margin: 0 0 18px;
    }

    /* ── Executive Summary ────────────────────────────────────────── */
    .executive-summary p {
      margin: 0 0 12px;
      font-size: 15px;
      color: #2c2c54;
    }

    .root-cause-box {
      background: #f0f4ff;
      border-left: 4px solid #4a6cf7;
      border-radius: 0 6px 6px 0;
      padding: 12px 16px;
      margin-top: 12px;
    }

    .root-cause-box strong {
      color: #2c3e7a;
    }

    /* ── Finding Card ─────────────────────────────────────────────── */
    .finding-card {
      border: 1px solid #e8eaf0;
      border-radius: 8px;
      margin-bottom: 20px;
      overflow: hidden;
    }

    .finding-header {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 14px 18px;
      background: #f9fafc;
      border-bottom: 1px solid #e8eaf0;
      flex-wrap: wrap;
    }

    .finding-index {
      font-size: 12px;
      font-weight: 700;
      color: #888;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      white-space: nowrap;
    }

    .finding-title {
      font-size: 15px;
      font-weight: 600;
      color: #1a1a2e;
      flex: 1;
    }

    .finding-body {
      padding: 16px 18px;
    }

    .finding-meta {
      display: flex;
      gap: 16px;
      margin-bottom: 14px;
      flex-wrap: wrap;
      align-items: center;
    }

    .confidence-badge {
      font-size: 13px;
      color: #555;
    }

    .affected-components {
      margin-bottom: 14px;
    }

    .affected-components .label {
      font-size: 13px;
      font-weight: 600;
      color: #555;
      margin-right: 8px;
    }

    .component-chip {
      display: inline-block;
      background: #eef0f8;
      color: #3a3a6e;
      border-radius: 4px;
      padding: 2px 8px;
      font-size: 12px;
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
      margin-right: 4px;
    }

    .reasoning {
      margin-bottom: 14px;
    }

    .reasoning p {
      margin: 0;
      color: #333;
      font-size: 14px;
    }

    .subsection-label {
      font-size: 13px;
      font-weight: 600;
      color: #444;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 8px;
    }

    .recommended-action {
      background: #f5fff8;
      border: 1px solid #c8e6c9;
      border-radius: 6px;
      padding: 12px 14px;
      font-size: 14px;
      color: #1b5e20;
      margin-top: 14px;
    }

    /* ── Severity Badges ──────────────────────────────────────────── */
    .severity-badge {
      display: inline-block;
      padding: 3px 10px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.8px;
      text-transform: uppercase;
      white-space: nowrap;
    }

    .severity-critical {
      background: #fde8e8;
      color: #c0392b;
      border: 1px solid #f5c6c6;
    }

    .severity-high {
      background: #fef3e2;
      color: #d35400;
      border: 1px solid #f5d5a0;
    }

    .severity-medium {
      background: #fefce8;
      color: #b7791f;
      border: 1px solid #f5e9a0;
    }

    .severity-low {
      background: #e8f4fd;
      color: #1a6fa8;
      border: 1px solid #b0d8f5;
    }

    .severity-info {
      background: #f0f0f5;
      color: #555577;
      border: 1px solid #d8d8e8;
    }

    /* ── Evidence Table ───────────────────────────────────────────── */
    .evidence-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
      margin-bottom: 4px;
    }

    .evidence-table th {
      background: #f0f2fa;
      color: #444;
      font-weight: 600;
      text-align: left;
      padding: 8px 12px;
      border: 1px solid #e0e2ec;
    }

    .evidence-table td {
      padding: 7px 12px;
      border: 1px solid #e8eaf0;
      vertical-align: top;
    }

    .evidence-table tr:nth-child(even) td {
      background: #fafbff;
    }

    .evidence-path {
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
      font-size: 12px;
      color: #2c3e7a;
      word-break: break-all;
    }

    .evidence-note {
      color: #444;
    }

    .no-data {
      color: #999;
      font-style: italic;
      font-size: 13px;
    }

    /* ── Collapsible Details (contradictions, trace) ─────────────── */
    details {
      border: 1px solid #e8eaf0;
      border-radius: 6px;
      margin-bottom: 10px;
      background: #fafbff;
    }

    details[open] {
      background: #ffffff;
    }

    summary {
      cursor: pointer;
      padding: 10px 14px;
      font-size: 13px;
      font-weight: 600;
      color: #444;
      list-style: none;
      user-select: none;
    }

    summary::-webkit-details-marker { display: none; }

    summary::before {
      content: "▶ ";
      font-size: 10px;
      color: #888;
      transition: transform 0.15s;
    }

    details[open] summary::before {
      content: "▼ ";
    }

    .details-content {
      padding: 0 14px 12px;
    }

    .details-content ul {
      margin: 8px 0 0;
      padding-left: 20px;
    }

    .details-content li {
      font-size: 13px;
      color: #444;
      margin-bottom: 4px;
    }

    /* ── Missing Evidence List ────────────────────────────────────── */
    .missing-evidence-list {
      list-style: none;
      padding: 0;
      margin: 0;
    }

    .missing-evidence-list li {
      padding: 7px 12px;
      border-left: 3px solid #f39c12;
      background: #fffbf0;
      margin-bottom: 6px;
      border-radius: 0 4px 4px 0;
      font-size: 14px;
      color: #555;
    }

    /* ── AI-assisted Badge ────────────────────────────────────────── */
    .ai-badge {
      display: inline-block;
      background: #e8f0fe;
      color: #1a56db;
      border: 1px solid #a4c2f4;
      border-radius: 4px;
      padding: 2px 7px;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.4px;
      white-space: nowrap;
    }

    .finding-card.ai-assisted .finding-header {
      background: #f0f4ff;
    }

    /* ── Spec Recommendations ─────────────────────────────────────── */
    .recommendation-card {
      border: 1px solid #e8eaf0;
      border-radius: 6px;
      padding: 14px 16px;
      margin-bottom: 12px;
    }

    .recommendation-type-badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.5px;
      text-transform: uppercase;
      margin-bottom: 8px;
    }

    .rec-collector {
      background: #e8f5e9;
      color: #2e7d32;
      border: 1px solid #a5d6a7;
    }

    .rec-analyzer {
      background: #e3f2fd;
      color: #1565c0;
      border: 1px solid #90caf9;
    }

    .rec-redaction {
      background: #fce4ec;
      color: #880e4f;
      border: 1px solid #f48fb1;
    }

    .recommendation-description {
      font-size: 14px;
      color: #333;
      margin-bottom: 8px;
    }

    .recommendation-rationale {
      font-size: 13px;
      color: #777;
      font-style: italic;
    }

    /* ── Metadata Table ───────────────────────────────────────────── */
    .metadata-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 14px;
    }

    .metadata-table th {
      background: #f0f2fa;
      text-align: left;
      padding: 8px 14px;
      font-weight: 600;
      color: #555;
      border: 1px solid #e0e2ec;
      width: 40%;
    }

    .metadata-table td {
      padding: 8px 14px;
      border: 1px solid #e8eaf0;
      color: #333;
    }

    /* ── Next Steps ───────────────────────────────────────────────── */
    .next-steps-list {
      list-style: none;
      padding: 0;
      margin: 0;
    }

    .next-steps-list li {
      padding: 9px 14px 9px 40px;
      background: #f5fff8;
      border: 1px solid #c8e6c9;
      border-radius: 6px;
      margin-bottom: 8px;
      font-size: 14px;
      color: #2c5f2e;
      position: relative;
    }

    .next-steps-list li::before {
      content: "→";
      position: absolute;
      left: 14px;
      font-weight: 700;
      color: #388e3c;
    }

    /* ── Footer ───────────────────────────────────────────────────── */
    .report-footer {
      background: #f7f8fc;
      border-top: 1px solid #e8eaf0;
      padding: 16px 40px;
      font-size: 12px;
      color: #888;
      text-align: center;
    }

    /* ── Print ────────────────────────────────────────────────────── */
    @media print {
      body { background: #fff; }
      .report-container { box-shadow: none; margin: 0; max-width: 100%; border-radius: 0; }
      .report-header { background: #1a1a2e !important; -webkit-print-color-adjust: exact; }
      details { border: 1px solid #ccc; }
      details[open] { page-break-inside: avoid; }
    }
  </style>`;
}

// ---------------------------------------------------------------------------
// HTML section builders
// ---------------------------------------------------------------------------

/**
 * Renders the `<head>` element including charset declaration and the embedded
 * stylesheet.
 */
function buildHead(title: string): string {
  return `
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(title)}</title>
    ${buildStylesheet()}
  </head>`;
}

/**
 * Renders the report header band showing the document title and generation
 * timestamp.
 */
function buildHeader(generatedAt: string): string {
  return `
      <div class="report-header">
        <h1>Investigation Report</h1>
        <div class="generated-at">Generated: ${escapeHtml(generatedAt)}</div>
      </div>`;
}

/**
 * Renders the executive summary section with optional root-cause callout box.
 */
function buildExecutiveSummary(report: InvestigationReport): string {
  const rootCauseHtml =
    report.rootCause !== null
      ? `
        <div class="root-cause-box">
          <strong>Root Cause:</strong> ${escapeHtml(report.rootCause)}
        </div>`
      : '';

  return `
        <div class="section">
          <h2 class="section-title">Executive Summary</h2>
          <div class="executive-summary">
            <p>${escapeHtml(report.executiveSummary)}</p>
            ${rootCauseHtml}
          </div>
        </div>`;
}

/**
 * Renders the evidence table for a single finding.
 * Uses a standard `<table>` with `<th>` headers and zebra-striped rows.
 */
function buildEvidenceTable(finding: Finding): string {
  if (finding.evidence.length === 0) {
    return '<p class="no-data">No evidence recorded.</p>';
  }

  const rows = finding.evidence
    .map(
      (ev) => `
              <tr>
                <td class="evidence-path">${escapeHtml(cleanEvidencePath(ev.path))}</td>
                <td class="evidence-note">${escapeHtml(ev.note)}</td>
              </tr>`,
    )
    .join('');

  return `
            <table class="evidence-table">
              <thead>
                <tr>
                  <th>Path</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>${rows}
              </tbody>
            </table>`;
}

/**
 * Renders the collapsible contradictions section for a single finding.
 * Uses a native `<details>/<summary>` element so no JavaScript is required.
 */
function buildContradictionsDetails(finding: Finding): string {
  if (finding.contradictionsChecked.length === 0) {
    return '';
  }

  const items = finding.contradictionsChecked
    .map((c) => `<li>${escapeHtml(c)}</li>`)
    .join('\n                  ');

  return `
            <details>
              <summary>Contradictions Checked (${finding.contradictionsChecked.length})</summary>
              <div class="details-content">
                <ul>
                  ${items}
                </ul>
              </div>
            </details>`;
}

/**
 * Renders the affected components chips for a single finding.
 */
function buildAffectedComponents(finding: Finding): string {
  if (finding.affectedComponents.length === 0) {
    return '';
  }

  const chips = finding.affectedComponents
    .map((c) => `<span class="component-chip">${escapeHtml(cleanEvidencePath(c))}</span>`)
    .join(' ');

  return `
            <div class="affected-components">
              <span class="label">Affected Components:</span>
              ${chips}
            </div>`;
}

/**
 * Renders all findings as individual cards.
 */
function buildFindings(findings: Finding[]): string {
  if (findings.length === 0) {
    return `
        <div class="section">
          <h2 class="section-title">Findings</h2>
          <p class="no-data">No findings recorded.</p>
        </div>`;
  }

  const cards = findings
    .map(
      (finding, idx) => {
        const aiClass = isAIFinding(finding) ? ' ai-assisted' : '';
        const aiBadge = isAIFinding(finding)
          ? '<span class="ai-badge">[AI] AI-assisted</span>'
          : '';
        return `
          <div class="finding-card${aiClass}">
            <div class="finding-header">
              <span class="finding-index">Finding ${idx + 1}</span>
              <span class="severity-badge ${severityClass(finding.severity)}">${severityLabel(finding.severity)}</span>
              <span class="finding-title">${escapeHtml(humanizeTitle(finding.title))}</span>
              ${aiBadge}
            </div>
            <div class="finding-body">
              <div class="finding-meta">
                <span class="confidence-badge">Confidence: <strong>${formatConfidence(finding.confidence, finding.confidenceQuality)}</strong></span>
              </div>
              ${buildAffectedComponents(finding)}
              <div class="reasoning">
                <div class="subsection-label">Reasoning</div>
                <p>${escapeHtml(finding.reasoningSummary)}</p>
              </div>
              <div class="evidence-section">
                <div class="subsection-label">Evidence</div>
                ${buildEvidenceTable(finding)}
              </div>
              ${buildContradictionsDetails(finding)}
              <div class="recommended-action">
                <strong>Recommended Action:</strong> ${escapeHtml(finding.recommendedAction)}
              </div>
            </div>
          </div>`;
      },
    )
    .join('');

  return `
        <div class="section">
          <h2 class="section-title">Findings</h2>
          ${cards}
        </div>`;
}

/**
 * Renders the consolidated next-steps section.
 */
function buildNextSteps(nextSteps: string[]): string {
  if (nextSteps.length === 0) {
    return `
        <div class="section">
          <h2 class="section-title">Next Steps</h2>
          <p class="no-data">No next steps identified.</p>
        </div>`;
  }

  const items = nextSteps
    .map((step) => `<li>${escapeHtml(step)}</li>`)
    .join('\n            ');

  return `
        <div class="section">
          <h2 class="section-title">Next Steps</h2>
          <ul class="next-steps-list">
            ${items}
          </ul>
        </div>`;
}

/**
 * Renders the missing evidence section with callout items.
 */
function buildMissingEvidence(missingEvidence: string[]): string {
  if (missingEvidence.length === 0) {
    return `
        <div class="section">
          <h2 class="section-title">Missing Evidence</h2>
          <p class="no-data">No missing evidence identified.</p>
        </div>`;
  }

  const items = missingEvidence
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join('\n            ');

  return `
        <div class="section">
          <h2 class="section-title">Missing Evidence</h2>
          <ul class="missing-evidence-list">
            ${items}
          </ul>
        </div>`;
}

/**
 * Returns the CSS class for a spec recommendation type badge.
 */
function recTypeClass(type: SpecRecommendation['type']): string {
  const classes: Record<SpecRecommendation['type'], string> = {
    collector: 'rec-collector',
    analyzer: 'rec-analyzer',
    redaction: 'rec-redaction',
  };
  return classes[type];
}

/**
 * Renders the spec improvement recommendations section.
 */
function buildSpecRecommendations(recommendations: SpecRecommendation[]): string {
  if (recommendations.length === 0) {
    return `
        <div class="section">
          <h2 class="section-title">Spec Improvement Recommendations</h2>
          <p class="no-data">No spec improvements recommended.</p>
        </div>`;
  }

  const cards = recommendations
    .map(
      (rec) => `
          <div class="recommendation-card">
            <span class="recommendation-type-badge ${recTypeClass(rec.type)}">${rec.type}</span>
            <div class="recommendation-description">${escapeHtml(rec.description)}</div>
            <div class="recommendation-rationale">Rationale: ${escapeHtml(rec.rationale)}</div>
          </div>`,
    )
    .join('');

  return `
        <div class="section">
          <h2 class="section-title">Spec Improvement Recommendations</h2>
          ${cards}
        </div>`;
}

/**
 * Renders the collapsible all-evidence-references section.
 */
function buildAllEvidenceReferences(
  evidenceReferences: InvestigationReport['evidenceReferences'],
): string {
  if (evidenceReferences.length === 0) {
    return '';
  }

  const rows = evidenceReferences
    .map(
      (ev) => `
                  <tr>
                    <td class="evidence-path">${escapeHtml(cleanEvidencePath(ev.path))}</td>
                    <td class="evidence-note">${escapeHtml(ev.note)}</td>
                  </tr>`,
    )
    .join('');

  return `
        <div class="section">
          <h2 class="section-title">All Evidence References</h2>
          <details>
            <summary>View all ${evidenceReferences.length} evidence references</summary>
            <div class="details-content">
              <table class="evidence-table">
                <thead>
                  <tr>
                    <th>Path</th>
                    <th>Note</th>
                  </tr>
                </thead>
                <tbody>${rows}
                </tbody>
              </table>
            </div>
          </details>
        </div>`;
}

/**
 * Renders the collapsible contradictions-overview section using the
 * consolidated `report.contradictions` list (not per-finding).
 */
function buildContradictionsOverview(contradictions: string[]): string {
  if (contradictions.length === 0) {
    return '';
  }

  const items = contradictions
    .map((c) => `<li>${escapeHtml(c)}</li>`)
    .join('\n                  ');

  return `
        <div class="section">
          <h2 class="section-title">Contradictions Checked</h2>
          <details>
            <summary>View all ${contradictions.length} contradiction checks</summary>
            <div class="details-content">
              <ul>
                ${items}
              </ul>
            </div>
          </details>
        </div>`;
}

/**
 * Renders the metadata summary table at the bottom of the report body.
 */
function buildMetadata(report: InvestigationReport, generatedAt: string): string {
  return `
        <div class="section">
          <h2 class="section-title">Investigation Metadata</h2>
          <table class="metadata-table">
            <tbody>
              <tr>
                <th>Generated At</th>
                <td>${escapeHtml(generatedAt)}</td>
              </tr>
              <tr>
                <th>Total Findings</th>
                <td>${report.findings.length}</td>
              </tr>
              <tr>
                <th>Evidence References</th>
                <td>${report.evidenceReferences.length}</td>
              </tr>
              <tr>
                <th>Contradictions Checked</th>
                <td>${report.contradictions.length}</td>
              </tr>
              <tr>
                <th>Spec Recommendations</th>
                <td>${report.specRecommendations.length}</td>
              </tr>
            </tbody>
          </table>
        </div>`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generates a self-contained HTML document from an {@link InvestigationReport}.
 *
 * The document is fully self-contained — all CSS is embedded in a `<style>`
 * element inside `<head>` so the file can be opened in any browser without
 * an internet connection or an external stylesheet.
 *
 * The document contains:
 * 1. **Header band** — title and generation timestamp.
 * 2. **Executive summary** — bundle diagnosis and root-cause callout.
 * 3. **Findings** — each finding rendered as a card with:
 *    - Severity badge (colour-coded by CSS class).
 *    - Confidence percentage.
 *    - Affected components chips.
 *    - Reasoning paragraph.
 *    - Evidence table (path + note).
 *    - Collapsible contradictions-checked section.
 *    - Recommended action callout.
 * 4. **Next steps** — consolidated action list.
 * 5. **Missing evidence** — consolidated gaps list.
 * 6. **All evidence references** — collapsible full-reference table.
 * 7. **Contradictions overview** — collapsible full contradictions list.
 * 8. **Spec improvement recommendations** — categorised recommendation cards.
 * 9. **Investigation metadata** — summary count table.
 *
 * The layout is print-friendly: background gradients are preserved with
 * `-webkit-print-color-adjust: exact` on the header; all other sections print
 * cleanly without background noise.
 *
 * @param report - The investigation report to render.
 * @returns A UTF-8 HTML string representing the full investigation report.
 */
export function generateHtmlReport(report: InvestigationReport): string {
  const generatedAt = new Date().toISOString();

  return `<!DOCTYPE html>
<html lang="en">
${buildHead('Investigation Report')}
  <body>
    <div class="report-container">
      ${buildHeader(generatedAt)}
      <div class="report-body">
        ${buildExecutiveSummary(report)}
        ${buildFindings(report.findings)}
        ${buildNextSteps(report.nextSteps)}
        ${buildMissingEvidence(report.missingEvidence)}
        ${buildAllEvidenceReferences(report.evidenceReferences)}
        ${buildContradictionsOverview(report.contradictions)}
        ${buildSpecRecommendations(report.specRecommendations)}
        ${buildMetadata(report, generatedAt)}
      </div>
      <div class="report-footer">
        Support Bundle Investigator &mdash; generated ${escapeHtml(generatedAt)}
      </div>
    </div>
  </body>
</html>`;
}

/**
 * Writes an {@link InvestigationReport} as an HTML file to disk.
 *
 * The report is written to `findings.html` inside `outputDir`.  The directory
 * is created recursively if it does not already exist.
 *
 * @param report    - The investigation report to write.
 * @param outputDir - Directory where `findings.html` will be created.
 * @returns The absolute path of the written file.
 */
export async function writeHtmlReport(
  report: InvestigationReport,
  outputDir: string,
): Promise<string> {
  const resolvedOutputDir = path.resolve(outputDir);
  await fsp.mkdir(resolvedOutputDir, { recursive: true });
  const outFile = path.join(resolvedOutputDir, 'findings.html');
  await fsp.writeFile(outFile, generateHtmlReport(report), 'utf-8');
  return outFile;
}
