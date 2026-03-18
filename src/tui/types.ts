// ---------------------------------------------------------------------------
// Shared TUI types
//
// Centralises types that are used across multiple TUI modules to avoid
// circular imports. No Ink or React imports — this module must be importable
// in any TUI component or the entry-point index.
// ---------------------------------------------------------------------------

/**
 * Options forwarded from the CLI `--tui` flag to the TUI entry point.
 *
 * These map directly to the subset of {@link PipelineOptions} that can be
 * expressed on the command line, plus `outputDir` for export.
 */
export interface TUIOptions {
  /** Directory to write exported reports (defaults to process.cwd()). */
  outputDir?: string;
  /** Enable verbose logging in the underlying pipeline. */
  verbose?: boolean;
  /** Disable AI-powered investigation steps. */
  noAi?: boolean;
  /** Capture a detailed investigation trace. */
  trace?: boolean;
}

// Re-export progress step status so consumers don't need to import from the
// component layer, keeping the dependency graph clean.
export type StepStatus = 'pending' | 'started' | 'completed';
