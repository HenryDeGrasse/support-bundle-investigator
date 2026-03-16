import type { ArtifactCategory } from './bundle.js';

export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface Evidence {
  path: string;
  note: string;
  artifactType?: ArtifactCategory;
  timestamp?: string;
}

export interface Finding {
  id: string;
  title: string;
  severity: FindingSeverity;
  /** Confidence score in the range [0, 1] */
  confidence: number;
  affectedComponents: string[];
  reasoningSummary: string;
  evidence: Evidence[];
  contradictionsChecked: string[];
  recommendedAction: string;
  missingEvidence: string[];
}
