#!/usr/bin/env node
/**
 * RAT -- Replicated AI Troubleshooting
 *
 * A simplified entry point that:
 * 1. Auto-builds if dist/ is stale or missing
 * 2. Scans ./bundles/ (or a specified directory) for .tar.gz support bundles
 * 3. Presents an interactive selection list
 * 4. Launches the pane-based TUI on the selected bundle
 *
 * Usage:
 *   rat                           # Scan ./bundles/ (default)
 *   rat /path/to/dir              # Scan specific directory
 *   rat /path/to/bundle.tar.gz    # Analyze directly
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { loadDotEnv } from './env-loader.js';

// Load .env before anything reads process.env
loadDotEnv();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default directory where users should drop support bundle tarballs. */
const DEFAULT_BUNDLE_DIR = 'bundles';

// ---------------------------------------------------------------------------
// Auto-build
// ---------------------------------------------------------------------------

/**
 * Returns the project root by walking up from the current file until we find
 * package.json. Works in both CJS (__dirname) and ESM (import.meta.url).
 */
function findProjectRoot(): string {
  // ESM-safe: derive directory from import.meta.url when __dirname is unavailable
  let dir: string;
  try {
    dir = typeof __dirname !== 'undefined'
      ? __dirname
      : path.dirname(fileURLToPath(import.meta.url));
  } catch {
    dir = process.cwd();
  }

  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

/**
 * Checks whether a build is needed and runs `npm run build` if so.
 *
 * Build is needed when:
 * - dist/ directory does not exist, OR
 * - Any src/ file is newer than the newest dist/ file
 */
function ensureBuilt(projectRoot: string): void {
  const distDir = path.join(projectRoot, 'dist');
  const srcDir = path.join(projectRoot, 'src');

  if (!fs.existsSync(distDir)) {
    console.log('  [rat] dist/ not found -- building...');
    execSync('npm run build', { cwd: projectRoot, stdio: 'inherit' });
    return;
  }

  // Quick staleness check: compare newest src/ mtime vs dist/ mtime
  try {
    const distStat = fs.statSync(distDir);
    const srcStat = fs.statSync(srcDir);
    if (srcStat.mtimeMs > distStat.mtimeMs) {
      console.log('  [rat] Source files changed -- rebuilding...');
      execSync('npm run build', { cwd: projectRoot, stdio: 'inherit' });
    }
  } catch {
    // If stat fails, skip auto-build -- user can build manually
  }
}

// ---------------------------------------------------------------------------
// Bundle discovery
// ---------------------------------------------------------------------------

async function findBundles(dir: string): Promise<string[]> {
  const resolved = path.resolve(dir);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(resolved, { withFileTypes: true });
  } catch {
    return [];
  }

  const bundles: string[] = [];
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.tar.gz')) {
      bundles.push(path.join(resolved, entry.name));
    }
  }

  // Also check one level deep for common bundle directories
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.name.startsWith('.')) {
      try {
        const subEntries = fs.readdirSync(path.join(resolved, entry.name), {
          withFileTypes: true,
        });
        for (const sub of subEntries) {
          if (sub.isFile() && sub.name.endsWith('.tar.gz')) {
            bundles.push(path.join(resolved, entry.name, sub.name));
          }
        }
      } catch {
        // Skip inaccessible directories
      }
    }
  }

  return bundles.sort();
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// ---------------------------------------------------------------------------
// Interactive selection
// ---------------------------------------------------------------------------

