import type { ArtifactCategory, ArtifactEntry } from '../types/index.js';

/**
 * Returns the index of `segment` within `segments`, or -1 if not found.
 * Matching is case-sensitive and exact (no wildcards).
 */
function indexOf(segments: string[], segment: string): number {
  return segments.indexOf(segment);
}

/**
 * Classifies a single ArtifactEntry by inspecting its relativePath.
 *
 * Classification rules (evaluated in priority order):
 * - filename is "version.yaml"           -> 'cluster-info'
 * - path contains "cluster-info" segment -> 'cluster-info'
 * - path contains "analyzers" segment    -> 'analyzer'
 * - path is "cluster-resources/events/"  -> 'event'
 * - path contains "cluster-resources"    -> 'kubernetes-resource'
 * - path contains "logs" segment         -> 'log'
 * - path contains "helm" segment         -> 'helm-release'
 * - (anything else)                      -> 'unknown'
 *
 * The path is split on '/' so that a bundle root directory prefix (e.g.
 * "my-bundle/analyzers/output.json") is handled transparently.
 */
export function classifyArtifact(entry: ArtifactEntry): ArtifactCategory {
  const { relativePath } = entry;
  const segments = relativePath.split('/');
  const filename = segments[segments.length - 1] ?? '';

  // version.yaml anywhere in the path → cluster-info
  if (filename === 'version.yaml') {
    return 'cluster-info';
  }

  // cluster-info directory segment → cluster-info
  if (indexOf(segments, 'cluster-info') >= 0) {
    return 'cluster-info';
  }

  // analyzers directory segment → analyzer
  if (indexOf(segments, 'analyzers') >= 0) {
    return 'analyzer';
  }

  // cluster-resources segment — check sub-kind before returning kubernetes-resource
  const crIdx = indexOf(segments, 'cluster-resources');
  if (crIdx >= 0) {
    const subKind = segments[crIdx + 1];
    if (subKind === 'events') {
      return 'event';
    }
    return 'kubernetes-resource';
  }

  // logs directory segment → log
  if (indexOf(segments, 'logs') >= 0) {
    return 'log';
  }

  // helm directory segment → helm-release
  if (indexOf(segments, 'helm') >= 0) {
    return 'helm-release';
  }

  return 'unknown';
}
