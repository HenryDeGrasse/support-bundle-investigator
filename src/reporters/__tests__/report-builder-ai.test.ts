import { describe, it, expect } from 'vitest';
import type { Finding, FindingSeverity, ArtifactCategory } from '../../types/index.js';
import type { BundleProfile } from '../../types/index.js';
import type { PipelineResult } from '../../pipeline/analyze.js';
import type { InvestigationGraphImpl } from '../../graph/index.js';
import type { InvestigationTrace } from '../../pipeline/trace.js';
import { buildReport, isAIFinding } from '../report-builder.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeHeuristicFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'finding:kubernetes:0',
    title: 'CrashLoopBackOff: Pod app-pod',
    severity: 'critical' as FindingSeverity,
    confidence: 0.9,
    affectedComponents: ['app-pod'],
    reasoningSummary: 'The pod is in CrashLoopBackOff with 8 restarts.',
    evidence: [
      {
        path: 'cluster-resources/pods/default.json',
        note: 'CrashLoopBackOff restartCount=8',
        artifactType: 'kubernetes-resource',
      },
    ],
    contradictionsChecked: ['Pod is not in Running state'],
    recommendedAction: 'Check pod logs and fix startup error.',
    missingEvidence: [],
    ...overrides,
  };
}

function makeAIFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'finding:ai:kubernetes:0',
    title: 'Database auth failure causing CrashLoopBackOff',
    severity: 'critical' as FindingSeverity,
    confidence: 0.85,
    affectedComponents: ['app-pod', 'db-config'],
    reasoningSummary:
      'The pod crashes due to a database authentication failure caused by a ConfigMap typo.',
    evidence: [
      {
        path: 'cluster-resources/pods/default.json',
        note: 'CrashLoopBackOff restartCount=8',
        artifactType: 'kubernetes-resource',
      },
      {
        path: 'logs/app-pod/app.log',
        note: 'FATAL: password authentication failed for user "admin"',
        artifactType: 'log',
      },
    ],
    contradictionsChecked: ['No successful DB connections found'],
    recommendedAction: 'Fix the DB_USER typo in ConfigMap db-config.',
    missingEvidence: [],
    ...overrides,
  };
}

function makeAISingleSourceFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'finding:ai:log:1',
    title: 'Log error pattern detected',
    severity: 'high' as FindingSeverity,
    confidence: 0.75,
    affectedComponents: ['app-pod'],
    reasoningSummary: 'Application logs show repeated errors.',
    evidence: [
      {
        path: 'logs/app-pod/app.log',
        note: 'ERROR: connection refused',
        artifactType: 'log',
      },
    ],
    contradictionsChecked: [],
    recommendedAction: 'Inspect application logs.',
    missingEvidence: [],
    ...overrides,
  };
}

function makeMinimalProfile(): BundleProfile {
  const emptyByCategory: Record<ArtifactCategory, number> = {
    analyzer: 0,
    log: 0,
    'kubernetes-resource': 0,
    event: 0,
    'cluster-info': 0,
    'helm-release': 0,
    unknown: 0,
  };
  return {
    manifest: {
      bundlePath: '/tmp/test.tar.gz',
      extractedPath: '/tmp/extracted',
      files: [],
      totalSize: 0,
      extractedAt: new Date(),
    },
    analyzerCount: 1,
    resourceCount: 2,
    eventCount: 1,
    logFileCount: 1,
    namespaces: ['default'],
    workloads: [],
    coverageGaps: [],
    artifactsByCategory: emptyByCategory,
  };
}

function makePipelineResult(findings: Finding[] = []): PipelineResult {
  return {
    profile: makeMinimalProfile(),
    analyzerResults: [],
    resources: [],
    events: [],
    logs: [],
    findings,
    findingTree: [],
    graph: {
      nodes: new Map(),
      edges: [],
    } as unknown as InvestigationGraphImpl,
    trace: {
      bundlePath: '/tmp/test.tar.gz',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      steps: [],
    } as unknown as InvestigationTrace,
  };
}

// ---------------------------------------------------------------------------
// Section 1: isAIFinding — helper function
// ---------------------------------------------------------------------------

