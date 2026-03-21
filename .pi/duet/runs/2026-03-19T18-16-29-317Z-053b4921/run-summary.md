# Duet run summary

Run ID: 2026-03-19T18-16-29-317Z-053b4921
Phase: completed
Updated: 2026-03-19T19:02:50.277Z
Goal: Implement three diagnostic improvements: (1) Cross-namespace service correlation in the DNS failure evidence collector — when a referenced service is missing from its target namespace, search all namespaces and surface a 'did you mean?' suggestion with the correct URL fix. (2) Confidence calibration — boost confidence from 'weak' to 'strong' when cross-namespace match is found or evidence spans ≥3 artifact types, by adding evidence diversity bonuses in the ranker and updating the confidence quality computation in the verifier. (3) Readiness probe evidence scoping — filter readiness probe evidence to pods in the affected namespace or unhealthy pods only, excluding irrelevant healthy system pods (e.g., kube-system CoreDNS/etcd).
Execution mode: relay
Total steps: 4
Handoff mode: none

## Final plan
- plan.json

## Step outcomes

### 1. Parse two-part Kubernetes DNS short-form hostnames (service.namespace) (step-1)
- Verdict: approve
- Final artifacts: .pi/duet/runs/2026-03-19T18-16-29-317Z-053b4921/steps/1/iteration-2
- Changed files (18):
  - src/cli/rat.ts
  - src/investigators/__tests__/hypothesis-evidence-collector.test.ts
  - src/investigators/config-investigator.ts
  - src/investigators/hypothesis-evidence-collector.ts
  - src/investigators/hypothesis-generator.ts
  - .pi/duet/runs/2026-03-16T19-55-28-917Z-c283c28f
  - .pi/duet/runs/2026-03-16T20-02-17-496Z-d45258d1
  - .pi/duet/runs/2026-03-17T04-14-31-149Z-a4395a84
  - .pi/duet/runs/2026-03-17T16-56-20-343Z-4184d000
  - .pi/duet/runs/2026-03-18T00-23-36-373Z-c30ee659
  - .pi/duet/runs/2026-03-18T03-20-26-247Z-2dd387da
  - .pi/duet/runs/2026-03-18T04-58-10-431Z-6337c4f9
  - .pi/duet/runs/2026-03-18T21-13-21-684Z-0bd167b6
  - .pi/duet/runs/2026-03-19T04-47-28-024Z-eac3309b
  - .pi/duet/runs/2026-03-19T18-16-29-317Z-053b4921
  - ghost-service-bundle-spec.yaml
  - test/fixtures/scenarios/ghost-service/analysis.json
  - test/fixtures/scenarios/ghost-service/cluster-resources
- Checks:
  - lint: passed
  - typecheck: passed
  - unit: passed

### 2. Cross-namespace service correlation in DNS failure evidence collector (step-2)
- Verdict: approve
- Final artifacts: .pi/duet/runs/2026-03-19T18-16-29-317Z-053b4921/steps/2/iteration-2
- Changed files (20):
  - src/cli/rat.ts
  - src/investigators/__tests__/hypothesis-converter.test.ts
  - src/investigators/__tests__/hypothesis-evidence-collector.test.ts
  - src/investigators/config-investigator.ts
  - src/investigators/hypothesis-converter.ts
  - src/investigators/hypothesis-evidence-collector.ts
  - src/investigators/hypothesis-generator.ts
  - .pi/duet/runs/2026-03-16T19-55-28-917Z-c283c28f
  - .pi/duet/runs/2026-03-16T20-02-17-496Z-d45258d1
  - .pi/duet/runs/2026-03-17T04-14-31-149Z-a4395a84
  - .pi/duet/runs/2026-03-17T16-56-20-343Z-4184d000
  - .pi/duet/runs/2026-03-18T00-23-36-373Z-c30ee659
  - .pi/duet/runs/2026-03-18T03-20-26-247Z-2dd387da
  - .pi/duet/runs/2026-03-18T04-58-10-431Z-6337c4f9
  - .pi/duet/runs/2026-03-18T21-13-21-684Z-0bd167b6
  - .pi/duet/runs/2026-03-19T04-47-28-024Z-eac3309b
  - .pi/duet/runs/2026-03-19T18-16-29-317Z-053b4921
  - ghost-service-bundle-spec.yaml
  - test/fixtures/scenarios/ghost-service/analysis.json
  - test/fixtures/scenarios/ghost-service/cluster-resources
