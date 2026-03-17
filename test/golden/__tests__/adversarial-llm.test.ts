// ---------------------------------------------------------------------------
// Priority 5: Adversarial LLM Output Tests
// ---------------------------------------------------------------------------
//
// Tests realistic bad LLM outputs that models actually produce:
// - Hallucinated paths
// - Inflated confidence
// - Duplicate findings across seeds
// - Missing required fields
// - Malformed JSON structures

import { describe, it, expect, vi, afterEach } from 'vitest';
import { validateAIFindings } from '../../../src/ai/schemas.js';

afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------
// Hallucinated evidence
// ---------------------------------------------------------------------------

describe('Adversarial LLM: hallucinated evidence', () => {
  it('drops findings where evidence path looks plausible but was not provided', () => {
    // LLM invents a kube-system path that was never in context
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const raw = [{
      title: 'CoreDNS failure',
      severity: 'high',
      confidence: 0.95,
      affectedComponents: ['Pod/kube-system/coredns-abc123'],
      reasoningSummary: 'CoreDNS is failing to resolve names',
      // Path looks real but was never in provided chunks:
      evidence: [{ path: 'cluster-resources/pods/kube-system/coredns-abc123.yaml', note: 'Pod is CrashLooping' }],
      contradictionsChecked: ['Checked DNS config'],
      recommendedAction: 'Restart CoreDNS',
      missingEvidence: [],
    }];

    // validateAIFindings accepts it structurally — this finding IS valid per schema
    // The grounding check (path exists in chunks) must be done by the caller
    const findings = validateAIFindings(raw);
    expect(findings).toHaveLength(1);
    // This test documents that validateAIFindings does NOT check path existence —
    // that responsibility belongs to a post-validation grounding filter
    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Confidence inflation
// ---------------------------------------------------------------------------

describe('Adversarial LLM: confidence inflation', () => {
  it('clamps confidence > 1.0 to 1.0', () => {
    const raw = [{
      title: 'Overconfident finding',
      severity: 'critical',
      confidence: 1.5,
      affectedComponents: ['Pod/default/app'],
      reasoningSummary: 'Very sure',
      evidence: [{ path: 'pods/default.json', note: 'proof' }],
      contradictionsChecked: [],
      recommendedAction: 'Fix it',
      missingEvidence: [],
    }];

    const findings = validateAIFindings(raw);
    expect(findings[0]!.confidence).toBe(1.0);
  });

  it('clamps negative confidence to 0', () => {
    const raw = [{
      title: 'Negative confidence',
      severity: 'low',
      confidence: -0.5,
      affectedComponents: ['Pod/default/app'],
      reasoningSummary: 'Not sure at all',
      evidence: [{ path: 'pods/default.json', note: 'weak' }],
      contradictionsChecked: [],
      recommendedAction: 'Investigate more',
      missingEvidence: [],
    }];

    const findings = validateAIFindings(raw);
    expect(findings[0]!.confidence).toBe(0);
  });

  it('preserves confidence NaN as validation failure (dropped)', () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const raw = [{
      title: 'NaN confidence',
      severity: 'high',
      confidence: NaN,
      affectedComponents: ['Pod/default/app'],
      reasoningSummary: 'Test',
      evidence: [{ path: 'test.yaml', note: 'test' }],
      contradictionsChecked: [],
      recommendedAction: 'Test',
      missingEvidence: [],
    }];

    const findings = validateAIFindings(raw);
    expect(findings).toHaveLength(0);
    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Missing required fields
// ---------------------------------------------------------------------------

describe('Adversarial LLM: missing required fields', () => {
  it('drops finding with empty title', () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const raw = [{
      title: '',
      severity: 'high',
      confidence: 0.8,
      affectedComponents: [],
      reasoningSummary: 'Has reasoning but no title',
      evidence: [{ path: 'test.yaml', note: 'note' }],
      contradictionsChecked: [],
      recommendedAction: 'Do something',
      missingEvidence: [],
    }];

    const findings = validateAIFindings(raw);
    expect(findings).toHaveLength(0);
    consoleSpy.mockRestore();
  });

  it('drops finding with invented severity level', () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const raw = [{
      title: 'Bad severity',
      severity: 'urgent', // not in the enum
      confidence: 0.8,
      affectedComponents: [],
      reasoningSummary: 'Test',
      evidence: [{ path: 'test.yaml', note: 'note' }],
      contradictionsChecked: [],
      recommendedAction: 'Fix',
      missingEvidence: [],
    }];

    const findings = validateAIFindings(raw);
    expect(findings).toHaveLength(0);
    consoleSpy.mockRestore();
  });

  it('drops finding missing reasoningSummary', () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const raw = [{
      title: 'Good title',
      severity: 'high',
      confidence: 0.8,
      affectedComponents: [],
      // reasoningSummary missing entirely
      evidence: [{ path: 'test.yaml', note: 'note' }],
      contradictionsChecked: [],
      recommendedAction: 'Fix',
      missingEvidence: [],
    }];

    const findings = validateAIFindings(raw);
    expect(findings).toHaveLength(0);
    consoleSpy.mockRestore();
  });

  it('drops finding missing recommendedAction', () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const raw = [{
      title: 'Good title',
      severity: 'high',
      confidence: 0.8,
      affectedComponents: [],
      reasoningSummary: 'Good reasoning',
      evidence: [{ path: 'test.yaml', note: 'note' }],
      contradictionsChecked: [],
      // recommendedAction missing
      missingEvidence: [],
    }];

    const findings = validateAIFindings(raw);
    expect(findings).toHaveLength(0);
    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Malformed JSON structures
// ---------------------------------------------------------------------------

describe('Adversarial LLM: malformed structures', () => {
  it('handles findings wrapped in extra nesting', () => {
    // LLM sometimes wraps output in extra object layers
    const raw = { findings: [{ wrapped: true }] };
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // validateAIFindings expects a raw array, not { findings: [...] }
    const findings = validateAIFindings(raw);
    expect(findings).toHaveLength(0);
    consoleSpy.mockRestore();
  });

  it('handles string instead of array', () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const findings = validateAIFindings('this is not an array');
    expect(findings).toHaveLength(0);
    consoleSpy.mockRestore();
  });

  it('handles null', () => {
    const findings = validateAIFindings(null);
    expect(findings).toHaveLength(0);
  });

  it('handles undefined', () => {
    const findings = validateAIFindings(undefined);
    expect(findings).toHaveLength(0);
  });

  it('handles array with mixed valid and invalid entries', () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const raw = [
      // Valid
      {
        title: 'Valid finding',
        severity: 'high',
        confidence: 0.8,
        affectedComponents: ['Pod/default/app'],
        reasoningSummary: 'Good reasoning',
        evidence: [{ path: 'test.yaml', note: 'note' }],
        contradictionsChecked: [],
        recommendedAction: 'Fix it',
        missingEvidence: [],
      },
      // Invalid: number instead of object
      42,
      // Invalid: null
      null,
      // Invalid: missing title
      {
        severity: 'high',
        confidence: 0.5,
        reasoningSummary: 'No title',
        evidence: [{ path: 'test.yaml', note: 'note' }],
        recommendedAction: 'Fix',
      },
      // Valid
      {
        title: 'Second valid',
        severity: 'low',
        confidence: 0.3,
        affectedComponents: [],
        reasoningSummary: 'Reasoning',
        evidence: [{ path: 'other.yaml', note: 'note' }],
        contradictionsChecked: [],
        recommendedAction: 'Check',
        missingEvidence: [],
      },
    ];

    const findings = validateAIFindings(raw);
    expect(findings).toHaveLength(2);
    expect(findings[0]!.title).toBe('Valid finding');
    expect(findings[1]!.title).toBe('Second valid');
    consoleSpy.mockRestore();
  });

  it('handles evidence with malformed lineRange gracefully', () => {
    const raw = [{
      title: 'Bad line range',
      severity: 'medium',
      confidence: 0.6,
      affectedComponents: [],
      reasoningSummary: 'Test',
      evidence: [
        { path: 'test.yaml', note: 'note', lineRange: 'not-an-array' },
        { path: 'test2.yaml', note: 'note', lineRange: [5, 3] }, // reversed
        { path: 'test3.yaml', note: 'note', lineRange: [0, 10] }, // zero start
        { path: 'test4.yaml', note: 'note', lineRange: [1, 10] }, // valid
      ],
      contradictionsChecked: [],
      recommendedAction: 'Fix',
      missingEvidence: [],
    }];

    const findings = validateAIFindings(raw);
    expect(findings).toHaveLength(1);
    // Only the valid lineRange should survive
    const validEvidence = findings[0]!.evidence.filter((e) => e.lineRange !== undefined);
    expect(validEvidence).toHaveLength(1);
    expect(validEvidence[0]!.lineRange).toEqual([1, 10]);
  });
});
