// ---------------------------------------------------------------------------
// Contextual Retrieval
// ---------------------------------------------------------------------------
//
// Prepends a short, template-generated context sentence to each chunk's
// content before embedding.  This is a V1 template-based implementation —
// no LLM call is required.  A future V2 can replace `generateChunkContext`
// with a local-LLM-powered context generator.
//
// Reference: Anthropic (2024) — contextual retrieval reduced top-20 failure
// by 49% by prepending a short context sentence to each chunk before embedding.
//
// Implementation:
// - `generateChunkContext(document, chunkContent)` → a short context sentence
//   based on the document category and content heuristics.
// - `buildDocumentContext(chunk)` → derives a DocumentContext from chunk
//   metadata.
// - `contextualizeChunks(chunks, documents)` → parallel-maps each chunk to a
//   new IndexedChunk with `contextualizedContent = contextPrefix\n\ncontent`.
//
// The raw `content` field is never mutated.  Both raw and contextualized
// content are stored on the returned chunk objects.

import type { ArtifactCategory } from '../types/index.js';
import type { IndexedChunk } from './chunk-indexer.js';

// ---------------------------------------------------------------------------
// DocumentContext
// ---------------------------------------------------------------------------

/**
 * Metadata about the source document from which a chunk was extracted.
 *
 * Used by {@link generateChunkContext} to produce a context sentence that
 * describes where the chunk comes from and what it is about.  All fields are
 * optional; the generator falls back to generic descriptions when fields are
 * absent.
 */
