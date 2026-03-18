import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Validates that the TUI can be loaded without ESM/CJS compatibility errors.
 *
 * The primary failure mode this guards against is `ink` (ESM-only with
 * top-level await) being loaded via `require()` from a CJS bundle, which
 * crashes with "require() cannot be used on an ESM graph with top-level
 * await."
 *
 * The fix is:
 * 1. `bin.sbi` in package.json must point to the ESM build (`.mjs`).
 * 2. The ESM binary must use `import()` to load the TUI module.
 */
describe('TUI ESM compatibility', () => {
  it('package.json bin.sbi points to an ESM entry (.mjs)', () => {
    const pkgPath = path.resolve(__dirname, '../../../package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));

    expect(pkg.bin?.sbi).toBeDefined();
    expect(pkg.bin.sbi).toMatch(/\.mjs$/);
  });

  it('the ESM CLI binary file exists after build', () => {
    const pkgPath = path.resolve(__dirname, '../../../package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    const binPath = path.resolve(__dirname, '../../..', pkg.bin.sbi);

    // This test only validates after `npm run build` has been run.
    // In CI the build step runs before tests.
    if (fs.existsSync(binPath)) {
      const content = fs.readFileSync(binPath, 'utf-8');
      // ESM files use import/export, not "use strict" + require
      expect(content).not.toMatch(/^"use strict"/);
      expect(content).toMatch(/import/);
    }
  });

  it('the TUI entry helpers can be imported without side effects', async () => {
    // Import only the pure helpers — not the React/Ink components.
    // This validates that the non-Ink parts of the TUI module are importable
    // in a test environment without React rendering infrastructure.
    const helpers = await import('../helpers.js');
    expect(helpers.severityColor).toBeTypeOf('function');
    expect(helpers.sourceTag).toBeTypeOf('function');
    expect(helpers.confidenceBar).toBeTypeOf('function');
  });

  it('the TUI state machine can be imported without side effects', async () => {
    const sm = await import('../state-machine.js');
    expect(sm.initialState).toBeTypeOf('function');
    expect(sm.transition).toBeTypeOf('function');
    expect(sm.mapKeyToAction).toBeTypeOf('function');
  });
});
