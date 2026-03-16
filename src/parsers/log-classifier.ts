import type { LogFile } from './log-parser.js';
import { classifyLogImportance } from './log-parser.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LogCategory =
  | 'application'
  | 'system'
  | 'kubernetes'
  | 'database'
  | 'networking'
  | 'unknown';

export interface LogClassification {
  path: string;
  importance: number;
  errorDensity: number;
  primaryErrors: string[];
  category: LogCategory;
}

// ---------------------------------------------------------------------------
// Category patterns
// ---------------------------------------------------------------------------

/**
 * Ordered list of [keyword, category] pairs used to classify a log file
 * by its path or dominant error messages.
 */
const CATEGORY_PATH_PATTERNS: Array<[RegExp, LogCategory]> = [
  [/kube|apiserver|kubelet|controller-manager|scheduler|etcd/i, 'kubernetes'],
  [/postgres|mysql|mongo|redis|cassandra|elasticsearch|db\b/i, 'database'],
  [/nginx|haproxy|envoy|istio|proxy|ingress|network/i, 'networking'],
  [/syslog|systemd|kernel|journald|dmesg/i, 'system'],
];

const CATEGORY_ERROR_PATTERNS: Array<[RegExp, LogCategory]> = [
  [/EtcdCluster|etcd|apiserver|kubeconfig|kubectl/i, 'kubernetes'],
  [/dial tcp|dns lookup|no such host|connection refused|timeout.*connect/i, 'networking'],
  [/database|postgres|mysql|mongo|redis|sql:|db conn/i, 'database'],
  [/systemd|kernel|oom|cgroup|mount/i, 'system'],
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function categoriseLog(logFile: LogFile): LogCategory {
  // 1. Check path
  const lowerPath = logFile.path.toLowerCase();
  for (const [pattern, category] of CATEGORY_PATH_PATTERNS) {
    if (pattern.test(lowerPath)) return category;
  }

  // 2. Check dominant error messages
  const errorLines = logFile.lines
    .filter((l) => l.level === 'error')
    .map((l) => l.content)
    .join('\n');

  for (const [pattern, category] of CATEGORY_ERROR_PATTERNS) {
    if (pattern.test(errorLines)) return category;
  }

  // 3. Default: application
  if (logFile.errorCount > 0 || logFile.warningCount > 0 || logFile.lines.length > 0) {
    return 'application';
  }

  return 'unknown';
}

/**
 * Extracts the most prominent error messages from a log file.
 *
 * Returns up to 5 unique, deduplicated error/fatal line contents.
 */
function extractPrimaryErrors(logFile: LogFile): string[] {
  const seen = new Set<string>();
  const primary: string[] = [];

  for (const line of logFile.lines) {
    if (line.level !== 'error') continue;
    // Normalise by stripping timestamps at the start so repeated errors with
    // different timestamps still deduplicate
    const normalised = line.content.replace(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?\s*/,
      '',
    );
    if (!seen.has(normalised)) {
      seen.add(normalised);
      primary.push(line.content);
    }
    if (primary.length >= 5) break;
  }

  return primary;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Produces a {@link LogClassification} for each provided {@link LogFile}.
 *
 * Computes error density, recalculates importance, determines category, and
 * extracts primary error lines.
 */
export function classifyLogs(logFiles: LogFile[]): LogClassification[] {
  return logFiles.map((logFile) => {
    const total = logFile.lines.length;
    const errorDensity = total > 0 ? logFile.errorCount / total : 0;
    const importance = classifyLogImportance(logFile);
    const category = categoriseLog(logFile);
    const primaryErrors = extractPrimaryErrors(logFile);

    return {
      path: logFile.path,
      importance,
      errorDensity,
      primaryErrors,
      category,
    };
  });
}

/**
 * Sorts an array of {@link LogClassification} by importance descending
 * (highest first).
 *
 * The original array is not mutated — a new sorted copy is returned.
 */
export function rankLogsByImportance(classifications: LogClassification[]): LogClassification[] {
  return [...classifications].sort((a, b) => b.importance - a.importance);
}
