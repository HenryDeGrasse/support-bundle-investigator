import { describe, it, expect } from 'vitest';
import { chunkLogFile, chunkResource, chunkAnalyzer } from '../chunker.js';
import type { LogFile, LogLine } from '../../parsers/log-parser.js';
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
