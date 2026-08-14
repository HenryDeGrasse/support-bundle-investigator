// ---------------------------------------------------------------------------
// Investigation prompts and category-specific playbooks
// ---------------------------------------------------------------------------
//
// Provides:
//   BASE_SYSTEM_PROMPT   — Establishes the LLM's role and grounding rules.
//   buildInvestigationPrompt — Constructs system + user prompts for a seed,
//                              selecting a category-specific playbook.
//
// Grounding constraint (mandatory in every investigation call):
//   Every claim must cite a path from the provided chunks. If evidence is
//   insufficient, populate missingEvidence — never speculate.

import type { InvestigationSeed } from '../investigators/types.js';
import type { IndexedChunk } from './chunk-indexer.js';
import { sanitizeSensitiveText } from '../utils/sensitive-data.js';

// ---------------------------------------------------------------------------
// Playbook category
// ---------------------------------------------------------------------------

/**
 * Internal playbook category resolved from a seed's category + hypothesis.
 *
 * `kubernetes` seeds are further split into `crashloop` vs `image-pull` by
 * inspecting the hypothesis text for image-pull keywords.
 */
export type PlaybookCategory =
  | 'crashloop'
  | 'image-pull'
  | 'connectivity'
  | 'configuration'
  | 'log';

// ---------------------------------------------------------------------------
// BASE_SYSTEM_PROMPT
// ---------------------------------------------------------------------------

/**
 * System prompt establishing the LLM's role as a senior Kubernetes support
 * engineer with explicit grounding constraints.
 *
 * Every investigation call combines this with a category-specific playbook.
 */
export const BASE_SYSTEM_PROMPT = `You are a senior Kubernetes support engineer specializing in troubleshooting production incidents.

Your task is to analyze provided evidence from a Kubernetes support bundle and produce structured JSON findings.

## Grounding Rules (MANDATORY)

1. You MUST only cite evidence from the provided context chunks. Do not use external knowledge to make claims about specific configuration values, pod states, or error messages that are not in the provided chunks.
2. Every finding MUST include at least one evidence entry with the exact source path from the provided context. Every claim in your reasoningSummary MUST be supported by that evidence.
3. If the provided context is insufficient to explain a finding, list what specific evidence is missing in the missingEvidence array instead of speculating.
4. Do NOT invent file paths, error messages, configuration values, or resource names that do not appear in the provided chunks.
5. Your confidence score must reflect the strength of the evidence you found in the provided chunks. Low or absent evidence requires low confidence and populated missingEvidence.
6. If you cannot find sufficient evidence for a meaningful finding, return an empty findings array rather than a speculative finding.

## Output Format

Return a JSON object with a "findings" array. Each finding must have all required fields as described in the user message schema.`;

// ---------------------------------------------------------------------------
// Category-specific playbooks
// ---------------------------------------------------------------------------

const CRASHLOOP_PLAYBOOK = `
## Investigation Playbook: CrashLoopBackOff

Focus your investigation on:
1. **Container exit reasons** — Look for exit code and reason in pod status (containerStatuses[].state.terminated.reason or waiting.reason)
2. **Container logs** — Search for FATAL, ERROR, or panic messages that explain why the container exits immediately
3. **Referenced secrets and configmaps** — Check if required Secrets/ConfigMaps are present and have the expected keys
4. **Volume mounts** — Look for FailedMount events indicating missing volumes, secrets, or configmaps
5. **Events** — Search for BackOff, FailedMount, Killing, and OOMKilled events for the affected pod
6. **Resource limits** — Check if OOMKilled reason indicates memory limit issues

Key correlations to make:
- Pod status CrashLoopBackOff → container log error messages → missing config/secret
- FailedMount event → missing Secret/ConfigMap reference in pod spec → secret/configmap existence
- OOMKilled reason → pod resource limits → application memory usage
- High restart count → application startup failure pattern`;

const IMAGE_PULL_PLAYBOOK = `
## Investigation Playbook: ImagePullBackOff / ErrImagePull

Focus your investigation on:
1. **Image tag accuracy** — Verify the exact image tag in the pod spec; look for typos or non-existent tags
2. **Registry accessibility** — Look for network errors in pull events (connection refused, dial timeout, TLS errors)
3. **Pull secrets** — Check if imagePullSecrets are configured and reference a valid Secret of type kubernetes.io/dockerconfigjson
4. **ErrImagePull events** — Look for specific error messages in events (registry not found, unauthorized, manifest unknown)
5. **Image name typos** — Common issue: verify the image name character by character

Key correlations to make:
- Pod ImagePullBackOff → ErrImagePull events → specific error message
- Missing imagePullSecret → private registry access failure
- Image tag not found → deployment spec image field shows invalid tag`;

