/**
 * Output quality verification tests for all four scenarios.
 *
 * These tests assert the ideal output quality described in the plan:
 * - Clean finding titles (no [Hypothesis] prefix, no (symptom:...) suffix)
 * - Bundle-relative evidence paths (no absolute temp paths)
 * - Correct top-1 hypothesis categories
 * - Appropriate finding counts
 * - Correct suppression / preservation of symptom findings
 * - Findings sorted by severity, diagnostic role, then confidence
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  analyzeBundlePipeline,
  cleanupPipelineResult,
  type PipelineResult,
} from '../../../src/pipeline/analyze.js';
import type { Finding } from '../../../src/types/index.js';
import { compareFindingsForDisplay } from '../../../src/investigators/orchestrator.js';
import { createTestBundle, getFixturePath } from '../../helpers/create-test-bundle.js';

// ---------------------------------------------------------------------------
// Setup — build .tar.gz archives for each scenario once
// ---------------------------------------------------------------------------

let tmpDir: string;
let wrongDbBundlePath: string;
let missingSecretBundlePath: string;
let badImageTagBundlePath: string;
let pvcPendingBundlePath: string;
let scenarioResults: Record<string, PipelineResult>;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbi-quality-'));

  wrongDbBundlePath = await createTestBundle(
    getFixturePath('wrong-db-endpoint'),
    path.join(tmpDir, 'wrong-db-endpoint.tar.gz'),
  );

  missingSecretBundlePath = await createTestBundle(
    getFixturePath('missing-secret-crashloop'),
    path.join(tmpDir, 'missing-secret-crashloop.tar.gz'),
  );

  badImageTagBundlePath = await createTestBundle(
    getFixturePath('bad-image-tag'),
    path.join(tmpDir, 'bad-image-tag.tar.gz'),
  );

  pvcPendingBundlePath = await createTestBundle(
    getFixturePath('pvc-pending'),
    path.join(tmpDir, 'pvc-pending.tar.gz'),
  );

  const [wrongDbResult, missingSecretResult, badImageTagResult, pvcPendingResult] =
    await Promise.all([
      analyzeBundlePipeline(wrongDbBundlePath, { verbose: false }),
      analyzeBundlePipeline(missingSecretBundlePath, { verbose: false }),
      analyzeBundlePipeline(badImageTagBundlePath, { verbose: false }),
      analyzeBundlePipeline(pvcPendingBundlePath, { verbose: false }),
    ]);

  scenarioResults = {
    'wrong-db-endpoint': wrongDbResult,
    'missing-secret-crashloop': missingSecretResult,
    'bad-image-tag': badImageTagResult,
    'pvc-pending': pvcPendingResult,
  };
});

afterAll(async () => {
  if (scenarioResults != null) {
    for (const result of Object.values(scenarioResults)) {
      await cleanupPipelineResult(result);
    }
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function runPipeline(bundlePath: string): PipelineResult {
  if (bundlePath === badImageTagBundlePath) return scenarioResults['bad-image-tag']!;
  if (bundlePath === missingSecretBundlePath) return scenarioResults['missing-secret-crashloop']!;
  if (bundlePath === wrongDbBundlePath) return scenarioResults['wrong-db-endpoint']!;
  if (bundlePath === pvcPendingBundlePath) return scenarioResults['pvc-pending']!;
  throw new Error(`No cached pipeline result for bundle: ${bundlePath}`);
}

const SEVERITY_ORDER: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
};

/**
 * Infers the hypothesis category from a finding id.
 * Returns undefined for non-hypothesis findings.
 */
function inferHypothesisCategory(finding: Finding): string | undefined {
  if (!finding.id.startsWith('finding:hypothesis:')) return undefined;
  return finding.id.split(':')[2];
}

/**
 * Asserts that a finding title and its evidence paths are clean (no absolute
 * paths, no [Hypothesis] prefix, no (symptom:...) suffix).
 */
