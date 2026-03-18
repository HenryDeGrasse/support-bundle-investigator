# Findings & Improvements

Gaps and improvements identified during architecture review. Each item has enough context for an agent to find, investigate, and implement independently.

---

## Parsing & Ingestion

### 1. Test fixtures use fake bundle format
**Files:** `test/fixtures/scenarios/bad-image-tag/`, `missing-secret-crashloop/`, `wrong-db-endpoint/`, `pvc-pending/`

Our 4 main scenario fixtures use a made-up layout (one YAML per resource, `analyzers/output.json`, `logs/app/pod.log`) that no real Troubleshoot collector produces. Real bundles use flat JSON Lists (`pods/default.json` containing a `PodList`), `analysis.json` at root, and logs under `cluster-resources/pods/logs/<ns>/<pod>/<container>.log`. Only `realistic-bundle-format/` matches the real layout. Rewrite all 4 scenarios to match real Troubleshoot format.

### 2. Helm releases parsed but never used
**Files:** `src/parsers/helm-parser.ts`, `src/pipeline/analyze.ts`, `src/ai/chunk-indexer.ts`

`parseHelmReleaseFile()` exists but is never called in the pipeline. Files classified as `helm-release` are ignored. Helm chart version, release status (`failed`, `pending-install`), and values overrides are invisible to investigators and AI. Add `helmReleases` to `InvestigatorContext`, parse in pipeline, chunk with identifiers (chart name, overridden keys).

### 3. `config` artifact category is dead code
**Files:** `src/types/bundle.ts`, `src/ingestion/classifier.ts`

`ArtifactCategory` includes `'config'` but `classifyArtifact()` never returns it. No classifier rule maps to it. Remove or implement with rules for known config paths.

### 4. Timeline module built but never called
**Files:** `src/parsers/timeline.ts`, `src/pipeline/analyze.ts`

`sortEventsByTime()`, `buildTimeline()`, `getEventWindow()` exist with full test coverage but are never used in the pipeline. Could correlate log error timestamps with K8s events within +/-60 seconds for evidence chains like "DNS failure at 10:00:16Z → Unhealthy event at 10:05:30Z".

### 5. No Services/Endpoints investigator
**Files:** `src/investigators/kubernetes-investigator.ts`

No detector checks whether Services referenced by pod env vars have matching Endpoints with ready addresses. "Service `my-service` exists but has 0 ready endpoints" is a high-signal connectivity finding the hypothesis layer could absorb.

---

## Chunking

### 6. Log chunking is position-based, not error-aware
**Files:** `src/graph/chunker.ts` (`chunkLogFile`), `src/parsers/log-parser.ts` (`extractErrorWindows`)

Fixed 50-line sliding window regardless of content. Error clusters at chunk boundaries get split. `extractErrorWindows()` already exists — use it to center chunks on error clusters. Non-error regions can be chunked at coarser granularity or summarized to save token budget.

### 7. K8s resources chunked as raw JSON, not structured summaries
**Files:** `src/graph/chunker.ts` (`chunkResource`), `src/ai/summarizer.ts`

`chunkResource()` uses `JSON.stringify(resource, null, 2)` as content (50-200 lines). `summarizeResource()` produces 5-15 line structured summaries with all diagnostic signals. The summary is stored in `IndexedChunk.summary` but the LLM receives the raw JSON in `content`. Use summaries as content to 5-10x effective context window usage.

### 8. Chunk ID collisions for flat-layout bundles
**Files:** `src/ai/chunk-indexer.ts` (resource chunking loop)

For resources from List files, the chunk indexer fabricates paths like `cluster-resources/pod/default/app-pod.json` that don't exist in the bundle. LLM cites these fabricated paths, violating grounding rules. Use the actual manifest file path with a resource-name qualifier in the chunk ID.

### 9. No token budget awareness
**Files:** `src/investigators/ai-investigator.ts` (`mergeChunks`, `MAX_CHUNKS_PER_SEED`)

No token counting or context window awareness. 20 chunks of full-JSON resources could be 4000+ lines, exceeding model limits. Estimate tokens per chunk, track running total during merge, switch to summaries for lower-priority chunks when approaching budget.

### 10. Log deduplication off by default
**Files:** `src/parsers/log-parser.ts` (`parseLogFile`), `src/pipeline/analyze.ts`

`parseLogFile` accepts `dedup: boolean` but defaults to `false`. Pipeline never passes `true`. Repeated error lines (e.g. 47 identical DNS failures) bloat log chunks sent to the LLM. Enable dedup for chunks or at minimum for AI context.

---

## Retrieval

### 11. No BM25 — lexical search uses raw term frequency
**Files:** `src/ai/lexical-search.ts`

