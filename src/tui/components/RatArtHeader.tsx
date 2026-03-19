import React from 'react';
import { Box, Text } from 'ink';

// ---------------------------------------------------------------------------
// RatArtHeader
// ---------------------------------------------------------------------------

/**
 * ASCII art header for the RAT (Replicated AI Troubleshooting) loading screen.
 *
 * Renders block-letter "RAT" above a detailed rat face:
 *
 *      _ __       _      _____
 *     |  _ \    / \   |_   _|
 *     | |_) |  / _ \    | |
 *     |  _ <  / ___ \   | |
 *     |_| \_\/_/   \_\  |_|
 *
 *           (\,/)
 *           oo   '''//,        _
 *         ,/_;~,        \,    / '
 *         "'   \    (    \    !
 *               ',|  \   |__.'
 *               '~  '~----''
 *
 *   Replicated AI Troubleshooting
 *
 * The inner Box has no alignItems override so all lines stay left-aligned
 * relative to each other; the parent's alignItems="center" centers the whole
 * block horizontally on screen.
 */
export function RatArtHeader(): React.ReactElement {
  return (
    <Box flexDirection="column" alignItems="center" marginBottom={1}>
      {/* All art lines in a left-aligned column so they render as a unit */}
      <Box flexDirection="column">
        {/* Block letters */}
        <Text color="cyan">{`     _ __       _      _____`}</Text>
        <Text color="cyan">{`    |  _ \\    / \\   |_   _|`}</Text>
        <Text color="cyan">{`    | |_) |  / _ \\    | |  `}</Text>
        <Text color="cyan">{`    |  _ <  / ___ \\   | |  `}</Text>
        <Text color="cyan">{`    |_| \\_\\/_/   \\_\\  |_|  `}</Text>
        {/* Spacer */}
        <Text>{' '}</Text>
        {/* Rat face */}
        <Text color="green">{`          (\\,/)`}</Text>
        <Text color="green">{`          oo   '''//,        _`}</Text>
        <Text color="green">{`        ,/_;~,        \\,    / '`}</Text>
        <Text color="green">{`        "'   \\    (    \\    !`}</Text>
        <Text color="green">{`              ',|  \\   |__.'`}</Text>
        <Text color="green">{`              '~  '~----''`}</Text>
      </Box>
      {/* Tagline below the art block */}
      <Box marginTop={1}>
        <Text color="gray" dimColor>
          Replicated AI Troubleshooting
        </Text>
      </Box>
    </Box>
  );
}
