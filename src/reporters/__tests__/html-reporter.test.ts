import { describe, it, expect, afterEach } from 'vitest';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { Finding, FindingSeverity } from '../../types/index.js';
import type { InvestigationReport, SpecRecommendation } from '../types.js';
import { generateHtmlReport, writeHtmlReport } from '../html-reporter.js';

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
// Section 1: generateHtmlReport — basic output structure
// ---------------------------------------------------------------------------

describe('generateHtmlReport — output is a valid HTML string', () => {
  it('returns a string', () => {
    const result = generateHtmlReport(makeReport());
    expect(typeof result).toBe('string');
  });

  it('returns a non-empty string', () => {
    const result = generateHtmlReport(makeReport());
    expect(result.length).toBeGreaterThan(0);
  });

  it('starts with <!DOCTYPE html>', () => {
    const result = generateHtmlReport(makeReport());
    expect(result.trimStart().startsWith('<!DOCTYPE html>')).toBe(true);
  });

  it('contains an <html> opening tag', () => {
    const result = generateHtmlReport(makeReport());
    expect(result).toMatch(/<html/i);
  });

  it('contains a closing </html> tag', () => {
    const result = generateHtmlReport(makeReport());
    expect(result).toContain('</html>');
  });

  it('contains a <head> element', () => {
    const result = generateHtmlReport(makeReport());
    expect(result).toContain('<head>');
    expect(result).toContain('</head>');
  });

  it('contains a <body> element', () => {
    const result = generateHtmlReport(makeReport());
    expect(result).toContain('<body>');
    expect(result).toContain('</body>');
  });

  it('contains a UTF-8 charset meta tag', () => {
    const result = generateHtmlReport(makeReport());
    expect(result).toMatch(/charset.*UTF-8/i);
  });

  it('contains a <title> element with expected text', () => {
    const result = generateHtmlReport(makeReport());
    expect(result).toContain('<title>');
    expect(result).toContain('Investigation Report');
  });
});

// ---------------------------------------------------------------------------
// Section 2: CSS presence and structure
// ---------------------------------------------------------------------------

