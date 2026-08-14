import type { Finding, FindingTreeNode } from '../types/index.js';

const SENSITIVE_VALUE_PATTERNS: ReadonlyArray<RegExp> = [
  /((?:"|')?(?:pass(?:word|wd)?|pwd|token|jwt|api[-_ ]?key|secret|credential|client[-_ ]?secret|access[-_ ]?key|private[-_ ]?key|auth[-_ ]?token|database[-_ ]?url|connection[-_ ]?(?:string|url))(?:"|')?\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|`[^`\n]*`|[^\s,;]+)/gi,
  /(Authorization\s*:\s*(?:Bearer|Basic|Token)\s+)([^\s,;]+)/gi,
  /([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)([^\s@/]+)(@)/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|AIza[0-9A-Za-z_-]{35}|npm_[A-Za-z0-9]{36}|(?:AKIA|ASIA)[0-9A-Z]{16}|sk_live_[A-Za-z0-9]{16,})\b/g,
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g,
  /-----BEGIN PGP PRIVATE KEY BLOCK-----[\s\S]*?-----END PGP PRIVATE KEY BLOCK-----/g,
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
  sanitized = sanitized.replace(SENSITIVE_VALUE_PATTERNS[3]!, '[REDACTED]');
  sanitized = sanitized.replace(SENSITIVE_VALUE_PATTERNS[4]!, '[REDACTED]');
  sanitized = sanitized.replace(SENSITIVE_VALUE_PATTERNS[5]!, '[REDACTED PRIVATE KEY]');
  sanitized = sanitized.replace(SENSITIVE_VALUE_PATTERNS[6]!, '[REDACTED PRIVATE KEY]');

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
