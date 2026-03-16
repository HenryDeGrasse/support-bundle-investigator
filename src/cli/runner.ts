import { parseArgs, CommanderError } from './cli.js';
import { analyzeBundlePipeline, cleanupPipelineResult } from '../pipeline/analyze.js';
import { writePipelineResult, writeTraceFile } from './output.js';

/**
 * Runs the SBI CLI for the provided argv vector and returns the intended exit
 * code instead of terminating the process directly.
 */
export async function runCli(argv: string[] = process.argv): Promise<number> {
  let args;

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

  try {
    const result = await analyzeBundlePipeline(args.bundlePath, {
      outputDir: args.outputDir,
      format: args.format,
      verbose: args.verbose,
      trace: args.trace,
    });

    await writePipelineResult(result, {
      format: args.format,
      outputDir: args.outputDir,
      verbose: args.verbose,
    });

    if (args.trace && args.outputDir) {
      await writeTraceFile(result.trace, args.outputDir);
    }

    await cleanupPipelineResult(result);
    return 0;
  } catch (err) {
    console.error('Error:', (err as Error).message);
    return 1;
  }
}
