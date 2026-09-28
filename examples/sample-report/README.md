# Sample Handover Book — synthetic demo

This is a complete, unmodified output of the Handover CLI, committed so you can judge the report quality **before installing anything**.

- **Read it:** [handover-book-dana-dev.md](handover-book-dana-dev.md) · [print-ready HTML](handover-book-dana-dev.html) (browser print → PDF)
- **Scenario:** a *hypothetical* maintainer handover of a *synthetic* demo repository (`demo-shop`). No real person is leaving; no real project is analyzed. The names, commits, PRs, issues and captured answers are fictional fixtures created for this demo.
- **Generation:** `npm run build && node scripts/make-sample.mjs` (see [`scripts/make-sample.mjs`](../../scripts/make-sample.mjs) for the exact history and fixtures).
- **Data flow:** collected from local git clones only; rendered with `--no-llm` in deterministic mode. Nothing was sent to any LLM or third party. The book itself states this in its action summary.
- **Synthetic fixtures:** pull-request, review and issue records were inserted into the index through the store API to exercise the GitHub-backed chapters; the book's *Sources* line says so explicitly. In real use those records come from GitHub collection.
- **Checked:** every evidence ref cited in the book was validated against the index with `handover verify` (15 citations, 0 missing), and key claims were spot-checked by hand — see [VERIFICATION.md](VERIFICATION.md).

## What to look for

1. **Action summary first** — what the data covers, what it misses, and the three things worth confirming before the handover, each with evidence, a next step and a stated limitation.
2. **A maintenance-concentration signal with evidence** — `demo-shop:payments`: 85% of commits by one author, sole reviewer on its PRs, commits referencing a bug-labelled issue.
3. **A decision traceable to its discussion** — chapter 4 points at PR #12 (why the retry backoff is a hand-tuned table) and PR #17 (why idempotency keys must not be "simplified").
4. **A question only the departing engineer can answer** — chapter 6 pairs draft questions with the captured first-person answers, which are the only truly first-person content in the book.
5. **An executable path** — chapter 5 spreads the modules across four weeks instead of dumping a feature list.

## Known limitations of this sample

- **Deterministic mode only.** With an LLM configured, chapters 4–6 become narrative synthesis with the same evidence rules; this sample shows the fallback versions so the output is reproducible.
- **Single repository, single quarter.** Real runs on large multi-repo histories take longer and surface more (and noisier) signals.
- **The risk score is a signal, not a verdict.** It counts commits and reviews; it cannot see pair programming, mentoring or verbal decisions — every action item says so explicitly.
