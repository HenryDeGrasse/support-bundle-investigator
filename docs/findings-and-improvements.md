# Findings & Improvements

Gaps identified during architecture review plus state-of-the-art upgrades to make this an elite diagnostic system. Organized by priority tier.

---

## Tier 1 — Foundational (fix what's broken)

### 1.1 Test fixtures use fake bundle format
**Files:** `test/fixtures/scenarios/*`

Our 4 main scenarios use a made-up layout (one YAML per resource, `analyzers/output.json`, `logs/app/pod.log`). Real Troubleshoot bundles use flat JSON Lists (`pods/default.json` containing `PodList`), `analysis.json` at root, logs under `cluster-resources/pods/logs/<ns>/<pod>/<container>.log`. Only `realistic-bundle-format/` matches reality. Rewrite all 4 scenarios to match real Troubleshoot format. Every test should exercise the code path real users hit.

### 1.2 Chunk IDs fabricate non-existent file paths
**Files:** `src/ai/chunk-indexer.ts`

For resources from List files, chunk indexer fabricates paths like `cluster-resources/pod/default/app-pod.json` that don't exist in the bundle. LLM cites these in evidence, violating its own grounding rules. Use the actual manifest file path with resource name as qualifier in chunk ID.

### 1.3 Log chunk identifiers drop the pod name
**Files:** `src/ai/chunk-indexer.ts` (`identifiersFromLogContent`)

`app-pod.log` → identifier `app` (not `app-pod`) because filenames ending in `.log` are filtered. Fix: strip extension before filtering. Also extract parent directory name (pod name in real bundle paths like `pods/logs/default/app-pod/app.log`).

### 1.4 Init container log association broken
**Files:** `src/investigators/log-investigator.ts` (`resolveLogPodComponent`)

Init container logs at `pods/logs/<ns>/<pod>/<init-container>.log` — `resolveLogPodComponent` matches on filename (container name), not parent directory (pod name). Check parent directory against known pod names.

### 1.5 `config` artifact category is dead code
**Files:** `src/types/bundle.ts`, `src/ingestion/classifier.ts`

Declared but never returned by classifier. Remove or implement.

### 1.6 Helm releases parsed but never used
**Files:** `src/parsers/helm-parser.ts`, `src/pipeline/analyze.ts`, `src/ai/chunk-indexer.ts`

`parseHelmReleaseFile()` exists but pipeline never calls it. Add `helmReleases` to `InvestigatorContext`, parse in pipeline, chunk, and index. Helm values overrides and release status (`failed`, `pending-install`) are high-signal diagnostic data.

### 1.7 Timeline module built but never called
**Files:** `src/parsers/timeline.ts`

`sortEventsByTime()`, `buildTimeline()`, `getEventWindow()` have full test coverage but are unused. Wire into investigators for timestamp-based evidence correlation (see 3.5).

---

## Tier 2 — Retrieval Quality (biggest ROI)

### 2.1 Replace raw term frequency with BM25
**Files:** `src/ai/lexical-search.ts`

Current content scoring: `token_count × 1.0`. No IDF, no length normalization, no saturation. At scale (~3500 chunks), common tokens like `default` drown relevant results.

Replace with BM25: `IDF(t) × (tf × (k1+1)) / (tf + k1 × (1 - b + b × |d|/avgdl))`. Standard params: `k1=1.2, b=0.75`. This is ~40 lines of code and the single highest-impact retrieval improvement.

Implementation: precompute `df(t)` (document frequency per term) and `avgdl` (average chunk length) during `build()`. Use them in `search()` scoring. The identifier (3.0) and namespace (1.5) signal paths stay unchanged — BM25 replaces only the content-token scoring.

### 2.2 Replace positional merge with Reciprocal Rank Fusion
**Files:** `src/investigators/ai-investigator.ts` (`mergeChunks`)

Current: graph chunks first, lexical fills remainder, semantic gets leftovers. No cross-system score comparison.

Replace with RRF: `score(chunk) = Σ_systems 1/(k + rank_in_system)`, `k=60`. Chunks found by multiple systems rank higher. ~20 lines. Pair with 2.1 for immediate quality jump.

