# Support Bundle Investigator (SBI)

> CLI-first, local-first tool that takes a [Troubleshoot](https://troubleshoot.sh/) support bundle `.tar.gz` and produces evidence-backed diagnosis.

**Status: Complete** — full investigation pipeline with differential diagnosis, AI-augmented analysis, interactive TUI, and 6 fixture scenarios verified by **3396+ tests across 83 files**.

---

## Quick Start

```bash
# 1. Install dependencies
npm install

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
npm run rat                          # auto-build + scan bundles/ + TUI

npx rat                              # same, via bin (after npm link or npm install -g)
npx rat /path/to/dir                 # scan a specific directory
npx rat /path/to/bundle.tar.gz       # analyze a specific file directly
npx rat --no-embedding-setup         # skip embedding setup prompt
```

### CLI (non-interactive)

```bash
npm run build

npx sbi analyze bundles/bundle.tar.gz          # text output (heuristic mode)
npx sbi analyze bundles/bundle.tar.gz --no-ai  # explicitly heuristic-only
npx sbi analyze bundles/bundle.tar.gz --tui    # TUI from the CLI
npx sbi analyze bundles/bundle.tar.gz --format json --output-dir ./reports
npx sbi analyze bundles/bundle.tar.gz --verbose
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

**Cloud mode (default):** Requires `OPENAI_API_KEY`. Uses OpenAI's API (`gpt-4o` by default). Best quality, fastest response time. Bundle data is sent to OpenAI.

**Local mode:** Uses a locally-running LLM server (Ollama, llama.cpp, vLLM, LM Studio). All data stays on your machine. Requires a model with good JSON output and sufficient context window.

```bash
# Cloud mode (default)
OPENAI_API_KEY=sk-proj-...
SBI_AI_MODEL=gpt-4o

# Local mode with Ollama
SBI_LLM_BACKEND=local
SBI_LLM_URL=http://localhost:11434/v1
SBI_AI_MODEL=qwen2.5:32b
SBI_TOKEN_BUDGET=20000          # reduce for smaller context windows

# Local mode with llama.cpp server
SBI_LLM_BACKEND=local
SBI_LLM_URL=http://localhost:8081/v1
SBI_AI_MODEL=local-model
SBI_TOKEN_BUDGET=20000
```

**Local model recommendations (Apple Silicon MacBook):**

| Model | RAM Needed | Context | JSON Quality | Overall Quality |
|---|---|---|---|---|
| `qwen2.5:32b` | ~20 GB | 128K | Good | Medium-High |
| `llama3.1:70b` (q4) | ~40 GB | 128K | Good | High (needs 64 GB+ RAM) |
| `deepseek-r1:32b` | ~20 GB | 128K | Good | Medium-High |
| `llama3.1:8b` | ~5 GB | 128K | Okay | Low (will hallucinate) |
| `mistral-small:22b` | ~14 GB | 32K | Good | Medium (small context) |

> **Note:** Local models are slower (~5-15 tok/s vs ~80-100 tok/s cloud) and less reliable at structured JSON output. The heuristic floor ensures you always get useful results even if the local LLM produces lower-quality findings. Use `SBI_TOKEN_BUDGET` to reduce context size for models with smaller windows.

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `OPENAI_API_KEY` | — | API key. Required for cloud mode. For local mode, any non-empty value works (or omit entirely). |
| `SBI_AI_MODEL` | `gpt-4o` | Chat model identifier. For Ollama, use the model tag (e.g. `qwen2.5:32b`). |
| `SBI_LLM_BACKEND` | `openai` | LLM backend: `openai` (cloud) or `local` (Ollama, llama.cpp, vLLM, LM Studio). |
| `SBI_LLM_URL` | auto | LLM API base URL. Defaults to `https://api.openai.com/v1` for cloud, `http://localhost:11434/v1` for local. |
| `SBI_TOKEN_BUDGET` | `100000` | Max tokens of context per AI seed call. Reduce for local models with smaller windows (e.g. `20000`). |
| `SBI_EMBEDDING_BACKEND` | `local` | Embedding backend: `local` (TEI/Ollama), `openai`, or `none`. |
| `SBI_EMBEDDING_URL` | `http://localhost:8080` | URL of the local embedding service. Change to `http://localhost:11434` for Ollama. |
| `SBI_EMBEDDING_MODEL` | `text-embedding-3-small` | Model name passed to Ollama (TEI ignores this — model is baked into the server). |

Put these in a `.env` file in the project root (it's gitignored):

```bash
# .env — Cloud mode (default)
OPENAI_API_KEY=sk-proj-...
SBI_AI_MODEL=gpt-4o
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

Choosing TEI will start the Docker container and write the settings to `.env`. Choosing OpenAI or None writes the setting to `.env`. The choice persists across runs.

---

## Testing

```bash
npm run unit          # 3396+ tests across 83 files
npm run lint          # zero-warning ESLint
npm run typecheck     # tsc --noEmit
```

### Benchmark diagnosis quality

```bash
npm run build
npm run benchmark:hypotheses    # heuristic diagnosis across all scenarios
node scripts/benchmark-retrieval.mjs   # P@5, R@5, MRR for graph + lexical retrieval
```

### Fixture scenarios

Six realistic failure scenarios in `test/fixtures/scenarios/`:

| Scenario | Root Cause | Top Diagnosis | Confidence |
|---|---|---|---|
| **wrong-db-endpoint** | `DB_HOST` points to non-existent DNS name | dns-failure | 0.81 |
| **missing-secret-crashloop** | `app-credentials` Secret absent | missing-secret | 1.00 |
| **bad-image-tag** | Image tag `myapp:v999.99.99` doesn't exist | image-pull-failure | 0.90 |
| **pvc-pending** | PVC references non-existent StorageClass | volume-mount-failure | 0.90 |
| **realistic-bundle-format** | Real Troubleshoot bundle structure | format validation | — |
| **multi-namespace-retrieval** | Multi-namespace cluster | retrieval precision/recall testing | — |

Try them manually:

```bash
npm run build
cd test/fixtures/scenarios
tar czf /tmp/wrong-db.tar.gz wrong-db-endpoint/
tar czf /tmp/missing-secret.tar.gz missing-secret-crashloop/
tar czf /tmp/bad-image.tar.gz bad-image-tag/
tar czf /tmp/pvc.tar.gz pvc-pending/

npx sbi analyze /tmp/wrong-db.tar.gz --no-ai
npx sbi analyze /tmp/missing-secret.tar.gz --format json --output-dir ./out
npx sbi analyze /tmp/bad-image.tar.gz --tui --no-ai
```

---

## Report Formats

When `--output-dir` is set, all three report files are written:

| File | Format | Contents |
|---|---|---|
| `findings.json` | JSON | Schema-versioned structured report. Each finding includes `confidenceQuality: "strong" | "moderate" | "weak"` indicating how well-supported the confidence score is. |
| `report.md` | Markdown | Executive summary, ranked findings with severity badges and confidence (`81% (weak)`, `100% (strong)`), evidence tables, spec recommendations. |
| `report.html` | HTML | Self-contained (no CDN), severity colour-coding, collapsible sections, print-friendly. |

```bash
npx sbi analyze bundle.tar.gz --output-dir ./reports --trace
ls reports/
# findings.json  report.md  report.html  trace.json
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
         +--> Kubernetes investigator (CrashLoopBackOff, ImagePullBackOff, not-ready, pending)
         +--> Log investigator (DNS failure, connection timeout, missing resource, image pull)
         +--> Config investigator (missing secrets, service refs, image tag mismatches)
         +--> Service investigator (empty Endpoints, DNS-confirmed unreachable)
         +--> NetworkPolicy investigator (egress/ingress blocks)
         +--> AI investigator (DiagnosticGraph traversal + BM25 + HyDE semantic -> LLM)
         |
         +--> Causal template matching (MissingSecret->FailedMount->CrashLoop, etc.)
         +--> Hypothesis engine (3-5 competing hypotheses per symptom, ranked)
         +--> Verifier (contradictions, confidence adjustment, confidenceQuality)
         +--> Orchestrator merge (AI primary, hypothesis dedup, symptom suppression)
         |
         +--> Sort by severity + confidence
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
|   |   +-- verifier.ts             # Contradiction checks, confidenceQuality
|   +-- parsers/                    # K8s resources, events, logs, Helm, timeline
|   +-- pipeline/analyze.ts         # Main pipeline (8 steps)
|   +-- reporters/                  # JSON/Markdown/HTML reporters, spec recommender
|   +-- tui/                        # Ink-based interactive terminal UI
|   +-- types/                      # TypeScript domain types
+-- test/
|   +-- fixtures/scenarios/         # 6 failure scenarios (real Troubleshoot format)
|   +-- retrieval/                  # Retrieval quality tests (P@K, R@K, MRR)
|   +-- golden/                     # CI/CD eval framework
|   +-- integration/                # Full pipeline integration tests
|   +-- e2e/                        # End-to-end scenario tests
+-- scripts/
|   +-- benchmark-hypotheses.mjs    # Diagnosis quality benchmark
|   +-- benchmark-retrieval.mjs     # Retrieval precision/recall benchmark
+-- docs/
|   +-- findings-and-improvements.md   # 700+ line improvement roadmap (7 tiers)
|   +-- support_bundle_investigator_prd_v2.md
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
  --no-ai             Disable AI features (heuristic-only, offline-safe)
  --tui               Launch interactive terminal UI
  -h, --help          Help
```

```
Usage: rat [options] [path]

Arguments:
  path                Directory to scan or .tar.gz to analyze (default: ./bundles/)

Options:
  --no-build          Skip auto-build check
  --no-embedding-setup  Skip embedding setup prompt (useful in CI or scripts)
```

---

## Design Decisions

**Local-first.** Support bundles contain sensitive cluster data. All heuristic analysis runs locally — no data leaves your machine. AI investigation (LLM calls) is additive and optional. Both the LLM and embedding backends can run entirely locally via Ollama, llama.cpp, or TEI — set `SBI_LLM_BACKEND=local` for a fully offline, air-gapped deployment.

**Heuristic precision floor.** Five deterministic investigators (Kubernetes, Log, Config, Service, NetworkPolicy) provide reliable offline analysis. AI findings are merged on top, never replacing the heuristic baseline.

**Differential diagnosis.** For each symptom, 3-5 competing root-cause hypotheses are generated from a declarative template registry and scored. The top finding includes an explicit comparison explaining why the runner-up was rejected.

**Confidence quality, not just a number.** Every finding carries `confidenceQuality: strong | moderate | weak` alongside the numeric confidence. `81% (weak)` means the number could shift significantly with more bundle data; `100% (strong)` means it's well-grounded across multiple independent sources.

**DiagnosticGraph.** A unified graph replaces two disconnected legacy graphs. It combines structural K8s edges (owner-refs, label-selectors, service-selectors), causal edges (from template matching and investigators), and temporal edges (log chunk ↔ event correlations, sequential event causality). Graph traversal for AI retrieval uses this richer edge set.

**BM25 + Reciprocal Rank Fusion.** Lexical search uses proper BM25 (TF saturation k1=1.2, length normalisation b=0.75, IDF). Graph, lexical, and semantic results are merged via RRF (k=60).

**Late chunking with TEI.** When TEI is running, each log chunk gets an embedding that encodes full-document context via token-level average pooling. A log error at line 3000 implicitly encodes `DB_HOST=db.internal` from line 12 because the transformer saw the entire document.

**Spec recommendations.** When confidence is limited by missing bundle data, the system recommends specific collectors, analyzers, or redaction rules to improve future bundles.

**No emoji.** Text symbols, ANSI colors, box-drawing characters, ASCII art only.
