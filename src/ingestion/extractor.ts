import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as tar from 'tar';
import { buildManifest } from './manifest.js';
import type { BundleManifest } from '../types/index.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ExtractOptions {
  /**
   * Directory to extract into. When omitted a temporary directory is created
   * under `os.tmpdir()` automatically. The caller is responsible for cleaning
   * up a custom `outputDir`; auto-created temp directories are removed on
   * extraction failure.
   */
  outputDir?: string;

  /**
   * Maximum allowed uncompressed size in bytes across archive entries.
   */
  maxSize?: number;

  /**
   * When true, perform a full archive validation pass before extraction.
   * Security validation is always performed.
   */
  validateIntegrity?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isUnsafeArchivePath(entryPath: string): boolean {
  const normalizedPath = entryPath.replace(/\\/g, '/');

  if (normalizedPath.startsWith('/')) {
    return true;
  }

  if (/^[A-Za-z]:\//.test(normalizedPath)) {
    return true;
  }

  return normalizedPath.split('/').some((segment) => segment === '..');
}

async function validateArchive(
  bundlePath: string,
  options: ExtractOptions,
): Promise<void> {
  let totalUncompressedSize = 0;
  let unsafePath: string | undefined;

  await tar.t({
    file: bundlePath,
    onentry(entry) {
      if (!unsafePath && isUnsafeArchivePath(entry.path)) {
        unsafePath = entry.path;
      }

      totalUncompressedSize += entry.size;
    },
  });

  if (unsafePath) {
    throw new Error(`Archive contains unsafe path: ${unsafePath}`);
  }

  if (
    typeof options.maxSize === 'number' &&
    totalUncompressedSize > options.maxSize
  ) {
    throw new Error(
      `Archive exceeds maxSize of ${options.maxSize} bytes: ${totalUncompressedSize}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Extracts a `.tar.gz` support bundle archive and returns a
 * {@link BundleManifest} describing every file found inside.
 *
 * Safety guarantees
 * -----------------
 * - Only files with a `.tar.gz` extension are accepted.
 * - The archive is validated before extraction and rejected if any entry path
 *   is absolute or contains `..` path segments.
 * - If an auto-created temporary directory is used and extraction fails for
 *   any reason, that directory is removed before the error is re-thrown.
 *
 * @param bundlePath - Path to the `.tar.gz` archive to extract.
 * @param options    - Optional extraction settings.
 * @returns A fully populated {@link BundleManifest} (file categories are all
 *          set to `'unknown'`; classification happens in the profiling step).
 */
export async function extractBundle(
  bundlePath: string,
  options: ExtractOptions = {},
): Promise<BundleManifest> {
  const absoluteBundlePath = path.resolve(bundlePath);

  // ── 1. Validate file accessibility ────────────────────────────────────────
  try {
    await fsp.access(absoluteBundlePath, fs.constants.R_OK);
  } catch {
    throw new Error(`Bundle file not found or not readable: ${absoluteBundlePath}`);
  }

  // ── 2. Validate extension ─────────────────────────────────────────────────
  if (!absoluteBundlePath.endsWith('.tar.gz')) {
    throw new Error(
      `Bundle must be a .tar.gz file, got: ${path.basename(absoluteBundlePath)}`,
    );
  }

  // ── 3. Validate archive contents before extraction ────────────────────────
  await validateArchive(absoluteBundlePath, options);

  // ── 4. Prepare output directory ───────────────────────────────────────────
  let outputDir: string;
  let ownsTempDir = false;

  if (options.outputDir) {
    outputDir = path.resolve(options.outputDir);
    await fsp.mkdir(outputDir, { recursive: true });
  } else {
    outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sbi-bundle-'));
    ownsTempDir = true;
  }

  // ── 5. Extract & build manifest ───────────────────────────────────────────
  try {
    await tar.x({
      file: absoluteBundlePath,
      cwd: outputDir,
    });

    return await buildManifest(outputDir, absoluteBundlePath);
  } catch (err) {
    if (ownsTempDir) {
      await fsp.rm(outputDir, { recursive: true, force: true }).catch(() => undefined);
    }
    throw err;
  }
}
