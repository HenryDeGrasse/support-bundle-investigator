import { describe, it, expect } from 'vitest';
import {
  BASE_SYSTEM_PROMPT,
  buildInvestigationPrompt,
  resolvePlaybookCategory,
} from '../prompts.js';
import type { InvestigationSeed } from '../../investigators/types.js';
import type { IndexedChunk } from '../chunk-indexer.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSeed(
  category: InvestigationSeed['category'],
  hypothesis: string,
  overrides: Partial<InvestigationSeed> = {},
): InvestigationSeed {
  return {
    id: 'seed:test:0',
    hypothesis,
    source: 'test:source',
    category,
    priority: 80,
    ...overrides,
  };
}

function makeChunk(
  id: string,
  path: string,
  content: string,
  startLine = 1,
  endLine = 10,
): IndexedChunk {
  return {
    id,
    artifactId: path,
    content,
    startLine,
    endLine,
    summary: `Chunk from ${path}`,
    identifiers: [],
    artifactCategory: 'kubernetes-resource',
  };
}

// ---------------------------------------------------------------------------
// BASE_SYSTEM_PROMPT
// ---------------------------------------------------------------------------

describe('BASE_SYSTEM_PROMPT', () => {
  it('is a non-empty string', () => {
    expect(typeof BASE_SYSTEM_PROMPT).toBe('string');
    expect(BASE_SYSTEM_PROMPT.length).toBeGreaterThan(100);
  });

  it('contains grounding constraint about only citing evidence', () => {
    expect(BASE_SYSTEM_PROMPT).toContain('only cite evidence');
  });

  it('mentions missingEvidence for insufficient evidence cases', () => {
    expect(BASE_SYSTEM_PROMPT).toContain('missingEvidence');
  });

  it('contains a JSON output format requirement', () => {
    expect(BASE_SYSTEM_PROMPT.toLowerCase()).toContain('json');
  });

  it('establishes role as a Kubernetes support engineer', () => {
    expect(BASE_SYSTEM_PROMPT.toLowerCase()).toContain('kubernetes');
  });

  it('contains instructions not to invent data', () => {
    expect(BASE_SYSTEM_PROMPT.toLowerCase()).toMatch(/do not invent|not invent/);
  });

  it('references confidence score instructions', () => {
    expect(BASE_SYSTEM_PROMPT.toLowerCase()).toContain('confidence');
  });
});

// ---------------------------------------------------------------------------
// resolvePlaybookCategory
// ---------------------------------------------------------------------------

describe('resolvePlaybookCategory', () => {
  it('returns "log" for log category', () => {
    const seed = makeSeed('log', 'Log file has errors');
    expect(resolvePlaybookCategory(seed)).toBe('log');
  });

  it('returns "configuration" for configuration category', () => {
    const seed = makeSeed('configuration', 'Missing secret db-credentials');
    expect(resolvePlaybookCategory(seed)).toBe('configuration');
  });

  it('returns "connectivity" for connectivity category', () => {
    const seed = makeSeed('connectivity', 'DNS resolution failure');
    expect(resolvePlaybookCategory(seed)).toBe('connectivity');
  });

  it('returns "crashloop" for kubernetes category without image-pull keywords', () => {
    const seed = makeSeed('kubernetes', 'Pod api-server is in CrashLoopBackOff');
    expect(resolvePlaybookCategory(seed)).toBe('crashloop');
  });

  it('returns "image-pull" when hypothesis contains "imagepull"', () => {
    const seed = makeSeed('kubernetes', 'Pod bad-pod is in ImagePullBackOff');
    expect(resolvePlaybookCategory(seed)).toBe('image-pull');
  });

  it('returns "image-pull" when hypothesis contains "errimage" (ErrImagePull)', () => {
    const seed = makeSeed('kubernetes', 'Pod bad-pod is in ErrImagePull');
    expect(resolvePlaybookCategory(seed)).toBe('image-pull');
  });

  it('returns "image-pull" when hypothesis contains "image pull" (space-separated)', () => {
    const seed = makeSeed('kubernetes', 'Pod bad-pod has image pull error');
    expect(resolvePlaybookCategory(seed)).toBe('image-pull');
  });

  it('is case-insensitive for image-pull detection', () => {
    const seed = makeSeed('kubernetes', 'Pod bad-pod is in IMAGEPULLBACKOFF');
    expect(resolvePlaybookCategory(seed)).toBe('image-pull');
  });

  it('returns "crashloop" for kubernetes category with unrelated hypothesis', () => {
    const seed = makeSeed('kubernetes', 'Pod api-server not ready in namespace default');
    expect(resolvePlaybookCategory(seed)).toBe('crashloop');
  });
});

