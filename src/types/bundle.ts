export type ArtifactCategory =
  | 'analyzer'
  | 'log'
  | 'kubernetes-resource'
  | 'event'
  | 'cluster-info'
  | 'helm-release'
  | 'unknown';

export interface ArtifactEntry {
  relativePath: string;
  absolutePath: string;
  size: number;
  category: ArtifactCategory;
  mimeType?: string;
}

export interface BundleManifest {
  bundlePath: string;
  extractedPath: string;
  files: ArtifactEntry[];
  totalSize: number;
  extractedAt: Date;
}

export interface WorkloadSummary {
  name: string;
  namespace: string;
  kind: string;
  replicas?: number;
  readyReplicas?: number;
}

export interface BundleProfile {
  manifest: BundleManifest;
  analyzerCount: number;
  logFileCount: number;
  resourceCount: number;
  eventCount: number;
  namespaces: string[];
  workloads: WorkloadSummary[];
  coverageGaps: string[];
  artifactsByCategory: Record<ArtifactCategory, number>;
}
