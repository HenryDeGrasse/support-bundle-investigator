# Support Bundle Investigator (SBI)

> CLI-first, local-first tool that takes a [Troubleshoot](https://troubleshoot.sh/) support bundle `.tar.gz` and produces evidence-backed diagnosis.

**Status: Complete** -- full investigation pipeline with **differential diagnosis**, AI-augmented analysis, interactive TUI, and 6 fixture scenarios verified by **2609+ tests across 70 files**.

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Drop a support bundle into the bundles/ directory
cp /path/to/support-bundle-*.tar.gz bundles/

# 3. Run RAT (builds automatically, opens interactive TUI)
npm run rat
```

That's it. RAT auto-builds if needed, scans `bundles/`, and launches the interactive TUI.

### How to get a support bundle

```bash
# Option A: Generate one from a running cluster using the Troubleshoot kubectl plugin
kubectl support-bundle https://your-app.com/support-bundle-spec.yaml

# Option B: Download from your vendor portal or customer support ticket

# Then drop it in:
cp support-bundle-*.tar.gz bundles/
```

The `bundles/` directory is gitignored (support bundles contain sensitive cluster data).

---

## Running the Tool

### Interactive TUI (recommended)

```bash
# Auto-build + scan bundles/ + interactive selection + TUI
npm run rat

# Or use the binary directly after building
npm run build
npx rat                              # scan bundles/
npx rat /path/to/dir                 # scan a specific directory
npx rat /path/to/bundle.tar.gz       # analyze a specific file directly
```

### CLI (non-interactive)

```bash
npm run build

# Heuristic mode (no API key needed, fully offline)
npx sbi analyze bundles/support-bundle.tar.gz --no-ai

# AI-augmented mode (requires OpenAI API key)
export OPENAI_API_KEY=sk-...
npx sbi analyze bundles/support-bundle.tar.gz

# Output formats
npx sbi analyze bundles/support-bundle.tar.gz --format json
npx sbi analyze bundles/support-bundle.tar.gz --format markdown
npx sbi analyze bundles/support-bundle.tar.gz --format html

# Write all reports to a directory
npx sbi analyze bundles/support-bundle.tar.gz --output-dir ./reports --trace

# TUI mode from the CLI
npx sbi analyze bundles/support-bundle.tar.gz --tui
```

---

## AI Mode

SBI has two investigation modes:

| Mode | When | What it does |
|------|------|--------------|
| **Heuristic** (default) | Always runs, no API key needed | Pattern-matching investigators + differential diagnosis hypothesis engine |
| **AI-augmented** (additive) | When `OPENAI_API_KEY` is set | Adds graph + BM25 + semantic retrieval, then LLM-structured findings with mandatory citations |

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPENAI_API_KEY` | For AI mode | -- | OpenAI API key. Without this, heuristic-only mode runs. |
| `SBI_AI_MODEL` | No | `gpt-4o` | OpenAI chat model for structured finding generation. Any OpenAI chat model works (`gpt-4o-mini`, `gpt-4-turbo`, etc.). |
| `SBI_EMBEDDING_MODEL` | No | `text-embedding-3-small` | OpenAI embedding model for semantic vector search. Used to find cross-source correlations beyond exact keyword matches. |

```bash
# Enable AI mode
export OPENAI_API_KEY=sk-proj-...

# Optional: use a cheaper/faster model
export SBI_AI_MODEL=gpt-4o-mini

# Optional: use a different embedding model
export SBI_EMBEDDING_MODEL=text-embedding-3-large

# Or create a .env file (gitignored)
echo 'OPENAI_API_KEY=sk-proj-...' > .env
```

### What the AI models do

- **`SBI_AI_MODEL` (default: `gpt-4o`)** -- The chat completion model. For each investigation seed, retrieved context chunks are sent to this model with a category-specific playbook prompt. The model must produce structured `Finding[]` JSON with mandatory evidence citations back to the provided chunks. It cannot invent claims -- every finding must reference specific file paths and line ranges from the bundle.

- **`SBI_EMBEDDING_MODEL` (default: `text-embedding-3-small`)** -- The embedding model. Converts text chunks into vector representations for cosine-similarity search. This is the "semantic expansion" step that finds relevant chunks the keyword search might miss (e.g., a log message about "connection refused" being relevant to a "service unavailable" investigation seed). Only used when AI mode is active.

### Disabling AI mode

```bash
npx sbi analyze bundle.tar.gz --no-ai    # force heuristic-only
```

### Graceful degradation

If AI features fail at any point, the pipeline continues with heuristic results:

- **No API key** or **`--no-ai`**: heuristic-only mode, no AI calls
- **Embedding fails**: AI continues with graph + BM25 retrieval only (no semantic expansion)
- **LLM call fails for a seed**: that seed is skipped with a warning, remaining seeds proceed
- **LLM response invalid**: findings without citeable evidence are dropped silently

---

## How It Works

### Pipeline

```
bundle.tar.gz
  |
  v
Extract --> Profile --> Parse (analyzers, K8s resources, events, logs, Helm)
  |
  v
Build resource graph (owner-refs, secret/configmap/PVC refs, events)
  |
  v
Generate investigation seeds (analyzer errors, pod health, log patterns, events)
  |
  v
Run investigators in parallel:
  - Kubernetes: CrashLoopBackOff, ImagePullBackOff, not-ready, pending, workloads
  - Log: DNS failures, connection timeouts, missing resources, image pull
  - Config: missing secrets, service refs, image tag mismatches
  - AI (if enabled): graph + BM25 + semantic retrieval --> LLM structured findings
  |
  v
Hypothesis engine: group by symptom --> generate 3-5 competing hypotheses
  --> collect supporting/contradicting/missing evidence per hypothesis
  --> rank with calibrated scoring (specificity, cross-source, contradiction penalties)
  |
  v
Verify: contradiction checks, confidence adjustment, deduplication
  |
  v
Report: JSON / Markdown / HTML / Interactive TUI
  + Spec recommendations (what to add to your bundle spec for better diagnosis)
```

### Retrieval (AI mode)

For each investigation seed, the AI investigator retrieves context through three complementary channels merged via Reciprocal Rank Fusion (RRF):

1. **Graph traversal** -- deterministic K8s resource neighborhood from the resource relationship graph (owner-refs, secret/configmap/PVC refs, event targets). Precision floor.
2. **BM25 lexical search** -- exact identifier matching with BM25 scoring (TF saturation, IDF weighting, length normalization) across all artifact types.
3. **Semantic expansion** -- embedding-based cosine similarity search for cross-source correlations that keywords miss.

---

## Testing

```bash
npm run unit          # 2609+ tests across 70 files
npm run lint          # zero-warning ESLint
npm run typecheck     # tsc --noEmit
```

### Test fixture scenarios

Six realistic failure scenarios in `test/fixtures/scenarios/`:

| Scenario | Root Cause | Expected Top Finding |
|----------|------------|---------------------|
| **wrong-db-endpoint** | `DB_HOST` env var points to non-existent DNS name | DNS resolution failure (0.81 confidence) |
| **missing-secret-crashloop** | `app-credentials` Secret missing, pod crashes | Missing secret (1.00 confidence) |
| **bad-image-tag** | Image tag `myapp:v999.99.99` doesn't exist | Image pull failure (0.80 confidence) |
| **pvc-pending** | PVC references non-existent StorageClass `fast-ssd` | Missing secret / PVC pending (0.70 confidence) |
| **realistic-bundle-format** | Real Troubleshoot bundle structure reference | Format validation |
| **multi-namespace-retrieval** | Large-scale multi-namespace fixture | Retrieval precision/recall testing |

All fixtures use the real Troubleshoot bundle format (flat JSON lists like `pods/default.json`, logs at `cluster-resources/pods/logs/default/<pod>/<container>.log`).

### Benchmark

```bash
npm run benchmark:hypotheses
```

Prints a table with scenario name, top diagnosis, confidence, correctness, and runtime for each scenario in both heuristic and AI modes.

### Try it manually

```bash
npm run build

# Create test bundles from fixtures
cd test/fixtures/scenarios
tar czf /tmp/wrong-db.tar.gz wrong-db-endpoint/
tar czf /tmp/missing-secret.tar.gz missing-secret-crashloop/
tar czf /tmp/bad-image.tar.gz bad-image-tag/
tar czf /tmp/pvc.tar.gz pvc-pending/

# Run analysis
npx sbi analyze /tmp/wrong-db.tar.gz --no-ai
npx sbi analyze /tmp/missing-secret.tar.gz --format json --output-dir ./out
npx sbi analyze /tmp/bad-image.tar.gz --tui --no-ai
```

---

## Report Output

When `--output-dir` is set, the CLI writes all three report files:

| File | Format | Contents |
|------|--------|----------|
| `findings.json` | JSON | Schema-versioned structured report with all findings, evidence, recommendations |
| `report.md` | Markdown | Executive summary, ranked findings with severity badges, evidence tables, spec recommendations |
| `report.html` | HTML | Self-contained (no CDN), severity color-coding, collapsible sections, print-friendly |

```bash
npx sbi analyze bundle.tar.gz --output-dir ./reports --trace
ls reports/
# findings.json  report.md  report.html  trace.json
```

---

## CLI Reference

```
Usage: sbi analyze [options] <bundle-path>

Arguments:
  bundle-path         Path to the support bundle .tar.gz file

Options:
  --output-dir <dir>  Directory to write output artifacts
  --format <format>   Output format: json | text | summary | markdown | html (default: "text")
  --verbose           Enable verbose pipeline logging
  --trace             Write a trace.json to the output directory
  --no-ai             Disable AI features (heuristic-only, offline-safe)
  --tui               Launch interactive terminal UI
  -h, --help          display help for command
```

### RAT command

```
Usage: rat [options] [path]

Arguments:
  path                Directory to scan or .tar.gz to analyze (default: ./bundles/)

Options:
  --no-build          Skip auto-build check
```

---

## Project Structure

```
support-bundle-investigator/
+-- bundles/                  # Drop your .tar.gz support bundles here
+-- src/
|   +-- cli/                  # Commander CLI + RAT launcher
|   +-- ai/                   # AI layer: chunk indexer, BM25, embeddings, LLM, vector store
|   +-- graph/                # Resource graph, investigation graph, chunker
|   +-- ingestion/            # Bundle extraction, classification, profiling
|   +-- investigators/        # K8s, log, config, AI investigators + hypothesis engine
|   +-- parsers/              # Analyzers, K8s resources, events, logs, Helm, timeline
|   +-- pipeline/             # Pipeline orchestration
|   +-- reporters/            # JSON/Markdown/HTML reporters, spec recommender
|   +-- tui/                  # Ink-based interactive terminal UI
|   +-- types/                # TypeScript domain types
|   +-- utils/                # Type guards
|   +-- index.ts              # Public API
+-- test/
|   +-- fixtures/scenarios/   # 6 failure scenario fixtures (real bundle format)
|   +-- retrieval/            # BM25 + graph retrieval quality tests
|   +-- golden/               # CI/CD eval framework (golden expectations, replay)
|   +-- integration/          # Full pipeline integration tests
|   +-- e2e/                  # End-to-end scenario tests
|   +-- helpers/              # Test utilities (createTestBundle)
+-- docs/
|   +-- findings-and-improvements.md   # 650+ line improvement roadmap (7 tiers)
|   +-- support_bundle_investigator_prd_v2.md
|   +-- architecture.mmd
+-- scripts/
|   +-- benchmark-hypotheses.mjs       # Diagnosis quality benchmark
+-- .env                      # API keys (gitignored)
+-- .gitignore
+-- package.json
+-- tsconfig.json
+-- tsup.config.ts
+-- vitest.config.ts
```

---

## Design Decisions

**Local-first.** Support bundles contain sensitive cluster data. All analysis runs locally -- no data leaves your machine. AI mode is additive and optional.

**Heuristic precision floor.** Three deterministic investigators (Kubernetes, Log, Configuration) provide reliable pattern-matching that works offline. AI findings are merged on top, never replace.

**Differential diagnosis.** For each symptom, 3-5 competing root-cause hypotheses are generated and scored. The top finding includes an explicit comparison explaining why the runner-up was rejected.

**BM25 + Reciprocal Rank Fusion.** Lexical search uses proper BM25 scoring (TF saturation k1=1.2, length normalization b=0.75, IDF weighting). Graph, lexical, and semantic results are merged via RRF (k=60) for robust ranking.

**Evidence-grounded AI.** Every AI finding must cite specific file paths and line ranges from the provided context chunks. Findings without citeable evidence are dropped.

**Spec recommendations.** When confidence is limited by missing bundle data, the system recommends specific collectors, analyzers, or redaction rules to improve future bundles.

**No emoji.** Text symbols, ANSI colors, box-drawing characters, and ASCII art only.
