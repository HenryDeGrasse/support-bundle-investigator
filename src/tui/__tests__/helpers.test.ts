// ---------------------------------------------------------------------------
// TUI helper tests
//
// Pure-function tests for src/tui/helpers.ts. No mocking needed — all
// functions are deterministic transformations over primitive inputs.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import {
  severityColor,
  sourceTag,
  truncateTitle,
  confidenceBar,
  evidenceIcon,
  formatSeverityLabel,
  extractDifferentialContext,
  formatCausalChain,
  formatConfidenceWithQuality,
} from '../helpers.js';
import type { FindingTreeNode } from '../../types/index.js';

// ---------------------------------------------------------------------------
// severityColor
// ---------------------------------------------------------------------------

describe('severityColor()', () => {
  it('maps critical to red', () => {
    expect(severityColor('critical')).toBe('red');
  });

  it('maps high to yellow', () => {
    expect(severityColor('high')).toBe('yellow');
  });

  it('maps medium to cyan', () => {
    expect(severityColor('medium')).toBe('cyan');
  });

  it('maps low to blue', () => {
    expect(severityColor('low')).toBe('blue');
  });

  it('maps info to gray', () => {
    expect(severityColor('info')).toBe('gray');
  });
});

// ---------------------------------------------------------------------------
// formatSeverityLabel
// ---------------------------------------------------------------------------

describe('formatSeverityLabel()', () => {
  it('returns CRITICAL for critical', () => {
    expect(formatSeverityLabel('critical')).toBe('CRITICAL');
  });

  it('returns HIGH for high', () => {
    expect(formatSeverityLabel('high')).toBe('HIGH');
  });

  it('returns MEDIUM for medium', () => {
    expect(formatSeverityLabel('medium')).toBe('MEDIUM');
  });

  it('returns LOW for low', () => {
    expect(formatSeverityLabel('low')).toBe('LOW');
  });

  it('returns INFO for info', () => {
    expect(formatSeverityLabel('info')).toBe('INFO');
  });
});

// ---------------------------------------------------------------------------
// sourceTag
// ---------------------------------------------------------------------------

describe('sourceTag()', () => {
  it('returns K8S for finding:k8s: prefix', () => {
    expect(sourceTag('finding:k8s:pod-not-ready')).toBe('K8S');
  });

  it('returns LOG for finding:log: prefix', () => {
    expect(sourceTag('finding:log:crashloop')).toBe('LOG');
  });

  it('returns CFG for finding:config: prefix', () => {
    expect(sourceTag('finding:config:missing-configmap')).toBe('CFG');
  });

  it('returns AI for finding:ai: prefix', () => {
    expect(sourceTag('finding:ai:root-cause')).toBe('AI');
  });

  it('returns HYP for finding:hypothesis: prefix', () => {
    expect(sourceTag('finding:hypothesis:dns-failure:1')).toBe('HYP');
  });

  it('returns SBI as fallback for unrecognised prefix', () => {
    expect(sourceTag('finding:unknown:something')).toBe('SBI');
  });
});

// ---------------------------------------------------------------------------
// truncateTitle
// ---------------------------------------------------------------------------

