import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { extractBundle, profileBundle } from '../ingestion/index.js';
import {
  parseAnalyzerFile,
  mergeAnalyzerResults,
  parseResourceFile,
  parseEventFile,
  identifyLogFiles,
  parseLogFile,
} from '../parsers/index.js';
import { InvestigationGraphImpl } from '../graph/index.js';
import type { AnalyzerResult, BundleProfile, K8sEvent, K8sResource } from '../types/index.js';
import type { LogFile } from '../parsers/index.js';
import {
  createTrace,
  startTraceStep,
  completeTraceStep,
  completeTrace,
} from './trace.js';
import type { InvestigationTrace } from './trace.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PipelineOptions {
  outputDir?: string;
  format?: 'json' | 'text' | 'summary';
  verbose?: boolean;
  trace?: boolean;
}

export interface PipelineResult {
  profile: BundleProfile;
  analyzerResults: AnalyzerResult[];
  resources: K8sResource[];
  events: K8sEvent[];
  logs: LogFile[];
  graph: InvestigationGraphImpl;
  trace: InvestigationTrace;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(message: string, verbose: boolean): void {
  if (verbose) {
    console.log(`[pipeline] ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

/**
 * Runs the full analysis pipeline on a support bundle archive.
 *
 * Steps:
 * 1. Extract bundle archive → BundleManifest
 * 2. Profile bundle → BundleProfile (classify artifacts)
 * 3. Parse analyzer files → AnalyzerResult[]
 * 4. Parse K8s resource files → K8sResource[]
 * 5. Parse event files → K8sEvent[]
 * 6. Parse log files → LogFile[]
 * 7. Build investigation graph
 * 8. Build investigation trace
 * 9. Return PipelineResult
 *
 * @param bundlePath - Path to the `.tar.gz` support bundle archive.
 * @param options    - Optional pipeline configuration.
 */
export async function analyzeBundlePipeline(
  bundlePath: string,
  options: PipelineOptions = {},
): Promise<PipelineResult> {
  const { verbose = false } = options;
  const trace = createTrace(path.resolve(bundlePath));

  // `outputDir` is reserved for user-facing artifacts (result.json, trace.json).
  // Bundle extraction always uses an internal temp directory so cleanup does not
  // delete user-requested outputs.

  // ── 1. Extract bundle ─────────────────────────────────────────────────────
  const step1 = startTraceStep(trace, 'extract');
  log('Extracting bundle…', verbose);

  const manifest = await extractBundle(bundlePath);

  completeTraceStep(trace, step1, manifest.files.length);
  log(`Extracted ${manifest.files.length} files`, verbose);

  // ── 2. Profile bundle ─────────────────────────────────────────────────────
  const step2 = startTraceStep(trace, 'profile');
  log('Profiling bundle…', verbose);

  const profile = await profileBundle(manifest);

  completeTraceStep(trace, step2, profile.manifest.files.length);
  log(
    `Profile: ${profile.analyzerCount} analyzers, ` +
      `${profile.resourceCount} resources, ` +
      `${profile.eventCount} events, ` +
      `${profile.logFileCount} logs`,
    verbose,
  );

  // ── 3. Parse analyzer files ───────────────────────────────────────────────
  const step3 = startTraceStep(trace, 'parse-analyzers');
  log('Parsing analyzer files…', verbose);

  const analyzerFiles = profile.manifest.files.filter((f) => f.category === 'analyzer');
  const analyzerBatches = await Promise.all(
    analyzerFiles.map((f) => parseAnalyzerFile(f.absolutePath)),
  );
  const analyzerResults = mergeAnalyzerResults(analyzerBatches);

  completeTraceStep(trace, step3, analyzerResults.length);
  log(`Parsed ${analyzerResults.length} analyzer results`, verbose);

  // ── 4. Parse K8s resource files ───────────────────────────────────────────
  const step4 = startTraceStep(trace, 'parse-resources');
  log('Parsing Kubernetes resource files…', verbose);

  const resourceFiles = profile.manifest.files.filter(
    (f) => f.category === 'kubernetes-resource',
  );
  const resourceBatches = await Promise.all(
    resourceFiles.map((f) => parseResourceFile(f.absolutePath)),
  );
  const resources = resourceBatches.flat();

  completeTraceStep(trace, step4, resources.length);
  log(`Parsed ${resources.length} K8s resources`, verbose);

  // ── 5. Parse event files ─────────────────────────────────────────────────
  const step5 = startTraceStep(trace, 'parse-events');
  log('Parsing event files…', verbose);

  const eventFiles = profile.manifest.files.filter((f) => f.category === 'event');
  const eventBatches = await Promise.all(
    eventFiles.map((f) => parseEventFile(f.absolutePath)),
  );
  const events = eventBatches.flat();

  completeTraceStep(trace, step5, events.length);
  log(`Parsed ${events.length} K8s events`, verbose);

  // ── 6. Parse log files ────────────────────────────────────────────────────
  const step6 = startTraceStep(trace, 'parse-logs');
  log('Parsing log files…', verbose);

  const logEntries = identifyLogFiles(profile.manifest);
  const logs = await Promise.all(logEntries.map((f) => parseLogFile(f.absolutePath)));

  completeTraceStep(trace, step6, logs.length);
  log(`Parsed ${logs.length} log files`, verbose);

  // ── 7. Build investigation graph ──────────────────────────────────────────
  const step7 = startTraceStep(trace, 'build-graph');
  log('Building investigation graph…', verbose);

  const graph = new InvestigationGraphImpl();
  let graphNodeCount = 0;

  for (const result of analyzerResults) {
    graph.addNode({
      id: `analyzer:${result.name}`,
      type: 'evidence',
      data: result,
      metadata: { category: 'analyzer' },
    });
    graphNodeCount++;
  }

  for (const resource of resources) {
    const nodeId = `resource:${resource.kind}/${resource.metadata.namespace ?? '_'}/${resource.metadata.name}`;
    graph.addNode({
      id: nodeId,
      type: 'artifact',
      data: resource,
      metadata: { category: 'kubernetes-resource' },
    });
    graphNodeCount++;
  }

  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    const nodeId = `event:${i}:${event.reason}:${event.involvedObject.name}`;
    graph.addNode({
      id: nodeId,
      type: 'evidence',
      data: event,
      metadata: { category: 'event' },
    });
    graphNodeCount++;
  }

  for (const logFile of logs) {
    const nodeId = `log:${logFile.path}`;
    graph.addNode({
      id: nodeId,
      type: 'artifact',
      data: logFile,
      metadata: { category: 'log' },
    });
    graphNodeCount++;
  }

  completeTraceStep(trace, step7, graphNodeCount);
  log(`Built graph with ${graphNodeCount} nodes`, verbose);

  // ── 8. Complete trace ─────────────────────────────────────────────────────
  completeTrace(trace, profile);

  return {
    profile,
    analyzerResults,
    resources,
    events,
    logs,
    graph,
    trace,
  };
}

// ---------------------------------------------------------------------------
// Cleanup helper
// ---------------------------------------------------------------------------

/**
 * Removes the temporary extraction directory created by the pipeline.
 *
 * Only removes directories that appear to be auto-created temp dirs (i.e.
 * paths under `os.tmpdir()` matching the `sbi-bundle-*` pattern). Caller is
 * responsible for deciding whether to clean up.
 */
export async function cleanupPipelineResult(result: PipelineResult): Promise<void> {
  const extractedPath = path.resolve(result.profile.manifest.extractedPath);
  const tempRoot = path.resolve(os.tmpdir());
  const relativeToTempRoot = path.relative(tempRoot, extractedPath);

  const isAutoCreatedTempDir =
    relativeToTempRoot !== '' &&
    !relativeToTempRoot.startsWith('..') &&
    !path.isAbsolute(relativeToTempRoot) &&
    path.basename(extractedPath).startsWith('sbi-bundle-');

  if (!isAutoCreatedTempDir) {
    return;
  }

  try {
    await fsp.rm(extractedPath, { recursive: true, force: true });
  } catch {
    // Silently ignore cleanup failures
  }
}
