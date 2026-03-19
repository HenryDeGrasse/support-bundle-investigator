import type { Chunk } from '../types/index.js';
import type { LogFile } from '../parsers/log-parser.js';
import { extractErrorWindows, deduplicateLogLines } from '../parsers/log-parser.js';
import type { K8sResource, AnalyzerResult } from '../types/index.js';
import { summarizeResource } from '../ai/summarizer.js';

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
// chunkLogFileErrorAware
// ---------------------------------------------------------------------------

/**
 * Error-aware chunking strategy that produces three chunk types:
 *
 * 1. **Preamble chunk** — first 20 lines of every log file (startup / config /
 *    env-var logging). Always included; this is where hostnames, connection
 *    strings, and versions are logged.
 *
 * 2. **Error-cluster chunks** — each group of overlapping error windows
 *    (10-line padding around each error-level line) collapsed into a single
 *    chunk. Repeated lines within each cluster are deduplicated via
 *    {@link deduplicateLogLines} so that 47 identical "connection refused"
 *    lines become one line with a `[repeated x47]` suffix.
 *
 * 3. **Summary chunk** — a short multi-line description of healthy regions:
 *    `"lines N-M: K INFO lines, no errors"`. Preserves the signal that those
 *    regions are healthy without consuming token budget on pure INFO noise.
 *
 * **Backward-compatible:** when no error-level lines exist, the entire file is
 * returned as a single chunk (identical to the old fixed-window approach for
 * small files).
 *
 * This replaces the fixed 50-line window with a semantically meaningful
 * decomposition that dramatically improves LLM diagnostic relevance.
 *
 * @param logFile The parsed log file to chunk.
 */
