#!/usr/bin/env node
/**
 * CLI binary wrapper for `sbi`.
 *
 * The reusable CLI implementation lives in `runner.ts` so both `dist/cli/run.js`
 * and `dist/index.js` can invoke the same logic without double-executing when
 * tsup bundles modules together.
 */

import { runCli } from './runner.js';

if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  runCli().then(
    (exitCode) => {
      process.exit(exitCode);
    },
    (err: unknown) => {
      console.error('Fatal:', err);
      process.exit(1);
    },
  );
}

export { runCli } from './runner.js';
