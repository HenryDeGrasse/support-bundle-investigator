import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text } from 'ink';

// ---------------------------------------------------------------------------
// Animated rat header art
// ---------------------------------------------------------------------------

/**
 * Four-frame animated rat derived from the user's preferred crouch/perk style.
 *
 * Animation beats:
 * - frame 0: crouched / sneaking
 * - frame 1: perked up / alert
 * - frame 2: nibble / chomp
 * - frame 3: blink / chew
 *
 * All frames are padded to a shared width so the animation does not jitter
 * horizontally when centered by Ink.
 */
const RAW_FRAMES = [
  [
    String.raw`            .  ,`,
    String.raw`           (\;/)`,
    String.raw`           oo   \\/,        _`,
    String.raw`         ,/_;~      \\,     / '`,
    String.raw`         "'    (  (   \    !`,
    String.raw`               //  \\   |__.'`,
    String.raw`             '~  '~----''`,
  ],
  [
    String.raw`            ,     .`,
    String.raw`           (\,;,/)`,
    String.raw`            (o o)\\//,`,
    String.raw`             \ /     \\,`,
    String.raw`             \\_/  (   \    )`,
    String.raw`                //  \\   |_./`,
    String.raw`              '~' '~----'`,
  ],
  [
    String.raw`            ,     .`,
    String.raw`           (\,;,/)`,
    String.raw`            (@ @)\\//,`,
    String.raw`             \n/     \\,`,
    String.raw`             \\_/  (   \    )`,
    String.raw`                //  \\   |_./`,
    String.raw`              '~' '~----'`,
  ],
  [
    String.raw`            ,     .`,
    String.raw`           (\,;,/)`,
    String.raw`            (- -)\\//,`,
    String.raw`             \~/     \\,`,
    String.raw`             \\_/  (   \    )`,
    String.raw`                //  \\   |_./`,
    String.raw`              '~' '~----'`,
  ],
] as const;

/**
 * Hold each frame much longer so the rat feels calm and deliberate rather than
 * flickery. Roughly 4–5× slower than the original pass.
 */
const FRAME_DURATIONS_MS = [2400, 900, 600, 1600] as const;

const FRAME_WIDTH = Math.max(
  ...RAW_FRAMES.flatMap((frame) => frame.map((line) => line.length)),
);

const FRAMES = RAW_FRAMES.map((frame) => frame.map((line) => line.padEnd(FRAME_WIDTH, ' ')));

// ---------------------------------------------------------------------------
// RatArtHeader
// ---------------------------------------------------------------------------

/**
 * Animated ASCII rat header for the loading screen.
 *
 * Replaces the previous static face/header art while keeping the bottom rat
 * runner unchanged. The art stays compact, terminal-safe, and centered.
 */
export function RatArtHeader(): React.ReactElement {
  const [frameIndex, setFrameIndex] = useState(0);

  useEffect(() => {
    const timer = setTimeout(() => {
      setFrameIndex((idx) => (idx + 1) % FRAMES.length);
    }, FRAME_DURATIONS_MS[frameIndex] ?? 250);

    return () => clearTimeout(timer);
  }, [frameIndex]);

  const activeFrame = useMemo(() => FRAMES[frameIndex] ?? FRAMES[0], [frameIndex]);

  return (
    <Box flexDirection="column" alignItems="center" marginBottom={1}>
      <Box flexDirection="column" width={FRAME_WIDTH}>
        {activeFrame.map((line, index) => (
          <Text key={`rat-line-${index}`} color="green">
            {line}
          </Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text color="gray" dimColor>
          Replicated AI Troubleshooting
        </Text>
      </Box>
    </Box>
  );
}
