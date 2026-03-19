#!/usr/bin/env node
/**
 * RAT -- Replicated AI Troubleshooting
 *
 * Entry flow:
 * 1. Auto-build if dist/ is stale or missing
 * 2. Detect / offer to set up a local embedding model (TEI or Ollama)
 * 3. Scan ./bundles/ (or a specified directory) for .tar.gz support bundles
 * 4. Present an interactive selection list
 * 5. Launch the pane-based TUI on the selected bundle
 *
 * Usage:
 *   rat                           # Scan ./bundles/ (default)
 *   rat /path/to/dir              # Scan specific directory
 *   rat /path/to/bundle.tar.gz    # Analyze directly
 *   rat --no-build                # Skip auto-build check
 *   rat --no-embedding-setup      # Skip embedding setup prompt
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { execSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { loadDotEnv } from './env-loader.js';

// Load .env before anything reads process.env
loadDotEnv();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default directory where users should drop support bundle tarballs. */
const DEFAULT_BUNDLE_DIR = 'bundles';

/** TEI Docker image (official HuggingFace Text Embeddings Inference). */
const TEI_DOCKER_IMAGE = 'ghcr.io/huggingface/text-embeddings-inference:cpu-1.5';

/**
 * Default embedding model for TEI.
 * gte-Qwen2-1.5B: 1.5B params, MIT license, 131K context, ~30ms on M-series.
 */
const TEI_DEFAULT_MODEL = 'Alibaba-NLP/gte-Qwen2-1.5B-instruct';

/**
 * Lighter-weight TEI model option (~560MB download vs ~3GB for Qwen2).
 * Good starting point for machines with less RAM.
 */
const TEI_LIGHT_MODEL = 'BAAI/bge-small-en-v1.5';

/** Ollama model for embeddings. */
const OLLAMA_EMBED_MODEL = 'nomic-embed-text';

/** TEI default port / URL. */
const TEI_PORT = 8080;
const TEI_URL = `http://localhost:${TEI_PORT}`;

/** Ollama default port / URL. */
const OLLAMA_PORT = 11434;
const OLLAMA_URL = `http://localhost:${OLLAMA_PORT}`;

// ---------------------------------------------------------------------------
// Project root resolution
// ---------------------------------------------------------------------------

function findProjectRoot(): string {
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

// ---------------------------------------------------------------------------
// Auto-build
// ---------------------------------------------------------------------------

function ensureBuilt(projectRoot: string): void {
  const distDir = path.join(projectRoot, 'dist');
  const srcDir = path.join(projectRoot, 'src');

  if (!fs.existsSync(distDir)) {
    console.log('  [rat] dist/ not found -- building...');
    execSync('npm run build', { cwd: projectRoot, stdio: 'inherit' });
    return;
  }

  try {
    const distStat = fs.statSync(distDir);
    const srcStat = fs.statSync(srcDir);
    if (srcStat.mtimeMs > distStat.mtimeMs) {
      console.log('  [rat] Source files changed -- rebuilding...');
      execSync('npm run build', { cwd: projectRoot, stdio: 'inherit' });
    }
  } catch {
    // Skip auto-build if stat fails
  }
}

// ---------------------------------------------------------------------------
// ASCII art banner
// ---------------------------------------------------------------------------

function printBanner(): void {
  console.log('');
  console.log(`     _ __       _      _____`);
  console.log(`    |  _ \\    / \\   |_   _|`);
  console.log(`    | |_) |  / _ \\    | |  `);
  console.log(`    |  _ <  / ___ \\   | |  `);
  console.log(`    |_| \\_\\/_/   \\_\\  |_|  `);
  console.log('');
  console.log(`          (\\,/)`);
  console.log(`          oo   '''//,        _`);
  console.log(`        ,/_;~,        \\,    / '`);
  console.log(`        "'   \\    (    \\    !`);
  console.log(`              ',|  \\   |__.'`);
  console.log(`              '~  '~----''`);
  console.log('');
  console.log('  Replicated AI Troubleshooting');
  console.log('');
}

// ---------------------------------------------------------------------------
// .env file writing
// ---------------------------------------------------------------------------

/**
 * Writes or updates a key in the .env file.
 * If the key already exists, replaces it. Otherwise appends it.
 */
function writeEnvKey(envPath: string, key: string, value: string): void {
  let content = '';
  try {
    content = fs.readFileSync(envPath, 'utf-8');
  } catch {
    // File doesn't exist yet — start fresh
  }

  const lines = content.split('\n');
  const keyPattern = new RegExp(`^${key}=`);
  const existingIndex = lines.findIndex((l) => keyPattern.test(l));

  if (existingIndex >= 0) {
    lines[existingIndex] = `${key}=${value}`;
  } else {
    // Add a blank line before new entries if file has content
    if (content.trim().length > 0 && !content.endsWith('\n')) {
      lines.push('');
    }
    lines.push(`${key}=${value}`);
  }

  fs.writeFileSync(envPath, lines.join('\n').trimEnd() + '\n', 'utf-8');
}

// ---------------------------------------------------------------------------
// Embedding detection helpers
// ---------------------------------------------------------------------------

/** Returns true when the given HTTP URL responds to a GET within 2 seconds. */
async function isReachable(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    return response.ok || response.status < 500;
  } catch {
    return false;
  }
}

