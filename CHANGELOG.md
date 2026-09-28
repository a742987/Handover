# Changelog

Notable changes to the `handover-book` npm package and the CLI. Dates are UTC.

## 0.1.2 — 2026-09-28

Documentation-only release; no code changes since 0.1.1.

- Added `CHANGELOG.md` and a clean-environment installation verification record (`docs/install-verification.md`): published-package install → `gen` (local Git, `--no-llm`) → `verify`, all passing on Windows/Node 24.
- README roadmap updated to reflect the verified end-to-end run; the GitHub-token collection path and Unix environments remain open items.

## 0.1.1 — 2026-09-28

Published to npm as [`handover-book@0.1.1`](https://www.npmjs.com/package/handover-book/v/0.1.1).

**Install:** `npm install -g handover-book@0.1.1` — puts both `handover` and `handover-mcp` on PATH. Requires Node >= 22.13.0.

**Added since 0.1.0**

- Action-summary first page: what the data covers, what it is missing, and the top items to confirm before the handover — each with evidence refs, a next step and a stated limitation.
- `handover verify` — checks that every evidence ref cited in a rendered book exists in the local index (exit 1 on missing refs).
- Explicit `--no-llm` / `HANDOVER_NO_LLM=1` off-switch: skip LLM synthesis even when an API key is configured; nothing leaves the machine.
- Committed sample book for a labelled synthetic scenario with a hand-verification record (`examples/sample-report/`) and a report screenshot, so the output can be judged before installing.
- Community entry points: `CONTRIBUTING.md`, `ROADMAP.md`, and issue templates (bug, install problem, false positive, feature request, sample-consent).

**Fixed since 0.1.0**

- XSS in rendered HTML output, secret-redaction bypasses, mixed-source data loss, and index integrity issues.
- Flaky Windows CI from fixture commits with implicit timestamps.

**Known limitations**

- Verified end-to-end in a clean environment on the local-Git deterministic path (Windows, Node 24); the GitHub-token collection path and Unix environments are pending — see [docs/install-verification.md](docs/install-verification.md).
- Without an LLM, chapters 4–6 are deterministic fallbacks; risk scores count commits and reviews and are signals to verify, not verdicts about knowledge or performance.
- `--redact` scrubs known secret formats on a best-effort basis and is not a guarantee.

## 0.1.0 — 2026-09-27

First tagged release (`v0.1.0`). CLI with GitHub collection (Octokit), local index (`node:sqlite`), risk engine, six-chapter Markdown book, `capture` first-person Q&A, `bus-factor` team view, `gate` CI command, print-ready HTML twin, and an MCP server (`handover-mcp`).

## 0.0.1 — 2026-09-27

Initial scaffold: CLI, GitHub collection, SQLite index, risk engine, Markdown book.
