import type { Chunk, ArtifactCategory } from '../types/index.js';
import type { K8sResource, K8sEvent, AnalyzerResult } from '../types/index.js';
import type { HelmRelease } from '../parsers/index.js';
import type { InvestigatorContext } from '../investigators/types.js';
import { chunkLogFileErrorAware, chunkResource, chunkAnalyzer } from '../graph/chunker.js';
import { summarizeResource, summarizeEvent, summarizeAnalyzer, summarizeHelmRelease } from './summarizer.js';
import { extractTimestamps } from '../parsers/index.js';
import { contextualizeChunks, buildDocumentContext } from './contextual-retrieval.js';

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

/**
 * Estimates the number of tokens in a text string using a simple heuristic:
 * 4 characters per token (a reasonable approximation for English prose, YAML,
 * and JSON content with Claude/GPT tokenizers).
 *
 * This is intentionally a fast, allocation-free estimate — no tokenizer
 * required.  Uses floor division so the result is always an integer.
 *
 * @param text - The text to estimate token count for.
 * @returns Estimated token count: `Math.floor(text.length / 4)`.
 */
export function estimateTokens(text: string): number {
  return Math.floor(text.length / 4);
}

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
  /**
   * Context-enriched content for embedding.
   *
   * A short template-generated context sentence is prepended to the raw
   * chunk content before embedding so that the vector representation encodes
   * both the chunk's source (kind, name, namespace, path) and its text.
   *
   * When present, the embedding pipeline uses this field instead of the raw
   * `content`.  The original `content` is always preserved unchanged.
   *
   * Populated by {@link contextualizeChunks} inside {@link buildChunkIndex}.
   */
  contextualizedContent?: string;
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
// Network identifier extraction
// ---------------------------------------------------------------------------

/**
 * Extracts network identifiers (hostnames, IPs, and URLs) from a plain string
 * value.  Used to surface meaningful connection targets from ConfigMap data
 * values and Pod `env[].value` literals so that lexical search can correlate
 * mis-configured host references across resources and logs.
 *
 * Recognition rules (applied in order, first match wins):
 * 1. **URL** (`scheme://[userinfo@]host[/…]`) — returns the bare hostname.
 * 2. **host:port** — returns the hostname part.
 * 3. **Bare dotted hostname** — returned as-is (must contain at least one `.`
 *    and start with a letter to avoid port-only strings like `"5432"`).
 *
 * Returns an empty array for values that match none of the above (e.g. plain
 * integers, short environment values like `"production"` or `"info"`).
 */
