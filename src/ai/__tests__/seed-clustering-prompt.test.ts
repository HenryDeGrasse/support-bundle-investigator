import { describe, it, expect } from 'vitest';
import {
  SEED_CLUSTERING_SYSTEM_PROMPT,
  buildSeedClusteringPrompt,
} from '../prompts.js';
import type { InvestigationSeed } from '../../investigators/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSeed(
  id: string,
  hypothesis: string,
  overrides: Partial<InvestigationSeed> = {},
): InvestigationSeed {
  return {
    id,
    hypothesis,
    source: `test:source:${id}`,
    category: 'kubernetes',
    priority: 80,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// SEED_CLUSTERING_SYSTEM_PROMPT
// ---------------------------------------------------------------------------

describe('SEED_CLUSTERING_SYSTEM_PROMPT', () => {
  it('is a non-empty string', () => {
    expect(typeof SEED_CLUSTERING_SYSTEM_PROMPT).toBe('string');
    expect(SEED_CLUSTERING_SYSTEM_PROMPT.length).toBeGreaterThan(100);
  });

  it('establishes the SRE triage role', () => {
    expect(SEED_CLUSTERING_SYSTEM_PROMPT.toLowerCase()).toContain(
      'site-reliability engineer',
    );
  });

  it('mentions initial triage', () => {
    expect(SEED_CLUSTERING_SYSTEM_PROMPT.toLowerCase()).toContain('triage');
  });

  it('contains grounding rules section', () => {
    expect(SEED_CLUSTERING_SYSTEM_PROMPT).toContain('Grounding Rules');
  });

  it('requires every seed ID to appear in exactly one cluster', () => {
    expect(SEED_CLUSTERING_SYSTEM_PROMPT).toContain('exactly one cluster');
  });

  it('requires grounding to seed IDs from the provided list', () => {
    expect(SEED_CLUSTERING_SYSTEM_PROMPT.toLowerCase()).toContain('seed id');
  });

  it('instructs not to invent seed IDs or resource names', () => {
    expect(SEED_CLUSTERING_SYSTEM_PROMPT.toLowerCase()).toMatch(
      /do not invent|not invent/,
    );
  });

  it('mentions grouping by root cause', () => {
    expect(SEED_CLUSTERING_SYSTEM_PROMPT.toLowerCase()).toContain('root cause');
  });

  it('requires a clusters array in the output', () => {
    expect(SEED_CLUSTERING_SYSTEM_PROMPT).toContain('"clusters"');
  });

  it('requires only valid JSON in the output', () => {
    expect(SEED_CLUSTERING_SYSTEM_PROMPT.toLowerCase()).toContain('json');
  });

  it('mentions singletons are allowed', () => {
    expect(SEED_CLUSTERING_SYSTEM_PROMPT.toLowerCase()).toContain('singleton');
  });

  it('requires representativeSeedId to be the highest-priority member', () => {
    expect(SEED_CLUSTERING_SYSTEM_PROMPT).toContain('representativeSeedId');
  });
});

// ---------------------------------------------------------------------------
// buildSeedClusteringPrompt — output structure
// ---------------------------------------------------------------------------

describe('buildSeedClusteringPrompt — output structure', () => {
  it('returns an object with system and user string properties', () => {
    const seeds = [makeSeed('seed:pod:0', 'Pod api-server is in CrashLoopBackOff')];
    const result = buildSeedClusteringPrompt(seeds);
    expect(result).toHaveProperty('system');
    expect(result).toHaveProperty('user');
    expect(typeof result.system).toBe('string');
    expect(typeof result.user).toBe('string');
  });

  it('system prompt is non-empty', () => {
    const seeds = [makeSeed('seed:pod:0', 'Pod is crashing')];
    const { system } = buildSeedClusteringPrompt(seeds);
    expect(system.length).toBeGreaterThan(200);
  });

  it('user prompt is non-empty', () => {
    const seeds = [makeSeed('seed:pod:0', 'Pod is crashing')];
    const { user } = buildSeedClusteringPrompt(seeds);
    expect(user.length).toBeGreaterThan(100);
  });

  it('system prompt equals SEED_CLUSTERING_SYSTEM_PROMPT', () => {
    const seeds = [makeSeed('seed:pod:0', 'Pod is crashing')];
    const { system } = buildSeedClusteringPrompt(seeds);
    expect(system).toBe(SEED_CLUSTERING_SYSTEM_PROMPT);
  });
});

// ---------------------------------------------------------------------------
// buildSeedClusteringPrompt — user prompt content: seed fields
// ---------------------------------------------------------------------------

describe('buildSeedClusteringPrompt — seed field serialisation', () => {
  it('user prompt contains each seed ID', () => {
    const seeds = [
      makeSeed('seed:pod:0', 'Pod api-server is in CrashLoopBackOff'),
      makeSeed('seed:event:1', 'Node not ready'),
    ];
    const { user } = buildSeedClusteringPrompt(seeds);
    expect(user).toContain('seed:pod:0');
    expect(user).toContain('seed:event:1');
  });

  it('user prompt contains each seed hypothesis verbatim', () => {
    const hypothesis1 = 'Pod api-server is in CrashLoopBackOff in namespace default';
    const hypothesis2 = 'Node worker-1 has NodeNotReady status';
    const seeds = [
      makeSeed('seed:pod:0', hypothesis1),
      makeSeed('seed:node:1', hypothesis2),
    ];
    const { user } = buildSeedClusteringPrompt(seeds);
    expect(user).toContain(hypothesis1);
    expect(user).toContain(hypothesis2);
  });

  it('user prompt contains each seed priority', () => {
    const seeds = [
      makeSeed('seed:pod:0', 'Pod is crashing', { priority: 90 }),
      makeSeed('seed:event:1', 'Node not ready', { priority: 85 }),
    ];
    const { user } = buildSeedClusteringPrompt(seeds);
    expect(user).toContain('90');
    expect(user).toContain('85');
  });

  it('user prompt contains each seed category', () => {
    const seeds = [
      makeSeed('seed:pod:0', 'Pod is crashing', { category: 'kubernetes' }),
      makeSeed('seed:log:1', 'Log errors found', { category: 'log' }),
    ];
    const { user } = buildSeedClusteringPrompt(seeds);
    expect(user).toContain('kubernetes');
    expect(user).toContain('log');
  });

  it('user prompt contains each seed source', () => {
    const seeds = [
      makeSeed('seed:pod:0', 'Pod is crashing', { source: 'pod:default:api-server' }),
    ];
    const { user } = buildSeedClusteringPrompt(seeds);
    expect(user).toContain('pod:default:api-server');
  });

  it('serialises seeds as JSON', () => {
    const seeds = [makeSeed('seed:pod:0', 'Pod api-server is crashing')];
    const { user } = buildSeedClusteringPrompt(seeds);
    // Seeds section is fenced with ```json
    expect(user).toContain('```json');
  });
});

// ---------------------------------------------------------------------------
// buildSeedClusteringPrompt — user prompt content: schema and rules
// ---------------------------------------------------------------------------

describe('buildSeedClusteringPrompt — output schema and rules', () => {
  it('user prompt contains the clusters array schema', () => {
    const seeds = [makeSeed('seed:pod:0', 'Pod is crashing')];
    const { user } = buildSeedClusteringPrompt(seeds);
    expect(user).toContain('"clusters"');
  });

  it('user prompt contains seedIds field in schema', () => {
    const seeds = [makeSeed('seed:pod:0', 'Pod is crashing')];
    const { user } = buildSeedClusteringPrompt(seeds);
    expect(user).toContain('"seedIds"');
  });

  it('user prompt contains representativeSeedId field in schema', () => {
    const seeds = [makeSeed('seed:pod:0', 'Pod is crashing')];
    const { user } = buildSeedClusteringPrompt(seeds);
    expect(user).toContain('"representativeSeedId"');
  });

  it('user prompt contains label field in schema', () => {
    const seeds = [makeSeed('seed:pod:0', 'Pod is crashing')];
    const { user } = buildSeedClusteringPrompt(seeds);
    expect(user).toContain('"label"');
  });

  it('user prompt contains reasoning field in schema', () => {
    const seeds = [makeSeed('seed:pod:0', 'Pod is crashing')];
    const { user } = buildSeedClusteringPrompt(seeds);
    expect(user).toContain('"reasoning"');
  });

  it('user prompt includes the rule that every seed must appear in exactly one cluster', () => {
    const seeds = [makeSeed('seed:pod:0', 'Pod is crashing')];
    const { user } = buildSeedClusteringPrompt(seeds);
    expect(user).toContain('exactly one cluster');
  });

  it('user prompt instructs not to invent seed IDs', () => {
    const seeds = [makeSeed('seed:pod:0', 'Pod is crashing')];
    const { user } = buildSeedClusteringPrompt(seeds);
    expect(user.toLowerCase()).toContain('do not invent seed ids');
  });

  it('user prompt instructs to return only valid JSON', () => {
    const seeds = [makeSeed('seed:pod:0', 'Pod is crashing')];
    const { user } = buildSeedClusteringPrompt(seeds);
    expect(user.toLowerCase()).toContain('only valid json');
  });

  it('user prompt instructs singletons to form their own cluster', () => {
    const seeds = [makeSeed('seed:pod:0', 'Pod is crashing')];
    const { user } = buildSeedClusteringPrompt(seeds);
    expect(user.toLowerCase()).toContain('singleton');
  });

  it('user prompt instructs to group by root cause not just category', () => {
    const seeds = [makeSeed('seed:pod:0', 'Pod is crashing')];
    const { user } = buildSeedClusteringPrompt(seeds);
    expect(user.toLowerCase()).toContain('root cause');
  });

  it('user prompt states representativeSeedId must be highest-priority member', () => {
    const seeds = [makeSeed('seed:pod:0', 'Pod is crashing')];
    const { user } = buildSeedClusteringPrompt(seeds);
    expect(user.toLowerCase()).toContain('highest priority');
  });

  it('user prompt mentions required JSON output schema section', () => {
    const seeds = [makeSeed('seed:pod:0', 'Pod is crashing')];
    const { user } = buildSeedClusteringPrompt(seeds);
    expect(user).toContain('Required JSON Output Schema');
  });
});

// ---------------------------------------------------------------------------
// buildSeedClusteringPrompt — seed count in user prompt
// ---------------------------------------------------------------------------

describe('buildSeedClusteringPrompt — seed count reporting', () => {
  it('user prompt mentions the number of seeds provided', () => {
    const seeds = [
      makeSeed('seed:pod:0', 'Pod is crashing'),
      makeSeed('seed:event:1', 'Node not ready'),
      makeSeed('seed:log:2', 'Log errors found'),
    ];
    const { user } = buildSeedClusteringPrompt(seeds);
    expect(user).toContain('3');
  });

  it('user prompt uses correct seed count for single seed', () => {
    const seeds = [makeSeed('seed:pod:0', 'Pod is crashing')];
    const { user } = buildSeedClusteringPrompt(seeds);
    expect(user).toContain('1');
  });
});

// ---------------------------------------------------------------------------
// buildSeedClusteringPrompt — edge cases
// ---------------------------------------------------------------------------

describe('buildSeedClusteringPrompt — edge cases', () => {
  it('works with an empty seed array', () => {
    expect(() => buildSeedClusteringPrompt([])).not.toThrow();
    const { system, user } = buildSeedClusteringPrompt([]);
    expect(typeof system).toBe('string');
    expect(typeof user).toBe('string');
    expect(system.length).toBeGreaterThan(0);
    expect(user.length).toBeGreaterThan(0);
  });

  it('empty seed array produces user prompt mentioning 0 seeds', () => {
    const { user } = buildSeedClusteringPrompt([]);
    expect(user).toContain('0');
  });

  it('empty seed array produces valid JSON-fenced content', () => {
    const { user } = buildSeedClusteringPrompt([]);
    expect(user).toContain('```json');
    expect(user).toContain('[]');
  });

  it('works with a single seed', () => {
    const seed = makeSeed('seed:pod:0', 'Pod api-server is in CrashLoopBackOff');
    expect(() => buildSeedClusteringPrompt([seed])).not.toThrow();
    const { system, user } = buildSeedClusteringPrompt([seed]);
    expect(typeof system).toBe('string');
    expect(typeof user).toBe('string');
  });

  it('single seed appears in the user prompt', () => {
    const seed = makeSeed('seed:pod:0', 'Pod api-server is in CrashLoopBackOff');
    const { user } = buildSeedClusteringPrompt([seed]);
    expect(user).toContain('seed:pod:0');
    expect(user).toContain('Pod api-server is in CrashLoopBackOff');
  });

  it('single seed user prompt still contains schema and rules', () => {
    const seed = makeSeed('seed:pod:0', 'Pod api-server is in CrashLoopBackOff');
    const { user } = buildSeedClusteringPrompt([seed]);
    expect(user).toContain('"clusters"');
    expect(user).toContain('exactly one cluster');
  });

  it('all category types are serialised correctly', () => {
    const seeds: InvestigationSeed[] = [
      makeSeed('seed:k8s:0', 'Pod crashing', { category: 'kubernetes' }),
      makeSeed('seed:log:1', 'Log errors', { category: 'log' }),
      makeSeed('seed:cfg:2', 'Missing secret', { category: 'configuration' }),
      makeSeed('seed:con:3', 'DNS failure', { category: 'connectivity' }),
    ];
    const { user } = buildSeedClusteringPrompt(seeds);
    expect(user).toContain('kubernetes');
    expect(user).toContain('log');
    expect(user).toContain('configuration');
    expect(user).toContain('connectivity');
  });
});

// ---------------------------------------------------------------------------
// buildSeedClusteringPrompt — multiple seeds with different priorities
// ---------------------------------------------------------------------------

describe('buildSeedClusteringPrompt — multiple seeds', () => {
  it('includes all seed IDs for a larger seed list', () => {
    const ids = ['seed:0', 'seed:1', 'seed:2', 'seed:3', 'seed:4'];
    const seeds = ids.map((id, i) =>
      makeSeed(id, `Hypothesis for seed ${i}`, { priority: 80 - i * 5 }),
    );
    const { user } = buildSeedClusteringPrompt(seeds);
    for (const id of ids) {
      expect(user).toContain(id);
    }
  });

  it('all hypotheses appear in the user prompt for multiple seeds', () => {
    const hypotheses = [
      'Pod api-server is in CrashLoopBackOff',
      'Node worker-1 is NotReady',
      'DNS resolution failing for service payments',
    ];
    const seeds = hypotheses.map((h, i) => makeSeed(`seed:${i}`, h));
    const { user } = buildSeedClusteringPrompt(seeds);
    for (const h of hypotheses) {
      expect(user).toContain(h);
    }
  });
});
