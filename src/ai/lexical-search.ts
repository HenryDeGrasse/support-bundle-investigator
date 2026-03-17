import type { IndexedChunk } from './chunk-indexer.js';

// ---------------------------------------------------------------------------
// Scoring weights
// ---------------------------------------------------------------------------

/** Identifier exact match (chunk.identifiers contains the query token). */
const WEIGHT_IDENTIFIER = 3.0;
/** Namespace match (query token equals chunk.namespace). */
const WEIGHT_NAMESPACE = 1.5;
/** Content token match (query token appears in chunk.content). */
const WEIGHT_CONTENT = 1.0;

/** Minimum token length for content indexing and querying. */
const MIN_TOKEN_LEN = 2;

// ---------------------------------------------------------------------------
// K8s domain constants
// ---------------------------------------------------------------------------

/**
 * Well-known Kubernetes error reason strings that are extracted from
 * hypothesis text. These use canonical K8s casing in returned identifiers.
 */
const K8S_ERROR_REASONS: readonly string[] = [
  'CrashLoopBackOff',
  'ImagePullBackOff',
  'ErrImagePull',
  'OOMKilled',
  'ContainerCannotRun',
  'DeadlineExceeded',
  'Evicted',
  'BackOff',
  'ContainersNotReady',
  'Unschedulable',
  'RunContainerError',
  'CreateContainerError',
  'InvalidImageName',
  'CreateContainerConfigError',
  'FailedScheduling',
  'FailedMount',
  'FailedAttachVolume',
  'NodeNotReady',
];

const K8S_ERROR_REASONS_LOWER = new Map(
  K8S_ERROR_REASONS.map((reason) => [reason.toLowerCase(), reason]),
);

/**
 * Common English and K8s-context words that appear in hypothesis strings but
 * are NOT Kubernetes resource identifiers. Filters these from
 * `extractQueryIdentifiers` so they don't add noise to identifier lookups.
 */
const K8S_STOP_WORDS: ReadonlySet<string> = new Set([
  // English connectives
  'in', 'is', 'are', 'the', 'a', 'an', 'of', 'for', 'with', 'and', 'or',
  'not', 'has', 'have', 'been', 'being', 'to', 'from', 'on', 'at', 'by',
  'due', 'via',
  // K8s structural keywords
  'pod', 'pods', 'log', 'logs', 'file', 'files', 'check', 'status', 'state',
  'phase', 'reason', 'message', 'type', 'name', 'namespace', 'container',
  'containers', 'image', 'images', 'event', 'events', 'resource', 'resources',
  'cluster', 'node', 'nodes', 'service', 'services', 'deployment', 'deployments',
  'secret', 'secrets', 'configmap', 'configmaps', 'running', 'pending',
  // Common severity / level words
  'high', 'low', 'medium', 'critical', 'severity', 'info', 'warn', 'error',
  'warning', 'failed', 'failure',
  // K8s lifecycle verbs used in hypothesis text
  'restart', 'restarts', 'back', 'off', 'loop', 'crash', 'crashloop',
  'missing', 'invalid', 'wrong', 'unreachable',
]);

// ---------------------------------------------------------------------------
// ScoredChunk
// ---------------------------------------------------------------------------

/**
 * An {@link IndexedChunk} paired with a lexical relevance score.
 */
export interface ScoredChunk {
  chunk: IndexedChunk;
  score: number;
}

interface ChunkScore {
  score: number;
  identifierHits: number;
  namespaceHits: number;
  contentHits: number;
}

// ---------------------------------------------------------------------------
// Tokenization
// ---------------------------------------------------------------------------

/**
 * Tokenizes `text` into lowercase tokens for content indexing and querying.
 *
 * Splitting strategy:
 * - Split on whitespace and non-alphanumeric characters, preserving hyphens so
 *   K8s resource names like `my-pod` remain intact.
 * - Strip leading/trailing hyphens from each token.
 * - Filter tokens shorter than `MIN_TOKEN_LEN`.
 */
function tokenizeContent(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\w-]+/)
    .map((t) => t.replace(/^-+|-+$/g, ''))
    .filter((t) => t.length >= MIN_TOKEN_LEN);
}

// ---------------------------------------------------------------------------
// Index helpers
// ---------------------------------------------------------------------------

function addToIndex(
  index: Map<string, Set<number>>,
  key: string,
  chunkIdx: number,
): void {
  let set = index.get(key);
  if (!set) {
    set = new Set<number>();
    index.set(key, set);
  }
  set.add(chunkIdx);
}

