#!/usr/bin/env node
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import * as tar from 'tar';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const cliEntry = path.join(repoRoot, 'dist', 'cli', 'run.js');

const SCENARIOS = [
  {
    name: 'wrong-db-endpoint',
    expectedTopCategory: 'dns-failure',
  },
  {
    name: 'missing-secret-crashloop',
    expectedTopCategory: 'missing-secret',
  },
  {
    name: 'bad-image-tag',
    expectedTopCategory: 'image-pull-failure',
  },
  {
    name: 'pvc-pending',
    expectedTopCategory: 'volume-mount-failure',
  },
];

// ---------------------------------------------------------------------------
// Category inference
// ---------------------------------------------------------------------------

/**
 * Infers the diagnostic category of a single finding from its ID or text.
 *
 * This mirrors the heuristic used to verify top-1 correctness but operates
 * on any finding, enabling per-confidence-band accuracy tracking.
 */
function inferFindingCategory(finding) {
  if (!finding) return 'none';

  const id = String(finding.id ?? '');
  if (id.startsWith('finding:hypothesis:')) {
    return id.split(':')[2] ?? 'unknown';
  }

  const lower = `${finding.title ?? ''} ${finding.reasoningSummary ?? ''}`.toLowerCase();
  if (lower.includes('dns') || lower.includes('name resolution') || lower.includes('nslookup')) {
    return 'dns-failure';
  }
  if (lower.includes('secret') && (lower.includes('missing') || lower.includes('not found'))) {
    return 'missing-secret';
  }
  if (lower.includes('image') && (lower.includes('pull') || lower.includes('err'))) {
    return 'image-pull-failure';
  }
  if (lower.includes('volume') || lower.includes('pvc') || lower.includes('mount')) {
    return 'volume-mount-failure';
  }
  if (lower.includes('connect')) {
    return 'connectivity-failure';
  }
  return 'non-hypothesis';
}

/**
 * Infers the top category from a list of findings (uses the first / highest
 * confidence finding).  Used for the per-scenario `correct_top1` check.
 */
function inferTopCategory(findings) {
  return inferFindingCategory(findings[0]);
}

// ---------------------------------------------------------------------------
// Confidence bands
// ---------------------------------------------------------------------------

/**
 * Confidence bands used for calibration analysis.
 *
 * Findings are assigned to the highest band whose `min` threshold they meet
 * (exclusive upper bound, inclusive lower bound, except the top band which
 * is inclusive on both ends).
 */
const CONFIDENCE_BANDS = [
  { label: '0.85–1.00', min: 0.85, max: 1.01 },
  { label: '0.70–0.85', min: 0.70, max: 0.85 },
  { label: '0.50–0.70', min: 0.50, max: 0.70 },
  { label: '0.00–0.50', min: 0.00, max: 0.50 },
];

/**
 * Assigns a finding's confidence value to a confidence band label.
 */
function confidenceBand(confidence) {
  for (const band of CONFIDENCE_BANDS) {
    if (confidence >= band.min && confidence < band.max) {
      return band.label;
    }
  }
  return '0.00–0.50';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseJson(stdout) {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    throw new Error('CLI produced empty stdout');
  }
  return JSON.parse(trimmed);
}

function formatMs(value) {
  return `${Math.round(value)}ms`;
}

function printTable(rows) {
  const headers = [
    'scenario',
    'mode',
    'elapsed',
    'top_category',
    'top_conf',
    'correct_top1',
    'total_findings',
    'hypothesis_findings',
    'ai_findings',
  ];

  const stringRows = rows.map((row) => [
    row.scenario,
    row.mode,
    formatMs(row.elapsedMs),
    row.topCategory,
    row.topConfidence.toFixed(2),
    row.correctTop1 ? 'yes' : 'no',
    String(row.totalFindings),
    String(row.hypothesisFindings),
    String(row.aiFindings),
  ]);

  const widths = headers.map((header, i) =>
    Math.max(header.length, ...stringRows.map((row) => row[i].length)),
  );

  const renderRow = (cells) =>
    cells.map((cell, i) => cell.padEnd(widths[i])).join('  ');

  console.log(renderRow(headers));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of stringRows) {
    console.log(renderRow(row));
  }
}

