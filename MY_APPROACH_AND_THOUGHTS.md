# My Approach and Thoughts

## Architecture

I built SBI as a **differential diagnosis engine** for Kubernetes support bundles. The core insight: a support bundle is already curated evidence. The right tool isn't "LLM over a tarball" — it's a system that generates competing root-cause hypotheses, gathers evidence for and against each, and honestly states uncertainty.

**Pipeline:** Ingest → Profile → Parse (analyzers, K8s resources, events, logs, Helm) → Build DiagnosticGraph → Seed investigation leads → Run six targeted investigators → Generate 3–5 competing hypotheses per symptom → Verify with contradiction checks → Rank with calibrated confidence → Report.

**Heuristic floor, AI ceiling:** Everything works offline. Five deterministic investigators (Kubernetes, Log, Config, Service, NetworkPolicy) plus graph-causal template matching provide the precision floor. AI (graph traversal + BM25 + semantic retrieval → LLM) adds cross-source correlation on top. No API key → full heuristic analysis. AI failure → graceful fallback.

## What Makes This Different

**Falsification, not summarization.** The hypothesis engine doesn't just confirm — it actively searches for contradicting evidence. When top hypotheses are close, the system says so and recommends what evidence would resolve the ambiguity.

**Evidence absorption.** When a graph-causal root cause (e.g., "Missing StorageClass 'fast-ssd'") confirms a hypothesis, the system absorbs the hypothesis's richer evidence set into the root cause finding. This produces high-confidence, well-evidenced diagnoses without duplicate findings.

**Spec-gap recommendations.** When confidence is limited by missing bundle data, the system recommends specific collectors or analyzers to improve future bundles — the most Replicated-native feature.

**Calibrated confidence.** Every finding carries both a numeric score and a quality label (`strong`/`moderate`/`weak`). Calibration is regression-tested with monotonicity assertions and scenario-ranking checks across nine fixture scenarios.

## Evaluation

Nine scenarios cover major Kubernetes failure modes: DNS misconfiguration, missing Secrets, bad image tags, PVC/StorageClass mismatches, cross-namespace DNS failures, NetworkPolicy blocks, node taints with memory pressure, failed Helm hooks, and multi-namespace clusters. Each has golden expectations with structural assertions for correctness, dedup invariants, and hallucination guards.

Nearly 3,900 tests across 99 files cover unit, integration, golden eval, retrieval benchmarks, robustness (corrupt/truncated/empty/partial/malformed bundles), sensitive-data leakage protection, and performance regression.

## Why I'm Proud of It

I'm proud of this project because I didn't just put an AI model on top of a support bundle. I built a graph from the Kubernetes resources, events, logs, and the relationships between them, then used graph traversal to follow the most useful paths from a symptom toward the evidence that could explain it. On top of that, I used AI techniques like BM25, Reciprocal Rank Fusion, semantic retrieval, HyDE, late chunking, GraphRAG, and grounded LLM analysis to make the diagnosis stronger without giving up the deterministic offline baseline. The part I'm most proud of is that the AI isn't treated like magic: it has to retrieve relevant context, compare competing hypotheses, and tie every conclusion back to evidence in the bundle.

## Interesting Observations

Real Troubleshoot bundles mix flat namespace JSON (`pods/default.json` containing a PodList) with nested paths. Aligning with both required careful classifier work. The hypothesis layer also exposed a subtle bug where numeric `DB_PORT=5432` was treated as a hostname — exactly the false evidence that erodes trust.

## What I'd Build Next

A real-bundle regression corpus from kind clusters with genuine production-like failures. Broader model-quality evaluation across cloud and local LLMs. Expanded causal templates for Ingress, RBAC, and certificate-expiry chains.
