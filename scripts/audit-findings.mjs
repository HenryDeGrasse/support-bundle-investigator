#!/usr/bin/env node
/**
 * scripts/audit-findings.mjs
 *
 * Self-test audit: runs every scenario through the heuristic pipeline,
 * checks dedup invariants, and outputs a compact machine-readable summary.
 *
 * Usage:
 *   npm run build
 *   npm run audit
 *
 * Exit code 0 = all clean.  Exit code 1 = issues found.
 *
 * Designed so an AI coding agent can run this, parse the JSON output,
 * and act on the results without a human needing to export or inspect
 * anything manually.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import * as tar from 'tar';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const distEntry = path.join(repoRoot, 'dist', 'index.mjs');

if (!fs.existsSync(distEntry)) {
  console.error('Build output not found. Run `npm run build` first.');
  process.exit(1);
}

const { analyzeBundlePipeline, cleanupPipelineResult } = await import(distEntry);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SCENARIOS_DIR = path.join(repoRoot, 'test', 'fixtures', 'scenarios');

const SCENARIOS = [
  'bad-image-tag',
  'missing-secret-crashloop',
  'wrong-db-endpoint',
  'pvc-pending',
  'ghost-service',
  'network-policy-deny',
  'node-taint-memory-pressure',
  'helm-release-failure',
  'multi-namespace-retrieval',
];

/** Families where duplicates on the same concrete component = bug. */
const DEDUP_FAMILIES = new Set([
  'missing-secret', 'dns-failure', 'image-pull-failure',
  'oom-kill', 'volume-mount-failure', 'network-policy',
]);

const KNOWN_KINDS = new Set(['Container', 'Image', 'DNS', 'NetworkPolicy', 'Node']);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function inferFamily(finding) {
  if (finding.id.startsWith('finding:hypothesis:')) return finding.id.split(':')[2] ?? 'unknown';
  const lower = (finding.title ?? '').toLowerCase();
  if (lower.includes('secret') && (lower.includes('missing') || lower.includes('absent'))) return 'missing-secret';
  if (lower.includes('dns') || lower.includes('no such host')) return 'dns-failure';
  if (lower.includes('imagepull') || lower.includes('image pull') || lower.includes('bad image tag') || lower.includes('image tag')) return 'image-pull-failure';
  if (lower.includes('crashloop')) return 'crashloop';
  if (lower.includes('oomkill') || lower.includes('out of memory')) return 'oom-kill';
  if ((lower.includes('volume') || lower.includes('pvc')) && (lower.includes('fail') || lower.includes('pending'))) return 'volume-mount-failure';
  if (lower.includes('networkpolicy') || lower.includes('network policy')) return 'network-policy';
  if (lower.includes('endpoint')) return 'no-endpoints';
  if (lower.includes('generic') && lower.includes('bug')) return 'generic-crash';
  if (lower.includes('connectivity') || lower.includes('connection')) return 'connectivity-failure';
  return 'other';
}

function extractNs(finding) {
  for (const comp of finding.affectedComponents ?? []) {
    const parts = comp.split('/');
    if (parts.length >= 3) return parts[1] ?? '';
    if (parts.length === 2 && !KNOWN_KINDS.has(parts[0])) return parts[0] ?? '';
  }
  return '';
}

