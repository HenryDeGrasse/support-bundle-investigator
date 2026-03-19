import { describe, it, expect } from 'vitest';
import type { Finding, FindingSeverity, ArtifactCategory } from '../../types/index.js';
import type { BundleProfile } from '../../types/index.js';
import type { PipelineResult } from '../../pipeline/analyze.js';
import type { InvestigationGraphImpl } from '../../graph/index.js';
import type { InvestigationTrace } from '../../pipeline/trace.js';
import { buildReport } from '../report-builder.js';

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
    reasoningSummary: 'A database hostname misconfiguration is causing DNS lookup failures.',
    evidence: [
      {
        path: 'logs/app/current.log',
        note: 'lookup db.internal: no such host',
        artifactType: 'log',
      },
    ],
    contradictionsChecked: ['No successful DB connection logs found'],
    recommendedAction: 'Update the DB_HOST environment variable to the correct hostname.',
    missingEvidence: ['Kubernetes events for pod app-pod'],
    ...overrides,
  };
}

function makeCriticalFinding(): Finding {
  return makeFinding({
    id: 'finding:test:critical',
    title: 'CrashLoopBackOff: Pod crashing at startup',
    severity: 'critical',
    confidence: 0.95,
    reasoningSummary: 'The app-pod is in CrashLoopBackOff due to a missing secret.',
    recommendedAction: 'Create the missing secret app-credentials.',
    missingEvidence: ['Container logs for app-pod'],
    contradictionsChecked: ['Pod is not in Running state'],
  });
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
// Section 1: buildReport — return type and structure
// ---------------------------------------------------------------------------

describe('buildReport — return type and structure', () => {
  it('returns an object with executiveSummary', () => {
    const report = buildReport(makePipelineResult([makeFinding()]));
    expect(typeof report.executiveSummary).toBe('string');
  });

  it('returns an object with findings array', () => {
    const result = makePipelineResult([makeFinding()]);
    const report = buildReport(result);
    expect(Array.isArray(report.findings)).toBe(true);
  });

  it('returns an object with rootCause', () => {
    const report = buildReport(makePipelineResult([makeFinding()]));
    expect('rootCause' in report).toBe(true);
  });

  it('returns an object with evidenceReferences array', () => {
    const report = buildReport(makePipelineResult([makeFinding()]));
    expect(Array.isArray(report.evidenceReferences)).toBe(true);
  });

  it('returns an object with contradictions array', () => {
    const report = buildReport(makePipelineResult([makeFinding()]));
    expect(Array.isArray(report.contradictions)).toBe(true);
  });

  it('returns an object with nextSteps array', () => {
    const report = buildReport(makePipelineResult([makeFinding()]));
    expect(Array.isArray(report.nextSteps)).toBe(true);
  });

  it('returns an object with missingEvidence array', () => {
    const report = buildReport(makePipelineResult([makeFinding()]));
    expect(Array.isArray(report.missingEvidence)).toBe(true);
  });

  it('returns an object with specRecommendations array', () => {
    const report = buildReport(makePipelineResult([makeFinding()]));
    expect(Array.isArray(report.specRecommendations)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Section 2: buildReport — findings pass-through
// ---------------------------------------------------------------------------

describe('buildReport — findings pass-through', () => {
  it('report findings array matches input findings', () => {
    const findings = [makeFinding({ id: 'f:0' }), makeFinding({ id: 'f:1' })];
    const report = buildReport(makePipelineResult(findings));
    expect(report.findings.length).toBe(2);
    expect(report.findings[0]!.id).toBe('f:0');
    expect(report.findings[1]!.id).toBe('f:1');
  });

  it('report findings are the same array reference (no copy)', () => {
    const findings = [makeFinding()];
    const result = makePipelineResult(findings);
    const report = buildReport(result);
    expect(report.findings).toBe(result.findings);
  });

  it('report findings array is empty when pipeline has no findings', () => {
    const report = buildReport(makePipelineResult([]));
    expect(report.findings.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Section 3: buildReport — root cause
// ---------------------------------------------------------------------------

describe('buildReport — root cause', () => {
  it('rootCause is null when there are no findings', () => {
    const report = buildReport(makePipelineResult([]));
    expect(report.rootCause).toBeNull();
  });

  it('rootCause is non-null when there is at least one finding', () => {
    const report = buildReport(makePipelineResult([makeFinding()]));
    expect(report.rootCause).not.toBeNull();
  });

  it('rootCause is derived from the first (highest-ranked) finding', () => {
    const topFinding = makeFinding({
      id: 'top',
      reasoningSummary: 'The main root cause of all failures.',
    });
    const secondFinding = makeFinding({
      id: 'second',
      reasoningSummary: 'Secondary reasoning.',
    });
    const report = buildReport(makePipelineResult([topFinding, secondFinding]));
    expect(report.rootCause).toBe('The main root cause of all failures.');
  });

  it('rootCause is a string when a finding is present', () => {
    const report = buildReport(makePipelineResult([makeFinding()]));
    expect(typeof report.rootCause).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// Section 4: buildReport — executive summary
// ---------------------------------------------------------------------------

describe('buildReport — executive summary', () => {
  it('executive summary is non-empty for a report with findings', () => {
    const report = buildReport(makePipelineResult([makeFinding()]));
    expect(report.executiveSummary.length).toBeGreaterThan(0);
  });

  it('executive summary mentions the finding count', () => {
    const findings = [makeFinding({ id: 'f:0' }), makeFinding({ id: 'f:1' })];
    const report = buildReport(makePipelineResult(findings));
    expect(report.executiveSummary).toContain('2');
  });

  it('executive summary mentions critical count when critical findings present', () => {
    const report = buildReport(makePipelineResult([makeCriticalFinding()]));
    expect(report.executiveSummary.toLowerCase()).toContain('critical');
  });

  it('executive summary states no issues when there are no findings', () => {
    const report = buildReport(makePipelineResult([]));
    expect(report.executiveSummary.toLowerCase()).toContain('no significant issues');
  });

  it('executive summary includes the top finding title', () => {
    const finding = makeFinding({ title: 'CrashLoopBackOff: Pod app-pod' });
    const report = buildReport(makePipelineResult([finding]));
    expect(report.executiveSummary).toContain('CrashLoopBackOff: Pod app-pod');
  });

  it('executive summary includes recommended action from top finding', () => {
    const finding = makeFinding({
      recommendedAction: 'Restart the deployment immediately.',
    });
    const report = buildReport(makePipelineResult([finding]));
    expect(report.executiveSummary).toContain('Restart the deployment immediately.');
  });

  it('executive summary humanizes legacy hypothesis titles', () => {
    const finding = makeFinding({
      title: '[Hypothesis] DNS failure for db.internal (symptom: Pod app-pod is not ready)',
    });
    const report = buildReport(makePipelineResult([finding]));
    expect(report.executiveSummary).toContain('Most significant: DNS failure for db.internal');
    expect(report.executiveSummary).not.toContain('[Hypothesis]');
    expect(report.executiveSummary).not.toContain('(symptom:');
  });
});

// ---------------------------------------------------------------------------
// Section 5: buildReport — evidence references
// ---------------------------------------------------------------------------

describe('buildReport — evidence references', () => {
  it('collects evidence references from all findings', () => {
    const f1 = makeFinding({
      id: 'f:0',
      evidence: [{ path: 'logs/a.log', note: 'note a', artifactType: 'log' }],
    });
    const f2 = makeFinding({
      id: 'f:1',
      evidence: [{ path: 'logs/b.log', note: 'note b', artifactType: 'log' }],
    });
    const report = buildReport(makePipelineResult([f1, f2]));
    expect(report.evidenceReferences.length).toBe(2);
  });

  it('deduplicates evidence references by path', () => {
    const sharedEvidence = [
      { path: 'logs/shared.log', note: 'note from finding 1', artifactType: 'log' as const },
    ];
    const f1 = makeFinding({ id: 'f:0', evidence: sharedEvidence });
    const f2 = makeFinding({ id: 'f:1', evidence: sharedEvidence });
    const report = buildReport(makePipelineResult([f1, f2]));
    expect(report.evidenceReferences.length).toBe(1);
    expect(report.evidenceReferences[0]!.path).toBe('logs/shared.log');
  });

  it('evidence reference has path and note fields', () => {
    const finding = makeFinding({
      evidence: [{ path: 'cluster-resources/pods/default/app.yaml', note: 'CrashLoopBackOff' }],
    });
    const report = buildReport(makePipelineResult([finding]));
    const ref = report.evidenceReferences[0]!;
    expect(ref.path).toBe('cluster-resources/pods/default/app.yaml');
    expect(ref.note).toBe('CrashLoopBackOff');
  });

  it('cleans absolute evidence paths before storing evidence references', () => {
    const finding = makeFinding({
      evidence: [
        {
          path: '/var/folders/26/x/T/sbi-bundle-AB/wrong-db/logs/app/app-pod.log',
          note: 'DNS failure',
          artifactType: 'log',
        },
      ],
    });
    const report = buildReport(makePipelineResult([finding]));
    expect(report.evidenceReferences[0]!.path).toBe('logs/app/app-pod.log');
  });

  it('evidence references is empty when findings have no evidence', () => {
    const finding = makeFinding({ evidence: [] });
    const report = buildReport(makePipelineResult([finding]));
    expect(report.evidenceReferences.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Section 6: buildReport — contradictions
// ---------------------------------------------------------------------------

describe('buildReport — contradictions', () => {
  it('collects contradictions from all findings', () => {
    const f1 = makeFinding({
      id: 'f:0',
      contradictionsChecked: ['Contradiction A'],
    });
    const f2 = makeFinding({
      id: 'f:1',
      contradictionsChecked: ['Contradiction B'],
    });
    const report = buildReport(makePipelineResult([f1, f2]));
    expect(report.contradictions).toContain('Contradiction A');
    expect(report.contradictions).toContain('Contradiction B');
  });

  it('deduplicates contradictions across findings', () => {
    const f1 = makeFinding({ id: 'f:0', contradictionsChecked: ['Shared contradiction'] });
    const f2 = makeFinding({ id: 'f:1', contradictionsChecked: ['Shared contradiction'] });
    const report = buildReport(makePipelineResult([f1, f2]));
    expect(report.contradictions.length).toBe(1);
  });

  it('contradictions is empty when no findings have contradictions checked', () => {
    const finding = makeFinding({ contradictionsChecked: [] });
    const report = buildReport(makePipelineResult([finding]));
    expect(report.contradictions.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Section 7: buildReport — next steps
// ---------------------------------------------------------------------------

describe('buildReport — next steps', () => {
  it('collects recommendedAction from each finding as a next step', () => {
    const f1 = makeFinding({ id: 'f:0', recommendedAction: 'Do thing A.' });
    const f2 = makeFinding({ id: 'f:1', recommendedAction: 'Do thing B.' });
    const report = buildReport(makePipelineResult([f1, f2]));
    expect(report.nextSteps).toContain('Do thing A.');
    expect(report.nextSteps).toContain('Do thing B.');
  });

  it('deduplicates next steps when multiple findings share the same action', () => {
    const f1 = makeFinding({ id: 'f:0', recommendedAction: 'Restart the pod.' });
    const f2 = makeFinding({ id: 'f:1', recommendedAction: 'Restart the pod.' });
    const report = buildReport(makePipelineResult([f1, f2]));
    const restartSteps = report.nextSteps.filter((s) => s === 'Restart the pod.');
    expect(restartSteps.length).toBe(1);
  });

  it('next steps is empty when there are no findings', () => {
    const report = buildReport(makePipelineResult([]));
    expect(report.nextSteps.length).toBe(0);
  });

  it('next steps length equals unique actions across findings', () => {
    const findings = [
      makeFinding({ id: 'f:0', recommendedAction: 'Action A.' }),
      makeFinding({ id: 'f:1', recommendedAction: 'Action B.' }),
      makeFinding({ id: 'f:2', recommendedAction: 'Action A.' }), // duplicate
    ];
    const report = buildReport(makePipelineResult(findings));
    expect(report.nextSteps.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Section 8: buildReport — missing evidence
// ---------------------------------------------------------------------------

describe('buildReport — missing evidence', () => {
  it('collects missingEvidence from all findings', () => {
    const f1 = makeFinding({ id: 'f:0', missingEvidence: ['Logs for pod A'] });
    const f2 = makeFinding({ id: 'f:1', missingEvidence: ['Events for pod B'] });
    const report = buildReport(makePipelineResult([f1, f2]));
    expect(report.missingEvidence).toContain('Logs for pod A');
    expect(report.missingEvidence).toContain('Events for pod B');
  });

  it('deduplicates missing evidence entries', () => {
    const f1 = makeFinding({ id: 'f:0', missingEvidence: ['Kubernetes events'] });
    const f2 = makeFinding({ id: 'f:1', missingEvidence: ['Kubernetes events'] });
    const report = buildReport(makePipelineResult([f1, f2]));
    const dupes = report.missingEvidence.filter((m) => m === 'Kubernetes events');
    expect(dupes.length).toBe(1);
  });

  it('missingEvidence is empty when no findings have missing evidence', () => {
    const finding = makeFinding({ missingEvidence: [] });
    const report = buildReport(makePipelineResult([finding]));
    expect(report.missingEvidence.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Section 9: buildReport — spec recommendations
// ---------------------------------------------------------------------------

describe('buildReport — spec recommendations', () => {
  it('generates spec recommendations from findings and profile', () => {
    const finding = makeFinding({
      missingEvidence: ['Container log files for the app pod'],
    });
    const report = buildReport(makePipelineResult([finding]));
    expect(Array.isArray(report.specRecommendations)).toBe(true);
  });

  it('spec recommendations have type, description, and rationale fields', () => {
    const finding = makeFinding({
      missingEvidence: ['Container log files for the app pod'],
    });
    const report = buildReport(makePipelineResult([finding]));
    if (report.specRecommendations.length > 0) {
      const rec = report.specRecommendations[0]!;
      expect(typeof rec.type).toBe('string');
      expect(typeof rec.description).toBe('string');
      expect(typeof rec.rationale).toBe('string');
    }
  });

  it('generates no spec recommendations when findings and profile have no gaps', () => {
    const finding = makeFinding({ missingEvidence: [] });
    const report = buildReport(makePipelineResult([finding]));
    expect(report.specRecommendations.length).toBe(0);
  });

  it('spec recommendation types are valid SpecRecommendationType values', () => {
    const finding = makeFinding({
      missingEvidence: ['Container log files', 'Kubernetes events'],
    });
    const report = buildReport(makePipelineResult([finding]));
    const validTypes = new Set(['collector', 'analyzer', 'redaction']);
    for (const rec of report.specRecommendations) {
      expect(validTypes.has(rec.type)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Section 10: buildReport — empty pipeline result
// ---------------------------------------------------------------------------

describe('buildReport — empty pipeline result', () => {
  it('handles empty findings without throwing', () => {
    expect(() => buildReport(makePipelineResult([]))).not.toThrow();
  });

  it('returns empty arrays for all collection fields when findings is empty', () => {
    const report = buildReport(makePipelineResult([]));
    expect(report.findings.length).toBe(0);
    expect(report.evidenceReferences.length).toBe(0);
    expect(report.contradictions.length).toBe(0);
    expect(report.nextSteps.length).toBe(0);
    expect(report.missingEvidence.length).toBe(0);
    expect(report.specRecommendations.length).toBe(0);
  });

  it('rootCause is null when findings is empty', () => {
    const report = buildReport(makePipelineResult([]));
    expect(report.rootCause).toBeNull();
  });
});