describe('truncateTitle()', () => {
  it('returns original string when within the limit', () => {
    expect(truncateTitle('Hello', 10)).toBe('Hello');
  });

  it('returns original string when exactly at the limit', () => {
    expect(truncateTitle('Hello', 5)).toBe('Hello');
  });

  it('truncates with an ellipsis when over the limit', () => {
    const result = truncateTitle('Hello World', 8);
    expect(result).toBe('Hello W…');
    expect(result.length).toBe(8);
  });

  it('handles empty string input', () => {
    expect(truncateTitle('', 5)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// confidenceBar
// ---------------------------------------------------------------------------

describe('confidenceBar()', () => {
  it('renders 0 as "0%"', () => {
    expect(confidenceBar(0)).toBe('0%');
  });

  it('renders 0.5 as "50%"', () => {
    expect(confidenceBar(0.5)).toBe('50%');
  });

  it('renders 0.95 as "95%"', () => {
    expect(confidenceBar(0.95)).toBe('95%');
  });

  it('renders 1.0 as "100%"', () => {
    expect(confidenceBar(1.0)).toBe('100%');
  });
});

// ---------------------------------------------------------------------------
// evidenceIcon
// ---------------------------------------------------------------------------

describe('evidenceIcon()', () => {
  it('returns LOG for log', () => {
    expect(evidenceIcon('log')).toBe('LOG');
  });

  it('returns K8S for kubernetes-resource', () => {
    expect(evidenceIcon('kubernetes-resource')).toBe('K8S');
  });

  it('returns EVT for event', () => {
    expect(evidenceIcon('event')).toBe('EVT');
  });

  it('returns ANL for analyzer', () => {
    expect(evidenceIcon('analyzer')).toBe('ANL');
  });

  it('returns HLM for helm-release', () => {
    expect(evidenceIcon('helm-release')).toBe('HLM');
  });

  it('returns --- for unrecognised artifact type', () => {
    expect(evidenceIcon('cluster-info')).toBe('---');
  });

  it('returns --- when artifactType is undefined', () => {
    expect(evidenceIcon(undefined)).toBe('---');
  });
});

// ---------------------------------------------------------------------------
// extractDifferentialContext
// ---------------------------------------------------------------------------

describe('extractDifferentialContext()', () => {
  // ── Fixtures ─────────────────────────────────────────────────────────────

  const withRunnerUp =
    '[Differential diagnosis, rank #1] Root cause: DNS resolution failure for "api" service. ' +
    'Symptom: Pod crashloop. ' +
    'Confidence rationale: Confidence 0.85: 3 supporting evidence items. ' +
    'Preferred over runner-up "Missing Secret" (45%) due to higher calibrated confidence (85% vs 45%). ' +
    'Derived from 2 raw finding(s): finding:k8s:pod-not-ready, finding:log:dns-error.';

  const withoutRunnerUp =
    '[Differential diagnosis, rank #2] Root cause: Image pull failure due to bad tag. ' +
    'Symptom: ErrImagePull. ' +
    'Confidence rationale: Confidence 0.60: 2 supporting evidence items.';

  // ── Rank extraction ───────────────────────────────────────────────────────

  it('extracts rank #1 from bracket prefix', () => {
    const result = extractDifferentialContext(withRunnerUp);
    expect(result.rank).toBe('rank #1');
  });

  it('extracts rank #2 from second-ranked finding', () => {
    const result = extractDifferentialContext(withoutRunnerUp);
    expect(result.rank).toBe('rank #2');
  });

  it('returns empty rank when no differential prefix is present', () => {
    const plain = 'Root cause: Config map missing. Symptom: Pod crash.';
    expect(extractDifferentialContext(plain).rank).toBe('');
  });

  // ── Root cause extraction ─────────────────────────────────────────────────

  it('extracts root cause text from "Root cause:" field', () => {
    const result = extractDifferentialContext(withRunnerUp);
    expect(result.rootCause).toBe('DNS resolution failure for "api" service');
  });

  it('extracts root cause for non-top-ranked finding', () => {
    const result = extractDifferentialContext(withoutRunnerUp);
    expect(result.rootCause).toBe('Image pull failure due to bad tag');
  });

  it('falls back to the full string as rootCause when no "Root cause:" pattern is found', () => {
    const noRootCause = '[Differential diagnosis, rank #1] Some generic explanation.';
    const result = extractDifferentialContext(noRootCause);
    expect(result.rootCause).toBe(noRootCause);
  });

  // ── Runner-up comparison ──────────────────────────────────────────────────

  it('extracts the runner-up comparison sentence when present', () => {
    const result = extractDifferentialContext(withRunnerUp);
    expect(result.runnerUpComparison).not.toBeNull();
    expect(result.runnerUpComparison).toContain('Preferred over runner-up');
    expect(result.runnerUpComparison).toContain('Missing Secret');
  });

  it('returns null for runnerUpComparison when no runner-up sentence is present', () => {
    const result = extractDifferentialContext(withoutRunnerUp);
    expect(result.runnerUpComparison).toBeNull();
  });

  it('runner-up comparison does not include "Derived from" content', () => {
    const result = extractDifferentialContext(withRunnerUp);
    expect(result.runnerUpComparison).not.toContain('Derived from');
  });
});

// ---------------------------------------------------------------------------
// formatCausalChain
// ---------------------------------------------------------------------------

function makeNode(title: string, children: FindingTreeNode[] = []): FindingTreeNode {
  return {
    finding: {
      id: `finding:test:${title.toLowerCase().replace(/\s+/g, '-')}`,
      title,
      severity: 'high',
      confidence: 0.8,
      affectedComponents: ['test'],
      reasoningSummary: 'test',
      evidence: [],
      contradictionsChecked: [],
      recommendedAction: 'none',
      missingEvidence: [],
    },
    children,
  };
}

describe('formatCausalChain()', () => {
  it('formats a single-node (leaf) as just its title', () => {
    const leaf = makeNode('Missing Secret');
    expect(formatCausalChain(leaf)).toBe('Missing Secret');
  });

  it('formats a two-node chain as "A → B"', () => {
    const child = makeNode('CrashLoopBackOff');
    const root = makeNode('Missing Secret', [child]);
    expect(formatCausalChain(root)).toBe('Missing Secret → CrashLoopBackOff');
  });

  it('formats the canonical four-node chain correctly', () => {
    const unhealthy = makeNode('Unhealthy Workload');
    const crashLoop = makeNode('CrashLoopBackOff', [unhealthy]);
    const failedMount = makeNode('FailedMount', [crashLoop]);
    const missingSecret = makeNode('Missing Secret', [failedMount]);

    expect(formatCausalChain(missingSecret)).toBe(
      'Missing Secret → FailedMount → CrashLoopBackOff → Unhealthy Workload',
    );
  });

  it('formats starting from a mid-chain node (sub-chain)', () => {
    const unhealthy = makeNode('Unhealthy Workload');
    const crashLoop = makeNode('CrashLoopBackOff', [unhealthy]);
    const failedMount = makeNode('FailedMount', [crashLoop]);
    // Start from FailedMount, not the root
    expect(formatCausalChain(failedMount)).toBe(
      'FailedMount → CrashLoopBackOff → Unhealthy Workload',
    );
  });

  it('respects maxDepth to avoid runaway traversal', () => {
    // Build a chain 5 deep but set maxDepth=3
    const d5 = makeNode('D5');
    const d4 = makeNode('D4', [d5]);
    const d3 = makeNode('D3', [d4]);
    const d2 = makeNode('D2', [d3]);
    const d1 = makeNode('D1', [d2]);

    const result = formatCausalChain(d1, 3);
    expect(result).toBe('D1 → D2 → D3');
  });

  it('follows only the first child at each level (primary causal path)', () => {
    const sibling1 = makeNode('Sibling1');
    const sibling2 = makeNode('Sibling2');
    // Node with two children — only first child is followed
    const root = makeNode('Root', [sibling1, sibling2]);

    expect(formatCausalChain(root)).toBe('Root → Sibling1');
  });
});

// ---------------------------------------------------------------------------
// formatConfidenceWithQuality
// ---------------------------------------------------------------------------

describe('formatConfidenceWithQuality()', () => {
  it('formats confidence with "strong" quality', () => {
    expect(formatConfidenceWithQuality(0.8, 'strong')).toBe('80% (strong)');
  });

  it('formats confidence with "moderate" quality', () => {
    expect(formatConfidenceWithQuality(0.8, 'moderate')).toBe('80% (moderate)');
  });

  it('formats confidence with "weak" quality', () => {
    expect(formatConfidenceWithQuality(0.8, 'weak')).toBe('80% (weak)');
  });

  it('formats 95% confidence with "strong" quality', () => {
    expect(formatConfidenceWithQuality(0.95, 'strong')).toBe('95% (strong)');
  });

  it('formats 0% confidence with "weak" quality', () => {
    expect(formatConfidenceWithQuality(0, 'weak')).toBe('0% (weak)');
  });

  it('formats 100% confidence with "strong" quality', () => {
    expect(formatConfidenceWithQuality(1.0, 'strong')).toBe('100% (strong)');
  });

  it('falls back to plain percentage when quality is undefined', () => {
    expect(formatConfidenceWithQuality(0.75, undefined)).toBe('75%');
  });

  it('rounds to the nearest integer percent', () => {
    expect(formatConfidenceWithQuality(0.856, 'moderate')).toBe('86% (moderate)');
  });
});
