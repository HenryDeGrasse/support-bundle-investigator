// ---------------------------------------------------------------------------
// Priority 7: AI Report Annotation Tests
// ---------------------------------------------------------------------------
//
// Tests that AI-contributed findings render correctly in all three report
// formats: Markdown, HTML, and JSON.

import { describe, it, expect } from 'vitest';
import { buildReport } from '../../../src/reporters/report-builder.js';
import { generateMarkdownReport } from '../../../src/reporters/markdown-reporter.js';
import { generateHtmlReport } from '../../../src/reporters/html-reporter.js';
import { generateJsonReport } from '../../../src/reporters/json-reporter.js';
import type { PipelineResult } from '../../../src/pipeline/analyze.js';
import type { Finding } from '../../../src/types/index.js';
import { InvestigationGraphImpl } from '../../../src/graph/investigation-graph.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHeuristicFinding(): Finding {
  return {
    id: 'finding:k8s:crashloop:0',
    title: 'CrashLoopBackOff: Pod app-pod',
    severity: 'critical',
    confidence: 0.95,
    affectedComponents: ['Pod/default/app-pod'],
    reasoningSummary: 'Pod is crash-looping with 8 restarts.',
    evidence: [{
      path: 'cluster-resources/pods/default/app-pod.yaml',
      note: 'Container is in CrashLoopBackOff',
    }],
    contradictionsChecked: ['Container is not running'],
    recommendedAction: 'Check container logs for startup errors.',
    missingEvidence: [],
  };
}

function makeAIFinding(): Finding {
  return {
    id: 'finding:ai:kubernetes:0',
    title: 'Missing Secret Causes Pod Crash [AI-assisted]',
    severity: 'critical',
    confidence: 0.9,
    affectedComponents: ['Pod/default/app-pod', 'Secret/default/app-credentials'],
    reasoningSummary: 'The pod crashes because secret app-credentials is missing. Logs confirm the error.',
    evidence: [
      { path: 'cluster-resources/pods/default/app-pod.yaml', note: 'Pod references missing secret' },
      { path: 'logs/app/app-pod.log', note: 'Error: secret app-credentials not found' },
      { path: 'cluster-resources/events/default.json', note: 'FailedMount event for app-credentials' },
    ],
    contradictionsChecked: ['No app-credentials secret exists in namespace default'],
    recommendedAction: 'Create the missing secret: kubectl create secret generic app-credentials',
    missingEvidence: ['Contents of the expected secret'],
  };
}

function makePipelineResult(findings: Finding[]): PipelineResult {
  return {
    profile: {
      manifest: { bundlePath: '', extractedPath: '', files: [], totalSize: 0, extractedAt: new Date() },
      analyzerCount: 0, logFileCount: 0, resourceCount: 0, eventCount: 0,
      namespaces: [], workloads: [], coverageGaps: [],
      artifactsByCategory: { analyzer: 0, log: 0, 'kubernetes-resource': 0, event: 0, 'cluster-info': 0, 'helm-release': 0, unknown: 0 },
    },
    analyzerResults: [],
    resources: [],
    events: [],
    logs: [],
    findings,
    graph: new InvestigationGraphImpl(),
    trace: { bundlePath: '', startedAt: '', completedAt: '', steps: [], summary: { filesProcessed: 0, categories: {} } },
  };
}

// ---------------------------------------------------------------------------
// Markdown report
// ---------------------------------------------------------------------------

describe('AI Report Annotation: Markdown', () => {
  it('AI-assisted findings show [AI-assisted] badge in title', () => {
    const result = makePipelineResult([makeHeuristicFinding(), makeAIFinding()]);
    const report = buildReport(result);
    const md = generateMarkdownReport(report);

    expect(md).toContain('[AI-assisted]');
  });

  it('heuristic findings do NOT show [AI-assisted] badge', () => {
    const result = makePipelineResult([makeHeuristicFinding()]);
    const report = buildReport(result);
    const md = generateMarkdownReport(report);

    expect(md).not.toContain('[AI-assisted]');
  });

  it('report with mixed findings renders both correctly', () => {
    const result = makePipelineResult([makeHeuristicFinding(), makeAIFinding()]);
    const report = buildReport(result);
    const md = generateMarkdownReport(report);

    // Both findings should appear
    expect(md).toContain('CrashLoopBackOff: Pod app-pod');
    expect(md).toContain('Missing Secret Causes Pod Crash');
    // Severity badges
    expect(md).toContain('CRITICAL');
  });

  it('AI finding evidence table includes all cross-source paths', () => {
    const result = makePipelineResult([makeAIFinding()]);
    const report = buildReport(result);
    const md = generateMarkdownReport(report);

    expect(md).toContain('cluster-resources/pods/default/app-pod.yaml');
    expect(md).toContain('logs/app/app-pod.log');
    expect(md).toContain('cluster-resources/events/default.json');
  });

  it('missing evidence from AI finding appears in Missing Evidence section', () => {
    const result = makePipelineResult([makeAIFinding()]);
    const report = buildReport(result);
    const md = generateMarkdownReport(report);

    expect(md).toContain('Contents of the expected secret');
  });
});

