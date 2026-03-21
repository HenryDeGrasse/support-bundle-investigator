import type { Finding, FindingSeverity, GraphEdge, Evidence, FindingTreeNode } from '../types/index.js';
import type { InvestigatorContext, InvestigationSeed, ClusteredSeed } from './types.js';
import { buildFindingTree } from '../graph/finding-tree.js';
import { generateSeeds } from './seed-generator.js';
import { clusterSeeds, toUnclusteredSeeds } from './seed-clusterer.js';
import { investigateKubernetes } from './kubernetes-investigator.js';
import { investigateLog } from './log-investigator.js';
import { investigateConfig } from './config-investigator.js';
import { investigateServices } from './service-investigator.js';
import { investigateNetworkPolicies } from './network-policy-investigator.js';
import { verifyFindings, computeConfidenceQuality } from './verifier.js';
import { investigateWithAI } from './ai-investigator.js';
import type { AIInvestigatorDeps } from './ai-investigator.js';
import { generateAllHypotheses, correlateAcrossSymptoms } from './hypothesis-generator.js';
import { collectEvidenceForHypothesis } from './hypothesis-evidence-collector.js';
import { rankHypotheses, identifySpecGaps } from './hypothesis-ranker.js';
import { convertHypothesisSetsToFindings } from './hypothesis-converter.js';
import { matchCausalTemplate } from '../graph/causal-templates.js';
import type { CausalTemplateInstance } from '../graph/causal-templates.js';
import type { K8sEvent } from '../types/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The result produced by a full orchestrated investigation run.
 *
 * - `findings`        — verified, deduplicated, severity-sorted findings
 * - `edges`           — all graph edges produced by every targeted investigator
 * - `findingTree`     — causal tree built from findings + 'causes' edges
 * - `seeds`           — original pre-clustering seeds (full audit trail)
 * - `clusteredSeeds`  — post-clustering seeds fed to the AI investigator
 * - `metadata`        — counters for seeds, raw vs. final findings
 */
export interface InvestigationResult {
  findings: Finding[];
  edges: GraphEdge[];
  /** Causal tree built from `findings` and `edges` using {@link buildFindingTree}. */
  findingTree: FindingTreeNode[];
  /**
   * Original pre-clustering seeds produced by `generateSeeds()`.
   * Retained for full audit trail — shows every raw signal detected.
   */
  seeds: InvestigationSeed[];
  /**
   * Post-clustering seeds fed to the AI investigator.
   * Each `ClusteredSeed` carries a `memberSeeds` list for traceability.
   * When clustering is disabled or below the threshold, each entry is a
   * singleton wrapper around a single original seed.
   */
  clusteredSeeds: ClusteredSeed[];
  metadata: {
    /** Total number of seeds generated before investigation. */
    seedCount: number;
    /** Total raw findings before verification and deduplication. */
    rawFindingCount: number;
    /** Total findings remaining after verification and deduplication. */
    finalFindingCount: number;
    /** Whether AI investigation was active during this run. */
    aiEnabled: boolean;
    /** Number of findings contributed by the AI investigator. */
    aiFindings: number;
    /** Total number of hypotheses generated across all symptom sets. */
    hypothesesGenerated: number;
    /** Number of hypotheses that received a confidence score > 0 after evidence collection. */
    hypothesesVerified: number;
    /**
     * Number of symptom findings matched by causal template analysis.
     * These findings were excluded from the hypothesis generator and handled
     * via graph traversal (the graph-driven investigation path).
     */
    graphMatchedSymptoms: number;
    /**
     * Number of cluster representatives after seed clustering.
     * Equals `clusteredSeeds.length`.  When clustering is disabled or
     * below the threshold this equals `seedCount`.
     */
    seedClusterCount: number;
    /**
     * Whether AI seed clustering was attempted and succeeded.
     * `false` when AI is disabled, seed count is below the threshold,
     * or the LLM call / response validation failed (graceful degradation).
     */
    seedClusteringEnabled: boolean;
  };
}

// ---------------------------------------------------------------------------
// Severity sort order  (higher number = higher priority in sorted output)
// ---------------------------------------------------------------------------

const SEVERITY_ORDER: Record<FindingSeverity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
};

function buildHypothesisSupportEdges(findings: Finding[]): GraphEdge[] {
  const edges: GraphEdge[] = [];

  for (const finding of findings) {
    for (let i = 0; i < finding.evidence.length; i++) {
      const evidence = finding.evidence[i]!;
      edges.push({
        id: `edge:hypothesis-support:${finding.id}:${i}`,
        source: `evidence:${evidence.path}`,
        target: finding.id,
        type: 'supports',
        weight: finding.confidence,
        note: 'Structured hypothesis evidence supports this differential-diagnosis candidate',
      });
    }
  }

  return edges;
}

// ---------------------------------------------------------------------------
// Pass 1: Component-based merge (structural)
// ---------------------------------------------------------------------------
//
// Contract: one normalization strategy (primaryComponent + issueFamily key)
// and one merge strategy (AI > hypothesis > heuristic priority, with evidence
// absorbed from non-winning findings).
//
// This pass replaces three previously-separate steps that all performed
// overlapping component/family matching:
//   (a) hypothesis category dedup within the hypothesis layer
//   (b) AI-primary promotion (AI absorbs heuristic for same component)
//   (c) mergeHypothesisFindings (hypothesis replaces heuristic for same family+component)

/**
 * Returns the issue family string for a finding.
 *
 * This is the **single normalization strategy** for Pass 1. Hypothesis findings
 * declare their family via their ID. All other findings are classified from
 * their title using a precedence-ordered pattern list.
 */
function normalizeIssueFamilyForPass1(finding: Finding): string {
  // Hypothesis findings declare their family in their ID structure.
  if (finding.id.startsWith('finding:hypothesis:')) {
    return finding.id.split(':')[2] ?? 'unknown';
  }

  const lower = finding.title.toLowerCase();

  // Missing secret: "secret" + absence indicator
  if (
    lower.includes('secret') &&
    (lower.includes('missing') ||
      lower.includes('not found') ||
      lower.includes('absent') ||
      lower.includes('does not exist') ||
      lower.includes('required'))
  ) {
    return 'missing-secret';
  }
  // DNS / name resolution failures
  if (
    lower.includes('dns') ||
    lower.includes('no such host') ||
    lower.includes('resolution fail')
  ) {
    return 'dns-failure';
  }
  // Image pull failures (check before generic "image" matches)
  if (
    lower.includes('imagepullbackoff') ||
    lower.includes('errimagepull') ||
    lower.includes('image pull') ||
    lower.includes('pull image') ||
    lower.includes('failed to pull')
  ) {
    return 'image-pull-failure';
  }
  // CrashLoopBackOff
  if (
    lower.includes('crashloopbackoff') ||
    lower.includes('crashloop') ||
    lower.includes('crash loop')
  ) {
    return 'crashloop';
  }
  // OOM / memory
  if (lower.includes('oomkill') || lower.includes('oom kill') || lower.includes('out of memory')) {
    return 'oom-kill';
  }
  // Volume / PVC mount failures
  if (
    (lower.includes('volume') || lower.includes('pvc') || lower.includes('persistentvolume')) &&
    (lower.includes('fail') || lower.includes('pending') || lower.includes('provision'))
  ) {
    return 'volume-mount-failure';
  }
  // Not-ready (after image-pull and crashloop so those are not mis-classified)
  if (lower.includes('not ready') || lower.includes('notready')) {
    return 'notready';
  }
  // Unhealthy workload
  if (lower.includes('unhealthy')) {
    return 'unhealthy';
  }
  // Connectivity / connection failures
  if (
    lower.includes('connection') &&
    (lower.includes('timeout') || lower.includes('refused') || lower.includes('fail'))
  ) {
    return 'connectivity-failure';
  }
  // Missing service
  if (lower.includes('service') && (lower.includes('missing') || lower.includes('not found'))) {
    return 'missing-service';
  }
  // Pending pod (broad scheduling / init failures)
  if (lower.includes('pending pod') || lower.includes('stuck in pending')) {
    return 'pending';
  }

  // Fallback: first 40 normalised chars of the title
  return lower.slice(0, 40).replace(/\s+/g, '-');
}

