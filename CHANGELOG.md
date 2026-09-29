# Changelog

Notable changes to the `handover-book` npm package and the CLI. Dates are UTC.

## Unreleased

Security and correctness fixes from a full project audit. Highlights: `--no-llm` now actually works (it previously did not, and repo content could be sent to the LLM provider despite the flag), the HTML report sanitizer is rewritten around a URL-scheme allowlist (closing several XSS routes reachable from malicious repo content), and mixed-case `-r Acme/API` no longer wipes an index collected as `acme/api`.

**Security**

- `--no-llm` is honored: the CLI flag was read from `options.noLlm`, which commander never sets for a `--no-*` flag, so a configured API key sent repository content to the LLM provider despite the flag. Only `HANDOVER_NO_LLM=1` worked. Both `gen` and `render` now map the flag correctly.
- HTML report sanitizer rewritten: URL schemes are now checked against an allowlist (http/https/mailto/relative) after decoding HTML5 named and numeric entities (previously `javascript&colon;`, entity-encoded tabs inside the scheme word, and SVG `<animate attributeName="href">` could smuggle scripts past the denylist; a numeric entity above U+10FFFF crashed the whole render). Out-of-range entities are clamped, `<animate>`/`<set>`/`<foreignObject>` are dropped, and `action`/`formaction` join the checked URL attributes.
- A malformed `<script >` open tag in chapter content no longer swallows the rest of the book (dangerous block-level tags are neutralized in the markdown before parsing, so they render as visible text instead of deleting content).
- Module names interpolated into risk headings and the 30-day path are rendered as inert code spans; a repo directory name containing backticks/markup can no longer inject into the rendered book. Chapter headings keep `&` readable instead of leaking `&amp;` into the markdown source.
- MCP `handover_search` results are secret-scrubbed like the risk tool — excerpts quote raw repository text and are an egress path the redact flag does not cover.

**Data loss / correctness**

- Mixed-case repository names (`-r Acme/API` after `acme/api`) no longer wipe the previously collected history: collection scope is normalized to lowercased slugs before the orphan cleanup, and the recorded repo list matches exactly what survives it.
- A later `-r`-only `collect`/`gen` run no longer wipes locally-collected (`--git-dir`) history: every local clone recorded in the index is preserved, not just the ones passed to the current run (CLI, pipeline and MCP behave identically now).
- Local git collection stores author timestamps normalized to UTC, like the GitHub path — non-UTC repos previously mis-sorted recency evidence and mis-bounded commit windows (all timestamp comparisons are lexicographic). Existing indexes keep their stored form; re-collect with `--refresh` to normalize.
- Amended/rebased-away local commits are pruned on a full re-index, matching the GitHub path's ghost-data contract.
- PR ghost-data prune actually deletes the conversation comments and labels of pruned PRs (the DELETE statements bound `repo` into a number placeholder, so they never matched anything).
- Prune statements no longer fail with "too many SQL variables" on full listings above SQLite's 32,766 bind-variable cap (large repos crashed mid-collect); seen-values are staged in a temp table.
- `handover verify` checks bare `[review:456]` citations — the exact format the LLM system prompt instructs the model to emit — which previously passed unchecked while the command claimed "all cited refs exist".
- Evidence appendix keeps refs that share a number across repositories (`acme/api#12` and `acme/web#12` are no longer deduplicated into one row).
- PR additions/deletions/changed_files are summed from the fetched file pages instead of being persisted as zeros (`pulls.list` does not carry those fields).
- CI bot logins (`dependabot[bot]`, `renovate[bot]`, …) no longer count as authors in ownership ratios, bus-factor headcount, or contributor counts.
- `--since` rejects impossible dates that `Date.parse` silently rolls over (`2024-02-30`, `T24:00`); search with a `since` filter excludes undated records instead of letting them through; legacy PR rows with a NULL `head_sha` are re-fetched once instead of skipping force-push detection forever.
- Local git collection no longer overwrites GitHub's canonical login in `collected_for`, records its `collected_via` source (so the book's Sources line no longer relies on name-shape guessing — same for the CLI `collect` command), and handles repositories whose full `git log` output exceeds any fixed buffer (streamed instead of `execFile`'s 64 MB cap).

**Usability / packaging**

- GitHub Enterprise Server support: set `GITHUB_API_URL` to the instance's API base.
- CODEOWNERS fetch failures from rate limiting (403/429) warn instead of silently vanishing from the bus-factor view.
- `gate --files -` fails with a hint instead of hanging when stdin is a TTY; `capture --answers` reports a missing file with a hint instead of a bare ENOENT; `bus-factor` "quiet" label reflects the requested `--window` instead of a hardcoded "90d"; SQLite sets a busy timeout so concurrent CLI/MCP access waits instead of failing; the risk engine no longer overflows the argument limit on huge module counts.
- npm package ships the README's hero screenshot and the sample report again (broken image/links on npmjs.com).
- Plugin metadata bumped to 0.1.2; SKILL.md chapter 6 renamed to the real "Questions & Draft Answers" with the draft-vs-captured distinction (it claimed the LLM answers spoke in the departing engineer's own voice); all eight community README translations re-synced with the English README (MCP tool count, command table, `--git-dir` no-token path, flags, roadmap, chapter 6 name); `.env.example` gained `HANDOVER_NO_LLM` and `GITHUB_API_URL` and an accurate redact description.

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