### 2.3 Contextual retrieval — prepend document context to chunks before embedding
**Files:** `src/ai/chunk-indexer.ts`, `src/ai/embeddings.ts`

Anthropic (2024): prepend a short context sentence to each chunk before embedding: "This chunk is from the Pod spec for app-pod in namespace default. It describes container environment variables and references Secret app-credentials." Reduced top-20 retrieval failure by 49% in benchmarks. 

Implementation: one LLM call per source document (not per chunk) to generate context prefix. Prepend to chunk content before embedding. Store both raw and contextualized content. Low cost, high impact.

### 2.4 HyDE — Hypothetical Document Embeddings for semantic search
**Files:** `src/investigators/ai-investigator.ts`, `src/ai/vector-store.ts`

Instead of embedding the raw seed hypothesis for vector search, ask the LLM to generate what the ideal evidence chunk would look like, then embed that. The hypothetical document embedding is closer in vector space to the real evidence than the question is.

Our seeds are already hypotheses — HyDE is a natural fit. "Pod app-pod is in CrashLoopBackOff" → LLM generates "Container app in pod app-pod terminated with exit code 1 due to missing environment variable DB_PASSWORD referenced from secret app-credentials which does not exist in namespace default" → embed this → retrieve.

### 2.5 Graph retrieval only helps Pod and Event seeds
**Files:** `src/graph/resource-graph.ts` (`getRelatedChunks`)

Analyzer and Log seeds skip neighborhood walks. Fix: extract entity names from hypothesis text, resolve them to graph nodes, walk their neighborhoods. For Analyzer seeds with no entity names, find unhealthy pods in the same namespace and walk from there.

### 2.6 No graph chunk scoring by hop distance
**Files:** `src/graph/resource-graph.ts` (`getRelatedChunks`, `getNeighborhood`)

Graph results are unranked bags. Score by hop: depth-0=1.0, depth-1=0.7, depth-2=0.4. Feed scores into RRF.

### 2.7 Stop-word list too aggressive
**Files:** `src/ai/lexical-search.ts` (`K8S_STOP_WORDS`)

`secret`, `service`, `configmap`, `missing`, `failed`, `unreachable` all stopped. Hypothesis "missing secret app-credentials" extracts only `app-credentials`. Apply stop list to RFC-1123 name extraction only, not compound term matching.

### 2.8 Vector store embeds summaries, not content
**Files:** `src/ai/chunk-indexer.ts`, `src/pipeline/analyze.ts`

Log chunk summary: `"Log chunk from path (lines N-M)"` — zero diagnostic content. Semantic search can't match "DNS failure for db.internal" against a log that contains `"no such host: db.internal"`. Embed content (truncated to ~500 tokens), or prepend primary error lines to log summaries. With contextual retrieval (2.3), this becomes even more important.

### 2.9 No ConfigMap/Secret value indexing
**Files:** `src/ai/chunk-indexer.ts` (`identifiersFromResource`)

Identifiers extract key names but not values. `DB_HOST: "wrong-host.internal"` doesn't surface the hostname. Log investigator finds DNS failure for that hostname but lexical index can't connect it to the ConfigMap. Extract hostnames, URLs, connection strings from ConfigMap data values and pod env var values.

### 2.10 Deduplicate overlapping seeds before LLM calls
**Files:** `src/investigators/ai-investigator.ts`

With small bundles, every seed gets identical chunks — 6 LLM calls with same context, slightly different framing. Compute chunk-set overlap between seeds. Seeds with >80% overlap get combined into single multi-hypothesis call.

---

## Tier 3 — Hybrid Chunking + Local Embedding

The chunking and embedding layers are refactored together as a hybrid: error-aware chunking produces **better chunks** (meaningful diagnostic units), late chunking produces **better embeddings** (each chunk vector encodes full-document context). They operate at different pipeline stages and compound.

