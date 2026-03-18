import type { FindingSeverity } from '../types/index.js';

// ---------------------------------------------------------------------------
// Severity helpers
// ---------------------------------------------------------------------------

/**
 * Maps a {@link FindingSeverity} to an Ink terminal color name for styled output.
 *
 * @param severity - The finding severity level.
 * @returns An Ink-compatible color string ('red', 'yellow', 'cyan', 'blue', or 'gray').
 */
export function severityColor(severity: FindingSeverity): string {
  switch (severity) {
    case 'critical':
      return 'red';
    case 'high':
      return 'yellow';
    case 'medium':
      return 'cyan';
    case 'low':
      return 'blue';
    case 'info':
      return 'gray';
  }
}

/**
 * Returns an uppercase severity label suitable for badge display.
 *
 * @param severity - The finding severity level.
 * @returns An uppercase label string, e.g. `'CRITICAL'`.
 */
export function formatSeverityLabel(severity: FindingSeverity): string {
  return severity.toUpperCase();
}

// ---------------------------------------------------------------------------
// Finding metadata helpers
// ---------------------------------------------------------------------------

/**
 * Derives a short human-readable source tag from the finding ID prefix.
 *
 * Recognised prefixes:
 * - `finding:k8s:*`         → `'K8S'`
 * - `finding:log:*`         → `'LOG'`
 * - `finding:config:*`      → `'CFG'`
 * - `finding:ai:*`          → `'AI'`
 * - `finding:hypothesis:*`  → `'HYP'`
 * - anything else           → `'SBI'`
 *
 * @param findingId - The full finding identifier.
 * @returns A short uppercase source tag.
 */
export function sourceTag(findingId: string): string {
  if (findingId.startsWith('finding:k8s:')) return 'K8S';
  if (findingId.startsWith('finding:log:')) return 'LOG';
  if (findingId.startsWith('finding:config:')) return 'CFG';
  if (findingId.startsWith('finding:ai:')) return 'AI';
  if (findingId.startsWith('finding:hypothesis:')) return 'HYP';
  return 'SBI';
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/**
 * Truncates a title string with a Unicode ellipsis (`'…'`) if it exceeds
 * `maxLen` characters. Returns the original string when within the limit.
 *
 * @param title  - The original title string.
 * @param maxLen - Maximum allowed character length (inclusive).
 * @returns The original string if `title.length <= maxLen`, otherwise a
 *          truncated string of exactly `maxLen` characters ending with `'…'`.
 */
export function truncateTitle(title: string, maxLen: number): string {
  if (title.length <= maxLen) return title;
  return `${title.slice(0, maxLen - 1)}…`;
}

/**
 * Renders a confidence score as a rounded percentage string.
 *
 * @param confidence - A confidence value in the range `[0, 1]`.
 * @returns A percentage string, e.g. `'95%'`.
 */
export function confidenceBar(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

/**
 * Maps an artifact type string to a representative Unicode icon.
 *
 * | Artifact type          | Icon |
 * |------------------------|------|
 * | `'log'`                | LOG  |
 * | `'kubernetes-resource'`| K8S  |
 * | `'event'`              | EVT  |
 * | `'analyzer'`           | ANL  |
 * | `'config'`             | CFG  |
 * | `'helm-release'`       | HLM  |
 * | default / undefined    | ---  |
 *
 * @param artifactType - The artifact category string (may be undefined).
 * @returns A Unicode icon character.
 */
export function evidenceIcon(artifactType?: string): string {
  switch (artifactType) {
    case 'log':
      return 'LOG';
    case 'kubernetes-resource':
      return 'K8S';
    case 'event':
      return 'EVT';
    case 'analyzer':
      return 'ANL';
    case 'config':
      return 'CFG';
    case 'helm-release':
      return 'HLM';
    default:
      return '---';
  }
}

// ---------------------------------------------------------------------------
// Differential diagnosis helpers
// ---------------------------------------------------------------------------

/**
 * Parses the differential diagnosis context from a finding's `reasoningSummary`.
 *
 * Extracts:
 * - `rank` — the rank specifier from the `[Differential diagnosis, rank #N]` prefix
 *   (e.g. `'rank #1'`), or `''` when the prefix is absent.
 * - `rootCause` — the text following `Root cause:` up to the first period, or the
 *   full summary string when the `Root cause:` pattern is absent.
 * - `runnerUpComparison` — the `Preferred over runner-up …` sentence when present,
 *   or `null` when absent.
 *
 * @param reasoningSummary - The full `reasoningSummary` string from a {@link Finding}.
 * @returns Structured differential context for visual rendering.
 */
export function extractDifferentialContext(reasoningSummary: string): {
  rank: string;
  rootCause: string;
  runnerUpComparison: string | null;
} {
  // ── Rank ────────────────────────────────────────────────────────────────
  const rankMatch = /\[Differential diagnosis, rank #(\d+)\]/.exec(reasoningSummary);
  const rank = rankMatch ? `rank #${rankMatch[1]}` : '';

  // ── Root cause ─────────────────────────────────────────────────────────
  const rootCauseMatch = /Root cause:\s*(.+?)\./.exec(reasoningSummary);
  const rootCause = rootCauseMatch ? rootCauseMatch[1].trim() : reasoningSummary;

  // ── Runner-up comparison ────────────────────────────────────────────────
  // The runner-up sentence begins with "Preferred over runner-up" and ends at
  // the period preceding "Derived from" or the end of the string.
  let runnerUpComparison: string | null = null;
  const runnerUpStart = reasoningSummary.indexOf('Preferred over runner-up');
  if (runnerUpStart !== -1) {
    const rest = reasoningSummary.slice(runnerUpStart);
    // Match greedily to the period that precedes "Derived from" or end-of-string.
    const endMatch = /^(.+?\.)(?:\s+Derived from|\s*$)/s.exec(rest);
    runnerUpComparison = endMatch ? endMatch[1].trim() : rest.trim();
  }

  return { rank, rootCause, runnerUpComparison };
}
