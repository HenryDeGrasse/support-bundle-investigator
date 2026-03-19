import type { Finding, FindingSeverity, GraphEdge } from '../types/index.js';
import type { InvestigatorContext, InvestigationSeed } from './types.js';
import { generateSeeds } from './seed-generator.js';
import { investigateKubernetes } from './kubernetes-investigator.js';
import { investigateLog } from './log-investigator.js';
import { investigateConfig } from './config-investigator.js';
import { verifyFindings } from './verifier.js';
import { investigateWithAI } from './ai-investigator.js';
import type { AIInvestigatorDeps } from './ai-investigator.js';
import { generateAllHypotheses } from './hypothesis-generator.js';
import { collectEvidenceForHypothesis } from './hypothesis-evidence-collector.js';
import { rankHypotheses, identifySpecGaps } from './hypothesis-ranker.js';
import {
  convertHypothesisSetsToFindings,
  mergeHypothesisFindings,
} from './hypothesis-converter.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The result produced by a full orchestrated investigation run.
 *
 * - `findings`        — verified, deduplicated, severity-sorted findings
 * - `edges`           — all graph edges produced by every targeted investigator
 * - `seeds`           — seeds generated from the context (for audit / trace)
 * - `metadata`        — counters for seeds, raw vs. final findings
 */
export interface InvestigationResult {
  findings: Finding[];
  edges: GraphEdge[];
  seeds: InvestigationSeed[];
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
 *    {@link investigateLog}, and {@link investigateConfig} run concurrently
 *    (all synchronous, structured for easy parallelisation).
 * 3. **Hypothesis verification** — {@link generateAllHypotheses} generates
 *    competing root-cause candidates per symptom (using the heuristic findings
 *    as input), {@link collectEvidenceForHypothesis} gathers
 *    supporting/contradicting/missing evidence for each, {@link rankHypotheses}
 *    scores and ranks them, and {@link convertHypothesisSetsToFindings} converts
 *    them to {@link Finding}s.  Only hypothesis findings with `confidence > 0`
 *    (at least one supporting evidence item) are kept.  This layer is always
 *    active (heuristic-only, no AI required).
 * 4. **AI investigator** — when {@link aiDeps} is provided, calls
 *    {@link investigateWithAI} and merges its findings into the raw pool.
 *    If the AI call fails, a warning is logged and heuristic results are
 *    returned unchanged (graceful degradation).
 * 5. **Verification** — {@link verifyFindings} runs contradiction checks,
 *    adjusts confidence, detects missing evidence, and deduplicates the
 *    heuristic + AI pool.
 * 6. **Combine** — {@link mergeHypothesisFindings} overlays calibrated
 *    hypothesis findings onto the verified heuristic pool, preferring
 *    hypothesis findings only when they cover the same issue on the same
 *    component. Symptom findings with no hypothesis equivalent are preserved.
 * 7. **Sort** — findings are sorted by severity descending, then confidence
 *    descending, so the most critical / most certain finding appears first.
 *
 * @param context - All parsed bundle data (from the pipeline).
 * @param aiDeps  - Optional AI dependencies. When provided, AI investigation
 *                  is added on top of heuristic investigation.
 * @returns A {@link InvestigationResult} ready for graph integration and
 *          report generation.
 */
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

  // Partition seeds by category so each investigator receives the most
  // relevant hints (investigators still examine all resources, but seeds
  // can be used for future prioritisation).
  const k8sSeeds = seeds.filter((s) => s.category === 'kubernetes');
  const logSeeds = seeds.filter((s) => s.category === 'log');
  const configSeeds = seeds.filter((s) => s.category === 'configuration');

  // ── 2. Run all three heuristic investigators (structurally parallel) ───────
  const k8sResult = investigateKubernetes(context, k8sSeeds);
  const logResult = investigateLog(context, logSeeds);
  const configResult = investigateConfig(context, configSeeds);

  // ── 3. Merge heuristic findings and graph edges ───────────────────────────
  const heuristicFindings: Finding[] = [
    ...k8sResult.findings,
    ...logResult.findings,
    ...configResult.findings,
  ];

  const allEdges: GraphEdge[] = [
    ...k8sResult.edges,
    ...logResult.edges,
    ...configResult.edges,
  ];

