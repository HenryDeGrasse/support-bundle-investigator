# Evaluation and Testing

SBI uses a layered evaluation strategy: golden scenario evals for correctness, retrieval benchmarks for search quality, robustness tests for failure-mode discipline, sensitive-data tests for trust, and performance benchmarks for throughput.

---

## Quick Reference

| Command | What it does | Requires API key? |
|---|---|---|
| `npm run unit` | Full test suite (3800+ tests, 97 files) | No |
| `npm run eval:golden` | Golden scorecard across all 9 scenarios | No |
| `npm run eval:cassette` | AI replay eval using recorded LLM cassettes | No |
| `npm run audit` | Full self-test audit: dedup, confidence quality, finding counts | No (requires build) |
| `npm run benchmark:hypotheses` | Heuristic diagnosis quality + confidence calibration | No (requires build) |
| `npm run benchmark:retrieval` | Retrieval P@5, R@5, MRR across scenarios | No (requires build) |
| `npm run test:robustness` | Corrupt/truncated/oversized/partial bundle handling | No |
| `npm run test:sensitive` | Sensitive-data leakage protection | No |
| `npm run test:perf` | Per-scenario throughput benchmarks | No |

---

## 1. Golden Scenario Evaluation

**Location:** `test/golden/`

Nine fixture scenarios, each with structural expectations defined in `test/golden/expectations.ts`:

| Check | Description |
|---|---|
| `minFindings` | Pipeline produces at least N findings |
| `topFindingTitle` | Top finding title matches one of the expected patterns |
| `topFindingSeverity` | Top finding severity is in the expected set |
| `topFindingConfidence` | Top finding confidence meets the minimum threshold |
| `mustCiteEvidence` | Evidence paths cite the expected artifact types |
| `mustNotHallucinate` | No finding mentions wrong failure modes |
| `rootCauseMatch` | Top finding reasoning matches expected root-cause patterns |
| `mustMentionIdentifiers` | Required identifiers (pod names, hostnames, etc.) appear somewhere in findings |

### Scorecard

`test/golden/scorecard.ts` generates a Markdown scorecard with a machine-readable JSON summary block. This is designed for CI artifact upload:

```bash
npm run eval:golden
```

The scorecard includes per-scenario pass/fail, score percentage, top finding title, expected pattern, confidence, evidence count, and heuristic/AI mode.

### Scenarios Covered

| Scenario | Root Cause | Investigators Exercised |
|---|---|---|
| wrong-db-endpoint | DNS misconfiguration | Log, Config, Hypothesis |
| missing-secret-crashloop | Absent Secret → FailedMount | K8s, Config, Hypothesis |
| bad-image-tag | Nonexistent image tag | K8s, Log, Hypothesis |
| pvc-pending | StorageClass mismatch | K8s, Hypothesis |
| ghost-service | Cross-namespace Service DNS | Service, Log, Hypothesis |
| network-policy-deny | Deny-all egress NetworkPolicy | NetworkPolicy, Service, Log |
| node-taint-memory-pressure | NoSchedule taint + MemoryPressure | K8s (node), Hypothesis |
| helm-release-failure | Failed Helm hook CrashLoop | K8s, Log, Hypothesis |
| multi-namespace-retrieval | Multi-NS DNS + auth + OOM | All heuristic investigators |

---

## 2. AI Cassette Replay Evaluation

**Location:** `test/golden/__tests__/cassette-eval.test.ts`, `test/fixtures/cassettes/`

LLM investigation calls can be recorded to cassettes (`SBI_AI_MODE=record`) and replayed (`SBI_AI_MODE=replay`). The replay path is wired into the real pipeline via `ReplayableLLMClient`.

The cassette eval test:
1. Loads recorded cassettes from `test/fixtures/cassettes/cassettes.json`
2. Validates the recorded AI findings pass schema validation
3. Runs the full pipeline in replay mode (no API credentials needed)
4. Scores the combined heuristic + replayed-AI results against golden expectations
5. Verifies graceful degradation when no cassette matches (falls back to heuristic-only)

```bash
npm run eval:cassette
```

### Recording New Cassettes

```bash
# Set record mode and run the pipeline against a scenario
SBI_AI_MODE=record OPENAI_API_KEY=sk-... \
  npx sbi analyze /tmp/wrong-db-endpoint.tar.gz --output-dir /tmp/out

# Cassettes are written to /tmp/out/cassettes/cassettes.json
# Copy them to test/fixtures/cassettes/ for CI replay
```

---

## 3. Retrieval Quality Benchmarks

**Location:** `scripts/benchmark-retrieval.mjs`, `test/retrieval/`

Per-seed retrieval quality metrics across scenarios:

| Metric | Description |
|---|---|
| **P@5** | Precision at 5: fraction of top-5 retrieved chunks that are ground-truth relevant |
| **R@5** | Recall at 5: fraction of ground-truth relevant chunks found in top-5 |
| **MRR** | Mean Reciprocal Rank: 1/rank of the first relevant chunk |

