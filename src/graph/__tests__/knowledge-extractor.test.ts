import { describe, it, expect, vi } from 'vitest';
import type { KnowledgeLLMClient, KnowledgeTriple } from '../knowledge-extractor.js';
import {
  extractTriples,
  ENTITY_TYPES,
  RELATIONSHIP_TYPES,
} from '../knowledge-extractor.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a mock LLM client that returns a fixed JSON response. */
function mockClient(triples: KnowledgeTriple[]): KnowledgeLLMClient {
  return {
    generateText: vi.fn().mockResolvedValue(
      JSON.stringify({ triples }),
    ),
  };
}

/** Build a mock LLM client wrapped in a `triples` object in the JSON. */
function mockClientRaw(jsonString: string): KnowledgeLLMClient {
  return {
    generateText: vi.fn().mockResolvedValue(jsonString),
  };
}

/** Build a mock LLM client that throws an error. */
function failingClient(): KnowledgeLLMClient {
  return {
    generateText: vi.fn().mockRejectedValue(new Error('LLM unavailable')),
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('ENTITY_TYPES', () => {
  it('includes Pod', () => expect(ENTITY_TYPES).toContain('Pod'));
  it('includes Deployment', () => expect(ENTITY_TYPES).toContain('Deployment'));
  it('includes Service', () => expect(ENTITY_TYPES).toContain('Service'));
  it('includes Secret', () => expect(ENTITY_TYPES).toContain('Secret'));
  it('includes ConfigMap', () => expect(ENTITY_TYPES).toContain('ConfigMap'));
  it('includes Hostname', () => expect(ENTITY_TYPES).toContain('Hostname'));
  it('includes Image', () => expect(ENTITY_TYPES).toContain('Image'));
  it('includes Error', () => expect(ENTITY_TYPES).toContain('Error'));
});

describe('RELATIONSHIP_TYPES', () => {
  it('includes connects-to', () => expect(RELATIONSHIP_TYPES).toContain('connects-to'));
  it('includes configured-with', () => expect(RELATIONSHIP_TYPES).toContain('configured-with'));
  it('includes fails-because', () => expect(RELATIONSHIP_TYPES).toContain('fails-because'));
  it('includes authenticates-with', () => expect(RELATIONSHIP_TYPES).toContain('authenticates-with'));
  it('includes resolves-to', () => expect(RELATIONSHIP_TYPES).toContain('resolves-to'));
  it('includes exposes', () => expect(RELATIONSHIP_TYPES).toContain('exposes'));
});

// ---------------------------------------------------------------------------
// Happy-path extraction
// ---------------------------------------------------------------------------

describe('extractTriples — happy path', () => {
  it('returns an empty array for empty chunk content', async () => {
    const client = mockClient([]);
    const result = await extractTriples('', client);
    expect(result).toEqual([]);
  });

  it('returns triples from a single-triple response', async () => {
    const triple: KnowledgeTriple = {
      source: 'Pod:app-pod',
      relationship: 'connects-to',
      target: 'Hostname:db.internal',
    };
    const client = mockClient([triple]);
    const result = await extractTriples('some log content', client);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(triple);
  });

  it('returns multiple triples', async () => {
    const triples: KnowledgeTriple[] = [
      { source: 'Pod:app-pod', relationship: 'connects-to', target: 'Hostname:db.internal' },
      { source: 'ConfigMap:app-config', relationship: 'configured-with', target: 'Hostname:db.internal' },
      { source: 'Secret:registry-creds', relationship: 'authenticates-with', target: 'Image:myapp:latest' },
    ];
    const client = mockClient(triples);
    const result = await extractTriples('chunk content', client);
    expect(result).toHaveLength(3);
    expect(result).toEqual(expect.arrayContaining(triples));
  });

  it('returns triples with all required fields', async () => {
    const triple: KnowledgeTriple = {
      source: 'Deployment:app',
      relationship: 'exposes',
      target: 'Service:app-svc',
    };
    const client = mockClient([triple]);
    const result = await extractTriples('content', client);
    expect(result[0]).toHaveProperty('source');
    expect(result[0]).toHaveProperty('relationship');
    expect(result[0]).toHaveProperty('target');
  });

  it('passes the chunk content to the LLM client', async () => {
    const client = mockClient([]);
    const content = 'DNS failure for db.internal: no such host';
    await extractTriples(content, client);
    expect(client.generateText).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining(content),
    );
  });
});

// ---------------------------------------------------------------------------
// Entity type coverage
// ---------------------------------------------------------------------------

describe('extractTriples — entity type coverage', () => {
  const entityPairs: Array<[string, string, string]> = [
    ['Pod:app-pod', 'connects-to', 'Hostname:db.internal'],
    ['Deployment:app', 'exposes', 'Service:app-svc'],
    ['Service:app-svc', 'exposes', 'Pod:app-pod'],
    ['Secret:registry-creds', 'authenticates-with', 'Image:myapp:v1'],
    ['ConfigMap:app-config', 'configured-with', 'Hostname:db.internal'],
    ['Error:ECONNREFUSED', 'fails-because', 'Hostname:db.internal'],
    ['Image:myapp:v1', 'resolves-to', 'Hostname:registry.internal'],
  ];

  for (const [source, relationship, target] of entityPairs) {
    it(`returns triple with source ${source.split(':')[0]}`, async () => {
      const triple: KnowledgeTriple = { source, relationship, target };
      const client = mockClient([triple]);
      const result = await extractTriples('content', client);
      expect(result).toContainEqual(triple);
    });
  }
});

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

describe('extractTriples — deduplication', () => {
  it('deduplicates exact duplicate triples', async () => {
    const triple: KnowledgeTriple = {
      source: 'Pod:app-pod',
      relationship: 'connects-to',
      target: 'Hostname:db.internal',
    };
    const client = mockClient([triple, triple, triple]);
    const result = await extractTriples('content', client);
    expect(result).toHaveLength(1);
  });

  it('deduplicates triples with same source+relationship+target', async () => {
    const a: KnowledgeTriple = {
      source: 'Pod:app-pod',
      relationship: 'connects-to',
      target: 'Hostname:db.internal',
    };
    const b: KnowledgeTriple = {
      source: 'Pod:app-pod',
      relationship: 'connects-to',
      target: 'Hostname:db.internal',
    };
    const c: KnowledgeTriple = {
      source: 'Pod:app-pod',
      relationship: 'connects-to',
      target: 'Hostname:other.host',
    };
    const client = mockClient([a, b, c]);
    const result = await extractTriples('content', client);
    expect(result).toHaveLength(2);
  });

  it('preserves distinct triples with same source but different target', async () => {
    const triples: KnowledgeTriple[] = [
      { source: 'Pod:app-pod', relationship: 'connects-to', target: 'Hostname:db.internal' },
      { source: 'Pod:app-pod', relationship: 'connects-to', target: 'Hostname:redis.internal' },
    ];
    const client = mockClient(triples);
    const result = await extractTriples('content', client);
    expect(result).toHaveLength(2);
  });

  it('preserves distinct triples with different relationship types', async () => {
    const triples: KnowledgeTriple[] = [
      { source: 'Pod:app-pod', relationship: 'connects-to', target: 'Hostname:db.internal' },
      { source: 'Pod:app-pod', relationship: 'fails-because', target: 'Hostname:db.internal' },
    ];
    const client = mockClient(triples);
    const result = await extractTriples('content', client);
    expect(result).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Graceful degradation
// ---------------------------------------------------------------------------

describe('extractTriples — graceful degradation', () => {
  it('returns empty array when LLM throws an error', async () => {
    const client = failingClient();
    const result = await extractTriples('some content', client);
    expect(result).toEqual([]);
  });

  it('returns empty array when LLM returns invalid JSON', async () => {
    const client = mockClientRaw('not valid json at all');
    const result = await extractTriples('content', client);
    expect(result).toEqual([]);
  });

  it('returns empty array when LLM returns empty string', async () => {
    const client = mockClientRaw('');
    const result = await extractTriples('content', client);
    expect(result).toEqual([]);
  });

  it('returns empty array when LLM returns JSON without triples key', async () => {
    const client = mockClientRaw('{"results": []}');
    const result = await extractTriples('content', client);
    expect(result).toEqual([]);
  });

  it('returns empty array when triples is not an array', async () => {
    const client = mockClientRaw('{"triples": "not-an-array"}');
    const result = await extractTriples('content', client);
    expect(result).toEqual([]);
  });

  it('filters out triples missing required fields', async () => {
    const client = mockClientRaw(
      JSON.stringify({
        triples: [
          { source: 'Pod:app-pod', relationship: 'connects-to', target: 'Hostname:db.internal' },
          { source: 'Pod:app-pod', relationship: 'connects-to' }, // missing target
          { source: 'Pod:app-pod', target: 'Hostname:db.internal' }, // missing relationship
          { relationship: 'connects-to', target: 'Hostname:db.internal' }, // missing source
        ],
      }),
    );
    const result = await extractTriples('content', client);
    expect(result).toHaveLength(1);
    expect(result[0]?.source).toBe('Pod:app-pod');
    expect(result[0]?.relationship).toBe('connects-to');
    expect(result[0]?.target).toBe('Hostname:db.internal');
  });

  it('does not throw when LLM returns a partial response', async () => {
    const client = mockClientRaw('{"triples": [{}]}');
    await expect(extractTriples('content', client)).resolves.toEqual([]);
  });

  it('handles JSON wrapped in markdown code blocks', async () => {
    const jsonContent = JSON.stringify({
      triples: [
        { source: 'Pod:app-pod', relationship: 'connects-to', target: 'Hostname:db.internal' },
      ],
    });
    const client = mockClientRaw('```json\n' + jsonContent + '\n```');
    const result = await extractTriples('content', client);
    expect(result).toHaveLength(1);
    expect(result[0]?.source).toBe('Pod:app-pod');
  });
});

// ---------------------------------------------------------------------------
// Relationship type validation
// ---------------------------------------------------------------------------

describe('extractTriples — relationship type handling', () => {
  it('accepts all defined relationship types', async () => {
    const triples: KnowledgeTriple[] = RELATIONSHIP_TYPES.map((rel) => ({
      source: 'Pod:test',
      relationship: rel,
      target: 'Hostname:test.internal',
    }));
    const client = mockClient(triples);
    const result = await extractTriples('content', client);
    expect(result).toHaveLength(RELATIONSHIP_TYPES.length);
  });

  it('preserves unknown relationship types (passthrough)', async () => {
    const triple: KnowledgeTriple = {
      source: 'Pod:app-pod',
      relationship: 'some-unknown-rel',
      target: 'Hostname:db.internal',
    };
    const client = mockClient([triple]);
    const result = await extractTriples('content', client);
    // Unknown relationship types should still be returned (not filtered)
    expect(result).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// KnowledgeLLMClient interface contract
// ---------------------------------------------------------------------------

describe('KnowledgeLLMClient interface', () => {
  it('mock client satisfies the interface', () => {
    const client: KnowledgeLLMClient = {
      generateText: async (_sys: string, _user: string) => '{"triples": []}',
    };
    expect(typeof client.generateText).toBe('function');
  });

  it('extractTriples calls generateText with system and user prompts', async () => {
    const generateText = vi.fn().mockResolvedValue('{"triples": []}');
    const client: KnowledgeLLMClient = { generateText };
    await extractTriples('test content', client);
    expect(generateText).toHaveBeenCalledTimes(1);
    const [systemPrompt, userPrompt] = generateText.mock.calls[0] as [string, string];
    expect(typeof systemPrompt).toBe('string');
    expect(systemPrompt.length).toBeGreaterThan(0);
    expect(typeof userPrompt).toBe('string');
    expect(userPrompt).toContain('test content');
  });
});
