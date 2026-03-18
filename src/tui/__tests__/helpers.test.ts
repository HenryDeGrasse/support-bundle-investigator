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
} from '../helpers.js';

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
  it('returns 📄 for log', () => {
    expect(evidenceIcon('log')).toBe('📄');
  });

  it('returns ⎈ for kubernetes-resource', () => {
    expect(evidenceIcon('kubernetes-resource')).toBe('⎈');
  });

  it('returns ⚡ for event', () => {
    expect(evidenceIcon('event')).toBe('⚡');
  });

  it('returns 🔍 for analyzer', () => {
    expect(evidenceIcon('analyzer')).toBe('🔍');
  });

  it('returns ⚙ for config', () => {
    expect(evidenceIcon('config')).toBe('⚙');
  });

  it('returns ⎈ for helm-release', () => {
    expect(evidenceIcon('helm-release')).toBe('⎈');
  });

  it('returns 📎 for unrecognised artifact type', () => {
    expect(evidenceIcon('cluster-info')).toBe('📎');
  });

  it('returns 📎 when artifactType is undefined', () => {
    expect(evidenceIcon(undefined)).toBe('📎');
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
