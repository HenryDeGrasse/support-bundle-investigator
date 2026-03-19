import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

const repoRoot = path.resolve(__dirname, '../../..');
const ratBin = path.join(repoRoot, 'dist/cli/rat.mjs');

describe('RAT CLI binary', () => {
  const binExists = fs.existsSync(ratBin);

  it('package.json registers rat as a bin entry', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf-8'));
    expect(pkg.bin?.rat).toBeDefined();
    expect(pkg.bin.rat).toMatch(/\.mjs$/);
  });

  it.skipIf(!binExists)(
    'rat binary loads without ESM errors',
    () => {
      // Run with a non-existent directory and --no-build to skip auto-build
      const proc = spawnSync(
        process.execPath,
        [ratBin, '--no-build', '/tmp/nonexistent-rat-dir-' + Date.now()],
        {
          cwd: repoRoot,
          encoding: 'utf-8',
          timeout: 10_000,
          env: { ...process.env, NODE_NO_WARNINGS: '1' },
        },
      );

      const combined = `${proc.stdout ?? ''}\n${proc.stderr ?? ''}`;
      expect(combined).not.toContain('require() cannot be used on an ESM graph');
      expect(combined).not.toContain('ERR_REQUIRE_ESM');
      expect(combined.toLowerCase()).toContain('rat');
    },
  );

  it.skipIf(!binExists)(
    'rat shows usage when no bundles are found',
    () => {
      const proc = spawnSync(
        process.execPath,
        [ratBin, '--no-build', '/tmp/nonexistent-rat-dir-' + Date.now()],
        {
          cwd: repoRoot,
          encoding: 'utf-8',
          timeout: 10_000,
        },
      );

      expect(proc.stdout).toContain('No .tar.gz support bundles found');
      expect(proc.stdout).toContain('bundles/');
    },
  );

  it.skipIf(!binExists)(
    'rat mentions how to get a support bundle',
    () => {
      const proc = spawnSync(
        process.execPath,
        [ratBin, '--no-build', '/tmp/nonexistent-rat-dir-' + Date.now()],
        {
          cwd: repoRoot,
          encoding: 'utf-8',
          timeout: 10_000,
        },
      );

      expect(proc.stdout).toContain('kubectl support-bundle');
    },
  );
});
