import * as fsp from 'fs/promises';
import * as path from 'path';
import { glob } from 'glob';
import type { ArtifactEntry, BundleManifest } from '../types/index.js';

// ---------------------------------------------------------------------------
// OS junk file filter
// ---------------------------------------------------------------------------

/**
 * File-name patterns that should be excluded from the manifest.
 *
 * These are typically injected by macOS (Apple Double `._*` resource forks,
 * `.DS_Store`) or other OS/editor tooling and are never valid bundle
 * artifacts.
 */
const JUNK_BASENAME_PATTERNS: RegExp[] = [
  /^\._/,           // macOS Apple Double / resource fork files
  /^\.DS_Store$/,   // macOS Finder metadata
  /^Thumbs\.db$/i,  // Windows thumbnail cache
  /^desktop\.ini$/i, // Windows folder settings
];

/**
 * Returns `true` if `relativePath` looks like an OS-injected junk file that
 * should be excluded from the bundle manifest.
 */
function isJunkFile(relativePath: string): boolean {
  const basename = relativePath.split('/').pop() ?? '';
  return JUNK_BASENAME_PATTERNS.some((pattern) => pattern.test(basename));
}

// ---------------------------------------------------------------------------
// buildManifest
// ---------------------------------------------------------------------------

/**
 * Recursively walks `extractedDir` and builds a {@link BundleManifest}.
 *
 * Each file found becomes an {@link ArtifactEntry} with:
 *  - `relativePath`  – path relative to `extractedDir` (using forward-slash separators)
 *  - `absolutePath`  – resolved absolute path on disk
 *  - `size`          – file size in bytes from `fs.stat`
 *  - `category`      – always `'unknown'`; classification is done in the profiling step
 *
 * OS-injected junk files (macOS `._*` resource forks, `.DS_Store`, etc.) are
 * automatically excluded from the manifest so they never reach downstream
 * parsers.
 *
 * @param extractedDir - Absolute path of the directory produced by tar extraction.
 * @param bundlePath   - Original bundle archive path stored in the manifest.
 */
export async function buildManifest(
  extractedDir: string,
  bundlePath: string,
): Promise<BundleManifest> {
  const resolvedExtractedDir = path.resolve(extractedDir);
  const resolvedBundlePath = path.resolve(bundlePath);

  const relativePaths = (
    await glob('**/*', {
      cwd: resolvedExtractedDir,
      nodir: true,
      dot: true,
      posix: true,
    })
  )
    .filter((p) => !isJunkFile(p))
    .sort((left, right) => left.localeCompare(right));

  const entries: ArtifactEntry[] = [];
  let totalSize = 0;

  for (const relativePath of relativePaths) {
    const absolutePath = path.resolve(resolvedExtractedDir, relativePath);
    const stat = await fsp.stat(absolutePath);

    totalSize += stat.size;
    entries.push({
      relativePath,
      absolutePath,
      size: stat.size,
      category: 'unknown',
    });
  }

  return {
    bundlePath: resolvedBundlePath,
    extractedPath: resolvedExtractedDir,
    files: entries,
    totalSize,
    extractedAt: new Date(),
  };
}
