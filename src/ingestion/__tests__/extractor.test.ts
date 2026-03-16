import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as zlib from 'zlib';
import { promisify } from 'util';
import * as tar from 'tar';
import { extractBundle } from '../extractor.js';
import * as manifestModule from '../manifest.js';

const gzip = promisify(zlib.gzip);

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const FIXTURES_DIR = path.resolve(__dirname, '../../../test/fixtures/scenarios');

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Pack a fixture scenario into a .tar.gz file at outputPath. */
async function createFixtureTarGz(scenario: string, outputPath: string): Promise<void> {
  const scenarioDir = path.join(FIXTURES_DIR, scenario);
  await tar.c({ gzip: true, file: outputPath, cwd: path.dirname(scenarioDir) }, [
    path.basename(scenarioDir),
  ]);
}

/** Build a raw tar buffer (uncompressed) from the given entries.
 *
 * This intentionally low-level helper allows crafting entries with paths that
 * would normally be rejected by the filesystem or the tar CLI (e.g. `../`
 * traversal paths), so we can verify that extractBundle handles them safely.
 */
function buildRawTar(entries: Array<{ entryPath: string; data: string }>): Buffer {
  const parts: Buffer[] = [];

  for (const { entryPath, data } of entries) {
    const dataBuffer = Buffer.from(data, 'utf8');
    const header = Buffer.alloc(512, 0);

    // name (100 bytes, offset 0) – truncate to 99 chars + implicit null
    Buffer.from(entryPath, 'ascii').copy(header, 0, 0, 99);
    // mode (8 bytes, offset 100)
    Buffer.from('0000644\0').copy(header, 100);
    // uid (8 bytes, offset 108)
    Buffer.from('0000000\0').copy(header, 108);
    // gid (8 bytes, offset 116)
    Buffer.from('0000000\0').copy(header, 116);
    // size (12 bytes, offset 124) – 11-digit octal + null
    const sizeOctal = dataBuffer.length.toString(8).padStart(11, '0') + '\0';
    Buffer.from(sizeOctal).copy(header, 124);
    // mtime (12 bytes, offset 136) – 11-digit octal + space
    Buffer.from('00000000000 ').copy(header, 136);
    // typeflag (1 byte, offset 156): '0' = regular file
    header[156] = 0x30;
    // magic (6 bytes, offset 257): ustar POSIX
    Buffer.from('ustar\0').copy(header, 257);
    // version (2 bytes, offset 263)
    Buffer.from('00').copy(header, 263);
    // checksum placeholder (8 spaces at offset 148 – required before summing)
    Buffer.from('        ').copy(header, 148);

    // Compute unsigned-byte sum of entire 512-byte header
    let checksum = 0;
    for (let i = 0; i < 512; i++) checksum += header[i];

    // Write as 6-octal-digit string + NUL + space (8 bytes total)
    Buffer.from(checksum.toString(8).padStart(6, '0') + '\0 ').copy(header, 148);

    parts.push(header);

    // Data blocks padded to 512-byte boundary
    if (dataBuffer.length > 0) {
      const paddedLen = Math.ceil(dataBuffer.length / 512) * 512;
      const padded = Buffer.alloc(paddedLen, 0);
      dataBuffer.copy(padded);
      parts.push(padded);
    }
  }

  // End-of-archive: two zero 512-byte blocks
  parts.push(Buffer.alloc(1024, 0));

  return Buffer.concat(parts);
}

/** Write a tar.gz file with path-traversal entries for security tests. */
async function createTraversalTarGz(outputPath: string): Promise<void> {
  const tarBuffer = buildRawTar([
    { entryPath: 'safe.txt', data: 'safe content' },
    { entryPath: '../evil.txt', data: 'evil content' },
  ]);
  await fsp.writeFile(outputPath, await gzip(tarBuffer));
}

