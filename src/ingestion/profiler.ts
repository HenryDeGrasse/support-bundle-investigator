import type {
  ArtifactCategory,
  ArtifactEntry,
  BundleManifest,
  BundleProfile,
  WorkloadSummary,
} from '../types/index.js';
import { classifyArtifact } from './classifier.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns a zero-initialised count map for every {@link ArtifactCategory}.
 */
function zeroCounts(): Record<ArtifactCategory, number> {
  return {
    analyzer: 0,
    log: 0,
    'kubernetes-resource': 0,
    event: 0,
    config: 0,
    'cluster-info': 0,
    'helm-release': 0,
    unknown: 0,
  };
}

/**
 * Extracts a namespace string from a classified {@link ArtifactEntry}.
 *
 * - For kubernetes-resource files the path structure is:
 *   `…/cluster-resources/<kind>/<namespace>/<file>`
 * - For event files the path structure is:
 *   `…/cluster-resources/events/<namespace>.{json,yaml}`
 *
 * Returns `undefined` when the path does not conform to either structure.
 */
function extractNamespace(entry: ArtifactEntry): string | undefined {
  const segments = entry.relativePath.split('/');
  const crIdx = segments.indexOf('cluster-resources');
  if (crIdx < 0) return undefined;

  const subKind = segments[crIdx + 1];
  if (!subKind) return undefined;

  if (subKind === 'events') {
    // events/<namespace>.json  →  strip extension to get namespace
    const evFile = segments[crIdx + 2];
    if (!evFile) return undefined;
    return evFile.replace(/\.(json|yaml)$/i, '') || undefined;
  }

  // <kind>/<namespace>/<file>  →  namespace is the directory
  const ns = segments[crIdx + 2];
  return ns || undefined;
}

/**
 * Kinds (as they appear in `cluster-resources/<kind>/` paths) that represent
 * workload controllers and should appear in the workload summary.
 */
const WORKLOAD_KINDS = new Set([
  'deployments',
  'statefulsets',
  'daemonsets',
  'replicasets',
  'jobs',
  'cronjobs',
]);

/**
 * Attempts to build a {@link WorkloadSummary} stub from a kubernetes-resource
 * entry whose sub-kind is a recognised workload controller.
 *
 * Returns `undefined` for non-workload resources (e.g. services, configmaps).
 */
function buildWorkloadSummary(entry: ArtifactEntry): WorkloadSummary | undefined {
  const segments = entry.relativePath.split('/');
  const crIdx = segments.indexOf('cluster-resources');
  if (crIdx < 0) return undefined;

  const kind = segments[crIdx + 1];
  if (!kind || !WORKLOAD_KINDS.has(kind)) return undefined;

  const namespace = segments[crIdx + 2];
  if (!namespace) return undefined;

  const filename = segments[segments.length - 1] ?? '';
  const name = filename.replace(/\.(yaml|json)$/i, '');
  if (!name) return undefined;

  return { name, namespace, kind };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Profiles a {@link BundleManifest} by classifying every artifact, counting
 * by category, extracting namespace information, building workload summaries,
 * and identifying coverage gaps.
 *
 * The returned {@link BundleProfile} contains an updated manifest where every
 * {@link ArtifactEntry} has its `category` field populated.
 *
 * @param manifest - The raw manifest produced by `buildManifest` (categories
 *                   are typically `'unknown'` at this stage).
 * @returns A fully populated {@link BundleProfile}.
 */
export async function profileBundle(manifest: BundleManifest): Promise<BundleProfile> {
  // ── 1. Classify every entry ───────────────────────────────────────────────
  const classifiedFiles: ArtifactEntry[] = manifest.files.map((entry) => ({
    ...entry,
    category: classifyArtifact(entry),
  }));

  const updatedManifest: BundleManifest = { ...manifest, files: classifiedFiles };

  // ── 2. Count by category ──────────────────────────────────────────────────
  const artifactsByCategory = zeroCounts();
  for (const file of classifiedFiles) {
    artifactsByCategory[file.category]++;
  }

  // ── 3. Extract namespaces ─────────────────────────────────────────────────
  const namespaceSet = new Set<string>();
  for (const file of classifiedFiles) {
    if (file.category === 'kubernetes-resource' || file.category === 'event') {
      const ns = extractNamespace(file);
      if (ns) namespaceSet.add(ns);
    }
  }

  // ── 4. Build workload summaries ───────────────────────────────────────────
  const workloads: WorkloadSummary[] = [];
  for (const file of classifiedFiles) {
    if (file.category === 'kubernetes-resource') {
      const summary = buildWorkloadSummary(file);
      if (summary) workloads.push(summary);
    }
  }

  // ── 5. Identify coverage gaps ─────────────────────────────────────────────
  const coverageGaps: string[] = [];
  if (artifactsByCategory.analyzer === 0) {
    coverageGaps.push('No analyzer results found');
  }
  if (artifactsByCategory.event === 0) {
    coverageGaps.push('No event data found');
  }
  if (artifactsByCategory.log === 0) {
    coverageGaps.push('No log files found');
  }
  if (artifactsByCategory['kubernetes-resource'] === 0) {
    coverageGaps.push('No Kubernetes resources found');
  }

  return {
    manifest: updatedManifest,
    analyzerCount: artifactsByCategory.analyzer,
    logFileCount: artifactsByCategory.log,
    resourceCount: artifactsByCategory['kubernetes-resource'],
    eventCount: artifactsByCategory.event,
    namespaces: Array.from(namespaceSet).sort(),
    workloads,
    coverageGaps,
    artifactsByCategory,
  };
}
