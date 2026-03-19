import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock OpenAI module
// ---------------------------------------------------------------------------
//
// `mockCreate` is defined at module scope so it can be configured per-test.
// The vi.mock factory closes over it and returns a constructor that yields
// an object whose `chat.completions.create` is the same `mockCreate` fn.

const mockCreate = vi.fn();

vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: mockCreate,
      },
    },
  })),
}));

import { LLMClient } from '../llm-client.js';
import type { AIConfig } from '../config.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEST_CONFIG: AIConfig = {
  provider: 'openai',
  apiKey: 'sk-test-key',
  model: 'gpt-4o',
  embeddingModel: 'text-embedding-3-small',
  embeddingBackend: 'openai',
  embeddingUrl: 'http://localhost:8080',
  enabled: true,
};

const VALID_FINDING = {
  title: 'CrashLoopBackOff: Pod api-server',
  severity: 'critical',
  confidence: 0.9,
  affectedComponents: ['Pod/default/api-server'],
  reasoningSummary:
    'The api-server pod is in CrashLoopBackOff with 8 restarts confirmed by BackOff events.',
  evidence: [
    {
      path: 'cluster-resources/pods/default/api-server.json',
      note: 'Container app is in CrashLoopBackOff state',
      lineRange: [12, 18],
    },
  ],
  contradictionsChecked: [
    'Pod confirmed in CrashLoopBackOff — restart count is non-zero',
  ],
  recommendedAction:
    'Inspect container logs with `kubectl logs api-server -n default --previous`.',
  missingEvidence: [],
};

function makeApiResponse(findings: unknown[]): { choices: { message: { content: string } }[] } {
  return {
    choices: [
      {
        message: {
          content: JSON.stringify({ findings }),
        },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockCreate.mockReset();
});

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

describe('LLMClient — construction', () => {
  it('can be instantiated with a valid AIConfig', () => {
    expect(() => new LLMClient(TEST_CONFIG)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// investigateSeed — happy path
// ---------------------------------------------------------------------------

describe('LLMClient.investigateSeed — happy path', () => {
  it('returns validated findings from a well-formed API response', async () => {
    mockCreate.mockResolvedValueOnce(makeApiResponse([VALID_FINDING]));

    const client = new LLMClient(TEST_CONFIG);
    const result = await client.investigateSeed('system', 'user');

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.title).toBe('CrashLoopBackOff: Pod api-server');
    expect(result.findings[0]!.severity).toBe('critical');
    expect(result.findings[0]!.confidence).toBe(0.9);
  });

  it('preserves evidence path and note in the returned finding', async () => {
    mockCreate.mockResolvedValueOnce(makeApiResponse([VALID_FINDING]));

    const client = new LLMClient(TEST_CONFIG);
    const result = await client.investigateSeed('system', 'user');

    expect(result.findings[0]!.evidence[0]!.path).toBe(
      'cluster-resources/pods/default/api-server.json',
    );
    expect(result.findings[0]!.evidence[0]!.note).toBe(
      'Container app is in CrashLoopBackOff state',
    );
    expect(result.findings[0]!.evidence[0]!.lineRange).toEqual([12, 18]);
  });

  it('preserves rawResponse in result', async () => {
    const rawContent = JSON.stringify({ findings: [VALID_FINDING] });
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: rawContent } }],
    });

    const client = new LLMClient(TEST_CONFIG);
    const result = await client.investigateSeed('system', 'user');

    expect(result.rawResponse).toBe(rawContent);
  });

  it('returns multiple findings when API returns multiple', async () => {
    const second = { ...VALID_FINDING, title: 'Second Finding', severity: 'high' };
    mockCreate.mockResolvedValueOnce(makeApiResponse([VALID_FINDING, second]));

    const client = new LLMClient(TEST_CONFIG);
    const result = await client.investigateSeed('system', 'user');

    expect(result.findings).toHaveLength(2);
  });

  it('clamps confidence above 1 to 1.0', async () => {
    mockCreate.mockResolvedValueOnce(
      makeApiResponse([{ ...VALID_FINDING, confidence: 1.5 }]),
    );

    const client = new LLMClient(TEST_CONFIG);
    const result = await client.investigateSeed('system', 'user');

    expect(result.findings[0]!.confidence).toBe(1.0);
  });

  it('clamps confidence below 0 to 0.0', async () => {
    mockCreate.mockResolvedValueOnce(
      makeApiResponse([{ ...VALID_FINDING, confidence: -0.2 }]),
    );

    const client = new LLMClient(TEST_CONFIG);
    const result = await client.investigateSeed('system', 'user');

    expect(result.findings[0]!.confidence).toBe(0.0);
  });
});

// ---------------------------------------------------------------------------
// investigateSeed — empty and edge-case responses
// ---------------------------------------------------------------------------

describe('LLMClient.investigateSeed — empty responses', () => {
  it('returns empty findings for empty findings array', async () => {
    mockCreate.mockResolvedValueOnce(makeApiResponse([]));

    const client = new LLMClient(TEST_CONFIG);
    const result = await client.investigateSeed('system', 'user');

    expect(result.findings).toHaveLength(0);
  });

  it('returns empty findings when API returns empty object', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: '{}' } }],
    });

    const client = new LLMClient(TEST_CONFIG);
    const result = await client.investigateSeed('system', 'user');

    expect(result.findings).toHaveLength(0);
  });

  it('returns empty findings when choices array is empty', async () => {
    mockCreate.mockResolvedValueOnce({ choices: [] });

    const client = new LLMClient(TEST_CONFIG);
    const result = await client.investigateSeed('system', 'user');

    expect(result.findings).toHaveLength(0);
  });

  it('returns empty findings when message content is absent', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: {} }],
    });

    const client = new LLMClient(TEST_CONFIG);
    const result = await client.investigateSeed('system', 'user');

    expect(result.findings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// investigateSeed — graceful degradation
// ---------------------------------------------------------------------------

describe('LLMClient.investigateSeed — graceful degradation', () => {
  it('returns empty findings on API error without throwing', async () => {
    mockCreate.mockRejectedValueOnce(new Error('OpenAI API error: 401 Unauthorized'));

    const client = new LLMClient(TEST_CONFIG);
    const result = await client.investigateSeed('system', 'user');

    expect(result.findings).toHaveLength(0);
  });

  it('returns empty findings on network timeout without throwing', async () => {
    mockCreate.mockRejectedValueOnce(new Error('Request timeout'));

    const client = new LLMClient(TEST_CONFIG);
    const result = await client.investigateSeed('system', 'user');

    expect(result.findings).toHaveLength(0);
  });

  it('returns empty findings on rate-limit error without throwing', async () => {
    mockCreate.mockRejectedValueOnce(new Error('Rate limit exceeded'));

    const client = new LLMClient(TEST_CONFIG);
    const result = await client.investigateSeed('system', 'user');

    expect(result.findings).toHaveLength(0);
  });

  it('returns empty findings when API returns malformed JSON', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'not valid json {{{' } }],
    });

    const client = new LLMClient(TEST_CONFIG);
    const result = await client.investigateSeed('system', 'user');

    expect(result.findings).toHaveLength(0);
    expect(result.rawResponse).toBe('not valid json {{{');
  });

  it('returns empty findings when API returns a JSON string (not object)', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: '"just a string"' } }],
    });

    const client = new LLMClient(TEST_CONFIG);
    const result = await client.investigateSeed('system', 'user');

    expect(result.findings).toHaveLength(0);
  });

  it('never rejects — always resolves even on unexpected errors', async () => {
    mockCreate.mockRejectedValueOnce(new TypeError('Cannot read properties of undefined'));

    const client = new LLMClient(TEST_CONFIG);
    // Should not throw
    await expect(client.investigateSeed('system', 'user')).resolves.toMatchObject({
      findings: [],
    });
  });
});