```bash
npm run build
npm run benchmark:retrieval
```

Unit tests in `test/retrieval/__tests__/` verify that:
- Top-5 lexical results include expected chunks and exclude noise from other namespaces
- Graph retrieval spans multiple artifact types
- BM25 scoring correctly penalizes common tokens and rewards identifiers

---

## 4. Confidence Calibration

**Location:** `src/investigators/__tests__/hypothesis-ranker.test.ts`, `scripts/benchmark-hypotheses.mjs`

Unit-level calibration gates:
- **Monotonicity:** more/better evidence → higher confidence (never decreasing)
- **Boundary conditions:** zero evidence → 0.0, generic-only → ≤ 0.50, max → ≤ 1.0
- **Penalties:** contradicting evidence reduces confidence, missing decisive evidence caps it
- **Scenario ranking:** fixture-inspired cases verify the expected category wins

The benchmark script provides corpus-level signal: per-scenario top-1 accuracy, confidence-band breakdown, and per-band accuracy percentages.

```bash
npm run build
npm run benchmark:hypotheses
```

---

## 5. Robustness Testing

**Location:** `test/integration/__tests__/robustness.test.ts`

| Test Case | Expected Behavior |
|---|---|
| Corrupt archive (random bytes) | `extractBundle` throws with clear gzip/archive error |
| Truncated gzip stream | Extraction fails with EOF/zlib error |
| Empty archive | Pipeline completes with zero findings, no crash |
| Partial bundle (analyzer-only, no resources) | Pipeline produces analyzer-derived findings only |
| Malformed YAML/JSON resource | Parser skips bad file, continues with valid resources |
| Log file with binary/non-UTF8 content | Parser handles gracefully |
| Large log file (100KB+) | Pipeline completes without memory issues |
| 500+ small files | Profiling and parsing complete within performance ceiling |
| Oversized archive (exceeds maxSize) | `extractBundle` rejects with size-limit error |

```bash
npm run test:robustness
```

---

## 6. Sensitive-Data Leakage Protection

**Location:** `test/integration/__tests__/sensitive-data.test.ts`, `src/utils/sensitive-data.ts`

Tests plant known canary values (base64-encoded secret blobs, passwords, API keys) in fixture bundles and verify they never appear in:
- Finding titles, reasoning, or evidence notes
- Markdown, HTML, or JSON report output
- Investigation prompts sent to the LLM

The sanitizer (`sanitizeSensitiveText`) strips patterns matching:
- Base64-encoded strings from Secret `data` fields
- Password/token values from environment variables
- API key patterns

```bash
npm run test:sensitive
```

---

## 7. Performance Benchmarks

**Location:** `test/integration/__tests__/perf-benchmark.test.ts`

Runs three heuristic-only pipeline iterations and asserts they complete within generous CI throughput ceilings. Designed to catch accidental O(n^2) regressions, not to set hard latency SLAs.

```bash
npm run test:perf
```

---

## 8. Observability: Trace and Provenance

### trace.json

Every pipeline run can emit a structured trace (`--trace` or `--debug`):

```jsonc
{
  "bundlePath": "/path/to/bundle.tar.gz",
  "startedAt": "2026-03-21T...",
  "completedAt": "2026-03-21T...",
  "steps": [
    {
      "name": "investigate",
      "startedAt": "...",
      "completedAt": "...",
      "artifactsProcessed": 42,
      "seedCount": 8,
      "seedCategories": { "kubernetes": 4, "log": 2, "connectivity": 2 },
      "retrievalStats": { "graphChunks": 12, "lexicalChunks": 8, "semanticChunks": 5, "mergedChunks": 15 },
      "confidenceStats": { "min": 0.45, "max": 1.0, "mean": 0.82, "median": 0.86 },
      "hypothesisStats": { "generated": 24, "verified": 24, "converted": 8 }
    }
    // ... other steps
  ],
  "aiSummary": {
    "backend": "cloud",
    "model": "gpt-4o",
    "totalCalls": 6,
    "successfulCalls": 6,
    "failedCalls": 0,
    "totalLatencyMs": 4200,
    "avgLatencyMs": 700,
    "totalPromptTokens": 45000,
    "totalCompletionTokens": 3200,
    "estimatedCostUsd": 0.273
  }
}
```

### provenance.json (--debug only)

```jsonc
[
  {
    "id": "finding:hypothesis:dns-failure:default/app-pod:0",
    "provenance": {
      "investigator": "hypothesis",
      "seedId": "seed:pod:0",
      "seedSource": "pod:default/app-pod",
      "generatedAt": "2026-03-21T...",
      "hypothesisFamily": "dns-failure",
      "confidenceDelta": -0.05,
      "mergedFrom": ["finding:log:dns:0", "finding:k8s:not-ready:0"]
    }
  }
]
```

This lets you answer: "Why did the system produce this finding? What seed triggered it? How much did verification change the confidence? Which other findings were merged into it?"
