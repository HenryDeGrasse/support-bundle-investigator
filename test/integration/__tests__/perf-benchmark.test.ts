import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { analyzeBundlePipeline, cleanupPipelineResult } from '../../../src/pipeline/analyze.js';
import { createTestBundle, getFixturePath } from '../../helpers/create-test-bundle.js';
import type { InvestigationTrace, TraceStep } from '../../../src/pipeline/trace.js';

let tmpDir: string;
let bundlePath: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbi-perf-'));
  bundlePath = await createTestBundle(
    getFixturePath('wrong-db-endpoint'),
    path.join(tmpDir, 'wrong-db-endpoint.tar.gz'),
  );
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function durationMs(startedAt: string, completedAt: string): number {
  return Date.parse(completedAt) - Date.parse(startedAt);
}

function stepDurationMs(step: TraceStep): number {
  expect(step.completedAt).toBeDefined();
  return durationMs(step.startedAt, step.completedAt!);
}

function traceDurationMs(trace: InvestigationTrace): number {
  expect(trace.completedAt).toBeDefined();
  return durationMs(trace.startedAt, trace.completedAt!);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted[middle] ?? 0;
}

describe('Pipeline performance benchmark', () => {
  it(
    'completes three heuristic-only runs within generous CI throughput ceilings',
    async () => {
      const warmupResult = await analyzeBundlePipeline(bundlePath, { noAi: true });
      await cleanupPipelineResult(warmupResult);

      const wallClockDurations: number[] = [];
      const traceDurations: number[] = [];
      const stepDurationSets: Array<Array<{ name: string; durationMs: number }>> = [];

      for (let run = 0; run < 3; run++) {
        const startedAt = Date.now();
        const result = await analyzeBundlePipeline(bundlePath, { noAi: true });
        const completedAt = Date.now();

        try {
          const wallClockMs = completedAt - startedAt;
          const traceMs = traceDurationMs(result.trace);
          const stepDurations = result.trace.steps.map((step) => ({
            name: step.name,
            durationMs: stepDurationMs(step),
          }));

          wallClockDurations.push(wallClockMs);
          traceDurations.push(traceMs);
          stepDurationSets.push(stepDurations);

          expect(result.findings.length).toBeGreaterThan(0);
          expect(wallClockMs).toBeLessThan(10_000);
          expect(traceMs).toBeLessThan(10_000);

          for (const step of stepDurations) {
            expect(step.durationMs).toBeGreaterThanOrEqual(0);
            expect(step.durationMs).toBeLessThan(5_000);
          }
        } finally {
          await cleanupPipelineResult(result);
        }
      }

      const maxWallClock = Math.max(...wallClockDurations);
      const medianWallClock = median(wallClockDurations);
      const maxTrace = Math.max(...traceDurations);
      const medianTrace = median(traceDurations);

      expect(medianWallClock).toBeGreaterThan(0);
      // Ratio-only checks are unstable when runs complete in a few
      // milliseconds: one scheduler pause can look like a 2x regression while
      // absolute throughput remains excellent. Keep the 2x ceiling for slower
      // runs and allow up to 100 ms of fixed jitter for fast ones.
      expect(maxWallClock).toBeLessThanOrEqual(
        Math.max(medianWallClock * 2, medianWallClock + 100),
      );
      expect(medianTrace).toBeGreaterThanOrEqual(0);
      if (medianTrace > 0) {
        expect(maxTrace).toBeLessThanOrEqual(
          Math.max(medianTrace * 2, medianTrace + 100),
        );
      }

      expect(stepDurationSets).toHaveLength(3);
      for (const stepDurations of stepDurationSets) {
        expect(stepDurations.length).toBeGreaterThan(0);
      }
    },
    30_000,
  );
});
