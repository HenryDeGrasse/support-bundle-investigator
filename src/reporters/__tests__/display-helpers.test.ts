import { describe, it, expect } from 'vitest';
import {
  cleanEvidencePath,
  humanizeTitle,
  humanizeReasoning,
  collapseEvidence,
  formatSummaryCard,
} from '../display-helpers.js';
import type { Evidence, Finding } from '../../types/index.js';

// ---------------------------------------------------------------------------
// cleanEvidencePath
// ---------------------------------------------------------------------------

describe('cleanEvidencePath', () => {
  it('strips an absolute temp extraction prefix leaving the bundle-relative path', () => {
    const input =
      '/var/folders/26/7kx/T/sbi-bundle-NpIkdp/wrong-db-endpoint/logs/app/app-pod.log';
    expect(cleanEvidencePath(input)).toBe('logs/app/app-pod.log');
  });

  it('strips extraction prefix with scenario directory', () => {
    expect(
      cleanEvidencePath(
        '/tmp/sbi-bundle-ABCD/missing-secret/cluster-resources/pods/default/app.yaml',
      ),
    ).toBe('cluster-resources/pods/default/app.yaml');
  });

  it('keeps already-relative paths unchanged', () => {
    expect(cleanEvidencePath('cluster-resources/pods/default/app.yaml')).toBe(
      'cluster-resources/pods/default/app.yaml',
    );
  });

  it('keeps short relative paths unchanged', () => {
    expect(cleanEvidencePath('logs/app.log')).toBe('logs/app.log');
  });

  it('handles paths with no sbi-bundle prefix — strips up to known bundle directories', () => {
    expect(
      cleanEvidencePath('/some/other/path/cluster-resources/events/default.json'),
    ).toBe('cluster-resources/events/default.json');
  });

  it('strips to known bundle directory: analyzers/', () => {
    expect(cleanEvidencePath('/tmp/foo/analyzers/analysis.json')).toBe(
      'analyzers/analysis.json',
    );
  });

  it('strips to known bundle directory: logs/', () => {
    expect(cleanEvidencePath('/tmp/foo/bar/logs/app/pod.log')).toBe('logs/app/pod.log');
  });

  it('returns the original when no known prefix is found', () => {
    expect(cleanEvidencePath('pod-status')).toBe('pod-status');
  });

  it('handles empty string', () => {
    expect(cleanEvidencePath('')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// humanizeTitle
// ---------------------------------------------------------------------------

describe('humanizeTitle', () => {
  it('strips the [Hypothesis] prefix', () => {
    expect(
      humanizeTitle(
        '[Hypothesis] DNS resolution is failing for a hostname (symptom: Pod is not ready)',
      ),
    ).not.toContain('[Hypothesis]');
  });

  it('strips the (symptom: ...) suffix', () => {
    expect(
      humanizeTitle(
        '[Hypothesis] DNS resolution is failing (symptom: Pod app-pod is not ready in namespace default)',
      ),
    ).not.toContain('(symptom:');
  });

  it('produces a concise title from a full hypothesis title', () => {
    const result = humanizeTitle(
      "[Hypothesis] DNS resolution is failing for a hostname the application depends on, preventing startup (symptom: Pod 'app-pod' is running but not ready in namespace 'default')",
    );
    expect(result).toBe(
      'DNS resolution is failing for a hostname the application depends on, preventing startup',
    );
  });

  it('leaves non-hypothesis titles untouched', () => {
    expect(humanizeTitle('CrashLoopBackOff: Pod app-pod')).toBe(
      'CrashLoopBackOff: Pod app-pod',
    );
  });

  it('strips absolute temp paths from log-investigator titles', () => {
    expect(
      humanizeTitle(
        'DNS Resolution Failures in /var/folders/26/x/T/sbi-bundle-AB/wrong-db/logs/app/app-pod.log',
      ),
    ).toBe('DNS Resolution Failures in logs/app/app-pod.log');
  });

  it('preserves the original preposition when cleaning absolute paths', () => {
    expect(
      humanizeTitle(
        'Missing resource logs from /tmp/sbi-bundle-AB/pvc-pending/logs/app/worker.log',
      ),
    ).toBe('Missing resource logs from logs/app/worker.log');
  });
});

// ---------------------------------------------------------------------------
// humanizeReasoning
// ---------------------------------------------------------------------------

describe('humanizeReasoning', () => {
  it('strips the [Differential diagnosis, rank #N] prefix', () => {
    const input =
      '[Differential diagnosis, rank #1] Root cause: DNS is failing. Symptom: Pod not ready.';
    expect(humanizeReasoning(input)).not.toContain('[Differential diagnosis');
  });

  it('removes "Confidence rationale: Confidence 0.XX: ..." sentence', () => {
    const input =
      'Root cause: DNS failure. Confidence rationale: Confidence 0.81: 6 supporting evidence items; 6 specific diagnostic signals. More text here.';
    const result = humanizeReasoning(input);
    expect(result).not.toContain('Confidence rationale:');
    expect(result).not.toContain('supporting evidence items');
  });

  it('keeps the "Preferred over runner-up" sentence', () => {
    const input =
      'Root cause: DNS failure. Preferred over runner-up "connectivity-failure" because of direct evidence.';
    expect(humanizeReasoning(input)).toContain('Preferred over runner-up');
  });

  it('removes "Derived from N raw finding(s):" sentences', () => {
    const input =
      'Root cause: DNS failure. Derived from 1 raw finding(s): finding:k8s:notready:0.';
    expect(humanizeReasoning(input)).not.toContain('Derived from');
  });

  it('cleans "Symptom: Pod ... in namespace ..." into readable form', () => {
    const input =
      "Root cause: DNS failure. Symptom: Pod 'app-pod' is running but not ready in namespace 'default'.";
    const result = humanizeReasoning(input);
    expect(result).toContain('Symptom:');
  });

  it('trims whitespace and collapses multiple spaces', () => {
    const input = '  Root cause: DNS.   Extra   spaces.  ';
    expect(humanizeReasoning(input)).toBe('Root cause: DNS. Extra spaces.');
  });
});

// ---------------------------------------------------------------------------
// collapseEvidence
// ---------------------------------------------------------------------------

describe('collapseEvidence', () => {
  it('collapses N evidence items with the same path into one', () => {
    const items: Evidence[] = [
      { path: 'logs/app.log', note: 'ERROR lookup db.internal: no such host' },
      { path: 'logs/app.log', note: 'ERROR lookup db.internal: no such host (retry 1)' },
      { path: 'logs/app.log', note: 'ERROR lookup db.internal: no such host (retry 2)' },
    ];
    const result = collapseEvidence(items);
    expect(result).toHaveLength(1);
    expect(result[0]!.note).toMatch(/3.*occurrence/i);
  });

  it('keeps items from different paths separate', () => {
    const items: Evidence[] = [
      { path: 'logs/a.log', note: 'error A' },
      { path: 'logs/b.log', note: 'error B' },
    ];
    expect(collapseEvidence(items)).toHaveLength(2);
  });

  it('returns empty for empty input', () => {
    expect(collapseEvidence([])).toEqual([]);
  });

  it('preserves single items unchanged', () => {
    const items: Evidence[] = [
      { path: 'logs/a.log', note: 'single error', artifactType: 'log' },
    ];
    const result = collapseEvidence(items);
    expect(result).toHaveLength(1);
    expect(result[0]!.note).toBe('single error');
  });

  it('preserves artifactType from the first item in a collapsed group', () => {
    const items: Evidence[] = [
      { path: 'logs/a.log', note: 'err 1', artifactType: 'log' },
      { path: 'logs/a.log', note: 'err 2', artifactType: 'log' },
    ];
    const result = collapseEvidence(items);
    expect(result[0]!.artifactType).toBe('log');
  });
});

// ---------------------------------------------------------------------------
// formatSummaryCard
// ---------------------------------------------------------------------------

describe('formatSummaryCard', () => {
  const finding: Finding = {
    id: 'finding:hypothesis:dns-failure:1',
    title: 'DNS failure for db.internal',
    severity: 'high',
    confidence: 0.81,
    affectedComponents: ['Pod/default/app-pod'],
    reasoningSummary: 'DNS is failing.',
    evidence: [],
    contradictionsChecked: [],
    recommendedAction: 'Check CoreDNS logs.',
    missingEvidence: [],
  };

  it('includes the root cause title', () => {
    expect(formatSummaryCard(finding, 5)).toContain('DNS failure');
  });

  it('includes the recommended action', () => {
    expect(formatSummaryCard(finding, 5)).toContain('Check CoreDNS logs');
  });

  it('includes the confidence percentage', () => {
    expect(formatSummaryCard(finding, 5)).toContain('81%');
  });

  it('includes the finding count', () => {
    expect(formatSummaryCard(finding, 5)).toContain('5');
  });

  it('does not contain emoji', () => {
    const result = formatSummaryCard(finding, 5);
    expect(result).not.toMatch(/[\u{1F300}-\u{1F9FF}]/u);
  });
});