export interface DocumentContext {
  /** Artifact category of the source document. */
  category: ArtifactCategory;
  /** Kubernetes resource kind (e.g. `"Pod"`, `"ConfigMap"`, `"Deployment"`). */
  kind?: string;
  /** Name of the resource, object, or analyzer. */
  name?: string;
  /** Kubernetes namespace. */
  namespace?: string;
  /** File path — used for log chunks. */
  path?: string;
  /** K8s event reason (e.g. `"BackOff"`, `"FailedMount"`). */
  reason?: string;
  /** Analyzer severity (e.g. `"error"`, `"warn"`, `"pass"`). */
  severity?: string;
  /** Chunk start line (1-based). */
  startLine?: number;
  /** Chunk end line (inclusive, 1-based). */
  endLine?: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Heuristically detects the primary content type of a text string for use in
 * context sentences.
 *
 * For log content, checks for error/warning/info keywords.
 * For K8s resource content, checks for common structural keywords.
 */
function detectContentType(content: string, category: ArtifactCategory): string {
  if (category === 'log') {
    if (/\b(FATAL|ERROR)\b/i.test(content)) return 'error log output';
    if (/\bWARN(ING)?\b/i.test(content)) return 'warning log output';
    return 'informational log output';
  }

  if (category === 'kubernetes-resource') {
    if (/\benv\b|\benvironment\b|\benvFrom\b/i.test(content)) {
      return 'container environment variables and references';
    }
    if (/\bcontainer\b|\bimage\b/i.test(content)) {
      return 'container specifications';
    }
    if (/\bsecret\b|\bconfigmap\b|\bvolume\b/i.test(content)) {
      return 'configuration and volume references';
    }
    return 'resource specification';
  }

  return 'diagnostic content';
}

// ---------------------------------------------------------------------------
// generateChunkContext
// ---------------------------------------------------------------------------

/**
 * Generates a short context sentence describing where a chunk comes from and
 * what it contains.
 *
 * The sentence is prepended to the chunk content before embedding so that the
 * vector representation encodes the chunk's source context, not just its
 * isolated text.
 *
 * Context sentences are template-based (no LLM required) and follow this
 * format pattern:
 * ```
 * "This chunk is from the Pod spec for app-pod in namespace default. It describes container environment variables."
 * "This chunk is from the log file pods/logs/default/app-pod/app.log (lines 145–195). It contains error log output."
 * "This chunk is from the analyzer result pod-status-check. It reports error status."
 * ```
 *
 * @param document     - Metadata describing the source document.
 * @param chunkContent - The raw chunk content (used for content-type heuristics).
 * @returns A short, single-sentence or two-sentence context string.
 */
export function generateChunkContext(
  document: DocumentContext,
  chunkContent: string,
): string {
  const { category, kind, name, namespace, path, reason, severity, startLine, endLine } = document;

  switch (category) {
    case 'kubernetes-resource': {
      const resourceKind = kind ?? 'Resource';
      const resourceName = name ?? 'unknown';
      const nsPart = namespace ? ` in namespace ${namespace}` : '';
      const contentType = detectContentType(chunkContent, category);
      return (
        `This chunk is from the ${resourceKind} spec for ${resourceName}${nsPart}.` +
        ` It describes ${contentType}.`
      );
    }

    case 'event': {
      const objectName = name ?? 'unknown';
      const nsPart = namespace ? ` in namespace ${namespace}` : '';
      const reasonPart = reason ? `. Reason: ${reason}` : '';
      return `This chunk is from a Kubernetes event on ${objectName}${nsPart}${reasonPart}.`;
    }

    case 'log': {
      const filePath = path ?? 'unknown';
      const lineRangePart =
        startLine !== undefined && endLine !== undefined
          ? ` (lines ${startLine}–${endLine})`
          : '';
      const contentType = detectContentType(chunkContent, category);
      return (
        `This chunk is from the log file ${filePath}${lineRangePart}.` +
        ` It contains ${contentType}.`
      );
    }

    case 'analyzer': {
      const analyzerName = name ?? 'unknown';
      const severityPart = severity ? ` ${severity}` : '';
      return `This chunk is from the analyzer result ${analyzerName}. It reports${severityPart} status.`;
    }

    case 'helm-release': {
      const releaseName = name ?? 'unknown';
      const nsPart = namespace ? ` in namespace ${namespace}` : '';
      return `This chunk is from the Helm release ${releaseName}${nsPart}. It describes the chart deployment status.`;
    }

    default: {
      // Generic fallback for unknown or future categories
      const resourceName = name ?? path ?? 'unknown';
      return `This chunk is from ${resourceName}. It contains diagnostic information.`;
    }
  }
}

// ---------------------------------------------------------------------------
// buildDocumentContext
// ---------------------------------------------------------------------------

/**
 * Derives a {@link DocumentContext} from an {@link IndexedChunk}'s metadata.
 *
 * This is a convenience helper used by {@link contextualizeChunks} callers who
 * want to derive context automatically rather than constructing
 * `DocumentContext` objects by hand.  It is also used internally by
 * {@link buildChunkIndex} after all chunks are created.
 *
 * Field extraction strategy:
 * - `category` → `chunk.artifactCategory`
 * - `kind` → `chunk.metadata.kind` (string)
 * - `name` → `chunk.metadata.name` (string)
 * - `namespace` → `chunk.namespace`
 * - `path` → `chunk.metadata.path` || `chunk.artifactId`
 * - `reason` → `chunk.metadata.reason` (string, for events)
 * - `severity` → `chunk.metadata.severity` (string, for analyzers)
 * - `startLine` / `endLine` → `chunk.startLine` / `chunk.endLine`
 */
export function buildDocumentContext(chunk: IndexedChunk): DocumentContext {
  const meta = (
    chunk.metadata !== null && typeof chunk.metadata === 'object' && !Array.isArray(chunk.metadata)
      ? chunk.metadata
      : {}
  ) as Record<string, unknown>;

  const getString = (key: string): string | undefined => {
    const v = meta[key];
    return typeof v === 'string' && v.length > 0 ? v : undefined;
  };

  const ctx: DocumentContext = {
    category: chunk.artifactCategory,
    namespace: chunk.namespace,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
  };

  switch (chunk.artifactCategory) {
    case 'kubernetes-resource':
      ctx.kind = getString('kind');
      ctx.name = getString('name');
      break;

    case 'event':
      ctx.name = getString('name');
      ctx.reason = getString('reason');
      break;

    case 'log':
      // Prefer metadata.path; fall back to artifactId
      ctx.path = getString('path') ?? chunk.artifactId;
      break;

    case 'analyzer':
      ctx.name = getString('name');
      ctx.severity = getString('severity');
      break;

    case 'helm-release':
      ctx.name = getString('name');
      break;

    default:
      ctx.name = getString('name');
      ctx.path = getString('path') ?? chunk.artifactId;
      break;
  }

  return ctx;
}

// ---------------------------------------------------------------------------
// contextualizeChunks
// ---------------------------------------------------------------------------

/**
 * Prepends a template-generated context sentence to each chunk's content,
 * storing the result in the `contextualizedContent` field.
 *
 * Rules:
 * - `chunks` and `documents` must be parallel arrays (same length).
 * - For each pair, `generateChunkContext(document, chunk.content)` produces
 *   the context prefix.
 * - `contextualizedContent = contextPrefix + "\n\n" + chunk.content`.
 * - The original `content` field is **never mutated** — callers can always
 *   access the raw chunk text.
 * - Original chunk objects are never mutated — new objects are returned via
 *   spread.
 *
 * Usage inside the embedding pipeline:
 * ```typescript
 * const textsToEmbed = chunks.map((c) => c.contextualizedContent ?? c.content);
 * const embeddings = await embeddingClient.embed(textsToEmbed);
 * ```
 *
 * @param chunks    - Indexed chunks to contextualize.
 * @param documents - Parallel array of document contexts, one per chunk.
 * @returns New array of chunks, each augmented with `contextualizedContent`.
 */
export function contextualizeChunks(
  chunks: IndexedChunk[],
  documents: DocumentContext[],
): IndexedChunk[] {
  const len = Math.min(chunks.length, documents.length);
  const result: IndexedChunk[] = [];

  for (let i = 0; i < len; i++) {
    const chunk = chunks[i]!;
    const doc = documents[i]!;
    const contextPrefix = generateChunkContext(doc, chunk.content);
    const contextualizedContent = `${contextPrefix}\n\n${chunk.content}`;

    result.push({
      ...chunk,
      contextualizedContent,
    });
  }

  return result;
}
