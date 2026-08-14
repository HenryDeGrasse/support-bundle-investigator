#!/usr/bin/env node

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as tar from 'tar';

import {
  analyzeBundlePipeline,
  cleanupPipelineResult,
} from '../dist/index.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturesRoot = path.join(projectRoot, 'test', 'fixtures', 'scenarios');
const scenarios = ['bad-image-tag', 'missing-secret-crashloop'];
const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sbi-record-cassettes-'));
const report = { recordedAt: new Date().toISOString(), scenarios: {} };

if (process.env.SBI_AI_MODE !== 'record') {
  throw new Error('Set SBI_AI_MODE=record before recording cassettes');
}
if (!process.env.OPENAI_API_KEY && process.env.SBI_LLM_BACKEND !== 'local') {
  throw new Error('OPENAI_API_KEY is required for cloud cassette recording');
}

try {
  for (const scenario of scenarios) {
    const scenarioDir = path.join(fixturesRoot, scenario);
    const bundlePath = path.join(temporaryRoot, `${scenario}.tar.gz`);
    await tar.c(
      {
        cwd: path.dirname(scenarioDir),
        file: bundlePath,
        gzip: true,
      },
      [path.basename(scenarioDir)],
    );

    const result = await analyzeBundlePipeline(bundlePath);
    try {
      const aiFindingCount = result.findings.filter((finding) =>
        finding.id.startsWith('finding:ai:'),
      ).length;
      if (aiFindingCount === 0) {
        throw new Error(`No AI findings were recorded for ${scenario}`);
      }
      report.scenarios[scenario] = {
        aiFindingCount,
        findingCount: result.findings.length,
      };
      console.log(`${scenario}: recorded ${aiFindingCount} AI findings`);
    } finally {
      await cleanupPipelineResult(result);
    }
  }

  const reportPath = path.join(
    projectRoot,
    'test',
    'golden',
    'cassette-record-report.json',
  );
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`Cassette recording report: ${reportPath}`);
} finally {
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}
