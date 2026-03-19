import type { HypothesisCategory } from './hypothesis-types.js';

// ---------------------------------------------------------------------------
// HypothesisTemplate types
// ---------------------------------------------------------------------------

/**
 * A rule describing evidence patterns that support or contradict a particular
 * hypothesis. Co-located with the template so that adding a new symptom type
 * requires no procedural code — just a new registry entry.
 */
export interface EvidenceRule {
  /** Human-readable label for this rule (used in diagnostics / traces). */
  label: string;
  /**
   * Regex pattern matched against evidence notes and finding titles.
   * Case-insensitive matching is used.
   */
  pattern: string;
  /** Whether the pattern is supporting or contradicting evidence. */
  type: 'supporting' | 'contradicting';
}

/**
 * A single hypothesis definition within a template. Pure data — no code.
 */
export interface HypothesisDefinition {
  /** Unique suffix appended to the symptom key to build the hypothesis id. */
  idSuffix: string;
  /** The root-cause category of this hypothesis. */
  category: HypothesisCategory;
  /** Human-readable root-cause description. */
  rootCause: string;
  /** Evidence rules co-located with this hypothesis. */
  evidenceRules: EvidenceRule[];
}

/**
 * A declarative hypothesis template mapping a symptom pattern to a set of
 * competing hypotheses. Each template is pure data — adding a new template
 * requires no new TypeScript code, just a new entry in
 * {@link HYPOTHESIS_TEMPLATE_REGISTRY}.
 */
export interface HypothesisTemplate {
  /** Unique identifier for this template (e.g. `'crashloop'`). */
  id: string;
  /** Human-readable name for this template. */
  name: string;
  /**
   * Regex patterns matched against the finding text corpus (title + evidence
   * + reasoning) to determine whether this template applies.
   * Case-insensitive matching is used. If **any** pattern matches, the
   * template is selected.
   */
  symptomPatterns: string[];
  /**
   * Description template for the symptom. Placeholders:
   * - `{name}` — pod/resource name
   * - `{namespace}` — Kubernetes namespace
   */
  symptomDescriptionTemplate: string;
  /**
   * Prefix used in the symptom key, e.g. `'pod-crashloop'` produces
   * `pod-crashloop:default/app-pod`.
   */
  symptomKeyPrefix: string;
  /** Competing hypothesis definitions for this symptom type. */
  hypotheses: HypothesisDefinition[];
}

// ---------------------------------------------------------------------------
// Template registry — all templates as data
// ---------------------------------------------------------------------------

/**
 * The global hypothesis template registry.
 *
 * Every entry defines one symptom type and its competing hypotheses purely as
 * data. Adding a new symptom type (e.g. `'oom-kill'`) requires **no** new
 * TypeScript code — just append a new entry to this array.
 *
 * Templates are evaluated in order; the first matching template wins.
 */
