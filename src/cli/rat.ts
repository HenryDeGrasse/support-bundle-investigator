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
import { parseRatArgs, resolveRatTarget } from './rat-options.js';
import { VERSION } from '../version.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default directory where users should drop support bundle tarballs. */
const DEFAULT_BUNDLE_DIR = 'bundles';

/** TEI Docker image (official HuggingFace Text Embeddings Inference). */
const TEI_DOCKER_IMAGE = 'ghcr.io/huggingface/text-embeddings-inference:cpu-1.5';

/**
 * Default embedding model for TEI.
 * bge-large-en-v1.5: BERT-based, ONNX available, ~1.3 GB, high quality.
 * Supported by TEI CPU image (requires ONNX — Qwen2/decoder models are not).
 */
const TEI_DEFAULT_MODEL = 'BAAI/bge-large-en-v1.5';

/**
 * Lighter-weight TEI model option (~560MB download).
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

function printUsage(): void {
  console.log(`Usage: rat [options] [path]

Replicated AI Troubleshooting — interactive support-bundle investigation

Arguments:
  path                    Directory to scan or .tar.gz to analyze
                          (default: ./bundles/ in the current directory)

Options:
  --no-build              Skip the development auto-build check
  --no-embedding-setup    Keep the configured embedding backend
  -V, --version           Print the version
  -h, --help              Show this help`);
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

/** Detects which local embedding services are currently running. */
async function detectRunningServices(): Promise<{ teiRunning: boolean; ollamaRunning: boolean }> {
  const [teiRunning, ollamaRunning] = await Promise.all([
    isReachable(`${TEI_URL}/health`),
    isReachable(`${OLLAMA_URL}/api/version`),
  ]);
  return { teiRunning, ollamaRunning };
}

/**
 * Prompts the user to pick an embedding backend.
 *
 * Running services are detected and shown first with a ✓ marker.
 * The currently configured backend is used as the default selection.
 */