const CONNECTIVITY_PLAYBOOK = `
## Investigation Playbook: DNS / Connectivity Failures

Focus your investigation on:
1. **DNS resolution** — Look for "no such host", "NXDOMAIN", "dial: lookup" errors in application logs
2. **Service endpoints** — Check if Services have active Endpoints; empty endpoints indicate no matching pods
3. **Network policies** — Look for NetworkPolicy resources that might block traffic between pods
4. **CoreDNS logs** — Search for DNS query failures, SERVFAIL, or timeout patterns
5. **Connection refused / timeout** — Distinguish between DNS failure (lookup fails) and connection failure (service unreachable after resolution)
6. **Service name format** — Verify the service name format matches DNS expectations (service.namespace.svc.cluster.local)

Key correlations to make:
- Application log DNS error → Service resource → Endpoints object → backing pod health
- Network policy → pod selector → affected pods
- CoreDNS error → upstream DNS configuration → cluster DNS settings`;

const CONFIGURATION_PLAYBOOK = `
## Investigation Playbook: Configuration Errors

Focus your investigation on:
1. **ConfigMap values** — Look for typos, wrong values, or mismatched keys in ConfigMap data fields
2. **Secret references** — Verify that secrets referenced by pods actually exist and have the expected keys
3. **Environment variable references** — Check envFrom and env.valueFrom references are valid and point to existing resources
4. **Mount paths** — Verify volume mount paths match what the application expects
5. **Common typos** — Check for swapped characters, extra spaces, wrong case in configuration values (e.g., "amdin" vs "admin")
6. **Key mismatches** — Pod references key "DB_USER" but secret only has "db_user" (case sensitivity issues)

Key correlations to make:
- Pod env reference → Secret/ConfigMap name → actual secret/configmap data keys
- Application log auth error → ConfigMap value typo → specific key in configmap
- FailedMount event → missing volume source → absent Secret or ConfigMap`;

const LOG_PLAYBOOK = `
## Investigation Playbook: Log-Driven Investigation

Focus your investigation on:
1. **Error patterns** — Look for FATAL, ERROR, CRITICAL, panic, exception, or stack trace patterns in log content
2. **Timestamps** — Correlate error timestamps with Kubernetes events (pod restarts, backoff events, evictions)
3. **Connection errors** — Look for database connection failures, HTTP 5xx errors, timeout patterns
4. **Authentication failures** — Look for "authentication failed", "unauthorized", "permission denied", "access denied"
5. **Startup sequence** — Trace the initialization log sequence to find where it fails
6. **Pod lifecycle correlation** — Match log timestamps with pod creation/restart events

Key correlations to make:
- Log error message → corresponding Kubernetes event reason
- Log timestamp → pod restart timestamp → number of restarts
- Authentication error → ConfigMap/Secret value → potential typo or wrong value
- Connection refused → Service/Endpoint availability → pod health`;

const PLAYBOOKS: Record<PlaybookCategory, string> = {
  crashloop: CRASHLOOP_PLAYBOOK,
  'image-pull': IMAGE_PULL_PLAYBOOK,
  connectivity: CONNECTIVITY_PLAYBOOK,
  configuration: CONFIGURATION_PLAYBOOK,
  log: LOG_PLAYBOOK,
};

// ---------------------------------------------------------------------------
// Playbook category resolution
// ---------------------------------------------------------------------------

/**
 * Resolves the investigation playbook category from a seed.
 *
 * - `log` → `log`
 * - `configuration` → `configuration`
 * - `connectivity` → `connectivity`
 * - `kubernetes` with image-pull keywords → `image-pull`
 * - `kubernetes` otherwise → `crashloop` (most common K8s failure pattern)
 */