export const HYPOTHESIS_TEMPLATE_REGISTRY: readonly HypothesisTemplate[] = [
  // ── CrashLoopBackOff ────────────────────────────────────────────────────
  {
    id: 'crashloop',
    name: 'CrashLoopBackOff',
    symptomPatterns: [
      'crashloopbackoff',
      'crashloop',
      'back-off restarting failed container',
    ],
    symptomKeyPrefix: 'pod-crashloop',
    symptomDescriptionTemplate:
      "Pod '{name}' is in CrashLoopBackOff in namespace '{namespace}'",
    hypotheses: [
      {
        idSuffix: 'missing-secret',
        category: 'missing-secret',
        rootCause:
          'A required Kubernetes Secret or key is absent, causing the container to fail on startup',
        evidenceRules: [
          {
            label: 'FailedMount event referencing Secret',
            pattern: 'failedmount.*secret|secret.*not found|missing.*secret',
            type: 'supporting',
          },
          {
            label: 'Secret exists and is mounted',
            pattern: 'secret.*mounted|secret.*found|secret.*exists',
            type: 'contradicting',
          },
        ],
      },
      {
        idSuffix: 'config-error',
        category: 'config-error',
        rootCause:
          'A ConfigMap value or environment variable is misconfigured, causing the application to exit at startup',
        evidenceRules: [
          {
            label: 'ConfigMap not found or key missing',
            pattern: 'configmap.*not found|key.*missing|invalid.*config',
            type: 'supporting',
          },
          {
            label: 'ConfigMap is valid',
            pattern: 'configmap.*valid|config.*correct',
            type: 'contradicting',
          },
        ],
      },
      {
        idSuffix: 'dns-failure',
        category: 'dns-failure',
        rootCause:
          'A dependency hostname required during startup cannot be resolved, causing the application to fail and restart',
        evidenceRules: [
          {
            label: 'DNS resolution error in logs',
            pattern: 'dns.*fail|nslookup.*fail|could not resolve|name resolution',
            type: 'supporting',
          },
          {
            label: 'DNS resolution succeeds',
            pattern: 'dns.*success|resolved.*successfully',
            type: 'contradicting',
          },
        ],
      },
      {
        idSuffix: 'oom-kill',
        category: 'oom-kill',
        rootCause:
          'The container is being killed by the OOM killer because it exceeds its memory limit',
        evidenceRules: [
          {
            label: 'OOMKilled exit reason',
            pattern: 'oomkilled|oom.*kill|out of memory|exit code 137',
            type: 'supporting',
          },
          {
            label: 'Memory usage well below limit',
            pattern: 'memory.*below.*limit|memory.*within.*limit',
            type: 'contradicting',
          },
        ],
      },
      {
        idSuffix: 'generic-crash',
        category: 'generic-crash',
        rootCause:
          'The application has an unclassified bug causing it to crash immediately on startup',
        evidenceRules: [
          {
            label: 'Non-zero exit code',
            pattern: 'exit code [1-9]|exited with|fatal.*error|panic',
            type: 'supporting',
          },
        ],
      },
    ],
  },

  // ── ImagePullBackOff ────────────────────────────────────────────────────
  {
    id: 'imagepull',
    name: 'ImagePullBackOff',
    symptomPatterns: [
      'imagepullbackoff',
      'errimagepull',
      'image pull',
      'failed to pull image',
      'back-off pulling image',
    ],
    symptomKeyPrefix: 'pod-imagepull',
    symptomDescriptionTemplate:
      "Pod '{name}' cannot pull its container image in namespace '{namespace}'",
    hypotheses: [
      {
        idSuffix: 'image-pull-failure:bad-tag',
        category: 'image-pull-failure',
        rootCause:
          'The image tag does not exist in the container registry (wrong, misspelled, or deleted tag)',
        evidenceRules: [
          {
            label: 'Tag not found error',
            pattern: 'not found|manifest unknown|tag.*invalid|tag.*missing',
            type: 'supporting',
          },
          {
            label: 'Image tag verified to exist',
            pattern: 'tag.*exists|image.*found|manifest.*present',
            type: 'contradicting',
          },
        ],
      },
      {
        idSuffix: 'image-pull-failure:auth-failure',
        category: 'image-pull-failure',
        rootCause:
          'Registry authentication failure — pull credentials are invalid, expired, or have insufficient registry permissions',
        evidenceRules: [
          {
            label: 'Auth/credentials error',
            pattern: 'unauthorized|403|authentication.*fail|credentials.*invalid|pull.*secret.*missing',
            type: 'supporting',
          },
          {
            label: 'Auth succeeds',
            pattern: 'authenticated|credentials.*valid',
            type: 'contradicting',
          },
        ],
      },
      {
        idSuffix: 'image-pull-failure:registry-unavailable',
        category: 'image-pull-failure',
        rootCause:
          'The container registry is unavailable or unreachable from the cluster network',
        evidenceRules: [
          {
            label: 'Registry connectivity error',
            pattern: 'timeout|connection refused|unreachable|network.*error|registry.*down',
            type: 'supporting',
          },
          {
            label: 'Registry reachable',
            pattern: 'registry.*reachable|registry.*available',
            type: 'contradicting',
          },
        ],
      },
    ],
  },

  // ── Not Ready ───────────────────────────────────────────────────────────
  {
    id: 'not-ready',
    name: 'Not Ready',
    symptomPatterns: [
      'not ready',
      'notready',
      'readiness probe failed',
      'readiness condition is false',
    ],
    symptomKeyPrefix: 'pod-not-ready',
    symptomDescriptionTemplate:
      "Pod '{name}' is running but not ready in namespace '{namespace}'",
    hypotheses: [
      {
        idSuffix: 'connectivity-failure',
        category: 'connectivity-failure',
        rootCause:
          'A required dependency (database, cache, or external service) is unavailable, blocking readiness',
        evidenceRules: [
          {
            label: 'Connection refused or timeout to dependency',
            pattern: 'connection refused|timeout.*dependency|cannot connect|service.*unavailable',
            type: 'supporting',
          },
          {
            label: 'All dependencies reachable',
            pattern: 'dependency.*healthy|service.*reachable|connection.*established',
            type: 'contradicting',
          },
        ],
      },
      {
        idSuffix: 'dns-failure',
        category: 'dns-failure',
        rootCause:
          'DNS resolution is failing for a hostname the application depends on, preventing startup',
        evidenceRules: [
          {
            label: 'DNS resolution error',
            pattern: 'dns.*fail|nslookup.*fail|could not resolve|name resolution',
            type: 'supporting',
          },
          {
            label: 'DNS works correctly',
            pattern: 'dns.*success|resolved.*successfully',
            type: 'contradicting',
          },
        ],
      },
      {
        idSuffix: 'readiness-failure',
        category: 'readiness-failure',
        rootCause:
          'The readiness probe is misconfigured — wrong port, path, or timing parameters cause it to always fail',
        evidenceRules: [
          {
            label: 'Readiness probe failure in events',
            pattern: 'readiness.*probe.*fail|probe.*refused|probe.*timeout|unhealthy',
            type: 'supporting',
          },
          {
            label: 'Readiness probe succeeds',
            pattern: 'readiness.*pass|probe.*success|healthy',
            type: 'contradicting',
          },
        ],
      },
    ],
  },

  // ── Pending Pod ─────────────────────────────────────────────────────────
  {
    id: 'pending',
    name: 'Pending Pod',
    symptomPatterns: [
      'pending pod',
      'containercreating',
      'volume mount failure',
      'failed to mount',
      'failedmount',
      'failedscheduling',
      'provisionfailed',
      'provisioningfailed',
    ],
    symptomKeyPrefix: 'pod-pending',
    symptomDescriptionTemplate:
      "Pod '{name}' is stuck in Pending/ContainerCreating in namespace '{namespace}'",
    hypotheses: [
      {
        idSuffix: 'volume-mount-failure',
        category: 'volume-mount-failure',
        rootCause:
          'A PersistentVolumeClaim cannot be provisioned because the referenced StorageClass is missing or the storage provisioner is unavailable',
        evidenceRules: [
          {
            label: 'PVC provisioning failure',
            pattern: 'storageclass.*not found|pvc.*pending|provision.*fail|no.*persistent.*volume',
            type: 'supporting',
          },
          {
            label: 'PVC bound successfully',
            pattern: 'pvc.*bound|volume.*provisioned|storage.*available',
            type: 'contradicting',
          },
        ],
      },
      {
        idSuffix: 'missing-secret',
        category: 'missing-secret',
        rootCause:
          'A volume, Secret, or ConfigMap referenced in the pod spec is absent, preventing the container from starting',
        evidenceRules: [
          {
            label: 'Secret/ConfigMap not found',
            pattern: 'secret.*not found|configmap.*not found|missing.*secret|missing.*configmap',
            type: 'supporting',
          },
          {
            label: 'All referenced secrets exist',
            pattern: 'secret.*found|secret.*exists|configmap.*exists',
            type: 'contradicting',
          },
        ],
      },
      {
        idSuffix: 'config-error',
        category: 'config-error',
        rootCause:
          'The pod spec has a misconfigured volume reference, resource request, or node selector that prevents scheduling',
        evidenceRules: [
          {
            label: 'Scheduling failure due to config',
            pattern: 'node.*selector|insufficient.*cpu|insufficient.*memory|unschedulable|toleration',
            type: 'supporting',
          },
          {
            label: 'Pod scheduled successfully',
            pattern: 'scheduled|node.*assigned',
            type: 'contradicting',
          },
        ],
      },
    ],
  },

  // ── Generic (fallback) ──────────────────────────────────────────────────
  {
    id: 'generic',
    name: 'Generic Symptom',
    // Empty symptom patterns: this template is the catch-all fallback
    symptomPatterns: [],
    symptomKeyPrefix: 'symptom',
    symptomDescriptionTemplate: '{title}',
    hypotheses: [
      {
        idSuffix: 'generic-crash',
        category: 'generic-crash',
        rootCause:
          'The application has an unclassified bug or configuration issue causing degraded behaviour',
        evidenceRules: [
          {
            label: 'Error in application logs',
            pattern: 'error|exception|fatal|panic|crash',
            type: 'supporting',
          },
        ],
      },
      {
        idSuffix: 'config-error',
        category: 'config-error',
        rootCause:
          'A configuration value or environment variable is incorrect or missing',
        evidenceRules: [
          {
            label: 'Config-related error',
            pattern: 'config.*error|env.*missing|invalid.*value|misconfigured',
            type: 'supporting',
          },
        ],
      },
    ],
  },
] as const satisfies readonly HypothesisTemplate[];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the full template registry. This is the primary API for consumers
 * that need to enumerate or inspect all templates.
 */