// ---------------------------------------------------------------------------
// HTML report
// ---------------------------------------------------------------------------

describe('AI Report Annotation: HTML', () => {
  it('HTML report includes AI-assisted findings', () => {
    const result = makePipelineResult([makeHeuristicFinding(), makeAIFinding()]);
    const report = buildReport(result);
    const html = generateHtmlReport(report);

    expect(html).toContain('Missing Secret Causes Pod Crash');
    expect(html).toContain('AI-assisted');
  });

  it('HTML report has valid structure with mixed findings', () => {
    const result = makePipelineResult([makeHeuristicFinding(), makeAIFinding()]);
    const report = buildReport(result);
    const html = generateHtmlReport(report);

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<html');
    expect(html).toContain('</html>');
    expect(html).toContain('CrashLoopBackOff');
    expect(html).toContain('Missing Secret');
  });

  it('HTML report escapes evidence path content', () => {
    const result = makePipelineResult([makeAIFinding()]);
    const report = buildReport(result);
    const html = generateHtmlReport(report);

    // Paths should not contain unescaped HTML
    expect(html).not.toContain('<script>');
  });
});

// ---------------------------------------------------------------------------
// JSON report
// ---------------------------------------------------------------------------

describe('AI Report Annotation: JSON', () => {
  it('JSON report contains both heuristic and AI findings', () => {
    const result = makePipelineResult([makeHeuristicFinding(), makeAIFinding()]);
    const report = buildReport(result);
    const json = generateJsonReport(report);
    const parsed = JSON.parse(json);

    expect(parsed.findings).toHaveLength(2);
  });

  it('each JSON finding has all required fields', () => {
    const result = makePipelineResult([makeAIFinding()]);
    const report = buildReport(result);
    const json = generateJsonReport(report);
    const parsed = JSON.parse(json);

    const finding = parsed.findings[0];
    expect(finding).toHaveProperty('title');
    expect(finding).toHaveProperty('severity');
    expect(finding).toHaveProperty('confidence');
    expect(finding).toHaveProperty('affectedComponents');
    expect(finding).toHaveProperty('reasoningSummary');
    expect(finding).toHaveProperty('evidence');
    expect(finding).toHaveProperty('contradictionsChecked');
    expect(finding).toHaveProperty('recommendedAction');
    expect(finding).toHaveProperty('missingEvidence');
  });

  it('AI finding evidence includes multiple paths (cross-source)', () => {
    const result = makePipelineResult([makeAIFinding()]);
    const report = buildReport(result);
    const json = generateJsonReport(report);
    const parsed = JSON.parse(json);

    const evidencePaths = parsed.findings[0].evidence.map((e: { path: string }) => e.path);
    expect(evidencePaths).toContain('cluster-resources/pods/default/app-pod.yaml');
    expect(evidencePaths).toContain('logs/app/app-pod.log');
    expect(evidencePaths).toContain('cluster-resources/events/default.json');
  });

  it('JSON report is round-trip parseable', () => {
    const result = makePipelineResult([makeHeuristicFinding(), makeAIFinding()]);
    const report = buildReport(result);
    const json = generateJsonReport(report);

    expect(() => JSON.parse(json)).not.toThrow();
    const parsed = JSON.parse(json);
    expect(parsed.findings).toBeInstanceOf(Array);
    expect(parsed.executiveSummary).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Executive summary AI mention
// ---------------------------------------------------------------------------

describe('AI Report Annotation: executive summary', () => {
  it('does NOT mention AI when no AI findings are present', () => {
    const result = makePipelineResult([makeHeuristicFinding()]);
    const report = buildReport(result);
    const md = generateMarkdownReport(report);

    // Should not mention AI-augmented analysis
    expect(md.toLowerCase()).not.toContain('ai-augmented');
  });
});