/**
 * Extracts the canonical primary component from a finding for Pass 1 grouping.
 *
 * This is the **single component extraction strategy** used to determine
 * whether two findings belong to the same merge group. Pod components are
 * preferred as the most specific structural identity; other workload and named
 * resources are used as fallbacks.
 */
function extractPrimaryComponentForPass1(finding: Finding): string {
  // Pod — most specific identity for per-pod issues
  for (const comp of finding.affectedComponents) {
    if (comp.startsWith('Pod/')) return comp;
  }
  // Workload controller — for deployment-level issues
  for (const comp of finding.affectedComponents) {
    if (
      comp.startsWith('Deployment/') ||
      comp.startsWith('StatefulSet/') ||
      comp.startsWith('DaemonSet/')
    ) {
      return comp;
    }
  }
  // Named resources — Secret, ConfigMap, Service, PVC
  for (const comp of finding.affectedComponents) {
    if (
      comp.startsWith('Secret/') ||
      comp.startsWith('ConfigMap/') ||
      comp.startsWith('Service/') ||
      comp.startsWith('PersistentVolumeClaim/')
    ) {
      return comp;
    }
  }
  return finding.affectedComponents[0] ?? finding.id;
}

/**
 * Returns a priority number for a finding type.
 * Lower number = higher priority (wins merge conflicts).
 *
 * Priority order: AI (0) > hypothesis (1) > heuristic (2).
 */
function findingPriority(finding: Finding): number {
  if (finding.id.startsWith('finding:ai:')) return 0;
  if (finding.id.startsWith('finding:hypothesis:')) return 1;
  return 2;
}

/**
 * **The single merge strategy for Pass 1.**
 *
 * Given a group of findings that describe the same issue on the same component,
 * selects the highest-priority finding as the base (AI > hypothesis > heuristic;
 * tie-broken by confidence) and absorbs evidence, affected components,
 * contradictions, and missing-evidence entries from non-winning findings into
 * the base finding.
 *
 * A small convergence boost is applied when multiple independent findings
 * corroborate the same issue.
 */
function mergeComponentGroup(group: Finding[]): Finding {
  if (group.length === 1) return group[0]!;

  // Sort by priority then confidence so the winner is sorted[0]
  const sorted = [...group].sort((a, b) => {
    const pd = findingPriority(a) - findingPriority(b);
    if (pd !== 0) return pd;
    return b.confidence - a.confidence;
  });
  const winner = sorted[0]!;

  // Convergence boost: multiple independent findings agree → slightly higher
  // confidence, capped at +0.10 regardless of group size.
  const boost = Math.min((group.length - 1) * 0.05, 0.10);
  const boostedConfidence = Math.round(Math.min(1.0, winner.confidence + boost) * 10_000) / 10_000;

  // Union all array fields (deduplicated)
  const evidenceMap = new Map<string, Evidence>();
  for (const f of group) {
    for (const ev of f.evidence) {
      const key = `${ev.path}|${ev.note}`;
      if (!evidenceMap.has(key)) evidenceMap.set(key, ev);
    }
  }
  const unionStrings = (...arrays: string[][]): string[] => {
    const seen = new Set<string>();
    return arrays.flat().filter((s) => (seen.has(s) ? false : seen.add(s)));
  };

  return {
    ...winner,
    confidence: boostedConfidence,
    evidence: Array.from(evidenceMap.values()),
    affectedComponents: unionStrings(...group.map((f) => f.affectedComponents)),
    contradictionsChecked: unionStrings(...group.map((f) => f.contradictionsChecked)),
    missingEvidence: unionStrings(...group.map((f) => f.missingEvidence)),
  };
}

/**
 * **Pass 1: Component-based merge.**
 *
 * Operates on two distinct finding pools and applies three rules:
 *
 * **Rule 1 — Within the heuristic+AI pool** (verifiedHeuristic): group by
 * `(primaryComponent, issueFamily)`. Within each group, AI wins over heuristic.
 * Evidence from the non-winning findings is absorbed into the winner via
 * {@link mergeComponentGroup}.
 *
 * **Rule 2 — Hypothesis vs. heuristic**: for each hypothesis finding, if
 * the heuristic+AI pool contains a *heuristic* finding (non-AI) with the
 * same `(primaryComponent, issueFamily)`, the hypothesis wins and the
 * heuristic is dropped. This replaces `mergeHypothesisFindings`.
 *
 * **Rule 3 — Hypothesis vs. AI**: if the heuristic+AI pool contains an *AI*
 * finding with the same `(primaryComponent, issueFamily)`, the AI wins and
 * the hypothesis is dropped. This replaces AI-primary promotion for the
 * cross-layer case.
 *
 * **Important:** multiple hypothesis findings with the same
 * `(primaryComponent, issueFamily)` but *different root-cause titles* are
 * **not** merged with each other — they are competing diagnostic theories
 * and must all survive for the user to review. Only exact title duplicates
 * (same root cause from multiple symptom groups) are collapsed, via a
 * preliminary dedup on `(component, family, normalizedTitle)`. This replaces
 * the old `hypothesisDedupMap`.
 *
 * Findings from different issue families on the same component remain
 * separate (e.g. CrashLoopBackOff and missing-secret both survive for the
 * same pod because they describe different problems).
 *
 * One normalization strategy: {@link extractPrimaryComponentForPass1} +
 * {@link normalizeIssueFamilyForPass1}.
 * One merge strategy: {@link mergeComponentGroup} (within heuristic+AI pool)
 * plus the priority-based selection described above.
 */