// ---------------------------------------------------------------------------
// buildInvestigationPrompt — output structure
// ---------------------------------------------------------------------------

describe('buildInvestigationPrompt — output structure', () => {
  it('returns an object with system and user string properties', () => {
    const seed = makeSeed('kubernetes', 'Pod api-server is in CrashLoopBackOff');
    const result = buildInvestigationPrompt(seed, []);
    expect(result).toHaveProperty('system');
    expect(result).toHaveProperty('user');
    expect(typeof result.system).toBe('string');
    expect(typeof result.user).toBe('string');
  });

  it('system prompt is non-empty', () => {
    const seed = makeSeed('kubernetes', 'Pod is crashing');
    const { system } = buildInvestigationPrompt(seed, []);
    expect(system.length).toBeGreaterThan(200);
  });

  it('user prompt is non-empty', () => {
    const seed = makeSeed('kubernetes', 'Pod is crashing');
    const { user } = buildInvestigationPrompt(seed, []);
    expect(user.length).toBeGreaterThan(100);
  });
});

// ---------------------------------------------------------------------------
// buildInvestigationPrompt — system prompt content
// ---------------------------------------------------------------------------

describe('buildInvestigationPrompt — system prompt content', () => {
  it('system prompt includes BASE_SYSTEM_PROMPT grounding constraint', () => {
    const seed = makeSeed('kubernetes', 'Pod is crashing');
    const { system } = buildInvestigationPrompt(seed, []);
    expect(system).toContain('only cite evidence');
  });

  it('crashloop seed system prompt contains crashloop investigation guidance', () => {
    const seed = makeSeed('kubernetes', 'Pod api-server is in CrashLoopBackOff');
    const { system } = buildInvestigationPrompt(seed, []);
    expect(system.toLowerCase()).toContain('crashloopbackoff');
  });

  it('crashloop seed system prompt mentions volume mounts', () => {
    const seed = makeSeed('kubernetes', 'Pod api-server is in CrashLoopBackOff');
    const { system } = buildInvestigationPrompt(seed, []);
    expect(system.toLowerCase()).toContain('volume mount');
  });

  it('image-pull seed system prompt contains image pull investigation guidance', () => {
    const seed = makeSeed('kubernetes', 'Pod bad-pod is in ImagePullBackOff');
    const { system } = buildInvestigationPrompt(seed, []);
    expect(system.toLowerCase()).toContain('pull secret');
  });

  it('image-pull seed system prompt mentions registry', () => {
    const seed = makeSeed('kubernetes', 'Pod bad-pod is in ImagePullBackOff');
    const { system } = buildInvestigationPrompt(seed, []);
    expect(system.toLowerCase()).toContain('registry');
  });

  it('connectivity seed system prompt mentions DNS', () => {
    const seed = makeSeed('connectivity', 'DNS resolution failure');
    const { system } = buildInvestigationPrompt(seed, []);
    expect(system.toLowerCase()).toContain('dns');
  });

  it('connectivity seed system prompt mentions CoreDNS', () => {
    const seed = makeSeed('connectivity', 'DNS resolution failure');
    const { system } = buildInvestigationPrompt(seed, []);
    expect(system.toLowerCase()).toContain('coredns');
  });

  it('configuration seed system prompt mentions configmap', () => {
    const seed = makeSeed('configuration', 'Missing secret');
    const { system } = buildInvestigationPrompt(seed, []);
    expect(system.toLowerCase()).toContain('configmap');
  });

  it('configuration seed system prompt mentions secret references', () => {
    const seed = makeSeed('configuration', 'Missing secret');
    const { system } = buildInvestigationPrompt(seed, []);
    expect(system.toLowerCase()).toContain('secret');
  });

  it('log seed system prompt mentions error patterns', () => {
    const seed = makeSeed('log', 'Log file has errors');
    const { system } = buildInvestigationPrompt(seed, []);
    expect(system.toLowerCase()).toContain('error pattern');
  });

  it('log seed system prompt mentions timestamp correlation', () => {
    const seed = makeSeed('log', 'Log file has errors');
    const { system } = buildInvestigationPrompt(seed, []);
    expect(system.toLowerCase()).toContain('timestamp');
  });
});

