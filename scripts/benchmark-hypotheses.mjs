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

function inferTopCategory(findings) {
  const top = findings[0];
  if (!top) return 'none';

  if (top.id.startsWith('finding:hypothesis:')) {
    return top.id.split(':')[2] ?? 'unknown';
  }

  const lower = `${top.title} ${top.reasoningSummary}`.toLowerCase();
  if (lower.includes('dns')) return 'dns-failure';
  if (lower.includes('secret')) return 'missing-secret';
  if (lower.includes('image')) return 'image-pull-failure';
  if (lower.includes('connect')) return 'connectivity-failure';
  return 'non-hypothesis';
}

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
      }
    }

    printTable(rows);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
