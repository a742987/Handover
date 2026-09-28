---
name: handover
description: Generate or work with a Handover Book — an evidence-linked offboarding document built from a departing engineer's GitHub history (commits, PRs, reviews, issues). Use when the user wants to prepare a handover/offboarding document, assess "what breaks when this person leaves", find modules where someone is the sole author or sole reviewer, or reconstruct why a design decision was made.
---

# Handover

Point Handover at a departing engineer's GitHub username and it produces a bound, evidence-linked Handover Book. Collection and rendering run locally; only GitHub is read, and when an LLM provider is configured, collected content is sent to it for synthesis.

## The book's six chapters

1. **Code Panorama** — every module they touched, its state, its history (deterministic)
2. **Implicit Knowledge Inventory** — modules where they were the sole author or sole reviewer (deterministic)
3. **Risk Top 5** — "what breaks when they leave", scored and ranked (deterministic)
4. **Decision Archaeology** — "why we chose this back then", quoting the actual PR/issue debates (LLM)
5. **The 30-Day Path** — the successor's learning plan (LLM)
6. **Letter to the Future** — the successor's likely questions, answered in the departing dev's voice (LLM)

Chapters 1–3 always work. Chapters 4–6 need an LLM (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or a local Ollama); without a key they fall back to deterministic summaries.

## How to run it

Prefer the `handover` MCP tools (registered by the plugin); they keep progress output out of the transcript and return structured JSON. Fall back to the `handover` CLI when the MCP server is not connected.

| Task | MCP tool | CLI |
|---|---|---|
| Full pipeline | `handover_generate` | `handover gen <username> -r owner/name` (or `-d <clone dir>` — local git, no token) |
| Index only, no book | `handover_collect` | `handover collect <username> -r owner/name` |
| Risk Top 5 from index | `handover_risk` | `handover risk <username>` |
| Capture the person's own answers (chapter 6) | `handover_capture` | `handover capture <username>` |
| Search the evidence (no network) | `handover_search` | — |
| Re-render book from index | `handover_render` | `handover render <username>` |

Key parameters:

- `repos` — `owner/name` strings for generate/collect; may be empty when `gitDirs` is set. Ask the user if unclear; never guess repo names.
- `gitDirs` — local clone directories; no token or network needed. `authorIdentity` optionally overrides which git author name/email marks the departing engineer locally.
- `since` — optional ISO date to bound the collection window (e.g. `2024-01-01`).
- `dataDir` — optional; defaults to `handover-data/` under the current working directory.
- `provider`/`model` — optional LLM override for chapters 4–6.
- `redact` — scrub known secret formats from the LLM digest and the book; `html` — also emit a print-ready HTML twin.

Environment: `GITHUB_TOKEN` must be set for anything that touches the network. Indexing is incremental — a second run for the same person only fetches what is new, so prefer re-running `handover_generate` over `--refresh`.

## Rules when presenting results

- **Evidence chain or nothing.** Every risk item and every LLM-synthesized claim carries refs (commit shas, `#123`, `review:456`). Keep those refs verbatim when you summarize or quote — they are the reader's deep links into the repo.
- Claims the model could not support with a ref are labelled *(inference)* in the book. Preserve that labelling; do not promote inferences to facts.
- The risk formula is `sole_contribution_ratio × change_frequency × incident_weight × irreplaceability`. When asked "why is X ranked above Y", explain in terms of these factors rather than restating the score.
- The index (`handover-data/<username>.db`) and the book (`handover-data/handover-book-<username>.md`) are per-person. One person, one index; add repos by re-running generate/collect with the full repo list.
