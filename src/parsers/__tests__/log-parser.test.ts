import { describe, it, expect, vi, afterEach } from 'vitest';
import * as path from 'path';
import * as fsp from 'fs/promises';
import * as os from 'os';
import {
  identifyLogFiles,
  classifyLogLevel,
  extractErrorWindows,
  deduplicateLogLines,
  classifyLogImportance,
  extractTimestamps,
  parseLogFile,
} from '../log-parser.js';
import { classifyLogs, rankLogsByImportance } from '../log-classifier.js';
import type { BundleManifest, ArtifactEntry } from '../../types/index.js';
import type { LogLine, LogFile } from '../log-parser.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SCENARIOS = path.resolve(__dirname, '../../../test/fixtures/scenarios');

function makeManifest(files: ArtifactEntry[]): BundleManifest {
  return {
    bundlePath: '/tmp/bundle.tar.gz',
    extractedPath: '/tmp/bundle-extracted',
    files,
    totalSize: 0,
    extractedAt: new Date(),
  };
}

function makeEntry(relativePath: string, absolutePath: string, category: ArtifactEntry['category']): ArtifactEntry {
  return { relativePath, absolutePath, size: 100, category };
}

// ---------------------------------------------------------------------------
// identifyLogFiles
// ---------------------------------------------------------------------------