/**
 * Prints the confidence calibration report.
 *
 * For each confidence band, shows the count of findings in that band, how
 * many were "correct" (matched the scenario's expected top category), and
 * the accuracy percentage.
 *
 * Also checks monotonicity: higher bands should have >= accuracy than lower
 * bands and prints a warning when this is violated.
 *
 * Primary calibration gate lives in the unit suite
 * (`src/investigators/__tests__/hypothesis-ranker.test.ts`). This benchmark is
 * a secondary corpus-level signal used to spot broader regressions and inspect
 * confidence-band behaviour on the fixture scenarios.
 *
 * @param {Array<{confidence: number, correct: boolean, scenario: string, mode: string}>} allFindingStats
 */
function printConfidenceCalibration(allFindingStats) {
  console.log('\n--- Confidence calibration by band ---\n');
  console.log(
    'Definition of "correct": a finding is correct when its inferred category\n' +
    'matches the scenario\'s expectedTopCategory.  With 4 scenarios this is a\n' +
    'small dataset — use the data to spot regressions, not absolute thresholds.\n',
  );

  const headers = ['band', 'findings', 'correct', 'accuracy'];
  const bandStats = CONFIDENCE_BANDS.map((band) => {
    const inBand = allFindingStats.filter(
      (s) => s.confidence >= band.min && s.confidence < band.max,
    );
    const correct = inBand.filter((s) => s.correct).length;
    const accuracy = inBand.length > 0 ? correct / inBand.length : null;
    return {
      label: band.label,
      total: inBand.length,
      correct,
      accuracy,
    };
  });

  const stringRows = bandStats.map((s) => [
    s.label,
    String(s.total),
    String(s.correct),
    s.accuracy === null ? 'n/a (no data)' : `${(s.accuracy * 100).toFixed(1)}%`,
  ]);

  const widths = headers.map((h, i) =>
    Math.max(h.length, ...stringRows.map((r) => r[i].length)),
  );
  const renderRow = (cells) =>
    cells.map((cell, i) => cell.padEnd(widths[i])).join('  ');

  console.log(renderRow(headers));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of stringRows) {
    console.log(renderRow(row));
  }

  // ── Monotonicity check ───────────────────────────────────────────────────
  // Higher confidence bands should have >= accuracy than lower bands.
  // We compare adjacent bands (highest first).

  console.log('\n--- Monotonicity check (higher confidence → higher accuracy) ---\n');

  const bandsWithData = bandStats.filter((b) => b.accuracy !== null);

  if (bandsWithData.length < 2) {
    console.log('Not enough data across bands to check monotonicity.');
    return;
  }

  let allMonotone = true;
  // bandsWithData is ordered highest-band-first (CONFIDENCE_BANDS order)
  for (let i = 0; i < bandsWithData.length - 1; i++) {
    const higher = bandsWithData[i];
    const lower = bandsWithData[i + 1];
    // Allow a tiny tolerance for floating-point imprecision
    const isMonotone = higher.accuracy >= lower.accuracy - 0.001;
    const status = isMonotone ? 'OK' : 'VIOLATION';
    console.log(
      `  ${higher.label} (${(higher.accuracy * 100).toFixed(1)}%) ` +
        `>= ${lower.label} (${(lower.accuracy * 100).toFixed(1)}%): ${status}`,
    );
    if (!isMonotone) allMonotone = false;
  }

  if (allMonotone) {
    console.log('\nMonotonicity: PASS — confidence scores are well-ordered.');
  } else {
    console.log(
      '\nMonotonicity: WARN — some bands violate monotonicity.' +
        '\nThis may indicate miscalibrated scoring constants or insufficient data.' +
        '\nReview src/investigators/hypothesis-ranker.ts scoring weights.',
    );
  }

  // ── Expected-category prevalence ────────────────────────────────────────
  // Differential diagnosis intentionally includes competing alternatives, so
  // this is not an overall diagnosis-accuracy metric. It is useful only as a
  // supporting calibration signal: the expected root category should be more
  // concentrated in higher-confidence bands.
  const totalAll = allFindingStats.length;
  const correctAll = allFindingStats.filter((s) => s.correct).length;
  if (totalAll > 0) {
    console.log(
      `\nExpected-category share across all competing findings: ` +
        `${correctAll}/${totalAll} = ${((correctAll / totalAll) * 100).toFixed(1)}%`,
    );
  }
}

