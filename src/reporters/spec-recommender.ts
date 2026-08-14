import type { Finding } from '../types/index.js';
import type { BundleProfile } from '../types/index.js';
import type { SpecRecommendation } from './types.js';

const LOG_COLLECTOR_DESCRIPTION =
  'Add or expand a `logs` collector to capture container logs for all application pods, not just system namespaces.';

const EVENTS_COLLECTOR_DESCRIPTION =
  'Ensure the `clusterResources` collector includes Kubernetes events (`events` resource type) for all relevant namespaces.';

const COREDNS_LOG_COLLECTOR_DESCRIPTION =
  'Add a `logs` collector targeting CoreDNS pods in the `kube-system` namespace (selector: `k8s-app: kube-dns`) to capture DNS resolution logs that confirm or refute DNS failure hypotheses.';

const NETWORK_POLICY_COLLECTOR_DESCRIPTION =
  'Add or expand the `clusterResources` collector to include `networkpolicies` resource type so that network-path blocking by NetworkPolicy rules can be investigated.';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function getFindingText(finding: Finding): string {
  return `${finding.title} ${finding.reasoningSummary}`.toLowerCase();
}

function isMissingSecretFinding(text: string): boolean {
  return (
    text.includes('missing secret') ||
    (text.includes('secret') && text.includes('missing')) ||
    (text.includes('secret') && text.includes('not found')) ||
    (text.includes('secret') && text.includes('does not exist'))
  );
}

function isImageFinding(text: string): boolean {
  return (
    text.includes('image tag mismatch') ||
    text.includes('image mismatch') ||
    text.includes('imagepullbackoff') ||
    text.includes('image pull')
  );
}

function isMissingServiceFinding(text: string): boolean {
  return (
    text.includes('missing service') ||
    text.includes('missing service reference') ||
    text.includes('service not found') ||
    text.includes('non-existent service') ||
    text.includes('no matching service resource')
  );
}

/**
 * Returns true when the finding title or reasoning summary indicates the
 * finding relied on a heuristic that a deterministic analyzer could replace.
 */
function isCandidateForAnalyzer(finding: Finding): boolean {
  const text = getFindingText(finding);
  return isMissingSecretFinding(text) || isImageFinding(text) || isMissingServiceFinding(text);
}

// ---------------------------------------------------------------------------
// Recommendation 1: Missing collectors (evidence gaps)
// ---------------------------------------------------------------------------

/**
 * Suggests collector additions when findings reference missing evidence that
 * would normally be covered by a known collector type.
 *
 * Rules:
 * - Any finding with missing evidence that mentions "log" → suggest a log
 *   collector for the relevant namespace / pod.
 * - Any finding with missing evidence that mentions "event" → suggest the
 *   Kubernetes events collector.
 * - Any finding with missing evidence that mentions "secret" → suggest the
 *   secrets collector (with appropriate redaction).
 */
function suggestMissingCollectors(findings: Finding[]): SpecRecommendation[] {
  const recommendations: SpecRecommendation[] = [];
  const seen = new Set<string>();

  for (const finding of findings) {
    for (const missing of finding.missingEvidence) {
      const lower = missing.toLowerCase();

      if (lower.includes('log') && !seen.has('collector:logs')) {
        seen.add('collector:logs');
        recommendations.push({
          type: 'collector',
          description: LOG_COLLECTOR_DESCRIPTION,
          rationale: `Finding "${finding.title}" reports missing container log files. Without these logs the investigation cannot determine the root crash reason or distinguish between transient and persistent failures.`,
        });
      }

      if (lower.includes('event') && !seen.has('collector:events')) {
        seen.add('collector:events');
        recommendations.push({
          type: 'collector',
          description: EVENTS_COLLECTOR_DESCRIPTION,
          rationale: `Finding "${finding.title}" reports missing Kubernetes events. Events provide readiness probe failure reasons, scheduler decisions, and pod lifecycle transitions needed to confirm pod-health hypotheses.`,
        });
      }

      if (lower.includes('secret') && !seen.has('collector:secrets')) {
        seen.add('collector:secrets');
        recommendations.push({
          type: 'collector',
          description:
            'Add a `secrets` collector (with a `redact` rule covering secret values) so the bundle captures secret metadata — name, namespace, and key names — without exposing sensitive values.',
          rationale: `Finding "${finding.title}" reports missing secret information. Knowing which secrets exist in the cluster is essential for confirming missing-secret hypotheses without storing sensitive data.`,
        });
      }
    }
  }

  return recommendations;
}