function extractPrimaryComponent(finding) {
  const preferredPrefixes = [
    'Pod/',
    'Deployment/',
    'StatefulSet/',
    'DaemonSet/',
    'Secret/',
    'ConfigMap/',
    'Service/',
    'PersistentVolumeClaim/',
  ];
  for (const prefix of preferredPrefixes) {
    const component = (finding.affectedComponents ?? []).find(candidate =>
      candidate.startsWith(prefix),
    );
    if (component) return component;
  }
  return finding.affectedComponents?.[0] ?? finding.id;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const issues = [];
const scenarioSummaries = [];

for (const scenario of SCENARIOS) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `sbi-audit-${scenario}-`));
  const archivePath = path.join(tmpDir, `${scenario}.tar.gz`);

  try {
    await tar.c({ gzip: true, file: archivePath, cwd: SCENARIOS_DIR }, [scenario]);
    const result = await analyzeBundlePipeline(archivePath, { noAi: true });

    const findings = result.findings;
    const families = findings.map(f => inferFamily(f));
    const uniqueFamilies = [...new Set(families)];

    // ── Dedup check ──────────────────────────────────────────────────────
    const seen = new Map();
    const dupViolations = [];
    for (const f of findings) {
      const family = inferFamily(f);
      if (!DEDUP_FAMILIES.has(family)) continue;
      const ns = extractNs(f);
      const component = extractPrimaryComponent(f);
      const key = `${ns}::${component}::${family}`;
      if (seen.has(key)) {
        dupViolations.push({ key, first: seen.get(key), second: f.id });
      } else {
        seen.set(key, f.id);
      }
    }

    // ── Generic-crash suppression check ──────────────────────────────────
    const specificComponents = new Set();
    for (const f of findings) {
      if (DEDUP_FAMILIES.has(inferFamily(f))) {
        for (const component of f.affectedComponents ?? []) {
          specificComponents.add(component);
        }
      }
    }
    const genericCrashViolations = [];
    for (const f of findings) {
      if (inferFamily(f) !== 'generic-crash') continue;
      const component = (f.affectedComponents ?? []).find(candidate =>
        specificComponents.has(candidate),
      );
      if (component) {
        genericCrashViolations.push({ findingId: f.id, component });
      }
    }

    // ── Confidence stats ─────────────────────────────────────────────────
    const confs = findings.map(f => f.confidence);
    const minConf = Math.min(...confs);
    const maxConf = Math.max(...confs);
    const meanConf = confs.reduce((a, b) => a + b, 0) / confs.length;

    const summary = {
      scenario,
      findingCount: findings.length,
      families: uniqueFamilies,
      topFinding: findings[0]?.title ?? 'none',
      topConfidence: findings[0]?.confidence ?? 0,
      topQuality: findings[0]?.confidenceQuality ?? 'unknown',
      confidenceRange: { min: minConf, max: maxConf, mean: Math.round(meanConf * 100) / 100 },
      dupViolations: dupViolations.length,
      genericCrashViolations: genericCrashViolations.length,
      pass: dupViolations.length === 0 && genericCrashViolations.length === 0,
    };

    scenarioSummaries.push(summary);

    if (dupViolations.length > 0) {
      issues.push({ scenario, type: 'dedup-violation', details: dupViolations });
    }
    if (genericCrashViolations.length > 0) {
      issues.push({ scenario, type: 'generic-crash-not-suppressed', details: genericCrashViolations });
    }

    await cleanupPipelineResult(result);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const overallPass = issues.length === 0;

// Human-readable table
console.log('');
console.log('=== Finding Audit ===');
console.log('');
const headers = ['Scenario', '#', 'Top Finding', 'Conf', 'Quality', 'Dedup', 'Status'];
console.log(headers.map((h, i) => h.padEnd([30, 3, 50, 5, 9, 5, 6][i])).join(' '));
console.log('-'.repeat(115));
for (const s of scenarioSummaries) {
  console.log([
    s.scenario.padEnd(30),
    String(s.findingCount).padEnd(3),
    s.topFinding.slice(0, 50).padEnd(50),
    (s.topConfidence * 100).toFixed(0).padStart(3) + '%',
    (' ' + s.topQuality).padEnd(9),
    s.dupViolations === 0 ? ' ok  ' : `${s.dupViolations} DUP`,
    s.pass ? ' PASS' : ' FAIL',
  ].join(' '));
}
console.log('');
console.log(`Overall: ${overallPass ? 'PASS' : 'FAIL'} (${scenarioSummaries.filter(s => s.pass).length}/${scenarioSummaries.length} scenarios clean)`);
console.log('');

// Machine-readable JSON block
console.log('--- JSON ---');
console.log(JSON.stringify({ overallPass, scenarios: scenarioSummaries, issues }, null, 2));

process.exit(overallPass ? 0 : 1);
