# My Approach and Thoughts

## Architecture Decision

I built SBI as a **hybrid investigation engine** — deterministic heuristics provide the precision floor, AI retrieval adds cross-source correlation on top. The system works fully offline by default; AI is additive, never required.

The core insight is that a support bundle is already a curated evidence package. The right product is not "LLM over a tarball." It is a **differential diagnosis engine** that generates competing root-cause hypotheses, gathers evidence for and against each, ranks them with calibrated confidence, and honestly states when evidence is insufficient.

## How It Works

The pipeline runs in layers:

1. **Ingestion** — extract, classify, and profile every artifact in the bundle
2. **Structured parsing** — analyzers, K8s resources, events, and logs are parsed into typed domain objects
3. **Seed generation** — analyzer errors, pod health signals, log importance scores, and warning events become investigation seeds
4. **Targeted investigators** — Kubernetes, Log, and Configuration investigators produce evidence-backed findings with contradiction checks
5. **Hypothesis verification** — for each symptom, 3–5 competing root-cause hypotheses are generated. Supporting, contradicting, and missing decisive evidence is collected for each. A calibrated scorer ranks them with category-specific decisive bonuses, cross-source rewards, and contradiction/missing-evidence penalties
6. **AI expansion** (optional) — graph traversal, lexical search, and semantic embeddings retrieve grounded context. An LLM produces structured findings with mandatory citations. Findings without citable evidence are dropped
7. **Reporting** — Markdown, HTML, and JSON reports include ranked findings, evidence tables, contradiction checks, missing-evidence notes, and spec-gap recommendations

## What Makes This Different

Phase 7 pushed the architecture further toward explicit contracts and data-driven diagnostics. The biggest shift was moving the hypothesis layer toward a declarative template registry with co-located evidence rules, so new failure modes increasingly become template/data work instead of more procedural branches. In parallel, I tightened the confidence model by adding monotonicity and scenario-ranking regression tests — calibration should be enforced continuously, not treated as a one-off benchmark exercise. I also consolidated the final finding merge into a documented 2-pass dedup architecture (structural merge first, cosmetic title dedup second, suppression last) because overlapping cleanup layers are where diagnostic systems quietly lose evidence and trust.

**Falsification, not summarization.** The hypothesis layer doesn't just find evidence that supports a conclusion — it actively searches for evidence that weakens it. When the top two hypotheses are close in confidence, the system says so and recommends what evidence would resolve the ambiguity.

**Spec-gap recommendations.** When confidence is limited by missing bundle data, the system recommends specific collectors or analyzers to add. This is the most Replicated-native feature: it improves future bundles, not just the current triage.

**Graceful degradation.** No API key → heuristic mode. Embedding failure → graph + lexical retrieval only. LLM failure for one seed → other seeds proceed. The system never aborts due to AI failures.

## Interesting Observations

Real Troubleshoot bundles use flat namespace JSON (`pods/default.json` containing a `PodList`) alongside nested paths. Aligning with both formats required careful classifier work. The hypothesis layer also exposed a subtle bug where numeric environment values like `DB_PORT=5432` were being treated as service hostnames — exactly the kind of false evidence that erodes trust.

## What I'd Do With More Time

Add a real-bundle regression corpus from kind/minikube clusters with genuine failures. Expand to storage-class and network-policy scenarios. Add Helm release metadata parsing for configuration drift detection. Build a nightly CI eval pipeline that records LLM responses and replays them in PR checks for cost-controlled regression testing.
