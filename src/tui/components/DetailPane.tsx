import React from 'react';
import { Box, Text } from 'ink';
import type { Finding } from '../../types/index.js';
import {
  severityColor,
  formatSeverityLabel,
  confidenceBar,
  evidenceIcon,
  extractDifferentialContext,
} from '../helpers.js';
import { Pane } from './Pane.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Props for the detail pane. */
export interface DetailPaneProps {
  /** The finding to display, or null when nothing is selected. */
  finding: Finding | null;
  /** Number of lines to skip from the top of the rendered content. */
  scrollOffset: number;
  /** When true the pane border and title render in their focused style. */
  focused: boolean;
}

// ---------------------------------------------------------------------------
// DetailPane
// ---------------------------------------------------------------------------

/**
 * Pane that renders the full detail of a selected finding inside a {@link Pane}
 * border.
 *
 * When no finding is selected a placeholder message is shown.
 *
 * When a finding is present, sections rendered top-to-bottom:
 * a. Title + severity badge + confidence
 * b. Differential diagnosis context — parsed from reasoningSummary
 * c. Full reasoning summary text
 * d. Evidence items — each with icon + file path + note
 * e. Contradictions checked — bulleted list
 * f. Missing evidence — bulleted list
 * g. Recommended action — highlighted box
 *
 * Scrolling is implemented by slicing rendered content based on scrollOffset.
 */
export function DetailPane({
  finding,
  scrollOffset,
  focused,
}: DetailPaneProps): React.ReactElement {
  if (finding === null) {
    return (
      <Pane title="Detail" focused={focused}>
        <Box marginLeft={2} marginTop={1}>
          <Text color="gray">Select a finding to view details</Text>
        </Box>
      </Pane>
    );
  }

  const color = severityColor(finding.severity);
  const label = formatSeverityLabel(finding.severity);
  const conf = confidenceBar(finding.confidence);
  const diff = extractDifferentialContext(finding.reasoningSummary);
  const runnerUpNameMatch = diff.runnerUpComparison
    ? /Preferred over runner-up\s+"([^"]+)"/.exec(diff.runnerUpComparison)
    : null;
  const runnerUpName = runnerUpNameMatch?.[1] ?? null;
  const runnerUpReason = diff.runnerUpComparison
    ? runnerUpName
      ? diff.runnerUpComparison
          .replace(`Preferred over runner-up "${runnerUpName}"`, '')
          .trim()
      : diff.runnerUpComparison
    : null;

  // Build all content lines as React elements for scrolling
  const lines: React.ReactElement[] = [];

  // ── (a) Title + severity badge + confidence ──────────────────────────────
  lines.push(
    <Box key="title" marginBottom={1}>
      <Text bold>{finding.title}</Text>
    </Box>,
  );
  lines.push(
    <Box key="meta" marginBottom={1}>
      <Text color={color} bold>
        [{label}]
      </Text>
      <Text> Confidence: </Text>
      <Text bold>{conf}</Text>
    </Box>,
  );

  // ── (b) Differential diagnosis context ───────────────────────────────────
  if (diff.rank || diff.runnerUpComparison) {
    lines.push(
      <Box key="diff-header" marginBottom={0}>
        <Text bold color="cyan">
          ── Differential Diagnosis
          {diff.rank ? ` (${diff.rank})` : ''} ──
        </Text>
      </Box>,
    );
    lines.push(
      <Box key="diff-root" marginLeft={2} marginBottom={0}>
        <Text>Root cause: </Text>
        <Text bold>{diff.rootCause}</Text>
      </Box>,
    );
    if (diff.runnerUpComparison) {
      lines.push(
        <Box
          key="diff-runnerup"
          borderStyle="single"
          borderColor="gray"
          marginLeft={2}
          marginBottom={1}
          paddingX={1}
        >
          <Text dimColor>Preferred over runner-up </Text>
          {runnerUpName ? <Text color="yellow">{runnerUpName}</Text> : null}
          <Text dimColor>
            {runnerUpReason
              ? `${runnerUpName ? ' ' : ''}${runnerUpReason}`
              : diff.runnerUpComparison}
          </Text>
        </Box>,
      );
    } else {
      lines.push(<Box key="diff-runnerup-spacer" marginBottom={1} />);
    }
  }

  // ── (c) Full reasoning summary ────────────────────────────────────────────
  lines.push(
    <Box key="reasoning-header" marginBottom={0}>
      <Text bold color="cyan">
        ── Reasoning Summary ──
      </Text>
    </Box>,
  );
  lines.push(
    <Box key="reasoning" marginLeft={2} marginBottom={1}>
      <Text wrap="wrap">{finding.reasoningSummary}</Text>
    </Box>,
  );

  // ── (d) Evidence items ────────────────────────────────────────────────────
  if (finding.evidence.length > 0) {
    lines.push(
      <Box key="evidence-header" marginBottom={0}>
        <Text bold color="cyan">
          ── Evidence ({finding.evidence.length}) ──
        </Text>
      </Box>,
    );
    for (let i = 0; i < finding.evidence.length; i++) {
      const ev = finding.evidence[i]!;
      lines.push(
        <Box key={`ev-${i}`} marginLeft={2} marginBottom={0}>
          <Text>{evidenceIcon(ev.artifactType)} </Text>
          <Text color="green">{ev.path}</Text>
          <Text color="gray"> — {ev.note}</Text>
        </Box>,
      );
    }
    lines.push(<Box key="evidence-spacer" marginBottom={1} />);
  }

  // ── (e) Contradictions checked ────────────────────────────────────────────
  if (finding.contradictionsChecked.length > 0) {
    lines.push(
      <Box key="contra-header" marginBottom={0}>
        <Text bold color="cyan">
          ── Contradictions Checked ──
        </Text>
      </Box>,
    );
    for (let i = 0; i < finding.contradictionsChecked.length; i++) {
      lines.push(
        <Box key={`contra-${i}`} marginLeft={2}>
          <Text color="gray">• {finding.contradictionsChecked[i]}</Text>
        </Box>,
      );
    }
    lines.push(<Box key="contra-spacer" marginBottom={1} />);
  }

  // ── (f) Missing evidence ──────────────────────────────────────────────────
  if (finding.missingEvidence.length > 0) {
    lines.push(
      <Box key="missing-header" marginBottom={0}>
        <Text bold color="cyan">
          ── Missing Evidence ──
        </Text>
      </Box>,
    );
    for (let i = 0; i < finding.missingEvidence.length; i++) {
      lines.push(
        <Box key={`missing-${i}`} marginLeft={2}>
          <Text color="yellow">• {finding.missingEvidence[i]}</Text>
        </Box>,
      );
    }
    lines.push(<Box key="missing-spacer" marginBottom={1} />);
  }

  // ── (g) Recommended action ────────────────────────────────────────────────
  lines.push(
    <Box
      key="action"
      borderStyle="single"
      borderColor="green"
      paddingX={1}
      marginBottom={1}
    >
      <Text>
        <Text bold color="green">
          Recommended Action:{' '}
        </Text>
        {finding.recommendedAction}
      </Text>
    </Box>,
  );

  // Apply scroll offset — clamp to the rendered content so overscrolling does
  // not blank the view, then slice from that point.
  const clampedScrollOffset = Math.min(scrollOffset, Math.max(0, lines.length - 1));
  const visibleLines = lines.slice(clampedScrollOffset);

  return (
    <Pane title="Detail" focused={focused}>
      <Box flexDirection="column" paddingX={1}>
        {visibleLines}
      </Box>
    </Pane>
  );
}