async function promptEmbeddingSetup(
  rl: readline.Interface,
  runningServices: { teiRunning: boolean; ollamaRunning: boolean },
): Promise<EmbeddingSetupResult> {
  const dockerAvail = isDockerAvailable();
  const ollamaInstalled = isOllamaInstalled();
  const hasApiKey = (process.env['OPENAI_API_KEY'] ?? '').trim().length > 0;

  // Determine what the user currently has configured
  const currentBackend = process.env['SBI_EMBEDDING_BACKEND'] ?? 'local';
  const currentUrl = process.env['SBI_EMBEDDING_URL'] ?? TEI_URL;
  const currentModel = process.env['SBI_EMBEDDING_MODEL'] ?? '';
  const currentIsOllama = currentUrl.includes(String(OLLAMA_PORT));
  const currentIsTei = currentBackend === 'local' && !currentIsOllama;

  console.log('  Embedding backend options:');
  console.log('');

  const options: Array<{ label: string; value: string }> = [];

  // ── Running services first ──────────────────────────────────────────────
  if (runningServices.teiRunning) {
    const armNote = process.arch === 'arm64' ? ' [x86 emulation]' : '';
    const currentNote = currentIsTei ? ' (current)' : '';
    options.push({
      label: `✓ TEI (running) -- ${TEI_URL}, 131K context, late chunking${armNote}${currentNote}`,
      value: 'tei',
    });
  }

  if (runningServices.ollamaRunning) {
    const modelNote = currentIsOllama && currentModel ? currentModel : OLLAMA_EMBED_MODEL;
    const currentNote = currentBackend === 'local' && currentIsOllama ? ' (current)' : '';
    options.push({
      label: `✓ Ollama (running) -- ${modelNote}, native ARM${currentNote}`,
      value: 'ollama',
    });
  }

  // ── Available but not running ───────────────────────────────────────────
  if (!runningServices.teiRunning && dockerAvail) {
    const armNote = process.arch === 'arm64' ? ' [x86 emulation on ARM]' : '';
    options.push({
      label: `TEI (Docker)  -- gte-Qwen2-1.5B (131K context, ~3 GB) or bge-small (~560 MB)${armNote}`,
      value: 'tei',
    });
  } else if (!runningServices.teiRunning && !dockerAvail) {
    console.log('  [!] Docker not detected -- TEI option unavailable');
    console.log('      Install Docker Desktop to use TEI: https://docs.docker.com/get-docker/');
    console.log('');
  }

  if (!runningServices.ollamaRunning && ollamaInstalled) {
    options.push({ label: `Ollama        -- nomic-embed-text (~274 MB, native ARM)`, value: 'ollama' });
  } else if (!runningServices.ollamaRunning && !ollamaInstalled) {
    console.log('  [!] Ollama not detected -- Ollama option unavailable');
    console.log('      Install Ollama: https://ollama.com/download');
    console.log('');
  }

  if (hasApiKey) {
    const currentNote = currentBackend === 'openai' ? ' (current)' : '';
    options.push({ label: `OpenAI API    -- text-embedding-3-small (no local service needed)${currentNote}`, value: 'openai' });
  }

  options.push({ label: `None          -- skip embeddings, use graph + BM25 only${currentBackend === 'none' ? ' (current)' : ''}`, value: 'none' });
  options.push({ label: `Keep current  -- don't change settings`, value: 'cancel' });

  // ── Find which option to default to ─────────────────────────────────────
  let defaultIdx = 0; // fallback: first option
  for (let i = 0; i < options.length; i++) {
    if (options[i]!.label.includes('(current)')) {
      defaultIdx = i;
      break;
    }
  }

  for (let i = 0; i < options.length; i++) {
    const marker = i === defaultIdx ? ' ←' : '';
    console.log(`    ${i + 1}) ${options[i]!.label}${marker}`);
  }
  console.log('');

  return new Promise<EmbeddingSetupResult>((resolve) => {
    rl.question(`  Select [${defaultIdx + 1}]: `, (answer) => {
      const trimmed = answer.trim();
      const num = trimmed === '' ? defaultIdx + 1 : parseInt(trimmed, 10);

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
 * Returns the available HF CLI command name (`huggingface-cli` or `hf`),
 * or null if neither is installed.
 * Used to pre-download models outside Docker for ARM compatibility.
 */
function getHfCliCommand(): string | null {
  for (const cmd of ['huggingface-cli', 'hf']) {
    try {
      const result = spawnSync(cmd, ['version'], { encoding: 'utf-8', timeout: 3000 });
      if (result.status === 0) return cmd;
    } catch {
      // try next
    }
  }
  return null;
}

/**
 * Pre-downloads a HuggingFace model to a local cache directory.
 *
 * On Apple Silicon, TEI's internal model download can fail under Rosetta
 * emulation ("relative URL without a base" error). Pre-downloading the model
 * on the host and mounting the cache directory as a volume works around this.
 *
 * Tries `huggingface-cli` / `hf` first. If neither is installed, falls back
 * to a Python one-liner using huggingface_hub.
 *
 * @returns The host-side cache directory path, or null on failure.
 */
function preDownloadModel(model: string, cacheDir: string): boolean {
  // Ensure cache directory exists
  fs.mkdirSync(cacheDir, { recursive: true });

  // Forward HF_TOKEN from the current process environment so authenticated
  // requests are used (higher rate limits, access to gated models).
  const hfEnv = { ...process.env };

  const hfCmd = getHfCliCommand();
  if (hfCmd !== null) {
    console.log(`  Downloading model with ${hfCmd}...`);
    const result = spawnSync(
      hfCmd,
      ['download', model, '--cache-dir', cacheDir],
      { encoding: 'utf-8', stdio: 'inherit', timeout: 1_800_000, env: hfEnv },
    );
    return result.status === 0;
  }

  // Fallback: try Python huggingface_hub
  console.log(`  huggingface-cli not found, trying Python huggingface_hub...`);
  const pyScript = `from huggingface_hub import snapshot_download; snapshot_download("${model}", cache_dir="${cacheDir}")`;

  for (const pyCmd of ['python3', 'python']) {
    const result = spawnSync(pyCmd, ['-c', pyScript], {
      encoding: 'utf-8',
      stdio: 'inherit',
      timeout: 1_800_000,
      env: hfEnv,
    });
    if (result.status === 0) return true;
  }

  return false;
}

/**
 * Starts TEI in a Docker container (detached).
 *
 * On ARM (Apple Silicon), pre-downloads the model on the host and mounts it
 * as a volume to avoid TEI's "relative URL without a base" download error
 * under Rosetta emulation.
 *
 * Returns true if the container started successfully and is reachable.
 */
async function startTEI(rl: readline.Interface): Promise<boolean> {
  console.log('');
  console.log('  TEI model options:');
  console.log('');
  console.log('    1) bge-large-en-v1.5         (recommended -- ~1.3 GB, high quality, TEI CPU compatible)');
  console.log('    2) bge-small-en-v1.5         (lightweight -- ~560 MB, fast, TEI CPU compatible)');
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
  console.log('');

  // Stop any existing TEI container on that port first
  try {
    spawnSync('docker', ['rm', '-f', 'sbi-tei'], { encoding: 'utf-8' });
  } catch {
    // Ignore -- no existing container
  }

  // TEI only publishes linux/amd64 images. On ARM (Apple Silicon) we need
  // Rosetta / QEMU emulation via --platform linux/amd64.
  const isArm = process.arch === 'arm64';

  // ── ARM: pre-download model on host to avoid TEI download bug ───────────
  //
  // TEI's Rust HuggingFace hub client fails under Rosetta emulation with
  // "relative URL without a base" when trying to download model artifacts.
  // Fix: download on the host and mount the cache into the container.
  const hfCacheDir = path.join(
    process.env['HOME'] ?? '/tmp',
    '.cache',
    'huggingface',
    'hub',
  );
  let useVolumeMount = false;

  if (isArm) {
    console.log('  [!] ARM architecture detected (Apple Silicon).');
    console.log('      TEI image is x86-only — running under Rosetta emulation.');
    console.log('      Pre-downloading model on host to avoid TEI download bug...');
    console.log('');

    const downloaded = preDownloadModel(model, hfCacheDir);
    if (downloaded) {
      useVolumeMount = true;
      console.log('');
      console.log('  Model pre-downloaded. Mounting cache into container.');
    } else {
      console.log('');
      console.log('  [!] Could not pre-download model.');
      console.log('      Install huggingface-cli:  pip install huggingface_hub');
      console.log('      Or: brew install huggingface-cli');
      console.log('');
      console.log('      Attempting direct Docker download anyway (may fail on ARM)...');
    }
    console.log('');
  } else {
    console.log('  (First run downloads the model -- this may take a few minutes)');
    console.log('');
  }

  const dockerArgs = [
    'run', '-d',
    '--name', 'sbi-tei',
    '-p', `${TEI_PORT}:80`,
    ...(isArm ? ['--platform', 'linux/amd64'] : []),
    // Pass HF_TOKEN into the container so TEI can authenticate with the Hub
    // (needed for gated models and higher download rate limits).
    ...(process.env['HF_TOKEN'] ? ['-e', `HF_TOKEN=${process.env['HF_TOKEN']}`] : []),
    // Mount the host HF cache into the container's model cache directory.
    // On ARM this provides the pre-downloaded model; on x86 it enables
    // caching across container restarts.
    ...(useVolumeMount
      ? ['-v', `${hfCacheDir}:/data`]
      : []),
    '--pull', 'always',
    TEI_DOCKER_IMAGE,
    '--model-id', model,
    '--max-client-batch-size', '64',
  ];

  const result = spawnSync('docker', dockerArgs, { encoding: 'utf-8', timeout: 30_000 });

  if (result.status !== 0) {
    console.log('  [!] Failed to start TEI container:');
    console.log(`      ${result.stderr?.trim() ?? 'unknown error'}`);
    console.log('');
    console.log('  Troubleshooting:');
    console.log('    - Make sure Docker Desktop is running');
    if (isArm) {
      console.log('    - On Apple Silicon, ensure Rosetta is enabled in Docker Desktop settings');
      console.log('    - Install huggingface-cli: pip install huggingface_hub');
      console.log('    - Consider using Ollama instead (native ARM support)');
    }
    console.log('    - Try manually:');
    console.log(`      huggingface-cli download ${model}`);
    console.log(`      docker run -d --name sbi-tei -p 8080:80 \\`);
    console.log(`        ${isArm ? '--platform linux/amd64 ' : ''}-v ~/.cache/huggingface/hub:/data \\`);
    console.log(`        ${TEI_DOCKER_IMAGE} --model-id ${model}`);
    return false;
  }

  const containerId = result.stdout?.trim();
  console.log(`  Container started: ${containerId?.slice(0, 12) ?? 'unknown'}`);
  console.log('  Waiting for TEI to become ready (model loading under emulation can be slow)...');

  // Poll /health until ready. Model loading under Rosetta can take 5+ minutes
  // for large models, so we allow up to 5 minutes on ARM.
  const maxWaitMs = isArm ? 300_000 : 180_000;
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

    // Check if the container has exited with an error
    try {
      const inspect = spawnSync('docker', ['inspect', '--format', '{{.State.Status}}', 'sbi-tei'], {
        encoding: 'utf-8',
        timeout: 3000,
      });
      if (inspect.stdout?.trim() === 'exited') {
        console.log('');
        console.log('  [!] TEI container exited unexpectedly.');
        console.log('      Check logs: docker logs sbi-tei');
        return false;
      }
    } catch {
      // Ignore inspect errors
    }
  }

  console.log('');

  if (!ready) {
    const maxMin = Math.round(maxWaitMs / 60_000);
    console.log(`  [!] TEI did not become ready within ${maxMin} minutes.`);
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
 * Detects running services and always presents the embedding backend menu.
 *
 * Flow:
 * 1. Probes TEI and Ollama to see what is currently running.
 * 2. Shows a menu with running services listed first (✓ marker).
 * 3. Defaults to the currently-configured backend.
 * 4. If the user picks a service that isn't running yet, starts it.
 * 5. Writes the chosen backend to .env.
 *
 * When --no-embedding-setup is passed, auto-selects: use whatever is
 * configured and reachable, or fall back to graph + BM25.
 */
async function handleEmbeddingSetup(userRoot: string, skipPrompt: boolean): Promise<void> {
  const envPath = path.join(userRoot, '.env');

  // ── Detect what's running ───────────────────────────────────────────────
  process.stdout.write('  Detecting embedding services... ');
  const running = await detectRunningServices();

  const parts: string[] = [];
  if (running.teiRunning) parts.push('TEI ✓');
  if (running.ollamaRunning) parts.push('Ollama ✓');
  if (parts.length === 0) parts.push('none found');
  console.log(parts.join(', '));
  console.log('');

  // ── Skip prompt mode: auto-select ───────────────────────────────────────
  if (skipPrompt) {
    const backend = process.env['SBI_EMBEDDING_BACKEND'] ?? 'local';
    const embeddingUrl = process.env['SBI_EMBEDDING_URL'] ?? TEI_URL;
    const currentIsOllama = embeddingUrl.includes(String(OLLAMA_PORT));
    const normalizedUrl = embeddingUrl.replace(/\/+$/, '');
    const isDefaultOllama = normalizedUrl === OLLAMA_URL;
    const isDefaultTei = normalizedUrl === TEI_URL;

    if (backend === 'none') {
      console.log('  Embeddings: disabled (graph + BM25 only)');
    } else if (backend === 'openai') {
      console.log('  Embeddings: OpenAI API');
    } else {
      const configuredRunning = currentIsOllama
        ? isDefaultOllama
          ? running.ollamaRunning
          : await isReachable(`${normalizedUrl}/api/version`)
        : isDefaultTei
          ? running.teiRunning
          : await isReachable(`${normalizedUrl}/health`);

      if (configuredRunning) {
        console.log(
          `  Embeddings: ${currentIsOllama ? 'Ollama' : 'TEI'} at ${embeddingUrl}`,
        );
      } else {
        // Preserve the user's .env while making the promised fallback real for
        // this invocation; otherwise the pipeline would repeatedly call a dead
        // endpoint before eventually degrading.
        process.env['SBI_EMBEDDING_BACKEND'] = 'none';
        console.log(
          '  No configured embedding service running -- using graph + BM25 for this run.',
        );
      }
    }
    console.log('');
    return;
  }

  // ── Always show the menu ────────────────────────────────────────────────
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const setupResult = await promptEmbeddingSetup(rl, running);
  rl.close();

  console.log('');

  if (setupResult.backend === 'skip') {
    const backend = process.env['SBI_EMBEDDING_BACKEND'] ?? 'local';
    const url = process.env['SBI_EMBEDDING_URL'] ?? TEI_URL;
    if (backend === 'local') {
      const label = url.includes(String(OLLAMA_PORT)) ? 'Ollama' : 'TEI';
      console.log(`  Keeping current: ${label} at ${url}`);
    } else {
      console.log(`  Keeping current: ${backend}`);
    }
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
    writeEnvKey(envPath, 'SBI_EMBEDDING_MODEL', 'text-embedding-3-small');
    process.env['SBI_EMBEDDING_BACKEND'] = 'openai';
    process.env['SBI_EMBEDDING_MODEL'] = 'text-embedding-3-small';
    console.log('  Set to OpenAI embeddings. Saved to .env');
    console.log('');
    return;
  }

  // ── Local: TEI or Ollama ────────────────────────────────────────────────
  const isOllama = setupResult.url.includes(String(OLLAMA_PORT));
  const alreadyRunning = isOllama ? running.ollamaRunning : running.teiRunning;

  let ready = alreadyRunning;

  if (!ready) {
    // Service isn't running yet — start it
    if (isOllama) {
      ready = await startOllama();
    } else {
      const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });
      ready = await startTEI(rl2);
      rl2.close();
    }
  }

  if (ready) {
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
    process.env['SBI_EMBEDDING_BACKEND'] = 'none';
    console.log('');
    console.log('  Setup failed. Continuing with graph + BM25 only for this run.');
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
  let args;
  try {
    args = parseRatArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    console.error('Run `rat --help` for usage.');
    process.exitCode = 1;
    return;
  }

  // Help and version are intentionally handled before .env loading, filesystem
  // discovery, builds, network probes, or Docker/Ollama commands.
  if (args.help) {
    printUsage();
    return;
  }
  if (args.version) {
    console.log(VERSION);
    return;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('Error: RAT requires an interactive terminal.');
    console.error('Use `sbi analyze <bundle.tar.gz>` for non-interactive analysis.');
    process.exitCode = 1;
    return;
  }

  // Runtime configuration and user data are rooted in the caller's working
  // directory. Package-root discovery is only for development build assets.
  loadDotEnv();
  const userRoot = process.cwd();
  const projectRoot = findProjectRoot();

  if (!args.noBuild) {
    ensureBuilt(projectRoot);
  }

  const target = resolveRatTarget(args.path, userRoot);

  if (args.path !== undefined && !fs.existsSync(target)) {
    console.error(`Error: Path does not exist: ${path.resolve(target)}`);
    process.exitCode = 1;
    return;
  }

  // Direct bundle path — skip setup flow, go straight to TUI
  if (
    fs.existsSync(target) &&
    fs.statSync(target).isFile() &&
    target.toLowerCase().endsWith('.tar.gz')
  ) {
    const { renderTUI } = await import('../tui/index.js');
    const outcome = await renderTUI(path.resolve(target), {});
    if (!outcome.ok) {
      process.exitCode = 'cancelled' in outcome && outcome.cancelled ? 130 : 1;
    }
    return;
  }

  if (fs.existsSync(target) && fs.statSync(target).isFile()) {
    console.error(`Error: Bundle must be a .tar.gz file: ${path.resolve(target)}`);
    process.exitCode = 1;
    return;
  }

  // Print banner once
  printBanner();

  // Determine scan directory
  const scanDir = target;

  const bundles = await findBundles(scanDir);

  if (bundles.length === 0) {
    console.log(`  No .tar.gz support bundles found in: ${path.resolve(scanDir)}`);
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
    process.exitCode = 1;
    return;
  }

  // Only probe or offer to install embedding services after confirming there
  // is work to analyze. An empty bundles directory should remain fast and
  // side-effect-free.
  await handleEmbeddingSetup(userRoot, args.noEmbeddingSetup);

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
  const outcome = await renderTUI(bundlePath, {});
  if (!outcome.ok) {
    process.exitCode = 'cancelled' in outcome && outcome.cancelled ? 130 : 1;
  }
}

main().catch((err: unknown) => {
  console.error('Fatal:', err);
  process.exitCode = 1;
});
