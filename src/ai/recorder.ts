// ---------------------------------------------------------------------------
// LLM Response Recorder / Replay
// ---------------------------------------------------------------------------
//
// Provides record/replay for LLM investigation calls so nightly CI can
// capture real API responses and PR CI can replay them deterministically.
//
// Mode is controlled via `SBI_AI_MODE` environment variable:
//   - `live`   — real API calls, no recording (default)
//   - `record` — real API calls, save cassettes to disk
//   - `replay` — load cassettes, match by seed key, return cached response
//
// Cassettes are keyed by an unambiguous hash of the seed, request, and model.
// This prevents scenarios that happen to reuse a seed ID from overwriting each
// other. Version-1 identity-only cassettes remain replayable for compatibility.

import * as fsp from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import type { AIFinding } from './schemas.js';
import { sanitizeSensitiveText } from '../utils/sensitive-data.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RecorderMode = 'live' | 'record' | 'replay';

export interface CassetteRequest {
  system: string;
  user: string;
}

export interface Cassette {
  seedKey: string;
  seedId: string;
  seedCategory: string;
  request: CassetteRequest;
  response: { findings: AIFinding[]; rawResponse: string };
  model: string;
  timestamp: string;
}

export interface CassetteStore {
  version: string;
  cassettes: Record<string, Cassette>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Computes a stable cassette key from a seed and, when available, its full
 * request identity.
 *
 * JSON tuple encoding avoids delimiter ambiguity (for example, IDs and
 * categories that themselves contain `::`). Record/replay callers should pass
 * both `request` and `model`; the optional arguments preserve the public API
 * for diagnostics and identity-only lookups.
 */
export function cassetteSeedKey(
  seedId: string,
  seedCategory: string,
  request?: CassetteRequest,
  model?: string,
): string {
  const keyRequest = request === undefined ? null : sanitizeRequest(request);
  const hash = crypto
    .createHash('sha256')
    .update(JSON.stringify(['2', seedId, seedCategory, keyRequest, model ?? null]))
    .digest('hex')
    .slice(0, 16);
  return `${seedCategory}:${hash}`;
}

/** Computes the key used by version-1 cassette stores. */
function legacyCassetteSeedKey(seedId: string, seedCategory: string): string {
  const hash = crypto
    .createHash('sha256')
    .update(`${seedId}::${seedCategory}`)
    .digest('hex')
    .slice(0, 16);
  return `${seedCategory}:${hash}`;
}

function isCassetteStore(value: unknown): value is CassetteStore {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<CassetteStore>;
  return (
    (candidate.version === '1' || candidate.version === '2') &&
    typeof candidate.cassettes === 'object' &&
    candidate.cassettes !== null &&
    !Array.isArray(candidate.cassettes)
  );
}

function sanitizeRequest(request: CassetteRequest): CassetteRequest {
  return {
    system: sanitizeSensitiveText(request.system),
    user: sanitizeSensitiveText(request.user),
  };
}

function sanitizeStringValues<T>(value: T): T {
  if (typeof value === 'string') {
    return sanitizeSensitiveText(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeStringValues(entry)) as T;
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        sanitizeStringValues(entry),
      ]),
    ) as T;
  }
  return value;
}

/**
 * Reads the `SBI_AI_MODE` environment variable and normalises it to a
 * valid {@link RecorderMode}. Defaults to `'live'`.
 */
export function getRecorderMode(): RecorderMode {
  const raw = (process.env['SBI_AI_MODE'] ?? 'live').trim().toLowerCase();
  if (raw === 'record' || raw === 'replay') return raw;
  return 'live';
}

// ---------------------------------------------------------------------------
// CassetteRecorder
// ---------------------------------------------------------------------------

/**
 * Records and replays LLM investigation call responses.
 *
 * ### Recording flow (nightly CI)
 * ```typescript
 * const recorder = new CassetteRecorder('record', './test/cassettes');
 * // After each real LLM call:
 * recorder.record(seedId, seedCategory, request, response, model);
 * // At the end:
 * await recorder.flush();
 * ```
 *
 * ### Replay flow (PR CI)
 * ```typescript
 * const recorder = new CassetteRecorder('replay', './test/cassettes');
 * await recorder.load();
 * // Instead of calling the LLM:
 * const cached = recorder.replay(seedId, seedCategory);
 * if (cached) { use cached.response } else { skip or warn }
 * ```
 */