export function chunkLogFileErrorAware(logFile: LogFile): Chunk[] {
  const { lines, path } = logFile;

  if (lines.length === 0) return [];

  // ── backward-compatible fallback: no errors → entire file as one chunk ──
  if (logFile.errorCount === 0) {
    const startLine = lines[0]!.lineNumber;
    const endLine = lines[lines.length - 1]!.lineNumber;
    return [
      {
        id: `${path}:${startLine}-${endLine}`,
        artifactId: path,
        content: lines.map((l) => l.content).join('\n'),
        startLine,
        endLine,
        metadata: {
          path,
          category: 'log',
          lineRange: [startLine, endLine],
        },
      },
    ];
  }

  const PREAMBLE_SIZE = 20;
  const ERROR_PADDING = 10;

  const chunks: Chunk[] = [];

  // ── 1. Preamble chunk ────────────────────────────────────────────────────
  const preambleEndIdx = Math.min(PREAMBLE_SIZE - 1, lines.length - 1);
  const preambleLines = lines.slice(0, preambleEndIdx + 1);
  chunks.push({
    id: `${path}:preamble:${lines[0]!.lineNumber}-${lines[preambleEndIdx]!.lineNumber}`,
    artifactId: path,
    content: preambleLines.map((l) => l.content).join('\n'),
    startLine: lines[0]!.lineNumber,
    endLine: lines[preambleEndIdx]!.lineNumber,
    metadata: {
      path,
      category: 'log',
      lineRange: [lines[0]!.lineNumber, lines[preambleEndIdx]!.lineNumber],
      chunkType: 'preamble',
    },
  });

  // ── 2. Error-cluster chunks ───────────────────────────────────────────────
  //
  // Extract windows around each error line, convert to index ranges (into the
  // `lines` array), merge overlapping ranges into clusters, then dedup.

  const errorWindows = extractErrorWindows(logFile, ERROR_PADDING);

  // Build a fast lineNumber → array-index lookup.
  const lineNumToIdx = new Map<number, number>();
  for (let i = 0; i < lines.length; i++) {
    lineNumToIdx.set(lines[i]!.lineNumber, i);
  }

  type IndexRange = { startIdx: number; endIdx: number };

  const windowRanges: IndexRange[] = errorWindows.map((w) => ({
    startIdx: lineNumToIdx.get(w.lines[0]!.lineNumber) ?? 0,
    endIdx: lineNumToIdx.get(w.lines[w.lines.length - 1]!.lineNumber) ?? lines.length - 1,
  }));

  windowRanges.sort((a, b) => a.startIdx - b.startIdx);

  // Merge overlapping / adjacent windows into clusters.
  const clusters: IndexRange[] = [];
  for (const range of windowRanges) {
    if (clusters.length === 0) {
      clusters.push({ ...range });
    } else {
      const last = clusters[clusters.length - 1]!;
      if (range.startIdx <= last.endIdx + 1) {
        last.endIdx = Math.max(last.endIdx, range.endIdx);
      } else {
        clusters.push({ ...range });
      }
    }
  }

  // Track which index ranges are covered (preamble + error clusters) so we
  // can identify the healthy "gap" regions for the summary chunk.
  const coveredRanges: IndexRange[] = [{ startIdx: 0, endIdx: preambleEndIdx }];

  for (const cluster of clusters) {
    const clusterLines = lines.slice(cluster.startIdx, cluster.endIdx + 1);
    const dedupedLines = deduplicateLogLines(clusterLines);
    const startLine = lines[cluster.startIdx]!.lineNumber;
    const endLine = lines[cluster.endIdx]!.lineNumber;

    chunks.push({
      id: `${path}:error-cluster:${startLine}-${endLine}`,
      artifactId: path,
      content: dedupedLines.map((l) => l.content).join('\n'),
      startLine,
      endLine,
      metadata: {
        path,
        category: 'log',
        lineRange: [startLine, endLine],
        chunkType: 'error-cluster',
      },
    });

    coveredRanges.push({ ...cluster });
  }

  // ── 3. Summary chunk for healthy regions ─────────────────────────────────
  //
  // Sort and merge covered ranges, then collect the gaps between them.

  coveredRanges.sort((a, b) => a.startIdx - b.startIdx);

  const mergedCovered: IndexRange[] = [];
  for (const range of coveredRanges) {
    if (mergedCovered.length === 0) {
      mergedCovered.push({ ...range });
    } else {
      const last = mergedCovered[mergedCovered.length - 1]!;
      if (range.startIdx <= last.endIdx + 1) {
        last.endIdx = Math.max(last.endIdx, range.endIdx);
      } else {
        mergedCovered.push({ ...range });
      }
    }
  }

  const healthyRegions: IndexRange[] = [];
  let prevEnd = -1;
  for (const { startIdx, endIdx } of mergedCovered) {
    if (prevEnd + 1 < startIdx) {
      healthyRegions.push({ startIdx: prevEnd + 1, endIdx: startIdx - 1 });
    }
    prevEnd = Math.max(prevEnd, endIdx);
  }
  if (prevEnd + 1 <= lines.length - 1) {
    healthyRegions.push({ startIdx: prevEnd + 1, endIdx: lines.length - 1 });
  }

  if (healthyRegions.length > 0) {
    const summaryParts = healthyRegions.map((r) => {
      const startLine = lines[r.startIdx]!.lineNumber;
      const endLine = lines[r.endIdx]!.lineNumber;
      const lineCount = r.endIdx - r.startIdx + 1;
      return `lines ${startLine}-${endLine}: ${lineCount} INFO lines, no errors`;
    });
    const summaryContent = summaryParts.join('\n');
    const firstHealthy = healthyRegions[0]!;
    const lastHealthy = healthyRegions[healthyRegions.length - 1]!;

    chunks.push({
      id: `${path}:summary`,
      artifactId: path,
      content: summaryContent,
      startLine: lines[firstHealthy.startIdx]!.lineNumber,
      endLine: lines[lastHealthy.endIdx]!.lineNumber,
      metadata: {
        path,
        category: 'log',
        lineRange: [
          lines[firstHealthy.startIdx]!.lineNumber,
          lines[lastHealthy.endIdx]!.lineNumber,
        ],
        chunkType: 'summary',
      },
    });
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// chunkResource
// ---------------------------------------------------------------------------

/**
 * Creates a single {@link Chunk} representing an entire Kubernetes resource.
 *
 * The `content` is the human-readable {@link summarizeResource} output so that
 * semantic embeddings capture the resource's diagnostic meaning rather than raw
 * JSON syntax noise.  The original pretty-printed JSON is preserved in
 * `metadata.rawContent` for callers that need the full spec (e.g. the LLM
 * prompt renderer which shows both the summary and the raw object).
 *
 * @param resource The parsed K8s resource.
 * @param path     The artifact path used as the chunk's `artifactId`.
 */
export function chunkResource(resource: K8sResource, path: string): Chunk {
  const rawContent = JSON.stringify(resource, null, 2);
  const content = summarizeResource(resource);
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
      rawContent,
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