export function resolvePlaybookCategory(seed: InvestigationSeed): PlaybookCategory {
  if (seed.category === 'log') return 'log';
  if (seed.category === 'configuration') return 'configuration';
  if (seed.category === 'connectivity') return 'connectivity';

  // For 'kubernetes' category, inspect the hypothesis to distinguish crashloop
  // from image-pull failures.
  const lower = seed.hypothesis.toLowerCase();
  if (
    lower.includes('imagepull') ||
    lower.includes('errimage') ||
    lower.includes('image pull')
  ) {
    return 'image-pull';
  }

  return 'crashloop';
}

// ---------------------------------------------------------------------------
// JSON output schema (embedded in the user prompt)
// ---------------------------------------------------------------------------

const FINDING_JSON_SCHEMA = `{
  "findings": [
    {
      "title": "Brief descriptive title of the finding",
      "severity": "critical | high | medium | low | info",
      "confidence": 0.85,
      "affectedComponents": ["Pod/namespace/name", "Container/container-name"],
      "reasoningSummary": "Detailed explanation grounded in the evidence. Must cite specific details from the provided chunks.",
      "evidence": [
        {
          "path": "exact/path/from/provided/chunks",
          "note": "Specific detail found at this path that supports the finding",
          "lineRange": [42, 47]
        }
      ],
      "contradictionsChecked": [
        "Description of a potential contradiction that was checked and found to be absent or resolved"
      ],
      "recommendedAction": "Specific actionable steps to resolve this finding",
      "missingEvidence": [
        "Description of evidence that would strengthen this finding but is not in the provided context"
      ],
      "rootCauseClass": "Optional: crashloop | image-pull | missing-secret | config-typo | dns-failure | oom | connection-refused",
      "counterevidence": ["Optional: any evidence that partially contradicts this finding"]
    }
  ]
}`;

// ---------------------------------------------------------------------------
// Chunk formatter
// ---------------------------------------------------------------------------

const MAX_STRUCTURED_EVIDENCE_CHARS = 12_000;

function isSensitiveFieldName(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (normalized === 'secret' || normalized === 'secrets') return true;
  return [
    'password',
    'passwd',
    'pwd',
    'token',
    'tokens',
    'jwt',
    'apikey',
    'apikeys',
    'clientsecret',
    'clientsecrets',
    'secretkey',
    'secretkeys',
    'credential',
    'credentials',
    'accesskey',
    'privatekey',
    'authorization',
    'authtoken',
    'databaseurl',
    'connectionstring',
    'connectionurl',
  ].some((name) => normalized === name || normalized.endsWith(name));
}

function redactStructuredValue(value: unknown, secretData = false): unknown {
  if (Array.isArray(value)) {
    return value.map((entry, index) => {
      const precedingArgument = value[index - 1];
      if (
        typeof precedingArgument === 'string' &&
        isSensitiveFieldName(precedingArgument.replace(/^--?/, ''))
      ) {
        return '[REDACTED]';
      }
      return redactStructuredValue(entry, secretData);
    });
  }

  if (typeof value !== 'object' || value === null) {
    if (secretData) return '[REDACTED]';
    return typeof value === 'string' ? sanitizeSensitiveText(value) : value;
  }

  const record = value as Record<string, unknown>;
  const isSecretResource = record['kind'] === 'Secret';
  const namedValueIsSensitive =
    typeof record['name'] === 'string' && isSensitiveFieldName(record['name']);
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => {
      const isSecretData = isSecretResource && (key === 'data' || key === 'stringData');
      if (key === 'value' && namedValueIsSensitive) return [key, '[REDACTED]'];
      if (isSensitiveFieldName(key)) return [key, '[REDACTED]'];
      return [key, redactStructuredValue(entry, secretData || isSecretData)];
    }),
  );
}

/**
 * Returns bounded, field-level Kubernetes evidence for the LLM. Resource
 * chunks use a compact summary for retrieval, while the raw object retained in
 * metadata contains fields such as selectors, ports, probes, and status that
 * can be decisive during diagnosis. Secret payloads and sensitive fields are
 * removed before this representation crosses the AI boundary.
 */
