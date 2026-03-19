// ---------------------------------------------------------------------------
// Late Chunking Infrastructure
// ---------------------------------------------------------------------------
//
// Implements late chunking: embed the full document at token level via the
// TEI `/embed_all` endpoint, then slice and average-pool the token-level
// embedding tensor at chunk boundaries.
//
// Each chunk embedding retains full-document context — the error chunk at
// line 3000 "knows" about DB_HOST=db.internal from line 12 because the
// transformer's attention saw it during the forward pass.
//
// Three public functions:
//   mapChunkBoundariesToTokenPositions  — line-range boundaries → token index ranges
//   averagePoolSlice                    — average-pool a token tensor slice
//   lateChunkEmbed                      — full orchestration; transparent fallback
//
// Graceful degradation: when the TEI token-level endpoint is unavailable,
// lateChunkEmbed transparently delegates to standard per-chunk embedding via
// the client's embed() method (no context-awareness, but always available).

import type { EmbeddingClientInterface } from './embeddings.js';

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/**
 * A chunk boundary expressed as a closed line-number range (1-indexed).
 *
 * Line numbers are 1-indexed and inclusive on both ends, matching the
 * `startLine`/`endLine` fields on `Chunk` objects produced by error-aware
 * chunking.
 */
export interface ChunkBoundary {
  /** First line of the chunk (1-indexed, inclusive). */
  startLine: number;
  /** Last line of the chunk (1-indexed, inclusive). */
  endLine: number;
}

/**
 * A token index range (0-indexed, inclusive on both ends).
 *
 * Used to address slices within the token-level embedding tensor returned by
 * the TEI `/embed_all` endpoint.
 */
export interface TokenRange {
  /** First token in the range (0-indexed, inclusive). */
  startToken: number;
  /** Last token in the range (0-indexed, inclusive). */
  endToken: number;
}

/**
 * Embedding client that supports token-level output (TEI) in addition to the
 * standard pooled-embedding interface.
 *
 * Extends {@link EmbeddingClientInterface} with an optional token-level
 * endpoint.  Implementations must honour the same graceful-degradation
 * contract: failures return `null` / empty arrays rather than throwing.
 *
 * {@link LocalEmbeddingClient} implements this interface by adding
 * `embedTokenLevel` on top of the standard `embed` and `embedSingle` methods.
 */
export interface LateChunkEmbeddingClient extends EmbeddingClientInterface {
  /**
   * Embed a single document and return one vector per token.
   *
   * Calls the TEI `/embed_all` endpoint which returns a 2-D array of shape
   * `[num_tokens, dim]`.  Returns `null` when TEI is unavailable or the
   * endpoint is not supported, signalling the caller to fall back to standard
   * per-chunk embedding.
   *
   * @param text - Full document text (TEI handles 131K+ token contexts).
   * @returns A 2-D array of shape `[num_tokens, dim]`, or `null` on failure.
   */
  embedTokenLevel(text: string): Promise<number[][] | null>;
}

// ---------------------------------------------------------------------------
// mapChunkBoundariesToTokenPositions
// ---------------------------------------------------------------------------

/**
 * Maps line-range chunk boundaries to token index ranges.
 *
 * Because we do not have direct access to the model's tokenizer, token
 * positions are **estimated proportionally from character offsets**.  Each
 * line contributes `line.length + 1` characters (the `+1` accounts for the
 * newline separator).  The character fraction of each chunk is then scaled to
 * the known `numTokens` count returned by the TEI endpoint.
 *
 * This is an approximation: actual boundaries depend on the tokenizer's
 * vocabulary and byte-pair encoding.  For error-aware chunking — where chunk
 * boundaries are line-aligned and chunks span multiple lines — the proportional
 * estimate is accurate enough for average-pooled embeddings.
 *
 * @param documentLines - All document lines in order (without trailing newlines).
 * @param boundaries    - Chunk boundaries in 1-indexed line numbers.
 * @param numTokens     - Total token count returned by the TEI endpoint.
 * @returns A parallel array of {@link TokenRange} objects (same length and
 *   order as `boundaries`).
 */
export function mapChunkBoundariesToTokenPositions(
  documentLines: string[],
  boundaries: ChunkBoundary[],
  numTokens: number,
): TokenRange[] {
  // Early exit: no lines or no tokens → every boundary maps to token 0
  if (documentLines.length === 0 || numTokens === 0) {
    return boundaries.map(() => ({ startToken: 0, endToken: 0 }));
  }

  // Each line contributes (line.length + 1) chars to account for the newline.
  const lineCharLengths = documentLines.map((l) => l.length + 1);
  const totalChars = lineCharLengths.reduce((sum, len) => sum + len, 0);

  if (totalChars === 0) {
    return boundaries.map(() => ({ startToken: 0, endToken: 0 }));
  }

  // cumulativeOffset[i] = character offset at the start of line i (0-indexed).
  // cumulativeOffset[documentLines.length] = totalChars.
  const cumulativeOffset: number[] = new Array(documentLines.length + 1).fill(0) as number[];
  for (let i = 0; i < documentLines.length; i++) {
    cumulativeOffset[i + 1] = cumulativeOffset[i]! + lineCharLengths[i]!;
  }

  return boundaries.map(({ startLine, endLine }) => {
    // Convert 1-indexed line numbers to 0-indexed array positions, clamped.
    const startIdx = Math.max(0, Math.min(startLine - 1, documentLines.length - 1));
    const endIdx = Math.max(0, Math.min(endLine - 1, documentLines.length - 1));

    const charStart = cumulativeOffset[startIdx]!;
    // charEnd is exclusive (the character position immediately after the last
    // character of the last line in this chunk, i.e. start of the next line).
    const charEnd = cumulativeOffset[endIdx + 1]!;

    const startToken = Math.floor((charStart / totalChars) * numTokens);
    const rawEndToken = Math.ceil((charEnd / totalChars) * numTokens) - 1;
    const endToken = Math.min(rawEndToken, numTokens - 1);

    return {
      startToken: Math.max(0, startToken),
      // Guarantee startToken ≤ endToken even in degenerate cases.
      endToken: Math.max(Math.max(0, startToken), endToken),
    };
  });
}