```
Log file (5000 lines)
  │
  ├─ Stage 1: Error-aware chunker (deterministic, zero cost)
  │   → Chunk 1: lines 1-20 (startup/config preamble — always included)
  │   → Chunk 2: lines 145-195 (DNS error cluster, 12 errors)
  │   → Chunk 3: lines 290-340 (timeout cluster, 8 errors)
  │   → Chunk 4: lines 800-830 (OOM warning cluster)
  │   → Summary chunk: "lines 21-144, 196-289, 341-799, 831-5000: healthy, no errors"
  │   Result: 5 chunks instead of 100 fixed-window chunks
  │
  ├─ Stage 2: Late chunking embedder (local GPU, ~200ms)
  │   → Embed full 5000-line log through local model (131K context)
  │   → Slice token-level embeddings at chunk boundaries [0-20, 145-195, ...]
  │   → Each chunk embedding encodes the full log context
  │   Result: each error chunk "knows" about config/setup from line 1-20
  │
  └─ Final: 5 chunks, each meaningful, each embedding context-aware
     20x fewer chunks, 20x better token budget usage, better retrieval
```

Why hybrid beats either alone:
- Error-aware alone: great chunks, but embeddings are isolated. Timeout chunk at line 3000 doesn't "know" about `DB_HOST=db.internal` at line 12.
- Late chunking alone with fixed windows: embeddings have context, but the LLM receives messy 50-line slices — half an error here, noise there.
- Hybrid: LLM receives clean error-centered chunks (good for comprehension) AND retrieval finds them via context-aware embeddings (good for search).

### 3.1 Error-aware log chunking
**Files:** `src/graph/chunker.ts` (`chunkLogFile`), `src/parsers/log-parser.ts` (`extractErrorWindows`)

Replace fixed 50-line window with error-centered chunking. `extractErrorWindows()` already identifies error clusters — build chunks centered on those. Three chunk types:

1. **Preamble chunk:** First 20-30 lines of every log (startup, config, env var logging). Always included — this is where connection strings, hostnames, and versions are logged.
2. **Error cluster chunks:** Centered on error windows with 10-line padding. Deduplicate repeated lines within each cluster (`[repeated x47]`).
3. **Summary chunk:** Single-line description of healthy regions: "lines 100-300: 200 INFO lines, no errors." Preserves the signal that these regions are healthy without consuming token budget.

This dramatically improves chunk relevance. Most log chunks currently sent to the LLM are pure INFO noise.

### 3.2 Late chunking with local embedding model
**Files:** `src/graph/chunker.ts`, `src/ai/embeddings.ts`, new `src/ai/local-embeddings.ts`

After error-aware chunking produces chunk boundaries, embed the full log document through a long-context local model, then slice the token-level embedding tensor at those boundaries. Average-pool each slice to get the chunk embedding.

Each chunk embedding retains full-document context. The error chunk about a timeout at line 3000 implicitly encodes `DB_HOST=db.internal` from line 12 because the transformer's attention saw it during the forward pass.

Implementation requires token-position mapping between the full-document embedding output and chunk line ranges. Use HuggingFace Text Embeddings Inference (TEI) server which exposes token-level outputs, or MLX directly on Apple Silicon. See 3.6 for local model details.

For K8s resources and events (single-chunk artifacts), late chunking adds nothing — standard single-document embedding is fine. Late chunking applies only to multi-chunk log files.

### 3.3 Use structured summaries as chunk content for K8s resources
**Files:** `src/graph/chunker.ts` (`chunkResource`), `src/ai/summarizer.ts`

`chunkResource()` sends full `JSON.stringify` (50-200 lines) as content. `summarizeResource()` produces 5-15 line summaries with all diagnostic signals. Use summaries as LLM-facing content, keep raw JSON in metadata for full-fidelity lookups. 5-10x effective context window usage.

### 3.4 Token budget awareness in chunk merge
**Files:** `src/investigators/ai-investigator.ts`

No token counting or context window awareness. 20 chunks of raw JSON could exceed model limits. Estimate tokens per chunk (`content.length / 4`), track running total during merge, switch from raw content to summaries for lower-priority chunks when approaching budget (e.g. 80% of model context window).

