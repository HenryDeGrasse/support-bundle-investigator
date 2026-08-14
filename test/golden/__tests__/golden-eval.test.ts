// ---------------------------------------------------------------------------
// Priority 3: Golden Set Evaluation Tests
// ---------------------------------------------------------------------------
//
// Tests the evaluation framework itself and runs heuristic-mode findings
// through golden expectations to verify the baseline quality floor.
// Also tests the recorder infrastructure for CI/CD replay.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { analyzeBundlePipeline, cleanupPipelineResult } from '../../../src/pipeline/analyze.js';
import type { PipelineResult } from '../../../src/pipeline/analyze.js';
import { createTestBundle, getFixturePath } from '../../helpers/create-test-bundle.js';
import { GOLDEN_EXPECTATIONS } from '../expectations.js';
import { evaluateScenario, buildEvalReport } from '../evaluate.js';
import {
  CassetteRecorder,
  cassetteSeedKey,
  getRecorderMode,
} from '../../../src/ai/recorder.js';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let tmpDir: string;
const results: Record<string, PipelineResult> = {};

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbi-golden-'));

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
// Golden eval: heuristic baseline
// ---------------------------------------------------------------------------

describe('Golden Evaluation: heuristic baseline', () => {
  for (const [scenario, expectation] of Object.entries(GOLDEN_EXPECTATIONS)) {
    describe(`Scenario: ${expectation.name}`, () => {
      it('produces findings that pass golden expectations', () => {
        const result = results[scenario]!;
        const evalResult = evaluateScenario(scenario, expectation, result.findings);

        // Log failures for debugging
        const failures = evalResult.checks.filter((c) => !c.pass);
        if (failures.length > 0) {
          console.log(`[${scenario}] Failed checks:`, failures.map((f) => `${f.check}: ${f.detail}`));
        }

        expect(evalResult.pass).toBe(true);
      });

      it(`has >= ${expectation.minFindings} findings`, () => {
        const result = results[scenario]!;
        expect(result.findings.length).toBeGreaterThanOrEqual(expectation.minFindings);
      });

      it(`has <= ${expectation.maxFindings} findings (dedup ceiling)`, () => {
        const result = results[scenario]!;
        expect(result.findings.length).toBeLessThanOrEqual(expectation.maxFindings);
      });

      it('top finding matches expected pattern', () => {
        const result = results[scenario]!;
        const top = result.findings[0]!;
        const matched = expectation.topFindingMustMatch.some((re) => re.test(top.title));
        expect(matched).toBe(true);
      });

      it('top finding has expected severity', () => {
        const result = results[scenario]!;
        const top = result.findings[0]!;
        expect(expectation.topFindingSeverity).toContain(top.severity);
      });

      it('top finding meets minimum confidence', () => {
        const result = results[scenario]!;
        const top = result.findings[0]!;
        expect(top.confidence).toBeGreaterThanOrEqual(expectation.topFindingMinConfidence);
      });

      it('no hallucinated content in findings', () => {
        const result = results[scenario]!;
        const fullText = result.findings
          .map((f) => `${f.title} ${f.reasoningSummary}`)
          .join(' ');

        for (const pattern of expectation.mustNotHallucinate) {
          expect(pattern.test(fullText)).toBe(false);
        }
      });

      it('root cause reasoning matches expected pattern', () => {
        const result = results[scenario]!;
        const rootCause = result.findings[0]!.reasoningSummary;
        const matched = expectation.rootCauseMustMatch.some((re) => re.test(rootCause));
        expect(matched).toBe(true);
      });

      for (const id of expectation.mustMentionIdentifiers) {
        it(`mentions required identifier: ${id}`, () => {
          const result = results[scenario]!;
          const fullText = result.findings
            .map((f) => [
              f.title,
              f.reasoningSummary,
              ...f.evidence.map((e) => `${e.path} ${e.note}`),
            ].join(' '))
            .join(' ')
            .toLowerCase();

          expect(fullText).toContain(id.toLowerCase());
        });
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Eval report builder
// ---------------------------------------------------------------------------

describe('Golden Evaluation: report builder', () => {
  it('builds a complete eval report from all scenarios', () => {
    const scenarioResults: Record<string, ReturnType<typeof evaluateScenario>> = {};

    for (const [scenario, expectation] of Object.entries(GOLDEN_EXPECTATIONS)) {
      scenarioResults[scenario] = evaluateScenario(scenario, expectation, results[scenario]!.findings);
    }

    const report = buildEvalReport(scenarioResults);

    expect(report.timestamp).toBeDefined();
    expect(report.overallPass).toBe(true);
    expect(report.overallScore).toBeGreaterThan(0.8);
    expect(Object.keys(report.scenarios)).toHaveLength(Object.keys(GOLDEN_EXPECTATIONS).length);
  });
});

// ---------------------------------------------------------------------------
// Cassette recorder infrastructure
// ---------------------------------------------------------------------------

describe('Cassette Recorder', () => {
  it('generates stable seed keys from seed identity', () => {
    const key1 = cassetteSeedKey('seed:pod:0', 'kubernetes');
    const key2 = cassetteSeedKey('seed:pod:0', 'kubernetes');
    expect(key1).toBe(key2);
  });

  it('generates different keys for different seeds', () => {
    const key1 = cassetteSeedKey('seed:pod:0', 'kubernetes');
    const key2 = cassetteSeedKey('seed:pod:1', 'kubernetes');
    expect(key1).not.toBe(key2);
  });

  it('generates different keys for different categories', () => {
    const key1 = cassetteSeedKey('seed:test:0', 'kubernetes');
    const key2 = cassetteSeedKey('seed:test:0', 'log');
    expect(key1).not.toBe(key2);
  });

  it('does not collide when identity fields contain the old delimiter', () => {
    const request = { system: 'system', user: 'user' };
    const key1 = cassetteSeedKey('seed::category', 'log', request, 'gpt-4o');
    const key2 = cassetteSeedKey('seed', 'category::log', request, 'gpt-4o');
    expect(key1).not.toBe(key2);
  });

  it('getRecorderMode defaults to live', () => {
    const original = process.env['SBI_AI_MODE'];
    delete process.env['SBI_AI_MODE'];
    expect(getRecorderMode()).toBe('live');
    if (original !== undefined) process.env['SBI_AI_MODE'] = original;
  });

  it('records and replays a cassette in memory', () => {
    const recorder = new CassetteRecorder('record', '/tmp/test-cassettes');

    recorder.record(
      'seed:pod:0',
      'kubernetes',
      { system: 'system prompt', user: 'user prompt' },
      { findings: [], rawResponse: '{}' },
      'gpt-4o',
    );

    expect(recorder.size).toBe(1);

    const cassette = recorder.replay('seed:pod:0', 'kubernetes');
    expect(cassette).toBeDefined();
    expect(cassette!.seedId).toBe('seed:pod:0');
    expect(cassette!.model).toBe('gpt-4o');
  });

  it('keeps distinct prompts for the same seed without overwriting', () => {
    const recorder = new CassetteRecorder('record', '/tmp/test-cassettes');
    const requestA = { system: 'system', user: 'scenario A' };
    const requestB = { system: 'system', user: 'scenario B' };

    recorder.record(
      'seed:pod:0',
      'kubernetes',
      requestA,
      { findings: [], rawResponse: '{"scenario":"A"}' },
      'gpt-4o',
    );
    recorder.record(
      'seed:pod:0',
      'kubernetes',
      requestB,
      { findings: [], rawResponse: '{"scenario":"B"}' },
      'gpt-4o',
    );

    expect(recorder.size).toBe(2);
    expect(
      recorder.replay('seed:pod:0', 'kubernetes', requestA, 'gpt-4o')
        ?.response.rawResponse,
    ).toBe('{"scenario":"A"}');
    expect(
      recorder.replay('seed:pod:0', 'kubernetes', requestB, 'gpt-4o')
        ?.response.rawResponse,
    ).toBe('{"scenario":"B"}');
    expect(recorder.replay('seed:pod:0', 'kubernetes')).toBeUndefined();
  });

  it('returns undefined for missing cassette', () => {
    const recorder = new CassetteRecorder('replay', '/tmp/test-cassettes');
    expect(recorder.replay('nonexistent', 'kubernetes')).toBeUndefined();
  });

  it('does not record in replay mode', () => {
    const recorder = new CassetteRecorder('replay', '/tmp/test-cassettes');
    recorder.record(
      'seed:pod:0',
      'kubernetes',
      { system: '', user: '' },
      { findings: [], rawResponse: '{}' },
      'gpt-4o',
    );
    expect(recorder.size).toBe(0);
  });

  it('round-trips cassettes through flush and load', async () => {
    const cassetteDir = path.join(tmpDir, 'cassettes-roundtrip');
    const recorder = new CassetteRecorder('record', cassetteDir);

    recorder.record(
      'seed:test:0',
      'log',
      { system: 'sys', user: 'usr' },
      { findings: [{ title: 'test', severity: 'high', confidence: 0.5, affectedComponents: [], reasoningSummary: 'r', evidence: [{ path: 'p', note: 'n' }], contradictionsChecked: [], recommendedAction: 'a', missingEvidence: [] }], rawResponse: '{"findings":[]}' },
      'gpt-4o',
    );

    await recorder.flush();

    // Load into a fresh recorder
    const loader = new CassetteRecorder('replay', cassetteDir);
    await loader.load();

    expect(loader.size).toBe(1);
    const cassette = loader.replay('seed:test:0', 'log');
    expect(cassette).toBeDefined();
    expect(cassette!.response.findings).toHaveLength(1);
    expect(cassette!.response.findings[0]!.title).toBe('test');
  });

  it('merges existing recordings and replaces the store atomically', async () => {
    const cassetteDir = path.join(tmpDir, 'cassettes-merge');
    const first = new CassetteRecorder('record', cassetteDir);
    first.record(
      'seed:first',
      'log',
      { system: 'sys', user: 'first' },
      { findings: [], rawResponse: 'first' },
      'gpt-4o',
    );
    await first.flush();

    const second = new CassetteRecorder('record', cassetteDir);
    second.record(
      'seed:second',
      'kubernetes',
      { system: 'sys', user: 'second' },
      { findings: [], rawResponse: 'second' },
      'gpt-4o',
    );
    await second.flush();

    const loader = new CassetteRecorder('replay', cassetteDir);
    await loader.load();
    expect(loader.size).toBe(2);
    expect(loader.has('seed:first', 'log')).toBe(true);
    expect(loader.has('seed:second', 'kubernetes')).toBe(true);
    expect(
      fs.readdirSync(cassetteDir).filter((name) => name.endsWith('.tmp')),
    ).toHaveLength(0);
  });

  it('redacts credentials from requests and echoed responses before persistence', async () => {
    const cassetteDir = path.join(tmpDir, 'cassettes-redacted');
    const recorder = new CassetteRecorder('record', cassetteDir);
    const credential = ['sk', 'proj', 'abcdefghijklmnopqrstuvwxyz123456'].join('-');

    recorder.record(
      'seed:sensitive',
      'log',
      { system: 'Investigate safely', user: `api-key=${credential}` },
      {
        findings: [{
          title: `Leaked credential ${credential}`,
          severity: 'high',
          confidence: 0.9,
          affectedComponents: ['Pod/default/app'],
          reasoningSummary: `The response echoed api-key=${credential}`,
          evidence: [{ path: 'app.log', note: `token=${credential}` }],
          contradictionsChecked: [],
          recommendedAction: `Rotate ${credential}`,
          missingEvidence: [],
        }],
        rawResponse: `{"api-key":"${credential}"}`,
      },
      'gpt-4o',
    );
    await recorder.flush();

    const persisted = fs.readFileSync(
      path.join(cassetteDir, 'cassettes.json'),
      'utf8',
    );
    expect(persisted).not.toContain(credential);
    expect(persisted).toContain('[REDACTED]');
  });

  it('load handles missing cassette file gracefully', async () => {
    const recorder = new CassetteRecorder('replay', '/nonexistent/path');
    await recorder.load();
    expect(recorder.size).toBe(0);
  });

  it('has() checks cassette existence', () => {
    const recorder = new CassetteRecorder('record', '/tmp/test');
    recorder.record('seed:a:0', 'kubernetes', { system: '', user: '' }, { findings: [], rawResponse: '{}' }, 'gpt-4o');
    expect(recorder.has('seed:a:0', 'kubernetes')).toBe(true);
    expect(recorder.has('seed:b:0', 'kubernetes')).toBe(false);
  });

  it('keys() returns all stored cassette keys', () => {
    const recorder = new CassetteRecorder('record', '/tmp/test');
    recorder.record('seed:a:0', 'kubernetes', { system: '', user: '' }, { findings: [], rawResponse: '{}' }, 'gpt-4o');
    recorder.record('seed:b:0', 'log', { system: '', user: '' }, { findings: [], rawResponse: '{}' }, 'gpt-4o');
    expect(recorder.keys()).toHaveLength(2);
  });
});
