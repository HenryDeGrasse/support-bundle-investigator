import type { Chunk, ArtifactCategory } from '../types/index.js';
import type { K8sResource, K8sEvent, AnalyzerResult } from '../types/index.js';
import type { InvestigatorContext } from '../investigators/types.js';
import { chunkLogFile, chunkResource, chunkAnalyzer } from '../graph/chunker.js';
import { summarizeResource, summarizeEvent, summarizeAnalyzer } from './summarizer.js';
import { extractTimestamps } from '../parsers/index.js';

// ---------------------------------------------------------------------------
// IndexedChunk
// ---------------------------------------------------------------------------

/**
 * A {@link Chunk} augmented with retrieval metadata for cross-source
 * correlation.
 *
 * Every `IndexedChunk` preserves stable citation metadata:
 * - `id`              — stable chunk ID (path:startLine-endLine or artifact:name)
 * - `artifactId`      — the source file path
 * - `artifactCategory`— the artifact type (log, kubernetes-resource, event, analyzer, …)
 * - `startLine`/`endLine` — deterministic line-range boundary
 * - `summary`         — a human-readable description of the chunk content
 * - `identifiers`     — pod names, namespaces, secret names, image tags, error reasons
 * - `namespace`       — Kubernetes namespace when applicable
 * - `timestamp`       — ISO timestamp extracted from the content when available
 */
