import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import type { PipelineOptions, PipelineResult } from '../../pipeline/index.js';
import { buildReport } from '../../reporters/index.js';
import { writePipelineResult } from '../../cli/output.js';
import {
  initialState,
  transition,
  mapKeyToAction,
} from '../state-machine.js';
import type { TUIState } from '../state-machine.js';
import { ProgressView } from './ProgressView.js';
import type { ProgressStep } from './ProgressView.js';
import { Dashboard } from './Dashboard.js';
import { DetailView } from './DetailView.js';
import { SpecsView } from './SpecsView.js';
import { ExportStatus } from './ExportStatus.js';

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
 * - On completion, auto-transitions to dashboard.
 * - Handles keyboard input via useInput.
 * - Renders the appropriate view based on navigation state.
 */
export function App({
  bundlePath,
  pipelineOptions = {},
  outputDir,
  runPipeline,
}: AppProps): React.ReactElement {
  const { exit } = useApp();

  // Navigation state
  const [navState, setNavState] = useState<TUIState>(initialState());

  // Pipeline progress steps
  const [steps, setSteps] = useState<ProgressStep[]>(
    PIPELINE_STEPS.map((name) => ({ name, status: 'pending' as const })),
  );

  // Pipeline result (set on completion)
  const [result, setResult] = useState<PipelineResult | null>(null);

  // Error state
  const [error, setError] = useState<string | null>(null);

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
      },
    };

    runPipeline(bundlePath, options)
      .then((pipelineResult) => {
        if (cancelled) return;
        setResult(pipelineResult);
        setNavState((prev) => transition(prev, { type: 'PIPELINE_COMPLETE' }, 0));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
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

    try {
      // Suppress writePipelineResult's success log so Ink keeps control of the screen.
      console.log = () => {};
      await writePipelineResult(result, {
        format: 'json',
        outputDir: dir,
        verbose: false,
      });
      showExportStatus(`Saved to ${dir}: findings.json, report.md, report.html`, 2000);
    } catch (err) {
      showExportStatus(
        `Export failed: ${err instanceof Error ? err.message : String(err)}`,
        3000,
      );
    } finally {
      console.log = originalConsoleLog;
    }
  }, [outputDir, result, showExportStatus]);

  // ── Keyboard input ────────────────────────────────────────────────────────
  useInput((input, key) => {
    // Derive a string key identifier from the Ink key object
    let keyId = '';
    if (key.upArrow) keyId = 'upArrow';
    else if (key.downArrow) keyId = 'downArrow';
    else if (key.return) keyId = 'return';
    else if (key.escape) keyId = 'escape';
    else if (key.tab) keyId = 'tab';

    // Handle 's' for export
    if (input === 's' && navState.view !== 'progress') {
      void handleExport();
      return;
    }

    const action = mapKeyToAction(
      keyId,
      input,
      navState.view,
      navState.selectedIndex,
    );

    if (!action) return;

    if (action.type === 'QUIT') {
      exit();
      return;
    }

    if (action.type === 'SELECT_FINDING' && (result?.findings.length ?? 0) === 0) {
      return;
    }

    setNavState((prev) =>
      transition(prev, action, result?.findings.length ?? 0),
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

  // ── Derive data for views ─────────────────────────────────────────────────
  const findings = result?.findings ?? [];
  const report = result ? buildReport(result) : null;
  const selectedFinding = findings[navState.selectedIndex] ?? null;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <Box flexDirection="column" padding={1}>
      {/* View header */}
      <Box marginBottom={1}>
        <Text bold color="cyan">
          Support Bundle Investigator
        </Text>
        {navState.view !== 'progress' && (
          <Text color="gray"> — {findings.length} finding{findings.length !== 1 ? 's' : ''}</Text>
        )}
      </Box>

      {/* Active view */}
      {navState.view === 'progress' && <ProgressView steps={steps} />}

      {navState.view === 'dashboard' && (
        <Dashboard
          findings={findings}
          selectedIndex={navState.selectedIndex}
          onSelect={(index) =>
            setNavState((prev) =>
              transition(prev, { type: 'SELECT_FINDING', index }, findings.length),
            )
          }
        />
      )}

      {navState.view === 'detail' && selectedFinding && (
        <DetailView
          finding={selectedFinding}
          scrollOffset={navState.detailScrollOffset}
        />
      )}

      {navState.view === 'specs' && report && (
        <SpecsView recommendations={report.specRecommendations} />
      )}

      {/* Export status overlay */}
      <ExportStatus visible={exportVisible} message={exportMessage} />
    </Box>
  );
}
