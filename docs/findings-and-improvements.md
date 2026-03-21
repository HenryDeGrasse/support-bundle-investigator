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

## Tier 4 — Graph Architecture (unified diagnostic graph)

### Current state: two disconnected graphs, one never read

We have three graph structures, none of which work together:

**ResourceRelationshipGraph** (`resource-graph.ts`): K8s structural edges (Pod→Secret, Pod→Deployment via ownerRef, Event→Pod). Queried only by `getRelatedChunks` in the AI investigator. Traversal is plain undirected BFS at depth=2 with no edge-type filtering, no scoring, no direction awareness.

**InvestigationGraphImpl** (`investigation-graph.ts`): A write-only data structure. The pipeline adds nodes and edges (`supports`, `correlates`), serializes to trace JSON, and never reads from it. `getNeighbors`, `getSupportingEvidence`, `getContradictions`, `findPath`, `getSubgraph` — all zero callers outside tests.

**FindingTree** (`finding-tree.ts`): Designed to organize findings into causal hierarchies using `causes` edges. But `causes` edges are never created (0 uses in the codebase). `buildFindingTree`, `getRootCauses`, `traverseDFS`, `getAncestors` — all dead code.

Edge types declared vs. used: `supports` (14), `correlates` (3), `causes` (0), `contradicts` (0), `derived-from` (0).

The actual diagnostic reasoning (hypothesis generation, evidence collection, ranking) is entirely procedural — flat array operations that don't touch the graph. The graph is decoration.

### 4.1 Unify into a single diagnostic graph
**Files:** merge `src/graph/resource-graph.ts` + `src/graph/investigation-graph.ts` → new `src/graph/diagnostic-graph.ts`

One graph, all node types, all edge types. Built in three phases during the pipeline:

**Phase A — Structural layer (deterministic, from K8s specs):**
Nodes: every parsed resource, event, log chunk, analyzer result.
Edges from K8s specs:
- `owner-reference`: Pod → ReplicaSet → Deployment
- `label-selector`: Deployment `spec.selector.matchLabels` → Pods with matching labels (see 4.3)
- `references-secret`: Pod → Secret (volumes, envFrom, env.valueFrom)
- `references-configmap`: Pod → ConfigMap
- `references-pvc`: Pod → PVC
- `event-target`: Event → involvedObject
- `service-selector`: Service → Pods matching selector labels
- `endpoint-backing`: Endpoints → Pod IPs → Pods

**Phase B — Causal layer (deterministic, from investigator findings):**
When investigators discover findings, they create `causes` edges encoding the diagnostic chain (see 4.2). These edges are what `FindingTree` was designed to consume but never got.

**Phase C — Semantic layer (LLM-extracted, optional):**
LLM triple extraction discovers relationships the schema can't encode (see 4.5). Community detection groups related entities. This layer is additive — the graph works without it.

All three phases write to the same graph. Queries traverse across all layers. A single traversal from a CrashLoopBackOff symptom can follow a `causes` edge to a FailedMount event, then a `references-secret` edge to the missing Secret, then a `label-selector` edge up to the Deployment — all in one walk.

### 4.2 Causal edges from investigators
**Files:** `src/investigators/kubernetes-investigator.ts`, `src/investigators/log-investigator.ts`, `src/investigators/orchestrator.ts`

When an investigator creates a finding, it also creates `causes` edges encoding the diagnostic chain it discovered. These replace the procedural hypothesis generator for known patterns.

**Causal template library:**
```
MissingSecret ─causes─► FailedMount ─causes─► CrashLoopBackOff ─causes─► DeploymentUnhealthy
MissingStorageClass ─causes─► ProvisioningFailed ─causes─► FailedMount ─causes─► PodPending
BadImageTag ─causes─► ErrImagePull ─causes─► ImagePullBackOff ─causes─► PodPending
DNSFailure ─causes─► ConnectionTimeout ─causes─► ReadinessProbeFailure ─causes─► PodNotReady
OOMKill ─causes─► ContainerRestart ─causes─► CrashLoopBackOff
ConfigMapTypo ─causes─► AuthFailure ─causes─► PodNotReady
```

