import * as path from 'node:path';

export interface RatArgs {
  path?: string;
  noBuild: boolean;
  noEmbeddingSetup: boolean;
  help: boolean;
  version: boolean;
}

/** Parse RAT's deliberately small command line without triggering any I/O. */
export function parseRatArgs(argv: string[]): RatArgs {
  const parsed: RatArgs = {
    noBuild: false,
    noEmbeddingSetup: false,
    help: false,
    version: false,
  };
  let positionalOnly = false;

  for (const arg of argv) {
    if (!positionalOnly && arg === '--') {
      positionalOnly = true;
      continue;
    }

    if (!positionalOnly && (arg === '--help' || arg === '-h')) {
      parsed.help = true;
      continue;
    }

    if (!positionalOnly && (arg === '--version' || arg === '-V')) {
      parsed.version = true;
      continue;
    }

    if (!positionalOnly && arg === '--no-build') {
      parsed.noBuild = true;
      continue;
    }

    if (!positionalOnly && arg === '--no-embedding-setup') {
      parsed.noEmbeddingSetup = true;
      continue;
    }

    if (!positionalOnly && arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    }

    if (parsed.path !== undefined) {
      throw new Error(`Unexpected extra path argument: ${arg}`);
    }
    parsed.path = arg;
  }

  return parsed;
}

/** Resolve RAT's user-data target without consulting the installed package root. */
export function resolveRatTarget(
  requestedPath: string | undefined,
  cwd: string,
): string {
  return requestedPath ?? path.join(cwd, 'bundles');
}
