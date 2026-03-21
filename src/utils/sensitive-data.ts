import type { Finding, FindingTreeNode } from '../types/index.js';

const SENSITIVE_VALUE_PATTERNS: ReadonlyArray<RegExp> = [
  /((?:"|')?(?:pass(?:word|wd)?|pwd|token|api[-_ ]?key|secret|client[-_ ]?secret|access[-_ ]?key|private[-_ ]?key|auth[-_ ]?token)(?:"|')?\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|`[^`\n]*`|[^\s,;]+)/gi,
  /(Authorization\s*:\s*Bearer\s+)([^\s,;]+)/gi,
  /(https?:\/\/[^\s:@/]+:)([^\s@/]+)(@)/gi,
];

function redactPreservingWrapper(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) return '"[REDACTED]"';
  if (value.startsWith("'") && value.endsWith("'")) return "'[REDACTED]'";
  if (value.startsWith('`') && value.endsWith('`')) return '`[REDACTED]`';
  return '[REDACTED]';
}

/**
 * Redacts common secret-bearing values from free-form text while preserving the
 * surrounding diagnostic context and key names.
 */
export function sanitizeSensitiveText(text: string): string {
  let sanitized = text;

  sanitized = sanitized.replace(SENSITIVE_VALUE_PATTERNS[0]!, (_match, prefix: string, value: string) => {
    return `${prefix}${redactPreservingWrapper(value)}`;
  });

  sanitized = sanitized.replace(SENSITIVE_VALUE_PATTERNS[1]!, '$1[REDACTED]');
  sanitized = sanitized.replace(SENSITIVE_VALUE_PATTERNS[2]!, '$1[REDACTED]$3');

  return sanitized;
}

export function sanitizeFinding(finding: Finding): Finding {
  return {
    ...finding,
    title: sanitizeSensitiveText(finding.title),
    reasoningSummary: sanitizeSensitiveText(finding.reasoningSummary),
    contradictionsChecked: finding.contradictionsChecked.map(sanitizeSensitiveText),
    recommendedAction: sanitizeSensitiveText(finding.recommendedAction),
    missingEvidence: finding.missingEvidence.map(sanitizeSensitiveText),
    evidence: finding.evidence.map((evidence) => ({
      ...evidence,
      note: sanitizeSensitiveText(evidence.note),
    })),
  };
}

export function sanitizeFindings(findings: ReadonlyArray<Finding>): Finding[] {
  return findings.map(sanitizeFinding);
}

export function sanitizeFindingTree(nodes: ReadonlyArray<FindingTreeNode>): FindingTreeNode[] {
  return nodes.map((node) => ({
    ...node,
    finding: sanitizeFinding(node.finding),
    children: sanitizeFindingTree(node.children),
  }));
}
