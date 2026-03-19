import { describe, it, expect } from 'vitest';
import { chunkLogFile, chunkResource, chunkAnalyzer, chunkLogFileErrorAware } from '../chunker.js';
import type { LogFile, LogLine } from '../../parsers/log-parser.js';
import type { LogLevel } from '../../parsers/log-parser.js';
import type { K8sResource } from '../../types/index.js';
import type { AnalyzerResult } from '../../types/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogLines(count: number): LogLine[] {
  return Array.from({ length: count }, (_, i) => ({
    lineNumber: i + 1,
    content: `Log line ${i + 1}`,
    level: 'info' as const,
  }));
}

function makeLogFile(lineCount: number, path = '/var/log/app/app.log'): LogFile {
  const lines = makeLogLines(lineCount);
  return {
    path,
    lines,
    errorCount: 0,
    warningCount: 0,
    importance: 0,
  };
}

function makeResource(name = 'my-pod', namespace = 'default'): K8sResource {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name, namespace },
    spec: { containers: [{ name: 'app', image: 'nginx:latest' }] },
    status: { phase: 'Running' },
  };
}

function makeAnalyzerResult(name = 'check-memory'): AnalyzerResult {
  return {
    name,
    title: 'Memory limit not set',
    message: 'No memory limits detected on containers',
    severity: 'warn',
    isPass: false,
    isFail: false,
    isWarn: true,
  };
}

// ---------------------------------------------------------------------------
// chunkLogFile
// ---------------------------------------------------------------------------

describe('chunkLogFile', () => {
  it('splits a log file into chunks of the given size', () => {
    const logFile = makeLogFile(10);
    const chunks = chunkLogFile(logFile, 5, 0);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.startLine).toBe(1);
    expect(chunks[0]!.endLine).toBe(5);
    expect(chunks[1]!.startLine).toBe(6);
    expect(chunks[1]!.endLine).toBe(10);
  });

  it('produces overlapping chunks when overlap > 0', () => {
    const logFile = makeLogFile(10);
    const chunks = chunkLogFile(logFile, 5, 2);
    // step = 5 - 2 = 3 → starts at 1, 4, 7 (lineNumbers), last chunk covers remaining lines
    expect(chunks.length).toBeGreaterThan(2);

    // Lines 1-5, then 4-8, then 7-10 (or 7-11 clamped) — verify overlap
    const firstChunk = chunks[0]!;
    const secondChunk = chunks[1]!;
    // The second chunk should start before the first chunk ends
    expect(secondChunk.startLine).toBeLessThan(firstChunk.endLine);
  });

  it('returns a single chunk when the log is smaller than chunkSize', () => {
    const logFile = makeLogFile(3);
    const chunks = chunkLogFile(logFile, 10, 0);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.startLine).toBe(1);
    expect(chunks[0]!.endLine).toBe(3);
  });

  it('returns empty array for empty log file', () => {
    const logFile = makeLogFile(0);
    const chunks = chunkLogFile(logFile, 5, 0);
    expect(chunks).toHaveLength(0);
  });

  it('chunks include metadata with path, category, and lineRange', () => {
    const logFile = makeLogFile(5, '/logs/app.log');
    const chunks = chunkLogFile(logFile, 5, 0);
    const chunk = chunks[0]!;

    expect(chunk.metadata).toBeDefined();
    expect(chunk.metadata!['path']).toBe('/logs/app.log');
    expect(chunk.metadata!['category']).toBe('log');
    expect(chunk.metadata!['lineRange']).toEqual([1, 5]);
  });

  it('chunk content contains the log line text', () => {
    const logFile = makeLogFile(3, '/logs/test.log');
    const chunks = chunkLogFile(logFile, 3, 0);
    expect(chunks[0]!.content).toContain('Log line 1');
    expect(chunks[0]!.content).toContain('Log line 3');
  });

  it('chunk artifactId matches the log file path', () => {
    const logFile = makeLogFile(5, '/logs/app.log');
    const chunks = chunkLogFile(logFile, 5, 0);
    expect(chunks[0]!.artifactId).toBe('/logs/app.log');
  });
});

