import React from 'react';
import { render } from 'ink';
import { App } from './components/App.js';
import { analyzeBundlePipeline, cleanupPipelineResult } from '../pipeline/index.js';
import type { TUIOptions, TUIOutcome } from './types.js';

// Re-export shared types and helpers so external consumers (e.g. the CLI
// runner, tests, or package users) can import from the TUI entry point
// without reaching into sub-modules.
export type { TUIOptions, TUIOutcome, StepStatus } from './types.js';
export { initialState, transition, mapKeyToAction } from './state-machine.js';
export type { TUIView, TUIAction, TUIState } from './state-machine.js';
export {
  initialDashboardState,
  dashboardTransition,
  mapKeyToDashboardAction,
} from './dashboard-state.js';
export type {
  DashboardPane,
  DashboardPhase,
  DashboardState,
  DashboardAction,
} from './dashboard-state.js';
export {
  severityColor,
  formatSeverityLabel,
  sourceTag,
  truncateTitle,
  confidenceBar,
  calculateViewport,
  evidenceIcon,
  extractDifferentialContext,
  formatCausalChain,
} from './helpers.js';

/**
 * Renders the interactive TUI for investigating a support bundle.
 *
 * This is the main entry point for `--tui` mode. It renders the Ink
 * application and returns a promise that resolves when the user exits.
 *
 * @param bundlePath - Absolute or relative path to the support bundle archive.
 * @param options    - TUI display / pipeline options forwarded from the CLI.
 */
export async function renderTUI(
  bundlePath: string,
  options: TUIOptions = {},
): Promise<TUIOutcome> {
  const { outputDir, ...requestedPipelineOptions } = options;
  const pipelineOptions = {
    ...requestedPipelineOptions,
    verbose: requestedPipelineOptions.verbose || requestedPipelineOptions.debug,
    trace: requestedPipelineOptions.trace || requestedPipelineOptions.debug,
  };
  let outcome: TUIOutcome = { ok: true };

  // Use Ink's fullscreen mode: clears the terminal on enter, restores on exit.
  // Combined with explicit width/height on the root Box (set in App.tsx via
  // useStdout), this produces a full-terminal dashboard experience.
  const { waitUntilExit } = render(
    <App
      bundlePath={bundlePath}
      pipelineOptions={pipelineOptions}
      outputDir={outputDir}
      runPipeline={analyzeBundlePipeline}
      cleanupPipeline={cleanupPipelineResult}
      onOutcome={(nextOutcome) => {
        // A pipeline error is terminal and must not be overwritten by the
        // subsequent q/ctrl-c used to dismiss its error screen.
        if (!outcome.ok && 'error' in outcome) return;
        outcome = nextOutcome;
      }}
    />,
    { exitOnCtrlC: false },
  );

  // Clear screen on entry for a clean fullscreen look
  process.stdout.write('\x1B[2J\x1B[H');

  try {
    await waitUntilExit();
    return outcome;
  } finally {
    // Restore screen even if Ink itself rejects while shutting down.
    process.stdout.write('\x1B[2J\x1B[H');
  }
}
