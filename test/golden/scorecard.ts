import type { EvalReport, ScenarioEvalResult } from './evaluate.js';

function escapeMarkdownCell(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n|\r/g, ' ')
    .trim();
}

function formatPass(pass: boolean): string {
  return pass ? 'PASS' : 'FAIL';
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatConfidence(value: number): string {
  return value > 0 ? `${value.toFixed(2)}` : 'n/a';
}

function formatMode(mode: ScenarioEvalResult['mode']): string {
  return mode === 'ai' ? 'AI' : 'Heuristic';
}

function buildSummary(report: EvalReport) {
  const scenarioEntries = Object.entries(report.scenarios)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([scenario, result]) => ({
      scenario,
      displayName: result.displayName,
      pass: result.pass,
      score: result.score,
      topFinding: result.topFinding,
      expectedPattern: result.expectedPattern,
      confidence: result.confidence,
      evidenceCount: result.evidenceCount,
      mode: result.mode,
      checksPassed: result.checks.filter((check) => check.pass).length,
      checksTotal: result.checks.length,
    }));

  return {
    timestamp: report.timestamp,
    overallPass: report.overallPass,
    overallScore: report.overallScore,
    scenarioCount: scenarioEntries.length,
    passedScenarioCount: scenarioEntries.filter((entry) => entry.pass).length,
    failedScenarioCount: scenarioEntries.filter((entry) => !entry.pass).length,
    scenarios: scenarioEntries,
  };
}

export function generateScorecard(report: EvalReport): string {
  const summary = buildSummary(report);
  const lines: string[] = [
    '# Golden Eval Scorecard',
    '',
    `Generated: ${summary.timestamp}`,
    '',
    `Overall Pass: ${summary.overallPass ? 'YES' : 'NO'}`,
    `Overall Score: ${formatPercent(summary.overallScore)}`,
    `Scenario Count: ${summary.scenarioCount}`,
    '',
    '| Scenario | Pass/Fail | Score% | Top Finding | Expected Pattern | Confidence | Evidence Count | Heuristic/AI |',
    '| --- | --- | ---: | --- | --- | ---: | ---: | --- |',
  ];

  for (const entry of summary.scenarios) {
    lines.push(
      `| ${escapeMarkdownCell(entry.scenario)} | ${formatPass(entry.pass)} | ${formatPercent(entry.score)} | ${escapeMarkdownCell(entry.topFinding)} | ${escapeMarkdownCell(entry.expectedPattern)} | ${formatConfidence(entry.confidence)} | ${entry.evidenceCount} | ${formatMode(entry.mode)} |`,
    );
  }

  lines.push('', '## JSON Summary', '', '```json', JSON.stringify(summary, null, 2), '```');

  return lines.join('\n');
}
