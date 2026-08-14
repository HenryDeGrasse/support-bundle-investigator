# Support Bundle Investigator (SBI)

[![CI](https://github.com/HenryDeGrasse/support-bundle-investigator/actions/workflows/ci.yml/badge.svg)](https://github.com/HenryDeGrasse/support-bundle-investigator/actions/workflows/ci.yml)

> CLI-first, local-first tool that takes a [Troubleshoot](https://troubleshoot.sh/) support bundle `.tar.gz` and produces evidence-backed diagnosis.

**Status: Complete** — full investigation pipeline with differential diagnosis, AI-augmented analysis, interactive TUI, and fixture scenarios verified by **3,800+ tests across 99 files**.

---

## Quick Start

SBI requires Node.js 20 or Node.js 22 and newer. CI verifies Node.js 20, 22,
and 24.

```bash
# 1. Install the locked dependencies
npm ci

# 2. Drop a support bundle into the bundles/ directory
cp /path/to/support-bundle-*.tar.gz bundles/

# 3. Run RAT (builds automatically, guides you through setup, opens TUI)
npm run rat
```

That's it. RAT auto-builds if needed, checks your embedding backend, and launches the interactive TUI. On first run it will ask if you want to set up a local embedding model.

---

## How to Get a Support Bundle

```bash
# Option A: Generate from a running cluster with the Troubleshoot plugin
kubectl support-bundle https://your-app.com/support-bundle-spec.yaml

# Option B: Download from your vendor portal or customer support ticket

# Then drop it in the bundles/ directory
cp support-bundle-*.tar.gz bundles/
```

The `bundles/` directory is gitignored — support bundles contain sensitive cluster data and should not be committed.

---

## Running the Tool

### Interactive TUI (recommended)

```bash
npm run rat                              # auto-build + scan bundles/ + TUI
npm run rat -- /path/to/dir              # scan a specific directory
npm run rat -- /path/to/bundle.tar.gz    # analyze a specific file directly
npm run rat -- --no-embedding-setup      # skip embedding setup prompt
```

Run `npm link` once if you prefer the global-style `rat` and `sbi` commands
while developing from a clone.

### CLI (non-interactive)

```bash
npm run build

node dist/cli/run.mjs analyze bundles/bundle.tar.gz          # text output
node dist/cli/run.mjs analyze bundles/bundle.tar.gz --no-ai  # heuristic-only
node dist/cli/run.mjs analyze bundles/bundle.tar.gz --tui    # TUI from the CLI
node dist/cli/run.mjs analyze bundles/bundle.tar.gz --format json --output-dir ./reports
node dist/cli/run.mjs analyze bundles/bundle.tar.gz --verbose
```

---

## AI Mode and Embedding Backends

SBI has two investigation layers that stack on top of each other:

| Layer | Always runs | What it does |
|---|---|---|
| **Heuristic** | Yes, offline | Pattern-matching investigators + differential diagnosis (3-5 competing hypotheses per symptom, ranked with calibrated confidence) |
| **AI-augmented** | When `OPENAI_API_KEY` is set (or `SBI_LLM_BACKEND=local`) | Graph + BM25 + semantic retrieval → LLM structured findings with mandatory bundle citations |

The AI layer uses **three retrieval channels** merged via Reciprocal Rank Fusion:
1. **Graph traversal** — DiagnosticGraph BFS (owner-refs, secret/ConfigMap/PVC refs, label-selectors, service-selectors, temporal edges)
2. **BM25 lexical** — exact identifier matching with IDF weighting and length normalisation
3. **Semantic expansion** — embedding-based cosine similarity (requires an embedding backend)

### LLM Backend: Cloud or Local

The LLM used for AI investigation can run in the cloud (OpenAI, default) or locally via any OpenAI-compatible server. The TUI status bar shows the active mode: `AI:cloud`, `AI:local`, or `AI:off`.

**Cloud mode (default):** Requires `OPENAI_API_KEY` and uses OpenAI's API (`gpt-5.6-terra` by default). Common credential patterns and Kubernetes Secret payloads are redacted from prompts before transmission, but the remaining diagnostic context from the bundle is sent to OpenAI.

**Local mode:** Uses a configured OpenAI-compatible endpoint such as Ollama, llama.cpp, vLLM, or LM Studio. Data stays on your machine only when `SBI_LLM_URL` points to a service running on infrastructure you control; a remote URL receives the redacted diagnostic context. The selected model should support reliable JSON output and a sufficient context window.

```bash
# Cloud mode (default)
OPENAI_API_KEY=sk-proj-...
SBI_AI_MODEL=gpt-5.6-terra

# Local mode with Ollama
SBI_LLM_BACKEND=local
SBI_LLM_URL=http://localhost:11434/v1
SBI_LLM_API_KEY=                 # optional; only for endpoints that require auth
SBI_AI_MODEL=qwen2.5:32b
SBI_TOKEN_BUDGET=20000          # reduce for smaller context windows

# Local mode with llama.cpp server
SBI_LLM_BACKEND=local
SBI_LLM_URL=http://localhost:8081/v1
SBI_LLM_API_KEY=                 # optional; only for endpoints that require auth
SBI_AI_MODEL=local-model
SBI_TOKEN_BUDGET=20000
```

**Local model examples for Apple Silicon:** Model fit and speed depend heavily
on quantization, context size, and available memory, so treat these as starting
points rather than benchmarked rankings.

| Model | Approx. RAM | Advertised context | Practical note |
|---|---:|---:|---|
| `qwen2.5:32b` | ~20 GB | 128K | A reasonable larger-model starting point |
| `llama3.1:70b` (q4) | ~40 GB | 128K | Usually needs a 64 GB-or-larger machine |
| `deepseek-r1:32b` | ~20 GB | 128K | Validate JSON reliability with your server and quantization |
| `llama3.1:8b` | ~5 GB | 128K | Fast and compact, but expect weaker diagnostic reliability |
| `mistral-small:22b` | ~14 GB | 32K | Reduce `SBI_TOKEN_BUDGET` to fit the smaller context |

> **Note:** Local performance and structured-JSON reliability vary by model,
> quantization, server, and hardware. The heuristic floor still produces useful
> results if the local LLM fails, and `SBI_TOKEN_BUDGET` can be reduced for
> models with smaller usable context windows.

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `OPENAI_API_KEY` | — | API key for cloud LLM calls or OpenAI embeddings. It is never forwarded to a local LLM endpoint. |
| `SBI_LLM_API_KEY` | `local` | Optional credential for an authenticated `SBI_LLM_URL`; local mode uses a non-secret placeholder when omitted. |
| `SBI_AI_MODEL` | `gpt-5.6-terra` | Chat model identifier. For Ollama, use the model tag (e.g. `qwen2.5:32b`). |
| `SBI_LLM_BACKEND` | `openai` | LLM backend: `openai` (cloud) or `local` (Ollama, llama.cpp, vLLM, LM Studio). |
| `SBI_LLM_URL` | auto | LLM API base URL. Defaults to `https://api.openai.com/v1` for cloud, `http://localhost:11434/v1` for local. |
| `SBI_TOKEN_BUDGET` | `100000` | Max tokens of context per AI seed call. Reduce for local models with smaller windows (e.g. `20000`). |
| `SBI_EMBEDDING_BACKEND` | `local` | Embedding backend: `local` (TEI/Ollama), `openai`, or `none`. |
| `SBI_EMBEDDING_URL` | `http://localhost:8080` | URL of the local embedding service. Change to `http://localhost:11434` for Ollama. |
| `SBI_EMBEDDING_MODEL` | `text-embedding-3-small` | Model name passed to Ollama (TEI ignores this — model is baked into the server). |

Put these in a `.env` file in the directory from which you run SBI (or a parent
directory). In a source checkout, the project-root `.env` is gitignored.

```bash
# .env — Cloud mode (default)
OPENAI_API_KEY=sk-proj-...
SBI_AI_MODEL=gpt-5.6-terra
SBI_EMBEDDING_BACKEND=local     # or: openai | none
SBI_EMBEDDING_URL=http://localhost:8080
```

```bash
# .env — Fully local mode (no data leaves your machine)
SBI_LLM_BACKEND=local
SBI_LLM_URL=http://localhost:11434/v1
SBI_AI_MODEL=qwen2.5:32b
SBI_TOKEN_BUDGET=20000
SBI_EMBEDDING_BACKEND=local
SBI_EMBEDDING_URL=http://localhost:11434
SBI_EMBEDDING_MODEL=nomic-embed-text
```

---

## Local Embedding Models (TEI and Ollama)

Semantic search works without sending data to OpenAI. Two local options:

### Option 1: HuggingFace TEI (recommended — best quality, supports late chunking)

TEI (Text Embeddings Inference) is a Docker container that serves embedding models via HTTP. It exposes token-level outputs which SBI uses for **late chunking** — each log chunk's embedding encodes full-document context instead of just the chunk's isolated text.

```bash
# Start TEI with the recommended model (gte-Qwen2-1.5B)
# First run downloads ~3 GB. Subsequent runs start in seconds.
docker run -d \
  --name sbi-tei \
  -p 8080:80 \
  ghcr.io/huggingface/text-embeddings-inference:cpu-1.5 \
  --model-id Alibaba-NLP/gte-Qwen2-1.5B-instruct

# Or use the lighter model (~560 MB, still good quality)
docker run -d \
  --name sbi-tei \
  -p 8080:80 \
  ghcr.io/huggingface/text-embeddings-inference:cpu-1.5 \
  --model-id BAAI/bge-small-en-v1.5

# Check it's ready (takes 30 seconds to a few minutes on first run)
curl http://localhost:8080/health

# Stop it when done
docker stop sbi-tei

# Restart without re-downloading
docker start sbi-tei
```

Then in `.env`:

```bash
SBI_EMBEDDING_BACKEND=local
SBI_EMBEDDING_URL=http://localhost:8080
```

**Model comparison:**

| Model | Size | RAM needed | Quality | Context | Notes |
|---|---|---|---|---|---|
| `gte-Qwen2-1.5B-instruct` | ~3 GB | ~4 GB | Best | 131K tokens | MIT license, recommended |
| `BAAI/bge-small-en-v1.5` | ~560 MB | ~1 GB | Good | 512 tokens | Great for low-RAM machines |

> **Apple Silicon note:** the `cpu-1.5` image works on Apple Silicon via Rosetta. For native ARM performance, use the `--platform linux/arm64` Docker flag if available, or use Ollama instead.

### Option 2: Ollama (simplest setup — standard embedding, no late chunking)

```bash
# Install Ollama: https://ollama.com/download
# Then pull the embedding model
ollama pull nomic-embed-text   # ~274 MB

# Ollama serves automatically when you run models
# Confirm it's running
curl http://localhost:11434/api/version
```

Then in `.env`:

```bash
SBI_EMBEDDING_BACKEND=local
SBI_EMBEDDING_URL=http://localhost:11434
SBI_EMBEDDING_MODEL=nomic-embed-text
```

> **Note:** Ollama supports standard per-chunk embedding but not token-level output. Late chunking (full-document context per chunk) requires TEI. For most bundles the difference is modest — Ollama is a great starting point.

### Option 3: OpenAI Embeddings API (no local service needed)

```bash
# In .env:
SBI_EMBEDDING_BACKEND=openai
OPENAI_API_KEY=sk-proj-...
SBI_EMBEDDING_MODEL=text-embedding-3-small   # or text-embedding-3-large
```

### Option 4: No embeddings (graph + BM25 only)

```bash
# In .env:
SBI_EMBEDDING_BACKEND=none
```

AI investigation still runs — semantic search is just disabled. Graph traversal (DiagnosticGraph with label-selector and temporal edges) and BM25 lexical search still retrieve context.

### Graceful degradation chain

```
LLM: SBI_LLM_BACKEND=local?  ─yes─►  Local LLM (Ollama/llama.cpp/vLLM)
      │no
      ▼
OPENAI_API_KEY set?  ─yes─►  OpenAI cloud LLM (best quality)
      │no
      ▼
Heuristic-only (no AI, still fully functional offline)


Embeddings:
TEI running?  ─yes─►  Late chunking + semantic search (best)
      │no
      ▼
Ollama running?  ─yes─►  Standard embedding + semantic search
      │no
      ▼
SBI_EMBEDDING_BACKEND=openai?  ─yes─►  OpenAI API embeddings
      │no
      ▼
Graph + BM25 only (still fully functional)
```

### RAT handles this automatically

When you run `rat`, it checks whether a local embedding service is reachable. If nothing is found, it asks:

```
  Checking local embedding service... not found

  No local embedding service found. Set one up now? [Y/n]:

  Embedding backend options:

    1) TEI (Docker)  -- gte-Qwen2-1.5B (recommended, ~3 GB first run) or bge-small (~560 MB)
    2) OpenAI API    -- text-embedding-3-small (no local service needed)
    3) None          -- skip embeddings, use graph + BM25 only
    4) Cancel        -- keep current settings

  Select [1]:
```

Choosing TEI will start the Docker container and write the settings to `.env` in the caller's current working directory. Choosing OpenAI or None writes its setting there as well. The choice persists across runs from that directory.

---

## Testing

```bash
npm run unit               # 3,800+ tests across 99 files
npm run lint               # zero-warning ESLint
npm run typecheck          # tsc --noEmit
npm audit --omit=dev       # production dependency advisories
npm run pack:smoke         # clean pack/install/import/bin verification
```

### Evaluation and benchmarks

```bash
npm run build
npm run eval:golden               # golden eval scorecard across all 9 scenarios
npm run eval:cassette             # AI replay eval using recorded LLM cassettes
npm run audit                     # full self-test: dedup invariants + confidence quality
npm run benchmark:hypotheses      # top-1 diagnosis accuracy + confidence calibration
npm run benchmark:retrieval       # P@5, R@5, MRR for graph + lexical retrieval
npm run test:robustness           # corrupt/truncated/oversized/partial bundle tests
npm run test:sensitive            # sensitive-data leakage protection tests
npm run test:perf                 # per-scenario throughput benchmarks
```

### Fixture scenarios

Nine failure scenarios in `test/fixtures/scenarios/`:

| Scenario | Root Cause | Top Diagnosis | Confidence |
|---|---|---|---|
| **wrong-db-endpoint** | `DB_HOST` points to non-existent DNS name | dns-failure | 1.00 (strong) |
| **missing-secret-crashloop** | `app-credentials` Secret absent | missing-secret | 0.95 (strong) |
| **bad-image-tag** | Image tag `myapp:v999.99.99` doesn't exist | image-pull-failure | 0.95 (strong) |
| **pvc-pending** | PVC references non-existent StorageClass | volume-mount-failure | 0.95 (strong) |
| **ghost-service** | Cross-namespace DNS failure (staging Service) | crashloop | 1.00 (moderate) |
| **network-policy-deny** | NetworkPolicy blocks all egress | network-policy-block | 0.98 (moderate) |
| **node-taint-memory-pressure** | NoSchedule taint + MemoryPressure | scheduling-failure | 0.90 (moderate) |
| **helm-release-failure** | Failed Helm hook CrashLoopBackOff | crashloop | 1.00 (moderate) |
| **multi-namespace-retrieval** | Multi-namespace DNS + auth failures | dns-failure | 0.89 (moderate) |

`realistic-bundle-format/` is additionally used as a format-validation fixture.

Try them manually:

```bash
npm run build
cd test/fixtures/scenarios
tar czf /tmp/wrong-db.tar.gz wrong-db-endpoint/
tar czf /tmp/missing-secret.tar.gz missing-secret-crashloop/
tar czf /tmp/bad-image.tar.gz bad-image-tag/
tar czf /tmp/pvc.tar.gz pvc-pending/
tar czf /tmp/ghost-service.tar.gz ghost-service/
tar czf /tmp/netpol.tar.gz network-policy-deny/

node dist/cli/run.mjs analyze /tmp/wrong-db.tar.gz --no-ai
node dist/cli/run.mjs analyze /tmp/missing-secret.tar.gz --format json --output-dir ./out
node dist/cli/run.mjs analyze /tmp/netpol.tar.gz --no-ai --debug --output-dir ./debug-out
```

---

## Report Formats

When `--output-dir` is set, all three report files are written:

| File | Format | Contents |
|---|---|---|
| `findings.json` | JSON | Schema-versioned structured report. Each finding includes `confidenceQuality: "strong" | "moderate" | "weak"` indicating how well-supported the confidence score is. In `--debug` mode, each finding also includes a `provenance` object showing which investigator produced it, the originating seed, confidence deltas from verification, and merge history. |
| `report.md` | Markdown | Executive summary, ranked findings with severity badges and confidence (`81% (weak)`, `100% (strong)`), evidence tables, spec recommendations. Includes AI summary (model, latency, tokens, estimated cost) when AI mode was active. |
| `report.html` | HTML | Self-contained (no CDN), severity colour-coding, collapsible sections, print-friendly. |
| `trace.json` | JSON | Investigation trace with per-step timing, seed counts/categories, retrieval stats (graph/lexical/semantic/merged chunk counts), confidence distribution (min/max/mean/median), hypothesis stats, and AI run summary (calls, latency, tokens, cost). |
| `provenance.json` | JSON | Per-finding provenance metadata (only in `--debug` mode). Maps each finding to its originating investigator, seed, confidence adjustments, and merge lineage. |

```bash
node dist/cli/run.mjs analyze bundle.tar.gz --output-dir ./reports --trace
ls reports/
# findings.json  report.md  report.html  trace.json

node dist/cli/run.mjs analyze bundle.tar.gz --output-dir ./reports --debug
ls reports/
# findings.json  report.md  report.html  trace.json  provenance.json
```

### Confidence quality

Every finding now carries a `confidenceQuality` label:

| Label | Meaning |
|---|---|
| `strong` | 3+ evidence items, 2+ distinct source types, no missing decisive evidence |
| `moderate` | Some evidence but not fully cross-source, or some gaps |
| `weak` | 1 evidence item, or 2+ missing decisive evidence items |

This tells you whether `81%` is a well-grounded estimate or a thin one that could shift significantly with more bundle data.

---

## Architecture

### Pipeline

```
bundle.tar.gz
  |
  +--> Extract --> Profile --> Parse (analyzers, K8s resources, events, logs, Helm)
  |
  +--> Build DiagnosticGraph
  |      owner-refs, secret/ConfigMap/PVC refs
  |      label-selector (Deployment -> Pods by matchLabels)
  |      service-selector (Service -> Pods by spec.selector)
  |      temporal-correlation (log chunk <-> event within 60s)
  |      temporal-sequence (FailedMount -> BackOff, ErrImagePull -> ImagePullBackOff, ...)
  |      workload-group hierarchy (middle layer aggregation)
  |
  +--> AI chunk index (when OPENAI_API_KEY set or SBI_LLM_BACKEND=local)
  |      buildChunkIndex (error-aware log chunking + contextual retrieval prefix)
  |      LexicalSearchIndex (BM25: TF saturation, IDF, length normalization)
  |      EmbeddingClient (TEI late chunking | Ollama | OpenAI | none)
  |      VectorStore (cosine similarity)
  |      LLM backend: cloud (OpenAI) | local (Ollama, llama.cpp, vLLM)
  |
  +--> runInvestigation
         Seeds: analyzer errors, pod health, log patterns, warning events
         |
         +--> Kubernetes investigator (CrashLoopBackOff, ImagePullBackOff, not-ready, pending, node conditions/capacity/taints)
         +--> Log investigator (DNS failure, connection timeout, missing resource, image pull)
         +--> Config investigator (missing secrets, service refs, image tag mismatches)
         +--> Service investigator (empty Endpoints, DNS-confirmed unreachable)
         +--> NetworkPolicy investigator (egress/ingress blocks)
         +--> AI investigator (DiagnosticGraph traversal + BM25 + HyDE semantic -> LLM)
         |
         +--> Causal template matching (MissingSecret->FailedMount->CrashLoop, etc.)
         +--> Hypothesis engine (declarative templates + evidence rules, 3-5 competing hypotheses per symptom)
         +--> Cross-symptom correlation (cluster-wide meta-findings for convergent root causes)
         +--> Verifier (contradictions, confidence adjustment, confidenceQuality)
         +--> Orchestrator merge (Pass 1 structural merge -> Pass 2 incident-aware title dedup -> symptom suppression)
         |
         +--> Sort by severity + diagnostic/root-cause tier + confidence
  |
  +--> Report (JSON + Markdown + HTML + TUI)
         specRecommendations: what to add to your bundle spec
```

### Project Structure

```
support-bundle-investigator/
+-- bundles/                  # Drop your .tar.gz support bundles here (gitignored)
+-- src/
|   +-- ai/
|   |   +-- chunk-indexer.ts        # Error-aware log chunking + contextual retrieval
|   |   +-- contextual-retrieval.ts # Template-based context prefix before embedding
|   |   +-- late-chunking.ts        # TEI token-level embedding + average pooling
|   |   +-- local-embeddings.ts     # TEI and Ollama HTTP clients
|   |   +-- hyde.ts                 # HyDE: hypothetical document embeddings for search
|   |   +-- lexical-search.ts       # BM25 inverted index
|   |   +-- vector-store.ts         # Cosine similarity store
|   |   +-- retrieval-metrics.ts    # P@K, R@K, MRR computation
|   |   +-- embeddings.ts           # OpenAI embedding client
|   |   +-- llm-client.ts           # OpenAI chat completion client
|   |   +-- prompts.ts              # Category-specific investigation playbooks
|   |   +-- schemas.ts              # AIFinding validation
|   |   +-- config.ts               # AI config from env vars (LLM backend, token budget)
|   |   +-- telemetry.ts            # AI call metrics aggregation (latency, tokens, cost)
|   |   +-- recorder.ts             # Cassette record/replay for AI LLM calls
|   |   +-- replayable-llm-client.ts # LLM client wrapper with cassette support
|   +-- cli/
|   |   +-- rat.ts                  # RAT launcher (auto-build, embedding setup, TUI)
|   |   +-- run.ts                  # sbi binary entry point
|   |   +-- cli.ts                  # Commander argument parsing
|   |   +-- env-loader.ts           # Zero-dependency .env file loader
|   |   +-- output.ts               # Report writing
|   +-- graph/
|   |   +-- diagnostic-graph.ts     # Unified DiagnosticGraph (all edge types)
|   |   +-- traversal.ts            # Typed weighted directional BFS
|   |   +-- causal-templates.ts     # Known failure chain templates -> causes edges
|   |   +-- community.ts            # Label propagation community detection (GraphRAG)
|   |   +-- knowledge-extractor.ts  # LLM triple extraction
|   |   +-- resource-graph.ts       # Legacy ResourceRelationshipGraph (adapter target)
|   |   +-- chunker.ts              # Log/resource/analyzer chunking
|   |   +-- finding-tree.ts         # Causal finding tree (DFS/BFS)
|   +-- ingestion/                  # Bundle extraction, classification, profiling
|   +-- investigators/
|   |   +-- orchestrator.ts         # Full pipeline: seeds -> findings -> sort
|   |   +-- kubernetes-investigator.ts
|   |   +-- log-investigator.ts
|   |   +-- config-investigator.ts
|   |   +-- service-investigator.ts
|   |   +-- network-policy-investigator.ts
|   |   +-- ai-investigator.ts      # DiagnosticGraph traversal + BM25 + HyDE -> LLM
|   |   +-- hypothesis-generator.ts # Template-driven hypothesis generation
|   |   +-- hypothesis-templates.ts # Declarative symptom -> hypothesis registry
|   |   +-- hypothesis-evidence-collector.ts
|   |   +-- hypothesis-ranker.ts
|   |   +-- hypothesis-converter.ts
|   |   +-- finding-provenance.ts   # Per-finding provenance stamping
|   |   +-- verifier.ts             # Contradiction checks, confidenceQuality
|   +-- parsers/                    # K8s resources, events, logs, Helm, timeline
|   +-- pipeline/analyze.ts         # Main pipeline (8 steps)
|   +-- reporters/                  # JSON/Markdown/HTML reporters, spec recommender
|   +-- tui/                        # Ink-based interactive terminal UI
|   +-- types/                      # TypeScript domain types
|   +-- utils/
|   |   +-- sensitive-data.ts       # Secret/password/token redaction for prompts and reports
+-- test/
|   +-- fixtures/scenarios/         # 9 failure scenarios (real Troubleshoot format)
|   +-- fixtures/cassettes/         # Recorded AI LLM responses for deterministic replay
|   +-- retrieval/                  # Retrieval quality tests (P@K, R@K, MRR)
|   +-- golden/                     # Golden eval scorecard + cassette replay evals
|   +-- integration/                # Pipeline, robustness, sensitive-data, perf tests
|   +-- e2e/                        # End-to-end scenario tests
+-- scripts/
|   +-- audit-findings.mjs          # Structural finding/dedup audit across scenarios
|   +-- benchmark-hypotheses.mjs    # Diagnosis quality benchmark
|   +-- benchmark-retrieval.mjs     # Retrieval precision/recall benchmark
|   +-- package-smoke.mjs           # Pack/install/import/bin release verification
|   +-- record-cassettes.mjs        # Sanitized AI cassette recording workflow
+-- docs/
|   +-- support_bundle_investigator_prd_v2.md  # Product requirements doc
|   +-- evals.md                               # Evaluation and testing reference
|   +-- ghost-service-bundle-spec.yaml         # Example Troubleshoot bundle spec
+-- .env                      # API keys and embedding config (gitignored)
+-- bundles/                  # Support bundles (gitignored)
```

---

## CLI Reference

```
Usage: sbi analyze [options] <bundle-path>

Arguments:
  bundle-path         Path to the support bundle .tar.gz file

Options:
  --output-dir <dir>  Directory to write reports (findings.json, report.md, report.html)
  --format <format>   Output format: json | text | summary | markdown | html (default: text)
  --verbose           Enable verbose logging (shows per-seed AI retrieval stats)
  --trace             Write trace.json to --output-dir
  --debug             Emit enriched trace with per-finding provenance and diagnostics
  --no-ai             Disable AI features (heuristic-only, offline-safe)
  --tui               Launch interactive terminal UI
  -h, --help          Help
```

`--debug` implies `--verbose` and `--trace`. It additionally writes `provenance.json` alongside the other report files, includes full provenance metadata in `findings.json`, and prints a per-finding provenance summary table to stderr.

```
Usage: rat [options] [path]

Arguments:
  path                Directory to scan or .tar.gz to analyze (default: ./bundles/)

Options:
  --no-build          Skip auto-build check
  --no-embedding-setup  Skip embedding setup prompt (useful in CI or scripts)
  -V, --version       Print the version
  -h, --help          Show this help
```

---

## Design Decisions

**Local-first.** Support bundles contain sensitive cluster data. All heuristic analysis runs locally — no data leaves your machine. AI investigation (LLM calls) is additive and optional. Both the LLM and embedding backends can run entirely locally via Ollama, llama.cpp, or TEI; point both configured endpoint URLs at services on infrastructure you control for an offline deployment.

**Heuristic precision floor.** Five deterministic investigators (Kubernetes, Log, Config, Service, NetworkPolicy) provide reliable offline analysis. AI findings are merged on top, never replacing the heuristic baseline.

**Differential diagnosis.** For each symptom, 3-5 competing root-cause hypotheses are generated from a declarative template registry and scored. Templates can carry co-located `evidenceRules`, so new diagnostic patterns increasingly land as data changes rather than bespoke procedural code. The top finding includes an explicit comparison explaining why the runner-up was rejected.

**Cross-symptom correlation.** When multiple symptom groups in the same namespace converge on the same top-ranked root cause, SBI emits a cluster-wide meta-finding with boosted confidence (for example, a shared `dns-failure` across several pods).

**Node-aware Kubernetes investigation.** The Kubernetes investigator now covers node conditions plus allocatable-vs-capacity memory analysis, scheduling-blocking taints, and MemoryPressure → OOMKilled pod correlation.

**Confidence quality, not just a number.** Every finding carries `confidenceQuality: strong | moderate | weak` alongside the numeric confidence. `81% (weak)` means the number could shift significantly with more bundle data; `100% (strong)` means it's well-grounded across multiple independent sources. Confidence calibration is regression-tested with monotonicity, penalty, and scenario-ranking unit tests.

**Two-pass dedup architecture.** Final finding consolidation is explicit and documented: Pass 1 performs structural component/family merges with evidence absorption, Pass 2 treats normalized titles as candidates but merges only findings tied to the same incident, and symptom suppression runs afterward as a separate step.

**DiagnosticGraph.** A unified graph replaces two disconnected legacy graphs. It combines structural K8s edges (owner-refs, label-selectors, service-selectors), causal edges (from template matching and investigators), and temporal edges (log chunk ↔ event correlations, sequential event causality). Graph traversal for AI retrieval uses this richer edge set.

**BM25 + Reciprocal Rank Fusion.** Lexical search uses proper BM25 (TF saturation k1=1.2, length normalisation b=0.75, IDF). Graph, lexical, and semantic results are merged via RRF (k=60).

**Late chunking with TEI.** When TEI is running, each log chunk gets an embedding that encodes full-document context via token-level average pooling. A log error at line 3000 implicitly encodes `DB_HOST=db.internal` from line 12 because the transformer saw the entire document.

**Spec recommendations.** When confidence is limited by missing bundle data, the system recommends specific collectors, analyzers, or redaction rules to improve future bundles.

**Per-finding provenance.** Every finding carries optional structured metadata: which investigator produced it, the originating seed, confidence deltas from verification, merge lineage, and hypothesis family. Available via `--debug` and in `provenance.json`.

**AI telemetry.** Every LLM call records latency, prompt/completion tokens, model name, and estimated cost (for OpenAI models). Aggregates are surfaced in `trace.json` and in the Markdown/HTML report footer so operators can audit AI usage per bundle.

**Cassette record/replay.** AI investigation calls can be recorded to disk (`SBI_AI_MODE=record`) and replayed deterministically (`SBI_AI_MODE=replay`). This enables cost-free CI regression testing of the AI path without API credentials.

**Sensitive-data protection.** Redaction is best-effort: common credential patterns and Kubernetes Secret payloads are removed from prompts and report output. Integration tests verify that representative canary values planted in fixtures never appear in findings, reports, or prompts.

**Robustness.** The pipeline is tested against corrupt archives, truncated gzip streams, empty bundles, partial bundles (missing entire artifact categories), malformed YAML/JSON resources, oversized archives, and bundles with 500+ tiny files. The system either fails with a clear error message or degrades gracefully with partial results — it never crashes silently.

**No emoji.** Text symbols, ANSI colors, box-drawing characters, ASCII art only.
