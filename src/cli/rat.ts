#!/usr/bin/env node
/**
 * RAT — Replicated AI Troubleshooting
 *
 * A simplified entry point that:
 * 1. Scans a directory for .tar.gz support bundles
 * 2. Presents an interactive selection list
 * 3. Launches the pane-based TUI on the selected bundle
 *
 * Usage:
 *   rat                    # Scan current directory
 *   rat /path/to/dir       # Scan specific directory
 *   rat /path/to/bundle.tar.gz  # Analyze directly
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

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

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const target = args[0] ?? process.cwd();

  // Check if the argument is a direct bundle file
  if (target.endsWith('.tar.gz') && fs.existsSync(target)) {
    const { renderTUI } = await import('../tui/index.js');
    process.stdout.write('\x1B[2J\x1B[H');
    await renderTUI(path.resolve(target), {});
    process.stdout.write('\x1B[2J\x1B[H');
    return;
  }

  // Scan for bundles
  const scanDir = fs.existsSync(target) && fs.statSync(target).isDirectory()
    ? target
    : process.cwd();

  const bundles = await findBundles(scanDir);

  if (bundles.length === 0) {
    console.log('');
    console.log('  RAT - Replicated AI Troubleshooting');
    console.log('  ====================================');
    console.log('');
    console.log(`  No .tar.gz support bundles found in: ${path.resolve(scanDir)}`);
    console.log('');
    console.log('  Usage:');
    console.log('    rat                          Scan current directory');
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
