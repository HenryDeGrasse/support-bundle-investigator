import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'path';
import type { InvestigatorContext } from '../types.js';
import type { BundleProfile } from '../../types/index.js';
import type { AnalyzerResult, K8sResource, K8sEvent } from '../../types/index.js';
import type { LogFile } from '../../parsers/index.js';
import { generateSeeds } from '../seed-generator.js';
import { parseAnalyzerFile, parseResourceFile, parseEventFile, parseLogFile } from '../../parsers/index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCENARIOS = path.resolve(__dirname, '../../../test/fixtures/scenarios');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a minimal BundleProfile sufficient for seed generation tests.
 * The seed generator does not deeply inspect profile fields, so this is safe.
 */
function makeMinimalProfile(): BundleProfile {
  return {
    manifest: {
      bundlePath: '',
      extractedPath: '',
      files: [],
      totalSize: 0,
      extractedAt: new Date(),
    },
    analyzerCount: 0,
    logFileCount: 0,
    resourceCount: 0,
    eventCount: 0,
    namespaces: [],
    workloads: [],
    coverageGaps: [],
    artifactsByCategory: {
      analyzer: 0,
      log: 0,
      'kubernetes-resource': 0,
      event: 0,
      'cluster-info': 0,
      'helm-release': 0,
      unknown: 0,
    },
  };
}

/**
 * Builds an InvestigatorContext by loading real fixture files for a scenario.
 */
async function loadScenarioContext(scenario: string): Promise<InvestigatorContext> {
  const base = path.join(SCENARIOS, scenario);

  const analyzerResults: AnalyzerResult[] = await parseAnalyzerFile(
    path.join(base, 'analysis.json'),
  );

  const resources: K8sResource[] = await parseResourceFile(
    path.join(base, 'cluster-resources', 'pods', 'default.json'),
  );

  const events: K8sEvent[] = await parseEventFile(
    path.join(base, 'cluster-resources', 'events', 'default.json'),
  );

  const appLog: LogFile = await parseLogFile(
    path.join(base, 'cluster-resources', 'pods', 'logs', 'default', 'app-pod', 'app.log'),
  );
  const logs: LogFile[] = [appLog];

  return {
    analyzerResults,
    resources,
    events,
    logs,
    profile: makeMinimalProfile(),
  };
}

// ---------------------------------------------------------------------------
// Shared assertion helpers
// ---------------------------------------------------------------------------

/**
 * Verifies that all seeds are ordered by priority (highest first).
 * Two adjacent seeds with equal priority are acceptable.
 */
function assertPriorityOrdering(seeds: ReturnType<typeof generateSeeds>): void {
  for (let i = 1; i < seeds.length; i++) {
    const prev = seeds[i - 1]!;
    const curr = seeds[i]!;
    expect(curr.priority).toBeLessThanOrEqual(prev.priority);
  }
}

// ---------------------------------------------------------------------------
// Scenario 1: wrong-db-endpoint
// ---------------------------------------------------------------------------

