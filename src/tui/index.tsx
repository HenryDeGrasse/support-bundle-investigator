import React from 'react';
import { render } from 'ink';
import { App } from './components/App.js';
import { analyzeBundlePipeline } from '../pipeline/index.js';
import type { TUIOptions } from './types.js';

// Re-export shared types and helpers so external consumers (e.g. the CLI
// runner, tests, or package users) can import from the TUI entry point
// without reaching into sub-modules.
export type { TUIOptions, StepStatus } from './types.js';
export { initialState, transition, mapKeyToAction } from './state-machine.js';
export type { TUIView, TUIAction, TUIState } from './state-machine.js';
export {
  severityColor,
  formatSeverityLabel,
  sourceTag,
  truncateTitle,
  confidenceBar,
  evidenceIcon,
  extractDifferentialContext,
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
): Promise<void> {
  const { outputDir, ...pipelineOptions } = options;

  const { waitUntilExit } = render(
    <App
      bundlePath={bundlePath}
      pipelineOptions={pipelineOptions}
      outputDir={outputDir}
      runPipeline={analyzeBundlePipeline}
    />,
  );

  await waitUntilExit();
}