export class CassetteRecorder {
  readonly mode: RecorderMode;
  private readonly dir: string;
  private store: CassetteStore;

  constructor(mode: RecorderMode, cassetteDir: string) {
    this.mode = mode;
    this.dir = cassetteDir;
    this.store = { version: '2', cassettes: {} };
  }

  /** Returns the file path for the consolidated cassette store. */
  get storePath(): string {
    return path.join(this.dir, 'cassettes.json');
  }

  /** Number of cassettes currently held in memory. */
  get size(): number {
    return Object.keys(this.store.cassettes).length;
  }

  /**
   * Records a single LLM call.
   *
   * Only takes effect in `record` mode; no-ops in other modes.
   */
  record(
    seedId: string,
    seedCategory: string,
    request: CassetteRequest,
    response: { findings: AIFinding[]; rawResponse: string },
    model: string,
  ): void {
    if (this.mode !== 'record') return;

    const sanitizedRequest = sanitizeRequest(request);
    const sanitizedResponse = sanitizeStringValues(response);
    const key = cassetteSeedKey(seedId, seedCategory, sanitizedRequest, model);
    this.store.cassettes[key] = {
      seedKey: key,
      seedId,
      seedCategory,
      request: sanitizedRequest,
      response: sanitizedResponse,
      model,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Retrieves a cached response for the given seed identity.
   *
   * Returns `undefined` when no matching cassette exists.
   */
  replay(
    seedId: string,
    seedCategory: string,
    request?: CassetteRequest,
    model?: string,
  ): Cassette | undefined {
    if (request !== undefined) {
      const exactKey = cassetteSeedKey(seedId, seedCategory, request, model);
      const exact = this.store.cassettes[exactKey];
      if (exact !== undefined) return exact;

      // Version-1 stores were keyed by seed identity only. Keep committed and
      // externally recorded v1 cassettes usable while all new writes use v2.
      const legacy = this.store.cassettes[
        legacyCassetteSeedKey(seedId, seedCategory)
      ];
      if (legacy !== undefined) return legacy;
    }

    const identityMatches = Object.values(this.store.cassettes).filter(
      (cassette) =>
        cassette.seedId === seedId && cassette.seedCategory === seedCategory,
    );

    // An identity-only lookup is safe only when it is unambiguous.
    return identityMatches.length === 1 ? identityMatches[0] : undefined;
  }

  /**
   * Loads cassettes from disk into memory.
   *
   * Safe to call in any mode — silently returns if the file doesn't exist.
   */
  async load(): Promise<void> {
    try {
      const raw = await fsp.readFile(this.storePath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      if (isCassetteStore(parsed)) {
        this.store = parsed;
      }
    } catch {
      // File not found or parse error — start with empty store
      this.store = { version: '2', cassettes: {} };
    }
  }

  /**
   * Writes all recorded cassettes to disk.
   *
   * Only takes effect in `record` mode; no-ops in other modes.
   */
  async flush(): Promise<void> {
    if (this.mode !== 'record') return;

    await fsp.mkdir(this.dir, { recursive: true });

    let existing: CassetteStore = { version: '2', cassettes: {} };
    try {
      const raw = await fsp.readFile(this.storePath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      if (!isCassetteStore(parsed)) {
        throw new Error(`Invalid cassette store: ${this.storePath}`);
      }
      existing = parsed;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw error;
    }

    const merged: CassetteStore = {
      version: '2',
      cassettes: {
        ...existing.cassettes,
        ...this.store.cassettes,
      },
    };
    const tempPath = `${this.storePath}.${process.pid}.${crypto.randomUUID()}.tmp`;

    try {
      await fsp.writeFile(tempPath, `${JSON.stringify(merged, null, 2)}\n`, {
        encoding: 'utf-8',
        mode: 0o600,
      });
      await fsp.rename(tempPath, this.storePath);
      this.store = merged;
    } finally {
      await fsp.rm(tempPath, { force: true }).catch(() => undefined);
    }
  }

  /** Returns all stored cassette keys (for diagnostics). */
  keys(): string[] {
    return Object.keys(this.store.cassettes);
  }

  /** Checks if a cassette exists for the given seed. */
  has(
    seedId: string,
    seedCategory: string,
    request?: CassetteRequest,
    model?: string,
  ): boolean {
    return this.replay(seedId, seedCategory, request, model) !== undefined;
  }
}
