import { describe, it, expect, afterEach } from 'vitest';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { Finding, FindingSeverity } from '../../types/index.js';
import type { InvestigationReport, SpecRecommendation } from '../types.js';
import { generateJsonReport, writeJsonReport } from '../json-reporter.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'finding:test:0',
    title: 'Test Finding',
    severity: 'high' as FindingSeverity,
    confidence: 0.75,
    affectedComponents: ['web', 'api'],
    reasoningSummary: 'Test reasoning summary.',
    evidence: [
      {
        path: 'logs/app/current.log',
        note: 'lookup db.internal: no such host',
        artifactType: 'log',
        timestamp: '2024-01-01T00:00:00.000Z',
      },
    ],
    contradictionsChecked: ['No successful DB connection logs found'],
    recommendedAction: 'Update the DB host configuration.',
    missingEvidence: ['Kubernetes events for pod app-pod'],
    ...overrides,
  };
}

function makeReport(overrides: Partial<InvestigationReport> = {}): InvestigationReport {
  return {
    executiveSummary: 'A database hostname misconfiguration is causing repeated DNS lookup failures.',
    findings: [makeFinding()],
    rootCause: 'Misconfigured DB hostname in environment variable DB_HOST.',
    evidenceReferences: [
      { path: 'logs/app/current.log', note: 'Repeated DNS lookup failures' },
      { path: 'cluster-resources/services/default/', note: 'No matching Service found' },
    ],
    contradictions: ['No successful DB connection logs found'],
    nextSteps: ['Update the DB host to the correct in-cluster Service name.'],
    missingEvidence: ['Kubernetes events for pod app-pod'],
    specRecommendations: [
      {
        type: 'collector',
        description: 'Add a logs collector to capture container logs.',
        rationale: 'Missing container logs prevent root-cause confirmation.',
      } as SpecRecommendation,
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Section 1: generateJsonReport — top-level structure
// ---------------------------------------------------------------------------

describe('generateJsonReport — output is valid JSON', () => {
  it('returns a string', () => {
    const result = generateJsonReport(makeReport());
    expect(typeof result).toBe('string');
  });

  it('output round-trips through JSON.parse without error', () => {
    const result = generateJsonReport(makeReport());
    expect(() => JSON.parse(result)).not.toThrow();
  });

  it('round-tripped object is a plain object (not null or array)', () => {
    const result = generateJsonReport(makeReport());
    const parsed: unknown = JSON.parse(result);
    expect(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)).toBe(true);
  });
});

describe('generateJsonReport — metadata fields', () => {
  it('includes a schemaVersion field', () => {
    const parsed = JSON.parse(generateJsonReport(makeReport())) as Record<string, unknown>;
    expect(parsed['schemaVersion']).toBeDefined();
    expect(typeof parsed['schemaVersion']).toBe('string');
  });

  it('includes a generatedAt field', () => {
    const parsed = JSON.parse(generateJsonReport(makeReport())) as Record<string, unknown>;
    expect(parsed['generatedAt']).toBeDefined();
    expect(typeof parsed['generatedAt']).toBe('string');
  });

  it('generatedAt is a valid ISO-8601 date string', () => {
    const parsed = JSON.parse(generateJsonReport(makeReport())) as Record<string, unknown>;
    const ts = parsed['generatedAt'] as string;
    const date = new Date(ts);
    expect(Number.isNaN(date.getTime())).toBe(false);
  });
});

describe('generateJsonReport — top-level report fields', () => {
  it('includes executiveSummary', () => {
    const report = makeReport();
    const parsed = JSON.parse(generateJsonReport(report)) as Record<string, unknown>;
    expect(parsed['executiveSummary']).toBe(report.executiveSummary);
  });

  it('includes rootCause when non-null', () => {
    const report = makeReport({ rootCause: 'Misconfigured DB hostname.' });
    const parsed = JSON.parse(generateJsonReport(report)) as Record<string, unknown>;
    expect(parsed['rootCause']).toBe('Misconfigured DB hostname.');
  });

  it('includes rootCause as null when report has no root cause', () => {
    const report = makeReport({ rootCause: null });
    const parsed = JSON.parse(generateJsonReport(report)) as Record<string, unknown>;
    expect(parsed['rootCause']).toBeNull();
  });

  it('includes evidenceReferences array', () => {
    const report = makeReport();
    const parsed = JSON.parse(generateJsonReport(report)) as Record<string, unknown>;
    expect(Array.isArray(parsed['evidenceReferences'])).toBe(true);
    expect((parsed['evidenceReferences'] as unknown[]).length).toBe(
      report.evidenceReferences.length,
    );
  });

  it('includes contradictions array', () => {
    const report = makeReport();
    const parsed = JSON.parse(generateJsonReport(report)) as Record<string, unknown>;
    expect(Array.isArray(parsed['contradictions'])).toBe(true);
  });

  it('includes nextSteps array', () => {
    const report = makeReport();
    const parsed = JSON.parse(generateJsonReport(report)) as Record<string, unknown>;
    expect(Array.isArray(parsed['nextSteps'])).toBe(true);
  });

  it('includes missingEvidence array', () => {
    const report = makeReport();
    const parsed = JSON.parse(generateJsonReport(report)) as Record<string, unknown>;
    expect(Array.isArray(parsed['missingEvidence'])).toBe(true);
  });

  it('includes specRecommendations array', () => {
    const report = makeReport();
    const parsed = JSON.parse(generateJsonReport(report)) as Record<string, unknown>;
    expect(Array.isArray(parsed['specRecommendations'])).toBe(true);
  });

  it('includes findings array', () => {
    const report = makeReport();
    const parsed = JSON.parse(generateJsonReport(report)) as Record<string, unknown>;
    expect(Array.isArray(parsed['findings'])).toBe(true);
    expect((parsed['findings'] as unknown[]).length).toBe(report.findings.length);
  });
});

// ---------------------------------------------------------------------------
// Section 2: generateJsonReport — finding fields
// ---------------------------------------------------------------------------

describe('generateJsonReport — finding field presence', () => {
  function getParsedFinding(): Record<string, unknown> {
    const report = makeReport();
    const parsed = JSON.parse(generateJsonReport(report)) as Record<string, unknown>;
    return (parsed['findings'] as Record<string, unknown>[])[0]!;
  }

  it('finding has id field', () => {
    expect(getParsedFinding()['id']).toBeDefined();
  });

  it('finding has title field', () => {
    expect(getParsedFinding()['title']).toBeDefined();
  });

  it('finding has severity field', () => {
    const f = getParsedFinding();
    expect(f['severity']).toBeDefined();
    expect(['critical', 'high', 'medium', 'low', 'info']).toContain(f['severity']);
  });

  it('finding has confidence field as a number', () => {
    const f = getParsedFinding();
    expect(typeof f['confidence']).toBe('number');
  });

  it('finding has affectedComponents array', () => {
    expect(Array.isArray(getParsedFinding()['affectedComponents'])).toBe(true);
  });

  it('finding has reasoningSummary field', () => {
    expect(typeof getParsedFinding()['reasoningSummary']).toBe('string');
  });

  it('finding has evidence array', () => {
    expect(Array.isArray(getParsedFinding()['evidence'])).toBe(true);
  });

  it('finding has contradictionsChecked array', () => {
    expect(Array.isArray(getParsedFinding()['contradictionsChecked'])).toBe(true);
  });

  it('finding has recommendedAction field', () => {
    expect(typeof getParsedFinding()['recommendedAction']).toBe('string');
  });

  it('finding has missingEvidence array', () => {
    expect(Array.isArray(getParsedFinding()['missingEvidence'])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Section 3: generateJsonReport — evidence fields
// ---------------------------------------------------------------------------

describe('generateJsonReport — evidence field presence', () => {
  function getParsedEvidence(): Record<string, unknown> {
    const report = makeReport();
    const parsed = JSON.parse(generateJsonReport(report)) as Record<string, unknown>;
    const finding = (parsed['findings'] as Record<string, unknown>[])[0]!;
    return (finding['evidence'] as Record<string, unknown>[])[0]!;
  }

  it('evidence has path field', () => {
    expect(typeof getParsedEvidence()['path']).toBe('string');
  });

  it('evidence has note field', () => {
    expect(typeof getParsedEvidence()['note']).toBe('string');
  });

  it('evidence includes artifactType when present on the source', () => {
    expect(getParsedEvidence()['artifactType']).toBeDefined();
  });

  it('evidence includes timestamp when present on the source', () => {
    expect(getParsedEvidence()['timestamp']).toBeDefined();
  });

  it('evidence omits artifactType when not defined on the source', () => {
    const finding = makeFinding({
      evidence: [{ path: 'logs/app.log', note: 'error line' }],
    });
    const report = makeReport({ findings: [finding] });
    const parsed = JSON.parse(generateJsonReport(report)) as Record<string, unknown>;
    const f = (parsed['findings'] as Record<string, unknown>[])[0]!;
    const ev = (f['evidence'] as Record<string, unknown>[])[0]!;
    expect(ev['artifactType']).toBeUndefined();
  });

  it('evidence omits timestamp when not defined on the source', () => {
    const finding = makeFinding({
      evidence: [{ path: 'logs/app.log', note: 'error line' }],
    });
    const report = makeReport({ findings: [finding] });
    const parsed = JSON.parse(generateJsonReport(report)) as Record<string, unknown>;
    const f = (parsed['findings'] as Record<string, unknown>[])[0]!;
    const ev = (f['evidence'] as Record<string, unknown>[])[0]!;
    expect(ev['timestamp']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Section 4: generateJsonReport — specRecommendation fields
// ---------------------------------------------------------------------------

describe('generateJsonReport — specRecommendation field presence', () => {
  function getParsedRecommendation(): Record<string, unknown> {
    const report = makeReport();
    const parsed = JSON.parse(generateJsonReport(report)) as Record<string, unknown>;
    return (parsed['specRecommendations'] as Record<string, unknown>[])[0]!;
  }

  it('specRecommendation has type field', () => {
    const r = getParsedRecommendation();
    expect(['collector', 'analyzer', 'redaction']).toContain(r['type']);
  });

  it('specRecommendation has description field', () => {
    expect(typeof getParsedRecommendation()['description']).toBe('string');
  });

  it('specRecommendation has rationale field', () => {
    expect(typeof getParsedRecommendation()['rationale']).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// Section 5: generateJsonReport — round-trip fidelity
// ---------------------------------------------------------------------------

describe('generateJsonReport — round-trip value fidelity', () => {
  it('executiveSummary round-trips exactly', () => {
    const report = makeReport({ executiveSummary: 'Custom summary for round-trip test.' });
    const parsed = JSON.parse(generateJsonReport(report)) as Record<string, unknown>;
    expect(parsed['executiveSummary']).toBe('Custom summary for round-trip test.');
  });

  it('finding title round-trips exactly', () => {
    const finding = makeFinding({ title: 'CrashLoopBackOff: Pod app-pod in default' });
    const report = makeReport({ findings: [finding] });
    const parsed = JSON.parse(generateJsonReport(report)) as Record<string, unknown>;
    const f = (parsed['findings'] as Record<string, unknown>[])[0]!;
    expect(f['title']).toBe('CrashLoopBackOff: Pod app-pod in default');
  });

  it('finding confidence round-trips as a number', () => {
    const finding = makeFinding({ confidence: 0.92 });
    const report = makeReport({ findings: [finding] });
    const parsed = JSON.parse(generateJsonReport(report)) as Record<string, unknown>;
    const f = (parsed['findings'] as Record<string, unknown>[])[0]!;
    expect(f['confidence']).toBe(0.92);
  });

  it('multiple findings are all serialized', () => {
    const findings = [
      makeFinding({ id: 'finding:k8s:0', title: 'Finding One', severity: 'critical' as FindingSeverity }),
      makeFinding({ id: 'finding:log:0', title: 'Finding Two', severity: 'medium' as FindingSeverity }),
    ];
    const report = makeReport({ findings });
    const parsed = JSON.parse(generateJsonReport(report)) as Record<string, unknown>;
    expect((parsed['findings'] as unknown[]).length).toBe(2);
  });

  it('nextSteps values round-trip exactly', () => {
    const report = makeReport({ nextSteps: ['Step one', 'Step two'] });
    const parsed = JSON.parse(generateJsonReport(report)) as Record<string, unknown>;
    expect(parsed['nextSteps']).toEqual(['Step one', 'Step two']);
  });

  it('contradictions values round-trip exactly', () => {
    const report = makeReport({ contradictions: ['Contradiction A', 'Contradiction B'] });
    const parsed = JSON.parse(generateJsonReport(report)) as Record<string, unknown>;
    expect(parsed['contradictions']).toEqual(['Contradiction A', 'Contradiction B']);
  });
});

// ---------------------------------------------------------------------------
// Section 6: generateJsonReport — empty/minimal report
// ---------------------------------------------------------------------------

describe('generateJsonReport — empty findings and empty arrays', () => {
  it('produces valid JSON for an empty report', () => {
    const report = makeReport({
      findings: [],
      evidenceReferences: [],
      contradictions: [],
      nextSteps: [],
      missingEvidence: [],
      specRecommendations: [],
      rootCause: null,
    });
    expect(() => JSON.parse(generateJsonReport(report))).not.toThrow();
  });

  it('findings array is empty when report has no findings', () => {
    const report = makeReport({ findings: [] });
    const parsed = JSON.parse(generateJsonReport(report)) as Record<string, unknown>;
    expect((parsed['findings'] as unknown[]).length).toBe(0);
  });

  it('specRecommendations array is empty when report has none', () => {
    const report = makeReport({ specRecommendations: [] });
    const parsed = JSON.parse(generateJsonReport(report)) as Record<string, unknown>;
    expect((parsed['specRecommendations'] as unknown[]).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Section 7: writeJsonReport
// ---------------------------------------------------------------------------

describe('writeJsonReport — file output', () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tmpDirs) {
      await fsp.rm(dir, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  async function makeTmpDir(): Promise<string> {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sbi-json-reporter-test-'));
    tmpDirs.push(dir);
    return dir;
  }

  it('returns the path to the written file', async () => {
    const dir = await makeTmpDir();
    const result = await writeJsonReport(makeReport(), dir);
    expect(typeof result).toBe('string');
    expect(result.endsWith('findings.json')).toBe(true);
  });

  it('written file is named findings.json', async () => {
    const dir = await makeTmpDir();
    const filePath = await writeJsonReport(makeReport(), dir);
    const basename = path.basename(filePath);
    expect(basename).toBe('findings.json');
  });

  it('written file exists on disk', async () => {
    const dir = await makeTmpDir();
    const filePath = await writeJsonReport(makeReport(), dir);
    const stat = await fsp.stat(filePath);
    expect(stat.isFile()).toBe(true);
  });

  it('written file contains valid JSON', async () => {
    const dir = await makeTmpDir();
    const filePath = await writeJsonReport(makeReport(), dir);
    const content = await fsp.readFile(filePath, 'utf-8');
    expect(() => JSON.parse(content)).not.toThrow();
  });

  it('written file content round-trips to a report with correct executiveSummary', async () => {
    const dir = await makeTmpDir();
    const report = makeReport({ executiveSummary: 'Written to disk summary.' });
    const filePath = await writeJsonReport(report, dir);
    const content = await fsp.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(content) as Record<string, unknown>;
    expect(parsed['executiveSummary']).toBe('Written to disk summary.');
  });

  it('creates the output directory when it does not exist', async () => {
    const dir = await makeTmpDir();
    const nestedDir = path.join(dir, 'nested', 'sub', 'dir');
    const filePath = await writeJsonReport(makeReport(), nestedDir);
    const stat = await fsp.stat(filePath);
    expect(stat.isFile()).toBe(true);
  });

  it('written file is inside the specified outputDir', async () => {
    const dir = await makeTmpDir();
    const filePath = await writeJsonReport(makeReport(), dir);
    expect(filePath.startsWith(dir)).toBe(true);
  });

  it('returns an absolute path even when outputDir is relative', async () => {
    const dir = await makeTmpDir();
    const relativeDir = path.relative(process.cwd(), dir);
    const filePath = await writeJsonReport(makeReport(), relativeDir);
    expect(path.isAbsolute(filePath)).toBe(true);
    expect(filePath).toBe(path.join(dir, 'findings.json'));
  });
});