function pass1ComponentMerge(
  heuristicAndAI: Finding[],
  hypothesisFindings: Finding[],
): Finding[] {
  // ── Step A: Deduplicate same-title hypothesis findings ──────────────────────
  // The same hypothesis (same component+family+title) can appear from multiple
  // symptom groups when normalisation routes two different heuristic findings to
  // the same primary component. Keep only the highest-confidence entry per
  // unique (component, family, normalizedTitle) triple.
  // This replaces the old hypothesisDedupMap.
  const hypothesisByKey = new Map<string, Finding>();
  for (const hyp of hypothesisFindings) {
    const component = extractPrimaryComponentForPass1(hyp);
    const family = normalizeIssueFamilyForPass1(hyp);
    const title = normalizeTitleForPass2(hyp.title);
    const key = `${component}::${family}::${title}`;
    const existing = hypothesisByKey.get(key);
    if (existing == null || hyp.confidence > existing.confidence) {
      hypothesisByKey.set(key, hyp);
    }
  }
  const uniqueHypotheses = Array.from(hypothesisByKey.values());

  // ── Step B: Merge heuristic + AI by (component, family) ────────────────────
  // Within each group, AI wins over heuristic (Rule 1).
  const heuristicGroups = new Map<string, Finding[]>();
  for (const f of heuristicAndAI) {
    const key = `${extractPrimaryComponentForPass1(f)}::${normalizeIssueFamilyForPass1(f)}`;
    const group = heuristicGroups.get(key) ?? [];
    group.push(f);
    heuristicGroups.set(key, group);
  }
  const mergedPool = Array.from(heuristicGroups.values()).map(mergeComponentGroup);

  // Index the merged pool by (component, family) for O(1) hypothesis lookup.
  const poolByKey = new Map<string, Finding>();
  for (const f of mergedPool) {
    const key = `${extractPrimaryComponentForPass1(f)}::${normalizeIssueFamilyForPass1(f)}`;
    poolByKey.set(key, f);
  }

  // ── Step C: Cross-layer selection ──────────────────────────────────────────
  // Determine which hypothesis findings survive and which pool findings are
  // displaced by hypothesis findings.
  //
  // Rule 2: hypothesis displaces heuristic (non-AI) for same (component, family).
  // Rule 3: AI displaces hypothesis for same (component, family).
  const absorbedPoolKeys = new Set<string>(); // Pool (component, family) keys displaced by hypotheses
  const absorbedHypKeys = new Set<string>();  // Hypothesis (c, f, title) keys displaced by AI

  for (const hyp of uniqueHypotheses) {
    const component = extractPrimaryComponentForPass1(hyp);
    const family = normalizeIssueFamilyForPass1(hyp);
    const poolKey = `${component}::${family}`;
    const poolFinding = poolByKey.get(poolKey);

    if (poolFinding == null) {
      // No heuristic/AI for this (component, family) → hypothesis survives as-is.
    } else if (poolFinding.id.startsWith('finding:ai:')) {
      // Rule 3: AI present → hypothesis is absorbed by the AI finding.
      const hypKey = `${poolKey}::${normalizeTitleForPass2(hyp.title)}`;
      absorbedHypKeys.add(hypKey);
    } else {
      // Rule 2: Only heuristic present → hypothesis wins, heuristic displaced.
      absorbedPoolKeys.add(poolKey);
    }
  }

  // ── Step D: Assemble final result ──────────────────────────────────────────
  const result: Finding[] = [];

  // Include pool (heuristic+AI) findings that were not displaced by a hypothesis.
  for (const f of mergedPool) {
    const key = `${extractPrimaryComponentForPass1(f)}::${normalizeIssueFamilyForPass1(f)}`;
    if (!absorbedPoolKeys.has(key)) {
      result.push(f);
    }
  }

  // Include hypothesis findings that were not absorbed by an AI finding.
  for (const hyp of uniqueHypotheses) {
    const component = extractPrimaryComponentForPass1(hyp);
    const family = normalizeIssueFamilyForPass1(hyp);
    const title = normalizeTitleForPass2(hyp.title);
    const hypKey = `${component}::${family}::${title}`;
    if (!absorbedHypKeys.has(hypKey)) {
      result.push(hyp);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Pass 2: Title-based dedup (cosmetic)
// ---------------------------------------------------------------------------
//
// Contract: one normalization strategy (strip decorators, lowercase) and one
// merge strategy (higher confidence wins; AI findings win title collisions
// before confidence is compared).
//
// This pass catches LLM wording variants (the same root-cause described with
// slightly different words) and cross-component duplicates where the same
// missing resource affects multiple pods (same title, different components —
// not merged by Pass 1 which operates on component identity).

/**
 * **The single normalization strategy for Pass 2.**
 *
 * Strips structural decorators added by the hypothesis layer (`[Hypothesis]`,
 * `(symptom:…)` suffixes) and normalises typographic variants (curly quotes)
 * so that functionally-identical titles map to the same key.
 */
function normalizeTitleForPass2(title: string): string {
  return title
    .replace(/\[Hypothesis\]\s*/i, '')
    .replace(/\(symptom:.*\)$/i, '')
    .replace(/['']/g, "'")
    .trim()
    .toLowerCase();
}

/**
 * **Pass 2: Title-based dedup.**
 *
 * Iterates over Pass-1 output with AI findings sorted first (so they win title
 * collisions before confidence is compared). For each finding, normalises its
 * title via {@link normalizeTitleForPass2} and keeps only the first seen (or
 * the higher-confidence duplicate when a collision occurs).
 *
 * This pass uses one normalization strategy ({@link normalizeTitleForPass2})
 * and one merge strategy (higher confidence wins; AI wins before confidence is
 * compared, making the pass stable when confidence values are equal).
 */
function pass2TitleDedup(findings: Finding[]): Finding[] {
  // AI findings are sorted first so they win title collisions over non-AI
  // findings with equal-or-lower confidence without needing a special case.
  const aiFirst = [...findings].sort((a, b) => {
    const aIsAi = a.id.startsWith('finding:ai:') ? 0 : 1;
    const bIsAi = b.id.startsWith('finding:ai:') ? 0 : 1;
    return aIsAi - bIsAi;
  });

  const result: Finding[] = [];
  const seenTitles = new Map<string, Finding>();

  for (const finding of aiFirst) {
    const normTitle = normalizeTitleForPass2(finding.title);
    const existing = seenTitles.get(normTitle);

    if (existing == null) {
      seenTitles.set(normTitle, finding);
      result.push(finding);
    } else if (finding.confidence > existing.confidence) {
      // Replace the lower-confidence duplicate in-place
      const idx = result.indexOf(existing);
      if (idx !== -1) result[idx] = finding;
      seenTitles.set(normTitle, finding);
    }
    // else: skip the lower-confidence duplicate
  }

  return result;
}

// ---------------------------------------------------------------------------
// Edge utilities
// ---------------------------------------------------------------------------

function filterEdgesForRetainedFindings(
  edges: GraphEdge[],
  retainedFindings: Finding[],
): GraphEdge[] {
  const retainedFindingIds = new Set(retainedFindings.map((finding) => finding.id));

  return edges.filter((edge) => {
    const sourceIsFinding = edge.source.startsWith('finding:');
    const targetIsFinding = edge.target.startsWith('finding:');

    if (sourceIsFinding && !retainedFindingIds.has(edge.source)) {
      return false;
    }
    if (targetIsFinding && !retainedFindingIds.has(edge.target)) {
      return false;
    }

    return true;
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Runs the full investigation pipeline against parsed bundle data.
 *
 * Steps:
 * 1. **Seed generation** — {@link generateSeeds} produces prioritised
 *    investigation seeds from analyzers, pod health, logs, and events.
 * 2. **Targeted investigators** — {@link investigateKubernetes},
 *    {@link investigateLog}, {@link investigateConfig}, and
 *    {@link investigateServices} run concurrently (all synchronous,
 *    structured for easy parallelisation).
 * 3. **Hypothesis verification** — {@link generateAllHypotheses} generates
 *    competing root-cause candidates per symptom, {@link collectEvidenceForHypothesis}
 *    gathers supporting/contradicting/missing evidence for each, {@link rankHypotheses}
 *    scores and ranks them, and {@link convertHypothesisSetsToFindings} converts them
 *    to {@link Finding}s.  Only hypothesis findings with `confidence > 0` are kept.
 *    This layer is always active (heuristic-only, no AI required).
 * 4. **AI investigator** — when {@link aiDeps} is provided, calls
 *    {@link investigateWithAI} and merges its findings into the raw pool.
 *    If the AI call fails, a warning is logged and heuristic results are
 *    returned unchanged (graceful degradation).
 * 5. **Verification** — {@link verifyFindings} runs contradiction checks,
 *    adjusts confidence, detects missing evidence, and deduplicates the
 *    heuristic + AI pool by issue type + primary component.
 * 6. **Pass 1 — Component-based merge** — {@link pass1ComponentMerge} groups
 *    all findings (heuristic, AI, hypothesis) by `(primaryComponent, issueFamily)`.
 *    Within each group, the highest-priority finding wins (AI > hypothesis >
 *    heuristic) and absorbs evidence from non-winning findings.  Findings from
 *    different issue families on the same component remain separate.
 * 7. **Pass 2 — Title-based dedup** — {@link pass2TitleDedup} normalises titles
 *    and removes cosmetic wording variants (same root cause, different phrasing).
 *    AI findings win title collisions; higher confidence wins ties.
 * 8. **Symptom suppression** — pure-symptom heuristic findings
 *    (Not-Ready, Pending, Unhealthy Workload) are suppressed when a root-cause
 *    finding covers the same component.  CrashLoopBackOff is always preserved.
 * 9. **Sort** — findings are sorted by severity descending, then confidence
 *    descending, so the most critical / most certain finding appears first.
 *
 * @param context - All parsed bundle data (from the pipeline).
 * @param aiDeps  - Optional AI dependencies. When provided, AI investigation
 *                  is added on top of heuristic investigation.
 * @returns A {@link InvestigationResult} ready for graph integration and
 *          report generation.
 */
// ---------------------------------------------------------------------------
// Graph-driven investigation helpers (Phase 5e / 4.8)
// ---------------------------------------------------------------------------
//
// These helpers implement the graph-query phase that runs BEFORE the
// hypothesis generator.  The orchestrator calls matchCausalTemplate after
// all investigators have run, then:
//   1. Collects symptom finding IDs that are explained by a causal chain.
//   2. Creates synthetic root-cause Finding objects for the root nodes of
//      those chains.
//   3. Builds direct finding→finding `causes` edges so buildFindingTree
//      produces a real parent→child structure.
//
// The hypothesis generator is skipped for matched symptom findings and used
// only as the fallback path for unmatched symptoms.

/**
 * Returns the finding IDs that appear as the last `finding:` node in at
 * least one causal template instance whose root-cause node is **synthetic**
 * (i.e. the root-cause ID is NOT already present in the heuristic findings).
 *
 * Only symptoms matched by templates with a synthetic root cause are excluded
 * from hypothesis generation — the graph-driven path fully replaces the
 * hypothesis layer for those symptoms.  When the template root cause is an
 * existing heuristic finding (e.g. `finding:log:dns:*` in the DNS-failure
 * template), the symptom is kept in the hypothesis generation input so that
 * the hypothesis layer still generates differential-diagnosis alternatives
 * (connectivity-failure, readiness-failure, etc.).
 *
 * @param instances       - Causal template instances from {@link matchCausalTemplate}.
 * @param heuristicIds    - Set of finding IDs already produced by investigators.
 */
function collectMatchedSymptomIds(
  instances: CausalTemplateInstance[],
  heuristicIds: Set<string>,
): Set<string> {
  const ids = new Set<string>();
  for (const instance of instances) {
    const rootId = instance.nodeIds[0];
    if (!rootId) continue;

    // Only skip hypothesis gen when the root cause is synthetic
    // (not an existing heuristic finding).  When the root is an existing
    // finding (e.g. `finding:log:dns:*`), hypothesis gen still produces
    // valuable differential-diagnosis alternatives.
    if (rootId.startsWith('finding:') && heuristicIds.has(rootId)) continue;

    // Walk from the end of the chain to find the last finding-type node
    for (let i = instance.nodeIds.length - 1; i >= 0; i--) {
      const nodeId = instance.nodeIds[i];
      if (nodeId?.startsWith('finding:')) {
        ids.add(nodeId);
        break;
      }
    }
  }
  return ids;
}

/**
 * Parses a causal-template root-cause node ID into its constituent parts.
 *
 * Node IDs have the format `finding:<type>:<name>:<namespace>` where
 * `<name>` may itself contain `:` characters (e.g. image tags like
 * `myapp:v999`).  The last segment is always the namespace; everything
 * between the type and namespace is the resource name.
 *
 * Returns `undefined` when the ID does not have the expected structure.
 */
function parseRootCauseNodeId(
  id: string,
): { type: string; name: string; namespace: string } | undefined {
  const parts = id.split(':');
  // Minimum: finding:<type>:<name>:<namespace>  → 4 parts
  if (parts.length < 4) return undefined;
  const type = parts[1] ?? '';
  const namespace = parts[parts.length - 1] ?? '';
  const name = parts.slice(2, parts.length - 1).join(':');
  if (!type || !name || !namespace) return undefined;
  return { type, name, namespace };
}

/**
 * Builds supporting {@link Evidence} from relevant events for a causal
 * root-cause finding of type `missing-secret`.
 */
function buildMissingSecretEvidence(
  secretName: string,
  namespace: string,
  podName: string | undefined,
  events: K8sEvent[],
  templateId: string,
  templateName: string,
): Evidence[] {
  const evidence: Evidence[] = events
    .filter(
      (e) =>
        e.reason === 'FailedMount' &&
        (podName ? e.involvedObject.name === podName : true) &&
        (e.involvedObject.namespace ?? 'default') === namespace &&
        e.message.toLowerCase().includes(secretName.toLowerCase()),
    )
    .map((e) => ({
      path: `events/${e.involvedObject.namespace ?? namespace}/${e.involvedObject.name}`,
      note: e.message,
    }));

  if (evidence.length === 0) {
    evidence.push({
      path: `causal-template:${templateId}`,
      note: `Causal template '${templateName}' matched: Secret '${secretName}' absent from namespace '${namespace}'`,
    });
  }
  return evidence;
}

/**
 * Builds supporting {@link Evidence} from relevant events for a causal
 * root-cause finding of type `bad-image-tag`.
 */
function buildBadImageTagEvidence(
  imageName: string,
  namespace: string,
  podName: string | undefined,
  events: K8sEvent[],
  templateId: string,
  templateName: string,
): Evidence[] {
  const evidence: Evidence[] = events
    .filter(
      (e) =>
        e.reason === 'ErrImagePull' &&
        (podName ? e.involvedObject.name === podName : true) &&
        (e.involvedObject.namespace ?? 'default') === namespace,
    )
    .map((e) => ({
      path: `events/${e.involvedObject.namespace ?? namespace}/${e.involvedObject.name}`,
      note: e.message,
    }));

  if (evidence.length === 0) {
    evidence.push({
      path: `causal-template:${templateId}`,
      note: `Causal template '${templateName}' matched: image '${imageName}' does not exist in registry`,
    });
  }
  return evidence;
}

/**
 * Builds supporting {@link Evidence} from relevant events for a causal
 * root-cause finding of type `missing-storage-class`.
 */
function buildMissingStorageClassEvidence(
  storageClass: string,
  namespace: string,
  events: K8sEvent[],
  templateId: string,
  templateName: string,
): Evidence[] {
  const evidence: Evidence[] = events
    .filter(
      (e) =>
        e.reason === 'ProvisioningFailed' &&
        (e.involvedObject.namespace ?? 'default') === namespace &&
        e.message.toLowerCase().includes(storageClass.toLowerCase()),
    )
    .map((e) => ({
      path: `events/${e.involvedObject.namespace ?? namespace}/${e.involvedObject.name}`,
      note: e.message,
    }));

  if (evidence.length === 0) {
    evidence.push({
      path: `causal-template:${templateId}`,
      note: `Causal template '${templateName}' matched: StorageClass '${storageClass}' does not exist`,
    });
  }
  return evidence;
}

/**
 * Constructs a synthetic root-cause {@link Finding} from a causal template
 * instance root-cause node.
 *
 * Returns `undefined` when the node type is unrecognised or when a required
 * parameter cannot be extracted from the data.
 */
function buildGraphRootCauseFinding(
  id: string,
  type: string,
  name: string,
  namespace: string,
  confidence: number,
  symptomFinding: Finding,
  instance: CausalTemplateInstance,
  events: K8sEvent[],
): Finding | undefined {
  const affectedComponents = [...symptomFinding.affectedComponents];
  const podComp = affectedComponents.find((c) => c.startsWith('Pod/'));
  const podName = podComp?.split('/')[2];

  switch (type) {
    case 'missing-secret': {
      const evidence = buildMissingSecretEvidence(
        name, namespace, podName, events, instance.templateId, instance.templateName,
      );
      return {
        id,
        title: `Missing Secret '${name}'`,
        severity: 'critical' as FindingSeverity,
        confidence,
        affectedComponents,
        reasoningSummary:
          `Secret '${name}' is absent from namespace '${namespace}'. ` +
          `FailedMount events confirm the secret is not found, causing the container to fail on startup.`,
        evidence,
        contradictionsChecked: [`Secret '${name}' in namespace '${namespace}'`],
        recommendedAction:
          `Create the missing secret '${name}' in namespace '${namespace}'. ` +
          `Run: kubectl create secret generic ${name} -n ${namespace} --from-literal=<key>=<value>`,
        missingEvidence: [],
      };
    }

    case 'bad-image-tag': {
      const evidence = buildBadImageTagEvidence(
        name, namespace, podName, events, instance.templateId, instance.templateName,
      );
      return {
        id,
        title: `Bad Image Tag: ${name}`,
        severity: 'critical' as FindingSeverity,
        confidence,
        affectedComponents,
        reasoningSummary:
          `Image '${name}' does not exist in the container registry. ` +
          `ErrImagePull events confirm the image cannot be pulled.`,
        evidence,
        contradictionsChecked: [`Image '${name}' in container registry`],
        recommendedAction: `Update the pod spec to use a valid, existing image tag.`,
        missingEvidence: [],
      };
    }

    case 'missing-storage-class': {
      const evidence = buildMissingStorageClassEvidence(
        name, namespace, events, instance.templateId, instance.templateName,
      );
      return {
        id,
        title: `Missing StorageClass '${name}'`,
        severity: 'critical' as FindingSeverity,
        confidence,
        affectedComponents,
        reasoningSummary:
          `StorageClass '${name}' does not exist in the cluster. ` +
          `PVC provisioning failed, preventing the pod from mounting its volume.`,
        evidence,
        contradictionsChecked: [`StorageClass '${name}' in cluster`],
        recommendedAction:
          `Create StorageClass '${name}' or update the PVC spec to reference an existing storage class.`,
        missingEvidence: [],
      };
    }

    default:
      return undefined;
  }
}

/**
 * Creates synthetic root-cause {@link Finding} objects for causal template
 * instance root nodes that are **not** already represented in the heuristic
 * findings pool.
 *
 * When the causal template's root-cause node ID matches an existing finding
 * (e.g. a `finding:log:dns:*` finding produced by the log investigator), no
 * synthetic finding is created — the existing finding becomes the root-cause.
 *
 * @param instances        - Causal template instances from {@link matchCausalTemplate}.
 * @param heuristicFindings - All findings from the three heuristic investigators.
 * @param events           - Raw Kubernetes events (used for evidence building).
 * @returns Synthetic root-cause findings keyed by their ID.
 */
function createGraphRootCauseFindings(
  instances: CausalTemplateInstance[],
  heuristicFindings: Finding[],
  events: K8sEvent[],
): Finding[] {
  const existingIds = new Set(heuristicFindings.map((f) => f.id));
  const results: Finding[] = [];
  const createdIds = new Set<string>();

  for (const instance of instances) {
    const rootId = instance.nodeIds[0];
    if (!rootId || !rootId.startsWith('finding:')) continue;
    // Skip if already an actual finding or already created
    if (existingIds.has(rootId) || createdIds.has(rootId)) continue;
    createdIds.add(rootId);

    // Find the symptom finding (last finding-type node in the chain)
    let symptomFinding: Finding | undefined;
    for (let i = instance.nodeIds.length - 1; i >= 0; i--) {
      const nodeId = instance.nodeIds[i];
      if (!nodeId) continue;
      const found = heuristicFindings.find((f) => f.id === nodeId);
      if (found) { symptomFinding = found; break; }
    }
    if (!symptomFinding) continue;

    const parsed = parseRootCauseNodeId(rootId);
    if (!parsed) continue;
    const { type, name, namespace } = parsed;

    // Confidence comes from the average weight of the causal chain edges
    const avgWeight =
      instance.edges.reduce((s, e) => s + (e.weight ?? 0.9), 0) /
      Math.max(1, instance.edges.length);

    const finding = buildGraphRootCauseFinding(
      rootId, type, name, namespace, avgWeight,
      symptomFinding, instance, events,
    );
    if (finding) results.push(finding);
  }

  return results;
}

/**
 * Builds direct finding→finding `causes` edges for the {@link FindingTree}.
 *
 * The causal template instances contain edges that may traverse event nodes
 * (e.g. `missing-secret → FailedMount-event → crashloop`).  Since
 * {@link buildFindingTree} only recognises finding-type nodes, this function
 * collapses event nodes by creating a direct edge between consecutive finding
 * nodes in each chain.
 *
 * A new edge is created only when both the source and target node IDs
 * correspond to findings in the combined pool (`heuristicFindings` +
 * `graphRootCauseFindings`).
 *
 * @returns One `causes` edge per consecutive (source-finding, target-finding)
 *   pair found in each causal chain.
 */
function buildDirectCausalEdges(
  instances: CausalTemplateInstance[],
  heuristicFindings: Finding[],
  graphRootCauseFindings: Finding[],
): GraphEdge[] {
  const allFindings = [...heuristicFindings, ...graphRootCauseFindings];
  const findingIds = new Set(allFindings.map((f) => f.id));
  const edges: GraphEdge[] = [];
  let counter = 0;

  for (const instance of instances) {
    // Collect only finding-type node IDs from the chain, in order
    const findingChain = instance.nodeIds.filter((id) => findingIds.has(id));
    if (findingChain.length < 2) continue;

    // Average edge weight for the whole causal chain
    const avgWeight =
      instance.edges.reduce((s, e) => s + (e.weight ?? 0.9), 0) /
      Math.max(1, instance.edges.length);

    for (let i = 0; i < findingChain.length - 1; i++) {
      const sourceId = findingChain[i]!;
      const targetId = findingChain[i + 1]!;
      edges.push({
        id: `edge:graph-causes:${++counter}:${sourceId.slice(-20)}:${targetId.slice(-20)}`,
        source: sourceId,
        target: targetId,
        type: 'causes',
        weight: avgWeight,
        note: `Causal template: ${instance.templateName}`,
      });
    }
  }

  return edges;
}

/**
 * Ranks a list of graph root-cause findings by a composite score derived from
 * their causal template instances:
 *
 * 1. **Causal path length** (weight 0.5): number of finding-to-finding hops
 *    in the causal chain.  Longer chains indicate a more specific diagnosis.
 * 2. **Average edge weight** (weight 0.3): higher weights signal stronger
 *    causal evidence.
 * 3. **Evidence count** (weight 0.2): more evidence items = higher certainty.
 *
 * Findings not appearing as root nodes in any instance receive a score of 0
 * and sort last.
 *
 * @param rootCauseFindings - Findings to rank (output of {@link createGraphRootCauseFindings}).
 * @param instances         - All causal template instances (provides path/weight data).
 * @returns A new array sorted by composite score descending.
 */
export function rankGraphRootCauses(
  rootCauseFindings: Finding[],
  instances: CausalTemplateInstance[],
): Finding[] {
  const scoreMap = new Map<string, number>();

  for (const f of rootCauseFindings) {
    let maxPathLength = 0;
    let totalEdgeWeight = 0;
    let edgeCount = 0;

    for (const instance of instances) {
      if (instance.nodeIds[0] !== f.id) continue;
      // Count finding-to-finding hops (skip event nodes)
      const findingNodes = instance.nodeIds.filter((id) => id.startsWith('finding:'));
      const pathLength = findingNodes.length - 1;
      if (pathLength > maxPathLength) maxPathLength = pathLength;

      for (const edge of instance.edges) {
        totalEdgeWeight += edge.weight ?? 0.9;
        edgeCount++;
      }
    }

    const avgEdgeWeight = edgeCount > 0 ? totalEdgeWeight / edgeCount : 0;
    const evidenceCount = f.evidence.length;
    const score = maxPathLength * 0.5 + avgEdgeWeight * 0.3 + evidenceCount * 0.2;
    scoreMap.set(f.id, score);
  }

  return [...rootCauseFindings].sort((a, b) => {
    const scoreA = scoreMap.get(a.id) ?? 0;
    const scoreB = scoreMap.get(b.id) ?? 0;
    return scoreB - scoreA;
  });
}

/**
 * Optional callback invoked before each AI seed investigation begins.
 * Used by the TUI to show per-seed progress during the AI phase.
 */
export type SeedProgressCallback = (
  seedIndex: number,
  seedTotal: number,
  seedLabel: string,
) => void;

export async function runInvestigation(
  context: InvestigatorContext,
  aiDeps?: AIInvestigatorDeps,
  onSeedProgress?: SeedProgressCallback,
): Promise<InvestigationResult> {
  // ── 1. Generate seeds ─────────────────────────────────────────────────────
  const seeds = generateSeeds(context);

  // ── 1a. AI seed clustering (optional, additive) ───────────────────────────
  //
  // When AI is enabled and the seed count meets the minimum threshold,
  // group seeds by likely shared root cause via a single LLM call and
  // collapse each cluster into one representative ClusteredSeed.
  //
  // Heuristic investigators (k8sSeeds, logSeeds, etc.) continue to use the
  // ORIGINAL seeds array — they examine all resources regardless, and seeds
  // are only context hints for those paths.
  //
  // The AI investigator receives the CLUSTERED seeds — this is the key
  // quality/cost lever: fewer LLM calls, each with richer combined context.
  let clusteredSeeds: ClusteredSeed[];
  let seedClusteringEnabled = false;

  if (aiDeps?.llmClient && seeds.length >= 3) {
    try {
      clusteredSeeds = await clusterSeeds(seeds, aiDeps.llmClient);
      seedClusteringEnabled = true;
    } catch (error) {
      console.warn(
        `[Orchestrator] Seed clustering failed, continuing with unclustered seeds: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      clusteredSeeds = toUnclusteredSeeds(seeds);
    }
  } else {
    clusteredSeeds = toUnclusteredSeeds(seeds);
  }

  // Partition seeds by category so each investigator receives the most
  // relevant hints (investigators still examine all resources, but seeds
  // can be used for future prioritisation).
  const k8sSeeds = seeds.filter((s) => s.category === 'kubernetes');
  const logSeeds = seeds.filter((s) => s.category === 'log');
  const configSeeds = seeds.filter((s) => s.category === 'configuration');
  const serviceSeeds = seeds.filter((s) => s.category === 'connectivity');

  // ── 2. Run all heuristic investigators (structurally parallel) ────────────
  const k8sResult = investigateKubernetes(context, k8sSeeds);
  const logResult = investigateLog(context, logSeeds);
  const configResult = investigateConfig(context, configSeeds);
  const serviceResult = investigateServices(context, serviceSeeds);
  const netpolResult = investigateNetworkPolicies(context, serviceSeeds);

  // ── 3. Merge heuristic findings and graph edges ───────────────────────────
  const heuristicFindings: Finding[] = [
    ...k8sResult.findings,
    ...logResult.findings,
    ...configResult.findings,
    ...serviceResult.findings,
    ...netpolResult.findings,
  ];

  const allEdges: GraphEdge[] = [
    ...k8sResult.edges,
    ...logResult.edges,
    ...configResult.edges,
    ...serviceResult.edges,
    ...netpolResult.edges,
  ];

  // ── 3a-graph. Graph-driven investigation phase (Phase 5e / 4.8) ───────────
  //
  // Before the hypothesis generator runs, match all known causal templates
  // against the heuristic findings and K8s events.  When a causal chain is
  // found (e.g. FailedMount → CrashLoopBackOff), the symptom finding that is
  // the "effect" end of the chain is recorded in `matchedSymptomIds`.
  //
  // The hypothesis generator is then called only with the UNMATCHED findings
  // so it acts as the fallback path for symptoms that no template explains.
  //
  // For each matched chain, a synthetic root-cause Finding is created (if the
  // root node is not already in the heuristic pool) and direct finding→finding
  // `causes` edges are built so that `buildFindingTree` produces a real
  // parent→child structure.

  // Run causal template matching
  const causalInstances = matchCausalTemplate(
    heuristicFindings,
    context.events,
    context.resources,
  );

  // Which symptom findings have a known causal chain from a SYNTHETIC root cause?
  // (Only exclude from hypothesis gen when the root is synthetic, not when it's
  // already an actual heuristic finding — the DNS failure template's root is
  // `finding:log:dns:*` which is real; hypothesis gen stays active for that case.)
  const heuristicFindingIds = new Set(heuristicFindings.map((f) => f.id));
  const matchedSymptomIds = collectMatchedSymptomIds(causalInstances, heuristicFindingIds);
  const graphMatchedSymptoms = matchedSymptomIds.size;

  // Create synthetic root-cause findings for chain roots that aren't already
  // in the heuristic pool (e.g. `finding:missing-secret:app-credentials:default`).
  const graphRootCauseFindings = createGraphRootCauseFindings(
    causalInstances,
    heuristicFindings,
    context.events,
  );

  // Build finding→finding `causes` edges (event nodes in chains are collapsed).
  const directCausalEdges = buildDirectCausalEdges(
    causalInstances,
    heuristicFindings,
    graphRootCauseFindings,
  );

  // Add all causal edges (full chains + direct finding-to-finding) to allEdges.
  for (const instance of causalInstances) {
    allEdges.push(...instance.edges);
  }
  allEdges.push(...directCausalEdges);

  // Track the IDs of synthetic root-cause findings for the suppression filter.
  const graphRootCauseIds = new Set(graphRootCauseFindings.map((f) => f.id));

  // ── 3b. Hypothesis verification layer (fallback for unmatched symptoms) ────
  //
  // For each unique symptom (grouped by primary affected component), generate
  // competing root-cause hypotheses, collect structured evidence, score and
  // rank them with calibrated confidence, then convert them to Finding objects.
  //
  // When a symptom finding was handled by the graph-driven phase above (i.e.
  // its ID is in `matchedSymptomIds`), it is EXCLUDED from hypothesis
  // generation — the graph traversal result replaces the hypothesis layer for
  // those symptoms.  The hypothesis generator runs only for unmatched symptoms.
  //
  // Only hypothesis findings with `confidence > 0` are included (zero-
  // confidence hypotheses have no supporting evidence and add no value).
  let hypothesesGenerated = 0;
  let hypothesesVerified = 0;

  // Feed only unmatched findings to the hypothesis generator (graph-driven
  // path has already handled the matched ones).
  const findingsForHypothesisGen = heuristicFindings.filter(
    (f) => !matchedSymptomIds.has(f.id),
  );

  const hypothesisSets = generateAllHypotheses(findingsForHypothesisGen, context);

  for (const set of hypothesisSets) {
    // Collect evidence and score each hypothesis
    const evidenced = set.hypotheses.map((h) => ({
      ...h,
      evidenceAssessment: collectEvidenceForHypothesis(h, context),
    }));
    hypothesesGenerated += evidenced.length;

    // Score, rank, and attach spec-gap recommendations
    const ranked = rankHypotheses(evidenced).map((h) => ({
      ...h,
      specGapRecommendations: identifySpecGaps(h),
    }));

    // Count hypotheses that received a positive confidence score
    hypothesesVerified += ranked.filter((h) => h.confidence > 0).length;

    // Update the set in place
    set.hypotheses = ranked;
    set.topHypothesis = ranked[0] ?? null;
  }

  // ── 3c. Cross-symptom hypothesis correlation (7.5) ───────────────────────
  //
  // After all hypothesis sets have been scored and ranked, look for
  // convergence: N symptom groups in the same namespace that all share the
  // same top-ranked root-cause category (e.g. all 'dns-failure').  When
  // convergence is detected, emit a single cluster-wide meta-finding with
  // confidence boosted by the number of converging symptoms.
  //
  // These meta-findings are merged into the final finding list alongside the
  // individual hypothesis findings and are subject to the same dedup passes.
  const correlatedMetaFindings = correlateAcrossSymptoms(hypothesisSets);

  // Convert hypothesis sets to findings, keeping only those with positive
  // confidence (at least one supporting evidence item contributed to the score).
  const allHypothesisFindings = convertHypothesisSetsToFindings(hypothesisSets);

  // Include both hypothesis findings (fallback path) and graph root-cause
  // findings (graph-driven path) in the combined pool that Pass 1 processes.
  // The graph root-cause findings are ranked by path length + edge weight +
  // evidence count so the most diagnostic root cause appears first.
  const rankedGraphRootCauses = rankGraphRootCauses(graphRootCauseFindings, causalInstances);
  const nonZeroHypothesisFindings = [
    ...allHypothesisFindings.filter((hf) => hf.confidence > 0),
    ...correlatedMetaFindings,
    ...rankedGraphRootCauses,
  ];

  // ── 4. AI investigation (additive, with graceful degradation) ─────────────
  const rawFindings: Finding[] = [...heuristicFindings];
  let aiEnabled = false;
  let aiFindings = 0;

  if (aiDeps !== undefined) {
    try {
      const aiResult = await investigateWithAI(context, clusteredSeeds, {
        ...aiDeps,
        onSeedProgress,
      });
      rawFindings.push(...aiResult.findings);
      allEdges.push(...aiResult.edges);
      aiEnabled = true;
      aiFindings = aiResult.findings.length;
    } catch (error) {
      // Graceful degradation: log the failure, continue with heuristic results
      console.warn(
        `[Orchestrator] AI investigation failed, continuing with heuristic results: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // ── 5. Verify: contradiction checks, confidence adjustment, dedup ─────────
  //
  // Applies per-finding contradiction checks, confidence adjustment, and
  // missing-evidence detection, then deduplicates within the heuristic + AI
  // pool by issue type + primary component.
  const verifiedHeuristic = verifyFindings(rawFindings, context);

  // ── 6. Pass 1: Component-based merge ─────────────────────────────────────
  //
  // All findings — verified heuristic, AI, and hypothesis — are combined and
  // grouped by (primaryComponent, issueFamily).  Within each group the
  // highest-priority finding wins (AI > hypothesis > heuristic) and absorbs
  // evidence from non-winning findings via {@link mergeComponentGroup}.
  //
  // This single pass replaces three previously-overlapping steps:
  //   (a) hypothesisDedupMap — per-category hypothesis dedup
  //   (b) AI-primary promotion — AI absorbs heuristic for same component
  //   (c) mergeHypothesisFindings — hypothesis replaces heuristic for same
  //       component + issue family
  //
  // Findings from different issue families on the same component remain
  // separate (e.g. CrashLoopBackOff and missing-secret both survive for the
  // same pod).
  const pass1Result = pass1ComponentMerge(verifiedHeuristic, nonZeroHypothesisFindings);

  // Build hypothesis support edges from all nonZero hypothesis findings;
  // any edges pointing to findings absorbed by Pass 1 are cleaned up at the
  // end via filterEdgesForRetainedFindings.
  const retainedEdges = filterEdgesForRetainedFindings(allEdges, pass1Result);
  const hypothesisEdges = buildHypothesisSupportEdges(nonZeroHypothesisFindings);
  const combinedEdges = [...retainedEdges, ...hypothesisEdges];

  // ── 7. Pass 2: Title-based dedup ─────────────────────────────────────────
  //
  // Catches cosmetic wording variants that survived Pass 1 because they
  // reference different components (e.g. the same missing Secret affecting
  // two pods, or LLM findings with rephrased titles).  Normalises titles via
  // {@link normalizeTitleForPass2} and keeps the higher-confidence entry per
  // normalised title.  AI findings win title collisions before confidence is
  // compared.
  //
  // The full normalised title is the dedup key — no character-count
  // truncation — so findings that differ only after position 80 are kept.
  const dedupedFindings = pass2TitleDedup(pass1Result);

  // ── 8. Symptom suppression (separate post-dedup filter) ─────────────────
  //
  // This is a distinct, third step — not part of the two dedup passes above.
  // It removes pure-symptom heuristic findings once a root-cause finding
  // covers the same component, cleaning up noise from the report.
  //
  // Suppressed finding types (broad symptoms with no diagnostic specificity):
  //   - 'Not Ready Pod'      (finding:k8s:notready:*) — generic readiness symptom
  //   - 'Pending Pod'        (finding:k8s:pending:*)  — generic scheduling symptom
  //   - 'Unhealthy Workload' (finding:k8s:workload:*) — generic workload symptom
  //
  // Preserved finding types (always kept, even when a root-cause exists):
  //   - CrashLoopBackOff  (finding:k8s:crashloop:*) — names the specific failure mode
  //   - ImagePullBackOff  (finding:k8s:imagepull:*)  — names the specific failure mode
  //
  // For 'Not Ready Pod' and 'Pending Pod': suppress when any root-cause
  //   finding has a component that exactly matches one of the symptom
  //   finding's pod components.
  //
  // For 'Unhealthy Workload': suppress when any root-cause finding has a Pod
  //   component in the same namespace as the workload.  This is a sound proxy
  //   for "the workload's pods are already diagnosed".
  const rootCauseFindings = dedupedFindings.filter(
    (f) =>
      (f.id.startsWith('finding:hypothesis:') && f.confidence >= 0.5) ||
      f.id.startsWith('finding:ai:') ||
      // Graph root-cause findings (created by the graph-driven phase) are
      // treated as root-cause findings for suppression purposes — they are
      // structural diagnoses produced by causal template matching.
      graphRootCauseIds.has(f.id),
  );

  // Collect pod components and namespaces covered by root-cause findings
  const rootCausePodComponents = new Set<string>();
  const rootCausePodNamespaces = new Set<string>();

  for (const rcf of rootCauseFindings) {
    for (const comp of rcf.affectedComponents) {
      if (comp.startsWith('Pod/')) {
        rootCausePodComponents.add(comp);
        const parts = comp.split('/');
        if (parts[1] != null) rootCausePodNamespaces.add(parts[1]);
      }
    }
  }

  const suppressedFindings = dedupedFindings.filter((f) => {
    // Suppress 'Not Ready Pod' and 'Pending Pod' when a root-cause finding
    // covers the same pod. These are broad workload symptoms rather than the
    // actual diagnosis once a stronger root cause is available.
    if (
      f.id.startsWith('finding:k8s:notready:') ||
      f.id.startsWith('finding:k8s:pending:')
    ) {
      return !f.affectedComponents.some((comp) => rootCausePodComponents.has(comp));
    }

    // Suppress 'Unhealthy Workload' when a root-cause finding covers a Pod in
    // the same namespace (the workload's pods have been diagnosed)
    if (f.id.startsWith('finding:k8s:workload:')) {
      return !f.affectedComponents.some((comp) => {
        const parts = comp.split('/');
        const ns = parts[1];
        return ns != null && rootCausePodNamespaces.has(ns);
      });
    }

    return true;
  });

  // ── 7c. Sort by severity desc, then confidence desc ───────────────────────
  // Also stamp confidenceQuality on any finding that still lacks it (synthetic
  // root-cause findings from causal templates and heuristic investigators that
  // bypassed verifyFindings don't get it from the verifier path).
  const sortedFindings = [...suppressedFindings]
    .map((f) =>
      f.confidenceQuality !== undefined
        ? f
        : { ...f, confidenceQuality: computeConfidenceQuality(f) },
    )
    .sort((a, b) => {
      const severityDiff =
        (SEVERITY_ORDER[b.severity] ?? 0) - (SEVERITY_ORDER[a.severity] ?? 0);
      if (severityDiff !== 0) return severityDiff;
      return b.confidence - a.confidence;
    });

  // Final graph cleanup: step 7a/7b can remove findings after the first edge
  // filtering pass, so re-filter once more against the final retained finding
  // set to avoid dangling finding-node references in the investigation graph.
  const finalEdges = filterEdgesForRetainedFindings(combinedEdges, sortedFindings);

  // Build the causal finding tree from the final findings and edges.
  // Only 'causes' edges connect findings in a causal chain — other edge types
  // (supports, contradicts, etc.) are ignored by buildFindingTree.
  const findingTree = buildFindingTree(sortedFindings, finalEdges);

  return {
    findings: sortedFindings,
    edges: finalEdges,
    findingTree,
    seeds,
    clusteredSeeds,
    metadata: {
      seedCount: seeds.length,
      rawFindingCount: rawFindings.length + nonZeroHypothesisFindings.length,
      finalFindingCount: sortedFindings.length,
      aiEnabled,
      aiFindings,
      hypothesesGenerated,
      hypothesesVerified,
      graphMatchedSymptoms,
      seedClusterCount: clusteredSeeds.length,
      seedClusteringEnabled,
    },
  };
}