### 3.5 Enable log deduplication for AI context
**Files:** `src/parsers/log-parser.ts`, `src/pipeline/analyze.ts`

`parseLogFile` has `dedup` option but it's never enabled. 47 identical DNS failure lines bloat chunks. Enable dedup at parse time or at minimum when building AI chunks. The `[repeated x47]` suffix preserves signal. With error-aware chunking (3.1), dedup happens per-cluster naturally.

### 3.6 Local embedding backend (fully offline, self-hosted)
**Files:** new `src/ai/local-embeddings.ts`, `src/ai/config.ts`

Replace OpenAI API dependency with a pluggable local embedding backend. Aligns with Replicated's local-first DNA — no data leaves the network, no API keys required for embeddings.

**Target model: gte-Qwen2-1.5B-instruct** (default) or gte-Qwen2-7B-instruct (high-quality).

| Model | Params | VRAM (INT4) | VRAM (FP16) | Context | Speed (Apple Silicon) |
|---|---|---|---|---|---|
| gte-Qwen2-1.5B | 1.5B | 1.5 GB | 3 GB | 131,072 tokens | ~30-50ms/embed |
| gte-Qwen2-7B | 7B | 5 GB | 14 GB | 131,072 tokens | ~100-200ms/embed |

Both models: MIT license, available via Ollama and HuggingFace. 131K context covers any log file in a support bundle.

**Hardware requirements for the default 1.5B model:**
- Any Apple Silicon Mac with 8+ GB unified memory
- Any Linux/Windows machine with a discrete GPU (even 4 GB VRAM)
- CPU-only: ~2-5s per embedding — usable for small bundles, slow for large ones
- Production cluster: runs as a sidecar or Job — most nodes have more than enough

**Hardware for the 7B model (recommended for machines with 16+ GB):**
- Apple Silicon with 16+ GB unified memory (M1 Pro and up) — FP16, no quantization needed
- Any GPU with 8+ GB VRAM (RTX 3070+) at INT8, or 16+ GB (RTX 4080+) at FP16
- A single RTX 4090 (24 GB) serves the 7B model for a whole team via HTTP endpoint

**Runtime options (in order of preference for late chunking):**
1. **HuggingFace Text Embeddings Inference (TEI):** Docker container, exposes token-level embeddings via REST API. Required for true late chunking (need token-position outputs). `docker run ghcr.io/huggingface/text-embeddings-inference --model-id Alibaba-NLP/gte-Qwen2-1.5B-instruct`
2. **MLX (Apple Silicon native):** Direct Python/Swift integration via `mlx-lm`. Maximum performance on Mac. Supports token-level output with custom inference code.
3. **Ollama:** Simplest setup (`ollama pull qwen2:1.5b`). But only returns pooled embeddings — no token-level output. Works for standard embedding, NOT for late chunking. Use as fallback when TEI isn't available.