Content scoring is `token_count × 1.0` with no IDF, no length normalization, no saturation. At scale (~3500 chunks), common tokens like `default` drown relevant results. Replace content scoring with BM25: `IDF(t) × (tf × (k1+1)) / (tf + k1 × (1 - b + b × |d|/avgdl))`. Typical params: `k1=1.2, b=0.75`.

### 12. No RRF — merge uses positional priority instead of rank fusion
**Files:** `src/investigators/ai-investigator.ts` (`mergeChunks`)

Graph chunks always occupy first slots regardless of relevance. No cross-system score comparison. Replace with Reciprocal Rank Fusion: `RRF_score(chunk) = Σ 1/(k + rank_in_system)` with `k=60`. Chunks found by multiple systems rank higher than chunks found by only one.

### 13. Graph retrieval only helps Pod and Event seeds
**Files:** `src/graph/resource-graph.ts` (`getRelatedChunks`)

Analyzer and Log seeds skip graph neighborhood walks — they only exact-match their own chunk. Analyzer seed "Database Endpoint Unreachable" gets 1 chunk (itself). Fix: extract resource names from hypothesis text, or find unhealthy pods in the same namespace, and walk their neighborhoods.

### 14. Log chunk identifiers drop the pod name
**Files:** `src/ai/chunk-indexer.ts` (`identifiersFromLogContent`)

Path segment extraction filters out filenames ending in `.log`, so `app-pod.log` → identifier `app` (not `app-pod`). The actual pod name is lost. Fix: strip extension before filtering. Also extract parent directory name (pod name in real bundle paths).

### 15. Stop-word list too aggressive for resource kind terms
**Files:** `src/ai/lexical-search.ts` (`K8S_STOP_WORDS`)

`secret`, `service`, `configmap`, `missing`, `failed`, `unreachable` are all stopped. Hypothesis "missing secret app-credentials" only extracts `app-credentials`. Apply stop list only to RFC-1123 name extraction, not to compound term matching.

### 16. Vector store embeds summaries, not content
**Files:** `src/ai/chunk-indexer.ts`, `src/pipeline/analyze.ts` (embedding loop)

Embeddings are generated from `chunk.summary`. For log chunks, summary is just `"Log chunk from path (lines N-M)"` — zero diagnostic content. The semantic search can't match "DNS failure for db.internal" against a log chunk that contains `"no such host: db.internal"`. Embed content (or truncated content), or prepend primary error lines to log chunk summaries.

### 17. No graph chunk scoring by hop distance
**Files:** `src/graph/resource-graph.ts` (`getRelatedChunks`, `getNeighborhood`)

Graph results are unranked — depth-0 (the seed's own resource) and depth-2 (loosely related neighbor) have equal priority. Score by hop: depth-0 = 1.0, depth-1 = 0.8, depth-2 = 0.5. Feed scores into RRF ranking.

### 18. No Deployment→Pod label-selector edges in graph
**Files:** `src/graph/resource-graph.ts` (`buildResourceGraph`)

Graph relies on `ownerReferences` which go Pod→ReplicaSet→Deployment. If the ReplicaSet isn't in the bundle (some collectors omit it), Deployment and Pod are disconnected. Add label-selector edges: Deployment `spec.selector.matchLabels` → Pods with matching `metadata.labels`.

### 19. Same chunks sent to LLM for overlapping seeds
**Files:** `src/investigators/ai-investigator.ts` (`investigateWithAI`)

With small bundles, every seed gets all chunks. With 6 seeds and 7 chunks, that's 6 identical LLM calls with different hypothesis framing, producing near-duplicate findings. Deduplicate seeds with >80% chunk overlap into single multi-hypothesis calls.

### 20. No ConfigMap/Secret value content indexing
**Files:** `src/ai/chunk-indexer.ts` (`identifiersFromResource`)

Identifiers extract key names from ConfigMaps/Secrets but not values. A ConfigMap with `DB_HOST: "wrong-host.internal"` doesn't surface `wrong-host.internal` as an identifier. Log investigator finds DNS failure for that hostname but lexical index can't connect it to the ConfigMap. Extract hostnames, URLs, and connection strings from ConfigMap data values and pod env var values as identifiers.

### 21. No init container log association
**Files:** `src/investigators/log-investigator.ts` (`resolveLogPodComponent`)

Init container logs in real bundles are at `pods/logs/<ns>/<pod>/<init-container>.log`. `resolveLogPodComponent` matches only on filename (container name), not parent directory (pod name). Init container logs fail to resolve to their Pod component. Check parent directory name against known pod names.

---

## Retrieval Quality Testing

### 22. Never tested retrieval at realistic scale
**Files:** `test/` (no retrieval quality tests exist)

All fixtures have 7-12 chunks. Every seed gets 100% of chunks. Retrieval selectivity is never exercised. Create a multi-namespace fixture (~50 resources, ~20 events, ~10 log files, ~500 chunks) and write precision/recall tests: "For seed X, top-5 must include chunks A, B, C and must NOT include chunks from unrelated namespaces."
