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

  /** Maximum allowed uncompressed size in bytes across archive entries. */
  maxSize?: number;

  /** Maximum number of entries allowed in the archive. */
  maxEntries?: number;

  /** Maximum uncompressed size in bytes for any individual entry. */
  maxEntrySize?: number;

  /** Maximum UTF-8 byte length of an entry path or link target. */
  maxPathLength?: number;
}

/** Default archive limits. Callers may lower them for constrained environments. */
export const DEFAULT_MAX_UNCOMPRESSED_SIZE = 5 * 1024 * 1024 * 1024;
export const DEFAULT_MAX_ENTRY_SIZE = 1024 * 1024 * 1024;
export const DEFAULT_MAX_ENTRIES = 100_000;
export const DEFAULT_MAX_PATH_LENGTH = 4_096;

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

function resolveLimit(
  name: keyof Pick<
    ExtractOptions,
    'maxSize' | 'maxEntries' | 'maxEntrySize' | 'maxPathLength'
  >,
  value: number | undefined,
  fallback: number,
): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return limit;
}

async function validateArchive(
  bundlePath: string,
  options: ExtractOptions,
): Promise<void> {
  const maxSize = resolveLimit(
    'maxSize',
    options.maxSize,
    DEFAULT_MAX_UNCOMPRESSED_SIZE,
  );
  const maxEntries = resolveLimit(
    'maxEntries',
    options.maxEntries,
    DEFAULT_MAX_ENTRIES,
  );
  const maxEntrySize = resolveLimit(
    'maxEntrySize',
    options.maxEntrySize,
    DEFAULT_MAX_ENTRY_SIZE,
  );
  const maxPathLength = resolveLimit(
    'maxPathLength',
    options.maxPathLength,
    DEFAULT_MAX_PATH_LENGTH,
  );

  let totalUncompressedSize = 0;
  let entryCount = 0;

  await new Promise<void>((resolve, reject) => {
    const parser = new tar.Parser({ file: bundlePath, strict: true });
    const input = fs.createReadStream(bundlePath);
    let settled = false;

    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      input.unpipe(parser);
      input.destroy();
      reject(error);
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    parser.once('error', fail);
    parser.once('end', succeed);
    input.once('error', fail);
    parser.on('entry', (entry) => {
      try {
        entryCount += 1;
        if (entryCount > maxEntries) {
          throw new Error(
            `Archive exceeds maxEntries of ${maxEntries}: at least ${entryCount}`,
          );
        }

        if (isUnsafeArchivePath(entry.path)) {
          throw new Error(`Archive contains unsafe path: ${entry.path}`);
        }

        const pathLength = Buffer.byteLength(entry.path, 'utf8');
        if (pathLength > maxPathLength) {
          throw new Error(
            `Archive entry path exceeds maxPathLength of ${maxPathLength} bytes: ${pathLength}`,
          );
        }

        if (entry.linkpath !== undefined) {
          if (isUnsafeArchivePath(entry.linkpath)) {
            throw new Error(`Archive contains unsafe link target: ${entry.linkpath}`);
          }
          const linkPathLength = Buffer.byteLength(entry.linkpath, 'utf8');
          if (linkPathLength > maxPathLength) {
            throw new Error(
              `Archive link target exceeds maxPathLength of ${maxPathLength} bytes: ${linkPathLength}`,
            );
          }
        }

        if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
          throw new Error(`Archive entry has an invalid size: ${entry.path}`);
        }
        if (entry.size > maxEntrySize) {
          throw new Error(
            `Archive entry exceeds maxEntrySize of ${maxEntrySize} bytes: ${entry.path} (${entry.size})`,
          );
        }
        if (entry.size > maxSize - totalUncompressedSize) {
          throw new Error(
            `Archive exceeds maxSize of ${maxSize} bytes: more than ${maxSize}`,
          );
        }
        totalUncompressedSize += entry.size;
        entry.resume();
      } catch (error) {
        parser.abort(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    });

    input.pipe(parser);
  });
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
 * - Default limits cap aggregate expansion, individual entry size, entry
 *   count, and path length. Callers may supply stricter limits.
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
  if (!absoluteBundlePath.toLowerCase().endsWith('.tar.gz')) {
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
      preservePaths: false,
      strict: true,
    });

    return await buildManifest(outputDir, absoluteBundlePath);
  } catch (err) {
    if (ownsTempDir) {
      await fsp.rm(outputDir, { recursive: true, force: true }).catch(() => undefined);
    }
    throw err;
  }
}