/** Returns true when `docker` is installed and the daemon is responding. */
function isDockerAvailable(): boolean {
  try {
    const result = spawnSync('docker', ['info'], { encoding: 'utf-8', timeout: 4000 });
    return result.status === 0;
  } catch {
    return false;
  }
}

/** Returns true when `ollama` CLI is installed. */
function isOllamaInstalled(): boolean {
  try {
    const result = spawnSync('ollama', ['--version'], { encoding: 'utf-8', timeout: 2000 });
    return result.status === 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Embedding setup flow
// ---------------------------------------------------------------------------

type EmbeddingSetupResult =
  | { backend: 'openai' }
  | { backend: 'local'; url: string; model: string }
  | { backend: 'none' }
  | { backend: 'skip' }; // user chose not to change anything

/**
 * Prompts the user to pick a local embedding backend option.
 */
async function promptEmbeddingSetup(
  projectRoot: string,
  rl: readline.Interface,
): Promise<EmbeddingSetupResult> {
  const dockerAvail = isDockerAvailable();
  const ollamaInstalled = isOllamaInstalled();
  const hasApiKey = (process.env['OPENAI_API_KEY'] ?? '').trim().length > 0;

  console.log('  Embedding backend options:');
  console.log('');

  const options: Array<{ label: string; value: string }> = [];

  if (dockerAvail) {
    options.push({
      label: `TEI (Docker)  -- gte-Qwen2-1.5B (recommended, ~3 GB first run) or bge-small (~560 MB)`,
      value: 'tei',
    });
  } else {
    console.log('  [!] Docker not detected -- TEI option unavailable');
    console.log('      Install Docker Desktop to use TEI: https://docs.docker.com/get-docker/');
    console.log('');
  }

  if (ollamaInstalled) {
    options.push({ label: `Ollama        -- nomic-embed-text (~274 MB, simpler setup)`, value: 'ollama' });
  } else {
    console.log('  [!] Ollama not detected -- Ollama option unavailable');
    console.log('      Install Ollama: https://ollama.com/download');
    console.log('');
  }

  if (hasApiKey) {
    options.push({ label: `OpenAI API    -- text-embedding-3-small (no local service needed)`, value: 'openai' });
  }

  options.push({ label: `None          -- skip embeddings, use graph + BM25 only`, value: 'none' });
  options.push({ label: `Cancel        -- keep current settings`, value: 'cancel' });

  for (let i = 0; i < options.length; i++) {
    console.log(`    ${i + 1}) ${options[i]!.label}`);
  }
  console.log('');

  return new Promise<EmbeddingSetupResult>((resolve) => {
    rl.question('  Select [1]: ', (answer) => {
      const trimmed = answer.trim();
      const num = trimmed === '' ? 1 : parseInt(trimmed, 10);

      if (isNaN(num) || num < 1 || num > options.length) {
        console.log('  Invalid selection, keeping current settings.');
        resolve({ backend: 'skip' });
        return;
      }

      const choice = options[num - 1]!.value;

      if (choice === 'cancel') {
        resolve({ backend: 'skip' });
      } else if (choice === 'openai') {
        resolve({ backend: 'openai' });
      } else if (choice === 'none') {
        resolve({ backend: 'none' });
      } else if (choice === 'tei') {
        resolve({ backend: 'local', url: TEI_URL, model: TEI_DEFAULT_MODEL });
      } else if (choice === 'ollama') {
        resolve({ backend: 'local', url: OLLAMA_URL, model: OLLAMA_EMBED_MODEL });
      } else {
        resolve({ backend: 'skip' });
      }
    });
  });
}

/**
 * Starts TEI in a Docker container (detached).
 * Returns true if the container started successfully and is reachable.
 */
async function startTEI(projectRoot: string, rl: readline.Interface): Promise<boolean> {
  console.log('');
  console.log('  TEI model options:');
  console.log('');
  console.log('    1) gte-Qwen2-1.5B-instruct  (recommended -- ~3 GB, best quality, 131K context)');
  console.log('    2) bge-small-en-v1.5         (lightweight -- ~560 MB, fast, good quality)');
  console.log('');

  const model = await new Promise<string>((resolve) => {
    rl.question('  Select model [1]: ', (answer) => {
      const trimmed = answer.trim();
      if (trimmed === '' || trimmed === '1') {
        resolve(TEI_DEFAULT_MODEL);
      } else if (trimmed === '2') {
        resolve(TEI_LIGHT_MODEL);
      } else {
        resolve(TEI_DEFAULT_MODEL);
      }
    });
  });

  const modelShort = model.split('/').pop() ?? model;
  console.log('');
  console.log(`  Starting TEI with ${modelShort}...`);
  console.log(`  Docker image: ${TEI_DOCKER_IMAGE}`);
  console.log(`  (First run downloads the model -- this may take a few minutes)`);
  console.log('');

  // Stop any existing TEI container on that port first
  try {
    spawnSync('docker', ['rm', '-f', 'sbi-tei'], { encoding: 'utf-8' });
  } catch {
    // Ignore -- no existing container
  }

  const result = spawnSync(
    'docker',
    [
      'run', '-d',
      '--name', 'sbi-tei',
      '-p', `${TEI_PORT}:80`,
      '--pull', 'always',
      TEI_DOCKER_IMAGE,
      '--model-id', model,
      '--max-client-batch-size', '64',
    ],
    { encoding: 'utf-8', timeout: 30_000 },
  );

  if (result.status !== 0) {
    console.log('  [!] Failed to start TEI container:');
    console.log(`      ${result.stderr?.trim() ?? 'unknown error'}`);
    console.log('');
    console.log('  Troubleshooting:');
    console.log('    - Make sure Docker Desktop is running');
    console.log('    - Try manually: docker run -d --name sbi-tei -p 8080:80 \\');
    console.log(`      ${TEI_DOCKER_IMAGE} --model-id ${model}`);
    return false;
  }

  const containerId = result.stdout?.trim();
  console.log(`  Container started: ${containerId?.slice(0, 12) ?? 'unknown'}`);
  console.log('  Waiting for TEI to become ready...');

  // Poll /health until ready (model download + load can take up to 3 minutes)
  const maxWaitMs = 180_000;
  const pollIntervalMs = 3_000;
  const started = Date.now();
  let ready = false;

  while (Date.now() - started < maxWaitMs) {
    await new Promise<void>((r) => setTimeout(r, pollIntervalMs));
    const elapsed = Math.round((Date.now() - started) / 1000);
    process.stdout.write(`\r  Waiting... ${elapsed}s elapsed  `);

    if (await isReachable(`${TEI_URL}/health`)) {
      ready = true;
      break;
    }
  }

  console.log('');

  if (!ready) {
    console.log('  [!] TEI did not become ready within 3 minutes.');
    console.log(`      Check logs: docker logs sbi-tei`);
    return false;
  }

  console.log('  TEI is ready.');
  return true;
}

/**
 * Ensures Ollama has the embedding model pulled and its service is running.
 * Returns true on success.
 */
async function startOllama(): Promise<boolean> {
  console.log('');
  console.log(`  Pulling ${OLLAMA_EMBED_MODEL} via Ollama...`);
  console.log('  (First run downloads ~274 MB)');
  console.log('');

  const pullResult = spawnSync('ollama', ['pull', OLLAMA_EMBED_MODEL], {
    encoding: 'utf-8',
    stdio: 'inherit',
    timeout: 120_000,
  });

  if (pullResult.status !== 0) {
    console.log(`  [!] Failed to pull ${OLLAMA_EMBED_MODEL}.`);
    console.log('  Make sure Ollama is running: ollama serve');
    return false;
  }

  // Confirm Ollama is reachable
  if (!(await isReachable(`${OLLAMA_URL}/api/version`))) {
    console.log('');
    console.log('  [!] Ollama server is not responding on localhost:11434.');
    console.log('  Start it with: ollama serve');
    console.log('  Then re-run rat.');
    return false;
  }

  console.log(`  Ollama ready with ${OLLAMA_EMBED_MODEL}.`);
  return true;
}

/**
 * Checks the current embedding state and optionally guides setup.
 *
 * Decision tree:
 * 1. If SBI_EMBEDDING_BACKEND is explicitly set to 'openai' or 'none', skip prompting.
 * 2. If SBI_EMBEDDING_BACKEND is 'local' (default), probe the embedding URL.
 *    a. If something is reachable, report it and continue.
 *    b. If nothing is reachable, ask the user if they want to set one up.
 * 3. If the user confirms setup, run the appropriate backend flow.
 * 4. Write the chosen backend + URL to .env.
 */
async function handleEmbeddingSetup(projectRoot: string, skipPrompt: boolean): Promise<void> {
  const envPath = path.join(projectRoot, '.env');
  const backend = process.env['SBI_EMBEDDING_BACKEND'] ?? 'local';
  const embeddingUrl = process.env['SBI_EMBEDDING_URL'] ?? TEI_URL;

  // User explicitly opted out — nothing to do
  if (backend === 'none') {
    console.log('  Embeddings: disabled (graph + BM25 only)');
    console.log('');
    return;
  }

  if (backend === 'openai') {
    const hasKey = (process.env['OPENAI_API_KEY'] ?? '').trim().length > 0;
    console.log(`  Embeddings: OpenAI API${hasKey ? '' : ' [!] OPENAI_API_KEY not set'}`);
    console.log('');
    return;
  }

  // backend === 'local' (default) — probe the URL
  const probeUrl = backend === 'local' ? embeddingUrl : TEI_URL;
  const healthUrl = probeUrl.includes('11434') ? `${probeUrl}/api/version` : `${probeUrl}/health`;

  process.stdout.write('  Checking local embedding service... ');
  const reachable = await isReachable(healthUrl);

  if (reachable) {
    const serviceLabel = probeUrl.includes('11434') ? 'Ollama' : 'TEI';
    console.log(`${serviceLabel} running at ${probeUrl}`);
    console.log('');
    return;
  }

  console.log('not found');
  console.log('');

  if (skipPrompt) {
    console.log('  No local embedding service -- using graph + BM25 only.');
    console.log('  Run `rat` without --no-embedding-setup to configure one.');
    console.log('');
    return;
  }

  // Ask whether to set one up
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const wantsSetup = await new Promise<boolean>((resolve) => {
    rl.question(
      '  No local embedding service found. Set one up now? [Y/n]: ',
      (answer) => {
        const a = answer.trim().toLowerCase();
        resolve(a === '' || a === 'y' || a === 'yes');
      },
    );
  });

  if (!wantsSetup) {
    console.log('');
    console.log('  Continuing with graph + BM25 retrieval only.');
    console.log('  AI analysis will still run -- just without semantic search.');
    console.log('');
    rl.close();
    return;
  }

  console.log('');

  const setupResult = await promptEmbeddingSetup(projectRoot, rl);
  rl.close();

  console.log('');

  if (setupResult.backend === 'skip') {
    console.log('  Keeping current settings.');
    console.log('');
    return;
  }

  if (setupResult.backend === 'none') {
    writeEnvKey(envPath, 'SBI_EMBEDDING_BACKEND', 'none');
    process.env['SBI_EMBEDDING_BACKEND'] = 'none';
    console.log('  Embeddings disabled. Setting saved to .env');
    console.log('');
    return;
  }

  if (setupResult.backend === 'openai') {
    writeEnvKey(envPath, 'SBI_EMBEDDING_BACKEND', 'openai');
    process.env['SBI_EMBEDDING_BACKEND'] = 'openai';
    console.log('  Set to OpenAI embeddings. Saved to .env');
    console.log('');
    return;
  }

  // local: TEI or Ollama
  const isOllama = setupResult.url.includes(String(OLLAMA_PORT));

  let started = false;
  if (isOllama) {
    started = await startOllama();
  } else {
    // Need a new readline for TEI model selection
    const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });
    started = await startTEI(projectRoot, rl2);
    rl2.close();
  }

  if (started) {
    writeEnvKey(envPath, 'SBI_EMBEDDING_BACKEND', 'local');
    writeEnvKey(envPath, 'SBI_EMBEDDING_URL', setupResult.url);
    writeEnvKey(envPath, 'SBI_EMBEDDING_MODEL', setupResult.model);
    process.env['SBI_EMBEDDING_BACKEND'] = 'local';
    process.env['SBI_EMBEDDING_URL'] = setupResult.url;
    process.env['SBI_EMBEDDING_MODEL'] = setupResult.model;
    console.log('');
    console.log('  Settings saved to .env');
    console.log(`    SBI_EMBEDDING_BACKEND=local`);
    console.log(`    SBI_EMBEDDING_URL=${setupResult.url}`);
    console.log(`    SBI_EMBEDDING_MODEL=${setupResult.model}`);
    console.log('');
  } else {
    console.log('');
    console.log('  Setup failed. Continuing with graph + BM25 only.');
    console.log('');
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

  // One level deep
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.name.startsWith('.')) {
      try {
        const subEntries = fs.readdirSync(path.join(resolved, entry.name), { withFileTypes: true });
        for (const sub of subEntries) {
          if (sub.isFile() && sub.name.endsWith('.tar.gz')) {
            bundles.push(path.join(resolved, entry.name, sub.name));
          }
        }
      } catch {
        // Skip inaccessible
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
// Bundle selection
// ---------------------------------------------------------------------------

async function selectBundle(bundles: string[]): Promise<string | null> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

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

  const noBuild = args.includes('--no-build');
  const noEmbeddingSetup = args.includes('--no-embedding-setup');
  const filteredArgs = args.filter(
    (a) => a !== '--no-build' && a !== '--no-embedding-setup',
  );

  if (!noBuild) {
    ensureBuilt(projectRoot);
  }

  const target = filteredArgs[0] ?? path.join(projectRoot, DEFAULT_BUNDLE_DIR);

  // Direct bundle path — skip setup flow, go straight to TUI
  if (target.endsWith('.tar.gz') && fs.existsSync(target)) {
    const { renderTUI } = await import('../tui/index.js');
    process.stdout.write('\x1B[2J\x1B[H');
    await renderTUI(path.resolve(target), {});
    process.stdout.write('\x1B[2J\x1B[H');
    return;
  }

  // Print banner once
  printBanner();

  // Determine scan directory
  const userGaveExplicitPath = filteredArgs.length > 0;
  let scanDir: string;
  if (userGaveExplicitPath && fs.existsSync(target) && fs.statSync(target).isDirectory()) {
    scanDir = target;
  } else if (userGaveExplicitPath && !fs.existsSync(target)) {
    scanDir = target;
  } else {
    scanDir = path.join(projectRoot, DEFAULT_BUNDLE_DIR);
  }

  // Embedding setup (before bundle selection so user knows AI mode)
  await handleEmbeddingSetup(projectRoot, noEmbeddingSetup);

  const bundles = await findBundles(scanDir);

  if (bundles.length === 0) {
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

  // Bundle selection
  let bundlePath: string | null;
  if (bundles.length === 1) {
    const name = path.basename(bundles[0]!);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

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