async function selectBundle(bundles: string[]): Promise<string | null> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log('');
  console.log('  RAT - Replicated AI Troubleshooting');
  console.log('  ====================================');
  console.log('');
  console.log('  Found support bundles:');
  console.log('');

  for (let i = 0; i < bundles.length; i++) {
    const bundle = bundles[i]!;
    const name = path.basename(bundle);
    let size = '';
    try {
      const stat = fs.statSync(bundle);
      size = formatSize(stat.size);
    } catch {
      size = '?';
    }
    console.log(`    ${i + 1}) ${name}  (${size})`);
  }

  console.log('');

  return new Promise<string | null>((resolve) => {
    rl.question('  Select bundle [1]: ', (answer) => {
      rl.close();
      const trimmed = answer.trim();

      if (trimmed === '' || trimmed === '1') {
        resolve(bundles[0] ?? null);
        return;
      }

      if (trimmed.toLowerCase() === 'q') {
        resolve(null);
        return;
      }

      const num = parseInt(trimmed, 10);
      if (!isNaN(num) && num >= 1 && num <= bundles.length) {
        resolve(bundles[num - 1] ?? null);
      } else {
        console.log('  Invalid selection.');
        resolve(null);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const projectRoot = findProjectRoot();
  const args = process.argv.slice(2);

  // Auto-build if needed (unless user passed --no-build)
  const noBuild = args.includes('--no-build');
  const filteredArgs = args.filter((a) => a !== '--no-build');

  if (!noBuild) {
    ensureBuilt(projectRoot);
  }

  const target = filteredArgs[0] ?? path.join(projectRoot, DEFAULT_BUNDLE_DIR);

  // Check if the argument is a direct bundle file
  if (target.endsWith('.tar.gz') && fs.existsSync(target)) {
    const { renderTUI } = await import('../tui/index.js');
    process.stdout.write('\x1B[2J\x1B[H');
    await renderTUI(path.resolve(target), {});
    process.stdout.write('\x1B[2J\x1B[H');
    return;
  }

  // Determine scan directory:
  // - If user gave an explicit path that exists as a directory, use it
  // - Otherwise use the default ./bundles/ directory
  const userGaveExplicitPath = filteredArgs.length > 0;
  let scanDir: string;
  if (userGaveExplicitPath && fs.existsSync(target) && fs.statSync(target).isDirectory()) {
    scanDir = target;
  } else if (userGaveExplicitPath && !fs.existsSync(target)) {
    // User specified a path that doesn't exist at all
    scanDir = target;
  } else {
    scanDir = path.join(projectRoot, DEFAULT_BUNDLE_DIR);
  }

  const bundles = await findBundles(scanDir);

  if (bundles.length === 0) {
    console.log('');
    console.log('  RAT - Replicated AI Troubleshooting');
    console.log('  ====================================');
    console.log('');
    console.log(`  No .tar.gz support bundles found in: ./${DEFAULT_BUNDLE_DIR}/`);
    console.log('');
    console.log('  To get started:');
    console.log(`    1. Place your support bundle .tar.gz file in the ./${DEFAULT_BUNDLE_DIR}/ directory`);
    console.log('    2. Run: rat');
    console.log('');
    console.log('  How to get a support bundle:');
    console.log('    kubectl support-bundle https://your-app.com/support-bundle-spec.yaml');
    console.log('    # or download from your vendor portal / customer support');
    console.log('');
    console.log('  Usage:');
    console.log('    rat                          Scan ./bundles/ (default)');
    console.log('    rat /path/to/dir             Scan specific directory');
    console.log('    rat /path/to/bundle.tar.gz   Analyze directly');
    console.log('');
    process.exit(1);
  }

  // If only one bundle, ask for confirmation
  let bundlePath: string | null;
  if (bundles.length === 1) {
    const name = path.basename(bundles[0]!);
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    console.log('');
    console.log('  RAT - Replicated AI Troubleshooting');
    console.log('  ====================================');
    console.log('');
    console.log(`  Found: ${name}`);

    bundlePath = await new Promise<string | null>((resolve) => {
      rl.question('  Analyze? [Y/n]: ', (answer) => {
        rl.close();
        const trimmed = answer.trim().toLowerCase();
        if (trimmed === '' || trimmed === 'y' || trimmed === 'yes') {
          resolve(bundles[0]!);
        } else {
          resolve(null);
        }
      });
    });
  } else {
    bundlePath = await selectBundle(bundles);
  }

  if (!bundlePath) {
    console.log('  Cancelled.');
    return;
  }

  console.log(`  Analyzing: ${path.basename(bundlePath)}`);
  console.log('');

  const { renderTUI } = await import('../tui/index.js');
  process.stdout.write('\x1B[2J\x1B[H');
  await renderTUI(bundlePath, {});
  process.stdout.write('\x1B[2J\x1B[H');
}

main().catch((err: unknown) => {
  console.error('Fatal:', err);
  process.exit(1);
});