describe('isAIFinding', () => {
  it('returns true for a finding with id starting with finding:ai:', () => {
    expect(isAIFinding(makeAIFinding())).toBe(true);
  });

  it('returns false for a heuristic finding (finding:kubernetes: prefix)', () => {
    expect(isAIFinding(makeHeuristicFinding())).toBe(false);
  });

  it('returns false for finding:test: prefix', () => {
    const f = makeHeuristicFinding({ id: 'finding:test:0' });
    expect(isAIFinding(f)).toBe(false);
  });

  it('returns true for any finding:ai: variant (finding:ai:log:1)', () => {
    expect(isAIFinding(makeAISingleSourceFinding())).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Section 2: Executive summary — AI annotation
// ---------------------------------------------------------------------------

describe('buildReport — executive summary AI annotation', () => {
  it('executive summary does not mention AI when there are no AI findings', () => {
    const report = buildReport(makePipelineResult([makeHeuristicFinding()]));
    expect(report.executiveSummary.toLowerCase()).not.toContain('ai');
  });

  it('executive summary mentions AI-augmented analysis when AI findings are present', () => {
    const report = buildReport(makePipelineResult([makeAIFinding()]));
    expect(report.executiveSummary.toLowerCase()).toContain('ai-augmented');
  });

  it('executive summary states AI finding count (1 finding)', () => {
    const report = buildReport(makePipelineResult([makeAIFinding()]));
    expect(report.executiveSummary).toContain('1 finding');
  });

  it('executive summary states AI finding count (2 findings)', () => {
    const report = buildReport(
      makePipelineResult([makeAIFinding(), makeAISingleSourceFinding()]),
    );
    // Should say "2 findings"
    expect(report.executiveSummary).toContain('2 findings');
  });

  it('executive summary mentions "cross-source" when cross-source AI findings are present', () => {
    const report = buildReport(makePipelineResult([makeAIFinding()]));
    expect(report.executiveSummary.toLowerCase()).toContain('cross-source');
  });

  it('executive summary does not mention "cross-source" when only single-source AI findings are present', () => {
    const report = buildReport(makePipelineResult([makeAISingleSourceFinding()]));
    expect(report.executiveSummary).toContain('AI-augmented analysis contributed 1 finding.');
    expect(report.executiveSummary.toLowerCase()).not.toContain('cross-source');
  });

  it('executive summary is unchanged when all findings are heuristic (no AI note)', () => {
    const heuristic = makeHeuristicFinding();
    const report = buildReport(makePipelineResult([heuristic]));
    // Should NOT contain AI-specific language
    expect(report.executiveSummary).not.toContain('AI-augmented');
    expect(report.executiveSummary).not.toContain('cross-source');
  });

  it('executive summary still includes top finding title with mixed findings', () => {
    // Heuristic finding is listed first (higher confidence)
    const heuristic = makeHeuristicFinding({ confidence: 0.95 });
    const ai = makeAIFinding({ confidence: 0.85 });
    const report = buildReport(makePipelineResult([heuristic, ai]));
    expect(report.executiveSummary).toContain('CrashLoopBackOff: Pod app-pod');
    expect(report.executiveSummary).toContain('AI-augmented');
  });
});

// ---------------------------------------------------------------------------
// Section 3: Root cause — cross-source AI finding preference
// ---------------------------------------------------------------------------

describe('buildReport — root cause prefers cross-source AI findings', () => {
  it('root cause uses cross-source AI finding when one is present', () => {
    // The AI finding has evidence from 2 artifact types (kubernetes-resource + log)
    const heuristic = makeHeuristicFinding();
    const ai = makeAIFinding(); // has kubernetes-resource + log evidence
    // Pass heuristic first (higher priority in list) but AI should win for root cause
    const report = buildReport(makePipelineResult([heuristic, ai]));
    expect(report.rootCause).toBe(
      'The pod crashes due to a database authentication failure caused by a ConfigMap typo.',
    );
  });

  it('root cause falls back to first finding when no cross-source AI finding present', () => {
    const heuristic = makeHeuristicFinding();
    const report = buildReport(makePipelineResult([heuristic]));
    expect(report.rootCause).toBe('The pod is in CrashLoopBackOff with 8 restarts.');
  });

  it('root cause uses first cross-source AI finding when multiple are present', () => {
    const ai1 = makeAIFinding({
      id: 'finding:ai:kubernetes:0',
      reasoningSummary: 'First cross-source AI finding.',
      evidence: [
        { path: 'pods/default.json', note: 'pod crash', artifactType: 'kubernetes-resource' },
        { path: 'logs/app.log', note: 'auth error', artifactType: 'log' },
      ],
    });
    const ai2 = makeAIFinding({
      id: 'finding:ai:kubernetes:1',
      reasoningSummary: 'Second cross-source AI finding.',
      evidence: [
        { path: 'pods/other.json', note: 'pod crash', artifactType: 'kubernetes-resource' },
        { path: 'events/default.json', note: 'BackOff event', artifactType: 'event' },
      ],
    });
    const report = buildReport(makePipelineResult([ai1, ai2]));
    expect(report.rootCause).toBe('First cross-source AI finding.');
  });

  it('root cause does NOT prefer single-source AI finding over heuristic finding', () => {
    // Single-source AI finding (only log evidence)
    const aiSingleSource = makeAISingleSourceFinding();
    const heuristic = makeHeuristicFinding();
    // Heuristic is first in the list, AI single-source is second
    const report = buildReport(makePipelineResult([heuristic, aiSingleSource]));
    // Since no cross-source AI finding exists, root cause should use first finding (heuristic)
    expect(report.rootCause).toBe('The pod is in CrashLoopBackOff with 8 restarts.');
  });

  it('root cause is null when there are no findings', () => {
    const report = buildReport(makePipelineResult([]));
    expect(report.rootCause).toBeNull();
  });

  it('root cause uses cross-source AI finding even when it is not the first in the list', () => {
    // heuristic finding is first (index 0), cross-source AI is second (index 1)
    const heuristic = makeHeuristicFinding();
    const ai = makeAIFinding(); // cross-source
    const report = buildReport(makePipelineResult([heuristic, ai]));
    // Root cause should prefer the cross-source AI finding
    expect(report.rootCause).toBe(
      'The pod crashes due to a database authentication failure caused by a ConfigMap typo.',
    );
  });
});

// ---------------------------------------------------------------------------
// Section 4: isAIFinding — edge cases
// ---------------------------------------------------------------------------

describe('isAIFinding — edge cases', () => {
  it('returns false for empty id string', () => {
    const f = makeHeuristicFinding({ id: '' });
    expect(isAIFinding(f)).toBe(false);
  });

  it('returns false for id that contains "ai" but does not start with finding:ai:', () => {
    const f = makeHeuristicFinding({ id: 'finding:kubernetes:ai-related:0' });
    expect(isAIFinding(f)).toBe(false);
  });

  it('returns true for finding:ai: with numeric suffix only', () => {
    const f = makeHeuristicFinding({ id: 'finding:ai:0' });
    expect(isAIFinding(f)).toBe(true);
  });
});