// ---------------------------------------------------------------------------
// Recommendation 2: Missing analyzers (heuristic → deterministic upgrades)
// ---------------------------------------------------------------------------

/**
 * Suggests analyzer additions when heuristic findings could be replaced with
 * deterministic analysis, improving precision and repeatability.
 *
 * Rules:
 * - Secret-existence findings → suggest a `secret-existence` analyzer that
 *   resolves every pod's `secretRef` and `secretKeyRef` against existing secrets.
 * - Image-mismatch or ImagePullBackOff findings → suggest an `imageTag`
 *   analyzer that compares the pod spec image against the running container
 *   image reported in the pod status.
 * - Missing-service findings → suggest a `serviceAvailability` analyzer.
 */
function suggestMissingAnalyzers(findings: Finding[]): SpecRecommendation[] {
  const recommendations: SpecRecommendation[] = [];
  const seen = new Set<string>();

  for (const finding of findings) {
    if (!isCandidateForAnalyzer(finding)) continue;

    const text = getFindingText(finding);

    if (isMissingSecretFinding(text) && !seen.has('analyzer:secret-existence')) {
      seen.add('analyzer:secret-existence');
      recommendations.push({
        type: 'analyzer',
        description:
          'Add a `secret-existence` analyzer that resolves every pod `secretRef` and `secretKeyRef` against the set of secrets present in the cluster, reporting an error when a referenced secret is absent.',
        rationale: `Finding "${finding.title}" was produced by a heuristic that cross-references pod specs with collected secret resources. A deterministic analyzer would make this check repeatable, faster, and more precise across all namespaces.`,
      });
    }

    if (isImageFinding(text) && !seen.has('analyzer:image-tag')) {
      seen.add('analyzer:image-tag');
      recommendations.push({
        type: 'analyzer',
        description:
          'Add an `imageTag` analyzer that compares the image specified in the pod spec against the image currently reported in the pod status, flagging mismatches or pull-backoff states as errors.',
        rationale: `Finding "${finding.title}" was produced by a heuristic that detects image-related failures from pod status and events. A deterministic analyzer would detect this class of failure reliably without depending on log pattern matching.`,
      });
    }

    if (isMissingServiceFinding(text) && !seen.has('analyzer:service-availability')) {
      seen.add('analyzer:service-availability');
      recommendations.push({
        type: 'analyzer',
        description:
          'Add a `serviceAvailability` analyzer that validates that every Service referenced by environment variables or config values in pod specs actually exists in the cluster.',
        rationale: `Finding "${finding.title}" was produced by a heuristic matching environment variable hostnames against collected Service resources. A deterministic analyzer would make this check reliable and namespace-aware.`,
      });
    }
  }

  return recommendations;
}

// ---------------------------------------------------------------------------
// Recommendation 3: Coverage improvements from profile gaps
// ---------------------------------------------------------------------------

/**
 * Suggests coverage improvements based on gaps noted in the bundle profile.
 *
 * Each entry in `profile.coverageGaps` is expected to be a human-readable
 * string describing what is missing (e.g. "no log files found").  This
 * function maps common gap descriptions to concrete collector or analyzer
 * recommendations.
 */