When the K8s investigator detects CrashLoopBackOff with FailedMount events mentioning a Secret, it creates:
```
node: finding:missing-secret:app-credentials
edge: finding:missing-secret:app-credentials ─causes─► event:FailedMount:app-pod
edge: event:FailedMount:app-pod ─causes─► finding:crashloop:app-pod
edge: finding:crashloop:app-pod ─causes─► finding:workload-unhealthy:app-deployment
```

Now `buildFindingTree` produces a real tree. `getRootCauses` returns `missing-secret:app-credentials`. The TUI shows:
```
Missing Secret 'app-credentials' [ROOT CAUSE]
  └─► FailedMount on Pod 'app-pod'
        └─► CrashLoopBackOff: Pod 'app-pod'
              └─► Unhealthy Workload: Deployment 'app-deployment'
```

This replaces the hypothesis generator's procedural grouping with structural graph traversal. The hypothesis layer becomes a fallback for cases where no causal template matches.

### 4.3 Label-selector and service-selector edges
**Files:** `src/graph/resource-graph.ts` (`buildResourceGraph`)

Two new edge types that encode how Kubernetes actually associates resources:

**Label-selector edges:** Deployment/StatefulSet/DaemonSet `spec.selector.matchLabels` → Pods with matching `metadata.labels`. This is how K8s associates workloads with Pods. Works even when the intermediate ReplicaSet isn't in the bundle (which happens with some collectors).

**Service-selector edges:** Service `spec.selector` → Pods with matching labels. Enables the connectivity investigator (5.1) to traverse from "this Service" to "these are the Pods backing it" to "they're all in CrashLoopBackOff, that's why the Service has no endpoints."

Implementation: after adding all resource nodes, iterate Services and Deployments. For each selector, scan all Pods for label matches. O(services × pods) — fine for bundle scale (~100 services × ~200 pods = 20K comparisons).

### 4.4 Typed, weighted, directional traversal
**Files:** new `src/graph/traversal.ts`, replaces `getNeighborhood` BFS

Replace the current undirected BFS with a query-pattern traversal engine. Key capabilities:

**Edge-type filtering:** "Follow only `causes` edges" or "follow `references-secret` then `event-target`."

**Direction awareness:** `causes` edges are directional. Backward traversal = root-cause search (symptom → cause). Forward traversal = impact analysis (cause → all affected symptoms).

**Weighted scoring:** Edges carry weights. `references-secret` (high diagnostic value) > `owner-reference` (structural) > `event-target` (noisy). Traversal scores decay with distance: `score = edge_weight × decay^depth`.

**Traversal patterns (replacing BFS):**
```typescript
// Root-cause search: from symptom, walk backward along causes edges
const rootCause = graph.traverse({
  start: 'finding:crashloop:app-pod',
  direction: 'backward',
  edgeTypes: ['causes'],
  maxDepth: 5,
});
// Returns: [missing-secret:app-credentials] with full path

// Impact analysis: from root cause, walk forward along causes edges
const impact = graph.traverse({
  start: 'finding:missing-secret:app-credentials',
  direction: 'forward', 
  edgeTypes: ['causes'],
  maxDepth: 5,
});
// Returns: [FailedMount, CrashLoopBackOff, DeploymentUnhealthy]

// Evidence gathering: from a finding, walk all structural edges
const evidence = graph.traverse({
  start: 'finding:crashloop:app-pod',
  direction: 'both',
  edgeTypes: ['supports', 'references-secret', 'event-target'],
  maxDepth: 2,
  minWeight: 0.5,
});
// Returns: [Secret:app-credentials, Event:FailedMount, Event:BackOff, Pod:app-pod]

// Chunk retrieval (replaces getRelatedChunks): walk graph, collect chunks for matched nodes
const chunks = graph.traverseForChunks({
  start: seedNodeId,
  direction: 'both',
  edgeTypes: ['causes', 'references-secret', 'references-configmap', 'event-target', 'label-selector'],
  maxDepth: 3,
  scoreDecay: 0.7,  // depth-0=1.0, depth-1=0.7, depth-2=0.49, depth-3=0.34
  chunkIndex: chunks,
});
// Returns: scored chunks, feed directly into RRF merge
```

