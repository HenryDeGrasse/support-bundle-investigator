import * as fsp from 'fs/promises';
import type { BundleManifest, ArtifactEntry } from '../types/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LogLevel = 'error' | 'warning' | 'info' | 'debug' | 'unknown';

export interface LogLine {
  lineNumber: number;
  content: string;
  level: LogLevel;
  timestamp?: string;
}

export interface LogFile {
  path: string;
  lines: LogLine[];
  errorCount: number;
  warningCount: number;
  importance: number;
}

export interface ErrorWindow {
  centerLine: number;
  lines: LogLine[];
  matchedPattern: string;
}

export interface LogParseOptions {
  maxLines?: number;
  windowSize?: number;
  dedup?: boolean;
}

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

/**
 * Ordered list of [pattern, level] tuples. The first match wins.
 */
const LEVEL_PATTERNS: Array<[RegExp, LogLevel]> = [
  // FATAL / panic always → error (checked before generic ERROR)
  [/\bFATAL\b/i, 'error'],
  [/\bpanic\b/i, 'error'],
  // Structured log level=error
  [/\blevel\s*=\s*err(or)?\b/i, 'error'],
  [/\blevel\s*=\s*fatal\b/i, 'error'],
  // Bracketed / prefixed
  [/\[ERR(OR)?\]/i, 'error'],
  [/\bERROR\b/i, 'error'],
  // Warn
  [/\blevel\s*=\s*warn(ing)?\b/i, 'warning'],
  [/\[WARN(ING)?\]/i, 'warning'],
  [/\bWARN(ING)?\b/i, 'warning'],
  // Info
  [/\blevel\s*=\s*info\b/i, 'info'],
  [/\[INFO\]/i, 'info'],
  [/\bINFO\b/i, 'info'],
  // Debug
  [/\blevel\s*=\s*debug\b/i, 'debug'],
  [/\[DEBUG\]/i, 'debug'],
  [/\bDEBUG\b/i, 'debug'],
];

/**
 * Common log timestamp patterns (ordered most-specific first).
 *
 * 1. ISO 8601 with fractional seconds and Z:  2024-01-15T10:00:00.123Z
 * 2. ISO 8601 with timezone offset:           2024-01-15T10:00:00+05:30
 * 3. Plain ISO 8601 with Z:                   2024-01-15T10:00:00Z
 * 4. Syslog:                                  Jan 15 10:00:00
 */
