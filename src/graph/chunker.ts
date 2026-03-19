import type { Chunk } from '../types/index.js';
import type { LogFile } from '../parsers/log-parser.js';
import type { K8sResource, AnalyzerResult } from '../types/index.js';

// ---------------------------------------------------------------------------
// chunkLogFile
// ---------------------------------------------------------------------------

/**
 * Splits a {@link LogFile} into overlapping chunks of `chunkSize` lines each.
 *
 * Consecutive chunks are offset by `step = chunkSize - overlap` lines so that
 * `overlap` lines appear in both the preceding and following chunk.
 *
 * @param logFile   The parsed log file to chunk.
 * @param chunkSize Number of log lines per chunk.
 * @param overlap   Number of lines that overlap between adjacent chunks.
 *                  Must be less than `chunkSize`; clamped to `chunkSize - 1`.
 */
export function chunkLogFile(logFile: LogFile, chunkSize: number, overlap: number): Chunk[] {
  const { lines, path } = logFile;

  if (lines.length === 0) return [];
  if (chunkSize <= 0) {
    throw new Error('chunkSize must be greater than 0');
  }

  const safeOverlap = Math.min(Math.max(overlap, 0), chunkSize - 1);
  const step = Math.max(1, chunkSize - safeOverlap);
  const chunks: Chunk[] = [];

  for (let i = 0; i < lines.length; i += step) {
    const startIdx = i;
    const endIdx = Math.min(i + chunkSize - 1, lines.length - 1);

    const chunkLines = lines.slice(startIdx, endIdx + 1);
    const startLine = lines[startIdx]!.lineNumber;
    const endLine = lines[endIdx]!.lineNumber;

    chunks.push({
      id: `${path}:${startLine}-${endLine}`,
      artifactId: path,
      content: chunkLines.map((l) => l.content).join('\n'),
      startLine,
      endLine,
      metadata: {
        path,
        category: 'log',
        lineRange: [startLine, endLine],
      },
    });

    // Stop once we've covered the last line
    if (endIdx >= lines.length - 1) break;
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// chunkResource
// ---------------------------------------------------------------------------

/**
 * Creates a single {@link Chunk} representing an entire Kubernetes resource.
 *
 * The content is a pretty-printed JSON serialisation of the resource object.
 *
 * @param resource The parsed K8s resource.
 * @param path     The artifact path used as the chunk's `artifactId`.
 */
export function chunkResource(resource: K8sResource, path: string): Chunk {
  const content = JSON.stringify(resource, null, 2);
  const lines = content.split('\n');

  return {
    id: `${path}:${resource.metadata.name}:resource`,
    artifactId: path,
    content,
    startLine: 1,
    endLine: lines.length,
    metadata: {
      path,
      category: 'kubernetes-resource',
      lineRange: [1, lines.length],
      kind: resource.kind,
      name: resource.metadata.name,
      namespace: resource.metadata.namespace,
    },
  };
}

// ---------------------------------------------------------------------------
// chunkAnalyzer
// ---------------------------------------------------------------------------

/**
 * Creates a single {@link Chunk} for an analyzer result.
 *
 * Content is a human-readable summary: `[SEVERITY] Title\nMessage`.
 *
 * @param result The parsed analyzer result.
 */
export function chunkAnalyzer(result: AnalyzerResult): Chunk {
  const content = `[${result.severity.toUpperCase()}] ${result.title}\n${result.message}`;
  const lines = content.split('\n');

  return {
    id: `analyzer:${result.name}`,
    artifactId: result.name,
    content,
    startLine: 1,
    endLine: lines.length,
    metadata: {
      path: `analyzer/${result.name}`,
      category: 'analyzer',
      lineRange: [1, lines.length],
      severity: result.severity,
      name: result.name,
    },
  };
}
