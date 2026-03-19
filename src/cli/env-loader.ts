/**
 * Minimal .env file loader — zero external dependencies.
 *
 * Walks up from the current working directory (and the script's own directory)
 * to find the nearest `.env` file. Parses KEY=VALUE lines and sets them on
 * `process.env` without overriding values already present in the environment.
 *
 * Supports:
 * - Bare values:        KEY=value
 * - Single-quoted:      KEY='value'
 * - Double-quoted:      KEY="value"
 * - Comments:           # ignored
 * - Blank lines:        ignored
 * - Inline comments:    KEY=value # ignored (only for unquoted values)
 *
 * Does NOT support:
 * - Multi-line values
 * - Variable interpolation ($VAR)
 * - Export prefix (export KEY=value) — stripped if present
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * Finds the nearest `.env` file by walking up from the given starting
 * directory. Returns the absolute path, or `null` if none is found.
 */
function findEnvFile(startDir: string): string | null {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, '.env');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Parses a `.env` file and returns a record of key-value pairs.
 */
function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();

    // Skip blanks and comments
    if (line.length === 0 || line.startsWith('#')) continue;

    // Strip optional `export ` prefix
    const stripped = line.startsWith('export ') ? line.slice(7).trim() : line;

    const eqIndex = stripped.indexOf('=');
    if (eqIndex < 1) continue;

    const key = stripped.slice(0, eqIndex).trim();
    let value = stripped.slice(eqIndex + 1).trim();

    // Handle quoted values
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      // Strip inline comments for unquoted values
      const hashIndex = value.indexOf(' #');
      if (hashIndex >= 0) {
        value = value.slice(0, hashIndex).trim();
      }
    }

    result[key] = value;
  }

  return result;
}

/**
 * Loads the nearest `.env` file into `process.env`.
 *
 * Values already present in the environment are NOT overridden — explicit
 * environment variables always take precedence over the file.
 *
 * Call this once at the top of each binary entry point (`run.ts`, `rat.ts`)
 * before any code reads `process.env`.
 */
export function loadDotEnv(): void {
  const envPath = findEnvFile(process.cwd());
  if (!envPath) return;

  try {
    const content = fs.readFileSync(envPath, 'utf-8');
    const parsed = parseEnvFile(content);

    for (const [key, value] of Object.entries(parsed)) {
      // Don't override existing environment variables
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch {
    // Silently ignore read errors — .env is optional
  }
}
