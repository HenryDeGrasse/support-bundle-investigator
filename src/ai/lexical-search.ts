import type { IndexedChunk } from './chunk-indexer.js';

// ---------------------------------------------------------------------------
// Scoring weights
// ---------------------------------------------------------------------------

/** Identifier exact match (chunk.identifiers contains the query token). */
const WEIGHT_IDENTIFIER = 3.0;
/** Namespace match (query token equals chunk.namespace). */
const WEIGHT_NAMESPACE = 1.5;
/**
 * Fallback content weight used for substring-expansion matches whose indexed
 * term differs from the query token (so BM25 parameters cannot be resolved).
 * Kept at 1.0 to preserve pre-BM25 behaviour for those edge cases.
 */
const WEIGHT_CONTENT_FALLBACK = 1.0;

// ---------------------------------------------------------------------------
// BM25 parameters
// ---------------------------------------------------------------------------

/** BM25 term-frequency saturation parameter. */
const BM25_K1 = 1.2;
/** BM25 length-normalisation parameter. */
const BM25_B = 0.75;

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
 *
 * Also used in {@link getContentMatches} to suppress noisy substring
 * expansion: stop words that are short prefixes of longer K8s tokens
 * (e.g. `'secret'` → `'secretkeyref'`) are only matched exactly, not via
 * substring expansion.
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

/**
 * Stop-word set used **exclusively** by the RFC-1123 name extraction step
 * (step 4 of {@link extractQueryIdentifiers}).
 *
 * This is a strict subset of {@link K8S_STOP_WORDS}: the high-signal
 * diagnostic terms that double as searchable K8s identifiers —
 * `secret`, `service`, `configmap`, `missing`, `failed`, `failure`,
 * `unreachable` — are intentionally **absent** so that queries like
 * `"missing secret app-credentials"` correctly extract all three tokens
 * as identifier candidates rather than silently discarding the first two.
 *
 * {@link K8S_STOP_WORDS} (which retains those terms) is still consulted
 * inside {@link getContentMatches} to suppress noisy substring expansion
 * (e.g. preventing `'secret'` from matching `'secretkeyref'` in unrelated
 * resource JSON).
 */
const RFC1123_STOP_WORDS: ReadonlySet<string> = new Set([
  // English connectives
  'in', 'is', 'are', 'the', 'a', 'an', 'of', 'for', 'with', 'and', 'or',
  'not', 'has', 'have', 'been', 'being', 'to', 'from', 'on', 'at', 'by',
  'due', 'via',
  // K8s structural keywords (non-diagnostic)
  'pod', 'pods', 'log', 'logs', 'file', 'files', 'check', 'status', 'state',
  'phase', 'reason', 'message', 'type', 'name', 'namespace', 'container',
  'containers', 'image', 'images', 'event', 'events', 'resource', 'resources',
  'cluster', 'node', 'nodes', 'deployment', 'deployments',
  'running', 'pending',
  // Common severity / level words
  'high', 'low', 'medium', 'critical', 'severity', 'info', 'warn', 'error',
  'warning',
  // K8s lifecycle verbs (non-diagnostic)
  'restart', 'restarts', 'back', 'off', 'loop', 'crash', 'crashloop',
  'invalid', 'wrong',
  // NOTE: 'secret', 'secrets', 'service', 'services', 'configmap',
  // 'configmaps', 'missing', 'failed', 'failure', 'unreachable' are
  // intentionally OMITTED so they can be extracted as identifier candidates.
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

  // ── BM25 statistics (computed during build) ──────────────────────────────

  /** Total number of indexed chunks (N in BM25 literature). */
  private bm25N = 0;
  /** Average document length in content tokens across all chunks. */
  private bm25Avgdl = 1;
  /** term → number of chunks containing that term (document frequency). */
  private bm25Df = new Map<string, number>();
  /** Per-chunk content token counts (indexed parallel to `chunks`). */
  private bm25DocLengths: number[] = [];

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
    this.bm25DocLengths = [];

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

      // Tokenise once; reuse tokens for both doc-length tracking and indexing.
      const tokens = tokenizeContent(chunk.content);
      this.bm25DocLengths.push(tokens.length);

      const tokenCounts = new Map<string, number>();
      for (const token of tokens) {
        tokenCounts.set(token, (tokenCounts.get(token) ?? 0) + 1);
      }

      for (const [token, count] of tokenCounts) {
        addToCountIndex(this.contentIndex, token, i, count);
      }
    }

    // ── BM25 corpus statistics ────────────────────────────────────────────
    this.bm25N = chunks.length;
    const totalLen = this.bm25DocLengths.reduce((s, l) => s + l, 0);
    this.bm25Avgdl = this.bm25N > 0 ? totalLen / this.bm25N : 1;

    this.bm25Df.clear();
    for (const [term, posting] of this.contentIndex) {
      this.bm25Df.set(term, posting.size);
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
        bump(idx, this.bm25Score(token, idx, count), 'contentHits', count);
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
      if (!RFC1123_STOP_WORDS.has(token)) {
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
   *
   * Substring expansion is suppressed for tokens that are in
   * {@link K8S_STOP_WORDS}.  These are short, generic words that produce
   * excessive false-positive matches via substring expansion
   * (e.g. `'secret'` matching every resource that contains `'secretkeyref'`
   * or `'secretref'`).  Exact matches are still performed so that documents
   * which contain the literal word (e.g. an event message that says
   * `"secret app-credentials not found"`) are still surfaced.
   */
  private getContentMatches(queryToken: string): Map<number, number> {
    const matches = new Map<number, number>();

    const exact = this.contentIndex.get(queryToken);
    if (exact) {
      mergeCounts(matches, exact);
    }

    // Suppress noisy substring expansion for stop-word query tokens.
    if (K8S_STOP_WORDS.has(queryToken)) {
      return matches;
    }

    for (const [indexedToken, posting] of this.contentIndex) {
      if (indexedToken === queryToken) continue;
      if (!indexedToken.includes(queryToken)) continue;
      mergeCounts(matches, posting);
    }

    return matches;
  }

  /**
   * Computes the BM25 score contribution for a single query term matching a
   * specific chunk.
   *
   * Formula: `IDF(t) × (tf × (k1+1)) / (tf + k1 × (1 - b + b × |d|/avgdl))`
   * where `IDF(t) = ln((N - df + 0.5) / (df + 0.5) + 1)`.
   *
   * If `queryToken` is not in the vocabulary (i.e. it matched via substring
   * expansion and has no direct IDF entry), falls back to
   * {@link WEIGHT_CONTENT_FALLBACK} × `tf` to preserve pre-BM25 behaviour
   * for those edge cases.
   */
  private bm25Score(queryToken: string, chunkIdx: number, tf: number): number {
    const df = this.bm25Df.get(queryToken);
    if (df === undefined) {
      // Substring-expansion match: query token not directly in index.
      return WEIGHT_CONTENT_FALLBACK * tf;
    }

    const N = this.bm25N;
    if (N === 0) return 0;

    const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
    const dl = this.bm25DocLengths[chunkIdx] ?? 1;
    const avgdl = this.bm25Avgdl;
    const tfNorm =
      (tf * (BM25_K1 + 1)) /
      (tf + BM25_K1 * (1 - BM25_B + BM25_B * (dl / avgdl)));
    return idf * tfNorm;
  }
}