export function extractNetworkIdentifiers(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];

  // 1. URL: scheme://[userinfo@]host[:port][/path][?query][#frag]
  const urlMatch = trimmed.match(
    /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/(?:[^@/?#]*@)?([a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?)/,
  );
  if (urlMatch?.[1]) {
    return [urlMatch[1]];
  }

  // 2. host:port (e.g. "wrong-host.internal:5432", "cache-pod.svc:6379")
  const hostPortMatch = trimmed.match(
    /^([a-zA-Z](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?):\d+$/,
  );
  if (hostPortMatch?.[1]) {
    return [hostPortMatch[1]];
  }

  // 3. Bare dotted hostname (e.g. "wrong-host.internal", "svc.cluster.local")
  if (/^[a-zA-Z](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?\.[a-zA-Z][a-zA-Z0-9-]*$/.test(trimmed)) {
    return [trimmed];
  }

  return [];
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

    // env entries: literal values (network identifiers) and valueFrom references
    for (const ev of getArray(c['env'])) {
      if (!isRecord(ev)) continue;

      // Literal env value — extract hostnames/URLs (e.g. API_URL=https://api.example.com)
      const literalValue = getString(ev['value']);
      if (literalValue) {
        for (const id of extractNetworkIdentifiers(literalValue)) {
          ids.add(id);
        }
      }

      // valueFrom: reference to a Secret or ConfigMap key
      if (isRecord(ev['valueFrom'])) {
        const vf = ev['valueFrom'] as Record<string, unknown>;
        if (isRecord(vf['secretKeyRef'])) ids.add(getString(vf['secretKeyRef']['name']));
        if (isRecord(vf['configMapKeyRef'])) ids.add(getString(vf['configMapKeyRef']['name']));
      }
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

  // ConfigMap: index both keys and network-identifiable values.
  // Keys are useful for key-name matching; values (hostnames, URLs) surface
  // misconfigured endpoints so lexical search can correlate them with log errors.
  const raw = resource as unknown as Record<string, unknown>;
  if (resource.kind === 'ConfigMap' && isRecord(raw['data'])) {
    for (const [key, value] of Object.entries(raw['data'] as Record<string, unknown>)) {
      ids.add(key);
      if (typeof value === 'string') {
        for (const id of extractNetworkIdentifiers(value)) {
          ids.add(id);
        }
      }
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

  // Path-based: extract likely pod/container name from path segments.
  // Strip .log/.txt extensions from filename segments before adding so that
  // paths like `logs/app/app-pod.log` correctly yield `app-pod` as an
  // identifier rather than being silently dropped.
  const normalizedPath = path.replace(/\\/g, '/');
  const pathSegments = normalizedPath.split('/');
  for (const seg of pathSegments) {
    if (!seg || seg === 'logs') continue;
    let normalized = seg;
    if (normalized.endsWith('.log')) normalized = normalized.slice(0, -4);
    else if (normalized.endsWith('.txt')) normalized = normalized.slice(0, -4);
    if (normalized) ids.add(normalized);
  }

  // For real Troubleshoot bundle paths of the form
  // <prefix>/logs/<ns>/<pod>/<container>.log, explicitly add the pod name
  // (grandparent directory of the container log file) as a high-confidence
  // identifier.
  const grandparentMatch = normalizedPath.match(
    /(?:^|\/)logs\/[^/]+\/([^/]+)\/[^/]+\.(?:log|txt)$/,
  );
  if (grandparentMatch?.[1]) {
    ids.add(grandparentMatch[1]);
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
 * Extracts identifiers from a Helm release: release name, namespace, chart,
 * chart version, app version, and status.  The status (e.g. `failed`,
 * `deployed`, `pending-install`) is a high-signal diagnostic identifier.
 */
export function identifiersFromHelmRelease(release: HelmRelease): string[] {
  const ids = new Set<string>();

  ids.add(release.name);
  if (release.namespace) ids.add(release.namespace);
  if (release.chart) ids.add(release.chart);
  if (release.chartVersion) ids.add(release.chartVersion);
  if (release.appVersion) ids.add(release.appVersion);
  if (release.status) ids.add(release.status);

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

function augmentHelmReleaseChunk(release: HelmRelease, artifactId: string): IndexedChunk {
  const summary = summarizeHelmRelease(release);
  const identifiers = identifiersFromHelmRelease(release);
  const content = summary;
  const lines = content.split('\n');

  return {
    id: `helm-release:${release.namespace}:${release.name}`,
    artifactId,
    content,
    startLine: 1,
    endLine: lines.length,
    summary,
    identifiers,
    namespace: release.namespace,
    artifactCategory: 'helm-release',
    metadata: {
      path: artifactId,
      category: 'helm-release',
      name: release.name,
      namespace: release.namespace,
      chart: release.chart,
      chartVersion: release.chartVersion,
      status: release.status,
    },
  };
}

/**
 * Truncates `text` to at most `maxChars` characters, appending `"..."` when
 * truncated.  Returns the full text unchanged when it fits within the limit.
 */
function truncateContent(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '...';
}

function augmentLogChunk(chunk: Chunk): IndexedChunk {
  const path = getChunkPath(chunk);
  const identifiers = identifiersFromLogContent(chunk.content, path);

  // Try to extract a timestamp from the first line of the chunk
  const firstLine = chunk.content.split('\n')[0] ?? '';
  const ts = extractTimestamps(firstLine);

  // Build a meaningful summary that includes actual log content so that
  // semantic embeddings can match on log content rather than on the bare
  // file-path description.  ~500 tokens ≈ 2 000 characters at 4 chars/token.
  const MAX_SUMMARY_CHARS = 2000;
  const prefix = `Log chunk from ${path} (lines ${chunk.startLine}–${chunk.endLine})`;

  const chunkType = isRecord(chunk.metadata)
    ? (chunk.metadata['chunkType'] as string | undefined)
    : undefined;

  let body: string;
  if (chunkType === 'error-cluster') {
    // For error-cluster chunks, prioritise error/fatal lines so they appear at
    // the start of the summary and are captured within any token truncation.
    const contentLines = chunk.content.split('\n');
    const errorLines = contentLines.filter((l) => /\b(ERROR|FATAL)\b/i.test(l));
    const otherLines = contentLines.filter((l) => !/\b(ERROR|FATAL)\b/i.test(l));
    // Put error lines first, then the rest, then truncate the whole thing.
    body = truncateContent([...errorLines, ...otherLines].join('\n'), MAX_SUMMARY_CHARS);
  } else {
    body = truncateContent(chunk.content, MAX_SUMMARY_CHARS);
  }

  const summary = body ? `${prefix}:\n${body}` : prefix;

  return {
    ...chunk,
    summary,
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
    // Use the actual source file path when available (populated by the pipeline
    // from the bundle manifest). Fall back to a constructed path for tests /
    // contexts that do not supply source-file tracking.
    const fallbackPath = `cluster-resources/${resource.kind.toLowerCase()}/${ns}/${resource.metadata.name}.json`;
    const resourcePath = context.resourceSourceFiles?.get(resource) ?? fallbackPath;
    const baseChunk = chunkResource(resource, resourcePath);
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
    const baseChunks = chunkLogFileErrorAware(logFile);
    for (const baseChunk of baseChunks) {
      chunks.push(augmentLogChunk(baseChunk));
    }
  }

  // ── Analyzer results ───────────────────────────────────────────────────────
  for (const result of context.analyzerResults) {
    const baseChunk = chunkAnalyzer(result);
    chunks.push(augmentAnalyzerChunk(baseChunk, result));
  }

  // ── Helm releases ──────────────────────────────────────────────────────────
  if (context.helmReleases) {
    for (const release of context.helmReleases) {
      // Use a deterministic artifact path derived from namespace and name so
      // the LLM can cite a stable, meaningful location.
      const artifactId = `helm/${release.namespace}/${release.name}`;
      chunks.push(augmentHelmReleaseChunk(release, artifactId));
    }
  }

  // ── Contextual retrieval — prepend context prefix to each chunk ────────────
  // Derive a DocumentContext from each chunk's metadata and produce a new
  // array where every chunk has a `contextualizedContent` field.  The raw
  // `content` is preserved unchanged; the embedding pipeline uses
  // `contextualizedContent` (see analyze.ts).
  const documents = chunks.map(buildDocumentContext);
  return contextualizeChunks(chunks, documents);
}
