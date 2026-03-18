import React from 'react';
import { Box, Text } from 'ink';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Props for the reusable pane wrapper. */
export interface PaneProps {
  /** Title displayed in the pane's header row. */
  title: string;
  /** When true the pane renders with a cyan border and bold title. */
  focused: boolean;
  /** Pane body content. */
  children: React.ReactNode;
}

// ---------------------------------------------------------------------------
// Pane
// ---------------------------------------------------------------------------

/**
 * Foundational container for all dashboard panes.
 *
 * Renders a rounded border whose color reflects keyboard focus:
 * - Focused   → cyan border, bold cyan title
 * - Unfocused → gray border, gray title
 *
 * The pane fills its parent container using `flexGrow={1}` and
 * `width="100%"` / `height="100%"` so the pane-based layout fills
 * the entire terminal when explicit dimensions are provided by the
 * parent DashboardLayout.
 */
export function Pane({ title, focused, children }: PaneProps): React.ReactElement {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={focused ? 'cyan' : 'gray'}
      flexGrow={1}
      width="100%"
      height="100%"
      overflow="hidden"
    >
      {/* Title row */}
      <Box>
        <Text bold={focused} color={focused ? 'cyan' : 'gray'}>
          {' '}
          {title}{' '}
        </Text>
      </Box>

      {/* Body */}
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {children}
      </Box>
    </Box>
  );
}
