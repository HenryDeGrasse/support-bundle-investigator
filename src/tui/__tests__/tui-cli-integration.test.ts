import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { VERSION } from '../../version.js';

const repoRoot = path.resolve(__dirname, '../../..');
const cliBin = path.join(repoRoot, 'dist/cli/run.mjs');

/**
 * Integration test that spawns the actual CLI binary to verify that:
 * 1. The ESM entry point loads without CJS/ESM compatibility errors.
 * 2. The `--tui` flag is accepted.
 * 3. Non-interactive invocations fail fast with actionable guidance.
 *
 * Full App rendering is covered separately with injected terminal streams.
 */
describe('TUI CLI binary integration', () => {
  const binExists = fs.existsSync(cliBin);

  it.skipIf(!binExists)(
    'CLI binary rejects --tui cleanly when no TTY is available',
    () => {
      // Use a non-existent bundle path — we only care that ink loads,
      // not that the pipeline runs.
      const proc = spawnSync(
        process.execPath,
        [cliBin, 'analyze', '/tmp/nonexistent-bundle.tar.gz', '--tui', '--no-ai'],
        {
          cwd: repoRoot,
          encoding: 'utf-8',
          timeout: 15_000,
          env: { ...process.env, NODE_NO_WARNINGS: '1' },
        },
      );

      const combined = `${proc.stdout ?? ''}\n${proc.stderr ?? ''}`;

      // The critical assertion: the old CJS error must not appear
      expect(combined).not.toContain('require() cannot be used on an ESM graph');
      expect(combined).not.toContain('ERR_REQUIRE_ESM');
      expect(proc.status).toBe(1);
      expect(proc.stderr).toContain('--tui requires an interactive terminal');
    },
  );

  it.skipIf(!binExists)(
    'non-TUI mode still works from the ESM binary',
    () => {
      // Verify that the normal --help path still works from the .mjs entry
      const proc = spawnSync(
        process.execPath,
        [cliBin, '--help'],
        {
          cwd: repoRoot,
          encoding: 'utf-8',
          timeout: 10_000,
        },
      );

      expect(proc.stdout).toContain('sbi');
      expect(proc.stdout).toContain('analyze');
    },
  );

  it.skipIf(!binExists)(
    'the SBI binary reports the shared application version',
    () => {
      const proc = spawnSync(process.execPath, [cliBin, '--version'], {
        cwd: repoRoot,
        encoding: 'utf-8',
        timeout: 10_000,
      });

      expect(proc.status).toBe(0);
      expect(proc.stdout.trim()).toBe(VERSION);
    },
  );

  it.skipIf(!binExists)(
    'non-TUI analyze still works from the ESM binary',
    () => {
      // Run analyze without --tui on a real fixture bundle to prove
      // the ESM binary handles the full pipeline
      const bundlePath = path.join(
        repoRoot,
        'test/fixtures/scenarios/bad-image-tag',
      );

      // If the fixture doesn't exist as a dir, skip
      if (!fs.existsSync(bundlePath)) return;

      // Create a temp tarball
      const tarProc = spawnSync(
        'tar',
        ['czf', '/tmp/sbi-tui-test.tar.gz', '-C', path.dirname(bundlePath), path.basename(bundlePath)],
        { encoding: 'utf-8' },
      );
      if (tarProc.status !== 0) return;

      const proc = spawnSync(
        process.execPath,
        [
          cliBin,
          'analyze',
          '/tmp/sbi-tui-test.tar.gz',
          '--no-ai',
          '--verbose',
          '--format',
          'json',
        ],
        {
          cwd: repoRoot,
          encoding: 'utf-8',
          timeout: 15_000,
        },
      );

      expect(proc.status).toBe(0);
      const report = JSON.parse(proc.stdout);
      expect(report.findings.length).toBeGreaterThan(0);
      expect(proc.stderr).toContain('[pipeline]');
    },
  );
});
