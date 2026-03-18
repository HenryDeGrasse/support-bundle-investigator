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

// ---------------------------------------------------------------------------
// ProgressView
// ---------------------------------------------------------------------------

/**
 * Displays pipeline step progress with spinners, completion indicators,
 * and a rolling window of recent detail messages.
 *
 * - Completed steps show a green checkmark with artifact count.
 * - The active (started) step shows an animated spinner.
 * - Pending steps show a gray circle.
 * - Below the step list, a small rolling window shows the last 3
 *   detail messages (e.g. per-seed AI investigation progress).
 */
export function ProgressView({ steps, recentDetails }: ProgressViewProps): React.ReactElement {
  const visibleDetails = (recentDetails ?? []).slice(-MAX_DETAIL_LINES);

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold>Pipeline Progress</Text>
      </Box>
      {steps.map((step) => (
        <Box key={step.name} marginLeft={2}>
          {step.status === 'completed' ? (
            <Text color="green">{'[done] '}</Text>
          ) : step.status === 'started' ? (
            <Text color="yellow">
              <Spinner type="dots" />{' '}
            </Text>
          ) : (
            <Text color="gray">{'[ -- ] '}</Text>
          )}
          <Text color={step.status === 'pending' ? 'gray' : undefined}>{step.name}</Text>
          {step.status === 'completed' && step.artifactsProcessed !== undefined && (
            <Text color="gray"> ({step.artifactsProcessed})</Text>
          )}
        </Box>
      ))}

      {/* Rolling detail window — shows last N sub-step messages */}
      {visibleDetails.length > 0 && (
        <Box flexDirection="column" marginTop={1} marginLeft={2}>
          <Box
            flexDirection="column"
            borderStyle="single"
            borderColor="gray"
            paddingX={1}
          >
            {visibleDetails.map((detail, i) => (
              <Box key={`detail-${i}`}>
                <Text color={i === visibleDetails.length - 1 ? 'cyan' : 'gray'} dimColor={i !== visibleDetails.length - 1}>
                  {detail}
                </Text>
              </Box>
            ))}
          </Box>
        </Box>
      )}
    </Box>
  );
}
