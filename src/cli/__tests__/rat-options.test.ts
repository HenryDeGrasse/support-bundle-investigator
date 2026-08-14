import { describe, expect, it } from 'vitest';
import { parseRatArgs, resolveRatTarget } from '../rat-options.js';

describe('parseRatArgs', () => {
  it('parses flags and a path without I/O', () => {
    expect(parseRatArgs(['--no-build', '/tmp/bundles', '--no-embedding-setup'])).toEqual({
      path: '/tmp/bundles',
      noBuild: true,
      noEmbeddingSetup: true,
      help: false,
      version: false,
    });
  });

  it('recognizes help and version aliases', () => {
    expect(parseRatArgs(['-h']).help).toBe(true);
    expect(parseRatArgs(['-V']).version).toBe(true);
  });

  it('rejects unknown options', () => {
    expect(() => parseRatArgs(['--wat'])).toThrow('Unknown option: --wat');
  });

  it('rejects more than one path', () => {
    expect(() => parseRatArgs(['/tmp/one', '/tmp/two'])).toThrow(
      'Unexpected extra path argument',
    );
  });

  it('supports paths beginning with a dash after --', () => {
    expect(parseRatArgs(['--', '-bundle.tar.gz']).path).toBe('-bundle.tar.gz');
  });
});

describe('resolveRatTarget()', () => {
  it('roots the default bundles directory in the caller cwd', () => {
    expect(resolveRatTarget(undefined, '/work/customer-case')).toBe(
      '/work/customer-case/bundles',
    );
  });

  it('preserves an explicit target path', () => {
    expect(resolveRatTarget('../bundles/case.tar.gz', '/work/customer-case')).toBe(
      '../bundles/case.tar.gz',
    );
  });
});
