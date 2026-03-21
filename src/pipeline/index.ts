export { analyzeBundlePipeline, cleanupPipelineResult } from './analyze.js';
export type { PipelineOptions, PipelineResult, PipelineProgressEvent, PipelineStepStatus, AIMode } from './analyze.js';

export {
  createTrace,
  startTraceStep,
  completeTraceStep,
  completeTrace,
} from './trace.js';
export type { TraceStep, InvestigationTrace } from './trace.js';