const TIMESTAMP_PATTERNS: RegExp[] = [
  /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?/,
  /(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}/,
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if decoded content looks binary (contains NUL bytes or a high
 * proportion of control/invalid UTF-8 characters). Printable Unicode is valid
 * log text and must not be mistaken for binary data.
 */
function isBinaryContent(content: string): boolean {
  // NUL byte is a clear binary indicator
  if (content.includes('\0')) return true;

  // Sample the first 1 KB and check for control/invalid characters. Values
  // above the ASCII range are intentionally allowed: logs commonly contain
  // names, messages, and emoji in UTF-8.
  const sample = content.slice(0, 1024);
  if (sample.length === 0) return false;

  let nonPrintable = 0;
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    const isAllowedWhitespace = code === 9 || code === 10 || code === 13;
    const isControl = code < 32 || (code >= 0x7f && code <= 0x9f);
    const isInvalidUtf8Replacement = code === 0xfffd;
    if (!isAllowedWhitespace && (isControl || isInvalidUtf8Replacement)) {
      nonPrintable++;
    }
  }
  return nonPrintable / sample.length > 0.1;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns true when the entry path looks like an application/system log.
 *
 * We trust manifest classification when present, but also fall back to path
 * inspection so callers can identify log-like files from lightly classified or
 * hand-built manifests used in tests.
 */
function isLogLikeEntry(entry: ArtifactEntry): boolean {
  if (entry.category === 'log') return true;

  const normalizedPath = entry.relativePath.replaceAll('\\', '/').toLowerCase();
  const segments = normalizedPath.split('/');
  const filename = segments[segments.length - 1] ?? '';

  const isStdStreamLog = filename === 'stdout.log' || filename === 'stderr.log';
  const isLogInsideLogsDir = segments.includes('logs') && filename.endsWith('.log');

  return isStdStreamLog || isLogInsideLogsDir;
}

/**
 * Returns all entries from the manifest that are classified as 'log' files.
 *
 * Files already tagged with the `log` artifact category are included, as are
 * any `.log` files found under a `logs/` path segment plus standalone
 * `stdout.log` / `stderr.log` files.
 */
export function identifyLogFiles(manifest: BundleManifest): ArtifactEntry[] {
  return manifest.files.filter((entry) => isLogLikeEntry(entry));
}

/**
 * Categorises a single log line by level.
 *
 * Patterns are evaluated in priority order (see `LEVEL_PATTERNS`).
 */
export function classifyLogLevel(line: string): LogLevel {
  for (const [pattern, level] of LEVEL_PATTERNS) {
    if (pattern.test(line)) {
      return level;
    }
  }
  return 'unknown';
}

/**
 * Extracts the first recognised timestamp from a log line.
 *
 * Returns the matched string or `null` when no pattern matches.
 */
export function extractTimestamps(line: string): string | null {
  for (const pattern of TIMESTAMP_PATTERNS) {
    const match = line.match(pattern);
    if (match) return match[0] ?? null;
  }
  return null;
}

/**
 * Pattern used to strip leading timestamps before near-identical comparison.
 */
const TIMESTAMP_STRIP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?\s*/;

/**
 * Returns a normalised "fingerprint" for a log line used during deduplication.
 *
 * The leading timestamp is stripped so that lines differing only in their
 * timestamp (e.g. repeated connection errors) are treated as near-identical.
 */
function lineFingerprint(content: string): string {
  return content.replace(TIMESTAMP_STRIP_RE, '');
}

/**
 * Collapses consecutive runs of identical or near-identical log lines into a
 * single entry.
 *
 * Two lines are considered "near-identical" when their content is the same
 * after stripping leading timestamps.  When N such lines appear in sequence
 * (N > 1) the first line's content is suffixed with ` [repeated xN]` so
 * reviewers can spot noise quickly.
 */
export function deduplicateLogLines(lines: LogLine[]): LogLine[] {
  if (lines.length === 0) return [];

  const result: LogLine[] = [];
  let runStart = 0;

  for (let i = 1; i <= lines.length; i++) {
    const current = lines[i];
    const prev = lines[runStart]!;

    if (current && lineFingerprint(current.content) === lineFingerprint(prev.content)) {
      // Still in the same run
      continue;
    }

    const runLength = i - runStart;
    if (runLength === 1) {
      result.push(prev);
    } else {
      result.push({
        ...prev,
        content: `${prev.content} [repeated x${runLength}]`,
      });
    }

    runStart = i;
  }

  return result;
}

/**
 * Computes an importance score (0–1) for a log file based on the density of
 * error and warning lines relative to total line count.
 *
 * Formula: `min(1, (errors * 2 + warnings) / totalLines)`
 *
 * A file of all errors scores 1.  Pure info/debug files score 0.
 */
export function classifyLogImportance(logFile: LogFile): number {
  const total = logFile.lines.length;
  if (total === 0) return 0;

  const score = (logFile.errorCount * 2 + logFile.warningCount) / total;
  return Math.min(1, score);
}

/**
 * Extracts context windows around each error-level line in a log file.
 *
 * @param logFile   The parsed log file.
 * @param windowSize  Number of lines to include before AND after each error
 *                    (default 5).
 * @returns An {@link ErrorWindow} per error line (not deduplicated across
 *          overlapping windows).
 */
export function extractErrorWindows(logFile: LogFile, windowSize = 5): ErrorWindow[] {
  const { lines } = logFile;
  const windows: ErrorWindow[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.level !== 'error') continue;

    const start = Math.max(0, i - windowSize);
    const end = Math.min(lines.length - 1, i + windowSize);
    const windowLines = lines.slice(start, end + 1);

    windows.push({
      centerLine: line.lineNumber,
      lines: windowLines,
      matchedPattern: 'error',
    });
  }

  return windows;
}

/**
 * Reads and parses a log file from disk.
 *
 * Applies `maxLines` truncation (head-of-file) and optional deduplication.
 * Binary files are detected heuristically — an empty `LogFile` with a
 * console warning is returned for those.
 */
export async function parseLogFile(
  filePath: string,
  options: LogParseOptions = {},
): Promise<LogFile> {
  const { maxLines, dedup = false } = options;

  const empty: LogFile = {
    path: filePath,
    lines: [],
    errorCount: 0,
    warningCount: 0,
    importance: 0,
  };

  let rawContent: string;
  try {
    rawContent = await fsp.readFile(filePath, 'utf-8');
  } catch (err) {
    console.warn(
      `[log-parser] Could not read log file "${filePath}": ${(err as Error).message}`,
    );
    return empty;
  }

  if (isBinaryContent(rawContent)) {
    console.warn(`[log-parser] Skipping binary file "${filePath}"`);
    return empty;
  }

  let rawLines = rawContent.split('\n');

  // Remove trailing empty line produced by a final newline
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') {
    rawLines = rawLines.slice(0, -1);
  }

  // Apply maxLines truncation (take from head)
  if (maxLines !== undefined && rawLines.length > maxLines) {
    rawLines = rawLines.slice(0, maxLines);
  }

  let logLines: LogLine[] = rawLines.map((content, idx) => {
    const level = classifyLogLevel(content);
    const ts = extractTimestamps(content);
    const line: LogLine = {
      lineNumber: idx + 1,
      content,
      level,
    };
    if (ts !== null) line.timestamp = ts;
    return line;
  });

  if (dedup) {
    logLines = deduplicateLogLines(logLines);
  }

  const errorCount = logLines.filter((l) => l.level === 'error').length;
  const warningCount = logLines.filter((l) => l.level === 'warning').length;

  const partialFile: LogFile = {
    path: filePath,
    lines: logLines,
    errorCount,
    warningCount,
    importance: 0,
  };

  const importance = classifyLogImportance(partialFile);

  return { ...partialFile, importance };
}
