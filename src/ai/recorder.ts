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
// Cassettes are keyed by a hash of seed.id + seed.category so that prompt
// refactoring does not invalidate recordings. If a seed has no matching
// cassette during replay, the call returns empty findings (not an error).

import * as fsp from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import type { AIFinding } from './schemas.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RecorderMode = 'live' | 'record' | 'replay';

export interface Cassette {
  seedKey: string;
  seedId: string;
  seedCategory: string;
  request: { system: string; user: string };
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
 * Computes a stable cassette key from a seed's identity fields.
 *
 * Uses `seed.id + seed.category` so that prompt text changes don't
 * invalidate recordings — only seed identity matters.
 */
export function cassetteSeedKey(seedId: string, seedCategory: string): string {
  const hash = crypto
    .createHash('sha256')
    .update(`${seedId}::${seedCategory}`)
    .digest('hex')
    .slice(0, 16);
  return `${seedCategory}:${hash}`;
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
    this.store = { version: '1', cassettes: {} };
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
    request: { system: string; user: string },
    response: { findings: AIFinding[]; rawResponse: string },
    model: string,
  ): void {
    if (this.mode !== 'record') return;

    const key = cassetteSeedKey(seedId, seedCategory);
    this.store.cassettes[key] = {
      seedKey: key,
      seedId,
      seedCategory,
      request,
      response,
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
  ): Cassette | undefined {
    const key = cassetteSeedKey(seedId, seedCategory);
    return this.store.cassettes[key];
  }

  /**
   * Loads cassettes from disk into memory.
   *
   * Safe to call in any mode — silently returns if the file doesn't exist.
   */
  async load(): Promise<void> {
    try {
      const raw = await fsp.readFile(this.storePath, 'utf-8');
      const parsed = JSON.parse(raw) as CassetteStore;
      if (parsed.version === '1' && typeof parsed.cassettes === 'object') {
        this.store = parsed;
      }
    } catch {
      // File not found or parse error — start with empty store
      this.store = { version: '1', cassettes: {} };
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
    await fsp.writeFile(
      this.storePath,
      JSON.stringify(this.store, null, 2),
      'utf-8',
    );
  }

  /** Returns all stored cassette keys (for diagnostics). */
  keys(): string[] {
    return Object.keys(this.store.cassettes);
  }

  /** Checks if a cassette exists for the given seed. */
  has(seedId: string, seedCategory: string): boolean {
    return this.replay(seedId, seedCategory) !== undefined;
  }
}
