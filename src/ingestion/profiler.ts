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
 * Strips a `.json` or `.yaml`/`.yml` extension from a filename.
 * Returns the input unchanged if it has no recognised extension.
 */
function stripResourceExtension(name: string): string {
  return name.replace(/\.(json|yaml|yml)$/i, '');
}

/**
 * Returns true when the segment looks like a file (has a recognised
 * resource-file extension) rather than a bare directory name.
 */
function isResourceFile(segment: string): boolean {
  return /\.(json|yaml|yml)$/i.test(segment);
}

/**
 * Extracts a namespace string from a classified {@link ArtifactEntry}.
 *
 * Supports two path layouts produced by the Troubleshoot collector:
 *
 * **Flat (real bundles):**
 *   `…/cluster-resources/<kind>/<namespace>.json`
 *
 * **Nested (legacy / test fixtures):**
 *   `…/cluster-resources/<kind>/<namespace>/<file>`
 *
 * **Cluster-scoped resources** (e.g. `cluster-resources/nodes.json`) have
 * no namespace segment and return `undefined`.
 *
 * Returns `undefined` when the path does not conform to any supported
 * structure.
 */
function extractNamespace(entry: ArtifactEntry): string | undefined {
  const segments = entry.relativePath.split('/');
  const crIdx = segments.indexOf('cluster-resources');
  if (crIdx < 0) return undefined;

  const subKind = segments[crIdx + 1];
  if (!subKind) return undefined;

  // Cluster-scoped: cluster-resources/<kind>.json (no namespace at all)
  if (isResourceFile(subKind)) return undefined;

  if (subKind === 'events') {
    // events/<namespace>.json  →  strip extension to get namespace
    const evFile = segments[crIdx + 2];
    if (!evFile) return undefined;
    return stripResourceExtension(evFile) || undefined;
  }

  const namespacePart = segments[crIdx + 2];
  if (!namespacePart) return undefined;

  // Flat layout: <kind>/<namespace>.json  →  strip extension
  if (isResourceFile(namespacePart)) {
    return stripResourceExtension(namespacePart) || undefined;
  }

  // Nested layout: <kind>/<namespace>/<file>  →  namespace is the directory
  return namespacePart || undefined;
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
 * Supports two path layouts:
 * - **Flat:** `cluster-resources/<kind>/<namespace>.json` — the namespace is
 *   derived from the filename; the workload name is set to `<namespace>`
 *   (individual workloads are discovered at parse-time, not from paths).
 * - **Nested:** `cluster-resources/<kind>/<namespace>/<file>` — name comes
 *   from the file, namespace from the directory.
 *
 * Returns `undefined` for non-workload resources (e.g. services, configmaps).
 */
function buildWorkloadSummary(entry: ArtifactEntry): WorkloadSummary | undefined {
  const segments = entry.relativePath.split('/');
  const crIdx = segments.indexOf('cluster-resources');
  if (crIdx < 0) return undefined;

  const kind = segments[crIdx + 1];
  if (!kind || !WORKLOAD_KINDS.has(kind)) return undefined;

  const namespacePart = segments[crIdx + 2];
  if (!namespacePart) return undefined;

  // ── Flat layout: cluster-resources/<kind>/<namespace>.json ─────────────
  if (isResourceFile(namespacePart) && segments.length === crIdx + 3) {
    const namespace = stripResourceExtension(namespacePart);
    if (!namespace) return undefined;
    // In flat layout, the file contains a List with many workloads — we
    // represent it as a single placeholder stub per namespace file. The
    // actual workload names are resolved at parse time when the List items
    // are unwrapped.
    return { name: `${kind}/${namespace}`, namespace, kind };
  }

  // ── Nested layout: cluster-resources/<kind>/<namespace>/<file> ─────────
  const namespace = namespacePart;
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
