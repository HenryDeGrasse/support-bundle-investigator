import * as fsp from 'fs/promises';
import type { AnalyzerResult, AnalyzerSeverity } from '../types/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_SEVERITIES = new Set<AnalyzerSeverity>(['error', 'warn', 'pass', 'info']);

/**
 * Maps Troubleshoot severity aliases to canonical AnalyzerSeverity values.
 *
 * Real bundles use:
 * - `"debug"` for passing checks → maps to `"pass"`
 * - `"fail"` for failing checks → maps to `"error"`
 */
const SEVERITY_ALIASES: Record<string, AnalyzerSeverity> = {
  debug: 'pass',
  fail: 'error',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function getOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function normalizeSeverity(raw: unknown): AnalyzerSeverity {
  if (typeof raw === 'string') {
    if (VALID_SEVERITIES.has(raw as AnalyzerSeverity)) {
      return raw as AnalyzerSeverity;
    }
    const alias = SEVERITY_ALIASES[raw];
    if (alias) return alias;
  }
  if (raw !== undefined) {
    console.warn(`[analyzer-parser] Unknown severity "${String(raw)}", defaulting to "info"`);
  }
  return 'info';
}

function mapEntry(raw: unknown): AnalyzerResult {
  const entry = isRecord(raw) ? raw : {};
  const insight = isRecord(entry.insight) ? entry.insight : {};
  const severity = normalizeSeverity(insight.severity);

  return {
    name: getString(entry.name),
    title: getString(insight.primary),
    message: getString(insight.detail),
    severity,
    iconKey: getOptionalString(entry.iconKey),
    iconUri: getOptionalString(entry.iconUri),
    isPass: severity === 'pass',
    isFail: severity === 'error',
    isWarn: severity === 'warn',
  };
}

/**
 * Parses a JSON string containing analyzer results.
 *
 * Accepts two formats:
 * - A top-level JSON array: `[{ "name": "...", "insight": { ... } }, ...]`
 * - A wrapped object with an `analyzers` key:
 *   `{ "analyzers": [ ... ] }`
 *
 * On any parse error or unexpected structure a warning is logged and an empty
 * array is returned so that callers can continue processing other files.
 */
export function parseAnalyzerJson(content: string): AnalyzerResult[] {
  let parsed: unknown;

  try {
    parsed = JSON.parse(content);
  } catch (err) {
    console.warn(
      `[analyzer-parser] Failed to parse analyzer JSON: ${(err as Error).message}`,
    );
    return [];
  }

  // Normalise to an array, handling the `analyzers` wrapper key
  let entries: unknown[];

  if (Array.isArray(parsed)) {
    entries = parsed;
  } else if (
    typeof parsed === 'object' &&
    parsed !== null &&
    'analyzers' in parsed &&
    Array.isArray((parsed as Record<string, unknown>).analyzers)
  ) {
    entries = (parsed as Record<string, unknown>).analyzers as unknown[];
  } else {
    console.warn(
      '[analyzer-parser] Unexpected analyzer JSON shape — expected array or { analyzers: [] }',
    );
    return [];
  }

  return entries.filter(isRecord).map(mapEntry);
}

/**
 * Reads an analyzer output file from disk and returns parsed results.
 *
 * On any I/O or parse error a warning is logged and an empty array is
 * returned, allowing the pipeline to continue with other files.
 */
export async function parseAnalyzerFile(filePath: string): Promise<AnalyzerResult[]> {
  let content: string;

  try {
    content = await fsp.readFile(filePath, 'utf-8');
  } catch (err) {
    console.warn(
      `[analyzer-parser] Could not read analyzer file "${filePath}": ${(err as Error).message}`,
    );
    return [];
  }

  return parseAnalyzerJson(content);
}

/**
 * Merges multiple arrays of {@link AnalyzerResult} into a single flat array,
 * preserving the original order across result sets.
 */
export function mergeAnalyzerResults(results: AnalyzerResult[][]): AnalyzerResult[] {
  return results.flat();
}
