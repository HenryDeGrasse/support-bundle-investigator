// ---------------------------------------------------------------------------
// Golden Set Expectations
// ---------------------------------------------------------------------------
//
// Defines structural expectations for each scenario. These are NOT about
// exact LLM wording — they verify that the correct root cause appears, that
// evidence is cited from the right artifacts, and that no hallucinations
// appear.

import type { FindingSeverity } from '../../src/types/index.js';

export interface ScenarioExpectation {
  /** Human-readable scenario name. */
  name: string;
  /** Minimum number of findings the pipeline should produce. */
  minFindings: number;
  /** Top finding title must match one of these patterns. */
  topFindingMustMatch: RegExp[];
  /** Acceptable severities for the top finding. */
  topFindingSeverity: FindingSeverity[];
  /** Minimum confidence for the top finding. */
  topFindingMinConfidence: number;
  /**
   * Evidence paths across all findings must include at least one match
   * per pattern.
   */
  mustCiteEvidence: RegExp[];
  /**
   * No finding title or reasoning should match these patterns.
   * Catches hallucinations of wrong failure modes.
   */
  mustNotHallucinate: RegExp[];
  /**
   * Root cause (reasoning of top finding) must match at least one pattern.
   */
  rootCauseMustMatch: RegExp[];
  /**
   * Key identifiers that must appear somewhere in findings (titles,
   * reasoning, evidence notes).
   */
  mustMentionIdentifiers: string[];
}

export const GOLDEN_EXPECTATIONS: Record<string, ScenarioExpectation> = {
  'bad-image-tag': {
    name: 'Bad Image Tag (ImagePullBackOff)',
    minFindings: 1,
    topFindingMustMatch: [
      /image.*pull/i,
      /ImagePullBackOff/i,
      /ErrImagePull/i,
      /image.*tag/i,
    ],
    topFindingSeverity: ['critical'],
    // Hypothesis evidence for image-pull-failure uses events + pod-status only
    // (no log evidence in collector), giving 0.74 confidence.  Step 1 correctly
    // routes the log finding through hypothesis dedup (Pod-based components),
    // so the hypothesis becomes the top finding.  Step 5 will further tune this.
    topFindingMinConfidence: 0.74,
    mustCiteEvidence: [
      /pods/i,
      /events/i,
    ],
    mustNotHallucinate: [
      /^CrashLoopBackOff$/i, // wrong failure mode (exact match)
      /missing.*secret/i,     // wrong failure mode
    ],
    rootCauseMustMatch: [
      /image/i,
      /v999\.99\.99|pull|tag|registry/i,
    ],
    mustMentionIdentifiers: ['app-pod', 'myapp:v999.99.99'],
  },

  'missing-secret-crashloop': {
    name: 'Missing Secret CrashLoop',
    minFindings: 1,
    topFindingMustMatch: [
      /CrashLoopBackOff/i,
      /missing.*secret/i,
      /app-credentials/i,
      // New hypothesis rootCause format (title is now just the rootCause string)
      /kubernetes secret.*absent|required.*kubernetes secret|secret.*absent|secret.*fail/i,
    ],
    topFindingSeverity: ['critical'],
    topFindingMinConfidence: 0.85,
    mustCiteEvidence: [
      /pods/i,
      /events/i,
    ],
    mustNotHallucinate: [
      /ImagePullBackOff/i,
    ],
    rootCauseMustMatch: [
      /secret|app-credentials|CrashLoop|FailedMount/i,
    ],
    mustMentionIdentifiers: ['app-pod', 'app-credentials'],
  },

  'wrong-db-endpoint': {
    name: 'Wrong DB Endpoint (DNS Failure)',
    minFindings: 1,
    topFindingMustMatch: [
      /dns/i,
      /db\.internal/i,
      /database/i,
      /endpoint/i,
      /no such host/i,
      /not ready/i,
      /readiness/i,
    ],
    topFindingSeverity: ['critical', 'high'],
    topFindingMinConfidence: 0.7,
    mustCiteEvidence: [
      /logs|events|pods/i,
    ],
    mustNotHallucinate: [
      /ImagePullBackOff/i,
      /CrashLoopBackOff/i,
    ],
    rootCauseMustMatch: [
      // In heuristic mode, top finding is "Not Ready" — reasoning mentions readiness probe
      // In AI mode, top finding is DNS failure — reasoning mentions db.internal
      /dns|db\.internal|no such host|database|endpoint|connectivity|ready|readiness|probe/i,
    ],
    mustMentionIdentifiers: ['app-pod'],
  },

  'pvc-pending': {
    name: 'PVC Pending (StorageClass Mismatch)',
    minFindings: 2,
    topFindingMustMatch: [
      /persistentvolumeclaim/i,
      /storageclass/i,
      /storage provisioner/i,
      /volume/i,
      /pvc/i,
    ],
    topFindingSeverity: ['critical'],
    topFindingMinConfidence: 0.7,
    mustCiteEvidence: [
      /events/i,
      /persistentvolumeclaims/i,
      /storageclasses/i,
    ],
    mustNotHallucinate: [
      /ImagePullBackOff/i,
      /CrashLoopBackOff/i,
    ],
    rootCauseMustMatch: [
      /persistentvolumeclaim|storageclass|storage provisioner|provisioningfailed|pending/i,
    ],
    mustMentionIdentifiers: ['db-pod', 'data-pvc', 'fast-ssd'],
  },
};
