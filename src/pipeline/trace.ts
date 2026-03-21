import type { BundleProfile } from '../types/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RetrievalStats {
  graphChunks: number;
  lexicalChunks: number;
  semanticChunks: number;
  mergedChunks: number;
}

export interface ConfidenceStats {
  min: number;
  max: number;
  mean: number;
  median: number;
}

export interface HypothesisStats {
  generated: number;
  verified: number;
  converted: number;
}

export interface TraceStep {
  name: string;
  startedAt: string;
  completedAt?: string;
  artifactsProcessed: number;
  errors?: string[];
  seedCount?: number;
  seedCategories?: Record<string, number>;
  retrievalStats?: RetrievalStats;
  confidenceStats?: ConfidenceStats;
  hypothesisStats?: HypothesisStats;
}

export interface InvestigationTrace {
  bundlePath: string;
  startedAt: string;
  completedAt?: string;
  steps: TraceStep[];
  profile?: BundleProfile;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a new investigation trace for the given bundle path.
 */
export function createTrace(bundlePath: string): InvestigationTrace {
  return {
    bundlePath,
    startedAt: new Date().toISOString(),
    steps: [],
  };
}

/**
 * Records the start of a new pipeline step and returns its index.
 *
 * The returned index should be passed to {@link completeTraceStep} when the
 * step finishes.
 */
export function startTraceStep(trace: InvestigationTrace, name: string): number {
  const step: TraceStep = {
    name,
    startedAt: new Date().toISOString(),
    artifactsProcessed: 0,
  };
  trace.steps.push(step);
  return trace.steps.length - 1;
}

/**
 * Marks a trace step as completed, recording the finish time, artifact count
 * and any errors encountered.
 */
export function completeTraceStep(
  trace: InvestigationTrace,
  stepIndex: number,
  artifactsProcessed: number,
  errors?: string[],
): void {
  const step = trace.steps[stepIndex];
  if (!step) return;

  step.completedAt = new Date().toISOString();
  step.artifactsProcessed = artifactsProcessed;
  if (errors && errors.length > 0) {
    step.errors = errors;
  }
}

/**
 * Marks the entire trace as completed.
 */
export function completeTrace(
  trace: InvestigationTrace,
  profile?: BundleProfile,
  metadata?: Record<string, unknown>,
): void {
  trace.completedAt = new Date().toISOString();
  if (profile) {
    trace.profile = profile;
  }
  if (metadata && Object.keys(metadata).length > 0) {
    trace.metadata = metadata;
  }
}