This replaces both `getNeighborhood` (resource graph BFS) and the flat chunk-matching loop in `getRelatedChunks` with a single, configurable traversal engine.

### 4.5 LLM-extracted knowledge graph (GraphRAG)
**Files:** new `src/graph/knowledge-extractor.ts`, new `src/graph/community.ts`

After deterministic edges are built from K8s specs and investigator findings, feed chunks to an LLM to extract relationships the schema can't encode:

**Extraction prompt per chunk:**
```
Extract all entities and relationships from this Kubernetes support bundle evidence.
Return JSON: { "triples": [{"source": "...", "relationship": "...", "target": "..."}, ...] }

Entity types: Pod, Deployment, Service, Secret, ConfigMap, PVC, Hostname, Image, Error, LogEntry
Relationship types: connects-to, configured-with, fails-because, authenticates-with, resolves-to, exposes
```

**Examples of what this discovers that schema extraction misses:**
- `ConfigMap:app-config ─configured-with─► Hostname:db.internal` (from data value, not spec)
- `Pod:app-pod ─connects-to─► Hostname:db.internal` (from log content, not spec)
- `LogEntry:line-47 ─fails-because─► Hostname:db.internal` (causal link from log error to config)
- `Secret:registry-creds ─authenticates-with─► Image:myapp:v999` (from dockerconfigjson type)

These triples create edges in the unified graph. Now a traversal from the DNS failure log entry can reach the ConfigMap value that defines the hostname, which no deterministic parser could connect.

**Community detection:**
After all edges (structural + causal + LLM-extracted) are in the graph, run Leiden community detection to find clusters:
- "Database stack": db-Pod, db-Service, db-Secret, db-ConfigMap, db-events, db-logs
- "Frontend stack": app-Pod, app-Deployment, app-Service, app-ConfigMap, app-logs
- "Ingress layer": ingress-controller, ingress-rules, TLS-secrets

Generate a summary per community via LLM. Store summaries as retrievable chunks. At query time, community summaries give the LLM the "big picture" of each application component without needing to see every individual artifact.

**Cost:** One LLM call per chunk for extraction (~3500 chunks at ~$0.01/call = ~$35 with GPT-4o-mini, or free with local LLM). Community detection is CPU-only (Leiden runs in <1s on graphs with <10K nodes). Summary generation is one LLM call per community (~5-20 communities).

**Local execution:** Triple extraction and community summaries can use a local LLM (Llama 3, Qwen2, Mistral via Ollama). Quality is lower than GPT-4o but sufficient for entity extraction. Pairs with the local embedding backend (3.6) for fully offline operation.

### 4.6 Temporal correlation edges
**Files:** `src/graph/diagnostic-graph.ts`, `src/parsers/timeline.ts`

Wire the unused timeline module into graph construction. Two sources of temporal edges:

**Log↔Event correlation:** When a log error at timestamp T matches an event within ±60 seconds targeting the same pod, add a `temporal-correlation` edge with the time delta as weight (closer = stronger).
```
LogEntry:dns-failure:10:00:16Z ─temporal(+5m14s)─► Event:Unhealthy:app-pod:10:05:30Z
```

**Event sequencing:** Sort events chronologically. When sequential events target the same pod and have causal affinity (e.g. FailedMount followed by BackOff), add a `temporal-sequence` edge.
```
Event:FailedMount:app-pod:10:05:15Z ─temporal-sequence─► Event:BackOff:app-pod:10:05:30Z
```

