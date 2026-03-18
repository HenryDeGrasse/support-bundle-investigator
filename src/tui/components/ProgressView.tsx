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
}

export interface ProgressViewProps {
  steps: ProgressStep[];
}

// ---------------------------------------------------------------------------
// ProgressView
// ---------------------------------------------------------------------------

/**
 * Displays pipeline step progress with spinners and completion indicators.
 *
 * - Completed steps show a green '✓' checkmark with artifact count.
 * - The active (started) step shows an animated spinner.
 * - Pending steps show a gray '○' indicator.
 */
export function ProgressView({ steps }: ProgressViewProps): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold>Pipeline Progress</Text>
      </Box>
      {steps.map((step) => (
        <Box key={step.name} marginLeft={2}>
          {step.status === 'completed' ? (
            <Text color="green">✓ </Text>
          ) : step.status === 'started' ? (
            <Text color="yellow">
              <Spinner type="dots" />{' '}
            </Text>
          ) : (
            <Text color="gray">○ </Text>
          )}
          <Text color={step.status === 'pending' ? 'gray' : undefined}>{step.name}</Text>
          {step.status === 'completed' && step.artifactsProcessed !== undefined && (
            <Text color="gray"> ({step.artifactsProcessed} artifacts)</Text>
          )}
        </Box>
      ))}
    </Box>
  );
}