// ---------------------------------------------------------------------------
// buildInvestigationPrompt — user prompt content
// ---------------------------------------------------------------------------

describe('buildInvestigationPrompt — user prompt content', () => {
  it('includes the seed hypothesis verbatim', () => {
    const hypothesis = 'Pod api-server is in CrashLoopBackOff in namespace default';
    const seed = makeSeed('kubernetes', hypothesis);
    const { user } = buildInvestigationPrompt(seed, []);
    expect(user).toContain(hypothesis);
  });

  it('includes the seed ID', () => {
    const seed = makeSeed('kubernetes', 'Pod is crashing', { id: 'seed:pod:42' });
    const { user } = buildInvestigationPrompt(seed, []);
    expect(user).toContain('seed:pod:42');
  });

  it('includes the seed priority', () => {
    const seed = makeSeed('kubernetes', 'Pod is crashing', { priority: 90 });
    const { user } = buildInvestigationPrompt(seed, []);
    expect(user).toContain('90');
  });

  it('includes the seed category', () => {
    const seed = makeSeed('configuration', 'Missing secret');
    const { user } = buildInvestigationPrompt(seed, []);
    expect(user).toContain('configuration');
  });

  it('includes the resolved playbook category in the user prompt', () => {
    const seed = makeSeed('kubernetes', 'Pod api-server is in CrashLoopBackOff');
    const { user } = buildInvestigationPrompt(seed, []);
    expect(user).toContain('crashloop');
  });

  it('includes image-pull playbook label for image-pull seeds', () => {
    const seed = makeSeed('kubernetes', 'Pod bad-pod is in ImagePullBackOff');
    const { user } = buildInvestigationPrompt(seed, []);
    expect(user).toContain('image-pull');
  });

  it('contains the JSON output schema', () => {
    const seed = makeSeed('kubernetes', 'Pod is crashing');
    const { user } = buildInvestigationPrompt(seed, []);
    expect(user).toContain('"findings"');
    expect(user).toContain('"severity"');
    expect(user).toContain('"confidence"');
    expect(user).toContain('"evidence"');
    expect(user).toContain('"missingEvidence"');
  });

  it('contains a grounding reminder listing source paths when chunks are present', () => {
    const seed = makeSeed('kubernetes', 'Pod is crashing');
    const chunk = makeChunk(
      'chunk-1',
      'cluster-resources/pods/default/app.json',
      'content',
    );
    const { user } = buildInvestigationPrompt(seed, [chunk]);
    expect(user.toLowerCase()).toContain('only cite paths');
  });

  it('contains a no-chunks reminder when no chunks are provided', () => {
    const seed = makeSeed('kubernetes', 'Pod is crashing');
    const { user } = buildInvestigationPrompt(seed, []);
    expect(user.toLowerCase()).toContain('no chunks were provided');
  });

  it('shows empty-chunks message when no chunks provided', () => {
    const seed = makeSeed('kubernetes', 'Pod is crashing');
    const { user } = buildInvestigationPrompt(seed, []);
    expect(user).toContain('No chunks provided');
  });
});

// ---------------------------------------------------------------------------
// buildInvestigationPrompt — chunk formatting
// ---------------------------------------------------------------------------

