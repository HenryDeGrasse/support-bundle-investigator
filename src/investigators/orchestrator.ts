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
export async function runInvestigation(
  context: InvestigatorContext,
  aiDeps?: AIInvestigatorDeps,
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
  const filteredHypothesisFindings = allHypothesisFindings.filter(
    (hf) => hf.confidence > 0,
  );

  // ── 4. AI investigation (additive, with graceful degradation) ─────────────
  const rawFindings: Finding[] = [...heuristicFindings];
  let aiEnabled = false;
  let aiFindings = 0;

  if (aiDeps !== undefined) {
    try {
      const aiResult = await investigateWithAI(context, seeds, aiDeps);
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

  // ── 6. Combine verified heuristic + filtered hypothesis findings ───────────
  const combinedFindings = mergeHypothesisFindings(
    filteredHypothesisFindings,
    verifiedHeuristic,
  );
  const retainedEdges = filterEdgesForRetainedFindings(allEdges, combinedFindings);
  const hypothesisEdges = buildHypothesisSupportEdges(filteredHypothesisFindings);
  const combinedEdges = [...retainedEdges, ...hypothesisEdges];

  // ── 7. Sort by severity desc, then confidence desc ────────────────────────
  const sortedFindings = [...combinedFindings].sort((a, b) => {
    const severityDiff =
      (SEVERITY_ORDER[b.severity] ?? 0) - (SEVERITY_ORDER[a.severity] ?? 0);
    if (severityDiff !== 0) return severityDiff;
    return b.confidence - a.confidence;
  });

  return {
    findings: sortedFindings,
    edges: combinedEdges,
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
