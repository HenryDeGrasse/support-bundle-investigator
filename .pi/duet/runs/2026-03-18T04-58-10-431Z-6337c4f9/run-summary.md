# Duet run summary

Run ID: 2026-03-18T04-58-10-431Z-6337c4f9
Phase: completed
Updated: 2026-03-18T10:45:08.191Z
Goal: Improve output quality of the support bundle analyzer across all four scenarios (bad-image-tag, missing-secret-crashloop, wrong-db-endpoint, pvc-pending). Fix five categories of quality issues: (1) log investigator uses absolute temp paths as affected components instead of Pod identifiers, breaking AI absorption and dedup; (2) hypothesis finding titles carry machine-readable [Hypothesis] prefix and (symptom:...) suffix into JSON/HTML output; (3) JSON and HTML reporters don't apply cleanEvidencePath or humanizeTitle, leaking raw absolute paths; (4) orchestrator dedup uses title-string similarity instead of category-aware matching, and doesn't suppress symptom findings already explained by a root-cause finding; (5) pvc-pending scenario is effectively undiagnosed because the k8s investigator has no Pending Pod detector. Ideal end state per scenario: bad-image-tag → 3 findings (image-pull root cause + 2 alternatives), missing-secret-crashloop → 3 findings (missing-secret root cause + CrashLoopBackOff symptom + 1 alternative), wrong-db-endpoint → 4 findings (DNS failure root cause + connectivity alternative + readiness alternative + connection timeout corroboration), pvc-pending → 3 findings (volume-mount-failure root cause naming the missing StorageClass 'fast-ssd' + unhealthy workload + missing resource logs). All finding titles clean, evidence paths bundle-relative, no redundant entries. The existing benchmark expectation of 'missing-secret' for pvc-pending is WRONG — the actual root cause is a storage class mismatch (ProvisioningFailed: storageclass 'fast-ssd' not found), not a missing secret. The benchmark must be updated to expect a new 'volume-mount-failure' category. Note on LLM-as-judge for benchmark: overkill for this project size — deterministic category assertions on 4 scenarios are more reliable and faster.
Execution mode: relay
Total steps: 5
Handoff mode: none

## Final plan
- plan.json

## Step outcomes

### 1. Fix log investigator to use Pod-based affected components and clean evidence paths (step-1)
- Verdict: approve
- Final artifacts: .pi/duet/runs/2026-03-18T04-58-10-431Z-6337c4f9/steps/1/iteration-2
- Changed files (10):
  - src/investigators/__tests__/log-investigator.test.ts
  - src/investigators/log-investigator.ts
  - test/golden/expectations.ts
  - .pi/duet/runs/2026-03-16T19-55-28-917Z-c283c28f
  - .pi/duet/runs/2026-03-16T20-02-17-496Z-d45258d1
  - .pi/duet/runs/2026-03-17T04-14-31-149Z-a4395a84
  - .pi/duet/runs/2026-03-17T16-56-20-343Z-4184d000
  - .pi/duet/runs/2026-03-18T00-23-36-373Z-c30ee659
  - .pi/duet/runs/2026-03-18T03-20-26-247Z-2dd387da
  - .pi/duet/runs/2026-03-18T04-58-10-431Z-6337c4f9
- Checks:
  - lint: passed
  - typecheck: passed
  - unit: passed
  - build: passed

### 2. Clean hypothesis finding titles and apply display helpers in JSON/HTML reporters (step-2)
- Verdict: approve
- Final artifacts: .pi/duet/runs/2026-03-18T04-58-10-431Z-6337c4f9/steps/2/iteration-3
- Changed files (21):
  - src/investigators/__tests__/hypothesis-converter.test.ts
  - src/investigators/__tests__/log-investigator.test.ts
  - src/investigators/hypothesis-converter.ts
  - src/investigators/log-investigator.ts
  - src/reporters/__tests__/display-helpers.test.ts
  - src/reporters/__tests__/html-reporter.test.ts
  - src/reporters/__tests__/json-reporter.test.ts
  - src/reporters/__tests__/report-builder.test.ts
  - src/reporters/display-helpers.ts
  - src/reporters/html-reporter.ts
  - src/reporters/json-reporter.ts
  - src/reporters/report-builder.ts
  - src/reporters/spec-recommender.ts
  - test/golden/expectations.ts
  - .pi/duet/runs/2026-03-16T19-55-28-917Z-c283c28f
  - .pi/duet/runs/2026-03-16T20-02-17-496Z-d45258d1
  - .pi/duet/runs/2026-03-17T04-14-31-149Z-a4395a84
  - .pi/duet/runs/2026-03-17T16-56-20-343Z-4184d000
  - .pi/duet/runs/2026-03-18T00-23-36-373Z-c30ee659
  - .pi/duet/runs/2026-03-18T03-20-26-247Z-2dd387da
  - ...and 1 more