  // ── 3a. Hypothesis verification layer (always active, heuristic-only) ─────
  //
  // For each unique symptom (grouped by primary affected component), generate
  // competing root-cause hypotheses, collect structured evidence, score and
  // rank them with calibrated confidence, then convert them to Finding objects.
  //
  // Hypothesis findings are converted into first-class findings and then
  // merged with the heuristic pool using issue-family + component overlap.
  // This preserves symptom findings such as CrashLoopBackOff while allowing a
  // calibrated root-cause hypothesis (for example, Missing Secret) to replace
  // an equivalent heuristic root-cause finding for the same pod.
  //
  // Only hypothesis findings with `confidence > 0` are included (zero-
  // confidence hypotheses have no supporting evidence and add no value).
  let hypothesesGenerated = 0;
  let hypothesesVerified = 0;

  const hypothesisSets = generateAllHypotheses(heuristicFindings, context);

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

  // Convert hypothesis sets to findings, keeping only those with positive
  // confidence (at least one supporting evidence item contributed to the score).
  const allHypothesisFindings = convertHypothesisSetsToFindings(hypothesisSets);
  const nonZeroHypothesisFindings = allHypothesisFindings.filter(
    (hf) => hf.confidence > 0,
  );

  // Deduplicate hypothesis findings that describe the same root cause for the
  // same category. This happens when the same pod appears in multiple symptom
  // groups (e.g. once from k8s findings and once from log findings with an
  // absolute path as component). Keep only the highest-confidence entry per
  // unique (category, rootCauseKey) pair.
  const hypothesisDedupMap = new Map<string, Finding>();
  for (const hf of nonZeroHypothesisFindings) {
    // Extract category from id: "finding:hypothesis:image-pull-failure:N"
    const category = hf.id.split(':')[2] ?? '';
    // Use category + a normalized title as the dedup key
    const titleKey = hf.title
      .replace(/\[Hypothesis\]\s*/i, '')
      .replace(/\(symptom:.*\)$/, '')
      .trim()
      .toLowerCase();
    const dedupKey = `${category}::${titleKey}`;

    const existing = hypothesisDedupMap.get(dedupKey);
    if (existing == null || hf.confidence > existing.confidence) {
      hypothesisDedupMap.set(dedupKey, hf);
    }
  }
  const filteredHypothesisFindings = Array.from(hypothesisDedupMap.values());

  // ── 4. AI investigation (additive, with graceful degradation) ─────────────
  const rawFindings: Finding[] = [...heuristicFindings];
  let aiEnabled = false;
  let aiFindings = 0;

