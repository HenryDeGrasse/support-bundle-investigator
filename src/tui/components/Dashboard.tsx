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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DashboardProps {
  findings: Finding[];
  selectedIndex: number;
  onSelect: (index: number) => void;
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

/**
 * Severity-colored ranked findings list with keyboard navigation.
 *
 * Each row displays:
 * - Selection indicator ('▸' on selected row)
 * - Severity badge colored via severityColor()
 * - Confidence via confidenceBar()
 * - Source tag via sourceTag()
 * - Truncated title via truncateTitle(title, 60)
 */
export function Dashboard({ findings, selectedIndex }: DashboardProps): React.ReactElement {
  return (
    <Box flexDirection="column">
      {/* Header */}
      <Box marginBottom={1}>
        <Text bold>
          {'  '}
          {'SEV    CONF  TAG  TITLE'}
        </Text>
      </Box>

      {findings.length === 0 ? (
        <Box marginLeft={2}>
          <Text color="gray">No findings.</Text>
        </Box>
      ) : (
        findings.map((finding, index) => {
          const isSelected = index === selectedIndex;
          const color = severityColor(finding.severity);
          const label = formatSeverityLabel(finding.severity).padEnd(8);
          const conf = confidenceBar(finding.confidence).padEnd(6);
          const tag = sourceTag(finding.id).padEnd(5);
          const title = truncateTitle(finding.title, 60);

          return (
            <Box key={finding.id}>
              <Text color="cyan">{isSelected ? '▸ ' : '  '}</Text>
              <Text color={color} bold={isSelected}>
                {label}
              </Text>
              <Text bold={isSelected}>{conf}</Text>
              <Text color="gray" bold={isSelected}>
                {tag}
              </Text>
              <Text bold={isSelected}>{title}</Text>
            </Box>
          );
        })
      )}

      <Box marginTop={1}>
        <Text color="gray" dimColor>
          [↑↓/jk] navigate  [enter] view detail  [tab] specs  [s] export  [q] quit
        </Text>
      </Box>
    </Box>
  );
}