function addToCountIndex(
  index: Map<string, Map<number, number>>,
  key: string,
  chunkIdx: number,
  count: number,
): void {
  let posting = index.get(key);
  if (!posting) {
    posting = new Map<number, number>();
    index.set(key, posting);
  }
  posting.set(chunkIdx, (posting.get(chunkIdx) ?? 0) + count);
}

function mergeCounts(
  into: Map<number, number>,
  from: Map<number, number>,
): void {
  for (const [chunkIdx, count] of from) {
    into.set(chunkIdx, (into.get(chunkIdx) ?? 0) + count);
  }
}

function compareScores(
  a: [number, ChunkScore],
  b: [number, ChunkScore],
  chunks: readonly IndexedChunk[],
): number {
  if (b[1].score !== a[1].score) return b[1].score - a[1].score;
  if (b[1].identifierHits !== a[1].identifierHits) {
    return b[1].identifierHits - a[1].identifierHits;
  }
  if (b[1].namespaceHits !== a[1].namespaceHits) {
    return b[1].namespaceHits - a[1].namespaceHits;
  }
  if (b[1].contentHits !== a[1].contentHits) {
    return b[1].contentHits - a[1].contentHits;
  }
  return chunks[a[0]]!.id.localeCompare(chunks[b[0]]!.id);
}

// ---------------------------------------------------------------------------
// LexicalSearchIndex
// ---------------------------------------------------------------------------

/**
 * Inverted-index lexical search over {@link IndexedChunk} arrays.
 *
 * ### Scoring model
 *
 * | Match type       | Weight |
 * |------------------|--------|
 * | Identifier exact | 3.0    |
 * | Namespace match  | 1.5    |
 * | Content token    | 1.0    |
 *
 * Identifier matching is O(1) per extracted query identifier. Content matching
 * uses exact token lookup first, then deterministic substring expansion over
 * the indexed vocabulary so partial terms like `auth` can still surface
 * `authentication` log chunks.
 */
export class LexicalSearchIndex {
  /** All indexed chunks in insertion order. */
  private chunks: IndexedChunk[] = [];

  /** identifier (lowercased) → set of chunk array indices. */
  private identifierIndex = new Map<string, Set<number>>();

  /** namespace (lowercased) → set of chunk array indices. */
  private namespaceIndex = new Map<string, Set<number>>();

  /** content token → (chunk array index → token frequency in that chunk). */
  private contentIndex = new Map<string, Map<number, number>>();

  // ── build ────────────────────────────────────────────────────────────────

