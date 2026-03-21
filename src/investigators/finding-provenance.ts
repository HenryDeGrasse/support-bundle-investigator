import type {
  Finding,
  FindingInvestigator,
  FindingProvenance,
} from '../types/index.js';
import type { InvestigationSeed } from './types.js';

export interface ApplyFindingProvenanceOptions {
  investigator?: FindingInvestigator;
  seed?: InvestigationSeed;
  generatedAt?: string;
  mergedFrom?: string[];
  hypothesisFamily?: string;
  confidenceDelta?: number;
}

export interface ApplyBatchFindingProvenanceOptions {
  investigator: FindingInvestigator;
  generatedAt?: string;
  resolveSeed?: (finding: Finding) => InvestigationSeed | undefined;
  resolveHypothesisFamily?: (finding: Finding) => string | undefined;
}

function mergeUniqueStrings(...arrays: Array<ReadonlyArray<string> | undefined>): string[] | undefined {
  const merged: string[] = [];
  const seen = new Set<string>();

  for (const values of arrays) {
    for (const value of values ?? []) {
      if (value.trim().length === 0 || seen.has(value)) {
        continue;
      }
      seen.add(value);
      merged.push(value);
    }
  }

  return merged.length > 0 ? merged : undefined;
}

export function inferFindingInvestigator(finding: Pick<Finding, 'id'>): FindingInvestigator {
  if (finding.id.startsWith('finding:ai:')) return 'ai';
  if (finding.id.startsWith('finding:hypothesis:')) return 'hypothesis';
  if (finding.id.startsWith('finding:log:')) return 'log';
  if (finding.id.startsWith('finding:config:')) return 'config';
  if (finding.id.startsWith('finding:service:')) return 'service';
  if (finding.id.startsWith('finding:netpol:')) return 'network-policy';
  if (finding.id.startsWith('finding:k8s:')) return 'kubernetes';
  return 'graph-causal';
}

export function applyFindingProvenance(
  finding: Finding,
  options: ApplyFindingProvenanceOptions = {},
): Finding {
  const existing = finding.provenance;
  const investigator = options.investigator ?? existing?.investigator ?? inferFindingInvestigator(finding);
  const generatedAt = options.generatedAt ?? existing?.generatedAt ?? new Date().toISOString();

  const provenance: FindingProvenance = {
    investigator,
    generatedAt,
  };

  const seedId = options.seed?.id ?? existing?.seedId;
  if (seedId !== undefined) {
    provenance.seedId = seedId;
  }

  const seedSource = options.seed?.source ?? existing?.seedSource;
  if (seedSource !== undefined) {
    provenance.seedSource = seedSource;
  }

  const mergedFrom = mergeUniqueStrings(existing?.mergedFrom, options.mergedFrom);
  if (mergedFrom !== undefined) {
    provenance.mergedFrom = mergedFrom;
  }

  const hypothesisFamily = options.hypothesisFamily ?? existing?.hypothesisFamily;
  if (hypothesisFamily !== undefined) {
    provenance.hypothesisFamily = hypothesisFamily;
  }

  const confidenceDelta = options.confidenceDelta ?? existing?.confidenceDelta;
  if (confidenceDelta !== undefined) {
    provenance.confidenceDelta = confidenceDelta;
  }

  return {
    ...finding,
    provenance,
  };
}

export function applyBatchFindingProvenance(
  findings: Finding[],
  options: ApplyBatchFindingProvenanceOptions,
): Finding[] {
  const generatedAt = options.generatedAt ?? new Date().toISOString();

  return findings.map((finding) =>
    applyFindingProvenance(finding, {
      investigator: options.investigator,
      generatedAt,
      seed: options.resolveSeed?.(finding),
      hypothesisFamily: options.resolveHypothesisFamily?.(finding),
    }),
  );
}

export function collectMergedFindingIds(findings: ReadonlyArray<Finding>): string[] {
  return mergeUniqueStrings(
    ...findings.map((finding) => [finding.id, ...(finding.provenance?.mergedFrom ?? [])]),
  ) ?? [];
}