  if (aiDeps !== undefined) {
    try {
      const aiResult = await investigateWithAI(context, seeds, {
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
  const verifiedHeuristic = verifyFindings(rawFindings, context);

  // ── 5a. AI-primary promotion ──────────────────────────────────────────────
  //
  // When AI findings are present, promote them to primary status. Heuristic
  // and hypothesis findings that overlap with AI findings on the same
  // component are folded into the AI finding's evidence as corroborating
  // context rather than appearing as separate top-level findings. This
  // produces a cleaner report where the AI's synthesized root-cause diagnosis
  // is the main finding rather than competing with 5+ symptom-level entries.
  //
  // Heuristic/hypothesis findings with no AI equivalent are preserved.
  const aiFindingsInPool = verifiedHeuristic.filter((f) => f.id.startsWith('finding:ai:'));

  let promotedFindings: Finding[];
  if (aiFindingsInPool.length > 0) {
    const nonAiFindings = verifiedHeuristic.filter((f) => !f.id.startsWith('finding:ai:'));

    // For each AI finding, absorb corroborating heuristic evidence
    const absorbedIds = new Set<string>();
    const enrichedAiFindings = aiFindingsInPool.map((aiFinding) => {
      const corroborating = nonAiFindings.filter((hf) => {
        if (absorbedIds.has(hf.id)) return false;
        return hf.affectedComponents.some((comp) =>
          aiFinding.affectedComponents.some(
            (aiComp) => comp === aiComp || comp.includes(aiComp) || aiComp.includes(comp),
          ),
        );
      });

      for (const hf of corroborating) {
        absorbedIds.add(hf.id);
      }

      // Merge corroborating evidence into the AI finding
      if (corroborating.length > 0) {
        const additionalEvidence = corroborating.flatMap((hf) =>
          hf.evidence.filter(
            (ev) => !aiFinding.evidence.some((existing) => existing.path === ev.path && existing.note === ev.note),
          ),
        );
        const additionalContradictions = corroborating.flatMap((hf) =>
          hf.contradictionsChecked.filter(
            (c) => !aiFinding.contradictionsChecked.includes(c),
          ),
        );

        return {
          ...aiFinding,
          evidence: [...aiFinding.evidence, ...additionalEvidence],
          contradictionsChecked: [...aiFinding.contradictionsChecked, ...additionalContradictions],
        };
      }
      return aiFinding;
    });

    // Keep heuristic findings that weren't absorbed by any AI finding
    const survivingHeuristic = nonAiFindings.filter((hf) => !absorbedIds.has(hf.id));
    promotedFindings = [...enrichedAiFindings, ...survivingHeuristic];
  } else {
    promotedFindings = verifiedHeuristic;
  }

  // ── 6. Combine promoted + filtered hypothesis findings ─────────────────────
  const combinedFindings = mergeHypothesisFindings(
    filteredHypothesisFindings,
    promotedFindings,
  );
  const retainedEdges = filterEdgesForRetainedFindings(allEdges, combinedFindings);
  const hypothesisEdges = buildHypothesisSupportEdges(filteredHypothesisFindings);
  const combinedEdges = [...retainedEdges, ...hypothesisEdges];

  // ── 7a. Final deduplication — remove near-duplicate findings ──────────────
  // Multiple hypothesis sets can produce findings with identical root-cause
  // descriptions (e.g. same hypothesis generated for two symptom groups
  // pointing to the same pod). Deduplicate by normalised title within
  // finding type groups (AI findings compete with AI, heuristic with heuristic).
  // When an AI finding and a heuristic finding have similar titles, prefer
  // the AI finding.
  //
  // The full normalized title is used as the dedup key (no character-count
  // truncation). Truncating to a short prefix would incorrectly merge two
  // legitimately different findings that happen to share a long common prefix.
  const dedupedFindings: Finding[] = [];
  const seenTitles = new Map<string, Finding>();

  // Sort AI findings first so they win title collisions
  const aiFirst = [...combinedFindings].sort((a, b) => {
    const aIsAi = a.id.startsWith('finding:ai:') ? 0 : 1;
    const bIsAi = b.id.startsWith('finding:ai:') ? 0 : 1;
    return aIsAi - bIsAi;
  });

  for (const f of aiFirst) {
    const normTitle = f.title
      .replace(/\[Hypothesis\]\s*/i, '')
      .replace(/\(symptom:.*\)$/i, '')
      .replace(/['']/g, "'")
      .trim()
      .toLowerCase();

    const existing = seenTitles.get(normTitle);
    if (existing == null) {
      seenTitles.set(normTitle, f);
      dedupedFindings.push(f);
    } else if (f.confidence > existing.confidence) {
      // Replace the lower-confidence duplicate
      const idx = dedupedFindings.indexOf(existing);
      if (idx !== -1) {
        dedupedFindings[idx] = f;
      }
      seenTitles.set(normTitle, f);
    }
    // else: skip the lower-confidence duplicate
  }

  // ── 7b. Symptom suppression pass ──────────────────────────────────────────
  // When a root-cause finding (hypothesis with confidence ≥ 0.5, or an AI
  // finding) exists for a component, suppress pure-symptom heuristic findings
  // for the same component so they don't add noise to the report.
  //
  // Suppressed finding types:
  //   - 'Not Ready Pod'      (finding:k8s:notready:*) — generic readiness symptom
  //   - 'Pending Pod'        (finding:k8s:pending:*)  — generic scheduling/volume symptom
  //   - 'Unhealthy Workload' (finding:k8s:workload:*) — generic workload symptom
  //
  // Preserved finding types (even when a root-cause hypothesis exists):
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
      f.id.startsWith('finding:ai:'),
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
  const sortedFindings = [...suppressedFindings].sort((a, b) => {
    const severityDiff =
      (SEVERITY_ORDER[b.severity] ?? 0) - (SEVERITY_ORDER[a.severity] ?? 0);
    if (severityDiff !== 0) return severityDiff;
    return b.confidence - a.confidence;
  });

  // Final graph cleanup: step 7a/7b can remove findings after the first edge
  // filtering pass, so re-filter once more against the final retained finding
  // set to avoid dangling finding-node references in the investigation graph.
  const finalEdges = filterEdgesForRetainedFindings(combinedEdges, sortedFindings);

  return {
    findings: sortedFindings,
    edges: finalEdges,
    seeds,
    metadata: {
      seedCount: seeds.length,
      rawFindingCount: rawFindings.length + filteredHypothesisFindings.length,
      finalFindingCount: sortedFindings.length,
      aiEnabled,
      aiFindings,
      hypothesesGenerated,
      hypothesesVerified,
    },
  };
}