export function loadTemplates(): readonly HypothesisTemplate[] {
  return HYPOTHESIS_TEMPLATE_REGISTRY;
}

/**
 * Finds the first matching template for the given finding text corpus.
 *
 * @param textCorpus - Lower-cased concatenation of finding title, reasoning,
 *   and evidence notes.
 * @returns The matching template, or the generic fallback template.
 */
export function matchTemplate(textCorpus: string): HypothesisTemplate {
  const lower = textCorpus.toLowerCase();
  for (const template of HYPOTHESIS_TEMPLATE_REGISTRY) {
    // The generic template (empty symptomPatterns) is the fallback
    if (template.symptomPatterns.length === 0) continue;
    for (const pattern of template.symptomPatterns) {
      if (lower.includes(pattern)) {
        return template;
      }
    }
  }
  // Return the generic fallback
  const generic = HYPOTHESIS_TEMPLATE_REGISTRY.find((t) => t.id === 'generic');
  // istanbul ignore next -- registry always contains 'generic'
  return generic ?? HYPOTHESIS_TEMPLATE_REGISTRY[HYPOTHESIS_TEMPLATE_REGISTRY.length - 1]!;
}

/**
 * Generates hypotheses from a template for a given symptom.
 *
 * This is the template-driven replacement for the old procedural generator
 * functions. It produces identical output to the original procedural code.
 *
 * @param template        - The matched hypothesis template.
 * @param symptomKey      - Stable symptom key (e.g. `"pod-crashloop:default/app-pod"`).
 * @param symptomDescription - Human-readable symptom description.
 * @param sourceFindings  - IDs of source findings for this symptom.
 * @returns Array of hypothesis objects, one per template hypothesis definition.
 */
export function generateHypothesesFromTemplate(
  template: HypothesisTemplate,
  symptomKey: string,
  symptomDescription: string,
  sourceFindings: string[],
): Array<{
  id: string;
  symptom: string;
  rootCause: string;
  category: HypothesisCategory;
  sourceFindings: string[];
  evidenceRules: EvidenceRule[];
}> {
  return template.hypotheses.map((def) => ({
    id: `${symptomKey}:${def.idSuffix}`,
    symptom: symptomDescription,
    rootCause: def.rootCause,
    category: def.category,
    sourceFindings,
    evidenceRules: def.evidenceRules,
  }));
}