- Checks:
  - lint: passed
  - typecheck: passed
  - unit: passed
  - build: passed

### 3. Improve orchestrator dedup, symptom suppression, and AI absorption (step-3)
- Verdict: approve
- Final artifacts: .pi/duet/runs/2026-03-18T04-58-10-431Z-6337c4f9/steps/3/iteration-3
- Changed files (23):
  - src/investigators/__tests__/hypothesis-converter.test.ts
  - src/investigators/__tests__/log-investigator.test.ts
  - src/investigators/__tests__/orchestrator.test.ts
  - src/investigators/hypothesis-converter.ts
  - src/investigators/log-investigator.ts
  - src/investigators/orchestrator.ts
  - src/reporters/__tests__/display-helpers.test.ts
  - src/reporters/__tests__/html-reporter.test.ts
  - src/reporters/__tests__/json-reporter.test.ts
  - src/reporters/__tests__/report-builder.test.ts
  - src/reporters/display-helpers.ts
  - src/reporters/html-reporter.ts
  - src/reporters/json-reporter.ts
  - src/reporters/report-builder.ts
  - src/reporters/spec-recommender.ts
  - test/golden/expectations.ts
  - .pi/duet/runs/2026-03-16T19-55-28-917Z-c283c28f
  - .pi/duet/runs/2026-03-16T20-02-17-496Z-d45258d1
  - .pi/duet/runs/2026-03-17T04-14-31-149Z-a4395a84
  - .pi/duet/runs/2026-03-17T16-56-20-343Z-4184d000
  - ...and 3 more
- Checks:
  - lint: passed
  - typecheck: passed
  - unit: passed
  - build: passed

### 4. Add Pending Pod detection, volume-mount-failure hypothesis category, and fix benchmark (step-4)
- Verdict: approve
- Final artifacts: .pi/duet/runs/2026-03-18T04-58-10-431Z-6337c4f9/steps/4/iteration-3
- Changed files (29):
  - scripts/benchmark-hypotheses.mjs
  - src/investigators/__tests__/hypothesis-converter.test.ts
  - src/investigators/__tests__/kubernetes-investigator.test.ts
  - src/investigators/__tests__/log-investigator.test.ts
  - src/investigators/__tests__/orchestrator.test.ts
  - src/investigators/hypothesis-converter.ts
  - src/investigators/hypothesis-evidence-collector.ts
  - src/investigators/hypothesis-generator.ts
  - src/investigators/hypothesis-types.ts
  - src/investigators/kubernetes-investigator.ts
  - src/investigators/log-investigator.ts
  - src/investigators/orchestrator.ts
  - src/reporters/__tests__/display-helpers.test.ts
  - src/reporters/__tests__/html-reporter.test.ts
  - src/reporters/__tests__/json-reporter.test.ts
  - src/reporters/__tests__/report-builder.test.ts
  - src/reporters/display-helpers.ts
  - src/reporters/html-reporter.ts
  - src/reporters/json-reporter.ts
  - src/reporters/report-builder.ts
  - ...and 9 more
- Checks:
  - lint: passed
  - typecheck: passed
  - unit: passed
  - build: passed

### 5. End-to-end scenario quality verification and benchmark validation (step-5)
- Verdict: approve
- Final artifacts: .pi/duet/runs/2026-03-18T04-58-10-431Z-6337c4f9/steps/5/iteration-3
- Changed files (30):
  - scripts/benchmark-hypotheses.mjs
  - src/investigators/__tests__/hypothesis-converter.test.ts
  - src/investigators/__tests__/kubernetes-investigator.test.ts
  - src/investigators/__tests__/log-investigator.test.ts
  - src/investigators/__tests__/orchestrator.test.ts
  - src/investigators/hypothesis-converter.ts
  - src/investigators/hypothesis-evidence-collector.ts
  - src/investigators/hypothesis-generator.ts
  - src/investigators/hypothesis-types.ts
  - src/investigators/kubernetes-investigator.ts
  - src/investigators/log-investigator.ts
  - src/investigators/orchestrator.ts
  - src/reporters/__tests__/display-helpers.test.ts
  - src/reporters/__tests__/html-reporter.test.ts
  - src/reporters/__tests__/json-reporter.test.ts
  - src/reporters/__tests__/report-builder.test.ts
  - src/reporters/display-helpers.ts
  - src/reporters/html-reporter.ts
  - src/reporters/json-reporter.ts
  - src/reporters/report-builder.ts
  - ...and 10 more
- Checks:
  - lint: passed
  - typecheck: passed
  - unit: passed
  - build: passed

## Preserved artifacts
- config.snapshot.json
- state.json
- plan.json
- final step artifact directories
- escalation directories
- operator-notes.md (if present)
- interventions.jsonl (if present)
- interventions.1.jsonl (if rotated)
