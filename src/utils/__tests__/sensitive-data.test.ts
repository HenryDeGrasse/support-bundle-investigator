import { describe, expect, it } from 'vitest';
import { sanitizeFinding, sanitizeSensitiveText } from '../sensitive-data.js';
import type { Finding } from '../../types/index.js';

function makeFinding(): Finding {
  return {
    id: 'finding:test:0',
    title: 'Connection failed with password=hunter2',
    severity: 'high',
    confidence: 0.8,
    affectedComponents: ['Pod/default/app'],
    reasoningSummary: 'The log shows password=hunter2 and api-key: SUPER_SECRET_TOKEN_12345.',
    evidence: [
      {
        path: 'cluster-resources/pods/logs/default/app/app.log',
        note: 'Connecting with password=hunter2 failed',
      },
    ],
    contradictionsChecked: ['Authorization: Bearer abc123 was present'],
    recommendedAction: 'Rotate api-key: SUPER_SECRET_TOKEN_12345 immediately.',
    missingEvidence: ['Confirm whether token=abc123 is still valid.'],
  };
}

describe('sanitizeSensitiveText', () => {
  it('redacts password-style assignments', () => {
    expect(sanitizeSensitiveText('password=hunter2')).toContain('password=[REDACTED]');
  });

  it('redacts quoted API key values', () => {
    expect(sanitizeSensitiveText('"api-key": "SUPER_SECRET_TOKEN_12345"')).toContain(
      '"api-key": "[REDACTED]"',
    );
  });

  it('redacts bearer tokens and URL userinfo passwords', () => {
    const sanitized = sanitizeSensitiveText(
      'Authorization: Bearer abc123 https://user:hunter2@example.com',
    );
    expect(sanitized).toContain('Authorization: Bearer [REDACTED]');
    expect(sanitized).toContain('https://user:[REDACTED]@example.com');
  });

  it('redacts non-HTTP connection strings and JWTs', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEyMyJ9.signature12345678';
    const sanitized = sanitizeSensitiveText(
      `DATABASE_URL=postgres://alice:hunter2@db.internal/app JWT=${jwt}`,
    );

    expect(sanitized).not.toContain('hunter2');
    expect(sanitized).not.toContain(jwt);
    expect(sanitized).toContain('DATABASE_URL=[REDACTED]');
    expect(sanitized).toContain('JWT=[REDACTED]');
  });

  it('redacts common standalone API keys and private-key blocks', () => {
    const apiKey = ['sk', 'proj', 'abcdefghijklmnopqrstuvwxyz123456'].join('-');
    const privateKey = [
      `-----BEGIN ${'PRIVATE KEY'}-----`,
      'sensitive-key-material',
      `-----END ${'PRIVATE KEY'}-----`,
    ].join('\n');
    const sanitized = sanitizeSensitiveText(`${apiKey}\n${privateKey}`);

    expect(sanitized).not.toContain(apiKey);
    expect(sanitized).not.toContain('sensitive-key-material');
    expect(sanitized).toContain('[REDACTED PRIVATE KEY]');
  });

  it('redacts common non-OpenAI tokens and Basic authorization headers', () => {
    const gitlabToken = `glpat-${'a'.repeat(24)}`;
    const slackToken = `xoxb-${'1'.repeat(12)}-${'a'.repeat(20)}`;
    const sanitized = sanitizeSensitiveText(
      `${gitlabToken}\n${slackToken}\nAuthorization: Basic dXNlcjpwYXNzd29yZA==`,
    );

    expect(sanitized).not.toContain(gitlabToken);
    expect(sanitized).not.toContain(slackToken);
    expect(sanitized).not.toContain('dXNlcjpwYXNzd29yZA==');
    expect(sanitized.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(3);
  });
});

describe('sanitizeFinding', () => {
  it('redacts sensitive values across finding text fields', () => {
    const finding = sanitizeFinding(makeFinding());

    expect(JSON.stringify(finding)).not.toContain('hunter2');
    expect(JSON.stringify(finding)).not.toContain('SUPER_SECRET_TOKEN_12345');
    expect(JSON.stringify(finding)).not.toContain('abc123');
    expect(finding.evidence[0]?.note).toContain('[REDACTED]');
  });
});
