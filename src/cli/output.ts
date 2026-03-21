import * as fsp from 'fs/promises';
import * as path from 'path';
import type { BundleProfile, Finding } from '../types/index.js';
import type { InvestigationTrace } from '../pipeline/trace.js';
import type { PipelineResult } from '../pipeline/analyze.js';
import {
  buildReport,
  generateJsonReport,
  generateMarkdownReport,
  generateHtmlReport,
  writeJsonReport,
} from '../reporters/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OutputOptions {
  format: 'json' | 'text' | 'summary' | 'markdown' | 'html';
  outputDir?: string;
  verbose?: boolean;
  debug?: boolean;
}

// ---------------------------------------------------------------------------
// Console output
// ---------------------------------------------------------------------------

/**
 * Prints a human-readable summary of the bundle profile to stdout.
 */
export function printProfileSummary(profile: BundleProfile): void {
  const { manifest, analyzerCount, logFileCount, resourceCount, eventCount } = profile;

  console.log('');
  console.log('═══════════════════════════════════════════════════════');
  console.log('  Support Bundle Profile');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  Bundle:       ${manifest.bundlePath}`);
  console.log(`  Files:        ${manifest.files.length}`);
  console.log(`  Analyzers:    ${analyzerCount}`);
  console.log(`  Resources:    ${resourceCount}`);
  console.log(`  Events:       ${eventCount}`);
  console.log(`  Log files:    ${logFileCount}`);
  console.log('');

  if (profile.namespaces.length > 0) {
    console.log(`  Namespaces:   ${profile.namespaces.join(', ')}`);
  }

  if (profile.workloads.length > 0) {
    console.log('');
    console.log('  Workloads:');
    for (const wl of profile.workloads) {
      console.log(`    - [${wl.kind}] ${wl.namespace}/${wl.name}`);
    }
  }

  if (profile.coverageGaps.length > 0) {
    console.log('');
    console.log('  Coverage gaps:');
    for (const gap of profile.coverageGaps) {
      console.log(`    ⚠  ${gap}`);
    }
  }

  console.log('═══════════════════════════════════════════════════════');
  console.log('');
}

// ---------------------------------------------------------------------------
// File output
// ---------------------------------------------------------------------------

/**
 * Writes the investigation trace to a JSON file in `outputDir`.
 */
export async function writeTraceFile(
  trace: InvestigationTrace,
  outputDir: string,
): Promise<void> {
  await fsp.mkdir(outputDir, { recursive: true });
  const traceFile = path.join(outputDir, 'trace.json');
  await fsp.writeFile(traceFile, JSON.stringify(trace, null, 2), 'utf-8');
}

/**
 * Writes per-finding provenance metadata to `provenance.json` in `outputDir`.
 */
export async function writeProvenanceFile(
  findings: Finding[],
  outputDir: string,
): Promise<void> {
  await fsp.mkdir(outputDir, { recursive: true });
  const provenanceFile = path.join(outputDir, 'provenance.json');
  const payload = findings.map((finding) => ({
    findingId: finding.id,
    title: finding.title,
    provenance: finding.provenance ?? null,
  }));
  await fsp.writeFile(provenanceFile, JSON.stringify(payload, null, 2), 'utf-8');
}

/**
 * Prints a text summary of analysis results to stdout.
 *
 * @deprecated Prefer `writePipelineResult` which now uses the Markdown reporter.
 *             Kept for backward-compatible re-exports.
 */
export function printTextSummary(result: PipelineResult): void {
  printProfileSummary(result.profile);

  const errors = result.analyzerResults.filter((r) => r.isFail);
  const warns = result.analyzerResults.filter((r) => r.isWarn);

  if (errors.length > 0) {
    console.log('  ❌  Analyzer Errors:');
    for (const e of errors) {
      console.log(`    [${e.name}] ${e.title}`);
      if (e.message) console.log(`      ${e.message}`);
    }
    console.log('');
  }

  if (warns.length > 0) {
    console.log('  ⚠   Analyzer Warnings:');
    for (const w of warns) {
      console.log(`    [${w.name}] ${w.title}`);
      if (w.message) console.log(`      ${w.message}`);
    }
    console.log('');
  }
}

/**
 * Writes the pipeline result to disk or prints to stdout depending on the
 * output options.
 *
 * When `outputDir` is set, always writes all three report files:
 *   - `findings.json`  — full structured report (via JSON reporter)
 *   - `report.md`      — human-readable Markdown report
 *   - `report.html`    — self-contained HTML report with embedded CSS
 *
 * When `outputDir` is not set, format controls stdout output:
 *   - `json`           — prints full JSON report to stdout
 *   - `text`           — prints Markdown report to stdout
 *   - `markdown`       — prints Markdown report to stdout
 *   - `html`           — prints HTML report to stdout
 *   - `summary`        — prints bundle profile summary to stdout
 */
export async function writePipelineResult(
  result: PipelineResult,
  options: OutputOptions,
): Promise<void> {
  const { format, outputDir } = options;
  const includeProvenance = options.debug === true || result.debug === true;

  if (outputDir) {
    // Always write all three report files when an output directory is provided.
    const resolvedDir = path.resolve(outputDir);
    await fsp.mkdir(resolvedDir, { recursive: true });

    const report = buildReport(result, { includeDiagnostics: true });

    await writeJsonReport(report, resolvedDir, { includeProvenance });

    const mdPath = path.join(resolvedDir, 'report.md');
    await fsp.writeFile(mdPath, generateMarkdownReport(report), 'utf-8');

    const htmlPath = path.join(resolvedDir, 'report.html');
    await fsp.writeFile(htmlPath, generateHtmlReport(report), 'utf-8');

    console.log(`Reports written to ${resolvedDir}: findings.json, report.md, report.html`);
    return;
  }

  // No outputDir — print to stdout based on format.
  if (format === 'summary') {
    printProfileSummary(result.profile);
    return;
  }

  const report = buildReport(result, { includeDiagnostics: true });

  if (format === 'json') {
    console.log(generateJsonReport(report, { includeProvenance }));
  } else if (format === 'html') {
    console.log(generateHtmlReport(report));
  } else {
    // 'text' | 'markdown'
    console.log(generateMarkdownReport(report));
  }
}