describe('identifyLogFiles', () => {
  it('finds .log files under logs/ directory', () => {
    const manifest = makeManifest([
      makeEntry('logs/app/app-pod.log', '/tmp/logs/app/app-pod.log', 'log'),
      makeEntry('logs/system/kubelet.log', '/tmp/logs/system/kubelet.log', 'log'),
      makeEntry('cluster-resources/pods.yaml', '/tmp/cluster-resources/pods.yaml', 'kubernetes-resource'),
    ]);

    const logFiles = identifyLogFiles(manifest);

    expect(logFiles).toHaveLength(2);
    expect(logFiles.map((f) => f.relativePath)).toContain('logs/app/app-pod.log');
    expect(logFiles.map((f) => f.relativePath)).toContain('logs/system/kubelet.log');
  });

  it('also finds stdout.log and stderr.log patterns', () => {
    const manifest = makeManifest([
      makeEntry('logs/app/stdout.log', '/tmp/logs/app/stdout.log', 'log'),
      makeEntry('logs/app/stderr.log', '/tmp/logs/app/stderr.log', 'log'),
      makeEntry('logs/app/container.log', '/tmp/logs/app/container.log', 'log'),
    ]);

    const logFiles = identifyLogFiles(manifest);

    expect(logFiles).toHaveLength(3);
    const paths = logFiles.map((f) => f.relativePath);
    expect(paths).toContain('logs/app/stdout.log');
    expect(paths).toContain('logs/app/stderr.log');
  });

  it('falls back to path-based identification for log-like files', () => {
    const manifest = makeManifest([
      makeEntry('bundle/logs/app/app.log', '/tmp/bundle/logs/app/app.log', 'unknown'),
      makeEntry('bundle/pods/stdout.log', '/tmp/bundle/pods/stdout.log', 'unknown'),
      makeEntry('bundle/config/app.yaml', '/tmp/bundle/config/app.yaml', 'unknown'),
    ]);

    const logFiles = identifyLogFiles(manifest);

    expect(logFiles.map((f) => f.relativePath)).toEqual([
      'bundle/logs/app/app.log',
      'bundle/pods/stdout.log',
    ]);
  });

  it('excludes non-log category entries', () => {
    const manifest = makeManifest([
      makeEntry('logs/app/app.log', '/tmp/logs/app/app.log', 'log'),
      makeEntry('analyzers/output.json', '/tmp/analyzers/output.json', 'analyzer'),
    ]);

    const logFiles = identifyLogFiles(manifest);
    expect(logFiles).toHaveLength(1);
  });

  it('returns empty array when no log files exist', () => {
    const manifest = makeManifest([
      makeEntry('analyzers/output.json', '/tmp/analyzers/output.json', 'analyzer'),
    ]);
    const logFiles = identifyLogFiles(manifest);
    expect(logFiles).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// classifyLogLevel
// ---------------------------------------------------------------------------

describe('classifyLogLevel', () => {
  it('classifies ERROR lines', () => {
    expect(classifyLogLevel('2024-01-15T10:00:00Z ERROR something went wrong')).toBe('error');
    expect(classifyLogLevel('[ERROR] connection failed')).toBe('error');
    expect(classifyLogLevel('level=error msg="bad thing"')).toBe('error');
    expect(classifyLogLevel('error: connection failed')).toBe('error');
    expect(classifyLogLevel('FATAL: system crash')).toBe('error');
    expect(classifyLogLevel('panic: runtime error: index out of range')).toBe('error');
  });

  it('classifies WARN/WARNING lines', () => {
    expect(classifyLogLevel('2024-01-15T10:00:00Z WARN  retrying...')).toBe('warning');
    expect(classifyLogLevel('[WARNING] disk space low')).toBe('warning');
    expect(classifyLogLevel('level=warn msg="slow query"')).toBe('warning');
    expect(classifyLogLevel('warning: disk space low')).toBe('warning');
  });

  it('classifies INFO lines', () => {
    expect(classifyLogLevel('2024-01-15T10:00:00Z INFO  Server started')).toBe('info');
    expect(classifyLogLevel('[INFO] loading config')).toBe('info');
    expect(classifyLogLevel('level=info msg="ready"')).toBe('info');
  });

  it('classifies DEBUG lines', () => {
    expect(classifyLogLevel('2024-01-15T10:00:00Z DEBUG processing request')).toBe('debug');
    expect(classifyLogLevel('[DEBUG] cache miss')).toBe('debug');
    expect(classifyLogLevel('level=debug msg="tick"')).toBe('debug');
  });

  it('returns unknown for unrecognised lines', () => {
    expect(classifyLogLevel('some random text without level')).toBe('unknown');
    expect(classifyLogLevel('')).toBe('unknown');
    expect(classifyLogLevel('   ')).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// extractTimestamps
// ---------------------------------------------------------------------------

describe('extractTimestamps', () => {
  it('extracts ISO 8601 timestamps', () => {
    expect(extractTimestamps('2024-01-15T10:00:00Z INFO  Server started')).toBe(
      '2024-01-15T10:00:00Z',
    );
    expect(extractTimestamps('2024-01-15T10:00:00.123Z ERROR failed')).toBe(
      '2024-01-15T10:00:00.123Z',
    );
  });

  it('extracts date-time with offset', () => {
    const ts = extractTimestamps('2024-01-15T10:00:00+05:30 INFO something');
    expect(ts).toBe('2024-01-15T10:00:00+05:30');
  });

  it('extracts ISO timestamps with fractional seconds and offset', () => {
    const ts = extractTimestamps('2024-01-15T10:00:00.123+05:30 INFO something');
    expect(ts).toBe('2024-01-15T10:00:00.123+05:30');
  });

  it('extracts common syslog timestamps', () => {
    const ts = extractTimestamps('Jan 15 10:00:00 hostname app: message');
    expect(ts).not.toBeNull();
  });

  it('returns null for lines without timestamps', () => {
    expect(extractTimestamps('no timestamp here')).toBeNull();
    expect(extractTimestamps('[INFO] bare log line')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractErrorWindows
// ---------------------------------------------------------------------------

describe('extractErrorWindows', () => {
  const lines: LogLine[] = [
    { lineNumber: 1, content: '2024-01-15T10:00:00Z INFO  start', level: 'info' },
    { lineNumber: 2, content: '2024-01-15T10:00:01Z INFO  loading', level: 'info' },
    { lineNumber: 3, content: '2024-01-15T10:00:02Z ERROR connection refused', level: 'error' },
    { lineNumber: 4, content: '2024-01-15T10:00:03Z WARN  retrying', level: 'warning' },
    { lineNumber: 5, content: '2024-01-15T10:00:04Z INFO  done', level: 'info' },
  ];

  const logFile: LogFile = {
    path: '/tmp/test.log',
    lines,
    errorCount: 1,
    warningCount: 1,
    importance: 0.5,
  };

  it('returns windows around error lines', () => {
    const windows = extractErrorWindows(logFile, 2);
    expect(windows).toHaveLength(1);
    expect(windows[0]!.centerLine).toBe(3);
  });

  it('includes context lines before and after the error', () => {
    const windows = extractErrorWindows(logFile, 2);
    const w = windows[0]!;
    expect(w.lines.length).toBeGreaterThanOrEqual(3);
    const lineNums = w.lines.map((l) => l.lineNumber);
    expect(lineNums).toContain(1); // before
    expect(lineNums).toContain(3); // center (error)
    expect(lineNums).toContain(4); // after
  });

  it('handles errors at start of file', () => {
    const startLines: LogLine[] = [
      { lineNumber: 1, content: 'ERROR at very start', level: 'error' },
      { lineNumber: 2, content: 'INFO  after error', level: 'info' },
      { lineNumber: 3, content: 'INFO  still going', level: 'info' },
    ];
    const startFile: LogFile = {
      path: '/tmp/start.log',
      lines: startLines,
      errorCount: 1,
      warningCount: 0,
      importance: 0.5,
    };
    const windows = extractErrorWindows(startFile, 2);
    expect(windows).toHaveLength(1);
    expect(windows[0]!.centerLine).toBe(1);
    // Should not throw or include negative-indexed lines
    expect(windows[0]!.lines[0]!.lineNumber).toBeGreaterThanOrEqual(1);
  });

  it('handles errors at end of file', () => {
    const endLines: LogLine[] = [
      { lineNumber: 1, content: 'INFO  start', level: 'info' },
      { lineNumber: 2, content: 'INFO  middle', level: 'info' },
      { lineNumber: 3, content: 'ERROR at very end', level: 'error' },
    ];
    const endFile: LogFile = {
      path: '/tmp/end.log',
      lines: endLines,
      errorCount: 1,
      warningCount: 0,
      importance: 0.5,
    };
    const windows = extractErrorWindows(endFile, 2);
    expect(windows).toHaveLength(1);
    expect(windows[0]!.centerLine).toBe(3);
    // Last line of window should not exceed file length
    const lastLine = windows[0]!.lines[windows[0]!.lines.length - 1]!;
    expect(lastLine.lineNumber).toBeLessThanOrEqual(3);
  });

  it('returns empty array when no errors present', () => {
    const cleanLines: LogLine[] = [
      { lineNumber: 1, content: 'INFO  all good', level: 'info' },
      { lineNumber: 2, content: 'INFO  still good', level: 'info' },
    ];
    const cleanFile: LogFile = {
      path: '/tmp/clean.log',
      lines: cleanLines,
      errorCount: 0,
      warningCount: 0,
      importance: 0,
    };
    const windows = extractErrorWindows(cleanFile, 2);
    expect(windows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// deduplicateLogLines
// ---------------------------------------------------------------------------

describe('deduplicateLogLines', () => {
  it('collapses runs of identical lines with count in content', () => {
    const lines: LogLine[] = [
      { lineNumber: 1, content: 'ERROR connection refused', level: 'error' },
      { lineNumber: 2, content: 'ERROR connection refused', level: 'error' },
      { lineNumber: 3, content: 'ERROR connection refused', level: 'error' },
      { lineNumber: 4, content: 'INFO  recovered', level: 'info' },
    ];

    const deduped = deduplicateLogLines(lines);

    expect(deduped).toHaveLength(2);
    expect(deduped[0]!.content).toContain('x3');
    expect(deduped[1]!.content).toBe('INFO  recovered');
  });

  it('preserves unique lines without modification', () => {
    const lines: LogLine[] = [
      { lineNumber: 1, content: 'INFO  start', level: 'info' },
      { lineNumber: 2, content: 'ERROR fail', level: 'error' },
      { lineNumber: 3, content: 'INFO  end', level: 'info' },
    ];

    const deduped = deduplicateLogLines(lines);
    expect(deduped).toHaveLength(3);
    expect(deduped[0]!.content).toBe('INFO  start');
    expect(deduped[1]!.content).toBe('ERROR fail');
  });

  it('handles single-line input', () => {
    const lines: LogLine[] = [{ lineNumber: 1, content: 'INFO  only', level: 'info' }];
    const deduped = deduplicateLogLines(lines);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]!.content).toBe('INFO  only');
  });

  it('handles empty array', () => {
    const deduped = deduplicateLogLines([]);
    expect(deduped).toHaveLength(0);
  });

  it('handles non-consecutive duplicate groups independently', () => {
    const lines: LogLine[] = [
      { lineNumber: 1, content: 'ERROR connection refused', level: 'error' },
      { lineNumber: 2, content: 'ERROR connection refused', level: 'error' },
      { lineNumber: 3, content: 'INFO  different', level: 'info' },
      { lineNumber: 4, content: 'ERROR connection refused', level: 'error' },
      { lineNumber: 5, content: 'ERROR connection refused', level: 'error' },
    ];

    const deduped = deduplicateLogLines(lines);
    // Two separate runs of the same error, plus one info line = 3 entries
    expect(deduped).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// classifyLogImportance
// ---------------------------------------------------------------------------

describe('classifyLogImportance', () => {
  it('scores 0 for log with no errors or warnings', () => {
    const logFile: LogFile = {
      path: '/tmp/quiet.log',
      lines: [
        { lineNumber: 1, content: 'INFO  start', level: 'info' },
        { lineNumber: 2, content: 'INFO  end', level: 'info' },
      ],
      errorCount: 0,
      warningCount: 0,
      importance: 0,
    };
    const score = classifyLogImportance(logFile);
    expect(score).toBe(0);
  });

  it('scores higher for logs with more errors', () => {
    const lowFile: LogFile = {
      path: '/tmp/low.log',
      lines: [
        { lineNumber: 1, content: 'INFO  1', level: 'info' },
        { lineNumber: 2, content: 'INFO  2', level: 'info' },
        { lineNumber: 3, content: 'INFO  3', level: 'info' },
        { lineNumber: 4, content: 'ERROR fail', level: 'error' },
        { lineNumber: 5, content: 'INFO  5', level: 'info' },
      ],
      errorCount: 1,
      warningCount: 0,
      importance: 0,
    };

    const highFile: LogFile = {
      path: '/tmp/high.log',
      lines: [
        { lineNumber: 1, content: 'ERROR fail 1', level: 'error' },
        { lineNumber: 2, content: 'ERROR fail 2', level: 'error' },
        { lineNumber: 3, content: 'ERROR fail 3', level: 'error' },
        { lineNumber: 4, content: 'INFO  1', level: 'info' },
        { lineNumber: 5, content: 'INFO  2', level: 'info' },
      ],
      errorCount: 3,
      warningCount: 0,
      importance: 0,
    };

    const lowScore = classifyLogImportance(lowFile);
    const highScore = classifyLogImportance(highFile);

    expect(highScore).toBeGreaterThan(lowScore);
  });

  it('returns a value between 0 and 1', () => {
    const allErrors: LogFile = {
      path: '/tmp/all-errors.log',
      lines: [
        { lineNumber: 1, content: 'ERROR 1', level: 'error' },
        { lineNumber: 2, content: 'ERROR 2', level: 'error' },
      ],
      errorCount: 2,
      warningCount: 0,
      importance: 0,
    };
    const score = classifyLogImportance(allErrors);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// parseLogFile
// ---------------------------------------------------------------------------

describe('parseLogFile', () => {
  it('returns structured LogFile with lines, errors, warnings from fixture', async () => {
    const filePath = path.join(
      SCENARIOS,
      'wrong-db-endpoint',
      'cluster-resources',
      'pods',
      'logs',
      'default',
      'app-pod',
      'app.log',
    );
    const logFile = await parseLogFile(filePath);

    expect(logFile.path).toBe(filePath);
    expect(logFile.lines.length).toBeGreaterThan(0);
    expect(logFile.errorCount).toBeGreaterThan(0);
    expect(logFile.warningCount).toBeGreaterThan(0);
    expect(logFile.importance).toBeGreaterThan(0);
  });

  it('parses missing-secret-crashloop log file correctly', async () => {
    const filePath = path.join(
      SCENARIOS,
      'missing-secret-crashloop',
      'cluster-resources',
      'pods',
      'logs',
      'default',
      'app-pod',
      'app.log',
    );
    const logFile = await parseLogFile(filePath);

    expect(logFile.errorCount).toBeGreaterThan(0);
    const errorLines = logFile.lines.filter((l) => l.level === 'error');
    expect(errorLines.length).toBeGreaterThan(0);
    // Should include the FATAL line
    const fatalLines = logFile.lines.filter((l) => l.content.includes('FATAL'));
    expect(fatalLines.length).toBeGreaterThan(0);
  });

  it('assigns correct line numbers (1-based)', async () => {
    const filePath = path.join(
      SCENARIOS,
      'wrong-db-endpoint',
      'cluster-resources',
      'pods',
      'logs',
      'default',
      'app-pod',
      'app.log',
    );
    const logFile = await parseLogFile(filePath);

    expect(logFile.lines[0]!.lineNumber).toBe(1);
    logFile.lines.forEach((line, idx) => {
      expect(line.lineNumber).toBe(idx + 1);
    });
  });

  it('handles maxLines option by truncating output', async () => {
    const filePath = path.join(
      SCENARIOS,
      'wrong-db-endpoint',
      'cluster-resources',
      'pods',
      'logs',
      'default',
      'app-pod',
      'app.log',
    );
    const logFile = await parseLogFile(filePath, { maxLines: 5 });

    expect(logFile.lines.length).toBeLessThanOrEqual(5);
  });

  it('applies deduplication when dedup option is true', async () => {
    // Create a temp file with repeated lines
    const tmpDir = os.tmpdir();
    const tmpFile = path.join(tmpDir, 'dedup-test.log');
    const repeatedContent = [
      '2024-01-15T10:00:00Z ERROR connection refused',
      '2024-01-15T10:00:01Z ERROR connection refused',
      '2024-01-15T10:00:02Z ERROR connection refused',
      '2024-01-15T10:00:03Z INFO  done',
    ].join('\n');

    await fsp.writeFile(tmpFile, repeatedContent, 'utf-8');

    const logFile = await parseLogFile(tmpFile, { dedup: true });
    // Deduplicated: 3 identical errors → 1 + "done" = 2 lines
    expect(logFile.lines.length).toBe(2);

    await fsp.unlink(tmpFile);
  });

  it('handles very large log content gracefully via maxLines', async () => {
    const tmpDir = os.tmpdir();
    const tmpFile = path.join(tmpDir, 'large-test.log');
    // Generate 10,000 lines
    const lines = Array.from(
      { length: 10000 },
      (_, i) => `2024-01-15T10:00:00Z INFO  line ${i + 1}`,
    );
    await fsp.writeFile(tmpFile, lines.join('\n'), 'utf-8');

    const logFile = await parseLogFile(tmpFile, { maxLines: 1000 });
    expect(logFile.lines.length).toBeLessThanOrEqual(1000);

    await fsp.unlink(tmpFile);
  });

  it('handles binary/non-text files gracefully — returns empty lines with warning', async () => {
    const tmpDir = os.tmpdir();
    const tmpFile = path.join(tmpDir, 'binary-test.log');
    // Write binary content (null bytes etc.)
    const binaryBuffer = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd]);
    await fsp.writeFile(tmpFile, binaryBuffer);

    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const logFile = await parseLogFile(tmpFile);
    expect(logFile.lines).toHaveLength(0);
    expect(consoleSpy).toHaveBeenCalled();

    consoleSpy.mockRestore();
    await fsp.unlink(tmpFile);
  });

  it('parses printable Unicode logs instead of treating them as binary', async () => {
    const tmpDir = os.tmpdir();
    const tmpFile = path.join(tmpDir, 'unicode.log');
    await fsp.writeFile(
      tmpFile,
      '2024-01-15T10:00:00Z INFO 服务已启动 ✅\n2024-01-15T10:00:01Z ERROR Échec de connexion\n',
      'utf-8',
    );

    const result = await parseLogFile(tmpFile);

    expect(result.lines).toHaveLength(2);
    expect(result.errorCount).toBe(1);
    expect(result.lines[0]?.content).toContain('服务已启动');

    await fsp.unlink(tmpFile);
  });
});

// ---------------------------------------------------------------------------
// classifyLogs & rankLogsByImportance (log-classifier)
// ---------------------------------------------------------------------------

describe('classifyLogs', () => {
  it('returns a classification for each log file', async () => {
    const filePath = path.join(
      SCENARIOS,
      'wrong-db-endpoint',
      'cluster-resources',
      'pods',
      'logs',
      'default',
      'app-pod',
      'app.log',
    );
    const logFile = await parseLogFile(filePath);

    const classifications = classifyLogs([logFile]);
    expect(classifications).toHaveLength(1);
    expect(classifications[0]!.path).toBe(filePath);
    expect(classifications[0]!.importance).toBeGreaterThanOrEqual(0);
    expect(classifications[0]!.importance).toBeLessThanOrEqual(1);
  });

  it('assigns a category to each log', async () => {
    const filePath = path.join(
      SCENARIOS,
      'wrong-db-endpoint',
      'cluster-resources',
      'pods',
      'logs',
      'default',
      'app-pod',
      'app.log',
    );
    const logFile = await parseLogFile(filePath);
    const classifications = classifyLogs([logFile]);
    const validCategories = ['application', 'system', 'kubernetes', 'database', 'networking', 'unknown'];
    expect(validCategories).toContain(classifications[0]!.category);
  });

  it('extracts primaryErrors from error-dense logs', async () => {
    const filePath = path.join(
      SCENARIOS,
      'missing-secret-crashloop',
      'cluster-resources',
      'pods',
      'logs',
      'default',
      'app-pod',
      'app.log',
    );
    const logFile = await parseLogFile(filePath);
    const classifications = classifyLogs([logFile]);
    expect(classifications[0]!.primaryErrors.length).toBeGreaterThan(0);
  });
});

describe('rankLogsByImportance', () => {
  it('ranks log classifications from most to least important', async () => {
    const crashPath = path.join(
      SCENARIOS,
      'missing-secret-crashloop',
      'cluster-resources',
      'pods',
      'logs',
      'default',
      'app-pod',
      'app.log',
    );
    const dbPath = path.join(
      SCENARIOS,
      'wrong-db-endpoint',
      'cluster-resources',
      'pods',
      'logs',
      'default',
      'app-pod',
      'app.log',
    );
    const badImagePath = path.join(
      SCENARIOS,
      'bad-image-tag',
      'cluster-resources',
      'pods',
      'logs',
      'default',
      'app-pod',
      'app.log',
    );

    const [crashLog, dbLog, badImageLog] = await Promise.all([
      parseLogFile(crashPath),
      parseLogFile(dbPath),
      parseLogFile(badImagePath),
    ]);

    const classifications = classifyLogs([crashLog!, dbLog!, badImageLog!]);
    const ranked = rankLogsByImportance(classifications);

    // Ranked should be sorted by importance descending
    for (let i = 0; i < ranked.length - 1; i++) {
      expect(ranked[i]!.importance).toBeGreaterThanOrEqual(ranked[i + 1]!.importance);
    }
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
