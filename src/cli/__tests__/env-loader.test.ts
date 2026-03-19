import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadDotEnv } from '../env-loader.js';

describe('loadDotEnv', () => {
  let tmpDir: string;
  let originalCwd: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-loader-test-'));
    originalCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    // Restore environment
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    Object.keys(savedEnv).forEach((k) => delete savedEnv[k]);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function saveAndClear(key: string): void {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }

  it('loads KEY=value from .env', () => {
    saveAndClear('TEST_ENV_LOADER_A');
    fs.writeFileSync(path.join(tmpDir, '.env'), 'TEST_ENV_LOADER_A=hello\n');

    loadDotEnv();

    expect(process.env['TEST_ENV_LOADER_A']).toBe('hello');
  });

  it('does not override existing env vars', () => {
    savedEnv['TEST_ENV_LOADER_B'] = process.env['TEST_ENV_LOADER_B'];
    process.env['TEST_ENV_LOADER_B'] = 'original';
    fs.writeFileSync(path.join(tmpDir, '.env'), 'TEST_ENV_LOADER_B=overridden\n');

    loadDotEnv();

    expect(process.env['TEST_ENV_LOADER_B']).toBe('original');
  });

  it('handles quoted values', () => {
    saveAndClear('TEST_ENV_LOADER_C');
    saveAndClear('TEST_ENV_LOADER_D');
    fs.writeFileSync(
      path.join(tmpDir, '.env'),
      'TEST_ENV_LOADER_C="double quoted"\nTEST_ENV_LOADER_D=\'single quoted\'\n',
    );

    loadDotEnv();

    expect(process.env['TEST_ENV_LOADER_C']).toBe('double quoted');
    expect(process.env['TEST_ENV_LOADER_D']).toBe('single quoted');
  });

  it('skips comments and blank lines', () => {
    saveAndClear('TEST_ENV_LOADER_E');
    fs.writeFileSync(
      path.join(tmpDir, '.env'),
      '# comment\n\nTEST_ENV_LOADER_E=works\n\n# another\n',
    );

    loadDotEnv();

    expect(process.env['TEST_ENV_LOADER_E']).toBe('works');
  });

  it('strips export prefix', () => {
    saveAndClear('TEST_ENV_LOADER_F');
    fs.writeFileSync(path.join(tmpDir, '.env'), 'export TEST_ENV_LOADER_F=exported\n');

    loadDotEnv();

    expect(process.env['TEST_ENV_LOADER_F']).toBe('exported');
  });

  it('strips inline comments for unquoted values', () => {
    saveAndClear('TEST_ENV_LOADER_G');
    fs.writeFileSync(path.join(tmpDir, '.env'), 'TEST_ENV_LOADER_G=value # comment\n');

    loadDotEnv();

    expect(process.env['TEST_ENV_LOADER_G']).toBe('value');
  });

  it('does nothing when no .env file exists', () => {
    // No .env file in tmpDir — should not throw
    expect(() => loadDotEnv()).not.toThrow();
  });

  it('loads multiple variables', () => {
    saveAndClear('TEST_ENV_LOADER_H');
    saveAndClear('TEST_ENV_LOADER_I');
    fs.writeFileSync(
      path.join(tmpDir, '.env'),
      'TEST_ENV_LOADER_H=first\nTEST_ENV_LOADER_I=second\n',
    );

    loadDotEnv();

    expect(process.env['TEST_ENV_LOADER_H']).toBe('first');
    expect(process.env['TEST_ENV_LOADER_I']).toBe('second');
  });
});
