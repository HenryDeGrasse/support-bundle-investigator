import { runCli } from './cli/runner.js';

export { VERSION } from './version.js';

// Pipeline
export { analyzeBundlePipeline, cleanupPipelineResult } from './pipeline/index.js';
export type {
  PipelineOptions,
  PipelineResult,
  PipelineProgressEvent,
  PipelineStepStatus,
} from './pipeline/index.js';
export type { InvestigationTrace, TraceStep } from './pipeline/index.js';

// Archive ingestion
export {
  DEFAULT_MAX_ENTRIES,
  DEFAULT_MAX_ENTRY_SIZE,
  DEFAULT_MAX_PATH_LENGTH,
  DEFAULT_MAX_UNCOMPRESSED_SIZE,
  extractBundle,
} from './ingestion/index.js';
export type { ExtractOptions } from './ingestion/index.js';

// CLI helpers
export { parseArgs, CommanderError } from './cli/index.js';
export type { ParsedArgs, OutputFormat } from './cli/index.js';
export {
  printProfileSummary,
  printTextSummary,
  writeTraceFile,
  writeProvenanceFile,
  writePipelineResult,
} from './cli/index.js';
export type { OutputOptions } from './cli/index.js';
export { runCli } from './cli/runner.js';

// ── Retrieval infrastructure ──────────────────────────────────────────────────
// Re-exported for benchmark scripts and downstream consumers that need
// direct access to the retrieval pipeline without invoking the full CLI.

export { buildChunkIndex } from './ai/chunk-indexer.js';
export type { IndexedChunk } from './ai/chunk-indexer.js';
export { LexicalSearchIndex } from './ai/lexical-search.js';
export { computeRetrievalMetrics, aggregateRetrievalMetrics } from './ai/retrieval-metrics.js';
export type { RetrievalMetrics } from './ai/retrieval-metrics.js';

export { buildResourceGraph, getRelatedChunks } from './graph/resource-graph.js';
export type { ResourceRelationshipGraph, GraphScoredChunk } from './graph/resource-graph.js';

export { parseResourceJson } from './parsers/k8s-resource-parser.js';
export { parseEventsJson } from './parsers/event-parser.js';
export { parseLogFile } from './parsers/log-parser.js';

if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  runCli().then(
    (exitCode) => {
      process.exit(exitCode);
    },
    (err: unknown) => {
      console.error('Fatal:', err);
      process.exit(1);
    },
  );
}
