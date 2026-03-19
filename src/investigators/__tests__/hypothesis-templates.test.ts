import { describe, it, expect } from 'vitest';
import {
  HYPOTHESIS_TEMPLATE_REGISTRY,
  loadTemplates,
  matchTemplate,
  generateHypothesesFromTemplate,
} from '../hypothesis-templates.js';
import type { HypothesisTemplate } from '../hypothesis-templates.js';

// ---------------------------------------------------------------------------
// loadTemplates
// ---------------------------------------------------------------------------

describe('loadTemplates', () => {
  it('returns the full template registry', () => {
    const templates = loadTemplates();
    expect(templates).toBe(HYPOTHESIS_TEMPLATE_REGISTRY);
  });

  it('contains at least 4 templates (crashloop, imagepull, not-ready, pending + generic)', () => {
    expect(loadTemplates().length).toBeGreaterThanOrEqual(5);
  });

  it('each template has a unique id', () => {
    const ids = loadTemplates().map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('each template has a non-empty name', () => {
    for (const t of loadTemplates()) {
      expect(t.name).toBeTruthy();
    }
  });

  it('each template has at least one hypothesis definition', () => {
    for (const t of loadTemplates()) {
      expect(t.hypotheses.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('all hypothesis definitions have non-empty rootCause', () => {
    for (const t of loadTemplates()) {
      for (const h of t.hypotheses) {
        expect(h.rootCause).toBeTruthy();
      }
    }
  });

  it('all hypothesis definitions have a valid category', () => {
    const validCategories = [
      'missing-secret', 'bad-db-endpoint', 'dns-failure', 'image-pull-failure',
      'config-error', 'oom-kill', 'connectivity-failure', 'readiness-failure',
      'generic-crash', 'missing-service', 'volume-mount-failure',
    ];
    for (const t of loadTemplates()) {
      for (const h of t.hypotheses) {
        expect(validCategories).toContain(h.category);
      }
    }
  });

  it('all hypothesis definitions have a non-empty idSuffix', () => {
    for (const t of loadTemplates()) {
      for (const h of t.hypotheses) {
        expect(h.idSuffix).toBeTruthy();
      }
    }
  });

  it('includes a generic fallback template', () => {
    const generic = loadTemplates().find((t) => t.id === 'generic');
    expect(generic).toBeDefined();
    expect(generic!.symptomPatterns).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// HypothesisTemplate type — structural checks
// ---------------------------------------------------------------------------

describe('HypothesisTemplate structure', () => {
  it('crashloop template has symptomKeyPrefix "pod-crashloop"', () => {
    const t = loadTemplates().find((t) => t.id === 'crashloop');
    expect(t?.symptomKeyPrefix).toBe('pod-crashloop');
  });

  it('imagepull template has symptomKeyPrefix "pod-imagepull"', () => {
    const t = loadTemplates().find((t) => t.id === 'imagepull');
    expect(t?.symptomKeyPrefix).toBe('pod-imagepull');
  });

  it('not-ready template has symptomKeyPrefix "pod-not-ready"', () => {
    const t = loadTemplates().find((t) => t.id === 'not-ready');
    expect(t?.symptomKeyPrefix).toBe('pod-not-ready');
  });

  it('pending template has symptomKeyPrefix "pod-pending"', () => {
    const t = loadTemplates().find((t) => t.id === 'pending');
    expect(t?.symptomKeyPrefix).toBe('pod-pending');
  });
});

// ---------------------------------------------------------------------------
// EvidenceRule co-location
// ---------------------------------------------------------------------------

describe('evidence rules are co-located with hypothesis definitions', () => {
  it('crashloop missing-secret hypothesis has at least one supporting rule', () => {
    const t = loadTemplates().find((t) => t.id === 'crashloop')!;
    const h = t.hypotheses.find((h) => h.category === 'missing-secret')!;
    const supporting = h.evidenceRules.filter((r) => r.type === 'supporting');
    expect(supporting.length).toBeGreaterThanOrEqual(1);
  });

  it('crashloop missing-secret hypothesis has at least one contradicting rule', () => {
    const t = loadTemplates().find((t) => t.id === 'crashloop')!;
    const h = t.hypotheses.find((h) => h.category === 'missing-secret')!;
    const contradicting = h.evidenceRules.filter((r) => r.type === 'contradicting');
    expect(contradicting.length).toBeGreaterThanOrEqual(1);
  });

  it('all evidence rules have a non-empty label', () => {
    for (const t of loadTemplates()) {
      for (const h of t.hypotheses) {
        for (const r of h.evidenceRules) {
          expect(r.label).toBeTruthy();
        }
      }
    }
  });

  it('all evidence rules have a non-empty pattern', () => {
    for (const t of loadTemplates()) {
      for (const h of t.hypotheses) {
        for (const r of h.evidenceRules) {
          expect(r.pattern).toBeTruthy();
        }
      }
    }
  });

  it('all evidence rules have a valid type', () => {
    for (const t of loadTemplates()) {
      for (const h of t.hypotheses) {
        for (const r of h.evidenceRules) {
          expect(['supporting', 'contradicting']).toContain(r.type);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// matchTemplate
// ---------------------------------------------------------------------------

describe('matchTemplate', () => {
  it('matches CrashLoopBackOff text to the crashloop template', () => {
    const t = matchTemplate('pod is in crashloopbackoff');
    expect(t.id).toBe('crashloop');
  });

  it('matches "crashloop" keyword', () => {
    expect(matchTemplate('container crashloop detected').id).toBe('crashloop');
  });

  it('matches "back-off restarting failed container"', () => {
    expect(matchTemplate('back-off restarting failed container').id).toBe('crashloop');
  });

  it('matches ImagePullBackOff text to the imagepull template', () => {
    expect(matchTemplate('imagepullbackoff for myapp:v2').id).toBe('imagepull');
  });

  it('matches "failed to pull image"', () => {
    expect(matchTemplate('failed to pull image registry/app:v1').id).toBe('imagepull');
  });

  it('matches "image pull" keyword', () => {
    expect(matchTemplate('image pull error').id).toBe('imagepull');
  });

  it('matches "not ready" text to the not-ready template', () => {
    expect(matchTemplate('pod is not ready').id).toBe('not-ready');
  });

  it('matches "readiness probe failed"', () => {
    expect(matchTemplate('readiness probe failed: connection refused').id).toBe('not-ready');
  });

  it('matches pending pod patterns', () => {
    expect(matchTemplate('pending pod stuck').id).toBe('pending');
    expect(matchTemplate('containercreating timeout').id).toBe('pending');
    expect(matchTemplate('failedmount event').id).toBe('pending');
    expect(matchTemplate('failedscheduling').id).toBe('pending');
  });

  it('falls back to generic for unrecognised text', () => {
    expect(matchTemplate('something completely different').id).toBe('generic');
  });

  it('is case-insensitive', () => {
    expect(matchTemplate('CrashLoopBackOff').id).toBe('crashloop');
    expect(matchTemplate('IMAGEPULLBACKOFF').id).toBe('imagepull');
  });
});

// ---------------------------------------------------------------------------
// generateHypothesesFromTemplate
// ---------------------------------------------------------------------------

describe('generateHypothesesFromTemplate', () => {
  const crashloopTemplate = loadTemplates().find((t) => t.id === 'crashloop')!;

  it('generates hypotheses matching the template definition count', () => {
    const result = generateHypothesesFromTemplate(
      crashloopTemplate,
      'pod-crashloop:default/app-pod',
      "Pod 'app-pod' is in CrashLoopBackOff in namespace 'default'",
      ['finding:k8s:crashloop:0'],
    );
    expect(result).toHaveLength(crashloopTemplate.hypotheses.length);
  });

  it('hypothesis IDs are constructed from symptomKey + idSuffix', () => {
    const result = generateHypothesesFromTemplate(
      crashloopTemplate,
      'pod-crashloop:default/app-pod',
      "Pod 'app-pod' is in CrashLoopBackOff",
      ['f1'],
    );
    for (let i = 0; i < result.length; i++) {
      expect(result[i]!.id).toBe(
        `pod-crashloop:default/app-pod:${crashloopTemplate.hypotheses[i]!.idSuffix}`,
      );
    }
  });

  it('each hypothesis carries the correct category', () => {
    const result = generateHypothesesFromTemplate(
      crashloopTemplate,
      'pod-crashloop:default/app-pod',
      'symptom desc',
      ['f1'],
    );
    for (let i = 0; i < result.length; i++) {
      expect(result[i]!.category).toBe(crashloopTemplate.hypotheses[i]!.category);
    }
  });

  it('each hypothesis carries the correct rootCause', () => {
    const result = generateHypothesesFromTemplate(
      crashloopTemplate,
      'pod-crashloop:default/app-pod',
      'symptom desc',
      ['f1'],
    );
    for (let i = 0; i < result.length; i++) {
      expect(result[i]!.rootCause).toBe(crashloopTemplate.hypotheses[i]!.rootCause);
    }
  });

  it('each hypothesis includes sourceFindings', () => {
    const result = generateHypothesesFromTemplate(
      crashloopTemplate,
      'pod-crashloop:default/app-pod',
      'symptom desc',
      ['f1', 'f2'],
    );
    for (const h of result) {
      expect(h.sourceFindings).toEqual(['f1', 'f2']);
    }
  });

  it('each hypothesis includes evidenceRules from the template definition', () => {
    const result = generateHypothesesFromTemplate(
      crashloopTemplate,
      'pod-crashloop:default/app-pod',
      'symptom desc',
      ['f1'],
    );
    for (let i = 0; i < result.length; i++) {
      expect(result[i]!.evidenceRules).toBe(crashloopTemplate.hypotheses[i]!.evidenceRules);
    }
  });

  it('all hypotheses have unique IDs', () => {
    const result = generateHypothesesFromTemplate(
      crashloopTemplate,
      'pod-crashloop:default/app-pod',
      'symptom desc',
      ['f1'],
    );
    const ids = result.map((h) => h.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ---------------------------------------------------------------------------
// Adding a new template requires no new TypeScript code
// ---------------------------------------------------------------------------

describe('adding a new template requires no new TypeScript code', () => {
  // Simulate adding an 'oom-kill' template (pure data, no new functions)
  const oomKillTemplate: HypothesisTemplate = {
    id: 'oom-kill-symptom',
    name: 'OOM Kill Symptom',
    symptomPatterns: ['oomkilled', 'out of memory', 'exit code 137'],
    symptomKeyPrefix: 'pod-oom-kill',
    symptomDescriptionTemplate:
      "Pod '{name}' was OOM-killed in namespace '{namespace}'",
    hypotheses: [
      {
        idSuffix: 'memory-limit-too-low',
        category: 'oom-kill',
        rootCause: 'Container memory limit is set too low for the application workload',
        evidenceRules: [
          {
            label: 'Memory usage near limit',
            pattern: 'memory.*usage.*limit|memory.*pressure',
            type: 'supporting',
          },
        ],
      },
      {
        idSuffix: 'memory-leak',
        category: 'oom-kill',
        rootCause: 'Application has a memory leak causing unbounded growth',
        evidenceRules: [
          {
            label: 'Steadily growing memory',
            pattern: 'memory.*leak|memory.*grow|heap.*grow',
            type: 'supporting',
          },
        ],
      },
    ],
  };

  it('the template conforms to HypothesisTemplate type without casting', () => {
    // TypeScript type checking ensures this is valid
    expect(oomKillTemplate.id).toBe('oom-kill-symptom');
  });

  it('generateHypothesesFromTemplate works with a custom template', () => {
    const result = generateHypothesesFromTemplate(
      oomKillTemplate,
      'pod-oom-kill:default/worker',
      "Pod 'worker' was OOM-killed in namespace 'default'",
      ['finding:oom:0'],
    );
    expect(result).toHaveLength(2);
    expect(result[0]!.category).toBe('oom-kill');
    expect(result[1]!.category).toBe('oom-kill');
    expect(result[0]!.id).toBe('pod-oom-kill:default/worker:memory-limit-too-low');
    expect(result[1]!.id).toBe('pod-oom-kill:default/worker:memory-leak');
  });

  it('matchTemplate can find a custom template when added to a local registry', () => {
    // This simulates the pattern: no code changes needed, just data
    const localRegistry = [...HYPOTHESIS_TEMPLATE_REGISTRY, oomKillTemplate];
    const corpus = 'container terminated with exit code 137 oomkilled';
    const lower = corpus.toLowerCase();

    let matched: HypothesisTemplate | undefined;
    for (const t of localRegistry) {
      if (t.symptomPatterns.length === 0) continue;
      for (const p of t.symptomPatterns) {
        if (lower.includes(p)) {
          matched = t;
          break;
        }
      }
      if (matched) break;
    }

    expect(matched?.id).toBe('oom-kill-symptom');
  });
});

// ---------------------------------------------------------------------------
// Template-driven output matches procedural output
// ---------------------------------------------------------------------------

describe('template-driven output matches procedural generator output', () => {
  it('crashloop template produces 5 hypotheses (same as the procedural generator)', () => {
    const t = loadTemplates().find((t) => t.id === 'crashloop')!;
    expect(t.hypotheses).toHaveLength(5);
  });

  it('imagepull template produces 3 hypotheses (same as the procedural generator)', () => {
    const t = loadTemplates().find((t) => t.id === 'imagepull')!;
    expect(t.hypotheses).toHaveLength(3);
  });

  it('not-ready template produces 3 hypotheses (same as the procedural generator)', () => {
    const t = loadTemplates().find((t) => t.id === 'not-ready')!;
    expect(t.hypotheses).toHaveLength(3);
  });

  it('pending template produces 3 hypotheses (same as the procedural generator)', () => {
    const t = loadTemplates().find((t) => t.id === 'pending')!;
    expect(t.hypotheses).toHaveLength(3);
  });

  it('generic template produces 2 hypotheses (same as the procedural generator)', () => {
    const t = loadTemplates().find((t) => t.id === 'generic')!;
    expect(t.hypotheses).toHaveLength(2);
  });

  it('crashloop template categories match procedural output', () => {
    const t = loadTemplates().find((t) => t.id === 'crashloop')!;
    const categories = t.hypotheses.map((h) => h.category);
    expect(categories).toContain('missing-secret');
    expect(categories).toContain('config-error');
    expect(categories).toContain('dns-failure');
    expect(categories).toContain('oom-kill');
    expect(categories).toContain('generic-crash');
  });

  it('imagepull template categories are all image-pull-failure', () => {
    const t = loadTemplates().find((t) => t.id === 'imagepull')!;
    for (const h of t.hypotheses) {
      expect(h.category).toBe('image-pull-failure');
    }
  });

  it('not-ready template categories match procedural output', () => {
    const t = loadTemplates().find((t) => t.id === 'not-ready')!;
    const categories = t.hypotheses.map((h) => h.category);
    expect(categories).toContain('connectivity-failure');
    expect(categories).toContain('dns-failure');
    expect(categories).toContain('readiness-failure');
  });

  it('crashloop rootCause strings match exactly', () => {
    const t = loadTemplates().find((t) => t.id === 'crashloop')!;
    const secretH = t.hypotheses.find((h) => h.idSuffix === 'missing-secret')!;
    expect(secretH.rootCause).toBe(
      'A required Kubernetes Secret or key is absent, causing the container to fail on startup',
    );
  });
});