function formatStructuredEvidence(chunk: IndexedChunk): string | undefined {
  const rawContent = chunk.metadata?.['rawContent'];
  if (typeof rawContent !== 'string' || rawContent.trim().length === 0) return undefined;

  try {
    const redacted = redactStructuredValue(JSON.parse(rawContent));
    const serialized = sanitizeSensitiveText(JSON.stringify(redacted, null, 2));
    if (serialized.length <= MAX_STRUCTURED_EVIDENCE_CHARS) return serialized;
    return `${serialized.slice(0, MAX_STRUCTURED_EVIDENCE_CHARS)}\n... [structured evidence truncated]`;
  } catch {
    // rawContent is expected to be JSON for Kubernetes resources. If a custom
    // caller supplies something else, retain a safely scrubbed, bounded excerpt.
    const sanitized = sanitizeSensitiveText(rawContent);
    if (sanitized.length <= MAX_STRUCTURED_EVIDENCE_CHARS) return sanitized;
    return `${sanitized.slice(0, MAX_STRUCTURED_EVIDENCE_CHARS)}\n... [structured evidence truncated]`;
  }
}

/**
 * Formats a single {@link IndexedChunk} for inclusion in the LLM user prompt.
 *
 * Each chunk is rendered with:
 * - Source path (citeable)
 * - Artifact category and line range (for citation metadata)
 * - Chunk ID
 * - Human-readable summary
 * - Full content fenced with triple backticks
 */
