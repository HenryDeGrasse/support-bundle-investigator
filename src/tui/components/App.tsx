import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Box, Text, useInput, useApp, useStdout } from 'ink';
import type { PipelineOptions, PipelineResult } from '../../pipeline/index.js';
import { buildReport } from '../../reporters/index.js';
import {
  writePipelineResult,
  writeTraceFile,
  writeProvenanceFile,
} from '../../cli/output.js';
import type { TUIOutcome } from '../types.js';
import {
  initialDashboardState,
  dashboardTransition,
  mapKeyToDashboardAction,
} from '../dashboard-state.js';
import type { DashboardState } from '../dashboard-state.js';
import { ProgressView } from './ProgressView.js';
import type { ProgressStep } from './ProgressView.js';
import { DashboardLayout } from './DashboardLayout.js';
import { ExportStatus } from './ExportStatus.js';
import { RatArtHeader } from './RatArtHeader.js';
import { RatRunner } from './RatRunner.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AppProps {
  /** Path to the bundle file to analyze. */
  bundlePath: string;
  /** Options forwarded to the pipeline (excluding onProgress). */
  pipelineOptions?: Omit<PipelineOptions, 'onProgress'>;
  /** Output directory for exported reports (defaults to cwd). */
  outputDir?: string;
  /**
   * Dependency-injected pipeline runner. Defaults to the real
   * analyzeBundlePipeline but can be replaced in tests.
   */
  runPipeline: (
    bundlePath: string,
    options: PipelineOptions,
  ) => Promise<PipelineResult>;
  /** Remove the pipeline's temporary extraction directory. */
  cleanupPipeline?: (result: PipelineResult) => Promise<void>;
  /** Report completion, cancellation, or failure to the CLI wrapper. */
  onOutcome?: (outcome: TUIOutcome) => void;
}

// ---------------------------------------------------------------------------
// Pipeline step names in display order
// ---------------------------------------------------------------------------

const PIPELINE_STEPS = [
  'extract',
  'profile',
  'parse-analyzers',
  'parse-resources',
  'parse-events',
  'parse-logs',
  'ai-index',
  'build-graph',
  'investigate',
];

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

/**
 * Root TUI component that orchestrates all views.
 *
 * - Runs the pipeline via an async effect on mount.
 * - Subscribes to onProgress to update step statuses.
 * - On completion, auto-transitions to the pane-based dashboard.
 * - Handles keyboard input via useInput.
 * - Renders ProgressView during loading, then DashboardLayout once ready.
 */
