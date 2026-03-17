import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { analyzeBundlePipeline, cleanupPipelineResult } from '../../../src/pipeline/analyze.js';
import { createTestBundle, getFixturePath } from '../../helpers/create-test-bundle.js';

let tmpDir: string;
let wrongDbBundlePath: string;
let realisticFormatBundlePath: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbi-real-bundle-'));

  wrongDbBundlePath = await createTestBundle(
    getFixturePath('wrong-db-endpoint'),
    path.join(tmpDir, 'wrong-db-endpoint.tar.gz'),
  );

  realisticFormatBundlePath = await createTestBundle(
    getFixturePath('realistic-bundle-format'),
    path.join(tmpDir, 'realistic-bundle-format.tar.gz'),
  );
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function runPipeline(bundlePath: string) {
  const result = await analyzeBundlePipeline(bundlePath, { noAi: true });
  afterAll(() => cleanupPipelineResult(result));
  return result;
}

describe('Real bundle regression corpus', () => {
  it('wrong-db-endpoint archive ranks dns-failure above generic connectivity-failure', async () => {
    const result = await runPipeline(wrongDbBundlePath);
    const topHypothesis = result.findings.find((finding) =>
      finding.id.startsWith('finding:hypothesis:'),
    );

    expect(topHypothesis).toBeDefined();
    expect(topHypothesis!.id).toContain('finding:hypothesis:dns-failure:');
  });

  it('wrong-db-endpoint archive does not emit numeric-only service evidence', async () => {
    const result = await runPipeline(wrongDbBundlePath);
    const combinedEvidence = result.findings
      .flatMap((finding) => finding.evidence)
      .map((evidence) => `${evidence.path} ${evidence.note}`)
      .join(' ');

    expect(combinedEvidence).not.toContain('cluster-resources/services/default/5432.yaml');
    expect(combinedEvidence).not.toMatch(/hostname '\s*5432\s*'/i);
    expect(combinedEvidence).not.toMatch(/service '\s*5432\s*'/i);
  });

  it('wrong-db-endpoint top hypothesis reasoning explains why it beat the runner-up', async () => {
    const result = await runPipeline(wrongDbBundlePath);
    const topHypothesis = result.findings.find((finding) =>
      finding.id.startsWith('finding:hypothesis:'),
    );

    expect(topHypothesis).toBeDefined();
    expect(topHypothesis!.reasoningSummary).toContain('Preferred over runner-up');
  });

  it('realistic Troubleshoot-format archive still parses successfully as a regression corpus bundle', async () => {
    const result = await runPipeline(realisticFormatBundlePath);

    expect(result.profile.analyzerCount).toBeGreaterThan(0);
    expect(result.profile.resourceCount).toBeGreaterThan(0);
    expect(result.profile.eventCount).toBeGreaterThan(0);
    expect(result.profile.logFileCount).toBeGreaterThan(0);
  });
});