// ---------------------------------------------------------------------------
// investigateSeed — validation integration
// ---------------------------------------------------------------------------

describe('LLMClient.investigateSeed — validation integration', () => {
  it('drops invalid findings but keeps valid ones in mixed response', async () => {
    const invalidFinding = {
      // Missing required title
      severity: 'critical',
      confidence: 0.9,
      affectedComponents: [],
      reasoningSummary: 'No title here',
      evidence: [],
      contradictionsChecked: [],
      recommendedAction: 'Fix it.',
      missingEvidence: [],
    };

    mockCreate.mockResolvedValueOnce(
      makeApiResponse([VALID_FINDING, invalidFinding]),
    );

    const client = new LLMClient(TEST_CONFIG);
    const result = await client.investigateSeed('system', 'user');

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.title).toBe('CrashLoopBackOff: Pod api-server');
  });

  it('drops evidence items with empty paths', async () => {
    const findingWithBadEvidence = {
      ...VALID_FINDING,
      evidence: [
        { path: '', note: 'Empty path evidence' },
        { path: 'valid/path.json', note: 'Valid evidence' },
      ],
    };

    mockCreate.mockResolvedValueOnce(makeApiResponse([findingWithBadEvidence]));

    const client = new LLMClient(TEST_CONFIG);
    const result = await client.investigateSeed('system', 'user');

    expect(result.findings[0]!.evidence).toHaveLength(1);
    expect(result.findings[0]!.evidence[0]!.path).toBe('valid/path.json');
  });

  it('drops findings that have no citeable evidence after validation', async () => {
    mockCreate.mockResolvedValueOnce(
      makeApiResponse([{ ...VALID_FINDING, evidence: [{ path: '', note: 'bad' }] }]),
    );

    const client = new LLMClient(TEST_CONFIG);
    const result = await client.investigateSeed('system', 'user');

    expect(result.findings).toHaveLength(0);
  });

  it('includes rootCauseClass when provided by the LLM', async () => {
    mockCreate.mockResolvedValueOnce(
      makeApiResponse([{ ...VALID_FINDING, rootCauseClass: 'crashloop' }]),
    );

    const client = new LLMClient(TEST_CONFIG);
    const result = await client.investigateSeed('system', 'user');

    expect(result.findings[0]!.rootCauseClass).toBe('crashloop');
  });
});
