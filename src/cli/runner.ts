import { parseArgs, CommanderError } from './cli.js';
import { analyzeBundlePipeline, cleanupPipelineResult } from '../pipeline/analyze.js';
import { writePipelineResult, writeTraceFile } from './output.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RunCliOptions {
  /**
   * Lazy loader for the TUI module.  Provided only by the CLI binary entry
   * point (`src/cli/run.ts`) where the relative import path to `dist/tui/`
   * is stable.  Omitted when `runCli` is called from the library entry
   * (`src/index.ts`) or from tests.
   */
  loadTUI?: () => Promise<{
    renderTUI: (bundlePath: string, options: Record<string, unknown>) => Promise<void>;
  }>;
}

// ---------------------------------------------------------------------------
// runCli
// ---------------------------------------------------------------------------

/**
 * Runs the SBI CLI for the provided argv vector and returns the intended exit
 * code instead of terminating the process directly.
 *
 * @param argv    - Raw argument vector (defaults to `process.argv`).
 * @param options - Optional dependency-injection options (e.g. TUI loader).
 */
export async function runCli(
  argv: string[] = process.argv,
  options: RunCliOptions = {},
): Promise<number> {
  let args;
  let result: Awaited<ReturnType<typeof analyzeBundlePipeline>> | undefined;

  try {
    args = parseArgs(argv);
  } catch (err) {
    if (err instanceof CommanderError) {
      // exitCode 0 = --help / --version (output already printed by Commander)
      return err.exitCode;
    }

    console.error((err as Error).message);
    return 1;
  }

  // ── TUI mode ─────────────────────────────────────────────────────────────
  if (args.tui) {
    if (!options.loadTUI) {
      console.error('Error: --tui is only supported when running via the sbi CLI binary.');
      return 1;
    }

    try {
      const { renderTUI } = await options.loadTUI();
      await renderTUI(args.bundlePath, {
        outputDir: args.outputDir,
        verbose: args.verbose,
        noAi: args.noAi,
        trace: args.trace,
      });
      return 0;
    } catch (err) {
      console.error('Error:', (err as Error).message);
      return 1;
    }
  }

  // ── Standard pipeline mode ────────────────────────────────────────────────
  try {
    result = await analyzeBundlePipeline(args.bundlePath, {
      outputDir: args.outputDir,
      verbose: args.verbose,
      trace: args.trace,
      noAi: args.noAi,
    });

    await writePipelineResult(result, {
      format: args.format,
      outputDir: args.outputDir,
      verbose: args.verbose,
    });

    if (args.trace && args.outputDir) {
      await writeTraceFile(result.trace, args.outputDir);
    }

    return 0;
  } catch (err) {
    console.error('Error:', (err as Error).message);
    return 1;
  } finally {
    if (result) {
      await cleanupPipelineResult(result);
    }
  }
}