**Architecture:** Make `EmbeddingClient` an interface (it's already a class). Add `LocalEmbeddingClient` that calls a local HTTP endpoint. Config via environment:
```
SBI_EMBEDDING_BACKEND=local|openai     # default: local
SBI_EMBEDDING_URL=http://localhost:8080 # TEI or Ollama endpoint
SBI_EMBEDDING_MODEL=gte-Qwen2-1.5B     # model selection
```

When `SBI_EMBEDDING_BACKEND=local` and late chunking is enabled, use TEI's token-level endpoint. When TEI isn't available, fall back to Ollama pooled embeddings (standard embedding, no late chunking). When no local model is running, fall back to OpenAI API if `OPENAI_API_KEY` is set. When nothing is available, skip semantic retrieval entirely — graph + BM25 lexical still work.

**Graceful degradation chain:**
```
TEI (token-level, late chunking) → Ollama (pooled, standard embedding)
  → OpenAI API (pooled, standard embedding) → no semantic retrieval (graph + BM25 only)
```

**Self-hosting deployment for Replicated customers:**
- Ship TEI as an optional Helm chart component alongside the SBI analyzer
- Customer deploys TEI on a node with a GPU (or CPU-only for smaller bundles)
- SBI connects to TEI via cluster-internal service URL
- Zero external API calls, all data stays on-prem

---

## Tier 4 — Graph Architecture Upgrade

### 4.1 Causal edges in the resource graph
**Files:** `src/graph/resource-graph.ts`

Current graph has only structural edges (`references-secret`, `owner-reference`, `event-target`). Add **causal edges** encoding diagnostic direction:

```
Missing Secret →(causes)→ FailedMount →(causes)→ CrashLoopBackOff →(causes)→ Deployment Unhealthy
Missing StorageClass →(causes)→ ProvisioningFailed →(causes)→ FailedMount →(causes)→ Pod Pending
Bad Image Tag →(causes)→ ErrImagePull →(causes)→ ImagePullBackOff →(causes)→ Pod Pending
DNS Failure →(causes)→ Connection Timeout →(causes)→ Readiness Probe Fail →(causes)→ Pod Not Ready
```

Encode these as a causal template library. When evidence matches a template, instantiate the causal chain in the graph. Enables root-cause traversal: start from symptom node, walk backward along causal edges to find root cause. This replaces the procedural hypothesis generator with a structural, extensible mechanism.

### 4.2 Label-selector edges (Deployment → Pod)
**Files:** `src/graph/resource-graph.ts` (`buildResourceGraph`)

Graph relies on `ownerReferences` which go Pod→ReplicaSet→Deployment. If ReplicaSet isn't in the bundle, Deployment and Pod are disconnected. Add label-selector matching: Deployment `spec.selector.matchLabels` → Pods with matching `metadata.labels`. This is how Kubernetes actually associates them.

### 4.3 LLM-extracted knowledge graph (GraphRAG approach)
**Files:** new `src/graph/knowledge-graph.ts`

Microsoft GraphRAG (2024): feed chunks to an LLM to extract `(entity, relationship, entity)` triples. Discovers relationships schema-based extraction misses:

- "ConfigMap value `db.internal` is a hostname used to connect to the database"
- "Pod `app-pod` cannot start because Secret `app-credentials` does not exist"
- "Error at line 47 is caused by DNS failure for hostname referenced in env var DB_HOST"

Then run community detection (Leiden algorithm) to cluster related entities. Generate per-community summaries. At query time, retrieve both graph neighbors AND community summaries.

Implementation approach:
1. After chunking, send chunks to LLM with extraction prompt: "Extract all entities and relationships from this Kubernetes support bundle evidence"
2. Build entity graph from triples
3. Run community detection (use a JS implementation of Leiden or Louvain)
4. Generate community summaries via LLM
5. Store community summaries as retrievable chunks
6. At query time: graph neighborhood + BM25 + vector search + community summaries → RRF merge

### 4.4 Hierarchical graph abstraction
**Files:** `src/graph/resource-graph.ts`

Current graph is flat — all resources at the same level. Add hierarchy:
- **Bottom:** individual resources, events, log lines
- **Middle:** workload groups (Deployment + ReplicaSet + Pods + Secrets + ConfigMaps)
- **Top:** application components (frontend stack, database stack, ingress layer)

Middle layer is derivable from owner-references and label selectors. Top layer requires either LLM inference or user-provided application topology. Queries route to the appropriate level — "why is the app broken?" starts at top, "why is this pod crashing?" starts at bottom.

### 4.5 Temporal correlation edges
**Files:** `src/graph/resource-graph.ts`, `src/parsers/timeline.ts`

Wire the unused timeline module into graph construction. When a log error at timestamp T correlates with an event within ±60 seconds targeting the same pod, add a `temporal-correlation` edge. Enables evidence chains: "DNS failure at 10:00:16Z in app-pod.log → Unhealthy event at 10:05:30Z → ReadinessProbe failure."

---

## Tier 5 — Services/Endpoints & New Investigators

### 5.1 Services/Endpoints connectivity investigator
**Files:** new `src/investigators/service-investigator.ts`

Check whether Services referenced by pod env vars have matching Endpoints with ready addresses. "Service `my-service` exists but has 0 ready endpoints" is a high-confidence connectivity finding. Cross-reference with DNS failure findings from the log investigator.

### 5.2 NetworkPolicy investigator
**Files:** new investigator

Parse NetworkPolicy resources. Detect when a NetworkPolicy's pod selector matches a failing pod and its egress/ingress rules would block traffic to the dependency it's trying to reach.

### 5.3 Resource limits / OOM investigator
**Files:** extend `src/investigators/kubernetes-investigator.ts`

Detect OOMKilled termination reason in container statuses. Cross-reference with container resource limits vs requests. Flag when limits are set too low relative to the application's memory profile visible in logs.

---

## Tier 6 — Retrieval Quality Testing

### 6.1 Realistic-scale test fixture
**Files:** `test/fixtures/scenarios/`

Create a multi-namespace fixture: 5 namespaces, ~50 resources, ~200 events, ~10 log files (~500 chunks). Include both healthy and unhealthy resources. Plant specific diagnostic signals in specific chunks.

### 6.2 Retrieval precision/recall tests
**Files:** new `test/retrieval/__tests__/`

For each seed in the realistic fixture, assert: "top-5 retrieved chunks MUST include chunks A, B, C" (recall) and "MUST NOT include unrelated chunks from namespace X" (precision). Run against graph, lexical, and merged results independently. These tests validate that BM25, RRF, and contextual retrieval actually improve quality.

### 6.3 End-to-end retrieval quality benchmark
**Files:** `scripts/benchmark-retrieval.mjs`

Automated benchmark: for each scenario, log which chunks each seed retrieves, what the LLM receives, and what findings it produces. Track retrieval quality metrics (precision@5, recall@5, MRR) across code changes. Regression gate for retrieval refactors.

---

## Implementation Priority

**Phase 1 — Foundations (1-2 days):** 1.1-1.7. Fix fixtures, fix broken identifiers, wire up unused code. No architecture changes. All existing tests updated.

**Phase 2 — Retrieval core (2-3 days):** 2.1 (BM25), 2.2 (RRF), 2.5-2.7 (graph improvements), 2.9 (value indexing). The biggest quality jump. Write retrieval tests (6.1, 6.2) first as TDD targets.

**Phase 3 — Hybrid chunking + local embedding (3-4 days):** 3.1 (error-aware log chunking), 3.3 (summary content for resources), 3.4 (token budget), 3.5 (dedup), 3.6 (local embedding backend with TEI/Ollama), 3.2 (late chunking over error-aware boundaries). This is the chunking + embedding refactor done together. Error-aware chunking is pure logic (day 1). Local embedding backend is infra (day 2). Late chunking wires them together (day 3). Token budget + resource summaries complete the picture (day 4).

**Phase 4 — Advanced retrieval (2-3 days):** 2.3 (contextual retrieval), 2.4 (HyDE), 2.8 (embed content not summaries), 2.10 (seed dedup). Each independently measurable. Contextual retrieval pairs naturally with the local embedding backend — the context prefix LLM call can use a local LLM too.

**Phase 5 — Graph architecture (3-5 days):** 4.1 (causal edges), 4.2 (label selectors), 4.3 (GraphRAG), 4.4 (hierarchy), 4.5 (temporal edges). Deepest refactor — transforms the system from "structured search" to "knowledge-graph-driven diagnosis."

**Phase 6 — New investigators + testing (2-3 days):** 5.1-5.3 (new investigators), 6.3 (benchmark). Extends coverage to new failure modes.

### Dependency graph

```
Phase 1 (foundations)
  └─► Phase 2 (BM25 + RRF)
        ├─► Phase 3 (hybrid chunking + local embedding)
        │     └─► Phase 4 (contextual retrieval, HyDE)
        └─► Phase 5 (graph architecture)
              └─► Phase 6 (new investigators)
```

Phase 2 and Phase 3 can run in parallel once Phase 1 is done. Phase 4 depends on Phase 3 (needs local embedding backend). Phase 5 is independent of Phase 3/4 but benefits from Phase 2's retrieval improvements. Phase 6 can start anytime after Phase 1 for the investigator logic, but retrieval quality testing (6.1-6.3) should wait for Phase 2.