- Checks:
  - lint: passed
  - typecheck: passed
  - unit: passed

### 3. Confidence calibration — evidence diversity bonus and cross-namespace boost (step-3)
- Verdict: approve
- Final artifacts: .pi/duet/runs/2026-03-19T18-16-29-317Z-053b4921/steps/3/iteration-2
- Changed files (24):
  - src/cli/rat.ts
  - src/investigators/__tests__/hypothesis-converter.test.ts
  - src/investigators/__tests__/hypothesis-evidence-collector.test.ts
  - src/investigators/__tests__/hypothesis-ranker.test.ts
  - src/investigators/__tests__/verifier.test.ts
  - src/investigators/config-investigator.ts
  - src/investigators/hypothesis-converter.ts
  - src/investigators/hypothesis-evidence-collector.ts
  - src/investigators/hypothesis-generator.ts
  - src/investigators/hypothesis-ranker.ts
  - src/investigators/verifier.ts
  - .pi/duet/runs/2026-03-16T19-55-28-917Z-c283c28f
  - .pi/duet/runs/2026-03-16T20-02-17-496Z-d45258d1
  - .pi/duet/runs/2026-03-17T04-14-31-149Z-a4395a84
  - .pi/duet/runs/2026-03-17T16-56-20-343Z-4184d000
  - .pi/duet/runs/2026-03-18T00-23-36-373Z-c30ee659
  - .pi/duet/runs/2026-03-18T03-20-26-247Z-2dd387da
  - .pi/duet/runs/2026-03-18T04-58-10-431Z-6337c4f9
  - .pi/duet/runs/2026-03-18T21-13-21-684Z-0bd167b6
  - .pi/duet/runs/2026-03-19T04-47-28-024Z-eac3309b
  - ...and 4 more
- Checks:
  - lint: passed
  - typecheck: passed
  - unit: passed

### 4. Scope readiness probe evidence to relevant pods only (step-4)
- Verdict: approve
- Final artifacts: .pi/duet/runs/2026-03-19T18-16-29-317Z-053b4921/steps/4/iteration-2
- Changed files (24):
  - src/cli/rat.ts
  - src/investigators/__tests__/hypothesis-converter.test.ts
  - src/investigators/__tests__/hypothesis-evidence-collector.test.ts
  - src/investigators/__tests__/hypothesis-ranker.test.ts
  - src/investigators/__tests__/verifier.test.ts
  - src/investigators/config-investigator.ts
  - src/investigators/hypothesis-converter.ts
  - src/investigators/hypothesis-evidence-collector.ts
  - src/investigators/hypothesis-generator.ts
  - src/investigators/hypothesis-ranker.ts
  - src/investigators/verifier.ts
  - .pi/duet/runs/2026-03-16T19-55-28-917Z-c283c28f
  - .pi/duet/runs/2026-03-16T20-02-17-496Z-d45258d1
  - .pi/duet/runs/2026-03-17T04-14-31-149Z-a4395a84
  - .pi/duet/runs/2026-03-17T16-56-20-343Z-4184d000
  - .pi/duet/runs/2026-03-18T00-23-36-373Z-c30ee659
  - .pi/duet/runs/2026-03-18T03-20-26-247Z-2dd387da
  - .pi/duet/runs/2026-03-18T04-58-10-431Z-6337c4f9
  - .pi/duet/runs/2026-03-18T21-13-21-684Z-0bd167b6
  - .pi/duet/runs/2026-03-19T04-47-28-024Z-eac3309b
  - ...and 4 more
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