These edges let the traversal engine discover timing-based evidence chains that structural edges alone can't provide.

### 4.7 Hierarchical graph abstraction
**Files:** `src/graph/diagnostic-graph.ts`

Add hierarchy to the unified graph. Three levels:

**Bottom:** individual resources, events, log chunks, findings. This is what we have now.

**Middle (workload groups):** virtual nodes that aggregate a workload and its dependencies. One per Deployment/StatefulSet:
```
WorkloadGroup:app-deployment
  contains: Pod:app-pod, Secret:app-credentials, ConfigMap:app-config
  connected-to: Service:app-service
```
Derived automatically from `owner-reference` + `label-selector` + `references-*` edges. Traversal at this level answers "what's wrong with the app-deployment workload?" without enumerating individual Pods.

**Top (application components):** virtual nodes derived from community detection (4.5) or user-provided topology:
```
AppComponent:database-stack
  contains: WorkloadGroup:db-deployment, Service:db-service, PVC:db-data
AppComponent:frontend-stack
  contains: WorkloadGroup:app-deployment, Service:app-service, Ingress:app-ingress
```

Query routing: "why is the app broken?" starts at top level, finds the unhealthy component, drills into workload groups, then into individual resources. "why is this pod crashing?" starts at bottom, walks up to the workload group for context.

**TUI integration:** The hierarchical view maps directly to the TUI's pane layout. Findings pane shows the causal tree. Detail pane shows the workload group context. Specs pane shows the component-level topology.

### 4.8 Graph-driven investigation (replaces procedural orchestrator)

The end state: the orchestrator becomes a graph query engine instead of a procedural pipeline.

**Current flow (procedural):**
```
seeds → [k8s-investigator, log-investigator, config-investigator] → flat findings[]
  → hypothesis-generator (groups by component) → hypothesis-evidence-collector (scans arrays)
  → hypothesis-ranker (scores) → hypothesis-converter (to findings) → dedup → sort
```

**Target flow (graph-driven):**
```
1. Build structural graph (Phase A: K8s specs, label selectors, service selectors)
2. Run investigators → create finding nodes + causes edges in the graph
3. Run causal template matching → instantiate causal chains in the graph
4. (Optional) Run LLM triple extraction → add semantic edges
5. (Optional) Run community detection → add hierarchy
6. Root-cause query: from each symptom finding, traverse backward along causes edges
7. If no causal path found → fall back to hypothesis generator (current behavior)
8. Rank root causes by: causal path length, edge weights, evidence count
9. Build finding tree from causes edges → present to user
```

The hypothesis generator becomes the fallback for novel failures that don't match a known causal template. As more templates are added (and as the LLM extraction layer discovers new patterns), the fallback is needed less often.

**What this achieves:** The graph IS the diagnosis. Every finding has a structural explanation — a path through typed edges from symptom to root cause. Evidence is not just "this file supports this finding" but "this Secret is missing (causes) this FailedMount (causes) this CrashLoopBackOff (causes) this Deployment unhealthy." The user sees the causal chain, not a ranked list of disconnected findings.

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

## Tier 7 — Pipeline Integrity & Confidence Calibration

Gaps found in the diagnostic pipeline logic that affect correctness, not just performance.

### 7.1 AI evidence paths are never grounding-verified
**Files:** `src/investigators/ai-investigator.ts` (`convertAIFindings`), `src/ai/schemas.ts`

When the LLM cites a path like `cluster-resources/pods/default/app-pod.json`, `matchChunkForEvidence` looks for it in the chunk index. If the path doesn't match any chunk (common because chunk IDs use fabricated paths — see 1.2), the evidence item is still included with `artifactType: undefined`. No confidence penalty, no filtering. A finding can have 100% confidence with evidence citing nonexistent files.

