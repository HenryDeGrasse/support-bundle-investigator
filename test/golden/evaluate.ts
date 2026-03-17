// ---------------------------------------------------------------------------
// Golden Set Evaluator
// ---------------------------------------------------------------------------
//
// Scores pipeline results against golden expectations. Returns a structured
// report that can be serialised to JSON for nightly CI artifacts.

import type { Finding } from '../../src/types/index.js';
import type { ScenarioExpectation } from './expectations.js';

export interface EvalDetail {
  check: string;
  pass: boolean;
  detail: string;
}

export interface ScenarioEvalResult {
  scenario: string;
  pass: boolean;
  score: number;
  checks: EvalDetail[];
}

export interface EvalReport {
  timestamp: string;
  scenarios: Record<string, ScenarioEvalResult>;
  overallPass: boolean;
  overallScore: number;
}

function allFindingsText(findings: Finding[]): string {
  return findings
    .map((f) => [
      f.title,
      f.reasoningSummary,
      ...f.evidence.map((e) => `${e.path} ${e.note}`),
    ].join(' '))
    .join(' ');
}

export function evaluateScenario(
  scenarioName: string,
  expectation: ScenarioExpectation,
  findings: Finding[],
): ScenarioEvalResult {
  const checks: EvalDetail[] = [];
  const top = findings[0];

  // 1. Minimum findings count
  checks.push({
    check: 'minFindings',
    pass: findings.length >= expectation.minFindings,
    detail: `Expected >= ${expectation.minFindings}, got ${findings.length}`,
  });

  // 2. Top finding title matches
  const topTitleMatch =
    top !== undefined &&
    expectation.topFindingMustMatch.some((re) => re.test(top.title));
  checks.push({
    check: 'topFindingTitle',
    pass: topTitleMatch,
    detail: top
      ? `Top finding: "${top.title}"`
      : 'No findings produced',
  });

  // 3. Top finding severity
  const topSeverityMatch =
    top !== undefined &&
    expectation.topFindingSeverity.includes(top.severity);
  checks.push({
    check: 'topFindingSeverity',
    pass: topSeverityMatch,
    detail: top
      ? `Got "${top.severity}", expected one of [${expectation.topFindingSeverity.join(', ')}]`
      : 'No findings',
  });

  // 4. Top finding confidence
  const topConfMatch =
    top !== undefined &&
    top.confidence >= expectation.topFindingMinConfidence;
  checks.push({
    check: 'topFindingConfidence',
    pass: topConfMatch,
    detail: top
      ? `Got ${(top.confidence * 100).toFixed(0)}%, min ${(expectation.topFindingMinConfidence * 100).toFixed(0)}%`
      : 'No findings',
  });

  // 5. Evidence citation coverage
  const allPaths = findings.flatMap((f) => f.evidence.map((e) => e.path));
  for (const pattern of expectation.mustCiteEvidence) {
    const cited = allPaths.some((p) => pattern.test(p));
    checks.push({
      check: `mustCiteEvidence: ${pattern.source}`,
      pass: cited,
      detail: cited ? 'Found matching evidence path' : `No evidence path matches /${pattern.source}/`,
    });
  }

  // 6. No hallucinations
  const fullText = allFindingsText(findings);
  for (const pattern of expectation.mustNotHallucinate) {
    const found = pattern.test(fullText);
    checks.push({
      check: `mustNotHallucinate: ${pattern.source}`,
      pass: !found,
      detail: found
        ? `HALLUCINATION DETECTED: /${pattern.source}/ found in findings text`
        : 'Clean — pattern not found',
    });
  }

  // 7. Root cause match
  const rootCauseText = top?.reasoningSummary ?? '';
  const rootCauseMatch = expectation.rootCauseMustMatch.some((re) =>
    re.test(rootCauseText),
  );
  checks.push({
    check: 'rootCauseMatch',
    pass: rootCauseMatch,
    detail: rootCauseMatch
      ? 'Root cause reasoning matches expected pattern'
      : `Root cause "${rootCauseText.slice(0, 100)}" did not match any expected pattern`,
  });

  // 8. Required identifiers
  for (const id of expectation.mustMentionIdentifiers) {
    const mentioned = fullText.toLowerCase().includes(id.toLowerCase());
    checks.push({
      check: `mustMention: ${id}`,
      pass: mentioned,
      detail: mentioned ? `Found "${id}"` : `"${id}" not found in any finding`,
    });
  }

  const passCount = checks.filter((c) => c.pass).length;
  const score = checks.length > 0 ? passCount / checks.length : 0;

  return {
    scenario: scenarioName,
    pass: checks.every((c) => c.pass),
    score,
    checks,
  };
}

export function buildEvalReport(
  results: Record<string, ScenarioEvalResult>,
): EvalReport {
  const scenarios = results;
  const allResults = Object.values(scenarios);
  const overallPass = allResults.every((r) => r.pass);
  const overallScore =
    allResults.length > 0
      ? allResults.reduce((sum, r) => sum + r.score, 0) / allResults.length
      : 0;

  return {
    timestamp: new Date().toISOString(),
    scenarios,
    overallPass,
    overallScore,
  };
}
