import React from 'react';
import { Box, Text } from 'ink';
import type { DashboardPane, DashboardPhase } from '../dashboard-state.js';
import type { AIMode } from '../../pipeline/analyze.js';

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
  /** How the AI layer was configured: 'cloud', 'local', or 'off'. */
  aiMode?: AIMode;
}

// ---------------------------------------------------------------------------
// AI mode display helpers
// ---------------------------------------------------------------------------

/**
 * Returns a human-readable label and color for the AI mode indicator.
 */
function aiModeDisplay(mode: AIMode | undefined): { label: string; color: string } {
  switch (mode) {
    case 'cloud':
      return { label: 'AI:cloud', color: 'green' };
    case 'local':
      return { label: 'AI:local', color: 'yellow' };
    case 'off':
      return { label: 'AI:off', color: 'gray' };
    default:
      return { label: '', color: 'gray' };
  }
}

// ---------------------------------------------------------------------------
// StatusBarHeader
// ---------------------------------------------------------------------------

/**
 * Top bar displaying the application name, finding count, and AI mode.
 *
 * Renders:
 * - Bold cyan application title
 * - Gray finding count
 * - AI mode indicator (cloud/local/off)
 */
export function StatusBarHeader(
  props: Pick<StatusBarProps, 'findingCount' | 'activePane' | 'phase' | 'aiMode'>,
): React.ReactElement {
  const { label: aiLabel, color: aiColor } = aiModeDisplay(props.aiMode);

  return (
    <Box>
      <Text bold color="cyan">
        Support Bundle Investigator
      </Text>
      <Text color="gray"> — {props.findingCount} finding(s)</Text>
      {aiLabel.length > 0 && (
        <>
          <Text color="gray">{' | '}</Text>
          <Text color={aiColor}>{aiLabel}</Text>
        </>
      )}
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