Fix: after `convertAIFindings`, check each evidence item against the chunk index. If the path doesn't match any chunk's `artifactId`, either drop the evidence item or penalize the finding's confidence (-0.10 per ungrounded citation). If all evidence items are ungrounded, drop the entire finding.

### 7.2 AI confidence is unscored — LLM value taken at face value
**Files:** `src/investigators/ai-investigator.ts`, `src/investigators/orchestrator.ts`

The LLM returns `confidence: 1.0` and it's used directly. No adjustment for evidence grounding strength, hallucinated paths, thin evidence, or cross-source diversity. The heuristic pipeline has a multi-factor confidence model (verifier + hypothesis ranker). The AI pipeline has none.

Fix: apply a confidence scoring pass to AI findings after conversion. Factors: grounding ratio (how many evidence paths matched actual chunks), evidence count, cross-source diversity, specificity of reasoning. Reuse the same scoring constants from the hypothesis ranker where applicable.

### 7.3 AI findings bypass verifier contradiction checks in practice
**Files:** `src/investigators/verifier.ts`, `src/investigators/ai-investigator.ts`

The verifier's `parsePodComponent` expects exactly `Pod/namespace/name`. LLM-generated `affectedComponents` may use variant formats (`"Pod app-pod"`, `"default/app-pod"`, `"pod/default/app-pod"` lowercase). When parsing fails, all contradiction checks silently skip the finding. The finding passes verification unchecked.

Fix: normalize `affectedComponents` in AI findings before verification. Strip leading/trailing whitespace, handle lowercase `pod/`, handle missing `Pod/` prefix, split `namespace/name` patterns.

### 7.4 Evidence collector hardcodes fake bundle file paths
**Files:** `src/investigators/hypothesis-evidence-collector.ts`

`podFilePath()`, `secretFilePath()`, `eventsFilePath()` generate paths like `cluster-resources/pods/default/app-pod.yaml` — the fake fixture format. On real bundles, these paths don't match any actual file. Evidence items produced by the collector cite nonexistent paths.

Fix: align with real bundle paths (flat JSON lists) after fixture rewrite (1.1), or resolve paths against the actual manifest.

### 7.5 No cross-symptom hypothesis correlation — ✅ Resolved
**Files:** `src/investigators/hypothesis-generator.ts`, `src/investigators/orchestrator.ts`

Implemented a cross-symptom correlation pass after per-symptom ranking. When multiple symptom groups in the same namespace converge on the same top-ranked category, SBI now emits cluster-wide meta-findings such as `finding:meta:cluster-wide:dns-failure:*` with convergence-boosted confidence.

Coverage now includes both unit tests for `correlateAcrossSymptoms()` and an orchestrator integration test proving the full pipeline preserves the meta-finding through dedup and final output sorting.

### 7.6 No active falsification of hypotheses
**Files:** `src/investigators/hypothesis-evidence-collector.ts`

