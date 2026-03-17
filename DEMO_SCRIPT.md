# Demo Script (~2 minutes)

> Use this as a recording guide. Screen-record your terminal + a browser/preview for the HTML report.

## Setup (before recording)

```bash
npm install && npm run build
cd test/fixtures/scenarios
tar czf /tmp/wrong-db-endpoint.tar.gz wrong-db-endpoint/
tar czf /tmp/missing-secret-crashloop.tar.gz missing-secret-crashloop/
cd ../../..
```

---

## Scene 1: Heuristic Mode (~30s)

> "SBI takes a Troubleshoot support bundle and produces an evidence-backed diagnosis. Let's start with heuristic-only mode — no API key, fully offline."

```bash
npx sbi analyze /tmp/wrong-db-endpoint.tar.gz --no-ai --format markdown --verbose
```

**Point out:**
- Pipeline logs: extracted files, parsed artifacts, seeds generated
- Top finding: `[Hypothesis] DNS resolution is failing…` with confidence 81%
- Evidence table: exact log lines citing `lookup db.internal: no such host`
- Runner-up comparison: "Preferred over runner-up connectivity-failure because…"
- Contradiction check: system looked for contradicting evidence and found none
- Spec recommendation: suggests adding CoreDNS log collector

---

## Scene 2: AI Mode (~30s)

> "Now let's add AI. Same bundle, but with an OpenAI key."

```bash
export OPENAI_API_KEY=sk-...
npx sbi analyze /tmp/wrong-db-endpoint.tar.gz --format markdown --verbose
```

**Point out:**
- Semantic index built: N embedded chunks
- Per-seed retrieval stats: graph + lexical + semantic chunks
- AI finding: "Database Connectivity Failure [AI-assisted]" with cross-source evidence
- Evidence from 3 artifact types: logs + analyzer + pod status
- Executive summary now mentions AI contributed N findings with cross-source correlation

---

## Scene 3: Different Scenario (~20s)

> "Let's try a completely different failure — a missing Kubernetes Secret causing a CrashLoopBackOff."

```bash
npx sbi analyze /tmp/missing-secret-crashloop.tar.gz --no-ai --format markdown
```

**Point out:**
- Top finding: missing-secret hypothesis at 100% confidence
- Evidence chain: FailedMount event → missing `app-credentials` secret → CrashLoopBackOff
- Differential diagnosis: system also considered config-error, dns-failure, oom-kill — all ranked lower

---

## Scene 4: Report Output (~20s)

> "SBI writes all three report formats in one pass."

```bash
npx sbi analyze /tmp/wrong-db-endpoint.tar.gz --output-dir /tmp/sbi-demo --trace
open /tmp/sbi-demo/report.html
```

**Point out:**
- HTML report with colour-coded severity badges
- Collapsible evidence and contradiction sections
- Spec recommendations section at the bottom
- `findings.json` for programmatic consumption
- `trace.json` for debugging the investigation pipeline

---

## Scene 5: Benchmark (~10s)

> "Finally, a quick benchmark across all three scenarios."

```bash
npm run benchmark:hypotheses
```

**Point out:**
- All three scenarios: correct top-1 diagnosis
- Sub-100ms heuristic runtime per bundle
- DNS failure, missing secret, image pull failure — all correctly ranked

---

## Closing (~10s)

> "The key design choice: this is not summarization — it's differential diagnosis. The system generates competing hypotheses, collects evidence for and against each, and honestly says when it doesn't have enough data to be certain. That's how a strong support engineer works."
