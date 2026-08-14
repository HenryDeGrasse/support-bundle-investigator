import React from 'react';
import { Box, Text } from 'ink';
import type { SpecRecommendation, SpecRecommendationType } from '../../reporters/index.js';
import { calculateViewport } from '../helpers.js';
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
  /** Index of the focused recommendation; the viewport follows it. */
  scrollOffset?: number;
  /** Maximum recommendations that fit in the pane. */
  maxVisibleItems?: number;
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
  scrollOffset = 0,
  maxVisibleItems,
}: SpecsPaneProps): React.ReactElement {
  const capacity = Math.max(1, maxVisibleItems ?? Math.max(1, recommendations.length));
  const focusedIndex = Math.min(
    Math.max(0, scrollOffset),
    Math.max(0, recommendations.length - 1),
  );
  const viewport = calculateViewport(recommendations.length, focusedIndex, capacity);
  const visibleRecommendations = recommendations.slice(viewport.start, viewport.end);

  return (
    <Pane title="Spec Recommendations" focused={focused}>
      {recommendations.length === 0 ? (
        <Box marginLeft={2} marginTop={1}>
          <Text color="gray">No spec recommendations.</Text>
        </Box>
      ) : (
        <Box flexDirection="column" paddingX={1}>
          {visibleRecommendations.map((rec, index) => {
            const badge = typeBadge(rec.type);
            const itemIndex = viewport.start + index;
            const isSelected = focused && itemIndex === focusedIndex;
            return (
              <Box key={`${itemIndex}-${rec.type}`} flexDirection="column" marginBottom={1}>
                <Box>
                  <Text color="cyan">{isSelected ? '▸ ' : '  '}</Text>
                  <Text color={badge.color} bold={isSelected}>
                    [{badge.label}]
                  </Text>
                  <Text bold={isSelected} wrap="truncate-end"> {rec.description}</Text>
                </Box>
                <Box marginLeft={2}>
                  <Text color="gray" dimColor wrap="truncate-end">
                    Rationale: {rec.rationale}
                  </Text>
                </Box>
              </Box>
            );
          })}
          {recommendations.length > capacity && (
            <Text color="gray" dimColor>
              Showing {viewport.start + 1}–{viewport.end} of{' '}
              {recommendations.length} · [↑↓/jk] scroll
            </Text>
          )}
        </Box>
      )}
    </Pane>
  );
}
