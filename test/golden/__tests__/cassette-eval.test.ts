import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { analyzeBundlePipeline, cleanupPipelineResult } from '../../../src/pipeline/analyze.js';
import { LLMClient } from '../../../src/ai/llm-client.js';
import { validateAIFindings } from '../../../src/ai/schemas.js';
import type { CassetteStore } from '../../../src/ai/recorder.js';
import { createTestBundle, getFixturePath } from '../../helpers/create-test-bundle.js';
import { GOLDEN_EXPECTATIONS } from '../expectations.js';
import { evaluateScenario } from '../evaluate.js';

const CASSETTE_DIR = path.resolve('test/fixtures/cassettes');
const CASSETTE_PATH = path.join(CASSETTE_DIR, 'cassettes.json');

const CASSETTE_SEEDS = {
  'bad-image-tag': {
    seedKey: 'kubernetes:b6a9355b38ea7fa1',
  },
  'missing-secret-crashloop': {
    seedKey: 'kubernetes:a8c090a62fa36d5e',
  },
} as const;

type ReplayScenario = keyof typeof CASSETTE_SEEDS;

const ORIGINAL_ENV = {
  SBI_AI_MODE: process.env['SBI_AI_MODE'],
  SBI_CASSETTE_DIR: process.env['SBI_CASSETTE_DIR'],
  OPENAI_API_KEY: process.env['OPENAI_API_KEY'],
};

function loadCassetteStore(): CassetteStore {
  return JSON.parse(fs.readFileSync(CASSETTE_PATH, 'utf8')) as CassetteStore;
}

async function analyzeScenario(scenario: string) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `sbi-cassette-${scenario}-`));
  const bundlePath = await createTestBundle(
    getFixturePath(scenario),
    path.join(tmpDir, `${scenario}.tar.gz`),
  );

  try {
    const result = await analyzeBundlePipeline(bundlePath);
    return { result, tmpDir };
  } catch (error) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw error;
  }
}

describe.sequential('Golden Evaluation: cassette replay AI path', () => {
  beforeAll(() => {
    process.env['SBI_AI_MODE'] = 'replay';
    process.env['SBI_CASSETTE_DIR'] = CASSETTE_DIR;
    delete process.env['OPENAI_API_KEY'];
  });

  afterAll(() => {
    if (ORIGINAL_ENV.SBI_AI_MODE === undefined) {
      delete process.env['SBI_AI_MODE'];
    } else {
      process.env['SBI_AI_MODE'] = ORIGINAL_ENV.SBI_AI_MODE;
    }

    if (ORIGINAL_ENV.SBI_CASSETTE_DIR === undefined) {
      delete process.env['SBI_CASSETTE_DIR'];
    } else {
      process.env['SBI_CASSETTE_DIR'] = ORIGINAL_ENV.SBI_CASSETTE_DIR;
    }

    if (ORIGINAL_ENV.OPENAI_API_KEY === undefined) {
      delete process.env['OPENAI_API_KEY'];
    } else {
      process.env['OPENAI_API_KEY'] = ORIGINAL_ENV.OPENAI_API_KEY;
    }
  });

  it('replays cassette-backed AI findings through the real pipeline without credentials', async () => {
    const cassetteStore = loadCassetteStore();
    const investigateSpy = vi.spyOn(LLMClient.prototype, 'investigateSeed');
    const generateTextSpy = vi.spyOn(LLMClient.prototype, 'generateText');
    const scenarios: ReplayScenario[] = ['bad-image-tag', 'missing-secret-crashloop'];
    const created: Array<{ result: Awaited<ReturnType<typeof analyzeBundlePipeline>>; tmpDir: string }> = [];

    try {
      for (const scenario of scenarios) {
        const cassette = cassetteStore.cassettes[CASSETTE_SEEDS[scenario].seedKey];
        expect(cassette).toBeDefined();
        expect(cassette?.seedId).toBeTruthy();
        expect(cassette?.seedCategory).toBeTruthy();
        expect(validateAIFindings(cassette?.response.findings ?? [])).toHaveLength(
          cassette?.response.findings.length ?? 0,
        );

        const analyzed = await analyzeScenario(scenario);
        created.push(analyzed);

        const { result } = analyzed;
        expect(result.aiMode).toBe('cloud');

        const aiFindings = result.findings.filter((finding) => finding.id.startsWith('finding:ai:'));
        expect(aiFindings.length).toBeGreaterThan(0);

        const evalResult = evaluateScenario(
          scenario,
          GOLDEN_EXPECTATIONS[scenario]!,
          result.findings,
          'ai',
        );
        if (!evalResult.pass) {
          console.log(`[cassette-eval:${scenario}] failed checks`, evalResult.checks.filter((check) => !check.pass));
        }
        expect(evalResult.pass).toBe(true);
      }

      expect(investigateSpy).not.toHaveBeenCalled();
      expect(generateTextSpy).not.toHaveBeenCalled();
    } finally {
      investigateSpy.mockRestore();
      generateTextSpy.mockRestore();
      for (const { result, tmpDir } of created) {
        await cleanupPipelineResult(result);
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    }
  });

  it('degrades gracefully to heuristic-only findings when no cassette matches', async () => {
    const investigateSpy = vi.spyOn(LLMClient.prototype, 'investigateSeed');
    const generateTextSpy = vi.spyOn(LLMClient.prototype, 'generateText');

    let analyzed: { result: Awaited<ReturnType<typeof analyzeBundlePipeline>>; tmpDir: string } | undefined;
    try {
      analyzed = await analyzeScenario('wrong-db-endpoint');
      const { result } = analyzed;

      expect(result.aiMode).toBe('cloud');
      expect(result.findings.some((finding) => finding.id.startsWith('finding:ai:'))).toBe(false);

      const evalResult = evaluateScenario(
        'wrong-db-endpoint',
        GOLDEN_EXPECTATIONS['wrong-db-endpoint']!,
        result.findings,
        'ai',
      );
      if (!evalResult.pass) {
        console.log('[cassette-eval:wrong-db-endpoint] failed checks', evalResult.checks.filter((check) => !check.pass));
      }
      expect(evalResult.pass).toBe(true);
      expect(investigateSpy).not.toHaveBeenCalled();
      expect(generateTextSpy).not.toHaveBeenCalled();
    } finally {
      investigateSpy.mockRestore();
      generateTextSpy.mockRestore();
      if (analyzed !== undefined) {
        await cleanupPipelineResult(analyzed.result);
        fs.rmSync(analyzed.tmpDir, { recursive: true, force: true });
      }
    }
  });
});
