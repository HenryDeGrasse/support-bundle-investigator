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
import { InvestigationGraphImpl, buildResourceGraph } from '../graph/index.js';
import type {
  AnalyzerResult,
  BundleProfile,
  Evidence,
  Finding,
  K8sEvent,
  K8sResource,
} from '../types/index.js';
import type { LogFile } from '../parsers/index.js';
import { runInvestigation } from '../investigators/index.js';
import type { AIInvestigatorDeps } from '../investigators/index.js';
import { loadAIConfig, isAIEnabled, buildChunkIndex, LexicalSearchIndex, LLMClient, EmbeddingClient, VectorStore } from '../ai/index.js';
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

export type PipelineStepStatus = 'started' | 'completed';

export interface PipelineProgressEvent {
  /** Name of the pipeline step (matches trace step names: 'extract', 'profile', 'parse-analyzers', 'parse-resources', 'parse-events', 'parse-logs', 'ai-index', 'build-graph', 'investigate'). */
  step: string;
  /** Whether the step just started or just completed. */
  status: PipelineStepStatus;
  /** Number of artifacts processed (only set when status is 'completed'). */
  artifactsProcessed?: number;
}

export interface PipelineOptions {
  outputDir?: string;
  format?: 'json' | 'text' | 'summary' | 'markdown' | 'html';
  verbose?: boolean;
  trace?: boolean;
  /** When true, AI features are disabled regardless of API key presence. */
  noAi?: boolean;
  /** Optional callback invoked when each pipeline step starts and completes. */
  onProgress?: (event: PipelineProgressEvent) => void;
}