describe('buildInvestigationPrompt — chunk formatting', () => {
  it('includes chunk source path in user prompt', () => {
    const seed = makeSeed('kubernetes', 'Pod api-server is crashing');
    const chunk = makeChunk(
      'resource:pod:default:api-server',
      'cluster-resources/pods/default/api-server.json',
      'status:\n  containerStatuses:\n    - state:\n        waiting:\n          reason: CrashLoopBackOff',
    );
    const { user } = buildInvestigationPrompt(seed, [chunk]);
    expect(user).toContain('cluster-resources/pods/default/api-server.json');
  });

  it('includes chunk content in user prompt', () => {
    const seed = makeSeed('kubernetes', 'Pod api-server is crashing');
    const chunk = makeChunk(
      'resource:pod:default:api-server',
      'cluster-resources/pods/default/api-server.json',
      'reason: CrashLoopBackOff',
    );
    const { user } = buildInvestigationPrompt(seed, [chunk]);
    expect(user).toContain('reason: CrashLoopBackOff');
  });

  it('includes line range in chunk header', () => {
    const seed = makeSeed('kubernetes', 'Pod is crashing');
    const chunk = makeChunk('chunk-1', 'path/file.json', 'content', 5, 25);
    const { user } = buildInvestigationPrompt(seed, [chunk]);
    expect(user).toContain('5');
    expect(user).toContain('25');
  });

  it('includes chunk ID in chunk header', () => {
    const seed = makeSeed('kubernetes', 'Pod is crashing');
    const chunk = makeChunk('resource:pod:default:app', 'path/file.json', 'content');
    const { user } = buildInvestigationPrompt(seed, [chunk]);
    expect(user).toContain('resource:pod:default:app');
  });

  it('includes chunk summary', () => {
    const seed = makeSeed('kubernetes', 'Pod is crashing');
    const chunk = makeChunk('chunk-1', 'path/file.json', 'content');
    const { user } = buildInvestigationPrompt(seed, [chunk]);
    expect(user).toContain(`Chunk from path/file.json`);
  });

  it('includes all chunks for multiple-chunk input', () => {
    const seed = makeSeed('kubernetes', 'Pod is crashing');
    const chunks = [
      makeChunk('chunk-1', 'path/file1.json', 'content 1'),
      makeChunk('chunk-2', 'path/file2.json', 'content 2'),
      makeChunk('chunk-3', 'path/file3.json', 'content 3'),
    ];
    const { user } = buildInvestigationPrompt(seed, chunks);
    expect(user).toContain('path/file1.json');
    expect(user).toContain('path/file2.json');
    expect(user).toContain('path/file3.json');
  });

  it('shows chunk count in chunk section header', () => {
    const seed = makeSeed('kubernetes', 'Pod is crashing');
    const chunks = [
      makeChunk('chunk-1', 'a.json', 'a'),
      makeChunk('chunk-2', 'b.json', 'b'),
    ];
    const { user } = buildInvestigationPrompt(seed, chunks);
    expect(user).toContain('2 total');
  });

  it('includes all chunk source paths in grounding reminder', () => {
    const seed = makeSeed('kubernetes', 'Pod is crashing');
    const chunks = [
      makeChunk('chunk-1', 'cluster-resources/pods/default/app.json', 'content'),
      makeChunk('chunk-2', 'cluster-resources/events/default.json', 'content'),
    ];
    const { user } = buildInvestigationPrompt(seed, chunks);
    // Grounding reminder section should list source paths
    expect(user).toContain('cluster-resources/pods/default/app.json');
    expect(user).toContain('cluster-resources/events/default.json');
  });

  it('fences chunk content with triple backticks', () => {
    const seed = makeSeed('kubernetes', 'Pod is crashing');
    const chunk = makeChunk('chunk-1', 'path/file.json', 'kind: Pod');
    const { user } = buildInvestigationPrompt(seed, [chunk]);
    expect(user).toContain('```\nkind: Pod\n```');
  });

  it('redacts sensitive values from chunk content before including it in the prompt', () => {
    const seed = makeSeed('configuration', 'Investigate api-key: SUPER_SECRET_TOKEN_12345');
    const chunk = makeChunk(
      'chunk-1',
      'cluster-resources/configmaps/default/app-config.yaml',
      'api-key: SUPER_SECRET_TOKEN_12345\npassword=hunter2',
    );
    const { user } = buildInvestigationPrompt(seed, [chunk]);

    expect(user).not.toContain('SUPER_SECRET_TOKEN_12345');
    expect(user).not.toContain('hunter2');
    expect(user).toContain('api-key: [REDACTED]');
    expect(user).toContain('password=[REDACTED]');
  });
});

// ---------------------------------------------------------------------------
// buildInvestigationPrompt — artifact type in chunk
// ---------------------------------------------------------------------------

describe('buildInvestigationPrompt — artifact category in chunks', () => {
  it('includes artifact category in chunk source line', () => {
    const seed = makeSeed('kubernetes', 'Pod is crashing');
    const chunk: IndexedChunk = {
      id: 'log:app:1',
      artifactId: 'logs/app.log',
      content: 'FATAL: auth failed',
      startLine: 47,
      endLine: 52,
      summary: 'Log chunk with auth failure',
      identifiers: ['FATAL'],
      artifactCategory: 'log',
    };
    const { user } = buildInvestigationPrompt(seed, [chunk]);
    expect(user).toContain('log');
    expect(user).toContain('logs/app.log');
  });
});
