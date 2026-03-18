import React from 'react';
import { Box, Text } from 'ink';
import type { DashboardPane, DashboardPhase } from '../dashboard-state.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Props for the status bar components. */
export interface StatusBarProps {
  /** Total number of findings produced by the pipeline. */
  findingCount: number;
  /** Currently focused pane. */
  activePane: DashboardPane;
  /** Dashboard lifecycle phase. */
  phase: DashboardPhase;
}

// ---------------------------------------------------------------------------
// StatusBarHeader
// ---------------------------------------------------------------------------

/**
 * Top bar displaying the application name and finding count.
 *
 * Renders:
 * - Bold cyan application title
 * - Gray finding count
 */
export function StatusBarHeader(
  props: Pick<StatusBarProps, 'findingCount' | 'activePane' | 'phase'>,
): React.ReactElement {
  return (
    <Box>
      <Text bold color="cyan">
        Support Bundle Investigator
      </Text>
      <Text color="gray"> — {props.findingCount} finding(s)</Text>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// StatusBarFooter
// ---------------------------------------------------------------------------

/**
 * Bottom bar displaying context-sensitive keybinding hints.
 *
 * The hints shown depend on the currently focused pane:
 * - `'findings'` → navigation + selection hints + universal hints
 * - `'detail'`   → scroll hints + universal hints
 * - `'specs'`    → universal hints only
 *
 * Universal hints (always shown): [tab] switch pane  [t] toggle specs  [s] export  [q] quit
 */
export function StatusBarFooter(
  props: Pick<StatusBarProps, 'findingCount' | 'activePane' | 'phase'>,
): React.ReactElement {
  const universal = '[tab] switch pane  [t] toggle specs  [s] export  [q] quit';

  let contextHints = '';
  if (props.activePane === 'findings') {
    contextHints = '[↑↓/jk] navigate  [enter] select  ';
  } else if (props.activePane === 'detail') {
    contextHints = '[↑↓/jk] scroll  ';
  }

  return (
    <Box>
      <Text color="gray" dimColor>
        {contextHints}
        {universal}
      </Text>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// StatusBar
// ---------------------------------------------------------------------------

/**
 * Combined status bar that renders both header and footer sections.
 *
 * For layouts that need the header and footer placed at opposite ends of the
 * screen, use the individual {@link StatusBarHeader} and {@link StatusBarFooter}
 * components directly.
 */
export function StatusBar({
  findingCount,
  activePane,
  phase,
}: StatusBarProps): React.ReactElement {
  return (
    <Box flexDirection="column">
      <StatusBarHeader
        findingCount={findingCount}
        activePane={activePane}
        phase={phase}
      />
      <StatusBarFooter
        findingCount={findingCount}
        activePane={activePane}
        phase={phase}
      />
    </Box>
  );
}
