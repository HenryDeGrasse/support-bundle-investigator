import { describe, it, expect } from 'vitest';
import { parseHelmReleaseContent } from '../helm-parser.js';
import type { HelmRelease } from '../helm-parser.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReleaseJson(overrides: Partial<HelmRelease> = {}): string {
  return JSON.stringify({
    name: 'my-app',
    namespace: 'default',
    revision: 3,
    status: 'deployed',
    chart: 'my-chart-1.2.3',
    app_version: '2.0.0',
    updated: '2024-01-15T10:00:00Z',
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// JSON parsing
// ---------------------------------------------------------------------------

describe('parseHelmReleaseContent — single JSON release', () => {
  const releases = parseHelmReleaseContent(makeReleaseJson());

  it('parses one release', () => {
    expect(releases).toHaveLength(1);
  });

  it('extracts name', () => {
    expect(releases[0]!.name).toBe('my-app');
  });

  it('extracts namespace', () => {
    expect(releases[0]!.namespace).toBe('default');
  });

  it('extracts revision', () => {
    expect(releases[0]!.revision).toBe(3);
  });

  it('extracts status', () => {
    expect(releases[0]!.status).toBe('deployed');
  });

  it('splits chart name and version from "chart-version" format', () => {
    expect(releases[0]!.chart).toBe('my-chart');
    expect(releases[0]!.chartVersion).toBe('1.2.3');
  });

  it('extracts appVersion from app_version', () => {
    expect(releases[0]!.appVersion).toBe('2.0.0');
  });

  it('extracts updatedAt from updated', () => {
    expect(releases[0]!.updatedAt).toBe('2024-01-15T10:00:00Z');
  });
});

describe('parseHelmReleaseContent — JSON array of releases', () => {
  const content = JSON.stringify([
    { name: 'app-a', namespace: 'ns-a', chart: 'chart-a-1.0.0', status: 'deployed', revision: 1 },
    { name: 'app-b', namespace: 'ns-b', chart: 'chart-b-2.5.1', status: 'failed', revision: 2 },
  ]);
  const releases = parseHelmReleaseContent(content);

  it('parses both releases', () => {
    expect(releases).toHaveLength(2);
  });

  it('first release has correct name and namespace', () => {
    expect(releases[0]!.name).toBe('app-a');
    expect(releases[0]!.namespace).toBe('ns-a');
  });

  it('second release has correct status', () => {
    expect(releases[1]!.status).toBe('failed');
  });
});

describe('parseHelmReleaseContent — nested chart object', () => {
  const content = JSON.stringify({
    name: 'my-app',
    namespace: 'production',
    revision: 5,
    status: 'deployed',
    chart: {
      metadata: {
        name: 'web-app',
        version: '3.1.0',
      },
    },
    config: {
      replicaCount: 3,
      image: { tag: 'v2.0.0' },
    },
  });
  const releases = parseHelmReleaseContent(content);

  it('extracts chart name from nested metadata', () => {
    expect(releases[0]!.chart).toBe('web-app');
  });

  it('extracts chart version from nested metadata', () => {
    expect(releases[0]!.chartVersion).toBe('3.1.0');
  });

  it('extracts config values', () => {
    expect(releases[0]!.values).toEqual({ replicaCount: 3, image: { tag: 'v2.0.0' } });
  });
});

// ---------------------------------------------------------------------------
// YAML parsing
// ---------------------------------------------------------------------------

describe('parseHelmReleaseContent — YAML release', () => {
  const yamlContent = `
name: my-app
namespace: default
revision: 2
status: deployed
chart: my-chart-1.0.0
app_version: "1.5.0"
updated: "2024-03-01T12:00:00Z"
`;
  const releases = parseHelmReleaseContent(yamlContent);

  it('parses one release from YAML', () => {
    expect(releases).toHaveLength(1);
  });

  it('extracts name from YAML', () => {
    expect(releases[0]!.name).toBe('my-app');
  });

  it('extracts chart and version from YAML', () => {
    expect(releases[0]!.chart).toBe('my-chart');
    expect(releases[0]!.chartVersion).toBe('1.0.0');
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('parseHelmReleaseContent — edge cases', () => {
  it('returns empty array for empty string', () => {
    expect(parseHelmReleaseContent('')).toEqual([]);
  });

  it('returns empty array for whitespace-only', () => {
    expect(parseHelmReleaseContent('   \n  ')).toEqual([]);
  });

  it('returns empty array for invalid JSON', () => {
    expect(parseHelmReleaseContent('{not json}')).toEqual([]);
  });

  it('returns empty array for JSON object with no name field', () => {
    expect(parseHelmReleaseContent('{"chart": "foo"}')).toEqual([]);
  });

  it('returns empty array for JSON array of invalid objects', () => {
    expect(parseHelmReleaseContent('[{"chart": "foo"}, {}]')).toEqual([]);
  });

  it('skips invalid entries in a mixed array', () => {
    const content = JSON.stringify([
      { name: 'good', chart: 'c-1.0.0', status: 'deployed' },
      { chart: 'no-name' },
      null,
    ]);
    const releases = parseHelmReleaseContent(content);
    expect(releases).toHaveLength(1);
    expect(releases[0]!.name).toBe('good');
  });

  it('defaults namespace to "default" when missing', () => {
    const releases = parseHelmReleaseContent(JSON.stringify({ name: 'x', chart: 'c-1.0.0' }));
    expect(releases[0]!.namespace).toBe('default');
  });

  it('defaults revision to 1 when missing', () => {
    const releases = parseHelmReleaseContent(JSON.stringify({ name: 'x' }));
    expect(releases[0]!.revision).toBe(1);
  });

  it('defaults status to "unknown" when missing', () => {
    const releases = parseHelmReleaseContent(JSON.stringify({ name: 'x' }));
    expect(releases[0]!.status).toBe('unknown');
  });

  it('defaults values to empty object when no config or values field', () => {
    const releases = parseHelmReleaseContent(JSON.stringify({ name: 'x' }));
    expect(releases[0]!.values).toEqual({});
  });
});