function assertClean(finding: Finding, label: string): void {
  // Title must not contain legacy machine-readable markers
  expect(
    finding.title,
    `${label}: title must not contain '[Hypothesis]'`,
  ).not.toContain('[Hypothesis]');
  expect(
    finding.title,
    `${label}: title must not contain '(symptom:'`,
  ).not.toMatch(/\(symptom:/i);

  // Title must not contain absolute extraction paths
  expect(
    finding.title,
    `${label}: title must not start with '/'`,
  ).not.toMatch(/(?:^|\s)\//);
  expect(
    finding.title,
    `${label}: title must not contain '/sbi-bundle-'`,
  ).not.toContain('/sbi-bundle-');

  // Evidence paths must be bundle-relative
  for (const ev of finding.evidence) {
    expect(
      ev.path,
      `${label}: evidence path '${ev.path}' must not start with '/'`,
    ).not.toMatch(/^\//);
    expect(
      ev.path,
      `${label}: evidence path '${ev.path}' must not contain '/sbi-bundle-'`,
    ).not.toContain('/sbi-bundle-');
  }

  // affectedComponents must not start with '/' or contain '/sbi-bundle-'
  for (const comp of finding.affectedComponents) {
    expect(
      comp,
      `${label}: affectedComponent '${comp}' must not start with '/'`,
    ).not.toMatch(/^\//);
    expect(
      comp,
      `${label}: affectedComponent '${comp}' must not contain '/sbi-bundle-'`,
    ).not.toContain('/sbi-bundle-');
  }
}

/**
 * Asserts findings are sorted by severity, diagnostic role, then confidence.
 */
function assertSorted(findings: Finding[], label: string): void {
  for (let i = 0; i < findings.length - 1; i++) {
    const current = findings[i]!;
    const next = findings[i + 1]!;
    const currentSev = SEVERITY_ORDER[current.severity] ?? 0;
    const nextSev = SEVERITY_ORDER[next.severity] ?? 0;

    expect(
      currentSev,
      `${label}: finding[${i}] severity should be >= finding[${i + 1}] severity`,
    ).toBeGreaterThanOrEqual(nextSev);
    if (currentSev === nextSev) {
      expect(
        compareFindingsForDisplay(current, next),
        `${label}: finding[${i}] should precede finding[${i + 1}] in root-aware order`,
      ).toBeLessThanOrEqual(0);
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('output quality per scenario', () => {
  // ────────────────────────────────────────────────────────────────────────
  // bad-image-tag
  // ────────────────────────────────────────────────────────────────────────
  describe('bad-image-tag scenario', () => {
    it('finding count is between 1 and 3', async () => {
      const result = await runPipeline(badImageTagBundlePath);
      expect(result.findings.length).toBeGreaterThanOrEqual(1);
      expect(result.findings.length).toBeLessThanOrEqual(3);
    });

    it('top finding is about image pull failure', async () => {
      const result = await runPipeline(badImageTagBundlePath);
      const top = result.findings[0];
      expect(top).toBeDefined();
      // Either a hypothesis with category 'image-pull-failure', a heuristic
      // finding whose title mentions image pull, or a graph root-cause finding
      // about a bad image tag (introduced by the graph-driven investigation phase).
      const isImagePull =
        top!.id.includes('image-pull-failure') ||
        top!.id.includes('bad-image-tag') ||
        top!.title.toLowerCase().includes('image pull') ||
        top!.title.toLowerCase().includes('imagepullbackoff') ||
        top!.title.toLowerCase().includes('errimagepull') ||
        top!.title.toLowerCase().includes('bad image') ||
        top!.title.toLowerCase().includes('image tag');
      expect(isImagePull, `Expected top finding to be about image pull, got: "${top!.title}"`).toBe(true);
    });

    it('no finding title contains [Hypothesis] or (symptom:', async () => {
      const result = await runPipeline(badImageTagBundlePath);
      for (const finding of result.findings) {
        expect(finding.title).not.toContain('[Hypothesis]');
        expect(finding.title).not.toMatch(/\(symptom:/i);
      }
    });

    it('no finding title or evidence path contains /sbi-bundle- or starts with /', async () => {
      const result = await runPipeline(badImageTagBundlePath);
      for (const finding of result.findings) {
        assertClean(finding, `bad-image-tag finding "${finding.title}"`);
      }
    });

    it('no affectedComponents entry starts with /', async () => {
      const result = await runPipeline(badImageTagBundlePath);
      for (const finding of result.findings) {
        for (const comp of finding.affectedComponents) {
          expect(comp).not.toMatch(/^\//);
        }
      }
    });

    it('top finding has confidence >= 0.7', async () => {
      const result = await runPipeline(badImageTagBundlePath);
      expect(result.findings[0]!.confidence).toBeGreaterThanOrEqual(0.7);
    });

    it('findings are sorted in root-aware diagnostic order', async () => {
      const result = await runPipeline(badImageTagBundlePath);
      assertSorted(result.findings, 'bad-image-tag');
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // missing-secret-crashloop
  // ────────────────────────────────────────────────────────────────────────
  describe('missing-secret-crashloop scenario', () => {
    it('a missing-secret root-cause finding is present (hypothesis or graph-causal)', async () => {
      const result = await runPipeline(missingSecretBundlePath);
      // Accept either a hypothesis finding with missing-secret category OR a
      // graph-causal finding:missing-secret:* root cause (the latter suppresses
      // the former when causal template matching confirms the root cause).
      const missingSecretFinding = result.findings.find((f) =>
        f.id.startsWith('finding:missing-secret:') ||
        (f.id.startsWith('finding:hypothesis:') && inferHypothesisCategory(f) === 'missing-secret'),
      );
      expect(
        missingSecretFinding,
        `Expected a missing-secret finding (hypothesis or graph-causal), got IDs: ${result.findings.map((f) => f.id).join(', ')}`,
      ).toBeDefined();
    });

    it('CrashLoopBackOff symptom finding is present and not suppressed', async () => {
      const result = await runPipeline(missingSecretBundlePath);
      const crashLoopFinding = result.findings.find((f) =>
        f.id.startsWith('finding:k8s:crashloop:') ||
        f.title.toLowerCase().includes('crashloopbackoff'),
      );
      expect(
        crashLoopFinding,
        'CrashLoopBackOff symptom finding should be present (not suppressed)',
      ).toBeDefined();
    });

    it('no duplicate config-error hypothesis findings with the same title', async () => {
      const result = await runPipeline(missingSecretBundlePath);
      const configErrorFindings = result.findings.filter(
        (f) => f.id.includes('config-error'),
      );
      const titles = configErrorFindings.map((f) => f.title.toLowerCase().trim());
      const uniqueTitles = new Set(titles);
      expect(
        uniqueTitles.size,
        `config-error findings should have unique titles, got ${JSON.stringify(titles)}`,
      ).toBe(titles.length);
    });

    it('titles and paths are clean (no [Hypothesis], no absolute paths)', async () => {
      const result = await runPipeline(missingSecretBundlePath);
      for (const finding of result.findings) {
        assertClean(finding, `missing-secret finding "${finding.title}"`);
      }
    });

    it('top finding has confidence >= 0.7', async () => {
      const result = await runPipeline(missingSecretBundlePath);
      expect(result.findings[0]!.confidence).toBeGreaterThanOrEqual(0.7);
    });

    it('findings are sorted in root-aware diagnostic order', async () => {
      const result = await runPipeline(missingSecretBundlePath);
      assertSorted(result.findings, 'missing-secret-crashloop');
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // wrong-db-endpoint
  // ────────────────────────────────────────────────────────────────────────
  describe('wrong-db-endpoint scenario', () => {
    it('top finding is dns-failure category', async () => {
      const result = await runPipeline(wrongDbBundlePath);
      const top = result.findings[0];
      expect(top).toBeDefined();
      // The top finding must be a hypothesis with dns-failure category
      const category = inferHypothesisCategory(top!);
      const isDnsFailure =
        category === 'dns-failure' ||
        top!.title.toLowerCase().includes('dns') ||
        top!.title.toLowerCase().includes('no such host') ||
        top!.id.includes('dns-failure');
      expect(
        isDnsFailure,
        `Top finding should be about DNS failure, got id='${top!.id}' title='${top!.title}'`,
      ).toBe(true);
    });

    it('alternative hypotheses (connectivity-failure or readiness-failure) are present', async () => {
      const result = await runPipeline(wrongDbBundlePath);
      const hasConnectivity = result.findings.some(
        (f) => inferHypothesisCategory(f) === 'connectivity-failure',
      );
      const hasReadiness = result.findings.some(
        (f) => inferHypothesisCategory(f) === 'readiness-failure',
      );
      expect(
        hasConnectivity || hasReadiness,
        'At least one alternative hypothesis (connectivity-failure or readiness-failure) should be present',
      ).toBe(true);
    });

    it('no Not Ready Pod symptom finding is present (suppressed by root-cause)', async () => {
      const result = await runPipeline(wrongDbBundlePath);
      const notReadyFinding = result.findings.find((f) =>
        f.id.startsWith('finding:k8s:notready:'),
      );
      expect(
        notReadyFinding,
        `'Not Ready Pod' finding should be suppressed when a root-cause hypothesis covers the same pod. Found: ${notReadyFinding?.title}`,
      ).toBeUndefined();
    });

    it('titles and paths are clean (no [Hypothesis], no absolute paths)', async () => {
      const result = await runPipeline(wrongDbBundlePath);
      for (const finding of result.findings) {
        assertClean(finding, `wrong-db finding "${finding.title}"`);
      }
    });

    it('top finding has confidence >= 0.7', async () => {
      const result = await runPipeline(wrongDbBundlePath);
      expect(result.findings[0]!.confidence).toBeGreaterThanOrEqual(0.7);
    });

    it('findings are sorted in root-aware diagnostic order', async () => {
      const result = await runPipeline(wrongDbBundlePath);
      assertSorted(result.findings, 'wrong-db-endpoint');
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // pvc-pending
  // ────────────────────────────────────────────────────────────────────────
  describe('pvc-pending scenario', () => {
    it('at least one finding mentions the pending pod or volume/storage issue', async () => {
      const result = await runPipeline(pvcPendingBundlePath);
      const relevant = result.findings.find((f) => {
        const lower = (f.title + ' ' + f.reasoningSummary).toLowerCase();
        return (
          lower.includes('db-pod') ||
          lower.includes('data-pvc') ||
          lower.includes('pending') ||
          lower.includes('volume') ||
          lower.includes('storage') ||
          lower.includes('pvc') ||
          lower.includes('provisioning')
        );
      });
      expect(
        relevant,
        'At least one finding should mention the pending pod or volume/storage issue',
      ).toBeDefined();
    });

    it('finding count is at least 2', async () => {
      const result = await runPipeline(pvcPendingBundlePath);
      expect(result.findings.length).toBeGreaterThanOrEqual(2);
    });

    it('a volume-mount-failure root-cause finding is present (hypothesis or graph-causal)', async () => {
      const result = await runPipeline(pvcPendingBundlePath);
      // Accept either a hypothesis with volume-mount-failure category OR a
      // graph-causal finding:missing-storage-class:* root cause.
      const volumeFinding = result.findings.find((f) =>
        f.id.startsWith('finding:missing-storage-class:') ||
        (f.id.startsWith('finding:hypothesis:') && inferHypothesisCategory(f) === 'volume-mount-failure'),
      );
      expect(
        volumeFinding,
        `Expected a volume-mount-failure finding, got IDs: ${result.findings.map((f) => f.id).join(', ')}`,
      ).toBeDefined();
    });

    it('titles and paths are clean (no [Hypothesis], no absolute paths)', async () => {
      const result = await runPipeline(pvcPendingBundlePath);
      for (const finding of result.findings) {
        assertClean(finding, `pvc-pending finding "${finding.title}"`);
      }
    });

    it('top finding has confidence >= 0.5', async () => {
      const result = await runPipeline(pvcPendingBundlePath);
      expect(result.findings[0]!.confidence).toBeGreaterThanOrEqual(0.5);
    });

    it('findings are sorted in root-aware diagnostic order', async () => {
      const result = await runPipeline(pvcPendingBundlePath);
      assertSorted(result.findings, 'pvc-pending');
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Cross-scenario quality assertions
  // ────────────────────────────────────────────────────────────────────────
  describe('cross-scenario quality', () => {
    const scenarios = [
      { name: 'bad-image-tag', getBundlePath: () => badImageTagBundlePath },
      { name: 'missing-secret-crashloop', getBundlePath: () => missingSecretBundlePath },
      { name: 'wrong-db-endpoint', getBundlePath: () => wrongDbBundlePath },
      { name: 'pvc-pending', getBundlePath: () => pvcPendingBundlePath },
    ];

    for (const scenario of scenarios) {
      it(`${scenario.name}: no finding title contains '[Hypothesis]' or '(symptom:'`, async () => {
        const result = await runPipeline(scenario.getBundlePath());
        for (const finding of result.findings) {
          expect(
            finding.title,
            `[${scenario.name}] finding "${finding.title}" should not contain '[Hypothesis]'`,
          ).not.toContain('[Hypothesis]');
          expect(
            finding.title,
            `[${scenario.name}] finding "${finding.title}" should not contain '(symptom:'`,
          ).not.toMatch(/\(symptom:/i);
        }
      });

      it(`${scenario.name}: no evidence path starts with '/' or contains '/sbi-bundle-'`, async () => {
        const result = await runPipeline(scenario.getBundlePath());
        for (const finding of result.findings) {
          for (const ev of finding.evidence) {
            expect(
              ev.path,
              `[${scenario.name}] evidence path '${ev.path}' must not start with '/'`,
            ).not.toMatch(/^\//);
            expect(
              ev.path,
              `[${scenario.name}] evidence path '${ev.path}' must not contain '/sbi-bundle-'`,
            ).not.toContain('/sbi-bundle-');
          }
        }
      });

      it(`${scenario.name}: no affectedComponents entry contains '/sbi-bundle-'`, async () => {
        const result = await runPipeline(scenario.getBundlePath());
        for (const finding of result.findings) {
          for (const comp of finding.affectedComponents) {
            expect(
              comp,
              `[${scenario.name}] affectedComponent '${comp}' must not contain '/sbi-bundle-'`,
            ).not.toContain('/sbi-bundle-');
          }
        }
      });

      it(`${scenario.name}: findings are sorted in root-aware diagnostic order`, async () => {
        const result = await runPipeline(scenario.getBundlePath());
        assertSorted(result.findings, scenario.name);
      });
    }
  });
});