// ---------------------------------------------------------------------------
// Bundle creation
// ---------------------------------------------------------------------------

async function createScenarioBundle(tmpDir, scenarioName) {
  const scenarioDir = path.join(repoRoot, 'test', 'fixtures', 'scenarios', scenarioName);
  const bundlePath = path.join(tmpDir, `${scenarioName}.tar.gz`);

  await tar.c(
    {
      gzip: true,
      file: bundlePath,
      cwd: path.dirname(scenarioDir),
    },
    [path.basename(scenarioDir)],
  );

  return bundlePath;
}

// ---------------------------------------------------------------------------
// CLI runner
// ---------------------------------------------------------------------------

function runCli(bundlePath, mode) {
  const args = [cliEntry, 'analyze', bundlePath, '--format', 'json'];
  if (mode === 'heuristic') {
    args.push('--no-ai');
  }

  const start = process.hrtime.bigint();
  const proc = spawnSync(process.execPath, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: process.env,
  });
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;

  if (proc.status !== 0) {
    throw new Error(
      `CLI failed for ${path.basename(bundlePath)} (${mode})\n` +
        `stdout:\n${proc.stdout}\n\nstderr:\n${proc.stderr}`,
    );
  }

  const report = parseJson(proc.stdout);
  const findings = Array.isArray(report.findings) ? report.findings : [];
  const hypothesisFindings = findings.filter((finding) =>
    String(finding.id).startsWith('finding:hypothesis:'),
  );
  const aiFindings = findings.filter((finding) =>
    String(finding.id).startsWith('finding:ai:'),
  );

  return {
    elapsedMs,
    findings,
    hypothesisFindings,
    aiFindings,
    topCategory: inferTopCategory(findings),
    topConfidence: findings[0]?.confidence ?? 0,
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  try {
    await fs.access(cliEntry);
  } catch {
    console.error('Build output not found at dist/cli/run.js. Run `npm run build` first.');
    process.exit(1);
  }

  const aiEnabled = Boolean(process.env.OPENAI_API_KEY);
  const modes = aiEnabled ? ['heuristic', 'ai'] : ['heuristic'];
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sbi-benchmark-'));

  try {
    const rows = [];

    // Collect per-finding confidence/correctness data for calibration analysis
    /** @type {Array<{confidence: number, correct: boolean, scenario: string, mode: string, category: string}>} */
    const allFindingStats = [];

    for (const scenario of SCENARIOS) {
      const bundlePath = await createScenarioBundle(tmpDir, scenario.name);

      for (const mode of modes) {
        const result = runCli(bundlePath, mode);

        rows.push({
          scenario: scenario.name,
          mode,
          elapsedMs: result.elapsedMs,
          topCategory: result.topCategory,
          topConfidence: result.topConfidence,
          correctTop1: result.topCategory === scenario.expectedTopCategory,
          totalFindings: result.findings.length,
          hypothesisFindings: result.hypothesisFindings.length,
          aiFindings: result.aiFindings.length,
        });

        // Collect per-finding data for confidence calibration (7.7)
        for (const finding of result.findings) {
          const confidence = typeof finding.confidence === 'number' ? finding.confidence : 0;
          const category = inferFindingCategory(finding);
          const correct = category === scenario.expectedTopCategory;
          allFindingStats.push({
            confidence,
            correct,
            scenario: scenario.name,
            mode,
            category,
          });
        }
      }
    }

    // ── Main results table ─────────────────────────────────────────────────
    console.log('--- Scenario results ---\n');
    printTable(rows);

    // ── Confidence calibration (7.7) ───────────────────────────────────────
    printConfidenceCalibration(allFindingStats);

    const correctTop1 = rows.filter((row) => row.correctTop1).length;
    console.log(
      `\nScenario top-1 accuracy: ${correctTop1}/${rows.length} = ` +
        `${((correctTop1 / rows.length) * 100).toFixed(1)}%`,
    );
    if (correctTop1 !== rows.length) {
      throw new Error('Top-1 diagnosis benchmark failed.');
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
