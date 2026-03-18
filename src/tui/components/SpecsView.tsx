import React from 'react';
import { Box, Text } from 'ink';
import type { SpecRecommendation, SpecRecommendationType } from '../../reporters/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SpecsViewProps {
  recommendations: SpecRecommendation[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns a colored badge label for a spec recommendation type.
 */
function typeBadge(type: SpecRecommendationType): { label: string; color: string } {
  switch (type) {
    case 'collector':
      return { label: 'COLLECTOR', color: 'cyan' };
    case 'analyzer':
      return { label: 'ANALYZER', color: 'yellow' };
    case 'redaction':
      return { label: 'REDACTION', color: 'magenta' };
  }
}

// ---------------------------------------------------------------------------
// SpecsView
// ---------------------------------------------------------------------------

/**
 * Displays spec recommendations with type badges, descriptions, and rationale.
 */
export function SpecsView({ recommendations }: SpecsViewProps): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold>Spec Recommendations</Text>
      </Box>

      {recommendations.length === 0 ? (
        <Box marginLeft={2}>
          <Text color="gray">No spec recommendations generated.</Text>
        </Box>
      ) : (
        recommendations.map((rec, index) => {
          const badge = typeBadge(rec.type);
          return (
            <Box key={index} flexDirection="column" marginBottom={1} marginLeft={2}>
              <Box>
                <Text color={badge.color} bold>
                  [{badge.label}]
                </Text>
                <Text> {rec.description}</Text>
              </Box>
              <Box marginLeft={2}>
                <Text color="gray" dimColor>
                  Rationale: {rec.rationale}
                </Text>
              </Box>
            </Box>
          );
        })
      )}

      <Box marginTop={1}>
        <Text color="gray" dimColor>
          [tab] back to dashboard  [s] export  [q] quit
        </Text>
      </Box>
    </Box>
  );
}
