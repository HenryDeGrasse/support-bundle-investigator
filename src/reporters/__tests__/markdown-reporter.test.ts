import { describe, it, expect, afterEach } from 'vitest';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { Finding, FindingSeverity } from '../../types/index.js';
import type { InvestigationReport, SpecRecommendation } from '../types.js';
import { generateMarkdownReport, writeMarkdownReport } from '../markdown-reporter.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'finding:test:0',
    title: 'DNS Resolution Failure',
    severity: 'high' as FindingSeverity,
    confidence: 0.85,
    affectedComponents: ['web', 'api'],
    reasoningSummary:
      'Repeated DNS lookup failures detected in application logs for host db.internal.',
    evidence: [
      {
        path: 'logs/app/current.log',
        note: 'lookup db.internal: no such host',
        artifactType: 'log',
        timestamp: '2024-01-01T00:00:00.000Z',
      },
    ],
    contradictionsChecked: ['No successful DB connection logs found'],
    recommendedAction: 'Update the DB_HOST environment variable to the correct in-cluster DNS name.',
    missingEvidence: ['Kubernetes events for pod app-pod'],
    ...overrides,
  };
}

function makeReport(overrides: Partial<InvestigationReport> = {}): InvestigationReport {
  return {
    executiveSummary:
      'A database hostname misconfiguration is causing repeated DNS lookup failures.',
    findings: [makeFinding()],
    rootCause: 'Misconfigured DB_HOST environment variable.',
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
// Section 1: generateMarkdownReport — output is a non-empty string
// ---------------------------------------------------------------------------

describe('generateMarkdownReport — basic output', () => {
  it('returns a string', () => {
    const result = generateMarkdownReport(makeReport());
    expect(typeof result).toBe('string');
  });

  it('returns a non-empty string', () => {
    const result = generateMarkdownReport(makeReport());
    expect(result.length).toBeGreaterThan(0);
  });

  it('output contains the top-level H1 heading', () => {
    const result = generateMarkdownReport(makeReport());
    expect(result).toContain('# Investigation Report');
  });
});

// ---------------------------------------------------------------------------
// Section 2: Section headers
// ---------------------------------------------------------------------------

describe('generateMarkdownReport — section headers', () => {
  it('contains the Executive Summary H2 header', () => {
    const result = generateMarkdownReport(makeReport());
    expect(result).toContain('## Executive Summary');
  });

  it('contains the Findings H2 header', () => {
    const result = generateMarkdownReport(makeReport());
    expect(result).toContain('## Findings');
  });

  it('contains the Missing Evidence H2 header', () => {
    const result = generateMarkdownReport(makeReport());
    expect(result).toContain('## Missing Evidence');
  });

  it('contains the Spec Improvement Recommendations H2 header', () => {
    const result = generateMarkdownReport(makeReport());
    expect(result).toContain('## Spec Improvement Recommendations');
  });

  it('contains the Investigation Metadata H2 header', () => {
    const result = generateMarkdownReport(makeReport());
    expect(result).toContain('## Investigation Metadata');
  });
});

// ---------------------------------------------------------------------------
// Section 2b: Diagnostics section
// ---------------------------------------------------------------------------

describe('generateMarkdownReport — diagnostics section', () => {
  it('renders diagnostics when present on the report', () => {
    const result = generateMarkdownReport(
      makeReport({
        diagnostics: {
          stepTimings: [{ name: 'investigate', durationMs: 420, artifactsProcessed: 12 }],
          seedCount: 3,
          seedCategories: { kubernetes: 2, connectivity: 1 },
          retrievalStats: {
            graphChunks: 5,
            lexicalChunks: 4,
            semanticChunks: 0,
            mergedChunks: 6,
          },
          confidenceStats: {
            min: 0.4,
            max: 0.9,
            mean: 0.65,
            median: 0.65,
          },
          confidenceHistogram: {
            '0-0.5': 1,
            '0.5-0.75': 0,
            '0.75-1.0': 1,
          },
          hypothesisStats: {
            generated: 4,
            verified: 3,
            converted: 2,
            conversionRate: 0.5,
          },
          aiSummary: {
            model: 'gpt-4o-mini',
            backend: 'cloud',
            totalCalls: 2,
            successfulCalls: 2,
            failedCalls: 0,
            totalLatencyMs: 240,
            avgLatencyMs: 120,
          },
        },
      }),
    );

    expect(result).toContain('## Diagnostics');
    expect(result).toContain('### Pipeline Step Timings');
    expect(result).toContain('| investigate | 420 | 12 |');
    expect(result).toContain('### Seed Count by Category');
    expect(result).toContain('- kubernetes: 2');
    expect(result).toContain('### Finding Confidence Histogram');
    expect(result).toContain('- 0.75-1.0: 1');
    expect(result).toContain('### Hypothesis Conversion');
    expect(result).toContain('Conversion Rate: 50.0%');
    expect(result).toContain('### AI Call Stats');
    expect(result).toContain('- Model: gpt-4o-mini');
  });

  it('does not render diagnostics when explicitly disabled', () => {
    const result = generateMarkdownReport(
      makeReport({
        diagnostics: {
          stepTimings: [{ name: 'investigate', durationMs: 420, artifactsProcessed: 12 }],
          confidenceHistogram: {
            '0-0.5': 0,
            '0.5-0.75': 0,
            '0.75-1.0': 1,
          },
        },
      }),
      { includeDiagnostics: false },
    );

    expect(result).not.toContain('## Diagnostics');
  });
});

// ---------------------------------------------------------------------------
// Section 3: Executive summary content
// ---------------------------------------------------------------------------

describe('generateMarkdownReport — executive summary content', () => {
  it('includes the executive summary text', () => {
    const report = makeReport({
      executiveSummary: 'Custom executive summary for testing.',
    });
    const result = generateMarkdownReport(report);
    expect(result).toContain('Custom executive summary for testing.');
  });

  it('includes the root cause when present', () => {
    const report = makeReport({ rootCause: 'Misconfigured DB hostname.' });
    const result = generateMarkdownReport(report);
    expect(result).toContain('Misconfigured DB hostname.');
    expect(result).toContain('Root Cause');
  });

  it('does not render a Root Cause line when rootCause is null', () => {
    const report = makeReport({ rootCause: null });
    const result = generateMarkdownReport(report);
    expect(result).not.toContain('**Root Cause:**');
  });
});

// ---------------------------------------------------------------------------
// Section 4: Finding count
// ---------------------------------------------------------------------------

describe('generateMarkdownReport — finding count', () => {
  it('renders one H3 subsection for each finding', () => {
    const findings = [
      makeFinding({ id: 'finding:test:0', title: 'Finding Alpha' }),
      makeFinding({ id: 'finding:test:1', title: 'Finding Beta' }),
      makeFinding({ id: 'finding:test:2', title: 'Finding Gamma' }),
    ];
    const report = makeReport({ findings });
    const result = generateMarkdownReport(report);
    expect(result).toContain('### 1. Finding Alpha');
    expect(result).toContain('### 2. Finding Beta');
    expect(result).toContain('### 3. Finding Gamma');
  });

  it('renders a "no findings" placeholder when findings array is empty', () => {
    const report = makeReport({ findings: [] });
    const result = generateMarkdownReport(report);
    expect(result).toContain('_No findings recorded._');
  });

  it('finding count in the metadata footer matches the findings array length', () => {
    const findings = [makeFinding(), makeFinding({ id: 'finding:test:1', title: 'Another' })];
    const report = makeReport({ findings });
    const result = generateMarkdownReport(report);
    expect(result).toContain('| Total Findings | 2 |');
  });
});

// ---------------------------------------------------------------------------
// Section 5: Severity rendering
// ---------------------------------------------------------------------------

describe('generateMarkdownReport — severity rendering', () => {
  it('renders "CRITICAL" badge for critical severity', () => {
    const finding = makeFinding({ severity: 'critical' as FindingSeverity });
    const report = makeReport({ findings: [finding] });
    expect(generateMarkdownReport(report)).toContain('CRITICAL');
  });

  it('renders "HIGH" badge for high severity', () => {
    const finding = makeFinding({ severity: 'high' as FindingSeverity });
    const report = makeReport({ findings: [finding] });
    expect(generateMarkdownReport(report)).toContain('HIGH');
  });

  it('renders "MEDIUM" badge for medium severity', () => {
    const finding = makeFinding({ severity: 'medium' as FindingSeverity });
    const report = makeReport({ findings: [finding] });
    expect(generateMarkdownReport(report)).toContain('MEDIUM');
  });

  it('renders "LOW" badge for low severity', () => {
    const finding = makeFinding({ severity: 'low' as FindingSeverity });
    const report = makeReport({ findings: [finding] });
    expect(generateMarkdownReport(report)).toContain('LOW');
  });

  it('renders "INFO" badge for info severity', () => {
    const finding = makeFinding({ severity: 'info' as FindingSeverity });
    const report = makeReport({ findings: [finding] });
    expect(generateMarkdownReport(report)).toContain('INFO');
  });
});

// ---------------------------------------------------------------------------
// Section 6: Confidence rendering
// ---------------------------------------------------------------------------

describe('generateMarkdownReport — confidence rendering', () => {
  it('renders confidence as a percentage', () => {
    const finding = makeFinding({ confidence: 0.85 });
    const report = makeReport({ findings: [finding] });
    expect(generateMarkdownReport(report)).toContain('85%');
  });

  it('renders confidence 0.5 as 50%', () => {
    const finding = makeFinding({ confidence: 0.5 });
    const report = makeReport({ findings: [finding] });
    expect(generateMarkdownReport(report)).toContain('50%');
  });

  it('renders confidence 1.0 as 100%', () => {
    const finding = makeFinding({ confidence: 1.0 });
    const report = makeReport({ findings: [finding] });
    expect(generateMarkdownReport(report)).toContain('100%');
  });

  it('renders confidence 0.0 as 0%', () => {
    const finding = makeFinding({ confidence: 0.0 });
    const report = makeReport({ findings: [finding] });
    expect(generateMarkdownReport(report)).toContain('0%');
  });

  it('confidence label appears in the finding section', () => {
    const finding = makeFinding({ confidence: 0.72 });
    const report = makeReport({ findings: [finding] });
    const result = generateMarkdownReport(report);
    expect(result).toContain('Confidence');
    expect(result).toContain('72%');
  });
});

// ---------------------------------------------------------------------------
// Section 7: Evidence references
// ---------------------------------------------------------------------------

describe('generateMarkdownReport — evidence references', () => {
  it('renders the evidence path in the evidence table', () => {
    const finding = makeFinding({
      evidence: [
        {
          path: 'logs/app/current.log',
          note: 'lookup db.internal: no such host',
        },
      ],
    });
    const report = makeReport({ findings: [finding] });
    const result = generateMarkdownReport(report);
    expect(result).toContain('logs/app/current.log');
  });

  it('renders the evidence note in the evidence table', () => {
    const finding = makeFinding({
      evidence: [
        {
          path: 'logs/app/current.log',
          note: 'lookup db.internal: no such host',
        },
      ],
    });
    const report = makeReport({ findings: [finding] });
    const result = generateMarkdownReport(report);
    expect(result).toContain('lookup db.internal: no such host');
  });

  it('renders multiple evidence entries', () => {
    const finding = makeFinding({
      evidence: [
        { path: 'logs/app/current.log', note: 'First evidence note' },
        { path: 'cluster-resources/pods/default/app-pod.yaml', note: 'Pod status shows errors' },
      ],
    });
    const report = makeReport({ findings: [finding] });
    const result = generateMarkdownReport(report);
    expect(result).toContain('First evidence note');
    expect(result).toContain('Pod status shows errors');
  });

  it('renders "no evidence" placeholder when evidence array is empty', () => {
    const finding = makeFinding({ evidence: [] });
    const report = makeReport({ findings: [finding] });
    const result = generateMarkdownReport(report);
    expect(result).toContain('_No evidence recorded._');
  });

  it('renders the evidence table headers', () => {
    const finding = makeFinding({
      evidence: [{ path: 'some/path.log', note: 'some note' }],
    });
    const report = makeReport({ findings: [finding] });
    const result = generateMarkdownReport(report);
    expect(result).toContain('| Path | Note |');
  });

  it('evidence count in metadata footer is correct', () => {
    const report = makeReport({
      evidenceReferences: [
        { path: 'a.log', note: 'note a' },
        { path: 'b.log', note: 'note b' },
      ],
    });
    const result = generateMarkdownReport(report);
    expect(result).toContain('| Evidence References | 2 |');
  });
});

// ---------------------------------------------------------------------------
// Section 8: Contradictions checked
// ---------------------------------------------------------------------------

describe('generateMarkdownReport — contradictions checked', () => {
  it('renders each contradiction as a list item', () => {
    const finding = makeFinding({
      contradictionsChecked: ['Contradiction A', 'Contradiction B'],
    });
    const report = makeReport({ findings: [finding] });
    const result = generateMarkdownReport(report);
    expect(result).toContain('- Contradiction A');
    expect(result).toContain('- Contradiction B');
  });

  it('contradictions count in metadata footer is correct', () => {
    const report = makeReport({
      contradictions: ['Check one', 'Check two', 'Check three'],
    });
    const result = generateMarkdownReport(report);
    expect(result).toContain('| Contradictions Checked | 3 |');
  });
});

// ---------------------------------------------------------------------------
// Section 9: Affected components
// ---------------------------------------------------------------------------

describe('generateMarkdownReport — affected components', () => {
  it('renders affected components for a finding', () => {
    const finding = makeFinding({ affectedComponents: ['frontend', 'backend', 'database'] });
    const report = makeReport({ findings: [finding] });
    const result = generateMarkdownReport(report);
    expect(result).toContain('frontend');
    expect(result).toContain('backend');
    expect(result).toContain('database');
  });

  it('does not render an Affected Components line when the array is empty', () => {
    const finding = makeFinding({ affectedComponents: [] });
    const report = makeReport({ findings: [finding] });
    const result = generateMarkdownReport(report);
    expect(result).not.toContain('**Affected Components:**');
  });
});

// ---------------------------------------------------------------------------
// Section 10: Recommended action
// ---------------------------------------------------------------------------

describe('generateMarkdownReport — recommended action', () => {
  it('renders the recommended action text', () => {
    const finding = makeFinding({
      recommendedAction: 'Set DB_HOST to db-service.default.svc.cluster.local.',
    });
    const report = makeReport({ findings: [finding] });
    const result = generateMarkdownReport(report);
    expect(result).toContain('Set DB_HOST to db-service.default.svc.cluster.local.');
  });
});

// ---------------------------------------------------------------------------
// Section 11: Missing evidence section
// ---------------------------------------------------------------------------

describe('generateMarkdownReport — missing evidence section', () => {
  it('renders each missing evidence item as a list entry', () => {
    const report = makeReport({
      missingEvidence: ['Kubernetes events for pod app-pod', 'Container logs for init container'],
    });
    const result = generateMarkdownReport(report);
    expect(result).toContain('- Kubernetes events for pod app-pod');
    expect(result).toContain('- Container logs for init container');
  });

  it('renders a placeholder when there is no missing evidence', () => {
    const report = makeReport({ missingEvidence: [] });
    const result = generateMarkdownReport(report);
    expect(result).toContain('_No missing evidence identified._');
  });
});

// ---------------------------------------------------------------------------
// Section 12: Spec recommendations section
// ---------------------------------------------------------------------------

describe('generateMarkdownReport — spec improvement recommendations', () => {
  it('renders each recommendation as a numbered subsection', () => {
    const report = makeReport({
      specRecommendations: [
        {
          type: 'collector',
          description: 'Add a logs collector.',
          rationale: 'Missing logs prevent diagnosis.',
        },
        {
          type: 'analyzer',
          description: 'Add a secret-existence analyzer.',
          rationale: 'Secret heuristics are unreliable.',
        },
      ],
    });
    const result = generateMarkdownReport(report);
    expect(result).toContain('### 1.');
    expect(result).toContain('### 2.');
  });

  it('renders "collector" type label', () => {
    const report = makeReport({
      specRecommendations: [
        { type: 'collector', description: 'Add logs collector.', rationale: 'Reason.' },
      ],
    });
    expect(generateMarkdownReport(report)).toContain('Collector');
  });

  it('renders "analyzer" type label', () => {
    const report = makeReport({
      specRecommendations: [
        { type: 'analyzer', description: 'Add analyzer.', rationale: 'Reason.' },
      ],
    });
    expect(generateMarkdownReport(report)).toContain('Analyzer');
  });

  it('renders "redaction" type label', () => {
    const report = makeReport({
      specRecommendations: [
        { type: 'redaction', description: 'Add redaction rule.', rationale: 'Reason.' },
      ],
    });
    expect(generateMarkdownReport(report)).toContain('Redaction');
  });

  it('renders the recommendation description', () => {
    const report = makeReport({
      specRecommendations: [
        {
          type: 'collector',
          description: 'Add a logs collector to capture container logs.',
          rationale: 'Missing container logs prevent root-cause confirmation.',
        },
      ],
    });
    const result = generateMarkdownReport(report);
    expect(result).toContain('Add a logs collector to capture container logs.');
  });

  it('renders the recommendation rationale', () => {
    const report = makeReport({
      specRecommendations: [
        {
          type: 'collector',
          description: 'Add a logs collector.',
          rationale: 'Missing container logs prevent root-cause confirmation.',
        },
      ],
    });
    const result = generateMarkdownReport(report);
    expect(result).toContain('Missing container logs prevent root-cause confirmation.');
  });

  it('renders a placeholder when there are no recommendations', () => {
    const report = makeReport({ specRecommendations: [] });
    const result = generateMarkdownReport(report);
    expect(result).toContain('_No spec improvements recommended._');
  });

  it('spec recommendations count in metadata footer is correct', () => {
    const report = makeReport({
      specRecommendations: [
        { type: 'collector', description: 'Desc 1.', rationale: 'Rat 1.' },
        { type: 'analyzer', description: 'Desc 2.', rationale: 'Rat 2.' },
      ],
    });
    const result = generateMarkdownReport(report);
    expect(result).toContain('| Spec Recommendations | 2 |');
  });
});

// ---------------------------------------------------------------------------
// Section 13: Metadata footer
// ---------------------------------------------------------------------------

describe('generateMarkdownReport — metadata footer', () => {
  it('contains the Generated At field', () => {
    const result = generateMarkdownReport(makeReport());
    expect(result).toContain('Generated At');
  });

  it('contains a valid ISO-8601 timestamp in the footer', () => {
    const result = generateMarkdownReport(makeReport());
    // ISO date looks like 2024-01-01T00:00:00.000Z
    const isoPattern = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
    expect(result).toMatch(isoPattern);
  });

  it('contains the Total Findings count', () => {
    const result = generateMarkdownReport(makeReport());
    expect(result).toContain('Total Findings');
  });

  it('contains the horizontal rule separator before metadata', () => {
    const result = generateMarkdownReport(makeReport());
    expect(result).toContain('---');
  });
});

// ---------------------------------------------------------------------------
// Section 14: Empty / minimal report
// ---------------------------------------------------------------------------

describe('generateMarkdownReport — empty report', () => {
  it('produces a non-empty string for an empty report', () => {
    const report = makeReport({
      findings: [],
      evidenceReferences: [],
      contradictions: [],
      nextSteps: [],
      missingEvidence: [],
      specRecommendations: [],
      rootCause: null,
    });
    const result = generateMarkdownReport(report);
    expect(result.length).toBeGreaterThan(0);
  });

  it('contains all section headers even for empty report', () => {
    const report = makeReport({
      findings: [],
      evidenceReferences: [],
      contradictions: [],
      nextSteps: [],
      missingEvidence: [],
      specRecommendations: [],
      rootCause: null,
    });
    const result = generateMarkdownReport(report);
    expect(result).toContain('## Executive Summary');
    expect(result).toContain('## Findings');
    expect(result).toContain('## Missing Evidence');
    expect(result).toContain('## Spec Improvement Recommendations');
    expect(result).toContain('## Investigation Metadata');
  });
});

// ---------------------------------------------------------------------------
// Section 15: writeMarkdownReport — file output
// ---------------------------------------------------------------------------

describe('writeMarkdownReport — file output', () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tmpDirs) {
      await fsp.rm(dir, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  async function makeTmpDir(): Promise<string> {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sbi-markdown-reporter-test-'));
    tmpDirs.push(dir);
    return dir;
  }

  it('returns the path to the written file', async () => {
    const dir = await makeTmpDir();
    const result = await writeMarkdownReport(makeReport(), dir);
    expect(typeof result).toBe('string');
    expect(result.endsWith('findings.md')).toBe(true);
  });

  it('written file is named findings.md', async () => {
    const dir = await makeTmpDir();
    const filePath = await writeMarkdownReport(makeReport(), dir);
    const basename = path.basename(filePath);
    expect(basename).toBe('findings.md');
  });

  it('written file exists on disk', async () => {
    const dir = await makeTmpDir();
    const filePath = await writeMarkdownReport(makeReport(), dir);
    const stat = await fsp.stat(filePath);
    expect(stat.isFile()).toBe(true);
  });

  it('written file contains the H1 heading', async () => {
    const dir = await makeTmpDir();
    const filePath = await writeMarkdownReport(makeReport(), dir);
    const content = await fsp.readFile(filePath, 'utf-8');
    expect(content).toContain('# Investigation Report');
  });

  it('written file contains the executive summary text', async () => {
    const dir = await makeTmpDir();
    const report = makeReport({ executiveSummary: 'Written to disk summary.' });
    const filePath = await writeMarkdownReport(report, dir);
    const content = await fsp.readFile(filePath, 'utf-8');
    expect(content).toContain('Written to disk summary.');
  });

  it('creates the output directory when it does not exist', async () => {
    const dir = await makeTmpDir();
    const nestedDir = path.join(dir, 'nested', 'sub', 'dir');
    const filePath = await writeMarkdownReport(makeReport(), nestedDir);
    const stat = await fsp.stat(filePath);
    expect(stat.isFile()).toBe(true);
  });

  it('written file is inside the specified outputDir', async () => {
    const dir = await makeTmpDir();
    const filePath = await writeMarkdownReport(makeReport(), dir);
    expect(filePath.startsWith(dir)).toBe(true);
  });

  it('returns an absolute path even when outputDir is relative', async () => {
    const dir = await makeTmpDir();
    const relativeDir = path.relative(process.cwd(), dir);
    const filePath = await writeMarkdownReport(makeReport(), relativeDir);
    expect(path.isAbsolute(filePath)).toBe(true);
    expect(filePath).toBe(path.join(dir, 'findings.md'));
  });
});

// ---------------------------------------------------------------------------
// Section 16: AI-assisted finding annotation
// ---------------------------------------------------------------------------

describe('generateMarkdownReport — AI-assisted finding annotation', () => {
  it('renders [AI-assisted] tag in finding heading for AI finding', () => {
    const aiFinding = makeFinding({ id: 'finding:ai:kubernetes:0', title: 'AI Finding' });
    const report = makeReport({ findings: [aiFinding] });
    const result = generateMarkdownReport(report);
    expect(result).toContain('### 1. AI Finding [AI-assisted]');
  });

  it('does not render [AI-assisted] tag for heuristic finding', () => {
    const heuristicFinding = makeFinding({
      id: 'finding:kubernetes:0',
      title: 'Heuristic Finding',
    });
    const report = makeReport({ findings: [heuristicFinding] });
    const result = generateMarkdownReport(report);
    expect(result).toContain('### 1. Heuristic Finding');
    expect(result).not.toContain('[AI-assisted]');
  });

  it('renders [AI-assisted] only on the AI finding in a mixed list', () => {
    const heuristic = makeFinding({ id: 'finding:kubernetes:0', title: 'Heuristic Finding' });
    const ai = makeFinding({ id: 'finding:ai:log:1', title: 'AI Finding' });
    const report = makeReport({ findings: [heuristic, ai] });
    const result = generateMarkdownReport(report);
    expect(result).toContain('### 1. Heuristic Finding');
    expect(result).not.toContain('### 1. Heuristic Finding [AI-assisted]');
    expect(result).toContain('### 2. AI Finding [AI-assisted]');
  });

  it('renders [AI-assisted] tag for finding:ai:log: prefix', () => {
    const finding = makeFinding({ id: 'finding:ai:log:0', title: 'Log AI Finding' });
    const report = makeReport({ findings: [finding] });
    const result = generateMarkdownReport(report);
    expect(result).toContain('[AI-assisted]');
  });

  it('renders [AI-assisted] tag for finding:ai:configuration: prefix', () => {
    const finding = makeFinding({
      id: 'finding:ai:configuration:0',
      title: 'Config AI Finding',
    });
    const report = makeReport({ findings: [finding] });
    const result = generateMarkdownReport(report);
    expect(result).toContain('[AI-assisted]');
  });
});
