import { describe, it, expect } from 'vitest';
import { classifyArtifact } from '../classifier.js';
import { profileBundle } from '../profiler.js';
import type { ArtifactEntry, BundleManifest } from '../../types/index.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Creates a minimal ArtifactEntry with `category` set to `'unknown'`. */
function makeEntry(relativePath: string, size = 100): ArtifactEntry {
  return {
    relativePath,
    absolutePath: `/tmp/sbi-test/${relativePath}`,
    size,
    category: 'unknown',
  };
}

/** Creates a minimal BundleManifest from an array of relative paths. */
function makeManifest(relativePaths: string[]): BundleManifest {
  const files = relativePaths.map((p) => makeEntry(p));
  return {
    bundlePath: '/tmp/bundle.tar.gz',
    extractedPath: '/tmp/sbi-test',
    files,
    totalSize: files.reduce((acc, f) => acc + f.size, 0),
    extractedAt: new Date(),
  };
}

// ---------------------------------------------------------------------------
// classifyArtifact — individual classification rules
// ---------------------------------------------------------------------------

describe('classifyArtifact', () => {
  it('classifies analyzer JSON files as "analyzer"', () => {
    expect(classifyArtifact(makeEntry('analyzers/output.json')).valueOf()).toBe('analyzer');
    // with a bundle-root prefix
    expect(classifyArtifact(makeEntry('my-bundle/analyzers/output.json'))).toBe('analyzer');
  });

  it('classifies files under cluster-resources/ (non-events) as "kubernetes-resource"', () => {
    const podEntry = makeEntry('bundle/cluster-resources/pods/default/app-pod.yaml');
    const deployEntry = makeEntry('bundle/cluster-resources/deployments/default/app-dep.yaml');
    const svcEntry = makeEntry('bundle/cluster-resources/services/default/svc.yaml');

    expect(classifyArtifact(podEntry)).toBe('kubernetes-resource');
    expect(classifyArtifact(deployEntry)).toBe('kubernetes-resource');
    expect(classifyArtifact(svcEntry)).toBe('kubernetes-resource');
  });

  it('classifies files under logs/ as "log"', () => {
    expect(classifyArtifact(makeEntry('logs/app/app-pod.log'))).toBe('log');
    expect(classifyArtifact(makeEntry('bundle/logs/app/container.log'))).toBe('log');
  });

  it('classifies event files as "event"', () => {
    expect(classifyArtifact(makeEntry('cluster-resources/events/default.json'))).toBe('event');
    expect(classifyArtifact(makeEntry('bundle/cluster-resources/events/kube-system.json'))).toBe(
      'event',
    );
  });

  it('classifies version.yaml as "cluster-info"', () => {
    expect(classifyArtifact(makeEntry('version.yaml'))).toBe('cluster-info');
    expect(classifyArtifact(makeEntry('bundle/version.yaml'))).toBe('cluster-info');
  });

  it('classifies files under cluster-info/ as "cluster-info"', () => {
    expect(classifyArtifact(makeEntry('cluster-info/cluster_version.json'))).toBe('cluster-info');
    expect(classifyArtifact(makeEntry('bundle/cluster-info/nodes.json'))).toBe('cluster-info');
  });

  it('classifies helm files as "helm-release"', () => {
    expect(classifyArtifact(makeEntry('helm/releases/my-app.yaml'))).toBe('helm-release');
    expect(classifyArtifact(makeEntry('bundle/helm/my-release.json'))).toBe('helm-release');
  });

  it('marks unrecognized files as "unknown"', () => {
    expect(classifyArtifact(makeEntry('README.md'))).toBe('unknown');
    expect(classifyArtifact(makeEntry('bundle/random-file.txt'))).toBe('unknown');
    expect(classifyArtifact(makeEntry('bundle/support-bundle.md'))).toBe('unknown');
  });

  it('events take priority over the generic kubernetes-resource rule', () => {
    // Even though the path starts with cluster-resources/, events/ sub-kind wins
    const entry = makeEntry('cluster-resources/events/production.json');
    expect(classifyArtifact(entry)).toBe('event');
  });
});

// ---------------------------------------------------------------------------
// profileBundle — profile generation
// ---------------------------------------------------------------------------

