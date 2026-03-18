import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import type { StepStatus } from '../types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProgressStep {
  name: string;
  status: StepStatus;
  artifactsProcessed?: number;
  /** Optional detail message (e.g. per-seed AI progress). */
  detail?: string;
}

export interface ProgressViewProps {
  steps: ProgressStep[];
  /** Rolling window of recent detail messages (e.g. per-seed progress). */
  recentDetails?: string[];
}

/** Maximum number of detail lines shown in the rolling window. */
const MAX_DETAIL_LINES = 3;

/** Friendly display names for pipeline steps. */
const STEP_LABELS: Record<string, string> = {
  'extract': 'Extract bundle',
  'profile': 'Profile',
  'parse-analyzers': 'Parse analyzers',
  'parse-resources': 'Parse resources',
  'parse-events': 'Parse events',
  'parse-logs': 'Parse logs',
  'ai-index': 'Build AI index',
  'build-graph': 'Build graph',
  'investigate': 'Investigate',
};

// ---------------------------------------------------------------------------
// ProgressView
// ---------------------------------------------------------------------------

/**
 * Displays pipeline step progress with spinners, completion indicators,
 * and a rolling window of recent detail messages.
 *
 * The step list renders at a fixed height (one row per step) so that
 * detail messages appearing below do not push the steps around.
 *
 * - Completed steps show a green checkmark with artifact count.
 * - The active (started) step shows an animated spinner.
 * - Pending steps show a gray dash.
 * - Below the step list, a small bordered box shows the last 3
 *   detail messages (e.g. per-seed AI investigation progress).
 */
export function ProgressView({ steps, recentDetails }: ProgressViewProps): React.ReactElement {
  const visibleDetails = (recentDetails ?? []).slice(-MAX_DETAIL_LINES);

  return (
    <Box flexDirection="column" alignItems="center" flexGrow={1} justifyContent="center">
      <Box flexDirection="column" width={50}>
        <Box marginBottom={1} justifyContent="center">
          <Text bold>Pipeline Progress</Text>
        </Box>

        {/* Step list — fixed height, one row per step */}
        {steps.map((step) => {
          const label = STEP_LABELS[step.name] ?? step.name;
          return (
            <Box key={step.name}>
              {step.status === 'completed' ? (
                <Text color="green">{'  [ok] '}</Text>
              ) : step.status === 'started' ? (
                <Text color="yellow">
                  {'  '}
                  <Spinner type="dots" />
                  {'   '}
                </Text>
              ) : (
                <Text color="gray">{'  [ - ] '}</Text>
              )}
              <Text color={step.status === 'pending' ? 'gray' : undefined}>
                {label.padEnd(20)}
              </Text>
              {step.status === 'completed' && step.artifactsProcessed !== undefined && (
                <Text color="gray">{step.artifactsProcessed}</Text>
              )}
            </Box>
          );
        })}

        {/* Rolling detail window — fixed position below steps */}
        <Box flexDirection="column" marginTop={1} height={MAX_DETAIL_LINES + 2}>
          {visibleDetails.length > 0 ? (
            <Box
              flexDirection="column"
              borderStyle="single"
              borderColor="gray"
              paddingX={1}
              width="100%"
            >
              {visibleDetails.map((detail, i) => (
                <Box key={`detail-${i}`}>
                  <Text
                    color={i === visibleDetails.length - 1 ? 'cyan' : 'gray'}
                    dimColor={i !== visibleDetails.length - 1}
                  >
                    {detail.length > 46 ? detail.slice(0, 43) + '...' : detail}
                  </Text>
                </Box>
              ))}
            </Box>
          ) : (
            <Box />
          )}
        </Box>
      </Box>
    </Box>
  );
}