export interface IndexedChunk extends Chunk {
  /** Human-readable description of the chunk for LLM context. */
  summary: string;
  /**
   * Key identifiers extracted deterministically from the chunk:
   * pod names, container names, namespace names, image tags, secret names,
   * configmap names, error reasons, log levels.
   */
  identifiers: string[];
  /** Kubernetes namespace, when applicable. */
  namespace?: string;
  /** Artifact category for retrieval filtering and citation labels. */
  artifactCategory: ArtifactCategory;
  /** ISO timestamp extracted from the chunk content, when present. */
  timestamp?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function getArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Extracts the file path from a chunk's metadata or falls back to artifactId.
 */
function getChunkPath(chunk: Chunk): string {
  if (isRecord(chunk.metadata) && typeof chunk.metadata['path'] === 'string') {
    return chunk.metadata['path'];
  }
  return chunk.artifactId;
}

// ---------------------------------------------------------------------------
// Identifier extractors
// ---------------------------------------------------------------------------

/**
 * Extracts identifiers from a K8s resource: name, namespace, container names,
 * image tags, referenced secret/configmap names, owner ref names.
 */
function identifiersFromResource(resource: K8sResource): string[] {
  const ids = new Set<string>();

  ids.add(resource.metadata.name);
  if (resource.metadata.namespace) ids.add(resource.metadata.namespace);

  // Labels keys/values that might be identifiers
  for (const [k, v] of Object.entries(resource.metadata.labels ?? {})) {
    if (k === 'app' || k === 'app.kubernetes.io/name') ids.add(v);
  }

  const spec = isRecord(resource.spec) ? (resource.spec as Record<string, unknown>) : {};

  // Pod containers (or pod template containers for workloads)
  const containers = getArray(spec['containers']);
  const initContainers = getArray(spec['initContainers']);

  // For workload resources, also inspect spec.template.spec.
  const template = isRecord(spec['template']) ? (spec['template'] as Record<string, unknown>) : {};
  const podSpec = isRecord(template['spec']) ? (template['spec'] as Record<string, unknown>) : {};
  const templateContainers = getArray(podSpec['containers']);
  const templateInitContainers = getArray(podSpec['initContainers']);

  const allContainers = [
    ...containers,
    ...initContainers,
    ...templateContainers,
    ...templateInitContainers,
  ];

  const allVolumeSpecs = [
    ...getArray(spec['volumes']),
    ...getArray(podSpec['volumes']),
  ];

  for (const c of allContainers) {
    if (!isRecord(c)) continue;
    const cName = getString(c['name']);
    if (cName) ids.add(cName);

    const image = getString(c['image']);
    if (image) {
      ids.add(image);
      // Also add the image name without tag and the tag itself
      const colonIdx = image.lastIndexOf(':');
      if (colonIdx > 0) {
        ids.add(image.slice(0, colonIdx));
        ids.add(image.slice(colonIdx + 1));
      }
    }

    // envFrom secrets/configmaps
    for (const ef of getArray(c['envFrom'])) {
      if (!isRecord(ef)) continue;
      if (isRecord(ef['secretRef'])) ids.add(getString(ef['secretRef']['name']));
      if (isRecord(ef['configMapRef'])) ids.add(getString(ef['configMapRef']['name']));
    }

    // env.valueFrom
    for (const ev of getArray(c['env'])) {
      if (!isRecord(ev) || !isRecord(ev['valueFrom'])) continue;
      const vf = ev['valueFrom'] as Record<string, unknown>;
      if (isRecord(vf['secretKeyRef'])) ids.add(getString(vf['secretKeyRef']['name']));
      if (isRecord(vf['configMapKeyRef'])) ids.add(getString(vf['configMapKeyRef']['name']));
    }
  }

  // Volume references
  for (const vol of allVolumeSpecs) {
    if (!isRecord(vol)) continue;
    if (isRecord(vol['secret'])) ids.add(getString(vol['secret']['secretName']));
    if (isRecord(vol['configMap'])) ids.add(getString(vol['configMap']['name']));
    if (isRecord(vol['persistentVolumeClaim'])) ids.add(getString(vol['persistentVolumeClaim']['claimName']));
  }

  // Owner references
  const ownerRefs = getArray((resource.metadata as unknown as Record<string, unknown>)['ownerReferences']);
  for (const ref of ownerRefs) {
    if (isRecord(ref)) ids.add(getString(ref['name']));
  }

  // Pod/container status reasons improve deterministic lexical matching.
  const status = isRecord(resource.status) ? (resource.status as Record<string, unknown>) : {};
  for (const condition of getArray(status['conditions'])) {
    if (!isRecord(condition)) continue;
    const type = getString(condition['type']);
    const reason = getString(condition['reason']);
    if (type) ids.add(type);
    if (reason) ids.add(reason);
  }

  for (const containerStatus of getArray(status['containerStatuses'])) {
    if (!isRecord(containerStatus)) continue;
    for (const stateName of ['waiting', 'terminated', 'running'] as const) {
      if (!isRecord(containerStatus['state'])) continue;
      const state = containerStatus['state'] as Record<string, unknown>;
      if (!isRecord(state[stateName])) continue;
      const stateDetails = state[stateName] as Record<string, unknown>;
      const reason = getString(stateDetails['reason']);
      if (reason) ids.add(reason);
      ids.add(stateName);
    }
  }

  const phase = getString(status['phase']);
  if (phase) ids.add(phase);

  // ConfigMap keys (useful for spotting typos in data values)
  const raw = resource as unknown as Record<string, unknown>;
  if (resource.kind === 'ConfigMap' && isRecord(raw['data'])) {
    for (const key of Object.keys(raw['data'] as Record<string, unknown>)) {
      ids.add(key);
    }
  }

  // Filter empty strings
  ids.delete('');
  return [...ids];
}

/**
 * Extracts identifiers from a K8s event: involved object name/namespace,
 * reason.
 */
function identifiersFromEvent(event: K8sEvent): string[] {
  const ids = new Set<string>();
  ids.add(event.involvedObject.name);
  ids.add(event.reason);
  if (event.involvedObject.namespace) ids.add(event.involvedObject.namespace);
  ids.delete('');
  return [...ids];
}

/**
 * Extracts identifiers from log chunk content: pod/container names embedded
 * in log lines (e.g. "[app-pod]"), error reasons, and common K8s identifiers.
 *
 * This is a best-effort extraction using common log patterns.
 */
function identifiersFromLogContent(content: string, path: string): string[] {
  const ids = new Set<string>();

  // Path-based: extract likely pod/container name from path segment
  const pathSegments = path.replace(/\\/g, '/').split('/');
  for (const seg of pathSegments) {
    if (seg && seg !== 'logs' && !seg.endsWith('.log') && !seg.endsWith('.txt')) {
      ids.add(seg);
    }
  }

  // Common K8s error reasons that appear in logs
  const k8sReasons = [
    'CrashLoopBackOff', 'ImagePullBackOff', 'ErrImagePull', 'OOMKilled',
    'Error', 'ContainerCannotRun', 'DeadlineExceeded', 'Evicted',
  ];
  for (const reason of k8sReasons) {
    if (content.includes(reason)) ids.add(reason);
  }

  // Log-level keywords as identifiers for filtering
  if (/\bFATAL\b/i.test(content)) ids.add('FATAL');
  if (/\bERROR\b/i.test(content)) ids.add('ERROR');
  if (/\bWARN(ING)?\b/i.test(content)) ids.add('WARN');

  ids.delete('');
  return [...ids];
}

/**
 * Extracts identifiers from analyzer chunk content and name.
 */
function identifiersFromAnalyzer(result: AnalyzerResult): string[] {
  const ids = new Set<string>();
  ids.add(result.name);
  ids.add(result.severity);

  // Common component names that might appear in analyzer messages
  const words = `${result.title} ${result.message}`.split(/\s+/);
  for (const word of words) {
    // Keep only alpha-numeric-hyphen tokens that look like resource names
    if (/^[a-z][a-z0-9-]{2,63}$/.test(word)) {
      ids.add(word);
    }
  }

  ids.delete('');
  return [...ids];
}

// ---------------------------------------------------------------------------
// Event chunking (not in the base chunker — added here as additive)
// ---------------------------------------------------------------------------

/**
 * Creates a single {@link Chunk} for a K8s event.
 *
 * Content is the {@link summarizeEvent} output.
 */
function chunkEvent(event: K8sEvent, index: number): Chunk {
  const content = summarizeEvent(event);
  const lines = content.split('\n');
  const ns = event.involvedObject.namespace ?? 'default';
  const id = `event:${ns}:${event.reason}:${event.involvedObject.name}:${index}`;

  return {
    id,
    artifactId: `events/${ns}`,
    content,
    startLine: 1,
    endLine: lines.length,
    metadata: {
      path: `events/${ns}`,
      category: 'event',
      lineRange: [1, lines.length],
      reason: event.reason,
      kind: event.involvedObject.kind,
      name: event.involvedObject.name,
      namespace: ns,
    },
  };
}

// ---------------------------------------------------------------------------
// Augmentation helpers
// ---------------------------------------------------------------------------

function augmentResourceChunk(chunk: Chunk, resource: K8sResource): IndexedChunk {
  const summary = summarizeResource(resource);
  const identifiers = identifiersFromResource(resource);
  const ns = resource.metadata.namespace;

  return {
    ...chunk,
    summary,
    identifiers,
    namespace: ns,
    artifactCategory: 'kubernetes-resource',
  };
}

function augmentEventChunk(chunk: Chunk, event: K8sEvent): IndexedChunk {
  const summary = summarizeEvent(event);
  const identifiers = identifiersFromEvent(event);
  const ns = event.involvedObject.namespace;

  return {
    ...chunk,
    summary,
    identifiers,
    namespace: ns,
    artifactCategory: 'event',
    timestamp: event.lastTimestamp ?? event.firstTimestamp,
  };
}

function augmentAnalyzerChunk(chunk: Chunk, result: AnalyzerResult): IndexedChunk {
  const summary = summarizeAnalyzer(result);
  const identifiers = identifiersFromAnalyzer(result);

  return {
    ...chunk,
    summary,
    identifiers,
    artifactCategory: 'analyzer',
  };
}

function augmentLogChunk(chunk: Chunk): IndexedChunk {
  const path = getChunkPath(chunk);
  const identifiers = identifiersFromLogContent(chunk.content, path);

  // Try to extract a timestamp from the first line of the chunk
  const firstLine = chunk.content.split('\n')[0] ?? '';
  const ts = extractTimestamps(firstLine);

  return {
    ...chunk,
    summary: `Log chunk from ${path} (lines ${chunk.startLine}–${chunk.endLine})`,
    identifiers,
    artifactCategory: 'log',
    timestamp: ts ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// buildChunkIndex
// ---------------------------------------------------------------------------

/**
 * Builds a flat array of {@link IndexedChunk}s from all artifacts in the
 * investigator context.
 *
 * Every chunk includes:
 * - Stable citation metadata (chunk id, file path, artifact type, line range)
 * - A human-readable summary for LLM context
 * - Deterministically extracted identifiers for lexical matching
 *
 * Chunking parameters:
 * - Log files: 50-line chunks with 10-line overlap
 * - K8s resources: one chunk per object (preserves full structure)
 * - Events: one chunk per event
 * - Analyzer results: one chunk per result
 */
export function buildChunkIndex(context: InvestigatorContext): IndexedChunk[] {
  const chunks: IndexedChunk[] = [];

  // ── K8s resources ──────────────────────────────────────────────────────────
  for (const resource of context.resources) {
    const ns = resource.metadata.namespace ?? 'default';
    const path = `cluster-resources/${resource.kind.toLowerCase()}/${ns}/${resource.metadata.name}.json`;
    const baseChunk = chunkResource(resource, path);
    chunks.push(augmentResourceChunk(baseChunk, resource));
  }

  // ── Events ────────────────────────────────────────────────────────────────
  for (let i = 0; i < context.events.length; i++) {
    const event = context.events[i]!;
    const baseChunk = chunkEvent(event, i);
    chunks.push(augmentEventChunk(baseChunk, event));
  }

  // ── Log files ─────────────────────────────────────────────────────────────
  for (const logFile of context.logs) {
    const baseChunks = chunkLogFile(logFile, 50, 10);
    for (const baseChunk of baseChunks) {
      chunks.push(augmentLogChunk(baseChunk));
    }
  }

  // ── Analyzer results ───────────────────────────────────────────────────────
  for (const result of context.analyzerResults) {
    const baseChunk = chunkAnalyzer(result);
    chunks.push(augmentAnalyzerChunk(baseChunk, result));
  }

  return chunks;
}