  /**
   * Builds the inverted index from a flat array of {@link IndexedChunk}s.
   *
   * - Each chunk's `identifiers[]` are indexed for O(1) exact lookup.
   * - Each chunk's `namespace` is indexed for namespace-scoped boosting.
   * - Each chunk's `content` is tokenised and indexed with per-chunk term
   *   counts for lexical matching.
   *
   * Calling `build` again replaces the existing index.
   */
  build(chunks: IndexedChunk[]): void {
    this.chunks = [...chunks];
    this.identifierIndex.clear();
    this.namespaceIndex.clear();
    this.contentIndex.clear();

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;

      for (const id of chunk.identifiers) {
        const normalized = id.trim().toLowerCase();
        if (normalized.length > 0) {
          addToIndex(this.identifierIndex, normalized, i);
        }
      }

      if (chunk.namespace) {
        addToIndex(this.namespaceIndex, chunk.namespace.toLowerCase(), i);
      }

      const tokenCounts = new Map<string, number>();
      for (const token of tokenizeContent(chunk.content)) {
        tokenCounts.set(token, (tokenCounts.get(token) ?? 0) + 1);
      }

      for (const [token, count] of tokenCounts) {
        addToCountIndex(this.contentIndex, token, i, count);
      }
    }
  }

  // ── search ───────────────────────────────────────────────────────────────

  /**
   * Returns the top-`topK` chunks most relevant to `query`, sorted by
   * descending relevance.
   *
   * Scoring accumulates across three passes:
   * 1. **Identifier pass** (weight 3.0): extract K8s identifiers from `query`
   *    via {@link extractQueryIdentifiers}, then look them up exactly.
   * 2. **Namespace pass** (weight 1.5): tokenise `query`, match tokens against
   *    the namespace index.
   * 3. **Content pass** (weight 1.0): match query tokens against content terms,
   *    including deterministic substring expansion for partial-token lookup.
   *
   * Ties are broken deterministically in favor of stronger signal classes:
   * identifier hits > namespace hits > content hits > chunk id.
   */
  search(query: string, topK: number): ScoredChunk[] {
    if (this.chunks.length === 0 || topK <= 0) return [];

    const scores = new Map<number, ChunkScore>();

    const bump = (
      idx: number,
      delta: number,
      field: 'identifierHits' | 'namespaceHits' | 'contentHits',
      hits = 1,
    ): void => {
      const current = scores.get(idx) ?? {
        score: 0,
        identifierHits: 0,
        namespaceHits: 0,
        contentHits: 0,
      };
      current.score += delta;
      current[field] += hits;
      scores.set(idx, current);
    };

    const queryIds = this.extractQueryIdentifiers(query);
    const queryTokens = tokenizeContent(query);

    for (const id of queryIds) {
      for (const idx of this.identifierIndex.get(id.toLowerCase()) ?? []) {
        bump(idx, WEIGHT_IDENTIFIER, 'identifierHits');
      }
    }

    for (const token of queryTokens) {
      for (const idx of this.namespaceIndex.get(token) ?? []) {
        bump(idx, WEIGHT_NAMESPACE, 'namespaceHits');
      }
    }

    for (const token of queryTokens) {
      for (const [idx, count] of this.getContentMatches(token)) {
        bump(idx, WEIGHT_CONTENT * count, 'contentHits', count);
      }
    }

    return [...scores.entries()]
      .filter(([, details]) => details.score > 0)
      .sort((a, b) => compareScores(a, b, this.chunks))
      .slice(0, topK)
      .map(([idx, details]) => ({ chunk: this.chunks[idx]!, score: details.score }));
  }

  // ── extractQueryIdentifiers ──────────────────────────────────────────────

  /**
   * Parses K8s identifiers from a free-text hypothesis string.
   *
   * Extraction pipeline:
   * 1. **Known error reasons** — matched case-insensitively and returned with
   *    canonical K8s casing.
   * 2. **Image references** — patterns like `nginx:1.19` or `repo/app:v2.0.0`.
   * 3. **Standalone image tags** — patterns like `1.19.0` or `v2.0.0`.
   * 4. **RFC-1123 resource names** — lowercase tokens of 2–63 chars matching
   *    `[a-z][a-z0-9-]+`, filtered through {@link K8S_STOP_WORDS}.
   *
   * Returns a deduplicated array.
   */
  extractQueryIdentifiers(hypothesis: string): string[] {
    const ids = new Set<string>();
    const lowerHypothesis = hypothesis.toLowerCase();

    for (const [lowerReason, canonicalReason] of K8S_ERROR_REASONS_LOWER) {
      if (lowerHypothesis.includes(lowerReason)) {
        ids.add(canonicalReason);
      }
    }

    const imagePattern = /\b[a-zA-Z0-9][a-zA-Z0-9._/-]*:[a-zA-Z0-9._-]+\b/g;
    for (const match of hypothesis.matchAll(imagePattern)) {
      ids.add(match[0]!);
    }

    const imageTagPattern = /\b(v?\d+(?:\.\d+){1,3}(?:[-._][a-zA-Z0-9]+)*)\b/g;
    for (const match of hypothesis.matchAll(imageTagPattern)) {
      ids.add(match[1]!);
    }

    const k8sNamePattern = /\b([a-z][a-z0-9-]{1,62})\b/g;
    for (const match of hypothesis.matchAll(k8sNamePattern)) {
      const token = match[1]!;
      if (!K8S_STOP_WORDS.has(token)) {
        ids.add(token);
      }
    }

    return [...ids];
  }

  // ── internal helpers ─────────────────────────────────────────────────────

  /**
   * Returns content token matches for `queryToken`.
   *
   * Exact matches are used first. When the query token is only a partial term,
   * the search deterministically expands to indexed tokens that contain the
   * query token as a substring (e.g. `auth` → `authentication`).
   */
  private getContentMatches(queryToken: string): Map<number, number> {
    const matches = new Map<number, number>();

    const exact = this.contentIndex.get(queryToken);
    if (exact) {
      mergeCounts(matches, exact);
    }

    for (const [indexedToken, posting] of this.contentIndex) {
      if (indexedToken === queryToken) continue;
      if (!indexedToken.includes(queryToken)) continue;
      mergeCounts(matches, posting);
    }

    return matches;
  }
}
