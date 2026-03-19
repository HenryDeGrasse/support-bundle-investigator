import React from 'react';
import { Box } from 'ink';
import type { Finding, FindingTreeNode } from '../../types/index.js';
import type { SpecRecommendation } from '../../reporters/index.js';
import type { DashboardState } from '../dashboard-state.js';
import { StatusBarHeader, StatusBarFooter } from './StatusBar.js';
import { FindingsPane } from './FindingsPane.js';
import { DetailPane } from './DetailPane.js';
import { SpecsPane } from './SpecsPane.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Props for the multi-pane dashboard layout orchestrator. */
export interface DashboardLayoutProps {
  /** The findings produced by the pipeline. */
  findings: Finding[];
  /** Spec recommendations to display in the specs pane. */
  recommendations: SpecRecommendation[];
  /** Current dashboard navigation state. */
  state: DashboardState;
  /** Terminal height in rows (for fullscreen layout). */
  height?: number;
  /** Terminal width in columns (for fullscreen layout). */
  width?: number;
  /**
   * Optional causal tree built from the pipeline's finding tree.
   * Used to show causal chain indicators in the findings pane.
   */
  findingTree?: FindingTreeNode[];
}

// ---------------------------------------------------------------------------
// DashboardLayout
// ---------------------------------------------------------------------------

/**
 * Pure presentational orchestrator that composes all dashboard panes into a
 * single multi-pane layout.
 *
 * Layout structure:
 * ```
 * ┌─────────────────────────────────────────────────────┐
 * │ StatusBarHeader                                      │
 * ├──────────────┬──────────────────────────────────────┤
 * │              │ DetailPane                            │
 * │ FindingsPane │─────────────────────────────────────-│
 * │  (~35%)      │ SpecsPane (when specsVisible)         │
 * │              │  (~65%)                               │
 * ├──────────────┴──────────────────────────────────────┤
 * │ StatusBarFooter                                      │
 * └─────────────────────────────────────────────────────┘
 * ```
 *
 * This component holds no state — all state is passed in via `state`.
 */
export function DashboardLayout({
  findings,
  recommendations,
  state,
  height,
  width,
  findingTree,
}: DashboardLayoutProps): React.ReactElement {
  const selectedFinding = findings[state.selectedIndex] ?? null;

  // Compute the set of finding IDs that are causal effects (have a parent).
  // These are shown with a '→' chain indicator in the findings pane.
  const causalChildIds = React.useMemo<ReadonlySet<string>>(() => {
    if (!findingTree || findingTree.length === 0) return new Set<string>();
    return new Set(
      findingTree.filter((n) => n.parent !== undefined).map((n) => n.finding.id),
    );
  }, [findingTree]);

  // Reserve 2 rows for header + footer status bars.
  // Remaining rows go to the main content area.
  const contentHeight = height != null ? Math.max(height - 2, 4) : undefined;

  // When specs pane is visible, split the right column: detail gets ~65%, specs ~35%.
  const detailHeight =
    contentHeight != null && state.specsVisible
      ? Math.max(Math.floor(contentHeight * 0.65), 3)
      : contentHeight;
  const specsHeight =
    contentHeight != null && state.specsVisible
      ? Math.max(contentHeight - (detailHeight ?? 0), 3)
      : undefined;

  return (
    <Box flexDirection="column" width={width ?? '100%'} height={height}>
      {/* Header */}
      <StatusBarHeader
        findingCount={findings.length}
        activePane={state.activePane}
        phase={state.phase}
      />

      {/* Main content area */}
      <Box flexDirection="row" height={contentHeight} flexGrow={1}>
        {/* Left column: ~35% width */}
        <Box width="35%" height={contentHeight}>
          <FindingsPane
            findings={findings}
            selectedIndex={state.selectedIndex}
            focused={state.activePane === 'findings'}
            causalChildIds={causalChildIds}
          />
        </Box>

        {/* Right column: ~65% width */}
        <Box flexDirection="column" width="65%" height={contentHeight}>
          {/* Detail pane — takes remaining space */}
          <Box height={detailHeight} flexGrow={state.specsVisible ? 0 : 1}>
            <DetailPane
              finding={selectedFinding}
              scrollOffset={state.detailScrollOffset}
              focused={state.activePane === 'detail'}
            />
          </Box>

          {/* Specs pane — shown when specsVisible */}
          {state.specsVisible && (
            <Box height={specsHeight}>
              <SpecsPane
                recommendations={recommendations}
                focused={state.activePane === 'specs'}
              />
            </Box>
          )}
        </Box>
      </Box>

      {/* Footer keybindings */}
      <StatusBarFooter
        findingCount={findings.length}
        activePane={state.activePane}
        phase={state.phase}
      />
    </Box>
  );
}