describe('profileBundle', () => {
  it('generates correct artifact counts by category', async () => {
    const manifest = makeManifest([
      'bundle/analyzers/output.json',
      'bundle/cluster-resources/pods/default/pod.yaml',
      'bundle/cluster-resources/deployments/default/dep.yaml',
      'bundle/cluster-resources/events/default.json',
      'bundle/logs/app/app.log',
      'bundle/version.yaml',
      'bundle/cluster-info/cluster_version.json',
      'bundle/random.txt',
    ]);

    const profile = await profileBundle(manifest);

    expect(profile.artifactsByCategory.analyzer).toBe(1);
    expect(profile.artifactsByCategory['kubernetes-resource']).toBe(2);
    expect(profile.artifactsByCategory.event).toBe(1);
    expect(profile.artifactsByCategory.log).toBe(1);
    expect(profile.artifactsByCategory['cluster-info']).toBe(2);
    expect(profile.artifactsByCategory.unknown).toBe(1);

    // Convenience top-level counts
    expect(profile.analyzerCount).toBe(1);
    expect(profile.resourceCount).toBe(2);
    expect(profile.eventCount).toBe(1);
    expect(profile.logFileCount).toBe(1);
  });

  it('extracts namespace list from resource paths', async () => {
    const manifest = makeManifest([
      'bundle/cluster-resources/pods/default/pod.yaml',
      'bundle/cluster-resources/deployments/production/dep.yaml',
      'bundle/cluster-resources/services/staging/svc.yaml',
      'bundle/cluster-resources/events/kube-system.json',
    ]);

    const profile = await profileBundle(manifest);

    // Namespaces are sorted alphabetically
    expect(profile.namespaces).toEqual(['default', 'kube-system', 'production', 'staging']);
  });

  it('deduplicates namespaces that appear in multiple resource files', async () => {
    const manifest = makeManifest([
      'bundle/cluster-resources/pods/default/pod-a.yaml',
      'bundle/cluster-resources/pods/default/pod-b.yaml',
      'bundle/cluster-resources/deployments/default/dep.yaml',
    ]);

    const profile = await profileBundle(manifest);

    expect(profile.namespaces).toEqual(['default']);
  });

  it('identifies coverage gap when no analyzer results are present', async () => {
    const manifest = makeManifest([
      'bundle/cluster-resources/pods/default/pod.yaml',
      'bundle/logs/app/app.log',
      'bundle/cluster-resources/events/default.json',
    ]);

    const profile = await profileBundle(manifest);

    expect(profile.coverageGaps).toContain('No analyzer results found');
  });

  it('identifies coverage gap when no event data is present', async () => {
    const manifest = makeManifest([
      'bundle/analyzers/output.json',
      'bundle/cluster-resources/pods/default/pod.yaml',
      'bundle/logs/app/app.log',
    ]);

    const profile = await profileBundle(manifest);

    expect(profile.coverageGaps).toContain('No event data found');
  });

  it('identifies coverage gap when no log files are present', async () => {
    const manifest = makeManifest([
      'bundle/analyzers/output.json',
      'bundle/cluster-resources/pods/default/pod.yaml',
      'bundle/cluster-resources/events/default.json',
    ]);

    const profile = await profileBundle(manifest);

    expect(profile.coverageGaps).toContain('No log files found');
  });

  it('identifies coverage gap when no Kubernetes resources are present', async () => {
    const manifest = makeManifest([
      'bundle/analyzers/output.json',
      'bundle/logs/app/app.log',
    ]);

    const profile = await profileBundle(manifest);

    expect(profile.coverageGaps).toContain('No Kubernetes resources found');
    expect(profile.coverageGaps).toContain('No event data found');
  });

  it('reports no coverage gaps for a well-populated bundle', async () => {
    const manifest = makeManifest([
      'bundle/analyzers/output.json',
      'bundle/cluster-resources/pods/default/pod.yaml',
      'bundle/cluster-resources/events/default.json',
      'bundle/logs/app/app.log',
    ]);

    const profile = await profileBundle(manifest);

    expect(profile.coverageGaps).toHaveLength(0);
  });

  it('includes workload summary stubs for deployment resources', async () => {
    const manifest = makeManifest([
      'bundle/cluster-resources/deployments/default/app-deployment.yaml',
      'bundle/cluster-resources/deployments/production/api-deployment.yaml',
      'bundle/cluster-resources/statefulsets/default/db-statefulset.yaml',
    ]);

    const profile = await profileBundle(manifest);

    expect(profile.workloads).toHaveLength(3);

    const appDep = profile.workloads.find((w) => w.name === 'app-deployment');
    expect(appDep).toBeDefined();
    expect(appDep?.namespace).toBe('default');
    expect(appDep?.kind).toBe('deployments');

    const apiDep = profile.workloads.find((w) => w.name === 'api-deployment');
    expect(apiDep?.namespace).toBe('production');

    const db = profile.workloads.find((w) => w.name === 'db-statefulset');
    expect(db?.kind).toBe('statefulsets');
  });

  it('does not include non-workload resources (services, configmaps) in workload summaries', async () => {
    const manifest = makeManifest([
      'bundle/cluster-resources/services/default/svc.yaml',
      'bundle/cluster-resources/configmaps/default/cm.yaml',
      'bundle/cluster-resources/deployments/default/app.yaml',
    ]);

    const profile = await profileBundle(manifest);

    // Only deployments should appear — not services or configmaps
    expect(profile.workloads).toHaveLength(1);
    expect(profile.workloads[0]?.kind).toBe('deployments');
  });

  it('stores classified entries in the returned manifest', async () => {
    const manifest = makeManifest([
      'bundle/analyzers/output.json',
      'bundle/logs/app/app.log',
      'bundle/version.yaml',
    ]);

    const profile = await profileBundle(manifest);

    const analyzerEntry = profile.manifest.files.find((f) =>
      f.relativePath.includes('analyzers'),
    );
    const logEntry = profile.manifest.files.find((f) => f.relativePath.includes('logs'));
    const versionEntry = profile.manifest.files.find((f) =>
      f.relativePath.endsWith('version.yaml'),
    );

    expect(analyzerEntry?.category).toBe('analyzer');
    expect(logEntry?.category).toBe('log');
    expect(versionEntry?.category).toBe('cluster-info');
  });

  it('handles an empty manifest without throwing', async () => {
    const manifest = makeManifest([]);
    const profile = await profileBundle(manifest);

    expect(profile.namespaces).toHaveLength(0);
    expect(profile.workloads).toHaveLength(0);
    expect(profile.analyzerCount).toBe(0);
    expect(profile.coverageGaps.length).toBeGreaterThan(0);
  });
});
