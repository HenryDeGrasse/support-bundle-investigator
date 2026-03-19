// ---------------------------------------------------------------------------
// Classifier tests
//
// Tests for src/ingestion/classifier.ts.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { classifyArtifact } from '../classifier.js';
import type { ArtifactEntry } from '../../types/index.js';

/** Creates a minimal ArtifactEntry with `category` set to `'unknown'`. */
function makeEntry(relativePath: string, size = 100): ArtifactEntry {
  return {
    relativePath,
    absolutePath: `/tmp/sbi-test/${relativePath}`,
    size,
    category: 'unknown',
  };
}

// ---------------------------------------------------------------------------
// 1.5 — 'config' category is dead code: classifyArtifact must never return it
// ---------------------------------------------------------------------------

describe('classifyArtifact — never returns "config"', () => {
  const knownPathPatterns = [
    // analyzer
    'analyzers/output.json',
    'my-bundle/analyzers/output.json',
    'analysis.json',
    'my-bundle/analysis.json',
    // kubernetes-resource
    'cluster-resources/pods/default/pod.yaml',
    'cluster-resources/deployments/production.json',
    'cluster-resources/pods/default.json',
    'cluster-resources/nodes.json',
    // event
    'cluster-resources/events/default.json',
    'bundle/cluster-resources/events/kube-system.json',
    // log
    'logs/app/app-pod.log',
    'bundle/logs/app/container.log',
    'cluster-resources/pods/logs/default/app-pod/container.log',
    // cluster-info
    'version.yaml',
    'bundle/version.yaml',
    'cluster-info/cluster_version.json',
    // helm-release
    'helm/releases/my-app.yaml',
    'bundle/helm/my-release.json',
    // unknown
    'README.md',
    'bundle/random-file.txt',
  ];

  it.each(knownPathPatterns)('does not return "config" for path: %s', (path) => {
    expect(classifyArtifact(makeEntry(path))).not.toBe('config');
  });
});
