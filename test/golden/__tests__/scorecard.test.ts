import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { analyzeBundlePipeline, cleanupPipelineResult } from '../../../src/pipeline/analyze.js';
import type { PipelineResult } from '../../../src/pipeline/analyze.js';
import { createTestBundle, getFixturePath } from '../../helpers/create-test-bundle.js';
import { GOLDEN_EXPECTATIONS } from '../expectations.js';
import { buildEvalReport, evaluateScenario } from '../evaluate.js';
import { generateScorecard } from '../scorecard.js';

let tmpDir: string;
const results: Record<string, PipelineResult> = {};

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbi-scorecard-'));

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

describe('Golden Evaluation: scorecard', () => {
  it('generates a markdown scorecard with a machine-readable JSON summary', () => {
    const scenarioResults: Record<string, ReturnType<typeof evaluateScenario>> = {};

    for (const [scenario, expectation] of Object.entries(GOLDEN_EXPECTATIONS)) {
      scenarioResults[scenario] = evaluateScenario(scenario, expectation, results[scenario]!.findings);
    }

    const report = buildEvalReport(scenarioResults);
    const scorecard = generateScorecard(report);

    expect(scorecard).toContain('# Golden Eval Scorecard');
    expect(scorecard).toContain(
      '| Scenario | Pass/Fail | Score% | Top Finding | Expected Pattern | Confidence | Evidence Count | Heuristic/AI |',
    );
    expect(scorecard).toContain('| --- | --- | ---: | --- | --- | ---: | ---: | --- |');
    expect(scorecard).toContain('## JSON Summary');
    expect(scorecard).not.toContain('undefined');

    for (const scenario of Object.keys(GOLDEN_EXPECTATIONS)) {
      expect(scorecard).toContain(`| ${scenario} |`);
    }

    const jsonBlockMatch = scorecard.match(/```json\n([\s\S]+?)\n```/);
    expect(jsonBlockMatch).not.toBeNull();

    const summary = JSON.parse(jsonBlockMatch![1]!) as {
      overallScore: number;
      scenarioCount: number;
      scenarios: Array<{ scenario: string }>;
    };

    expect(summary.scenarioCount).toBe(Object.keys(GOLDEN_EXPECTATIONS).length);
    expect(summary.scenarios).toHaveLength(Object.keys(GOLDEN_EXPECTATIONS).length);
    expect(summary.overallScore).toBeGreaterThan(0.9);
  });
});
