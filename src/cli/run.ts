#!/usr/bin/env node
/**
 * CLI binary entry point for `sbi`.
 *
 * This file is the `bin.sbi` target in package.json.  It always invokes
 * `runCli` — there is no `require.main` guard because the ESM build
 * (`dist/cli/run.mjs`) does not support that pattern.
 *
 * The TUI loader is supplied here — and only here — because this file has a
 * stable output location (`dist/cli/run.mjs`), so the relative import path
 * `../tui/index.js` reliably resolves to `dist/tui/index.mjs` in the ESM
 * bundle.
 *
 * The reusable CLI implementation lives in `runner.ts` so the library entry
 * (`src/index.ts`) can re-export `runCli` without triggering execution.
 */

import { loadDotEnv } from './env-loader.js';
import { runCli } from './runner.js';

// Load .env before anything reads process.env
loadDotEnv();

runCli(process.argv, {
  loadTUI: () => import('../tui/index.js'),
}).then(
  (exitCode) => {
    process.exit(exitCode);
  },
  (err: unknown) => {
    console.error('Fatal:', err);
    process.exit(1);
  },
);
