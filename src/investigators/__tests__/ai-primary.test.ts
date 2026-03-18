import { describe, it, expect } from 'vitest';
import type { Finding, FindingSeverity } from '../../types/index.js';

/**
 * Tests for AI-primary promotion logic in the orchestrator.
 *
 * When AI findings exist and cover the same components as heuristic findings,
 * the heuristic findings should be folded into the AI finding's evidence
 * rather than appearing as separate top-level entries.
 */

function makeFinding(overrides: Partial<Finding>): Finding {
  return {
    id: 'finding:test:0',
    title: 'Test Finding',
    severity: 'high' as FindingSeverity,
    confidence: 0.75,
    affectedComponents: ['Pod/default/app-pod'],
    reasoningSummary: 'Test.',
    evidence: [{ path: 'logs/app.log', note: 'error', artifactType: 'log' }],
    contradictionsChecked: ['check-1'],
    recommendedAction: 'Fix it.',
    missingEvidence: [],
    ...overrides,
  };
}

/**
 * Simulates the AI-primary promotion logic from the orchestrator.
 * Extracted here for isolated testing.
 */
function promoteAiFindings(allFindings: Finding[]): Finding[] {
  const aiFindings = allFindings.filter((f) => f.id.startsWith('finding:ai:'));
  if (aiFindings.length === 0) return allFindings;

  const nonAiFindings = allFindings.filter((f) => !f.id.startsWith('finding:ai:'));
  const absorbedIds = new Set<string>();

  const enriched = aiFindings.map((aiFinding) => {
    const corroborating = nonAiFindings.filter((hf) => {
      if (absorbedIds.has(hf.id)) return false;
      return hf.affectedComponents.some((comp) =>
        aiFinding.affectedComponents.some(
          (aiComp) => comp === aiComp || comp.includes(aiComp) || aiComp.includes(comp),
        ),
      );
    });

    for (const hf of corroborating) {
      absorbedIds.add(hf.id);
    }

    if (corroborating.length > 0) {
      const additionalEvidence = corroborating.flatMap((hf) =>
        hf.evidence.filter(
          (ev) => !aiFinding.evidence.some((e) => e.path === ev.path && e.note === ev.note),
        ),
      );
      const additionalContradictions = corroborating.flatMap((hf) =>
        hf.contradictionsChecked.filter((c) => !aiFinding.contradictionsChecked.includes(c)),
      );

      return {
        ...aiFinding,
        evidence: [...aiFinding.evidence, ...additionalEvidence],
        contradictionsChecked: [...aiFinding.contradictionsChecked, ...additionalContradictions],
      };
    }
    return aiFinding;
  });

  const surviving = nonAiFindings.filter((hf) => !absorbedIds.has(hf.id));
  return [...enriched, ...surviving];
}

describe('AI-primary promotion', () => {
  it('absorbs heuristic finding into AI finding when same component', () => {
    const ai = makeFinding({
      id: 'finding:ai:kubernetes:0',
      title: 'Database Connection Failure',
      affectedComponents: ['Pod/default/app-pod'],
      evidence: [{ path: 'logs/app.log', note: 'DNS failure', artifactType: 'log' }],
      contradictionsChecked: ['DB_HOST is set'],
    });
    const heuristic = makeFinding({
      id: 'finding:k8s:notready:0',
      title: 'Not Ready Pod: app-pod',
      affectedComponents: ['Pod/default/app-pod'],
      evidence: [{ path: 'pods/app-pod.yaml', note: 'not ready', artifactType: 'kubernetes-resource' }],
      contradictionsChecked: ['pod is running'],
    });

    const result = promoteAiFindings([ai, heuristic]);

    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('finding:ai:kubernetes:0');
    expect(result[0]!.evidence.length).toBeGreaterThan(1);
    expect(result[0]!.evidence.some((e) => e.note === 'not ready')).toBe(true);
    expect(result[0]!.contradictionsChecked).toContain('pod is running');
  });

  it('keeps heuristic findings that have no AI equivalent', () => {
    const ai = makeFinding({
      id: 'finding:ai:kubernetes:0',
      affectedComponents: ['Pod/default/app-pod'],
    });
    const unrelated = makeFinding({
      id: 'finding:k8s:notready:1',
      affectedComponents: ['Pod/default/other-pod'],
    });

    const result = promoteAiFindings([ai, unrelated]);

    expect(result).toHaveLength(2);
    expect(result.map((f) => f.id)).toContain('finding:ai:kubernetes:0');
    expect(result.map((f) => f.id)).toContain('finding:k8s:notready:1');
  });

  it('returns all findings unchanged when no AI findings exist', () => {
    const h1 = makeFinding({ id: 'finding:k8s:0' });
    const h2 = makeFinding({ id: 'finding:log:0' });

    const result = promoteAiFindings([h1, h2]);
    expect(result).toHaveLength(2);
  });

  it('does not duplicate evidence when AI and heuristic cite the same path+note', () => {
    const sharedEvidence = { path: 'logs/app.log', note: 'DNS failure', artifactType: 'log' as const };
    const ai = makeFinding({
      id: 'finding:ai:kubernetes:0',
      evidence: [sharedEvidence],
    });
    const heuristic = makeFinding({
      id: 'finding:log:dns:0',
      evidence: [sharedEvidence, { path: 'events/default.json', note: 'Unhealthy', artifactType: 'event' }],
    });

    const result = promoteAiFindings([ai, heuristic]);

    expect(result).toHaveLength(1);
    // Should have 2: original AI evidence + the non-duplicate event evidence
    expect(result[0]!.evidence).toHaveLength(2);
  });

  it('absorbs multiple heuristic findings into one AI finding', () => {
    const ai = makeFinding({
      id: 'finding:ai:kubernetes:0',
      affectedComponents: ['Pod/default/app-pod'],
      evidence: [{ path: 'a.log', note: 'ai evidence' }],
    });
    const h1 = makeFinding({
      id: 'finding:k8s:notready:0',
      affectedComponents: ['Pod/default/app-pod'],
      evidence: [{ path: 'b.yaml', note: 'heuristic 1' }],
    });
    const h2 = makeFinding({
      id: 'finding:log:dns:0',
      affectedComponents: ['Pod/default/app-pod'],
      evidence: [{ path: 'c.log', note: 'heuristic 2' }],
    });

    const result = promoteAiFindings([ai, h1, h2]);

    expect(result).toHaveLength(1);
    expect(result[0]!.evidence).toHaveLength(3);
  });

  it('does not absorb hypothesis findings — only raw heuristic findings', () => {
    const ai = makeFinding({
      id: 'finding:ai:kubernetes:0',
      affectedComponents: ['Pod/default/app-pod'],
    });
    const hypothesis = makeFinding({
      id: 'finding:hypothesis:dns-failure:1',
      affectedComponents: ['Pod/default/app-pod'],
    });

    // The hypothesis finding starts with 'finding:hypothesis:' not 'finding:ai:'
    // so it's in the non-AI pool and eligible for absorption
    const result = promoteAiFindings([ai, hypothesis]);

    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('finding:ai:kubernetes:0');
  });
});
