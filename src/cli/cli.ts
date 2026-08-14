import { Command, CommanderError, InvalidArgumentError } from 'commander';
import { VERSION } from '../version.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OutputFormat = 'json' | 'text' | 'summary' | 'markdown' | 'html';

export interface ParsedArgs {
  bundlePath: string;
  outputDir?: string;
  format: OutputFormat;
  verbose: boolean;
  trace: boolean;
  debug: boolean;
  noAi: boolean;
  /** When true, launch the interactive TUI instead of printing to stdout. */
  tui: boolean;
}

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

const VALID_FORMATS: OutputFormat[] = ['json', 'text', 'summary', 'markdown', 'html'];

function validateFormat(value: string): OutputFormat {
  if (!VALID_FORMATS.includes(value as OutputFormat)) {
    throw new InvalidArgumentError(
      `Invalid format "${value}". Must be one of: ${VALID_FORMATS.join(', ')}.`,
    );
  }
  return value as OutputFormat;
}

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

/**
 * Parses command-line arguments using Commander.
 *
 * Uses `exitOverride()` so that `--help`/`--version` and invalid arguments
 * throw a {@link CommanderError} instead of calling `process.exit` directly.
 * The caller (typically the CLI entry point) is responsible for catching
 * these errors and exiting appropriately.
 *
 * @param argv - Raw argument vector. Defaults to `process.argv`.
 *               In tests, pass `['node', 'sbi', 'analyze', '<bundle>', ...]`.
 * @throws {CommanderError} when `--help` or `--version` is requested (code 0)
 *         or when required arguments are missing/invalid (code 1).
 */
export function parseArgs(argv: string[] = process.argv): ParsedArgs {
  let bundlePath = '';
  let capturedOpts: {
    outputDir?: string;
    format?: OutputFormat;
    verbose?: boolean;
    trace?: boolean;
    debug?: boolean;
    /** Commander --no-ai stores the negation under property `ai` */
    ai?: boolean;
    tui?: boolean;
  } = {};

  const program = new Command();

  // Prevent Commander from calling process.exit; throw CommanderError instead
  program.exitOverride();

  program
    .name('sbi')
    .description(
      'Support Bundle Investigator — evidence-backed diagnosis from support bundles',
    )
    .version(VERSION);

  const analyzeCmd = new Command('analyze');
  analyzeCmd
    .description('Analyze a support bundle .tar.gz archive')
    .argument('<bundle-path>', 'Path to the support bundle .tar.gz file')
    .option(
      '--output-dir <dir>',
      'Directory to write output artifacts (findings.json, report.md, report.html, optional trace.json)',
    )
    .option(
      '--format <format>',
      'Output format: json | text | summary | markdown | html (default: text)',
      validateFormat,
      'text' as OutputFormat,
    )
    .option('--verbose', 'Enable verbose pipeline logging', false)
    .option('--trace', 'Write a JSON trace file to the output directory', false)
    .option('--debug', 'Emit enriched trace with per-finding provenance and diagnostics', false)
    .option('--no-ai', 'Disable AI features and run in heuristic-only mode')
    .option('--tui', 'Launch interactive terminal UI for investigation results', false)
    .exitOverride()
    .action((bp: string, opts: typeof capturedOpts) => {
      bundlePath = bp;
      capturedOpts = opts;
    });

  program.addCommand(analyzeCmd);
  program.parse(argv);

  if (!bundlePath) {
    // No subcommand was matched — show help and throw
    throw new CommanderError(
      1,
      'commander.missingArgument',
      'Missing required argument: bundle-path. Run `sbi analyze --help` for usage.',
    );
  }

  return {
    bundlePath,
    outputDir: capturedOpts.outputDir,
    format: capturedOpts.format ?? 'text',
    verbose: capturedOpts.verbose ?? false,
    trace: capturedOpts.trace ?? false,
    debug: capturedOpts.debug ?? false,
    // Commander's --no-ai sets `ai` to false; absence means AI is not disabled
    noAi: capturedOpts.ai === false,
    tui: capturedOpts.tui ?? false,
  };
}

/**
 * Re-export so callers can do instance checks without importing commander directly.
 */
export { CommanderError };