/** Write a valid but empty tar.gz (archive containing only a directory entry, no files). */
async function createEmptyTarGz(outputPath: string): Promise<void> {
  // Pack an empty directory so the archive is well-formed (the directory entry
  // satisfies the parser's SAW_VALID_ENTRY check) but contains no files.
  // A tar consisting of only null-block end-of-archive markers is rejected by
  // tar v7 as TAR_BAD_ARCHIVE (unrecoverable), so we use this approach instead.
  const base = path.dirname(outputPath);
  const emptyDirName = 'empty-bundle-dir';
  await fsp.mkdir(path.join(base, emptyDirName), { recursive: true });
  await tar.c({ gzip: true, file: outputPath, cwd: base }, [emptyDirName]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('extractBundle', () => {
  let tmpDir: string;
  let validBundlePath: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbi-extractor-test-'));
    validBundlePath = path.join(tmpDir, 'wrong-db-endpoint.tar.gz');
    await createFixtureTarGz('wrong-db-endpoint', validBundlePath);
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------

  it('successfully extracts a valid .tar.gz to a temp directory', async () => {
    const manifest = await extractBundle(validBundlePath);

    expect(manifest.extractedPath).toBeTruthy();
    expect(fs.existsSync(manifest.extractedPath)).toBe(true);

    // cleanup
    fs.rmSync(manifest.extractedPath, { recursive: true, force: true });
  });

  it('returns a BundleManifest with all file entries', async () => {
    const manifest = await extractBundle(validBundlePath);

    expect(manifest.bundlePath).toBe(path.resolve(validBundlePath));
    expect(manifest.files.length).toBeGreaterThan(0);
    expect(manifest.totalSize).toBeGreaterThan(0);
    expect(manifest.extractedAt).toBeInstanceOf(Date);

    for (const file of manifest.files) {
      expect(file.relativePath).toBeTruthy();
      expect(file.absolutePath).toBeTruthy();
      expect(typeof file.size).toBe('number');
      expect(file.size).toBeGreaterThanOrEqual(0);
      expect(file.category).toBe('unknown');
    }

    // cleanup
    fs.rmSync(manifest.extractedPath, { recursive: true, force: true });
  });

  it('rejects non-.tar.gz files with a clear error', async () => {
    const zipPath = path.join(tmpDir, 'bundle.zip');
    fs.writeFileSync(zipPath, 'not a tar.gz');

    await expect(extractBundle(zipPath)).rejects.toThrow(/\.tar\.gz/);
  });

  it('handles empty archive gracefully', async () => {
    const emptyPath = path.join(tmpDir, 'empty.tar.gz');
    await createEmptyTarGz(emptyPath);

    const manifest = await extractBundle(emptyPath);

    expect(manifest.files).toHaveLength(0);
    expect(manifest.totalSize).toBe(0);

    // cleanup
    fs.rmSync(manifest.extractedPath, { recursive: true, force: true });
  });

  it('enforces maxSize when provided', async () => {
    await expect(extractBundle(validBundlePath, { maxSize: 1 })).rejects.toThrow(/maxSize/i);
  });

  it('protects against path traversal (entries with ../ are rejected)', async () => {
    const traversalPath = path.join(tmpDir, 'traversal.tar.gz');
    await createTraversalTarGz(traversalPath);

    const outputDir = fs.mkdtempSync(path.join(tmpDir, 'traversal-extracted-'));

    await expect(extractBundle(traversalPath, { outputDir })).rejects.toThrow(/unsafe path/i);

    // evil.txt must NOT have escaped outside the outputDir
    const escapedEvilPath = path.join(path.dirname(outputDir), 'evil.txt');
    expect(fs.existsSync(escapedEvilPath)).toBe(false);

    // Pre-validation should prevent partial extraction as well.
    expect(fs.readdirSync(outputDir)).toHaveLength(0);
  });

  it('detects a missing bundle file', async () => {
    const missingPath = path.join(tmpDir, 'does-not-exist.tar.gz');

    await expect(extractBundle(missingPath)).rejects.toThrow(/not found or not readable/i);
  });

  it('detects an unreadable bundle file', async () => {
    if (process.platform === 'win32') {
      return;
    }

    const unreadablePath = path.join(tmpDir, 'unreadable.tar.gz');
    await createFixtureTarGz('wrong-db-endpoint', unreadablePath);
    fs.chmodSync(unreadablePath, 0o000);

    try {
      await expect(extractBundle(unreadablePath)).rejects.toThrow(/not found or not readable/i);
    } finally {
      fs.chmodSync(unreadablePath, 0o644);
    }
  });

  it('cleans up the auto-created temp directory when post-extraction processing fails', async () => {
    const uniqueId = `cleanup-check-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const sourceDir = path.join(tmpDir, uniqueId);
    const markerFile = `${uniqueId}.txt`;
    const bundlePath = path.join(tmpDir, `${uniqueId}.tar.gz`);

    await fsp.mkdir(sourceDir, { recursive: true });
    await fsp.writeFile(path.join(sourceDir, markerFile), 'cleanup marker', 'utf8');
    await tar.c({ gzip: true, file: bundlePath, cwd: tmpDir }, [uniqueId]);

    const buildManifestSpy = vi
      .spyOn(manifestModule, 'buildManifest')
      .mockRejectedValue(new Error('manifest build failed'));

    try {
      await expect(extractBundle(bundlePath)).rejects.toThrow(/manifest build failed/i);

      const leftoverDirs = fs
        .readdirSync(os.tmpdir())
        .filter((dir) => dir.startsWith('sbi-bundle-'))
        .filter((dir) =>
          fs.existsSync(path.join(os.tmpdir(), dir, uniqueId, markerFile)),
        );

      expect(leftoverDirs).toHaveLength(0);
    } finally {
      buildManifestSpy.mockRestore();
    }
  });

  it('populates file sizes correctly in the manifest', async () => {
    const manifest = await extractBundle(validBundlePath);

    for (const file of manifest.files) {
      const stat = fs.statSync(file.absolutePath);
      expect(file.size).toBe(stat.size);
    }

    const expectedTotal = manifest.files.reduce((sum, f) => sum + f.size, 0);
    expect(manifest.totalSize).toBe(expectedTotal);

    // cleanup
    fs.rmSync(manifest.extractedPath, { recursive: true, force: true });
  });
});