Contradicting evidence search is passive — checks for success patterns in logs and healthy pod status. Never actively seeks evidence that would disprove a hypothesis. For "DNS failure" hypothesis, doesn't check whether there are successful DNS lookups for the same hostname in any log. For "missing Secret" hypothesis, doesn't check whether the Secret is actually present (it checks for absence but doesn't look for presence as contradicting signal when the hypothesis is something else).

Fix: for each hypothesis, define what evidence would falsify it and actively search for that. "DNS failure" → search for `"successfully resolved"` or `"connected to <hostname>"` for the same hostname. "Registry auth failure" → search for successful pulls of other images from the same registry.

### 7.7 Confidence scores not calibrated against ground truth — ✅ Resolved
**Files:** `src/investigators/hypothesis-ranker.ts`, `src/investigators/__tests__/hypothesis-ranker.test.ts`, `scripts/benchmark-hypotheses.mjs`

The confidence model now has explicit calibration regression coverage in the unit suite. Tests assert monotonicity across increasing evidence quality, enforce boundary conditions (`0.0` with no evidence, generic-only cap at `<= 0.50`, max score `<= 1.0`), and verify contradiction / missing-decisive penalties.

The benchmark remains as a corpus-level signal, but the primary calibration gate is now the test suite, including fixture-inspired scenario ranking checks for `wrong-db-endpoint`, `missing-secret-crashloop`, `bad-image-tag`, and `pvc-pending`.

### 7.8 Five dedup/merge layers with overlapping logic — ✅ Resolved
**Files:** `src/investigators/orchestrator.ts`, `src/investigators/__tests__/orchestrator.test.ts`

The orchestrator has been consolidated into a documented two-pass architecture plus a separate suppression step:
1. **Pass 1 — component/family structural merge** with explicit winner rules (AI > hypothesis > heuristic) and evidence absorption
2. **Pass 2 — title-based cosmetic dedup** for wording collisions across components
3. **Symptom suppression** as a distinct post-dedup cleanup step

Contract tests now verify non-overlap between passes, evidence preservation across passes, hypothesis-vs-heuristic and AI-vs-hypothesis precedence, and the normalization boundaries between Pass 1 and Pass 2.

### 7.9 Spec recommender ignores AI findings
**Files:** `src/reporters/spec-recommender.ts`

`suggestFromHypothesisGaps` only processes `finding:hypothesis:*` findings. AI findings (`finding:ai:*`) may have `missingEvidence` entries pointing to useful spec gaps but they're ignored.

Fix: process all findings in the hypothesis gap recommender, not just hypothesis-prefixed ones.

### 7.10 No node resource investigation — ✅ Resolved
**Files:** `src/investigators/kubernetes-investigator.ts`, `src/investigators/seed-generator.ts`, `src/investigators/__tests__/kubernetes-investigator.test.ts`, `src/investigators/__tests__/seed-generator.test.ts`

Node investigation now covers more than simple health conditions. SBI added:
- allocatable-vs-capacity memory analysis for constrained nodes
- taint analysis for `NoSchedule` / `NoExecute` scheduling blockers
- causal correlation from `MemoryPressure` nodes to OOMKilled pods on the same node
- seed generation for scheduling-preventing node taints

The Kubernetes investigator also links taint findings conservatively to matching `FailedScheduling` events and emits node-level findings without over-attributing unrelated scheduling failures.

### 7.11 Hypothesis templates are procedural, not declarative — ✅ Resolved
**Files:** `src/investigators/hypothesis-generator.ts`, `src/investigators/hypothesis-templates.ts`, `src/investigators/hypothesis-evidence-collector.ts`

The hypothesis layer now uses a declarative template registry. Templates carry `evidenceRules`, and the generator passes those rules through into each instantiated `Hypothesis`. The evidence collector can execute template-driven supporting / contradicting rules directly, which reduces the need for category-specific procedural code.

Phase 7 also added a standalone `oom-kill` template plus dedicated collectors for `oom-kill` and `missing-service`, so new failure patterns can be introduced with a mix of declarative templates and narrowly scoped collector extensions where deeper resource correlation is needed.

### 7.12 No uncertainty communication beyond a single number
**Files:** `src/types/finding.ts`, `src/reporters/`

The user sees `80%` confidence as a point estimate. No indication of whether the system is certain about that 80% (5 evidence items, all specific, cross-source) or uncertain (1 generic evidence item, 2 missing decisive). The `confidenceRationale` text exists but is buried in reasoning, not surfaced as a first-class UI element.

Fix: add `confidenceQuality: 'strong' | 'moderate' | 'weak'` to `Finding` based on evidence count + specificity + missing decisive count. Display in TUI and reports alongside the percentage: `80% (strong)` vs `80% (weak)`. "Strong" means the number is well-supported. "Weak" means the number could shift significantly with more evidence.

---

## Implementation Priority

**Phase 0 — Pipeline integrity (1-2 days):** 7.1-7.4 (grounding verification, AI confidence scoring, verifier normalization, evidence path alignment). These are correctness bugs — AI findings can cite nonexistent files at 100% confidence with zero verification. Fix before anything else.

**Phase 1 — Foundations (1-2 days):** 1.1-1.7. Fix fixtures, fix broken identifiers, wire up unused code. No architecture changes. All existing tests updated.

**Phase 2 — Retrieval core (2-3 days):** 2.1 (BM25), 2.2 (RRF), 2.5-2.7 (graph improvements), 2.9 (value indexing). The biggest quality jump. Write retrieval tests (6.1, 6.2) first as TDD targets.

**Phase 3 — Hybrid chunking + local embedding (3-4 days):** 3.1 (error-aware log chunking), 3.3 (summary content for resources), 3.4 (token budget), 3.5 (dedup), 3.6 (local embedding backend with TEI/Ollama), 3.2 (late chunking over error-aware boundaries). This is the chunking + embedding refactor done together. Error-aware chunking is pure logic (day 1). Local embedding backend is infra (day 2). Late chunking wires them together (day 3). Token budget + resource summaries complete the picture (day 4).

**Phase 4 — Advanced retrieval (2-3 days):** 2.3 (contextual retrieval), 2.4 (HyDE), 2.8 (embed content not summaries), 2.10 (seed dedup). Each independently measurable. Contextual retrieval pairs naturally with the local embedding backend — the context prefix LLM call can use a local LLM too.

**Phase 5 — Graph architecture (5-7 days).** The deepest refactor. Done in sub-phases:
- **5a (2 days):** Unify graphs (4.1), add label-selector + service-selector edges (4.3), typed weighted traversal engine (4.4). This gives us one graph, better structural edges, and a real query engine. Replaces `getRelatedChunks` BFS.
- **5b (1-2 days):** Causal edges from investigators (4.2), wire `FindingTree` + `getRootCauses` to the TUI. The finding tree works for the first time. Users see causal chains.
- **5c (1 day):** Temporal correlation edges (4.6), hierarchy middle layer (4.7 — workload groups from label selectors).
- **5d (2 days):** LLM triple extraction (4.5), community detection + summaries, hierarchy top layer. This is GraphRAG. Requires local or API LLM. Most impactful for large bundles with many components.
- **5e (ongoing):** Graph-driven investigation (4.8) — incrementally replace procedural hypothesis logic with graph traversal queries. Hypothesis generator becomes fallback for novel failures.

**Phase 6 — New investigators + testing (2-3 days):** 5.1-5.3 (new investigators), 6.3 (benchmark). New investigators create causal edges in the unified graph from day one.

### Dependency graph

```
Phase 0 (pipeline integrity — AI grounding, confidence scoring, verifier fixes)
  └─► Phase 1 (foundations — fixtures, identifiers, dead code)
        └─► Phase 2 (BM25 + RRF)
        ├─► Phase 3 (hybrid chunking + local embedding)
        │     └─► Phase 4 (contextual retrieval, HyDE)
        └─► Phase 5a (unified graph + traversal engine)
              └─► Phase 5b (causal edges + finding tree)
                    ├─► Phase 5c (temporal + hierarchy)
                    │     └─► Phase 5d (GraphRAG)
                    │           └─► Phase 5e (graph-driven investigation)
                    └─► Phase 6 (new investigators, create causal edges)
```

Phase 0 first (correctness). Phase 1 next (fixtures, dead code). Phase 2 and Phase 3 can run in parallel after Phase 1. Phase 4 depends on Phase 3 (needs local embedding backend). Phase 5a can start after Phase 1 (doesn't need retrieval changes). Phase 5b depends on 5a. Phase 6 depends on 5b (investigators need to create causal edges in the unified graph). Phase 5d depends on Phase 3 (needs local LLM for triple extraction) and 5c. Within Tier 7, items 7.5, 7.7, 7.8, 7.10, and 7.11 are now resolved; the remaining items (notably 7.6, 7.9, 7.12) stay threaded into their respective phases.
