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

## Tier 3 — Chunking Upgrade

### 3.1 Semantic chunking for logs (error-aware)
**Files:** `src/graph/chunker.ts` (`chunkLogFile`), `src/parsers/log-parser.ts` (`extractErrorWindows`)

Replace fixed 50-line window with error-centered chunking. `extractErrorWindows()` already identifies error clusters — build chunks centered on those. Non-error regions chunked at coarser granularity (200 lines) or collapsed into single-line summaries: "lines 100-300: 200 INFO lines, no errors, application healthy."

This dramatically improves chunk relevance. Most log chunks currently sent to the LLM are pure INFO noise consuming token budget.

### 3.2 Use structured summaries as chunk content for K8s resources
**Files:** `src/graph/chunker.ts` (`chunkResource`), `src/ai/summarizer.ts`

`chunkResource()` sends full `JSON.stringify` (50-200 lines) as content. `summarizeResource()` produces 5-15 line summaries with all diagnostic signals. Use summaries as LLM-facing content, keep raw JSON in metadata for full-fidelity lookups. 5-10x effective context window usage.

### 3.3 Token budget awareness in chunk merge
**Files:** `src/investigators/ai-investigator.ts`

No token counting or context window awareness. 20 chunks of raw JSON could exceed model limits. Estimate tokens per chunk (`content.length / 4`), track running total during merge, switch from raw content to summaries for lower-priority chunks when approaching budget (e.g. 80% of model context window).

### 3.4 Enable log deduplication for AI context
**Files:** `src/parsers/log-parser.ts`, `src/pipeline/analyze.ts`

`parseLogFile` has `dedup` option but it's never enabled. 47 identical DNS failure lines bloat chunks. Enable dedup at parse time or at minimum when building AI chunks. The `[repeated x47]` suffix preserves signal.

### 3.5 Late chunking (Jina AI approach)
**Files:** `src/graph/chunker.ts`, `src/ai/embeddings.ts`

Embed the full document first using a long-context model, then extract chunk-level embeddings from the corresponding token positions. Each chunk embedding retains full-document context, solving the "orphan chunk" problem where `"it failed"` loses meaning without preceding context. Most impactful for log files where error messages reference variables defined earlier in the log.

Requires a long-context embedding model (Jina embeddings v3, or OpenAI's text-embedding-3-large with 8K context). Implementation: embed full log file → slice embedding tensor at chunk boundaries → store per-chunk embeddings.

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

**Phase 3 — Chunking upgrade (1-2 days):** 3.1 (error-aware log chunking), 3.2 (summary content), 3.3 (token budget), 3.4 (dedup). Makes the context sent to the LLM dramatically more relevant.

**Phase 4 — Advanced retrieval (2-3 days):** 2.3 (contextual retrieval), 2.4 (HyDE), 2.8 (embed content), 2.10 (seed dedup), 3.5 (late chunking). Each one independently measurable.

**Phase 5 — Graph architecture (3-5 days):** 4.1 (causal edges), 4.2 (label selectors), 4.3 (GraphRAG), 4.4 (hierarchy), 4.5 (temporal edges). This is the deepest refactor — transforms the system from "structured search" to "knowledge-graph-driven diagnosis."

**Phase 6 — New investigators + testing (2-3 days):** 5.1-5.3 (new investigators), 6.3 (benchmark). Extends coverage to new failure modes.