export function App({
  bundlePath,
  pipelineOptions = {},
  outputDir,
  runPipeline,
  cleanupPipeline = async () => {},
  onOutcome = () => {},
}: AppProps): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();

  // Navigation state (pane-based)
  const [dashState, setDashState] = useState<DashboardState>(initialDashboardState());

  // Pipeline progress steps
  const [steps, setSteps] = useState<ProgressStep[]>(
    PIPELINE_STEPS.map((name) => ({ name, status: 'pending' as const })),
  );

  // Pipeline result (set on completion)
  const [result, setResult] = useState<PipelineResult | null>(null);

  // Error state
  const [error, setError] = useState<string | null>(null);

  // Rolling detail messages for progress sub-steps (e.g. per-seed AI progress)
  const [recentDetails, setRecentDetails] = useState<string[]>([]);

  // Export status overlay
  const [exportVisible, setExportVisible] = useState(false);
  const [exportMessage, setExportMessage] = useState('');
  const exportTimerRef = useRef<NodeJS.Timeout | null>(null);

  // ── Run pipeline on mount ─────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    const options: PipelineOptions = {
      ...pipelineOptions,
      onProgress: (event) => {
        if (cancelled) return;
        setSteps((prev) =>
          prev.map((s) => {
            if (s.name === event.step) {
              return {
                ...s,
                status: event.status,
                ...(event.artifactsProcessed !== undefined
                  ? { artifactsProcessed: event.artifactsProcessed }
                  : {}),
              };
            }
            return s;
          }),
        );
        // Capture detail messages for the rolling progress window
        if (event.detail) {
          setRecentDetails((prev) => [...prev, event.detail!]);
        }
      },
    };

    const originalConsoleLog = console.log;
    const diagnosticLog: typeof console.log = (...values: unknown[]) => {
      console.error(...values);
    };
    if (options.verbose) {
      console.log = diagnosticLog;
    }

    runPipeline(bundlePath, options)
      .then(async (pipelineResult) => {
        // The dashboard/report builders use in-memory data only, so extracted
        // bundle contents can be removed immediately. This also guarantees
        // cleanup if the user quits before the next render.
        await cleanupPipeline(pipelineResult);
        if (cancelled) return;
        setResult(pipelineResult);
        setDashState((prev) =>
          dashboardTransition(prev, { type: 'PIPELINE_COMPLETE' }, 0),
        );
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        onOutcome({ ok: false, error: message });
      })
      .finally(() => {
        if (console.log === diagnosticLog) {
          console.log = originalConsoleLog;
        }
      });

    return () => {
      cancelled = true;
      if (console.log === diagnosticLog) {
        console.log = originalConsoleLog;
      }
    };
  }, []); // intentionally empty — run once on mount

  // ── Export status timer lifecycle ────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (exportTimerRef.current) {
        clearTimeout(exportTimerRef.current);
      }
    };
  }, []);

  const showExportStatus = useCallback((message: string, durationMs: number) => {
    setExportMessage(message);
    setExportVisible(true);

    if (exportTimerRef.current) {
      clearTimeout(exportTimerRef.current);
    }

    exportTimerRef.current = setTimeout(() => {
      setExportVisible(false);
      exportTimerRef.current = null;
    }, durationMs);
  }, []);

  // ── Export handler ────────────────────────────────────────────────────────
  const handleExport = useCallback(async () => {
    if (!result) return;

    const dir = outputDir ?? process.cwd();
    const originalConsoleLog = console.log;
    const suppressedConsoleLog: typeof console.log = () => {};

    try {
      // Suppress writePipelineResult's success log so Ink keeps control of the screen.
      console.log = suppressedConsoleLog;
      await writePipelineResult(result, {
        format: 'json',
        outputDir: dir,
        verbose: false,
        debug: pipelineOptions.debug,
      });
      const written = ['findings.json', 'report.md', 'report.html'];
      if (pipelineOptions.trace || pipelineOptions.debug) {
        await writeTraceFile(result.trace, dir);
        written.push('trace.json');
      }
      if (pipelineOptions.debug) {
        await writeProvenanceFile(result.findings, dir);
        written.push('provenance.json');
      }
      showExportStatus(`Saved to ${dir}: ${written.join(', ')}`, 2000);
    } catch (err) {
      showExportStatus(
        `Export failed: ${err instanceof Error ? err.message : String(err)}`,
        3000,
      );
    } finally {
      if (console.log === suppressedConsoleLog) {
        console.log = originalConsoleLog;
      }
    }
  }, [outputDir, pipelineOptions.debug, pipelineOptions.trace, result, showExportStatus]);

  const findings = result?.findings ?? [];
  const report = useMemo(() => (result ? buildReport(result) : null), [result]);

  // ── Keyboard input ────────────────────────────────────────────────────────
  useInput((input, key) => {
    // Derive a string key identifier from the Ink key object
    let keyId = '';
    if (key.tab && key.shift) keyId = 'shift+tab';
    else if (key.upArrow) keyId = 'upArrow';
    else if (key.downArrow) keyId = 'downArrow';
    else if (key.return) keyId = 'return';
    else if (key.escape) keyId = 'escape';
    else if (key.tab) keyId = 'tab';

    const requestedQuit = input === 'q' || (input === 'c' && key.ctrl);
    if (requestedQuit) {
      if (dashState.phase === 'loading' && error === null) {
        onOutcome({ ok: false, cancelled: true });
      }
      exit();
      return;
    }

    // Handle 's' for export (only when not in loading phase)
    if (input === 's' && dashState.phase !== 'loading') {
      void handleExport();
      return;
    }

    const action = mapKeyToDashboardAction(
      keyId,
      input,
      dashState.activePane,
      dashState.selectedIndex,
    );

    if (!action) return;

    setDashState((prev) =>
      dashboardTransition(
        prev,
        action,
        findings.length,
        report?.specRecommendations.length ?? 0,
      ),
    );
  });

  // ── Error state ───────────────────────────────────────────────────────────
  if (error) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="red" bold>
          Pipeline error
        </Text>
        <Text color="red">{error}</Text>
        <Box marginTop={1}>
          <Text color="gray">Press q to quit.</Text>
        </Box>
      </Box>
    );
  }

  // ── Terminal dimensions for fullscreen layout ────────────────────────────
  const termWidth = stdout?.columns ?? 120;
  const termHeight = stdout?.rows ?? 40;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <Box flexDirection="column" width={termWidth} height={termHeight}>
      {dashState.phase === 'loading' ? (
        <Box flexDirection="column" flexGrow={1}>
          {/* Vertically-centred progress content */}
          <Box flexDirection="column" flexGrow={1} justifyContent="center" alignItems="center">
            <RatArtHeader />
            <ProgressView steps={steps} recentDetails={recentDetails} />
          </Box>
          {/* Rat runs along the bottom edge while the AI is thinking */}
          <RatRunner width={termWidth} />
          <Box>
            <Text color="gray" dimColor>
              {'  [q] quit'}
            </Text>
          </Box>
        </Box>
      ) : (
        <DashboardLayout
          findings={findings}
          recommendations={report?.specRecommendations ?? []}
          state={dashState}
          height={termHeight}
          width={termWidth}
          findingTree={result?.findingTree}
          aiMode={result?.aiMode}
        />
      )}

      {/* Export status overlay */}
      <ExportStatus visible={exportVisible} message={exportMessage} />
    </Box>
  );
}
