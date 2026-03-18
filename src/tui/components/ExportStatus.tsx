import React from 'react';
import { Box, Text } from 'ink';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExportStatusProps {
  visible: boolean;
  message: string;
}

// ---------------------------------------------------------------------------
// ExportStatus
// ---------------------------------------------------------------------------

/**
 * Brief save status overlay displayed at the bottom of the TUI.
 *
 * When visible, renders a small box with green text showing the export message.
 * Auto-dismiss is handled by the parent via a timer (typically 2 seconds).
 */
export function ExportStatus({ visible, message }: ExportStatusProps): React.ReactElement | null {
  if (!visible) return null;

  return (
    <Box borderStyle="single" borderColor="green" paddingX={1} marginTop={1}>
      <Text color="green">✓ {message}</Text>
    </Box>
  );
}