describe('generateHtmlReport — embedded CSS', () => {
  it('contains a <style> element', () => {
    const result = generateHtmlReport(makeReport());
    expect(result).toContain('<style>');
    expect(result).toContain('</style>');
  });

  it('CSS defines severity-critical class', () => {
    const result = generateHtmlReport(makeReport());
    expect(result).toContain('.severity-critical');
  });

  it('CSS defines severity-high class', () => {
    const result = generateHtmlReport(makeReport());
    expect(result).toContain('.severity-high');
  });

  it('CSS defines severity-medium class', () => {
    const result = generateHtmlReport(makeReport());
    expect(result).toContain('.severity-medium');
  });

  it('CSS defines severity-low class', () => {
    const result = generateHtmlReport(makeReport());
    expect(result).toContain('.severity-low');
  });

  it('CSS defines severity-info class', () => {
    const result = generateHtmlReport(makeReport());
    expect(result).toContain('.severity-info');
  });

  it('CSS includes critical color (red family)', () => {
    const result = generateHtmlReport(makeReport());
    // The stylesheet uses #c0392b for critical
    expect(result).toMatch(/severity-critical[\s\S]*?color.*#c0392b/);
  });

  it('CSS includes high color (orange family)', () => {
    const result = generateHtmlReport(makeReport());
    // The stylesheet uses #d35400 for high
    expect(result).toMatch(/severity-high[\s\S]*?color.*#d35400/);
  });

  it('CSS includes low color (blue family)', () => {
    const result = generateHtmlReport(makeReport());
    expect(result).toMatch(/severity-low[\s\S]*?color.*#1a6fa8/);
  });

  it('CSS includes info color (gray family)', () => {
    const result = generateHtmlReport(makeReport());
    expect(result).toMatch(/severity-info[\s\S]*?color.*#555577/);
  });

  it('CSS includes print media query', () => {
    const result = generateHtmlReport(makeReport());
    expect(result).toContain('@media print');
  });

  it('CSS includes evidence-table class', () => {
    const result = generateHtmlReport(makeReport());
    expect(result).toContain('.evidence-table');
  });

  it('CSS includes finding-card class', () => {
    const result = generateHtmlReport(makeReport());
    expect(result).toContain('.finding-card');
  });
});

// ---------------------------------------------------------------------------
// Section 3: Report content — executive summary
// ---------------------------------------------------------------------------

describe('generateHtmlReport — executive summary content', () => {
  it('contains the executive summary text', () => {
    const report = makeReport({
      executiveSummary: 'Custom executive summary for HTML testing.',
    });
    const result = generateHtmlReport(report);
    expect(result).toContain('Custom executive summary for HTML testing.');
  });

  it('includes the root cause when present', () => {
    const report = makeReport({ rootCause: 'Misconfigured DB hostname in HTML.' });
    const result = generateHtmlReport(report);
    expect(result).toContain('Misconfigured DB hostname in HTML.');
    expect(result).toContain('Root Cause');
  });

  it('does not render Root Cause block when rootCause is null', () => {
    const report = makeReport({ rootCause: null });
    const result = generateHtmlReport(report);
    expect(result).not.toContain('Root Cause:');
  });

  it('contains Executive Summary heading text', () => {
    const result = generateHtmlReport(makeReport());
    expect(result).toContain('Executive Summary');
  });
});

// ---------------------------------------------------------------------------
// Section 4: Finding rendering and count
// ---------------------------------------------------------------------------

describe('generateHtmlReport — finding rendering', () => {
  it('renders a finding card for each finding', () => {
    const findings = [
      makeFinding({ id: 'finding:test:0', title: 'Alpha Finding' }),
      makeFinding({ id: 'finding:test:1', title: 'Beta Finding' }),
    ];
    const report = makeReport({ findings });
    const result = generateHtmlReport(report);
    expect(result).toContain('Alpha Finding');
    expect(result).toContain('Beta Finding');
  });

  it('renders a "no findings" placeholder when findings is empty', () => {
    const report = makeReport({ findings: [] });
    const result = generateHtmlReport(report);
    expect(result).toContain('No findings recorded.');
  });

  it('renders the finding title in the output', () => {
    const finding = makeFinding({ title: 'CrashLoopBackOff: Pod app-pod' });
    const report = makeReport({ findings: [finding] });
    const result = generateHtmlReport(report);
    expect(result).toContain('CrashLoopBackOff: Pod app-pod');
  });

  it('renders the finding reasoning summary', () => {
    const finding = makeFinding({
      reasoningSummary: 'Unique reasoning summary text for test.',
    });
    const report = makeReport({ findings: [finding] });
    const result = generateHtmlReport(report);
    expect(result).toContain('Unique reasoning summary text for test.');
  });

  it('renders the recommended action', () => {
    const finding = makeFinding({
      recommendedAction: 'Set DB_HOST to db-service.default.svc.cluster.local.',
    });
    const report = makeReport({ findings: [finding] });
    const result = generateHtmlReport(report);
    expect(result).toContain('Set DB_HOST to db-service.default.svc.cluster.local.');
  });

  it('renders the confidence percentage', () => {
    const finding = makeFinding({ confidence: 0.78 });
    const report = makeReport({ findings: [finding] });
    const result = generateHtmlReport(report);
    expect(result).toContain('78%');
  });

  it('renders affected components', () => {
    const finding = makeFinding({ affectedComponents: ['frontend', 'backend'] });
    const report = makeReport({ findings: [finding] });
    const result = generateHtmlReport(report);
    expect(result).toContain('frontend');
    expect(result).toContain('backend');
  });

  it('does not render Affected Components when array is empty', () => {
    const finding = makeFinding({ affectedComponents: [] });
    const report = makeReport({ findings: [finding] });
    const result = generateHtmlReport(report);
    expect(result).not.toContain('Affected Components:');
  });

  it('renders Findings section heading', () => {
    const result = generateHtmlReport(makeReport());
    expect(result).toContain('Findings');
  });
});

// ---------------------------------------------------------------------------
// Section 5: Severity class rendering
// ---------------------------------------------------------------------------

describe('generateHtmlReport — severity CSS classes', () => {
  it('applies severity-critical class to critical findings', () => {
    const finding = makeFinding({ severity: 'critical' as FindingSeverity });
    const report = makeReport({ findings: [finding] });
    const result = generateHtmlReport(report);
    expect(result).toContain('severity-critical');
  });

  it('applies severity-high class to high findings', () => {
    const finding = makeFinding({ severity: 'high' as FindingSeverity });
    const report = makeReport({ findings: [finding] });
    const result = generateHtmlReport(report);
    expect(result).toContain('severity-high');
  });

  it('applies severity-medium class to medium findings', () => {
    const finding = makeFinding({ severity: 'medium' as FindingSeverity });
    const report = makeReport({ findings: [finding] });
    const result = generateHtmlReport(report);
    expect(result).toContain('severity-medium');
  });

  it('applies severity-low class to low findings', () => {
    const finding = makeFinding({ severity: 'low' as FindingSeverity });
    const report = makeReport({ findings: [finding] });
    const result = generateHtmlReport(report);
    expect(result).toContain('severity-low');
  });

  it('applies severity-info class to info findings', () => {
    const finding = makeFinding({ severity: 'info' as FindingSeverity });
    const report = makeReport({ findings: [finding] });
    const result = generateHtmlReport(report);
    expect(result).toContain('severity-info');
  });

  it('badge text shows CRITICAL for critical severity', () => {
    const finding = makeFinding({ severity: 'critical' as FindingSeverity });
    const report = makeReport({ findings: [finding] });
    const result = generateHtmlReport(report);
    expect(result).toContain('CRITICAL');
  });

  it('badge text shows HIGH for high severity', () => {
    const finding = makeFinding({ severity: 'high' as FindingSeverity });
    const report = makeReport({ findings: [finding] });
    const result = generateHtmlReport(report);
    expect(result).toContain('HIGH');
  });

  it('badge text shows MEDIUM for medium severity', () => {
    const finding = makeFinding({ severity: 'medium' as FindingSeverity });
    const report = makeReport({ findings: [finding] });
    const result = generateHtmlReport(report);
    expect(result).toContain('MEDIUM');
  });

  it('badge text shows LOW for low severity', () => {
    const finding = makeFinding({ severity: 'low' as FindingSeverity });
    const report = makeReport({ findings: [finding] });
    const result = generateHtmlReport(report);
    expect(result).toContain('LOW');
  });

  it('badge text shows INFO for info severity', () => {
    const finding = makeFinding({ severity: 'info' as FindingSeverity });
    const report = makeReport({ findings: [finding] });
    const result = generateHtmlReport(report);
    expect(result).toContain('INFO');
  });
});

// ---------------------------------------------------------------------------
// Section 6: Evidence table
// ---------------------------------------------------------------------------

describe('generateHtmlReport — evidence table', () => {
  it('renders a <table> element for evidence', () => {
    const result = generateHtmlReport(makeReport());
    expect(result).toContain('<table');
    expect(result).toContain('</table>');
  });

  it('renders evidence table headers (Path and Note)', () => {
    const result = generateHtmlReport(makeReport());
    expect(result).toContain('<th>Path</th>');
    expect(result).toContain('<th>Note</th>');
  });

  it('renders the evidence path in the table', () => {
    const finding = makeFinding({
      evidence: [{ path: 'logs/app/current.log', note: 'some note' }],
    });
    const report = makeReport({ findings: [finding] });
    const result = generateHtmlReport(report);
    expect(result).toContain('logs/app/current.log');
  });

  it('renders the evidence note in the table', () => {
    const finding = makeFinding({
      evidence: [{ path: 'some/path.log', note: 'lookup db.internal: no such host' }],
    });
    const report = makeReport({ findings: [finding] });
    const result = generateHtmlReport(report);
    expect(result).toContain('lookup db.internal: no such host');
  });

  it('renders multiple evidence rows', () => {
    const finding = makeFinding({
      evidence: [
        { path: 'logs/app/current.log', note: 'First evidence note' },
        { path: 'cluster-resources/pods/default/app-pod.yaml', note: 'Pod status shows errors' },
      ],
    });
    const report = makeReport({ findings: [finding] });
    const result = generateHtmlReport(report);
    expect(result).toContain('First evidence note');
    expect(result).toContain('Pod status shows errors');
  });

  it('renders "no evidence" placeholder when evidence array is empty', () => {
    const finding = makeFinding({ evidence: [] });
    const report = makeReport({ findings: [finding] });
    const result = generateHtmlReport(report);
    expect(result).toContain('No evidence recorded.');
  });

  it('applies evidence-table CSS class to the table', () => {
    const result = generateHtmlReport(makeReport());
    expect(result).toContain('class="evidence-table"');
  });
});

// ---------------------------------------------------------------------------
// Section 7: Collapsible sections
// ---------------------------------------------------------------------------

describe('generateHtmlReport — collapsible sections', () => {
  it('uses <details> element for contradictions-checked section', () => {
    const finding = makeFinding({
      contradictionsChecked: ['No successful DB connection found'],
    });
    const report = makeReport({ findings: [finding] });
    const result = generateHtmlReport(report);
    expect(result).toContain('<details>');
    expect(result).toContain('<summary>');
  });

  it('renders contradictions text inside the collapsible', () => {
    const finding = makeFinding({
      contradictionsChecked: ['Unique contradiction text for HTML test'],
    });
    const report = makeReport({ findings: [finding] });
    const result = generateHtmlReport(report);
    expect(result).toContain('Unique contradiction text for HTML test');
  });

  it('does not render contradictions details when contradictionsChecked is empty', () => {
    // We only check that when contradictionsChecked is empty, the per-finding
    // Contradictions details element is absent from that finding.
    const finding = makeFinding({ contradictionsChecked: [] });
    const report = makeReport({
      findings: [finding],
      contradictions: [], // also empty at report level
      evidenceReferences: [], // keep report-level details minimal
    });
    const result = generateHtmlReport(report);
    // No <details> should appear since both finding-level and report-level
    // contradictions/evidenceReferences are empty
    expect(result).not.toContain('<details>');
  });

  it('renders report-level contradictions in a collapsible section', () => {
    const report = makeReport({
      contradictions: ['Report level contradiction one'],
    });
    const result = generateHtmlReport(report);
    expect(result).toContain('Report level contradiction one');
  });

  it('uses <details> for the all-evidence-references section', () => {
    const report = makeReport({
      evidenceReferences: [{ path: 'ref/path.log', note: 'Reference note' }],
      findings: [], // no per-finding contradictions
    });
    const result = generateHtmlReport(report);
    expect(result).toContain('<details>');
  });
});

// ---------------------------------------------------------------------------
// Section 8: Next steps and missing evidence
// ---------------------------------------------------------------------------

describe('generateHtmlReport — next steps', () => {
  it('renders next steps', () => {
    const report = makeReport({
      nextSteps: ['Update DB_HOST to the correct in-cluster name.'],
    });
    const result = generateHtmlReport(report);
    expect(result).toContain('Update DB_HOST to the correct in-cluster name.');
  });

  it('renders a placeholder when nextSteps is empty', () => {
    const report = makeReport({ nextSteps: [] });
    const result = generateHtmlReport(report);
    expect(result).toContain('No next steps identified.');
  });
});

describe('generateHtmlReport — missing evidence', () => {
  it('renders missing evidence items', () => {
    const report = makeReport({
      missingEvidence: ['Kubernetes events for pod app-pod'],
    });
    const result = generateHtmlReport(report);
    expect(result).toContain('Kubernetes events for pod app-pod');
  });

  it('renders a placeholder when missingEvidence is empty', () => {
    const report = makeReport({ missingEvidence: [] });
    const result = generateHtmlReport(report);
    expect(result).toContain('No missing evidence identified.');
  });
});

// ---------------------------------------------------------------------------
// Section 9: Spec recommendations
// ---------------------------------------------------------------------------

describe('generateHtmlReport — spec improvement recommendations', () => {
  it('renders the collector recommendation description', () => {
    const report = makeReport({
      specRecommendations: [
        {
          type: 'collector',
          description: 'Add a logs collector to capture container logs.',
          rationale: 'Missing container logs prevent root-cause confirmation.',
        },
      ],
    });
    const result = generateHtmlReport(report);
    expect(result).toContain('Add a logs collector to capture container logs.');
  });

  it('renders the recommendation rationale', () => {
    const report = makeReport({
      specRecommendations: [
        {
          type: 'collector',
          description: 'Desc.',
          rationale: 'Missing container logs prevent root-cause confirmation.',
        },
      ],
    });
    const result = generateHtmlReport(report);
    expect(result).toContain('Missing container logs prevent root-cause confirmation.');
  });

  it('applies rec-collector CSS class for collector type', () => {
    const report = makeReport({
      specRecommendations: [{ type: 'collector', description: 'D', rationale: 'R' }],
    });
    const result = generateHtmlReport(report);
    expect(result).toContain('rec-collector');
  });

  it('applies rec-analyzer CSS class for analyzer type', () => {
    const report = makeReport({
      specRecommendations: [{ type: 'analyzer', description: 'D', rationale: 'R' }],
    });
    const result = generateHtmlReport(report);
    expect(result).toContain('rec-analyzer');
  });

  it('applies rec-redaction CSS class for redaction type', () => {
    const report = makeReport({
      specRecommendations: [{ type: 'redaction', description: 'D', rationale: 'R' }],
    });
    const result = generateHtmlReport(report);
    expect(result).toContain('rec-redaction');
  });

  it('renders a placeholder when specRecommendations is empty', () => {
    const report = makeReport({ specRecommendations: [] });
    const result = generateHtmlReport(report);
    expect(result).toContain('No spec improvements recommended.');
  });
});

// ---------------------------------------------------------------------------
// Section 10: Metadata section
// ---------------------------------------------------------------------------

describe('generateHtmlReport — metadata section', () => {
  it('contains the Generated At field', () => {
    const result = generateHtmlReport(makeReport());
    expect(result).toContain('Generated At');
  });

  it('contains a valid ISO-8601 timestamp', () => {
    const result = generateHtmlReport(makeReport());
    const isoPattern = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
    expect(result).toMatch(isoPattern);
  });

  it('contains the Total Findings count', () => {
    const report = makeReport({ findings: [makeFinding(), makeFinding({ id: 'finding:test:1' })] });
    const result = generateHtmlReport(report);
    expect(result).toContain('Total Findings');
  });

  it('metadata table shows correct findings count', () => {
    const findings = [makeFinding(), makeFinding({ id: 'finding:test:1' })];
    const report = makeReport({ findings });
    const result = generateHtmlReport(report);
    // The metadata table cell for findings count should contain 2
    expect(result).toContain('<td>2</td>');
  });

  it('metadata table shows correct evidence references count', () => {
    const report = makeReport({
      evidenceReferences: [
        { path: 'a.log', note: 'note a' },
        { path: 'b.log', note: 'note b' },
        { path: 'c.log', note: 'note c' },
      ],
    });
    const result = generateHtmlReport(report);
    expect(result).toContain('<td>3</td>');
  });
});

// ---------------------------------------------------------------------------
// Section 11: HTML escaping / safety
// ---------------------------------------------------------------------------

describe('generateHtmlReport — HTML escaping', () => {
  it('escapes < and > in finding title', () => {
    const finding = makeFinding({ title: 'Pod <app> failed' });
    const report = makeReport({ findings: [finding] });
    const result = generateHtmlReport(report);
    expect(result).toContain('Pod &lt;app&gt; failed');
    expect(result).not.toContain('<app>');
  });

  it('escapes & in executive summary', () => {
    const report = makeReport({ executiveSummary: 'DNS & network failures.' });
    const result = generateHtmlReport(report);
    expect(result).toContain('DNS &amp; network failures.');
  });

  it('escapes " in evidence path', () => {
    const finding = makeFinding({
      evidence: [{ path: 'path/to/"file".log', note: 'note' }],
    });
    const report = makeReport({ findings: [finding] });
    const result = generateHtmlReport(report);
    expect(result).toContain('&quot;');
  });
});

// ---------------------------------------------------------------------------
// Section 12: Empty / minimal report
// ---------------------------------------------------------------------------

describe('generateHtmlReport — empty report', () => {
  it('produces a non-empty HTML string for an empty report', () => {
    const report = makeReport({
      findings: [],
      evidenceReferences: [],
      contradictions: [],
      nextSteps: [],
      missingEvidence: [],
      specRecommendations: [],
      rootCause: null,
    });
    const result = generateHtmlReport(report);
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain('<!DOCTYPE html>');
  });

  it('still contains the header for an empty report', () => {
    const report = makeReport({
      findings: [],
      evidenceReferences: [],
      contradictions: [],
      nextSteps: [],
      missingEvidence: [],
      specRecommendations: [],
      rootCause: null,
    });
    const result = generateHtmlReport(report);
    expect(result).toContain('Investigation Report');
  });
});

// ---------------------------------------------------------------------------
// Section 13: writeHtmlReport — file output
// ---------------------------------------------------------------------------

describe('writeHtmlReport — file output', () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tmpDirs) {
      await fsp.rm(dir, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  async function makeTmpDir(): Promise<string> {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sbi-html-reporter-test-'));
    tmpDirs.push(dir);
    return dir;
  }

  it('returns the path to the written file', async () => {
    const dir = await makeTmpDir();
    const result = await writeHtmlReport(makeReport(), dir);
    expect(typeof result).toBe('string');
    expect(result.endsWith('findings.html')).toBe(true);
  });

  it('written file is named findings.html', async () => {
    const dir = await makeTmpDir();
    const filePath = await writeHtmlReport(makeReport(), dir);
    const basename = path.basename(filePath);
    expect(basename).toBe('findings.html');
  });

  it('written file exists on disk', async () => {
    const dir = await makeTmpDir();
    const filePath = await writeHtmlReport(makeReport(), dir);
    const stat = await fsp.stat(filePath);
    expect(stat.isFile()).toBe(true);
  });

  it('written file starts with <!DOCTYPE html>', async () => {
    const dir = await makeTmpDir();
    const filePath = await writeHtmlReport(makeReport(), dir);
    const content = await fsp.readFile(filePath, 'utf-8');
    expect(content.trimStart().startsWith('<!DOCTYPE html>')).toBe(true);
  });

  it('written file contains executive summary text', async () => {
    const dir = await makeTmpDir();
    const report = makeReport({ executiveSummary: 'Written to disk HTML summary.' });
    const filePath = await writeHtmlReport(report, dir);
    const content = await fsp.readFile(filePath, 'utf-8');
    expect(content).toContain('Written to disk HTML summary.');
  });

  it('creates the output directory when it does not exist', async () => {
    const dir = await makeTmpDir();
    const nestedDir = path.join(dir, 'nested', 'sub', 'dir');
    const filePath = await writeHtmlReport(makeReport(), nestedDir);
    const stat = await fsp.stat(filePath);
    expect(stat.isFile()).toBe(true);
  });

  it('written file is inside the specified outputDir', async () => {
    const dir = await makeTmpDir();
    const filePath = await writeHtmlReport(makeReport(), dir);
    expect(filePath.startsWith(dir)).toBe(true);
  });

  it('returns an absolute path even when outputDir is relative', async () => {
    const dir = await makeTmpDir();
    const relativeDir = path.relative(process.cwd(), dir);
    const filePath = await writeHtmlReport(makeReport(), relativeDir);
    expect(path.isAbsolute(filePath)).toBe(true);
    expect(filePath).toBe(path.join(dir, 'findings.html'));
  });

  it('written file contains embedded CSS', async () => {
    const dir = await makeTmpDir();
    const filePath = await writeHtmlReport(makeReport(), dir);
    const content = await fsp.readFile(filePath, 'utf-8');
    expect(content).toContain('<style>');
    expect(content).toContain('.severity-critical');
  });
});

// ---------------------------------------------------------------------------
// Section 14: AI-assisted finding badge rendering
// ---------------------------------------------------------------------------

describe('generateHtmlReport — AI-assisted finding badge', () => {
  it('renders the ai-assisted CSS class on an AI finding card', () => {
    const aiFinding = makeFinding({
      id: 'finding:ai:kubernetes:0',
      title: 'AI Database Auth Finding',
    });
    const report = makeReport({ findings: [aiFinding] });
    const result = generateHtmlReport(report);
    expect(result).toContain('ai-assisted');
  });

  it('renders the 🤖 AI-assisted badge text on an AI finding card', () => {
    const aiFinding = makeFinding({
      id: 'finding:ai:kubernetes:0',
      title: 'AI Finding',
    });
    const report = makeReport({ findings: [aiFinding] });
    const result = generateHtmlReport(report);
    expect(result).toContain('🤖');
    expect(result).toContain('AI-assisted');
  });

  it('renders the ai-badge CSS class on an AI finding card', () => {
    const aiFinding = makeFinding({
      id: 'finding:ai:log:1',
      title: 'AI Log Finding',
    });
    const report = makeReport({ findings: [aiFinding] });
    const result = generateHtmlReport(report);
    expect(result).toContain('class="ai-badge"');
  });

  it('does not render ai-assisted class attribute on heuristic finding card', () => {
    const heuristicFinding = makeFinding({
      id: 'finding:kubernetes:0',
      title: 'Heuristic Finding',
    });
    // Use a report with no AI findings so we can check the absence of the class attribute
    const report = makeReport({ findings: [heuristicFinding] });
    const result = generateHtmlReport(report);
    // The ai-assisted class may appear in the stylesheet, but must not appear as a card class
    expect(result).not.toContain('class="finding-card ai-assisted"');
    expect(result).not.toContain('🤖');
  });

  it('renders ai-assisted only on AI finding in a mixed list', () => {
    const heuristic = makeFinding({ id: 'finding:kubernetes:0', title: 'Heuristic' });
    const ai = makeFinding({ id: 'finding:ai:kubernetes:1', title: 'AI Finding' });
    const report = makeReport({ findings: [heuristic, ai] });
    const result = generateHtmlReport(report);
    // The ai-assisted class and badge should appear exactly for the AI finding
    expect(result).toContain('ai-assisted');
    expect(result).toContain('🤖');
  });

  it('CSS stylesheet defines ai-badge class', () => {
    const result = generateHtmlReport(makeReport());
    expect(result).toContain('.ai-badge');
  });

  it('CSS stylesheet defines ai-assisted finding-header style', () => {
    const result = generateHtmlReport(makeReport());
    expect(result).toContain('.finding-card.ai-assisted');
  });
});