function suggestCoverageImprovements(profile: BundleProfile): SpecRecommendation[] {
  const recommendations: SpecRecommendation[] = [];
  const seen = new Set<string>();

  for (const gap of profile.coverageGaps) {
    const lower = gap.toLowerCase();

    if (
      (lower.includes('no log') || lower.includes('log files') || lower.includes('logs missing')) &&
      !seen.has('coverage:logs')
    ) {
      seen.add('coverage:logs');
      recommendations.push({
        type: 'collector',
        description: LOG_COLLECTOR_DESCRIPTION,
        rationale: `Bundle profile coverage gap: "${gap}". Container logs are essential for diagnosing crash loops, connection errors, and application startup failures.`,
      });
    }

    if (
      (lower.includes('no event') || lower.includes('events missing') || lower.includes('no kubernetes event')) &&
      !seen.has('coverage:events')
    ) {
      seen.add('coverage:events');
      recommendations.push({
        type: 'collector',
        description: EVENTS_COLLECTOR_DESCRIPTION,
        rationale: `Bundle profile coverage gap: "${gap}". Kubernetes events provide scheduler decisions, probe failures, and pod lifecycle transitions that are critical for root-cause analysis.`,
      });
    }

    if (
      (lower.includes('no analyzer') || lower.includes('analyzer') && lower.includes('missing')) &&
      !seen.has('coverage:analyzers')
    ) {
      seen.add('coverage:analyzers');
      recommendations.push({
        type: 'analyzer',
        description:
          'Add Troubleshoot analyzers appropriate for your application (e.g. secret-existence, resource-quota, node-conditions). The current bundle has no analyzer output, so deterministic checks are absent.',
        rationale: `Bundle profile coverage gap: "${gap}". Analyzer results anchor investigation by providing deterministic pass/fail signals before heuristic investigation begins.`,
      });
    }

    if (
      lower.includes('no helm') ||
      (lower.includes('helm') && lower.includes('missing')) ||
      lower.includes('no release')
    ) {
      if (!seen.has('coverage:helm')) {
        seen.add('coverage:helm');
        recommendations.push({
          type: 'collector',
          description:
            'Add a `helm` collector to capture Helm release metadata — chart version, values, and deployment history — so configuration drift and version mismatches can be detected.',
          rationale: `Bundle profile coverage gap: "${gap}". Helm release data provides the desired configuration state and version history, which is critical for detecting configuration drift.`,
        });
      }
    }

    if (
      (lower.includes('redact') || lower.includes('sensitive') || lower.includes('secret value')) &&
      !seen.has('coverage:redaction')
    ) {
      seen.add('coverage:redaction');
      recommendations.push({
        type: 'redaction',
        description:
          'Add redaction rules for known secret paths (e.g. `/var/run/secrets`, environment variables with names matching `*_PASSWORD`, `*_TOKEN`, `*_KEY`) before collecting secret or config data.',
        rationale: `Bundle profile coverage gap: "${gap}". Without redaction rules, collecting secrets or configuration data risks exposing sensitive values in the bundle archive.`,
      });
    }
  }

  return recommendations;
}

// ---------------------------------------------------------------------------
// Recommendation 4: Hypothesis-layer evidence gaps
// ---------------------------------------------------------------------------

/**
 * Returns `true` when the finding was produced by the hypothesis or AI
 * analysis layers.  Both of these finding types may carry `missingEvidence`
 * entries that describe decisive data gaps — unlike lower-level heuristic
 * findings whose missing-evidence entries are already handled by
 * `suggestMissingCollectors`.
 *
 * Eligible prefixes:
 * - `finding:hypothesis:` — findings from the hypothesis/differential-diagnosis layer
 * - `finding:ai:` — findings from the LLM / AI investigation layer
 */
function isEligibleForGapAnalysis(finding: Finding): boolean {
  return (
    finding.id.startsWith('finding:hypothesis:') || finding.id.startsWith('finding:ai:')
  );
}

/**
 * Extracts the symptom text embedded in a legacy hypothesis finding title.
 *
 * Older hypothesis findings were rendered as:
 *   `[Hypothesis] <root cause> (symptom: <symptom text>)`
 *
 * Newer findings store only the root-cause text in `title`, so this helper
 * returns `null` for current-format titles and callers fall back to structured
 * component-based grouping.
 */
function extractHypothesisSymptom(finding: Finding): string | null {
  const title = finding.title.trimEnd();
  if (!title.endsWith(')')) return null;

  const marker = '(symptom:';
  const markerIndex = title.toLowerCase().lastIndexOf(marker);
  if (markerIndex < 0) return null;

  return title.slice(markerIndex + marker.length, -1).trim() || null;
}

/**
 * Returns the grouping key used for close-confidence disambiguation.
 *
 * Differential-diagnosis comparisons should happen within a single symptom's
 * hypothesis set, not across unrelated symptoms. When the structured symptom
 * text is unavailable, we fall back to the affected component set; if neither
 * is present we conservatively place findings into a single catch-all group so
 * older tests and synthetic fixtures still receive disambiguation behaviour.
 */
function getHypothesisDisambiguationGroupKey(finding: Finding): string {
  const symptom = extractHypothesisSymptom(finding);
  if (symptom !== null) return `symptom:${symptom.toLowerCase()}`;

  if (finding.affectedComponents.length > 0) {
    return `components:${finding.affectedComponents.join('|').toLowerCase()}`;
  }

  return 'all-hypotheses';
}

