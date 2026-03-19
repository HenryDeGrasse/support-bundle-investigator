import type { Evidence, Finding } from '../types/index.js';

// ---------------------------------------------------------------------------
// Evidence path cleaning
// ---------------------------------------------------------------------------

/**
 * Known top-level directories inside a Troubleshoot support bundle.
 * Used as anchors when stripping absolute extraction paths.
 */
const BUNDLE_ROOT_DIRS = [
  'cluster-resources/',
  'cluster-info/',
  'analyzers/',
  'logs/',
  'helm/',
  'host-collectors/',
  'podlogs/',
];

/**
 * Strips the temp extraction directory prefix from an evidence path,
 * returning only the bundle-relative portion.
 *
 * Handles paths like:
 * - `/var/folders/.../sbi-bundle-XYZ/scenario/logs/app/pod.log` → `logs/app/pod.log`
 * - `/tmp/sbi-bundle-AB/cluster-resources/pods/default.json` → `cluster-resources/pods/default.json`
 * - `cluster-resources/pods/default.json` → unchanged
 *
 * Strategy:
 * 1. If path contains `/sbi-bundle-`, strip everything up to and including
 *    the next directory component (the scenario name).
 * 2. Otherwise, find the first known bundle root directory and strip
 *    everything before it.
 * 3. Fall back to the original path.
 */
export function cleanEvidencePath(filePath: string): string {
  if (filePath.length === 0) return filePath;

  // Strategy 1: strip /path/to/sbi-bundle-XYZ/scenario-name/
  const sbiBundleIdx = filePath.indexOf('/sbi-bundle-');
  if (sbiBundleIdx !== -1) {
    // Find the end of the sbi-bundle-XYZ dir
    const afterBundle = filePath.indexOf('/', sbiBundleIdx + 1);
    if (afterBundle !== -1) {
      // Skip the scenario name directory
      const afterScenario = filePath.indexOf('/', afterBundle + 1);
      if (afterScenario !== -1) {
        return filePath.slice(afterScenario + 1);
      }
    }
  }

  // Strategy 2: find a known bundle root directory
  for (const rootDir of BUNDLE_ROOT_DIRS) {
    const idx = filePath.indexOf(rootDir);
    if (idx !== -1) {
      return filePath.slice(idx);
    }
  }

  // Strategy 3: return as-is
  return filePath;
}

// ---------------------------------------------------------------------------
// Title humanization
// ---------------------------------------------------------------------------

/**
 * Converts a machine-generated finding title into a human-friendly form.
 *
 * - Strips legacy `[Hypothesis] ` prefix as a backwards-compatible safety net
 * - Strips legacy `(symptom: ...)` suffix as a backwards-compatible safety net
 * - Cleans any remaining absolute temp paths from log-investigator titles
 */
export function humanizeTitle(title: string): string {
  let result = title;

  // Strip legacy [Hypothesis] prefix
  result = result.replace(/^\[Hypothesis\]\s*/i, '');

  // Strip legacy (symptom: ...) suffix
  result = result.replace(/\s*\(symptom:\s*.+\)\s*$/, '');

  // Clean absolute paths that may still appear in titles from older findings
  result = result.replace(
    /\b(in|from)\s+'?(\/[^\s']+)'?/g,
    (_match, preposition: string, absPath: string) => {
      const cleaned = cleanEvidencePath(absPath);
      return `${preposition} ${cleaned}`;
    },
  );

  return result.trim();
}

// ---------------------------------------------------------------------------
// Reasoning humanization
// ---------------------------------------------------------------------------

/**
 * Converts machine-generated reasoning into human-readable prose.
 *
 * - Strips `[Differential diagnosis, rank #N]` prefix
 * - Removes `Confidence rationale: Confidence 0.XX: ...` sentences
 * - Removes `Derived from N raw finding(s): ...` sentences
 * - Collapses multiple spaces
 */
export function humanizeReasoning(reasoning: string): string {
  let result = reasoning;

  // Strip [Differential diagnosis, rank #N] prefix
  result = result.replace(/^\[Differential diagnosis, rank #\d+\]\s*/i, '');

  // Remove confidence rationale sentence — everything from "Confidence rationale:"
  // up to (and including) the period before "Preferred over" or "Derived from" or end.
  result = result.replace(
    /Confidence rationale:\s*Confidence\s+[\d.]+:[\s\S]*?(?=Preferred over|Derived from|$)/g,
    '',
  );

  // Remove "Derived from N raw finding(s): ..." sentence
  result = result.replace(/Derived from \d+ raw finding\(s\):[^.]*\.\s*/g, '');

  // Clean absolute temp paths embedded in reasoning text
  result = result.replace(
    /(?:in|from|file)\s+'?(\/[^\s']+)'?/g,
    (_match, absPath: string) => {
      const cleaned = cleanEvidencePath(absPath);
      return `in '${cleaned}'`;
    },
  );

  // Collapse multiple spaces
  result = result.replace(/\s{2,}/g, ' ');

  return result.trim();
}

// ---------------------------------------------------------------------------
// Evidence collapsing
// ---------------------------------------------------------------------------

/**
 * Collapses multiple evidence items from the same file path into a single
 * summary entry.
 *
 * When N items share the same `path`, they are merged into one entry with
 * a note like: `"first note (N occurrences from this file)"`.
 *
 * Items with distinct paths are kept separate.
 */
export function collapseEvidence(items: Evidence[]): Evidence[] {
  if (items.length === 0) return [];

  const groups = new Map<string, Evidence[]>();
  for (const item of items) {
    const key = item.path;
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }

  const result: Evidence[] = [];
  for (const [path, group] of groups) {
    if (group.length === 1) {
      result.push(group[0]!);
    } else {
      const firstNote = group[0]!.note;
      result.push({
        path,
        note: `${firstNote} (${group.length} occurrences from this file)`,
        artifactType: group[0]!.artifactType,
        timestamp: group[0]!.timestamp,
      });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Summary card
// ---------------------------------------------------------------------------

/**
 * Formats a concise "start here" summary card from the top finding.
 *
 * ```
 * -- START HERE ------------------------------------------------
 * DNS failure for db.internal
 * > Check CoreDNS logs and verify the Service exists
 * Confidence: 81%  |  5 findings total  |  See Finding #1
 * --------------------------------------------------------------
 * ```
 */
export function formatSummaryCard(topFinding: Finding, totalFindings: number): string {
  const title = humanizeTitle(topFinding.title);
  const confidence = Math.round(topFinding.confidence * 100);
  const action = topFinding.recommendedAction;

  const lines = [
    '-- START HERE ------------------------------------------------',
    title,
    `> ${action}`,
    `Confidence: ${confidence}%  |  ${totalFindings} findings total  |  See Finding #1`,
    '--------------------------------------------------------------',
  ];

  return lines.join('\n');
}
