import type { AnalyzerResult, BundleProfile, K8sEvent, K8sResource } from '../types/index.js';
import type { Finding } from '../types/index.js';
import type { GraphEdge } from '../types/index.js';
import type { LogFile, HelmRelease } from '../parsers/index.js';

// ---------------------------------------------------------------------------
// Seed categories
// ---------------------------------------------------------------------------

/**
 * The kind of investigation that a seed targets.
 *
 * - `kubernetes`    — Pod lifecycle, workload health, events
 * - `log`           — High-importance log files with significant errors
 * - `configuration` — Missing secrets, wrong config values, env mismatches
 * - `connectivity`  — DNS resolution failures, unreachable endpoints, networking
 */
export type SeedCategory = 'kubernetes' | 'log' | 'configuration' | 'connectivity';

// ---------------------------------------------------------------------------
// InvestigationSeed
// ---------------------------------------------------------------------------

/**
 * A single hypothesis to be investigated, generated from parsed bundle data.
 *
 * Seeds are sorted by {@link priority} (highest first) so investigators work
 * on the most actionable leads first.
 */
export interface InvestigationSeed {
  /** Unique identifier within a seed generation run. */
  id: string;
  /** Human-readable description of what to investigate. */
  hypothesis: string;
  /** Identifier of the artifact or rule that produced the seed. */
  source: string;
  /** Which investigator type this seed targets. */
  category: SeedCategory;
  /** Urgency / importance in [0, 100]. Higher = more important. */
  priority: number;
}

// ---------------------------------------------------------------------------
// InvestigatorContext
// ---------------------------------------------------------------------------

/**
 * All parsed bundle data made available to investigators and the seed
 * generator.  Mirrors the data-bearing fields of `PipelineResult` without
 * the graph or trace — those are pipeline-level concerns.
 */
export interface InvestigatorContext {
  analyzerResults: AnalyzerResult[];
  resources: K8sResource[];
  events: K8sEvent[];
  logs: LogFile[];
  profile: BundleProfile;
  /**
   * Maps each parsed K8sResource to the relative source file path it was
   * loaded from (e.g. `cluster-resources/pods/default.json`).  Used by
   * `buildChunkIndex` to set accurate `artifactId` values instead of
   * fabricating a per-resource path.
   *
   * Optional: when absent, `buildChunkIndex` falls back to a constructed path.
   */
  resourceSourceFiles?: Map<K8sResource, string>;
  /**
   * Helm releases parsed from `helm-release` classified files in the bundle.
   *
   * Optional: when absent, no Helm release chunks are produced.
   */
  helmReleases?: HelmRelease[];
}

// ---------------------------------------------------------------------------
// InvestigatorResult
// ---------------------------------------------------------------------------

/**
 * What a targeted investigator produces after examining its seeds.
 *
 * - `findings` — evidence-backed diagnosis entries
 * - `edges`    — new graph relationships discovered during investigation
 */
export interface InvestigatorResult {
  findings: Finding[];
  edges: GraphEdge[];
}