// ---------------------------------------------------------------------------
// averagePoolSlice
// ---------------------------------------------------------------------------

/**
 * Average-pools a slice of a token-level embedding tensor.
 *
 * Given the full `[num_tokens, dim]` token embedding matrix and an inclusive
 * `[startToken, endToken]` index range, returns the element-wise mean vector
 * over that slice.
 *
 * This is the standard late-chunking pooling operation: each chunk's final
 * embedding is the mean of the per-token embeddings within its boundary,
 * preserving global context from the full-document forward pass.
 *
 * Indices are clamped to `[0, tokenEmbeddings.length - 1]` so callers do not
 * need to guard against off-by-one errors from the proportional mapping.
 *
 * @param tokenEmbeddings - 2-D array of shape `[num_tokens, dim]`.
 * @param startToken      - First token to include (0-indexed, clamped to valid range).
 * @param endToken        - Last token to include (0-indexed, clamped to valid range).
 * @returns Mean vector of length `dim`, or an empty array if the matrix is empty.
 */
export function averagePoolSlice(
  tokenEmbeddings: number[][],
  startToken: number,
  endToken: number,
): number[] {
  if (tokenEmbeddings.length === 0) return [];

  const maxIdx = tokenEmbeddings.length - 1;
  const clampedStart = Math.max(0, Math.min(startToken, maxIdx));
  // endToken must be ≥ clampedStart after clamping so that we always pool at
  // least the single token at clampedStart.
  const clampedEnd = Math.max(clampedStart, Math.min(endToken, maxIdx));

  const slice = tokenEmbeddings.slice(clampedStart, clampedEnd + 1);
  if (slice.length === 0 || !slice[0] || slice[0].length === 0) return [];

  const dim = slice[0].length;
  const pooled: number[] = new Array(dim).fill(0) as number[];

  for (const vec of slice) {
    for (let i = 0; i < dim; i++) {
      pooled[i]! += vec[i] ?? 0;
    }
  }

  const count = slice.length;
  return pooled.map((v) => v / count);
}

// ---------------------------------------------------------------------------
// lateChunkEmbed
// ---------------------------------------------------------------------------

/**
 * Orchestrates late chunking for a multi-chunk document.
 *
 * **TEI happy path:**
 * 1. Sends the full document to the TEI `/embed_all` token-level endpoint via
 *    `client.embedTokenLevel()`.
 * 2. Maps each chunk's line-range boundary to a token index range using
 *    {@link mapChunkBoundariesToTokenPositions}.
 * 3. Average-pools the token embedding slice for each chunk via
 *    {@link averagePoolSlice}.
 *
 * Each resulting chunk embedding encodes the full-document context: the error
 * cluster at line 3000 implicitly encodes `DB_HOST=db.internal` from line 12
 * because the transformer's attention saw the entire document.
 *
 * **Fallback (TEI unavailable):**
 * When `client.embedTokenLevel()` returns `null` or an empty array, falls back
 * to standard per-chunk embedding: each chunk's text is extracted from
 * `documentLines` using its boundary and embedded independently via
 * `client.embed()`.  This loses cross-chunk context but always works.
 *
 * The fallback is transparent to callers: the return signature is identical
 * regardless of which path was taken.
 *
 * @param client        - Client implementing {@link LateChunkEmbeddingClient}.
 * @param document      - Full document text (passed directly to TEI).
 * @param documentLines - Document split into lines (used for boundary mapping
 *                        and fallback text extraction).
 * @param boundaries    - Chunk boundaries in 1-indexed line numbers (e.g. from
 *                        `chunkLogFileErrorAware`).
 * @returns One embedding vector per entry in `boundaries`, in the same order.
 *   Returns `[]` immediately when `boundaries` is empty.
 */
export async function lateChunkEmbed(
  client: LateChunkEmbeddingClient,
  document: string,
  documentLines: string[],
  boundaries: ChunkBoundary[],
): Promise<number[][]> {
  if (boundaries.length === 0) return [];

  // ── Try TEI token-level embedding ────────────────────────────────────────
  const tokenEmbeddings = await client.embedTokenLevel(document);

  if (tokenEmbeddings !== null && tokenEmbeddings.length > 0) {
    // Map each chunk's line range to a token index range.
    const tokenRanges = mapChunkBoundariesToTokenPositions(
      documentLines,
      boundaries,
      tokenEmbeddings.length,
    );

    // Average-pool each token slice → one embedding vector per chunk.
    return tokenRanges.map(({ startToken, endToken }) =>
      averagePoolSlice(tokenEmbeddings, startToken, endToken),
    );
  }

  // ── Fallback: standard per-chunk embedding ────────────────────────────────
  //
  // Extract the text for each chunk from documentLines using its boundary,
  // then embed all chunk texts in a single batched call.
  const chunkTexts = boundaries.map(({ startLine, endLine }) => {
    const startIdx = Math.max(0, startLine - 1);
    const endIdx = Math.min(documentLines.length - 1, endLine - 1);
    return documentLines.slice(startIdx, endIdx + 1).join('\n');
  });

  return client.embed(chunkTexts);
}
