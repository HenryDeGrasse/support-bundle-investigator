import React from 'react';
import { Box, Text } from 'ink';
import type { SpecRecommendation, SpecRecommendationType } from '../../reporters/index.js';
import { Pane } from './Pane.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Props for the spec recommendations pane. */
export interface SpecsPaneProps {
  /** The spec recommendations to display. */
  recommendations: SpecRecommendation[];
  /** When true the pane border and title render in their focused style. */
  focused: boolean;
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
// SpecsPane
// ---------------------------------------------------------------------------

/**
 * Pane that displays spec recommendations with type badges, descriptions, and
 * rationale inside a {@link Pane} border.
 *
 * When no recommendations are present a placeholder message is shown in gray.
 */
export function SpecsPane({
  recommendations,
  focused,
}: SpecsPaneProps): React.ReactElement {
  return (
    <Pane title="Spec Recommendations" focused={focused}>
      {recommendations.length === 0 ? (
        <Box marginLeft={2} marginTop={1}>
          <Text color="gray">No spec recommendations.</Text>
        </Box>
      ) : (
        <Box flexDirection="column" paddingX={1}>
          {recommendations.map((rec, index) => {
            const badge = typeBadge(rec.type);
            return (
              <Box key={index} flexDirection="column" marginBottom={1}>
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
          })}
        </Box>
      )}
    </Pane>
  );
}
