import { runCli } from './cli/runner.js';

export const VERSION = "0.1.0";

// Pipeline
export { analyzeBundlePipeline, cleanupPipelineResult } from './pipeline/index.js';
export type {
  PipelineOptions,
  PipelineResult,
  PipelineProgressEvent,
  PipelineStepStatus,
} from './pipeline/index.js';
export type { InvestigationTrace, TraceStep } from './pipeline/index.js';

// CLI helpers
export { parseArgs, CommanderError } from './cli/index.js';
export type { ParsedArgs, OutputFormat } from './cli/index.js';
export {
  printProfileSummary,
  printTextSummary,
  writeTraceFile,
  writePipelineResult,
} from './cli/index.js';
export type { OutputOptions } from './cli/index.js';
export { runCli } from './cli/runner.js';

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
