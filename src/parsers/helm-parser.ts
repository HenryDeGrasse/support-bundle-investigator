import * as fsp from 'fs/promises';
import * as yaml from 'js-yaml';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Parsed representation of a Helm release found in a support bundle.
 *
 * Helm stores release data as base64-encoded, gzip-compressed protobuf
 * inside Kubernetes Secrets (type `helm.sh/release.v1`).  Many support
 * bundles instead capture a JSON/YAML dump of the release metadata
 * produced by `helm list --output json` or the Troubleshoot `helm`
 * collector.
 *
 * This parser handles the simpler JSON/YAML format.  Full protobuf
 * decoding would require a Helm library and is out of MVP scope.
 */
export interface HelmRelease {
  /** Release name (e.g. "my-app"). */
  name: string;
  /** Namespace the release is installed in. */
  namespace: string;
  /** Current revision number. */
  revision: number;
  /** Release status (e.g. "deployed", "failed", "pending-install"). */
  status: string;
  /** Chart name (e.g. "my-chart"). */
  chart: string;
  /** Chart version (e.g. "1.2.3"). */
  chartVersion: string;
  /** App version from Chart.yaml (e.g. "2.0.0"). */
  appVersion: string;
  /** ISO timestamp of last update/install. */
  updatedAt: string;
  /** Raw values override object (user-supplied values). */
  values: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function getNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? fallback : parsed;
  }
  return fallback;
}

/**
 * Attempts to parse a single raw Helm release object into a typed
 * {@link HelmRelease}.  Returns `null` when the input is not a valid
 * release record (missing `name` or unrecognisable shape).
 */
function parseRawRelease(raw: unknown): HelmRelease | null {
  if (!isRecord(raw)) return null;

  const name = getString(raw['name']);
  if (name.length === 0) return null;

  // Chart field may be "chart-1.2.3" (Helm list format) or a nested object
  let chart = '';
  let chartVersion = '';
  if (typeof raw['chart'] === 'string') {
    const parts = raw['chart'].match(/^(.+)-(\d+\.\d+.*)$/);
    if (parts) {
      chart = parts[1]!;
      chartVersion = parts[2]!;
    } else {
      chart = raw['chart'];
    }
  } else if (isRecord(raw['chart'])) {
    const metadata = isRecord(raw['chart']['metadata'])
      ? raw['chart']['metadata']
      : raw['chart'];
    chart = getString(metadata['name']);
    chartVersion = getString(metadata['version']);
  }

  return {
    name,
    namespace: getString(raw['namespace'], 'default'),
    revision: getNumber(raw['revision'], 1),
    status: getString(raw['status'], 'unknown'),
    chart,
    chartVersion,
    appVersion: getString(raw['app_version'] ?? raw['appVersion']),
    updatedAt: getString(raw['updated'] ?? raw['updatedAt']),
    values: isRecord(raw['config'])
      ? (raw['config'] as Record<string, unknown>)
      : isRecord(raw['values'])
        ? (raw['values'] as Record<string, unknown>)
        : {},
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parses a Helm release JSON or YAML file into an array of
 * {@link HelmRelease} objects.
 *
 * Handles:
 * - A single release object `{ name, namespace, chart, ... }`
 * - An array of release objects `[{ name, ... }, ...]`
 * - A YAML file containing one or more release documents
 *
 * Invalid or unrecognisable entries are silently skipped.
 *
 * @param filePath - Absolute path to the JSON/YAML file.
 * @returns Parsed releases (may be empty).
 */
export async function parseHelmReleaseFile(filePath: string): Promise<HelmRelease[]> {
  let content: string;
  try {
    content = await fsp.readFile(filePath, 'utf-8');
  } catch {
    return [];
  }

  const trimmed = content.trim();
  if (trimmed.length === 0) return [];

  // Try JSON first
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed.map(parseRawRelease).filter((r): r is HelmRelease => r !== null);
    }
    const single = parseRawRelease(parsed);
    return single ? [single] : [];
  } catch {
    // Not JSON — try YAML
  }

  try {
    const docs = yaml.loadAll(trimmed);
    const results: HelmRelease[] = [];
    for (const doc of docs) {
      if (Array.isArray(doc)) {
        for (const item of doc) {
          const release = parseRawRelease(item);
          if (release) results.push(release);
        }
      } else {
        const release = parseRawRelease(doc);
        if (release) results.push(release);
      }
    }
    return results;
  } catch {
    return [];
  }
}

/**
 * Parses a raw JSON or YAML string containing Helm release data.
 *
 * @param content - Raw file content.
 * @returns Parsed releases.
 */
export function parseHelmReleaseContent(content: string): HelmRelease[] {
  const trimmed = content.trim();
  if (trimmed.length === 0) return [];

  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed.map(parseRawRelease).filter((r): r is HelmRelease => r !== null);
    }
    const single = parseRawRelease(parsed);
    return single ? [single] : [];
  } catch {
    // Not JSON
  }

  try {
    const docs = yaml.loadAll(trimmed);
    const results: HelmRelease[] = [];
    for (const doc of docs) {
      if (Array.isArray(doc)) {
        for (const item of doc) {
          const release = parseRawRelease(item);
          if (release) results.push(release);
        }
      } else {
        const release = parseRawRelease(doc);
        if (release) results.push(release);
      }
    }
    return results;
  } catch {
    return [];
  }
}