export interface PipelineResult {
  profile: BundleProfile;
  analyzerResults: AnalyzerResult[];
  resources: K8sResource[];
  events: K8sEvent[];
  logs: LogFile[];
  /** Verified, deduplicated findings produced by the investigation pipeline. */
  findings: Finding[];
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

function emitProgress(options: PipelineOptions, event: PipelineProgressEvent): void {
  options.onProgress?.(event);
}

function addInvestigationEvidenceNode(
  graph: InvestigationGraphImpl,
  nodeId: string,
  evidence: Evidence,
): boolean {
  if (graph.getNode(nodeId)) {
    return false;
  }

  graph.addNode({
    id: nodeId,
    type: 'evidence',
    data: evidence,
    metadata: {
      category: evidence.artifactType ?? 'unknown',
      timestamp: evidence.timestamp,
      derived: true,
    },
  });

  return true;
}

function addInvestigationEvidenceNodes(
  graph: InvestigationGraphImpl,
  findings: Finding[],
): number {
  let addedCount = 0;

  for (const finding of findings) {
    for (const evidence of finding.evidence) {
      if (addInvestigationEvidenceNode(graph, `evidence:${evidence.path}`, evidence)) {
        addedCount++;
      }
    }
  }

  return addedCount;
}

function ensureInvestigationEdgeEndpoints(
  graph: InvestigationGraphImpl,
  findings: Finding[],
  investigationEdges: ReadonlyArray<{ source: string; target: string }>,
): number {
  let addedCount = 0;
  const evidenceByPath = new Map<string, Evidence>();

  for (const finding of findings) {
    for (const evidence of finding.evidence) {
      evidenceByPath.set(`evidence:${evidence.path}`, evidence);
    }
  }

  for (const edge of investigationEdges) {
    for (const nodeId of [edge.source, edge.target]) {
      if (!nodeId.startsWith('evidence:') || graph.getNode(nodeId)) {
        continue;
      }

      const basePath = nodeId.split(':').slice(0, 2).join(':');
      const baseEvidence = evidenceByPath.get(basePath);
      const placeholderEvidence: Evidence = baseEvidence
        ? {
            ...baseEvidence,
            note: `${baseEvidence.note} (derived graph node: ${nodeId})`,
          }
        : {
            path: nodeId.slice('evidence:'.length),
            note: `Derived investigation evidence node for ${nodeId}`,
            artifactType: 'unknown',
          };

      if (addInvestigationEvidenceNode(graph, nodeId, placeholderEvidence)) {
        addedCount++;
      }
    }
  }

  return addedCount;
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
 * 7. (AI only) Build chunk index + lexical index + LLM client → AIInvestigatorDeps
 * 8. Build the base investigation graph from parsed artifacts
 * 9. Run the investigation orchestrator → findings + graph updates
 * 10. Complete the investigation trace
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

  // `outputDir` is reserved for user-facing artifacts (findings.json, report.md,
  // report.html, trace.json).  Bundle extraction always uses an internal temp
  // directory so cleanup does not delete user-requested outputs.

  // ── 1. Extract bundle ─────────────────────────────────────────────────────
  const step1 = startTraceStep(trace, 'extract');
  emitProgress(options, { step: 'extract', status: 'started' });
  log('Extracting bundle…', verbose);

  const manifest = await extractBundle(bundlePath);

  completeTraceStep(trace, step1, manifest.files.length);
  emitProgress(options, { step: 'extract', status: 'completed', artifactsProcessed: manifest.files.length });
  log(`Extracted ${manifest.files.length} files`, verbose);

  // ── 2. Profile bundle ─────────────────────────────────────────────────────
  const step2 = startTraceStep(trace, 'profile');
  emitProgress(options, { step: 'profile', status: 'started' });
  log('Profiling bundle…', verbose);

  const profile = await profileBundle(manifest);

  completeTraceStep(trace, step2, profile.manifest.files.length);
  emitProgress(options, { step: 'profile', status: 'completed', artifactsProcessed: profile.manifest.files.length });
  log(
    `Profile: ${profile.analyzerCount} analyzers, ` +
      `${profile.resourceCount} resources, ` +
      `${profile.eventCount} events, ` +
      `${profile.logFileCount} logs`,
    verbose,
  );

  // ── 3. Parse analyzer files ───────────────────────────────────────────────
  const step3 = startTraceStep(trace, 'parse-analyzers');
  emitProgress(options, { step: 'parse-analyzers', status: 'started' });
  log('Parsing analyzer files…', verbose);

  const analyzerFiles = profile.manifest.files.filter((f) => f.category === 'analyzer');
  const analyzerBatches = await Promise.all(
    analyzerFiles.map((f) => parseAnalyzerFile(f.absolutePath)),
  );
  const analyzerResults = mergeAnalyzerResults(analyzerBatches);

  completeTraceStep(trace, step3, analyzerResults.length);
  emitProgress(options, { step: 'parse-analyzers', status: 'completed', artifactsProcessed: analyzerResults.length });
  log(`Parsed ${analyzerResults.length} analyzer results`, verbose);

  // ── 4. Parse K8s resource files ───────────────────────────────────────────
  const step4 = startTraceStep(trace, 'parse-resources');
  emitProgress(options, { step: 'parse-resources', status: 'started' });
  log('Parsing Kubernetes resource files…', verbose);

  const resourceFiles = profile.manifest.files.filter(
    (f) => f.category === 'kubernetes-resource',
  );
  const resourceBatches = await Promise.all(
    resourceFiles.map((f) => parseResourceFile(f.absolutePath)),
  );
  const resources = resourceBatches.flat();

  completeTraceStep(trace, step4, resources.length);
  emitProgress(options, { step: 'parse-resources', status: 'completed', artifactsProcessed: resources.length });
  log(`Parsed ${resources.length} K8s resources`, verbose);

  // ── 5. Parse event files ─────────────────────────────────────────────────
  const step5 = startTraceStep(trace, 'parse-events');
  emitProgress(options, { step: 'parse-events', status: 'started' });
  log('Parsing event files…', verbose);

  const eventFiles = profile.manifest.files.filter((f) => f.category === 'event');
  const eventBatches = await Promise.all(
    eventFiles.map((f) => parseEventFile(f.absolutePath)),
  );
  const events = eventBatches.flat();

  completeTraceStep(trace, step5, events.length);
  emitProgress(options, { step: 'parse-events', status: 'completed', artifactsProcessed: events.length });
  log(`Parsed ${events.length} K8s events`, verbose);

  // ── 6. Parse log files ────────────────────────────────────────────────────
  const step6 = startTraceStep(trace, 'parse-logs');
  emitProgress(options, { step: 'parse-logs', status: 'started' });
  log('Parsing log files…', verbose);

  const logEntries = identifyLogFiles(profile.manifest);
  const logs = await Promise.all(logEntries.map((f) => parseLogFile(f.absolutePath)));

  completeTraceStep(trace, step6, logs.length);
  emitProgress(options, { step: 'parse-logs', status: 'completed', artifactsProcessed: logs.length });
  log(`Parsed ${logs.length} log files`, verbose);

  // ── 7. Build AI chunk index and lexical index (optional, AI-gated) ────────
  let aiDeps: AIInvestigatorDeps | undefined;

  const aiConfig = loadAIConfig({ noAi: options.noAi });
  if (isAIEnabled(aiConfig)) {
    const stepAI = startTraceStep(trace, 'ai-index');
    emitProgress(options, { step: 'ai-index', status: 'started' });
    log('Building AI chunk index…', verbose);

    try {
      const chunks = buildChunkIndex({ analyzerResults, resources, events, logs, profile });
      const resourceGraph = buildResourceGraph(resources, events);
      const lexicalIndex = new LexicalSearchIndex();
      lexicalIndex.build(chunks);
      const llmClient = new LLMClient(aiConfig);

      // ── Semantic index (optional expansion layer) ──────────────────────────
      // Attempt to embed all chunk summaries and build a vector store.
      // If embedding fails, aiDeps is still set (without embeddingClient/
      // vectorStore) so graph + lexical retrieval remains available.
      let embeddingClient: EmbeddingClient | undefined;
      let vectorStore: VectorStore | undefined;

      try {
        embeddingClient = new EmbeddingClient(aiConfig);
        const summaries = chunks.map((c) => c.summary);
        const embeddings = await embeddingClient.embed(summaries);

        // Only build the store when at least one embedding succeeded
        const hasValidEmbeddings = embeddings.some((e) => e.length > 0);
        if (hasValidEmbeddings) {
          vectorStore = new VectorStore();
          vectorStore.addAll(chunks, embeddings);
          log(`Semantic index built: ${vectorStore.size} embedded chunks`, verbose);
        } else {
          log('Semantic index skipped: no valid embeddings returned', verbose);
          embeddingClient = undefined;
        }
      } catch (embeddingError) {
        const embeddingMessage =
          embeddingError instanceof Error ? embeddingError.message : String(embeddingError);
        console.warn(
          `[pipeline] Semantic embedding failed, continuing without vector store: ` +
            embeddingMessage,
        );
        embeddingClient = undefined;
        vectorStore = undefined;
      }

      aiDeps = {
        chunkIndex: chunks,
        resourceGraph,
        lexicalIndex,
        llmClient,
        verbose,
        ...(embeddingClient !== undefined && vectorStore !== undefined
          ? { embeddingClient, vectorStore }
          : {}),
      };

      completeTraceStep(trace, stepAI, chunks.length);
      emitProgress(options, { step: 'ai-index', status: 'completed', artifactsProcessed: chunks.length });
      log(`AI index built: ${chunks.length} chunks`, verbose);
    } catch (error) {
      // Graceful degradation: AI setup failed, continue without AI
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.warn(
        `[pipeline] AI index build failed, continuing in heuristic-only mode: ` +
          errorMessage,
      );
      completeTraceStep(trace, stepAI, 0, [errorMessage]);
      emitProgress(options, { step: 'ai-index', status: 'completed', artifactsProcessed: 0 });
    }
  }

  // ── 8. Build investigation graph ──────────────────────────────────────────
  const step7 = startTraceStep(trace, 'build-graph');
  emitProgress(options, { step: 'build-graph', status: 'started' });
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
  emitProgress(options, { step: 'build-graph', status: 'completed', artifactsProcessed: graphNodeCount });
  log(`Built graph with ${graphNodeCount} nodes`, verbose);

  // ── 9. Run investigation pipeline ────────────────────────────────────────
  const step8 = startTraceStep(trace, 'investigate');
  emitProgress(options, { step: 'investigate', status: 'started' });
  log('Running investigation pipeline…', verbose);

  const investigationResult = await runInvestigation(
    {
      analyzerResults,
      resources,
      events,
      logs,
      profile,
    },
    aiDeps,
  );

  const evidenceNodeCount = addInvestigationEvidenceNodes(
    graph,
    investigationResult.findings,
  );

  // Add finding nodes to the investigation graph.
  for (const finding of investigationResult.findings) {
    graph.addNode({
      id: finding.id,
      type: 'finding',
      data: finding,
      metadata: {
        severity: finding.severity,
        confidence: finding.confidence,
      },
    });
  }

  const derivedEvidenceNodeCount = ensureInvestigationEdgeEndpoints(
    graph,
    investigationResult.findings,
    investigationResult.edges,
  );

  // Add graph edges discovered by investigators.
  for (const edge of investigationResult.edges) {
    graph.addEdge(edge);
  }

  const investigateArtifactsProcessed =
    evidenceNodeCount +
    derivedEvidenceNodeCount +
    investigationResult.findings.length +
    investigationResult.edges.length;
  completeTraceStep(trace, step8, investigateArtifactsProcessed);
  emitProgress(options, { step: 'investigate', status: 'completed', artifactsProcessed: investigateArtifactsProcessed });
  const aiSuffix = investigationResult.metadata.aiEnabled
    ? `, ${investigationResult.metadata.aiFindings} AI findings`
    : '';
  log(
    `Investigation: ${investigationResult.metadata.seedCount} seeds, ` +
      `${investigationResult.metadata.rawFindingCount} raw findings → ` +
      `${investigationResult.metadata.finalFindingCount} after verification, ` +
      `${evidenceNodeCount + derivedEvidenceNodeCount} evidence nodes, ` +
      `${investigationResult.edges.length} edges${aiSuffix}`,
    verbose,
  );

  // ── 10. Complete trace ────────────────────────────────────────────────────
  completeTrace(trace, profile);

  return {
    profile,
    analyzerResults,
    resources,
    events,
    logs,
    findings: investigationResult.findings,
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
