import { parseArgs, CommanderError } from './cli.js';
import { analyzeBundlePipeline, cleanupPipelineResult } from '../pipeline/analyze.js';
import { writePipelineResult, writeTraceFile, writeProvenanceFile } from './output.js';

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

function formatDebugValue(value: string | number | undefined): string {
  if (value === undefined) {
    return '-';
  }

  const rendered = typeof value === 'number' ? value.toFixed(2) : value;
  return rendered.length > 36 ? `${rendered.slice(0, 33)}...` : rendered;
}

function emitDebugFindingSummary(
  findings: Awaited<ReturnType<typeof analyzeBundlePipeline>>['findings'],
): void {
  console.error('');
  console.error('Debug finding provenance summary');
  console.error('Finding ID                      | Investigator   | Seed                                 | Δconf | Merge history');
  console.error('------------------------------- | -------------- | ------------------------------------ | ----- | -------------');

  if (findings.length === 0) {
    console.error('(no findings)');
    return;
  }

  for (const finding of findings) {
    const provenance = finding.provenance;
    console.error(
      [
        formatDebugValue(finding.id).padEnd(31),
        formatDebugValue(provenance?.investigator).padEnd(14),
        formatDebugValue(provenance?.seedId).padEnd(36),
        formatDebugValue(provenance?.confidenceDelta).padEnd(5),
        formatDebugValue(provenance?.mergedFrom?.join(', ')),
      ].join(' | '),
    );
  }
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
        debug: args.debug,
      });
      return 0;
    } catch (err) {
      console.error('Error:', (err as Error).message);
      return 1;
    }
  }

  // ── Standard pipeline mode ────────────────────────────────────────────────
  try {
    const verbose = args.verbose || args.debug;
    const trace = args.trace || args.debug;

    result = await analyzeBundlePipeline(args.bundlePath, {
      outputDir: args.outputDir,
      verbose,
      trace,
      debug: args.debug,
      noAi: args.noAi,
    });

    await writePipelineResult(result, {
      format: args.format,
      outputDir: args.outputDir,
      verbose,
      debug: args.debug,
    });

    if (trace && args.outputDir) {
      await writeTraceFile(result.trace, args.outputDir);
    }

    if (args.debug && args.outputDir) {
      await writeProvenanceFile(result.findings, args.outputDir);
    }

    if (args.debug) {
      emitDebugFindingSummary(result.findings);
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