/**
 * Chooses the most useful missing-evidence item for distinguishing two nearby
 * hypotheses.
 *
 * Preference order:
 * 1. Evidence missing only from the higher-confidence hypothesis
 * 2. Evidence missing only from the second hypothesis
 * 3. The first available missing-evidence item from either hypothesis
 */
function chooseDistinguishingEvidence(top: Finding, second: Finding): string | null {
  const topMissing = top.missingEvidence.filter((item) => item.trim().length > 0);
  const secondMissing = second.missingEvidence.filter((item) => item.trim().length > 0);

  const secondSet = new Set(secondMissing.map((item) => item.toLowerCase()));
  const uniqueTop = topMissing.find((item) => !secondSet.has(item.toLowerCase()));
  if (uniqueTop !== undefined) return uniqueTop;

  const topSet = new Set(topMissing.map((item) => item.toLowerCase()));
  const uniqueSecond = secondMissing.find((item) => !topSet.has(item.toLowerCase()));
  if (uniqueSecond !== undefined) return uniqueSecond;

  return topMissing[0] ?? secondMissing[0] ?? null;
}

/**
 * Generates spec recommendations from evidence gaps surfaced by the
 * hypothesis and AI analysis layers.
 *
 * Both layers embed `missingEvidence` entries that describe decisive data not
 * present in the bundle.  This function maps those descriptions to concrete
 * collector recommendations:
 *
 * - CoreDNS / kube-dns references → suggest a CoreDNS log collector targeting
 *   the `kube-system` namespace.
 * - NetworkPolicy references → suggest expanding the `clusterResources`
 *   collector to include `networkpolicies`.
 * - When the top two eligible findings for the same symptom/group have
 *   confidence within 0.15 of each other, a recommendation is generated for
 *   evidence that would distinguish between them, preferring missing evidence
 *   unique to one of the competing findings.
 *
 * Eligible finding types (see `isEligibleForGapAnalysis`):
 * - `finding:hypothesis:*` — hypothesis/differential-diagnosis layer findings
 * - `finding:ai:*`         — LLM / AI investigation layer findings
 *
 * Lower-level heuristic findings (`finding:k8s:*`, `finding:log:*`, etc.) are
 * not processed here — they are handled by the sibling `suggestMissingCollectors`
 * function.
 *
 * @param findings - All findings from the investigation (may include hypothesis,
 *                   AI, and heuristic findings).
 * @returns Collector recommendations derived from hypothesis/AI-layer evidence gaps.
 */