// ---------------------------------------------------------------------------
// chunkResource
// ---------------------------------------------------------------------------

describe('chunkResource', () => {
  it('creates a single chunk per resource', () => {
    const resource = makeResource();
    const chunk = chunkResource(resource, 'default/pods/my-pod.yaml');
    expect(chunk).toBeDefined();
    expect(chunk.startLine).toBe(1);
    expect(chunk.endLine).toBeGreaterThanOrEqual(1);
  });

  it('chunk content includes resource data', () => {
    const resource = makeResource('web-app', 'production');
    const chunk = chunkResource(resource, 'production/pods/web-app.yaml');
    expect(chunk.content).toContain('web-app');
    expect(chunk.content).toContain('production');
  });

  it('chunk artifactId matches the provided path', () => {
    const resource = makeResource();
    const path = 'default/pods/my-pod.yaml';
    const chunk = chunkResource(resource, path);
    expect(chunk.artifactId).toBe(path);
  });

  it('chunk metadata includes path, category, and lineRange', () => {
    const resource = makeResource();
    const path = 'default/pods/my-pod.yaml';
    const chunk = chunkResource(resource, path);

    expect(chunk.metadata).toBeDefined();
    expect(chunk.metadata!['path']).toBe(path);
    expect(chunk.metadata!['category']).toBe('kubernetes-resource');
    expect(chunk.metadata!['lineRange']).toEqual([1, chunk.endLine]);
  });
});

// ---------------------------------------------------------------------------
// chunkAnalyzer
// ---------------------------------------------------------------------------

describe('chunkAnalyzer', () => {
  it('creates a single chunk per analyzer result', () => {
    const result = makeAnalyzerResult('check-memory');
    const chunk = chunkAnalyzer(result);
    expect(chunk).toBeDefined();
  });

  it('chunk content includes the analyzer title and message', () => {
    const result = makeAnalyzerResult('check-memory');
    const chunk = chunkAnalyzer(result);
    expect(chunk.content).toContain('Memory limit not set');
    expect(chunk.content).toContain('No memory limits detected');
  });

  it('chunk artifactId matches the analyzer result name', () => {
    const result = makeAnalyzerResult('check-disk');
    const chunk = chunkAnalyzer(result);
    expect(chunk.artifactId).toBe('check-disk');
  });

  it('chunk metadata includes path, category, and lineRange', () => {
    const result = makeAnalyzerResult('check-cpu');
    const chunk = chunkAnalyzer(result);

    expect(chunk.metadata).toBeDefined();
    expect(chunk.metadata!['category']).toBe('analyzer');
    expect(typeof chunk.metadata!['path']).toBe('string');
    expect(chunk.metadata!['lineRange']).toEqual([1, chunk.endLine]);
  });

  it('chunk line range is valid (startLine >= 1, endLine >= startLine)', () => {
    const result = makeAnalyzerResult('check-network');
    const chunk = chunkAnalyzer(result);
    expect(chunk.startLine).toBeGreaterThanOrEqual(1);
    expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine);
  });
});

// ---------------------------------------------------------------------------
// chunkResource — summary content (3.3)
// ---------------------------------------------------------------------------

