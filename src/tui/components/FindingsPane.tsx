import React from 'react';
import { Box, Text } from 'ink';
import type { Finding } from '../../types/index.js';
import {
  severityColor,
  formatSeverityLabel,
  confidenceBar,
  sourceTag,
  truncateTitle,
} from '../helpers.js';
import { humanizeTitle } from '../../reporters/display-helpers.js';
import { Pane } from './Pane.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Props for the findings list pane. */
export interface FindingsPaneProps {
  /** The findings to display. */
  findings: Finding[];
  /** Index of the currently highlighted finding. */
  selectedIndex: number;
  /** When true the pane border and title render in their focused style. */
  focused: boolean;
  /**
   * Optional set of finding IDs that are causal effects (i.e. they have a
   * parent in the finding tree). When provided, findings in this set are
   * rendered with a `→` causal chain indicator.
   */
  causalChildIds?: ReadonlySet<string>;
}

// ---------------------------------------------------------------------------
// FindingsPane
// ---------------------------------------------------------------------------

/**
 * Pane that renders the severity-ranked findings list inside a {@link Pane}
 * border.
 *
 * Each row displays:
 * - Selection indicator ('▸' on the selected row, two spaces otherwise)
 * - Severity badge colored via {@link severityColor} / {@link formatSeverityLabel}
 * - Confidence via {@link confidenceBar}
 * - Source tag via {@link sourceTag}
 * - Truncated title via {@link truncateTitle} (max 40 chars — narrower than the
 *   standalone Dashboard which uses 60)
 *
 * When the findings array is empty a "No findings." placeholder is shown in gray.
 */
export function FindingsPane({
  findings,
  selectedIndex,
  focused,
  causalChildIds,
}: FindingsPaneProps): React.ReactElement {
  return (
    <Pane title="Findings" focused={focused}>
      {/* Column header */}
      <Box marginBottom={1}>
        <Text bold color="gray">
          {'  '}
          {'SEV       CONF  TAG  TITLE'}
        </Text>
      </Box>

      {/* Rows */}
      {findings.length === 0 ? (
        <Box marginLeft={2}>
          <Text color="gray">No findings.</Text>
        </Box>
      ) : (
        findings.map((finding, index) => {
          const isSelected = index === selectedIndex;
          const color = severityColor(finding.severity);
          const label = formatSeverityLabel(finding.severity).padEnd(9);
          const conf = confidenceBar(finding.confidence).padEnd(5);
          const tag = sourceTag(finding.id).padEnd(4);
          // Reserve 2 chars for chain indicator; reduce title space by 2 to compensate
          const isCausalEffect = causalChildIds?.has(finding.id) ?? false;
          const title = truncateTitle(humanizeTitle(finding.title), isCausalEffect ? 38 : 40);

          return (
            <Box key={finding.id}>
              <Text color="cyan">{isSelected ? '▸ ' : '  '}</Text>
              <Text color={color} bold={isSelected}>
                {label}
              </Text>
              <Text bold={isSelected}>{conf} </Text>
              <Text color="gray" bold={isSelected}>
                {tag}{' '}
              </Text>
              {isCausalEffect && (
                <Text color="gray" dimColor>
                  {'→ '}
                </Text>
              )}
              <Text bold={isSelected}>{title}</Text>
            </Box>
          );
        })
      )}
    </Pane>
  );
}