describe('generateSeeds — wrong-db-endpoint', () => {
  let context: InvestigatorContext;

  beforeAll(async () => {
    context = await loadScenarioContext('wrong-db-endpoint');
  });

  it('produces at least 6 seeds from analyzers, pod heuristics, logs, and events', () => {
    const seeds = generateSeeds(context);
    // 2 analyzer (warn) + 1 pod not-ready + 1 log + 2 warning events = 6
    expect(seeds.length).toBeGreaterThanOrEqual(6);
  });

  it('includes at least one connectivity seed (DB endpoint issue)', () => {
    const seeds = generateSeeds(context);
    const connectivity = seeds.filter((s) => s.category === 'connectivity');
    expect(connectivity.length).toBeGreaterThanOrEqual(1);
  });

  it('connectivity seed hypothesis references the database issue', () => {
    const seeds = generateSeeds(context);
    const dbSeed = seeds.find(
      (s) =>
        s.category === 'connectivity' &&
        /database|db|endpoint|connectivity/i.test(s.hypothesis),
    );
    expect(dbSeed).toBeDefined();
  });

  it('includes a kubernetes seed for the not-ready pod', () => {
    const seeds = generateSeeds(context);
    const notReady = seeds.find(
      (s) =>
        s.category === 'kubernetes' &&
        /not ready|app-pod/i.test(s.hypothesis),
    );
    expect(notReady).toBeDefined();
  });

  it('includes a log seed for the high-importance log file', () => {
    const seeds = generateSeeds(context);
    const logSeed = seeds.find((s) => s.category === 'log');
    expect(logSeed).toBeDefined();
    expect(logSeed?.source).toMatch(/log:/);
  });

  it('includes kubernetes seeds from warning events', () => {
    const seeds = generateSeeds(context);
    const eventSeeds = seeds.filter(
      (s) => s.category === 'kubernetes' && s.source.startsWith('event:'),
    );
    expect(eventSeeds.length).toBeGreaterThanOrEqual(1);
  });

  it('returns seeds sorted by priority descending', () => {
    const seeds = generateSeeds(context);
    assertPriorityOrdering(seeds);
  });

  it('warn-severity analyzer seeds have priority 60', () => {
    const seeds = generateSeeds(context);
    const analyzerSeeds = seeds.filter((s) => s.source.startsWith('analyzer:'));
    expect(analyzerSeeds.length).toBeGreaterThan(0);
    for (const s of analyzerSeeds) {
      expect(s.priority).toBe(60);
    }
  });

  it('pod not-ready seed has priority 50', () => {
    const seeds = generateSeeds(context);
    const notReadySeed = seeds.find(
      (s) => s.source.startsWith('pod:') && /not ready/i.test(s.hypothesis),
    );
    expect(notReadySeed).toBeDefined();
    expect(notReadySeed?.priority).toBe(50);
  });

  it('all seeds have non-empty id, hypothesis, and source', () => {
    const seeds = generateSeeds(context);
    for (const s of seeds) {
      expect(s.id).toBeTruthy();
      expect(s.hypothesis).toBeTruthy();
      expect(s.source).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: missing-secret-crashloop
// ---------------------------------------------------------------------------

describe('generateSeeds — missing-secret-crashloop', () => {
  let context: InvestigatorContext;

  beforeAll(async () => {
    context = await loadScenarioContext('missing-secret-crashloop');
  });

  it('produces at least 7 seeds from analyzers, pod heuristic, logs, and events', () => {
    const seeds = generateSeeds(context);
    // 2 analyzer (error) + 1 CrashLoopBackOff + 1 log + 3 warning events = 7
    expect(seeds.length).toBeGreaterThanOrEqual(7);
  });

  it('includes a CrashLoopBackOff seed from pod heuristic', () => {
    const seeds = generateSeeds(context);
    const crashLoop = seeds.find(
      (s) =>
        s.category === 'kubernetes' &&
        /CrashLoopBackOff/i.test(s.hypothesis) &&
        s.source.startsWith('pod:'),
    );
    expect(crashLoop).toBeDefined();
  });

  it('CrashLoopBackOff seed has the highest priority (90)', () => {
    const seeds = generateSeeds(context);
    const crashLoop = seeds.find(
      (s) => /CrashLoopBackOff/i.test(s.hypothesis) && s.source.startsWith('pod:'),
    );
    expect(crashLoop?.priority).toBe(90);
  });

  it('includes a missing-secret seed from analyzer (configuration category)', () => {
    const seeds = generateSeeds(context);
    const secretSeed = seeds.find(
      (s) =>
        s.category === 'configuration' &&
        /secret|credential/i.test(s.hypothesis),
    );
    expect(secretSeed).toBeDefined();
  });

  it('error-severity analyzer seeds have priority 80', () => {
    const seeds = generateSeeds(context);
    const analyzerSeeds = seeds.filter((s) => s.source.startsWith('analyzer:'));
    expect(analyzerSeeds.length).toBe(2);
    for (const s of analyzerSeeds) {
      expect(s.priority).toBe(80);
    }
  });

  it('CrashLoopBackOff seed appears before error-analyzer seeds in sorted order', () => {
    const seeds = generateSeeds(context);
    const crashLoopIdx = seeds.findIndex(
      (s) => /CrashLoopBackOff/i.test(s.hypothesis) && s.source.startsWith('pod:'),
    );
    const analyzerIdx = seeds.findIndex((s) => s.source.startsWith('analyzer:'));
    expect(crashLoopIdx).toBeLessThan(analyzerIdx);
  });

  it('includes a log seed for the startup-failure log file', () => {
    const seeds = generateSeeds(context);
    const logSeed = seeds.find((s) => s.category === 'log');
    expect(logSeed).toBeDefined();
  });

  it('returns seeds sorted by priority descending', () => {
    const seeds = generateSeeds(context);
    assertPriorityOrdering(seeds);
  });

  it('all seeds have non-empty id, hypothesis, and source', () => {
    const seeds = generateSeeds(context);
    for (const s of seeds) {
      expect(s.id).toBeTruthy();
      expect(s.hypothesis).toBeTruthy();
      expect(s.source).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: bad-image-tag
// ---------------------------------------------------------------------------

describe('generateSeeds — bad-image-tag', () => {
  let context: InvestigatorContext;

  beforeAll(async () => {
    context = await loadScenarioContext('bad-image-tag');
  });

  it('produces at least 6 seeds from analyzers, pod heuristic, logs, and events', () => {
    const seeds = generateSeeds(context);
    // 2 analyzer (error) + 1 ImagePullBackOff + 1 log + 2 warning events = 6
    expect(seeds.length).toBeGreaterThanOrEqual(6);
  });

  it('includes an ImagePullBackOff seed from pod heuristic', () => {
    const seeds = generateSeeds(context);
    const pullSeed = seeds.find(
      (s) =>
        s.category === 'kubernetes' &&
        /ImagePullBackOff/i.test(s.hypothesis) &&
        s.source.startsWith('pod:'),
    );
    expect(pullSeed).toBeDefined();
  });

  it('ImagePullBackOff seed has the highest priority (90)', () => {
    const seeds = generateSeeds(context);
    const pullSeed = seeds.find(
      (s) => /ImagePullBackOff/i.test(s.hypothesis) && s.source.startsWith('pod:'),
    );
    expect(pullSeed?.priority).toBe(90);
  });

  it('ImagePullBackOff seed appears first in sorted order', () => {
    const seeds = generateSeeds(context);
    const pullSeed = seeds[0];
    expect(pullSeed?.priority).toBe(90);
    expect(pullSeed?.source).toMatch(/^pod:/);
  });

  it('error-severity analyzer seeds have priority 80', () => {
    const seeds = generateSeeds(context);
    const analyzerSeeds = seeds.filter((s) => s.source.startsWith('analyzer:'));
    expect(analyzerSeeds.length).toBe(2);
    for (const s of analyzerSeeds) {
      expect(s.priority).toBe(80);
    }
  });

  it('includes a log seed with high importance', () => {
    const seeds = generateSeeds(context);
    const logSeed = seeds.find((s) => s.category === 'log');
    expect(logSeed).toBeDefined();
    expect(logSeed?.hypothesis).toMatch(/importance/i);
  });

  it('warning event seeds do not include Normal events (Pulling)', () => {
    const seeds = generateSeeds(context);
    // The 'Pulling' event has type Normal, not Warning — should not produce a seed
    const pullingSeed = seeds.find(
      (s) => s.source.startsWith('event:') && s.source.includes('Pulling'),
    );
    expect(pullingSeed).toBeUndefined();
  });

  it('includes warning event seeds for ErrImagePull and Failed', () => {
    const seeds = generateSeeds(context);
    const eventSeeds = seeds.filter((s) => s.source.startsWith('event:'));
    expect(eventSeeds.length).toBeGreaterThanOrEqual(2);
    const reasons = eventSeeds.map((s) => s.source.split(':')[1] ?? '');
    expect(reasons).toContain('ErrImagePull');
    expect(reasons).toContain('Failed');
  });

  it('returns seeds sorted by priority descending', () => {
    const seeds = generateSeeds(context);
    assertPriorityOrdering(seeds);
  });

  it('all seeds have non-empty id, hypothesis, and source', () => {
    const seeds = generateSeeds(context);
    for (const s of seeds) {
      expect(s.id).toBeTruthy();
      expect(s.hypothesis).toBeTruthy();
      expect(s.source).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// generateSeeds — unit-level edge cases
// ---------------------------------------------------------------------------

describe('generateSeeds — edge cases', () => {
  it('returns empty array when context has no data', () => {
    const empty: InvestigatorContext = {
      analyzerResults: [],
      resources: [],
      events: [],
      logs: [],
      profile: makeMinimalProfile(),
    };
    const seeds = generateSeeds(empty);
    expect(seeds).toHaveLength(0);
  });

  it('ignores pass and info severity analyzer results', () => {
    const ctx: InvestigatorContext = {
      analyzerResults: [
        {
          name: 'all-good',
          title: 'Everything is fine',
          message: 'no issues found',
          severity: 'pass',
          isPass: true,
          isFail: false,
          isWarn: false,
        },
        {
          name: 'info-check',
          title: 'FYI',
          message: 'informational',
          severity: 'info',
          isPass: false,
          isFail: false,
          isWarn: false,
        },
      ],
      resources: [],
      events: [],
      logs: [],
      profile: makeMinimalProfile(),
    };
    const seeds = generateSeeds(ctx);
    expect(seeds).toHaveLength(0);
  });

  it('ignores Normal-type events', () => {
    const ctx: InvestigatorContext = {
      analyzerResults: [],
      resources: [],
      events: [
        {
          type: 'Normal',
          reason: 'Scheduled',
          message: 'Pod scheduled on node',
          involvedObject: { kind: 'Pod', name: 'test-pod', namespace: 'default' },
        },
      ],
      logs: [],
      profile: makeMinimalProfile(),
    };
    const seeds = generateSeeds(ctx);
    expect(seeds).toHaveLength(0);
  });

  it('ignores log files below the importance threshold', () => {
    const lowImportanceLog: LogFile = {
      path: '/some/info.log',
      lines: [
        { lineNumber: 1, content: 'INFO all is well', level: 'info' },
        { lineNumber: 2, content: 'INFO another info', level: 'info' },
      ],
      errorCount: 0,
      warningCount: 0,
      importance: 0.0,
    };
    const ctx: InvestigatorContext = {
      analyzerResults: [],
      resources: [],
      events: [],
      logs: [lowImportanceLog],
      profile: makeMinimalProfile(),
    };
    const seeds = generateSeeds(ctx);
    expect(seeds).toHaveLength(0);
  });

  it('assigns connectivity category to database-related analyzer results', () => {
    const ctx: InvestigatorContext = {
      analyzerResults: [
        {
          name: 'database-connectivity',
          title: 'Database Endpoint Unreachable',
          message: 'Cannot connect to db.internal:5432',
          severity: 'error',
          isPass: false,
          isFail: true,
          isWarn: false,
        },
      ],
      resources: [],
      events: [],
      logs: [],
      profile: makeMinimalProfile(),
    };
    const seeds = generateSeeds(ctx);
    expect(seeds).toHaveLength(1);
    expect(seeds[0]?.category).toBe('connectivity');
  });

  it('assigns configuration category to secret-related analyzer results', () => {
    const ctx: InvestigatorContext = {
      analyzerResults: [
        {
          name: 'secret-existence',
          title: "Required Secret 'app-credentials' Not Found",
          message: 'The secret app-credentials does not exist',
          severity: 'error',
          isPass: false,
          isFail: true,
          isWarn: false,
        },
      ],
      resources: [],
      events: [],
      logs: [],
      profile: makeMinimalProfile(),
    };
    const seeds = generateSeeds(ctx);
    expect(seeds).toHaveLength(1);
    expect(seeds[0]?.category).toBe('configuration');
  });

  it('produces unique ids within a single generateSeeds call', () => {
    const ctx: InvestigatorContext = {
      analyzerResults: [
        {
          name: 'check-a',
          title: 'Error A',
          message: 'something wrong',
          severity: 'error',
          isPass: false,
          isFail: true,
          isWarn: false,
        },
        {
          name: 'check-b',
          title: 'Error B',
          message: 'something else wrong',
          severity: 'error',
          isPass: false,
          isFail: true,
          isWarn: false,
        },
      ],
      resources: [],
      events: [],
      logs: [],
      profile: makeMinimalProfile(),
    };
    const seeds = generateSeeds(ctx);
    const ids = seeds.map((s) => s.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(seeds.length);
  });

  it('does not generate duplicate pod seeds for the same pod', () => {
    // A pod in CrashLoopBackOff should produce exactly one seed (CrashLoopBackOff),
    // not an additional not-ready seed.
    const ctx: InvestigatorContext = {
      analyzerResults: [],
      resources: [
        {
          apiVersion: 'v1',
          kind: 'Pod',
          metadata: { name: 'crash-pod', namespace: 'default' },
          status: {
            phase: 'Running',
            conditions: [{ type: 'Ready', status: 'False', reason: 'ContainersNotReady' }],
            containerStatuses: [
              {
                name: 'app',
                ready: false,
                restartCount: 5,
                state: {
                  waiting: {
                    reason: 'CrashLoopBackOff',
                    message: 'back-off restarting failed container',
                  },
                },
              },
            ],
          },
        },
      ],
      events: [],
      logs: [],
      profile: makeMinimalProfile(),
    };
    const seeds = generateSeeds(ctx);
    const podSeeds = seeds.filter((s) => s.source.startsWith('pod:'));
    // Only one pod seed — CrashLoopBackOff, NOT also a not-ready seed
    expect(podSeeds).toHaveLength(1);
    expect(podSeeds[0]?.priority).toBe(90);
    expect(podSeeds[0]?.hypothesis).toContain('CrashLoopBackOff');
  });
});
