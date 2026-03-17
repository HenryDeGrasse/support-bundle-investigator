import { describe, it, expect } from 'vitest';
import { validateAIFindings } from '../schemas.js';
import type { AIFinding } from '../schemas.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: 'CrashLoopBackOff: Pod api-server',
    severity: 'critical',
    confidence: 0.9,
    affectedComponents: ['Pod/default/api-server'],
    reasoningSummary: 'The pod is in CrashLoopBackOff with 8 restarts.',
    evidence: [
      {
        path: 'cluster-resources/pods/default/api-server.json',
        note: 'Container waiting state: CrashLoopBackOff',
      },
    ],
    contradictionsChecked: ['Restart count is non-zero'],
    recommendedAction: 'Check container logs with kubectl logs.',
    missingEvidence: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Basic validation
// ---------------------------------------------------------------------------

describe('validateAIFindings — basic', () => {
  it('returns empty array for null input', () => {
    expect(validateAIFindings(null)).toHaveLength(0);
  });

  it('returns empty array for undefined input', () => {
    expect(validateAIFindings(undefined)).toHaveLength(0);
  });

  it('returns empty array for plain object input', () => {
    expect(validateAIFindings({})).toHaveLength(0);
  });

  it('returns empty array for string input', () => {
    expect(validateAIFindings('string')).toHaveLength(0);
  });

  it('returns empty array for number input', () => {
    expect(validateAIFindings(42)).toHaveLength(0);
  });

  it('returns empty array for empty array', () => {
    expect(validateAIFindings([])).toHaveLength(0);
  });

  it('parses a fully valid finding correctly', () => {
    const findings = validateAIFindings([validRaw()]);
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.title).toBe('CrashLoopBackOff: Pod api-server');
    expect(f.severity).toBe('critical');
    expect(f.confidence).toBe(0.9);
    expect(f.affectedComponents).toEqual(['Pod/default/api-server']);
    expect(f.reasoningSummary).toBe('The pod is in CrashLoopBackOff with 8 restarts.');
    expect(f.recommendedAction).toBe('Check container logs with kubectl logs.');
    expect(f.contradictionsChecked).toEqual(['Restart count is non-zero']);
    expect(f.missingEvidence).toEqual([]);
  });

  it('drops non-object items in array', () => {
    const findings = validateAIFindings([validRaw(), 'string', 42, null, true]);
    expect(findings).toHaveLength(1);
  });

  it('returns typed AIFinding array', () => {
    const findings = validateAIFindings([validRaw()]);
    // TypeScript compile check — the result should be AIFinding[]
    const f: AIFinding = findings[0]!;
    expect(f.title).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Required field validation — title
// ---------------------------------------------------------------------------

describe('validateAIFindings — title validation', () => {
  it('drops findings with undefined title', () => {
    expect(validateAIFindings([validRaw({ title: undefined })])).toHaveLength(0);
  });

  it('drops findings with null title', () => {
    expect(validateAIFindings([validRaw({ title: null })])).toHaveLength(0);
  });

  it('drops findings with empty string title', () => {
    expect(validateAIFindings([validRaw({ title: '' })])).toHaveLength(0);
  });

  it('drops findings with whitespace-only title', () => {
    expect(validateAIFindings([validRaw({ title: '   ' })])).toHaveLength(0);
  });

  it('drops findings with numeric title', () => {
    expect(validateAIFindings([validRaw({ title: 42 })])).toHaveLength(0);
  });

  it('trims title whitespace', () => {
    const findings = validateAIFindings([validRaw({ title: '  My Finding  ' })]);
    expect(findings[0]!.title).toBe('My Finding');
  });
});

// ---------------------------------------------------------------------------
// Required field validation — severity
// ---------------------------------------------------------------------------

describe('validateAIFindings — severity validation', () => {
  it('accepts all valid severity values', () => {
    const severities = ['critical', 'high', 'medium', 'low', 'info'];
    for (const severity of severities) {
      const findings = validateAIFindings([validRaw({ severity })]);
      expect(findings).toHaveLength(1);
      expect(findings[0]!.severity).toBe(severity);
    }
  });

  it('drops findings with invalid severity string', () => {
    expect(validateAIFindings([validRaw({ severity: 'catastrophic' })])).toHaveLength(0);
  });

  it('drops findings with undefined severity', () => {
    expect(validateAIFindings([validRaw({ severity: undefined })])).toHaveLength(0);
  });

  it('drops findings with numeric severity', () => {
    expect(validateAIFindings([validRaw({ severity: 5 })])).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Required field validation — confidence
// ---------------------------------------------------------------------------

describe('validateAIFindings — confidence validation', () => {
  it('drops findings with string confidence', () => {
    expect(validateAIFindings([validRaw({ confidence: 'high' })])).toHaveLength(0);
  });

  it('drops findings with undefined confidence', () => {
    expect(validateAIFindings([validRaw({ confidence: undefined })])).toHaveLength(0);
  });

  it('drops findings with NaN confidence', () => {
    expect(validateAIFindings([validRaw({ confidence: NaN })])).toHaveLength(0);
  });

  it('accepts confidence at exactly 0', () => {
    expect(validateAIFindings([validRaw({ confidence: 0 })])[0]!.confidence).toBe(0.0);
  });

  it('accepts confidence at exactly 1', () => {
    expect(validateAIFindings([validRaw({ confidence: 1 })])[0]!.confidence).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// Confidence clamping
// ---------------------------------------------------------------------------

describe('validateAIFindings — confidence clamping', () => {
  it('clamps confidence greater than 1 to 1.0', () => {
    const findings = validateAIFindings([validRaw({ confidence: 1.5 })]);
    expect(findings[0]!.confidence).toBe(1.0);
  });

  it('clamps confidence less than 0 to 0.0', () => {
    const findings = validateAIFindings([validRaw({ confidence: -0.5 })]);
    expect(findings[0]!.confidence).toBe(0.0);
  });

  it('clamps large overconfidence to 1.0', () => {
    const findings = validateAIFindings([validRaw({ confidence: 99 })]);
    expect(findings[0]!.confidence).toBe(1.0);
  });

  it('preserves mid-range confidence unchanged', () => {
    const findings = validateAIFindings([validRaw({ confidence: 0.75 })]);
    expect(findings[0]!.confidence).toBe(0.75);
  });
});

// ---------------------------------------------------------------------------
// Required field validation — reasoningSummary and recommendedAction
// ---------------------------------------------------------------------------

describe('validateAIFindings — reasoningSummary and recommendedAction', () => {
  it('drops findings with undefined reasoningSummary', () => {
    expect(
      validateAIFindings([validRaw({ reasoningSummary: undefined })]),
    ).toHaveLength(0);
  });

  it('drops findings with numeric reasoningSummary', () => {
    expect(validateAIFindings([validRaw({ reasoningSummary: 42 })])).toHaveLength(0);
  });

  it('drops findings with undefined recommendedAction', () => {
    expect(
      validateAIFindings([validRaw({ recommendedAction: undefined })]),
    ).toHaveLength(0);
  });

  it('drops findings with numeric recommendedAction', () => {
    expect(validateAIFindings([validRaw({ recommendedAction: 0 })])).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Evidence validation
// ---------------------------------------------------------------------------

describe('validateAIFindings — evidence', () => {
  it('keeps evidence items with non-empty paths', () => {
    const findings = validateAIFindings([
      validRaw({
        evidence: [
          { path: 'cluster-resources/pods/default/app.json', note: 'Pod status' },
        ],
      }),
    ]);
    expect(findings[0]!.evidence).toHaveLength(1);
    expect(findings[0]!.evidence[0]!.path).toBe(
      'cluster-resources/pods/default/app.json',
    );
  });

  it('drops evidence items with missing path', () => {
    const findings = validateAIFindings([
      validRaw({
        evidence: [
          { note: 'No path provided' },
          { path: 'valid/path.json', note: 'Valid evidence' },
        ],
      }),
    ]);
    expect(findings[0]!.evidence).toHaveLength(1);
    expect(findings[0]!.evidence[0]!.path).toBe('valid/path.json');
  });

  it('drops findings whose evidence becomes empty after removing empty paths', () => {
    const findings = validateAIFindings([
      validRaw({ evidence: [{ path: '', note: 'Empty path' }] }),
    ]);
    expect(findings).toHaveLength(0);
  });

  it('drops findings whose evidence becomes empty after removing whitespace-only paths', () => {
    const findings = validateAIFindings([
      validRaw({ evidence: [{ path: '   ', note: 'Whitespace path' }] }),
    ]);
    expect(findings).toHaveLength(0);
  });

  it('drops findings whose evidence becomes empty after removing non-object evidence items', () => {
    const findings = validateAIFindings([
      validRaw({ evidence: ['string', 42, null] }),
    ]);
    expect(findings).toHaveLength(0);
  });

  it('preserves valid lineRange as tuple', () => {
    const findings = validateAIFindings([
      validRaw({
        evidence: [{ path: 'test.json', note: 'test', lineRange: [10, 20] }],
      }),
    ]);
    expect(findings[0]!.evidence[0]!.lineRange).toEqual([10, 20]);
  });

  it('omits lineRange when only one element', () => {
    const findings = validateAIFindings([
      validRaw({
        evidence: [{ path: 'test.json', note: 'test', lineRange: [10] }],
      }),
    ]);
    expect(findings[0]!.evidence[0]!.lineRange).toBeUndefined();
  });

  it('omits lineRange when elements are strings', () => {
    const findings = validateAIFindings([
      validRaw({
        evidence: [{ path: 'test.json', note: 'test', lineRange: ['a', 'b'] }],
      }),
    ]);
    expect(findings[0]!.evidence[0]!.lineRange).toBeUndefined();
  });

  it('drops findings with missing evidence array', () => {
    const findings = validateAIFindings([validRaw({ evidence: undefined })]);
    expect(findings).toHaveLength(0);
  });

  it('drops findings with non-array evidence value', () => {
    const findings = validateAIFindings([validRaw({ evidence: 'not-array' })]);
    expect(findings).toHaveLength(0);
  });

  it('trims evidence notes', () => {
    const findings = validateAIFindings([
      validRaw({
        evidence: [{ path: 'test.json', note: '  citeable detail  ' }],
      }),
    ]);
    expect(findings[0]!.evidence[0]!.note).toBe('citeable detail');
  });

  it('omits lineRange when start line is greater than end line', () => {
    const findings = validateAIFindings([
      validRaw({
        evidence: [{ path: 'test.json', note: 'test', lineRange: [20, 10] }],
      }),
    ]);
    expect(findings[0]!.evidence[0]!.lineRange).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Optional string arrays
// ---------------------------------------------------------------------------

describe('validateAIFindings — optional string arrays', () => {
  it('defaults affectedComponents to empty array when absent', () => {
    const findings = validateAIFindings([validRaw({ affectedComponents: undefined })]);
    expect(findings[0]!.affectedComponents).toEqual([]);
  });

  it('defaults contradictionsChecked to empty array when absent', () => {
    const findings = validateAIFindings([
      validRaw({ contradictionsChecked: undefined }),
    ]);
    expect(findings[0]!.contradictionsChecked).toEqual([]);
  });

  it('defaults missingEvidence to empty array when absent', () => {
    const findings = validateAIFindings([validRaw({ missingEvidence: undefined })]);
    expect(findings[0]!.missingEvidence).toEqual([]);
  });

  it('filters non-string items from affectedComponents', () => {
    const findings = validateAIFindings([
      validRaw({
        affectedComponents: ['Pod/default/app', 42, null, 'Container/app'],
      }),
    ]);
    expect(findings[0]!.affectedComponents).toEqual([
      'Pod/default/app',
      'Container/app',
    ]);
  });

  it('filters non-string items from missingEvidence', () => {
    const findings = validateAIFindings([
      validRaw({ missingEvidence: ['missing log file', 99, 'missing event'] }),
    ]);
    expect(findings[0]!.missingEvidence).toEqual(['missing log file', 'missing event']);
  });
});

// ---------------------------------------------------------------------------
// Optional fields
// ---------------------------------------------------------------------------

describe('validateAIFindings — optional fields', () => {
  it('includes rootCauseClass when present and non-empty', () => {
    const findings = validateAIFindings([
      validRaw({ rootCauseClass: 'crashloop' }),
    ]);
    expect(findings[0]!.rootCauseClass).toBe('crashloop');
  });

  it('omits rootCauseClass when absent', () => {
    const findings = validateAIFindings([validRaw()]);
    expect(findings[0]!.rootCauseClass).toBeUndefined();
  });

  it('omits rootCauseClass when empty string', () => {
    const findings = validateAIFindings([validRaw({ rootCauseClass: '' })]);
    expect(findings[0]!.rootCauseClass).toBeUndefined();
  });

  it('trims rootCauseClass', () => {
    const findings = validateAIFindings([
      validRaw({ rootCauseClass: '  config-typo  ' }),
    ]);
    expect(findings[0]!.rootCauseClass).toBe('config-typo');
  });

  it('includes counterevidence when non-empty', () => {
    const findings = validateAIFindings([
      validRaw({ counterevidence: ['Pod was briefly healthy'] }),
    ]);
    expect(findings[0]!.counterevidence).toEqual(['Pod was briefly healthy']);
  });

  it('omits counterevidence when empty array', () => {
    const findings = validateAIFindings([validRaw({ counterevidence: [] })]);
    expect(findings[0]!.counterevidence).toBeUndefined();
  });

  it('omits counterevidence when absent', () => {
    const findings = validateAIFindings([validRaw()]);
    expect(findings[0]!.counterevidence).toBeUndefined();
  });

  it('filters non-string items from counterevidence', () => {
    const findings = validateAIFindings([
      validRaw({ counterevidence: ['valid', 42, 'also valid'] }),
    ]);
    expect(findings[0]!.counterevidence).toEqual(['valid', 'also valid']);
  });
});

// ---------------------------------------------------------------------------
// Multiple findings
// ---------------------------------------------------------------------------

describe('validateAIFindings — multiple findings', () => {
  it('validates multiple valid findings', () => {
    const raw = [
      validRaw({ title: 'Finding 1', severity: 'critical' }),
      validRaw({ title: 'Finding 2', severity: 'high' }),
    ];
    const findings = validateAIFindings(raw);
    expect(findings).toHaveLength(2);
    expect(findings[0]!.title).toBe('Finding 1');
    expect(findings[1]!.title).toBe('Finding 2');
  });

  it('keeps valid findings and drops invalid ones in mixed input', () => {
    const raw = [
      validRaw({ title: 'Valid' }),
      validRaw({ title: '' }),
      validRaw({ title: 'Also Valid' }),
    ];
    const findings = validateAIFindings(raw);
    expect(findings).toHaveLength(2);
    expect(findings[0]!.title).toBe('Valid');
    expect(findings[1]!.title).toBe('Also Valid');
  });

  it('returns empty array when all findings are invalid', () => {
    const raw = [
      validRaw({ title: '' }),
      validRaw({ severity: 'unknown' }),
      validRaw({ confidence: 'high' }),
    ];
    expect(validateAIFindings(raw)).toHaveLength(0);
  });
});