function suggestFromHypothesisGaps(findings: Finding[]): SpecRecommendation[] {
  const recommendations: SpecRecommendation[] = [];
  const seen = new Set<string>();

  const hypothesisFindings = findings.filter(isEligibleForGapAnalysis);

  // Map missingEvidence entries to specific collector types.
  for (const finding of hypothesisFindings) {
    for (const missing of finding.missingEvidence) {
      const lower = missing.toLowerCase();

      if (
        (lower.includes('coredns') || lower.includes('kube-dns')) &&
        !seen.has('hypothesis:collector:coredns')
      ) {
        seen.add('hypothesis:collector:coredns');
        recommendations.push({
          type: 'collector',
          description: COREDNS_LOG_COLLECTOR_DESCRIPTION,
          rationale: `Hypothesis finding "${finding.title}" reports missing CoreDNS/kube-dns logs: "${missing}". These logs would confirm or refute DNS failure as the root cause.`,
        });
      }

      if (lower.includes('networkpolicy') && !seen.has('hypothesis:collector:networkpolicy')) {
        seen.add('hypothesis:collector:networkpolicy');
        recommendations.push({
          type: 'collector',
          description: NETWORK_POLICY_COLLECTOR_DESCRIPTION,
          rationale: `Hypothesis finding "${finding.title}" reports missing NetworkPolicy data: "${missing}". NetworkPolicy rules may be blocking the network path between services.`,
        });
      }
    }
  }

  // Close-confidence detection: compare the top two hypotheses *within each
  // symptom-level hypothesis set*. This avoids recommending disambiguation for
  // unrelated symptoms that just happen to have similar confidence scores.
  const findingsByGroup = new Map<string, Finding[]>();
  for (const finding of hypothesisFindings) {
    const groupKey = getHypothesisDisambiguationGroupKey(finding);
    const existing = findingsByGroup.get(groupKey);
    if (existing !== undefined) {
      existing.push(finding);
    } else {
      findingsByGroup.set(groupKey, [finding]);
    }
  }

  for (const [groupKey, groupedFindings] of findingsByGroup) {
    if (groupedFindings.length < 2) continue;

    const sorted = [...groupedFindings].sort((a, b) => b.confidence - a.confidence);
    const top = sorted[0]!;
    const second = sorted[1]!;

    if (top.confidence - second.confidence > 0.15) continue;

    const distinctiveEvidence = chooseDistinguishingEvidence(top, second);
    if (distinctiveEvidence === null || seen.has(`hypothesis:distinguish:${groupKey}`)) continue;

    seen.add(`hypothesis:distinguish:${groupKey}`);
    const topConfPct = Math.round(top.confidence * 100);
    const secondConfPct = Math.round(second.confidence * 100);
    const symptom = extractHypothesisSymptom(top);
    const symptomContext = symptom !== null ? ` for symptom "${symptom}"` : '';

    recommendations.push({
      type: 'collector',
      description: `Collect additional evidence to distinguish between competing hypotheses${symptomContext}: "${top.title}" (${topConfPct}% confidence) vs "${second.title}" (${secondConfPct}% confidence). Specifically: ${distinctiveEvidence}`,
      rationale: `The top two hypotheses${symptomContext} have close confidence levels (${topConfPct}% vs ${secondConfPct}%), making it difficult to determine the definitive root cause. Collecting the missing evidence would resolve this ambiguity.`,
    });
  }

  return recommendations;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generates a prioritised list of {@link SpecRecommendation}s by inspecting
 * investigation findings and the bundle profile for evidence gaps.
 *
 * Three types of recommendation are produced:
 *
 * 1. **Collector suggestions** — when findings include missing-evidence entries
 *    that point to absent log files, events, or secret metadata, a `collector`
 *    recommendation is generated so future bundles contain the required data.
 *
 * 2. **Analyzer suggestions** — when a heuristic finding could be replaced by a
 *    deterministic Troubleshoot analyzer (e.g. secret-existence, imageTag), an
 *    `analyzer` recommendation is generated to improve precision and repeatability.
 *
 * 3. **Coverage improvements** — `profile.coverageGaps` entries are mapped to
 *    concrete collector or redaction recommendations so the next bundle is more
 *    complete.
 *
 * Duplicate recommendations of the same type and target are suppressed; only
 * the first occurrence is returned.
 *
 * @param findings - Verified findings from the investigation pipeline.
 * @param profile  - Bundle profile describing what was (and was not) collected.
 * @returns A list of {@link SpecRecommendation}s, ordered by category:
 *          collector suggestions first, then analyzer, then redaction.
 */
export function generateSpecRecommendations(
  findings: Finding[],
  profile: BundleProfile,
): SpecRecommendation[] {
  const collectorFromFindings = suggestMissingCollectors(findings);
  const hypothesisGapSuggestions = suggestFromHypothesisGaps(findings);
  const analyzerSuggestions = suggestMissingAnalyzers(findings);
  const coverageSuggestions = suggestCoverageImprovements(profile);

  // Merge coverage suggestions into the appropriate category lists, preserving
  // the type ordering: collector → analyzer → redaction.
  const collectorRecs = [
    ...collectorFromFindings,
    ...hypothesisGapSuggestions.filter((r) => r.type === 'collector'),
    ...coverageSuggestions.filter((r) => r.type === 'collector'),
  ];
  const analyzerRecs = [
    ...analyzerSuggestions,
    ...hypothesisGapSuggestions.filter((r) => r.type === 'analyzer'),
    ...coverageSuggestions.filter((r) => r.type === 'analyzer'),
  ];
  const redactionRecs = [
    ...hypothesisGapSuggestions.filter((r) => r.type === 'redaction'),
    ...coverageSuggestions.filter((r) => r.type === 'redaction'),
  ];

  // Deduplicate across merged lists by (type, description) so a coverage gap
  // and a finding gap for the same resource don't both produce a recommendation.
  const seen = new Set<string>();
  const result: SpecRecommendation[] = [];

  for (const rec of [...collectorRecs, ...analyzerRecs, ...redactionRecs]) {
    const key = `${rec.type}:${rec.description}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(rec);
    }
  }

  return result;
}
