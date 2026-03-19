import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Two-frame walk cycle: tail-up and tail-down gives a wag effect. */
const RAT_FRAMES = ['~(__^>', '-(__^>'] as const;

/** Character width of each frame (must all be the same). */
const RAT_WIDTH = RAT_FRAMES[0].length; // 6

/** Cheese dot character. */
const CHEESE = '.';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generates a random set of cheese positions spread across the track,
 * starting from `offset` so cheese only appears ahead of the rat.
 */
function generateCheese(width: number, offset: number): Set<number> {
  const positions = new Set<number>();
  let i = offset + RAT_WIDTH + 2;
  while (i < width - 2) {
    positions.add(i);
    i += 3 + Math.floor(Math.random() * 5); // 3–7 char gaps
  }
  return positions;
}

// ---------------------------------------------------------------------------
// RatRunner
// ---------------------------------------------------------------------------

export interface RatRunnerProps {
  /** Full terminal width — the rat runs edge to edge. */
  width: number;
}

/**
 * An animated ASCII rat that scurries left-to-right eating cheese dots.
 *
 * - The rat sprite alternates between `~(__^>` and `-(__^>` for a
 *   tail-wagging walk cycle at ~8 fps.
 * - Yellow `.` cheese dots are scattered ahead; they disappear as the
 *   rat passes over them (eaten!).
 * - When the rat reaches the right edge it wraps back to the left and
 *   a fresh spread of cheese is generated.
 */
export function RatRunner({ width }: RatRunnerProps): React.ReactElement {
  const [pos, setPos] = useState(0);
  const [frame, setFrame] = useState(0);
  const [cheese, setCheese] = useState<Set<number>>(() => generateCheese(width, 0));

  useEffect(() => {
    const timer = setInterval(() => {
      setPos((p) => {
        const next = p + 1;
        if (next >= width - RAT_WIDTH) {
          // Reached the right edge — wrap and scatter fresh cheese
          setCheese(generateCheese(width, 0));
          return 0;
        }
        return next;
      });
      setFrame((f) => (f + 1) % RAT_FRAMES.length);
    }, 120); // ~8 fps

    return () => clearInterval(timer);
  }, [width]);

  const ratSprite = RAT_FRAMES[frame];

  // Section before the rat: blank (cheese has been eaten)
  const before = ' '.repeat(Math.max(0, pos));

  // Section after the rat: cheese dots at pre-generated positions
  const afterLen = Math.max(0, width - pos - RAT_WIDTH);
  const afterChars = Array<string>(afterLen).fill(' ');
  for (const c of cheese) {
    const idx = c - pos - RAT_WIDTH;
    if (idx >= 0 && idx < afterLen) {
      afterChars[idx] = CHEESE;
    }
  }
  const after = afterChars.join('');

  return (
    <Box>
      {/* Eaten trail — blank */}
      <Text>{before}</Text>
      {/* The rat itself */}
      <Text color="green">{ratSprite}</Text>
      {/* Uneaten cheese ahead */}
      <Text color="yellow">{after}</Text>
    </Box>
  );
}
