import { describe, it, expect } from 'vitest';
import { parseArgs, CommanderError } from '../cli.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds a process.argv-style array for the `analyze` subcommand.
 *
 * Commander expects argv[0] = node binary, argv[1] = script path.
 */
function argv(...args: string[]): string[] {
  return ['node', 'sbi', ...args];
}

// ---------------------------------------------------------------------------
// parseArgs — successful cases
// ---------------------------------------------------------------------------

describe('parseArgs()', () => {
  it('extracts bundle path from arguments', () => {
    const result = parseArgs(argv('analyze', 'my-bundle.tar.gz'));
    expect(result.bundlePath).toBe('my-bundle.tar.gz');
  });

  it('defaults to text format when --format is omitted', () => {
    const result = parseArgs(argv('analyze', 'bundle.tar.gz'));
    expect(result.format).toBe('text');
  });

  it('defaults verbose to false when --verbose is omitted', () => {
    const result = parseArgs(argv('analyze', 'bundle.tar.gz'));
    expect(result.verbose).toBe(false);
  });

  it('defaults trace to false when --trace is omitted', () => {
    const result = parseArgs(argv('analyze', 'bundle.tar.gz'));
    expect(result.trace).toBe(false);
  });

  it('accepts --output-dir flag', () => {
    const result = parseArgs(argv('analyze', 'bundle.tar.gz', '--output-dir', '/tmp/out'));
    expect(result.outputDir).toBe('/tmp/out');
  });

  it('accepts --format json flag', () => {
    const result = parseArgs(argv('analyze', 'bundle.tar.gz', '--format', 'json'));
    expect(result.format).toBe('json');
  });

  it('accepts --format text flag', () => {
    const result = parseArgs(argv('analyze', 'bundle.tar.gz', '--format', 'text'));
    expect(result.format).toBe('text');
  });

  it('accepts --format summary flag', () => {
    const result = parseArgs(argv('analyze', 'bundle.tar.gz', '--format', 'summary'));
    expect(result.format).toBe('summary');
  });

  it('accepts --format markdown flag', () => {
    const result = parseArgs(argv('analyze', 'bundle.tar.gz', '--format', 'markdown'));
    expect(result.format).toBe('markdown');
  });

  it('accepts --format html flag', () => {
    const result = parseArgs(argv('analyze', 'bundle.tar.gz', '--format', 'html'));
    expect(result.format).toBe('html');
  });

  it('accepts --verbose flag', () => {
    const result = parseArgs(argv('analyze', 'bundle.tar.gz', '--verbose'));
    expect(result.verbose).toBe(true);
  });

  it('accepts --trace flag', () => {
    const result = parseArgs(argv('analyze', 'bundle.tar.gz', '--trace'));
    expect(result.trace).toBe(true);
  });

  it('accepts all flags together', () => {
    const result = parseArgs(
      argv(
        'analyze',
        'bundle.tar.gz',
        '--output-dir',
        '/tmp/sbi-out',
        '--format',
        'json',
        '--verbose',
        '--trace',
      ),
    );
    expect(result.bundlePath).toBe('bundle.tar.gz');
    expect(result.outputDir).toBe('/tmp/sbi-out');
    expect(result.format).toBe('json');
    expect(result.verbose).toBe(true);
    expect(result.trace).toBe(true);
  });

  it('defaults noAi to false when --no-ai is omitted', () => {
    const result = parseArgs(argv('analyze', 'bundle.tar.gz'));
    expect(result.noAi).toBe(false);
  });

  it('sets noAi to true when --no-ai flag is passed', () => {
    const result = parseArgs(argv('analyze', 'bundle.tar.gz', '--no-ai'));
    expect(result.noAi).toBe(true);
  });

  it('accepts --no-ai together with other flags', () => {
    const result = parseArgs(
      argv('analyze', 'bundle.tar.gz', '--verbose', '--no-ai', '--format', 'json'),
    );
    expect(result.noAi).toBe(true);
    expect(result.verbose).toBe(true);
    expect(result.format).toBe('json');
  });

  // ── Error cases ─────────────────────────────────────────────────────────

  it('rejects missing bundle path (no analyze subcommand)', () => {
    expect(() => parseArgs(argv())).toThrow();
  });

  it('shows help with --help flag (throws CommanderError with code 0)', () => {
    let error: unknown;
    try {
      parseArgs(argv('analyze', '--help'));
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(CommanderError);
    expect((error as CommanderError).exitCode).toBe(0);
  });

  it('rejects invalid --format value', () => {
    expect(() =>
      parseArgs(argv('analyze', 'bundle.tar.gz', '--format', 'xml')),
    ).toThrow();
  });

  // ── --tui flag ───────────────────────────────────────────────────────────

  it('defaults tui to false when --tui is omitted', () => {
    const result = parseArgs(argv('analyze', 'bundle.tar.gz'));
    expect(result.tui).toBe(false);
  });

  it('sets tui to true when --tui flag is passed', () => {
    const result = parseArgs(argv('analyze', 'bundle.tar.gz', '--tui'));
    expect(result.tui).toBe(true);
  });

  it('accepts --tui together with other flags', () => {
    const result = parseArgs(
      argv('analyze', 'bundle.tar.gz', '--tui', '--verbose', '--no-ai'),
    );
    expect(result.tui).toBe(true);
    expect(result.verbose).toBe(true);
    expect(result.noAi).toBe(true);
  });
});