function formatChunk(chunk: IndexedChunk, index: number): string {
  const lineRange = `lines ${chunk.startLine}–${chunk.endLine}`;
  const category = chunk.artifactCategory;
  const structuredEvidence = formatStructuredEvidence(chunk);

  return [
    `### Chunk ${index + 1}`,
    `Source: ${chunk.artifactId} (${category}, ${lineRange})`,
    `Chunk ID: ${chunk.id}`,
    `Summary: ${sanitizeSensitiveText(chunk.summary)}`,
    '',
    '```',
    sanitizeSensitiveText(chunk.content),
    '```',
    ...(structuredEvidence === undefined
      ? []
      : ['', 'Structured resource evidence (sensitive values redacted):', '```json', structuredEvidence, '```']),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// SEED_CLUSTERING_SYSTEM_PROMPT
// ---------------------------------------------------------------------------

/**
 * System prompt for the pre-investigation seed-clustering LLM call.
 *
 * Role: senior Kubernetes SRE performing initial triage.
 * Task: group provided investigation seeds by likely shared root cause so that
 *       downstream investigators receive one representative lead per problem
 *       area rather than redundant overlapping leads.
 *
 * Grounding constraint: every grouping decision must cite seed IDs from the
 * provided list.  Do not invent symptom descriptions or resource names.
 */
export const SEED_CLUSTERING_SYSTEM_PROMPT = `You are a senior Kubernetes site-reliability engineer performing initial triage on a Kubernetes support bundle.

Your task is to group the provided investigation seeds by their most likely shared root cause.

## Grounding Rules (MANDATORY)

1. Every cluster you produce MUST reference seed IDs that appear in the provided seed list. Do not invent seed IDs, resource names, or symptom descriptions.
2. Every seed ID in the input MUST appear in exactly one cluster in your output. Do not drop or duplicate seeds.
3. Singletons are allowed — if a seed has no natural grouping partner, place it in its own single-member cluster.
4. Group by likely shared ROOT CAUSE, not just by similar category or namespace. Two CrashLoopBackOff events in different namespaces caused by different issues should be separate clusters.
5. The \`representativeSeedId\` MUST be the ID of the highest-priority member seed (highest numeric priority value).
6. Your \`reasoning\` field must explain specifically why the grouped seeds share a root cause, citing the seed IDs and their hypotheses.
7. Return only valid JSON matching the required output schema. Do not add commentary outside the JSON.

## Output Schema

Return a JSON object with a "clusters" array. Each cluster must have all required fields as described in the user message.`;

// ---------------------------------------------------------------------------
// Seed clustering JSON output schema
// ---------------------------------------------------------------------------

const CLUSTERING_JSON_SCHEMA = `{
  "clusters": [
    {
      "label": "Human-readable shared root-cause label (e.g. 'CrashLoopBackOff caused by missing Secret db-credentials')",
      "reasoning": "Explanation of why these seeds share a root cause, citing their IDs and hypothesis text",
      "seedIds": ["seed:pod:0", "seed:event:3"],
      "representativeSeedId": "seed:pod:0"
    }
  ]
}`;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Builds the system and user prompts for the pre-investigation seed-clustering
 * LLM call.
 *
 * **System prompt** = {@link SEED_CLUSTERING_SYSTEM_PROMPT} (static grounding
 * rules, no seed data).
 *
 * **User prompt** contains:
 * 1. The serialised seed list — each seed rendered as
 *    `{ id, hypothesis, source, category, priority }`.
 * 2. The required JSON output schema for the clustering response.
 * 3. Explicit rules summarising the grounding and partitioning constraints.
 *
 * @param seeds - Raw deterministic seeds from `generateSeeds()`.
 * @returns `{ system, user }` prompts ready for a single LLM call.
 */
export function buildSeedClusteringPrompt(seeds: InvestigationSeed[]): {
  system: string;
  user: string;
} {
  const serialisedSeeds = seeds.map((s) => ({
    id: s.id,
    hypothesis: sanitizeSensitiveText(s.hypothesis),
    source: sanitizeSensitiveText(s.source),
    category: s.category,
    priority: s.priority,
  }));

  const user = [
    '## Investigation Seeds to Cluster',
    '',
    `The following ${seeds.length} seed(s) were generated from deterministic analysis of a Kubernetes support bundle.`,
    'Group them by likely shared root cause.',
    '',
    '```json',
    JSON.stringify(serialisedSeeds, null, 2),
    '```',
    '',
    '## Required JSON Output Schema',
    '',
    'Return a JSON object matching this schema exactly:',
    CLUSTERING_JSON_SCHEMA,
    '',
    '## Rules',
    '',
    `- Every seed ID listed above MUST appear in exactly one cluster's seedIds array.`,
    '- Seeds with no natural grouping partner MUST form a singleton cluster (seedIds with one element).',
    '- representativeSeedId MUST be the ID of the member with the highest priority value.',
    '- Group by likely shared root cause, not merely by category or namespace similarity.',
    '- Do not invent seed IDs, resource names, or symptom descriptions not present in the seed list above.',
    '- Return only valid JSON. Do not add prose outside the JSON object.',
  ].join('\n');

  return { system: SEED_CLUSTERING_SYSTEM_PROMPT, user };
}

/**
 * Builds the system and user prompts for a single AI investigation call.
 *
 * **System prompt** = `BASE_SYSTEM_PROMPT` + category-specific playbook.
 *
 * **User prompt** contains:
 * 1. The seed hypothesis and metadata.
 * 2. All provided chunks, each formatted with source path, line range,
 *    chunk ID, summary, and fenced content.
 * 3. The required JSON output schema.
 * 4. A grounding reminder citing only provided source paths.
 *
 * @param seed   - The investigation seed driving this call.
 * @param chunks - Chunks retrieved for this seed (graph + lexical + semantic).
 */
export function buildInvestigationPrompt(
  seed: InvestigationSeed,
  chunks: IndexedChunk[],
): { system: string; user: string } {
  const playbookCategory = resolvePlaybookCategory(seed);
  const playbook = PLAYBOOKS[playbookCategory];

  const system = `${BASE_SYSTEM_PROMPT}\n${playbook}`;

  const chunkSection =
    chunks.length > 0
      ? `## Evidence Chunks (${chunks.length} total)\n\n${chunks.map(formatChunk).join('\n\n')}`
      : '## Evidence Chunks\n\n(No chunks provided — populate missingEvidence accordingly)';

  // Collect all source paths for the grounding reminder
  const sourcePaths = chunks.map((c) => `- ${c.artifactId}`).join('\n');
  const groundingReminder =
    chunks.length > 0
      ? `REMINDER: Only cite paths that appear in the "Source:" lines above:\n${sourcePaths}\n\nDo not invent paths, values, or error messages not present in the chunks.`
      : `REMINDER: No chunks were provided. Return an empty findings array or use missingEvidence to describe what would be needed.`;

  const user = [
    '## Investigation Hypothesis',
    '',
    sanitizeSensitiveText(seed.hypothesis),
    '',
    `Category: ${seed.category} (playbook: ${playbookCategory})`,
    `Seed ID: ${seed.id}`,
    `Priority: ${seed.priority}`,
    '',
    chunkSection,
    '',
    '## Required JSON Output Schema',
    '',
    'Return a JSON object matching this schema exactly:',
    FINDING_JSON_SCHEMA,
    '',
    groundingReminder,
  ].join('\n');

  return { system, user };
}
