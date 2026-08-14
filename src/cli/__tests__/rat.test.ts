import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { VERSION } from '../../version.js';

const repoRoot = path.resolve(__dirname, '../../..');
const ratBin = path.join(repoRoot, 'dist/cli/rat.mjs');

describe('RAT CLI binary', () => {
  const binExists = fs.existsSync(ratBin);

  it('package.json registers rat as a bin entry', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf-8'));
    expect(pkg.bin?.rat).toBeDefined();
    expect(pkg.bin.rat).toMatch(/\.mjs$/);
    expect(VERSION).toBe(pkg.version);
  });

  it.skipIf(!binExists)(
    'rat binary loads without ESM errors',
    () => {
      // Run with --no-build and --no-embedding-setup to skip async probes
      const proc = spawnSync(
        process.execPath,
        [ratBin, '--no-build', '--no-embedding-setup', '/tmp/nonexistent-rat-dir-' + Date.now()],
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
    'rat fails fast with actionable guidance when stdin is not a TTY',
    () => {
      const proc = spawnSync(
        process.execPath,
        [ratBin, '--no-build', '--no-embedding-setup', '/tmp/nonexistent-rat-dir-' + Date.now()],
        {
          cwd: repoRoot,
          encoding: 'utf-8',
          timeout: 10_000,
        },
      );

      expect(proc.status).toBe(1);
      expect(proc.stderr).toContain('RAT requires an interactive terminal');
      expect(proc.stderr).toContain('sbi analyze <bundle.tar.gz>');
      expect(proc.stdout).not.toContain('Detecting embedding services');
    },
  );

  it.skipIf(!binExists)(
    '--help is side-effect-free and works from outside the package',
    () => {
      const cwd = fs.mkdtempSync(path.join(process.env['TMPDIR'] ?? '/tmp', 'rat-help-'));
      try {
        const proc = spawnSync(process.execPath, [ratBin, '--help'], {
          cwd,
          encoding: 'utf-8',
          timeout: 10_000,
        });

        expect(proc.status).toBe(0);
        expect(proc.stdout).toContain('Usage: rat');
        expect(proc.stdout).toContain('current directory');
        expect(proc.stdout).not.toContain('Detecting embedding services');
        expect(proc.stdout).not.toContain('building');
        expect(fs.existsSync(path.join(cwd, '.env'))).toBe(false);
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!binExists)(
    '--version exits successfully without requiring a TTY',
    () => {
      const proc = spawnSync(process.execPath, [ratBin, '--version'], {
        cwd: repoRoot,
        encoding: 'utf-8',
        timeout: 10_000,
      });

      expect(proc.status).toBe(0);
      expect(proc.stdout.trim()).toBe(VERSION);
      expect(proc.stderr).toBe('');
    },
  );
});
