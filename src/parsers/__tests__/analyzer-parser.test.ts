import { describe, it, expect, vi, afterEach } from 'vitest';
import * as path from 'path';
import { parseAnalyzerJson, parseAnalyzerFile, mergeAnalyzerResults } from '../analyzer-parser.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXTURES_DIR = path.resolve(__dirname, '../../../test/fixtures/scenarios');

// ---------------------------------------------------------------------------
// parseAnalyzerJson — unit tests
// ---------------------------------------------------------------------------

describe('parseAnalyzerJson', () => {
  it('parses a valid analyzer JSON array into AnalyzerResult[]', () => {
    const json = JSON.stringify([
      {
        name: 'check-name',
        insight: {
          severity: 'warn',
          primary: 'Short title',
          detail: 'Detailed message about the issue',
        },
        iconKey: 'kubernetes_analyze',
        iconUri: 'https://example.com/icon.svg',
      },
    ]);

    const results = parseAnalyzerJson(json);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      name: 'check-name',
      title: 'Short title',
      message: 'Detailed message about the issue',
      severity: 'warn',
      iconKey: 'kubernetes_analyze',
      iconUri: 'https://example.com/icon.svg',
    });
  });

  it('correctly maps severity levels', () => {
    const json = JSON.stringify([
      { name: 'a', insight: { severity: 'error', primary: 'A', detail: 'a' } },
      { name: 'b', insight: { severity: 'warn', primary: 'B', detail: 'b' } },
      { name: 'c', insight: { severity: 'pass', primary: 'C', detail: 'c' } },
      { name: 'd', insight: { severity: 'info', primary: 'D', detail: 'd' } },
    ]);

    const results = parseAnalyzerJson(json);

    expect(results[0]?.severity).toBe('error');
    expect(results[1]?.severity).toBe('warn');
    expect(results[2]?.severity).toBe('pass');
    expect(results[3]?.severity).toBe('info');
  });

  it('sets isFail=true and isPass=false and isWarn=false for error severity', () => {
    const json = JSON.stringify([
      { name: 'x', insight: { severity: 'error', primary: 'X', detail: 'xd' } },
    ]);
    const results = parseAnalyzerJson(json);
    expect(results[0]?.isFail).toBe(true);
    expect(results[0]?.isPass).toBe(false);
    expect(results[0]?.isWarn).toBe(false);
  });

  it('sets isWarn=true and isFail=false and isPass=false for warn severity', () => {
    const json = JSON.stringify([
      { name: 'x', insight: { severity: 'warn', primary: 'X', detail: 'xd' } },
    ]);
    const results = parseAnalyzerJson(json);
    expect(results[0]?.isWarn).toBe(true);
    expect(results[0]?.isFail).toBe(false);
    expect(results[0]?.isPass).toBe(false);
  });

  it('sets isPass=true and isFail=false and isWarn=false for pass severity', () => {
    const json = JSON.stringify([
      { name: 'x', insight: { severity: 'pass', primary: 'X', detail: 'xd' } },
    ]);
    const results = parseAnalyzerJson(json);
    expect(results[0]?.isPass).toBe(true);
    expect(results[0]?.isFail).toBe(false);
    expect(results[0]?.isWarn).toBe(false);
  });

  it('sets all boolean flags to false for info severity', () => {
    const json = JSON.stringify([
      { name: 'x', insight: { severity: 'info', primary: 'X', detail: 'xd' } },
    ]);
    const results = parseAnalyzerJson(json);
    expect(results[0]?.isPass).toBe(false);
    expect(results[0]?.isFail).toBe(false);
    expect(results[0]?.isWarn).toBe(false);
  });

  it('handles analyzer JSON with an `analyzers` wrapper key', () => {
    const json = JSON.stringify({
      analyzers: [
        {
          name: 'wrapped-check',
          insight: {
            severity: 'pass',
            primary: 'All good',
            detail: 'Nothing is broken',
          },
        },
      ],
    });

    const results = parseAnalyzerJson(json);

    expect(results).toHaveLength(1);
    expect(results[0]?.name).toBe('wrapped-check');
    expect(results[0]?.severity).toBe('pass');
  });

  it('handles an empty analyzer array', () => {
    const results = parseAnalyzerJson('[]');
    expect(results).toHaveLength(0);
    expect(Array.isArray(results)).toBe(true);
  });

  it('handles malformed JSON gracefully — returns empty array and logs a warning', () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const results = parseAnalyzerJson('{ this is not valid json }');

    expect(results).toHaveLength(0);
    expect(consoleSpy).toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  it('handles missing insight fields with sensible defaults', () => {
    const json = JSON.stringify([
      {
        name: 'bare-check',
        // no insight at all
      },
      {
        name: 'partial-check',
        insight: {
          severity: 'error',
          // no primary or detail
        },
      },
    ]);

    const results = parseAnalyzerJson(json);

    expect(results).toHaveLength(2);

    const bare = results[0]!;
    expect(bare.name).toBe('bare-check');
    expect(bare.title).toBe('');
    expect(bare.message).toBe('');
    expect(bare.severity).toBe('info'); // default when severity absent

    const partial = results[1]!;
    expect(partial.severity).toBe('error');
    expect(partial.title).toBe('');
    expect(partial.message).toBe('');
  });

  it('defaults malformed field types to safe values', () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const json = JSON.stringify([
      {
        name: 123,
        insight: {
          severity: { level: 'error' },
          primary: false,
          detail: 42,
        },
        iconKey: ['bad'],
        iconUri: 99,
      },
    ]);

    const results = parseAnalyzerJson(json);
    const result = results[0]!;

    expect(result).toMatchObject({
      name: '',
      title: '',
      message: '',
      severity: 'info',
      iconKey: undefined,
      iconUri: undefined,
      isPass: false,
      isFail: false,
      isWarn: false,
    });
    expect(consoleSpy).toHaveBeenCalled();
  });

  it('skips non-object analyzer entries', () => {
    const json = JSON.stringify([
      null,
      1,
      'bad-entry',
      [],
      {
        name: 'good-check',
        insight: { severity: 'pass', primary: 'Okay', detail: 'Everything passed' },
      },
    ]);

    const results = parseAnalyzerJson(json);

    expect(results).toHaveLength(1);
    expect(results[0]?.name).toBe('good-check');
  });

  it('extracts name, title (primary), message (detail), iconKey, iconUri', () => {
    const json = JSON.stringify([
      {
        name: 'my-check',
        insight: {
          severity: 'info',
          primary: 'My Title',
          detail: 'My detailed message',
        },
        iconKey: 'my_icon_key',
        iconUri: 'https://icons.example.com/my_icon.png',
      },
    ]);

    const results = parseAnalyzerJson(json);
    const r = results[0]!;

    expect(r.name).toBe('my-check');
    expect(r.title).toBe('My Title');
    expect(r.message).toBe('My detailed message');
    expect(r.iconKey).toBe('my_icon_key');
    expect(r.iconUri).toBe('https://icons.example.com/my_icon.png');
  });

  it('handles unknown severity values by defaulting to info', () => {
    const json = JSON.stringify([
      { name: 'x', insight: { severity: 'critical', primary: 'X', detail: 'xd' } },
    ]);

    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const results = parseAnalyzerJson(json);
    consoleSpy.mockRestore();

    expect(results[0]?.severity).toBe('info');
  });

  // ── Fix #6: Troubleshoot uses "debug" severity for passing analyzers ────
  it('maps Troubleshoot "debug" severity to "pass"', () => {
    const json = JSON.stringify([
      { name: 'passing-check', insight: { severity: 'debug', primary: 'All Good', detail: 'Everything is fine' } },
    ]);

    const results = parseAnalyzerJson(json);

    expect(results[0]?.severity).toBe('pass');
    expect(results[0]?.isPass).toBe(true);
    expect(results[0]?.isFail).toBe(false);
    expect(results[0]?.isWarn).toBe(false);
  });

  it('maps "fail" severity to "error"', () => {
    const json = JSON.stringify([
      { name: 'failing-check', insight: { severity: 'fail', primary: 'Bad', detail: 'Something is wrong' } },
    ]);

    const results = parseAnalyzerJson(json);

    expect(results[0]?.severity).toBe('error');
    expect(results[0]?.isFail).toBe(true);
    expect(results[0]?.isPass).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseAnalyzerFile — integration tests using fixture files
// ---------------------------------------------------------------------------

describe('parseAnalyzerFile', () => {
  it('reads and parses the bad-image-tag scenario analyzer file', async () => {
    const filePath = path.join(FIXTURES_DIR, 'bad-image-tag', 'analysis.json');
    const results = await parseAnalyzerFile(filePath);

    expect(results.length).toBeGreaterThan(0);
    const errorResult = results.find((r) => r.isFail);
    expect(errorResult).toBeDefined();
    expect(errorResult?.severity).toBe('error');
  });

  it('reads and parses the wrong-db-endpoint scenario — maps warn severity', async () => {
    const filePath = path.join(FIXTURES_DIR, 'wrong-db-endpoint', 'analysis.json');
    const results = await parseAnalyzerFile(filePath);

    expect(results.length).toBeGreaterThan(0);
    results.forEach((r) => {
      expect(r.isWarn).toBe(true);
      expect(r.severity).toBe('warn');
    });
  });

  it('reads and parses the missing-secret-crashloop scenario', async () => {
    const filePath = path.join(
      FIXTURES_DIR,
      'missing-secret-crashloop',
      'analysis.json',
    );
    const results = await parseAnalyzerFile(filePath);

    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.isFail)).toBe(true);
  });

  it('returns empty array and logs a warning for a non-existent file', async () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const results = await parseAnalyzerFile('/non/existent/path/output.json');

    expect(results).toHaveLength(0);
    expect(consoleSpy).toHaveBeenCalled();

    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// mergeAnalyzerResults — merging multiple result sets
// ---------------------------------------------------------------------------

describe('mergeAnalyzerResults', () => {
  it('merges multiple analyzer result arrays into a single flat array', () => {
    const setA = parseAnalyzerJson(
      JSON.stringify([{ name: 'check-a', insight: { severity: 'error', primary: 'A', detail: 'a' } }]),
    );
    const setB = parseAnalyzerJson(
      JSON.stringify([
        { name: 'check-b', insight: { severity: 'warn', primary: 'B', detail: 'b' } },
        { name: 'check-c', insight: { severity: 'pass', primary: 'C', detail: 'c' } },
      ]),
    );

    const merged = mergeAnalyzerResults([setA, setB]);

    expect(merged).toHaveLength(3);
    expect(merged.map((r) => r.name)).toEqual(['check-a', 'check-b', 'check-c']);
  });

  it('returns an empty array when given no result sets', () => {
    const merged = mergeAnalyzerResults([]);
    expect(merged).toHaveLength(0);
  });

  it('returns the single result set when only one is provided', () => {
    const setA = parseAnalyzerJson(
      JSON.stringify([{ name: 'only-check', insight: { severity: 'pass', primary: 'P', detail: 'p' } }]),
    );
    const merged = mergeAnalyzerResults([setA]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.name).toBe('only-check');
  });

  it('parses multiple fixture files and merges their results', async () => {
    const scenarios = ['bad-image-tag', 'missing-secret-crashloop', 'wrong-db-endpoint'];
    const resultSets = await Promise.all(
      scenarios.map((s) =>
        parseAnalyzerFile(path.join(FIXTURES_DIR, s, 'analysis.json')),
      ),
    );

    const merged = mergeAnalyzerResults(resultSets);

    // Each scenario has 2 analyzer entries → 6 total
    expect(merged).toHaveLength(6);
  });
});

// Ensure vi cleanup
afterEach(() => {
  vi.restoreAllMocks();
});
