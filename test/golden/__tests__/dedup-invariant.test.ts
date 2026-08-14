// ---------------------------------------------------------------------------
// Dedup Invariant Test
// ---------------------------------------------------------------------------
//
// Structural assertions that run across every scenario and verify the
// pipeline never emits duplicate findings for the same concrete component.
//
// Namespace alone is intentionally not an incident identity: independent pods
// in one namespace may have the same failure family. Dedup and suppression
// therefore require a shared component (or a graph relationship covered by
// focused orchestrator tests).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { analyzeBundlePipeline, cleanupPipelineResult } from '../../../src/pipeline/analyze.js';
import type { PipelineResult } from '../../../src/pipeline/analyze.js';
import type { Finding } from '../../../src/types/index.js';
import { createTestBundle, getFixturePath } from '../../helpers/create-test-bundle.js';
import { GOLDEN_EXPECTATIONS } from '../expectations.js';

// ---------------------------------------------------------------------------
// Family normalisation (mirrors orchestrator logic)
// ---------------------------------------------------------------------------

function inferFamily(finding: Finding): string {
  if (finding.id.startsWith('finding:hypothesis:')) {
    return finding.id.split(':')[2] ?? 'unknown';
  }

  const lower = finding.title.toLowerCase();
  if (lower.includes('secret') && (lower.includes('missing') || lower.includes('absent') || lower.includes('not found'))) return 'missing-secret';
  if (lower.includes('dns') || lower.includes('no such host') || lower.includes('resolution fail')) return 'dns-failure';
  if (lower.includes('imagepullbackoff') || lower.includes('errimagepull') || lower.includes('image pull') || lower.includes('bad image tag') || lower.includes('image tag')) return 'image-pull-failure';
  if (lower.includes('crashloopbackoff') || lower.includes('crashloop') || lower.includes('crash loop')) return 'crashloop';
  if (lower.includes('oomkill') || lower.includes('oom kill') || lower.includes('out of memory')) return 'oom-kill';
  if ((lower.includes('volume') || lower.includes('pvc') || lower.includes('persistentvolume')) && (lower.includes('fail') || lower.includes('pending') || lower.includes('provision'))) return 'volume-mount-failure';
  if (lower.includes('not ready') || lower.includes('notready')) return 'notready';
  if (lower.includes('connection') && (lower.includes('timeout') || lower.includes('refused') || lower.includes('fail'))) return 'connectivity-failure';
  if (lower.includes('networkpolicy') || lower.includes('network policy')) return 'network-policy';
  if (lower.includes('endpoint')) return 'no-endpoints';
  if (lower.includes('pending pod') || lower.includes('scheduling')) return 'pending';
  if (lower.includes('taint')) return 'taint';
  if (lower.includes('memory') && lower.includes('pressure')) return 'memory-pressure';
  return 'other';
}

/**
 * Specific families where duplicates indicate a dedup bug.
 * Generic/catch-all families like 'other' or 'crashloop' (symptom, not
 * root cause) are excluded — multiple findings with those are expected.
 */
const DEDUP_ENFORCED_FAMILIES = new Set([
  'missing-secret',
  'dns-failure',
  'image-pull-failure',
  'oom-kill',
  'volume-mount-failure',
  'network-policy',
]);

function extractNamespace(finding: Finding): string {
  for (const component of finding.affectedComponents) {
    const parts = component.split('/');
    if (parts.length >= 3) return parts[1] ?? '';
    if (parts.length === 2) {
      const first = parts[0] ?? '';
      if (!['Container', 'Image', 'DNS', 'NetworkPolicy', 'Node'].includes(first)) {
        return first;
      }
    }
  }
  return '';
}

function extractPrimaryComponent(finding: Finding): string {
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
    const component = finding.affectedComponents.find((candidate) =>
      candidate.startsWith(prefix),
    );
    if (component) return component;
  }
  return finding.affectedComponents[0] ?? finding.id;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let tmpDir: string;
const results: Record<string, PipelineResult> = {};

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbi-dedup-invariant-'));

  for (const scenario of Object.keys(GOLDEN_EXPECTATIONS)) {
    const bundlePath = await createTestBundle(
      getFixturePath(scenario),
      path.join(tmpDir, `${scenario}.tar.gz`),
    );
    results[scenario] = await analyzeBundlePipeline(bundlePath, { noAi: true });
  }
});

afterAll(async () => {
  for (const result of Object.values(results)) {
    await cleanupPipelineResult(result);
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Invariant tests
// ---------------------------------------------------------------------------

describe('Dedup invariant: no duplicate (component, family) pairs', () => {
  for (const scenario of Object.keys(GOLDEN_EXPECTATIONS)) {
    it(`${scenario}: no two findings share a dedup-enforced (component, family) pair`, () => {
      const result = results[scenario]!;
      const seen = new Map<string, string>(); // key → finding id

      for (const finding of result.findings) {
        const family = inferFamily(finding);
        if (!DEDUP_ENFORCED_FAMILIES.has(family)) continue;

        const namespace = extractNamespace(finding);
        const component = extractPrimaryComponent(finding);
        const key = `${namespace}::${component}::${family}`;
        const existing = seen.get(key);
        if (existing && existing !== finding.id) {
          expect.fail(
            `Dedup violation in "${scenario}": two findings share key "${key}":\n` +
            `  1) ${existing}\n` +
            `  2) ${finding.id}\n` +
            `Both have family "${family}" on primary component "${component}".`,
          );
        }
        seen.set(key, finding.id);
      }
    });
  }
});

describe('Dedup invariant: generic-crash suppression is component-specific', () => {
  for (const scenario of Object.keys(GOLDEN_EXPECTATIONS)) {
    it(`${scenario}: no generic-crash finding when a specific root cause covers the same component`, () => {
      const result = results[scenario]!;

      // Collect concrete components covered by specific root causes. A root
      // elsewhere in the same namespace must not suppress an independent pod.
      const specificComponents = new Set<string>();
      for (const f of result.findings) {
        const family = inferFamily(f);
        if (DEDUP_ENFORCED_FAMILIES.has(family)) {
          for (const component of f.affectedComponents) {
            specificComponents.add(component);
          }
        }
      }

      // Check for generic-crash findings on those exact components. Structural
      // graph-neighbour suppression is covered by orchestrator unit fixtures.
      for (const f of result.findings) {
        if (inferFamily(f) !== 'generic-crash') continue;
        const overlappingComponent = f.affectedComponents.find((component) =>
          specificComponents.has(component),
        );
        if (overlappingComponent) {
          expect.fail(
            `Generic-crash finding "${f.id}" should have been suppressed in "${scenario}" ` +
            `because component "${overlappingComponent}" has a specific root-cause finding.`,
          );
        }
      }
    });
  }
});