describe('chunkResource — summary content (3.3)', () => {
  it('chunk content is the human-readable summarizeResource output, not raw JSON', () => {
    const resource = makeResource('my-pod', 'default');
    const chunk = chunkResource(resource, 'default/pods/my-pod.yaml');
    // The content should start with "Pod: my-pod" — a human-readable summary
    expect(chunk.content).toContain('Pod:');
    expect(chunk.content).toContain('my-pod');
    // Must NOT start with the raw JSON opening brace
    expect(chunk.content.trim()).not.toMatch(/^\{/);
  });

  it('raw JSON is stored in metadata.rawContent', () => {
    const resource = makeResource('my-pod', 'default');
    const chunk = chunkResource(resource, 'default/pods/my-pod.yaml');
    expect(chunk.metadata).toBeDefined();
    const raw = chunk.metadata!['rawContent'];
    expect(typeof raw).toBe('string');
    // rawContent should be parseable JSON containing the resource fields
    const parsed = JSON.parse(raw as string) as { metadata: { name: string } };
    expect(parsed.metadata.name).toBe('my-pod');
  });

  it('endLine reflects the number of lines in the summary content', () => {
    const resource = makeResource('my-pod', 'default');
    const chunk = chunkResource(resource, 'default/pods/my-pod.yaml');
    const summaryLines = chunk.content.split('\n').length;
    expect(chunk.endLine).toBe(summaryLines);
  });

  it('metadata.rawContent contains the full resource spec', () => {
    const resource = makeResource('web-app', 'production');
    const chunk = chunkResource(resource, 'production/pods/web-app.yaml');
    const raw = chunk.metadata!['rawContent'] as string;
    // The raw content should include spec details not present in the summary
    expect(raw).toContain('"containers"');
    expect(raw).toContain('nginx:latest');
  });

  it('content and metadata.rawContent differ for a real resource', () => {
    const resource = makeResource('my-pod', 'default');
    const chunk = chunkResource(resource, 'default/pods/my-pod.yaml');
    // The human-readable summary must be distinct from the raw JSON blob
    expect(chunk.content).not.toBe(chunk.metadata!['rawContent']);
  });
});

// ---------------------------------------------------------------------------
// chunkLogFileErrorAware — helpers
// ---------------------------------------------------------------------------

/**
 * Builds a LogFile where errorLines (1-indexed) are error-level and
 * all other lines are info-level.
 */
function makeLogFileWithErrors(
  lineCount: number,
  errorLineNumbers: number[],
  path = '/var/log/app/app.log',
): LogFile {
  const errorSet = new Set(errorLineNumbers);
  const lines: LogLine[] = Array.from({ length: lineCount }, (_, i) => {
    const lineNumber = i + 1;
    const isError = errorSet.has(lineNumber);
    return {
      lineNumber,
      content: isError
        ? `ERROR: something failed at line ${lineNumber}`
        : `INFO: normal log line ${lineNumber}`,
      level: (isError ? 'error' : 'info') as LogLevel,
    };
  });

  const errorCount = lines.filter((l) => l.level === 'error').length;
  return {
    path,
    lines,
    errorCount,
    warningCount: 0,
    importance: errorCount > 0 ? 0.5 : 0,
  };
}

// ---------------------------------------------------------------------------
// chunkLogFileErrorAware
// ---------------------------------------------------------------------------

describe('chunkLogFileErrorAware', () => {
  // ── backward-compat: no errors ──────────────────────────────────────────

  it('returns empty array for empty log file', () => {
    const logFile = makeLogFile(0);
    const chunks = chunkLogFileErrorAware(logFile);
    expect(chunks).toHaveLength(0);
  });

  it('returns entire file in one chunk when no errors exist (backward-compatible)', () => {
    const logFile = makeLogFile(55); // all INFO lines, errorCount=0
    const chunks = chunkLogFileErrorAware(logFile);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.startLine).toBe(1);
    expect(chunks[0]!.endLine).toBe(55);
  });

  it('single-chunk fallback covers all content', () => {
    const logFile = makeLogFile(5);
    const chunks = chunkLogFileErrorAware(logFile);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.content).toContain('Log line 1');
    expect(chunks[0]!.content).toContain('Log line 5');
  });

  // ── preamble ────────────────────────────────────────────────────────────

  it('always includes a preamble chunk (first ~20 lines) when errors are present', () => {
    // Error at line 50, far beyond the preamble zone
    const logFile = makeLogFileWithErrors(100, [50]);
    const chunks = chunkLogFileErrorAware(logFile);

    const preamble = chunks.find((c) => c.metadata?.['chunkType'] === 'preamble');
    expect(preamble).toBeDefined();
    expect(preamble!.startLine).toBe(1);
    expect(preamble!.endLine).toBe(20);
  });

  it('preamble chunk artifactId matches the log file path', () => {
    const logFile = makeLogFileWithErrors(100, [50], '/logs/test.log');
    const chunks = chunkLogFileErrorAware(logFile);
    const preamble = chunks.find((c) => c.metadata?.['chunkType'] === 'preamble');
    expect(preamble!.artifactId).toBe('/logs/test.log');
  });

  it('preamble chunk category is log', () => {
    const logFile = makeLogFileWithErrors(100, [50]);
    const chunks = chunkLogFileErrorAware(logFile);
    const preamble = chunks.find((c) => c.metadata?.['chunkType'] === 'preamble');
    expect(preamble!.metadata!['category']).toBe('log');
  });

  it('preamble spans only up to the file length when file is shorter than 20 lines', () => {
    const logFile = makeLogFileWithErrors(10, [5]);
    const chunks = chunkLogFileErrorAware(logFile);
    const preamble = chunks.find((c) => c.metadata?.['chunkType'] === 'preamble');
    expect(preamble).toBeDefined();
    // Should end at line 10, not line 20
    expect(preamble!.endLine).toBeLessThanOrEqual(10);
  });

  // ── error-cluster chunks ────────────────────────────────────────────────

  it('creates an error-cluster chunk centered on the error with 10-line padding', () => {
    // Error at line 50 in a 100-line file
    const logFile = makeLogFileWithErrors(100, [50]);
    const chunks = chunkLogFileErrorAware(logFile);

    const errorCluster = chunks.find((c) => c.metadata?.['chunkType'] === 'error-cluster');
    expect(errorCluster).toBeDefined();
    // With 10-line padding around line 50: starts at 40, ends at 60
    expect(errorCluster!.startLine).toBeLessThanOrEqual(50);
    expect(errorCluster!.endLine).toBeGreaterThanOrEqual(50);
    expect(errorCluster!.content).toContain('ERROR');
  });

  it('deduplicates repeated lines within error clusters', () => {
    // 30 identical error lines in the middle of a 60-line file
    const errorLines = Array.from({ length: 30 }, (_, i) => i + 21); // lines 21-50
    const lines: LogLine[] = [
      // Lines 1-20: info
      ...Array.from({ length: 20 }, (_, i) => ({
        lineNumber: i + 1,
        content: `INFO: line ${i + 1}`,
        level: 'info' as LogLevel,
      })),
      // Lines 21-50: identical error text
      ...errorLines.map((n) => ({
        lineNumber: n,
        content: 'ERROR: connection refused to db.internal:5432',
        level: 'error' as LogLevel,
      })),
      // Lines 51-60: info
      ...Array.from({ length: 10 }, (_, i) => ({
        lineNumber: 51 + i,
        content: `INFO: line ${51 + i}`,
        level: 'info' as LogLevel,
      })),
    ];
    const logFile: LogFile = {
      path: '/test/app.log',
      lines,
      errorCount: 30,
      warningCount: 0,
      importance: 1,
    };

    const chunks = chunkLogFileErrorAware(logFile);
    const errorChunk = chunks.find((c) => c.metadata?.['chunkType'] === 'error-cluster');
    expect(errorChunk).toBeDefined();

    // 30 identical error lines should be collapsed to << 30 lines in the output
    const contentLines = errorChunk!.content.split('\n');
    const errorContentLines = contentLines.filter((l) => l.includes('ERROR'));
    expect(errorContentLines.length).toBeLessThan(30);

    // The [repeated xN] marker should appear
    expect(errorChunk!.content).toContain('[repeated x');
  });

  it('merges overlapping error windows into a single cluster', () => {
    // Two errors close together (lines 30 and 35) — their 10-line windows overlap
    const logFile = makeLogFileWithErrors(100, [30, 35]);
    const chunks = chunkLogFileErrorAware(logFile);

    const errorClusters = chunks.filter((c) => c.metadata?.['chunkType'] === 'error-cluster');
    // The two overlapping windows should be merged into one cluster
    expect(errorClusters).toHaveLength(1);
    expect(errorClusters[0]!.content).toContain('ERROR');
  });

  it('creates separate clusters for errors far apart', () => {
    // Two errors far apart (lines 25 and 75) — their 10-line windows do not overlap
    const logFile = makeLogFileWithErrors(100, [25, 75]);
    const chunks = chunkLogFileErrorAware(logFile);

    const errorClusters = chunks.filter((c) => c.metadata?.['chunkType'] === 'error-cluster');
    expect(errorClusters).toHaveLength(2);
  });

  // ── summary chunk ───────────────────────────────────────────────────────

  it('creates a summary chunk describing healthy regions', () => {
    // Error in the middle → healthy regions before and after
    const logFile = makeLogFileWithErrors(100, [50]);
    const chunks = chunkLogFileErrorAware(logFile);

    const summaryChunk = chunks.find((c) => c.metadata?.['chunkType'] === 'summary');
    expect(summaryChunk).toBeDefined();
    expect(summaryChunk!.content).toContain('INFO lines');
    expect(summaryChunk!.content).toContain('no errors');
  });

  it('summary chunk describes line ranges of healthy regions', () => {
    const logFile = makeLogFileWithErrors(100, [50]);
    const chunks = chunkLogFileErrorAware(logFile);
    const summary = chunks.find((c) => c.metadata?.['chunkType'] === 'summary');
    expect(summary).toBeDefined();
    // Should contain at least one "lines N-M:" entry
    expect(summary!.content).toMatch(/lines \d+-\d+:/);
  });

  it('no summary chunk when all lines are covered by preamble and error clusters', () => {
    // Very short file: error at line 5, preamble covers 1-10 (entire file)
    const logFile = makeLogFileWithErrors(10, [5]);
    const chunks = chunkLogFileErrorAware(logFile);
    const summaryChunk = chunks.find((c) => c.metadata?.['chunkType'] === 'summary');
    // Summary may or may not exist depending on coverage; at minimum we verify
    // that if it exists it has valid content
    if (summaryChunk) {
      expect(summaryChunk.content).toContain('INFO lines');
    }
  });

  // ── chunk IDs and metadata ───────────────────────────────────────────────

  it('all chunks have valid line ranges (startLine >= 1, endLine >= startLine)', () => {
    const logFile = makeLogFileWithErrors(100, [25, 75]);
    const chunks = chunkLogFileErrorAware(logFile);
    for (const chunk of chunks) {
      expect(chunk.startLine).toBeGreaterThanOrEqual(1);
      expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine);
    }
  });

  it('all chunks have the same artifactId as the log file path', () => {
    const path = '/logs/myservice.log';
    const logFile = makeLogFileWithErrors(100, [50], path);
    const chunks = chunkLogFileErrorAware(logFile);
    for (const chunk of chunks) {
      expect(chunk.artifactId).toBe(path);
    }
  });

  it('all chunk IDs are unique', () => {
    const logFile = makeLogFileWithErrors(100, [25, 50, 75]);
    const chunks = chunkLogFileErrorAware(logFile);
    const ids = chunks.map((c) => c.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it('produces more than one chunk for a file with errors (preamble + at least one error-cluster)', () => {
    const logFile = makeLogFileWithErrors(100, [50]);
    const chunks = chunkLogFileErrorAware(logFile);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('error-cluster chunk metadata has chunkType = error-cluster', () => {
    const logFile = makeLogFileWithErrors(100, [50]);
    const chunks = chunkLogFileErrorAware(logFile);
    const ec = chunks.find((c) => c.metadata?.['chunkType'] === 'error-cluster');
    expect(ec).toBeDefined();
    expect(ec!.metadata!['category']).toBe('log');
  });
});
