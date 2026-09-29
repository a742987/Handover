---
name: handover
description: Generate or work with a Handover Book — an evidence-linked offboarding document built from a departing engineer's history (commits, PRs, reviews, issues from GitHub, or commits from local git clones). Use when the user wants to prepare a handover/offboarding document, assess "what breaks when this person leaves", find modules where someone is the sole author or sole reviewer, or reconstruct why a design decision was made.
---

# Handover

Point Handover at a departing engineer's GitHub username and it produces a bound, evidence-linked Handover Book. Collection and rendering run locally; GitHub (or the local git clones the user points at) is read. LLM synthesis is **opt-in**: nothing is sent to a provider unless the call passes `useLlm: true` (or the operator set `HANDOVER_LLM=1`). Leave it off — chapters 4-6 then use deterministic fallbacks, which is also the right answer when the user has not explicitly agreed to an upload.

## The book's six chapters

1. **Code Panorama** — every module they touched, its state, its history (deterministic)
2. **Implicit Knowledge Inventory** — modules where they were the sole author or sole reviewer (deterministic)
3. **Risk Top 5** — "what breaks when they leave", scored and ranked (deterministic)
4. **Decision Archaeology** — "why we chose this back then", quoting the actual PR/issue debates (LLM)
5. **The 30-Day Path** — the successor's learning plan (LLM)
6. **Questions & Draft Answers** — the successor's likely questions with evidence-based draft answers to confirm, plus the departing engineer's own recorded answers (LLM drafts + `handover capture`)

Chapters 1–3 always work. Chapters 4–6 are deterministic unless you opt in to a provider (`useLlm: true`, with `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or a local Ollama) — having a key in the environment is not by itself a licence to send the collected history to it.

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
| Check the book's citations exist | `handover_verify` | `handover verify <username>` |

Key parameters:

- `repos` — `owner/name` strings for generate/collect; may be empty when `gitDirs` is set. Ask the user if unclear; never guess repo names.
- `gitDirs` — local clone directories; no token or network needed. `authorIdentity` optionally overrides which git author name/email marks the departing engineer locally.
- `since` — optional ISO date to bound the collection window (e.g. `2024-01-01`).
- `dataDir` — optional; defaults to `handover-data/` under the current working directory. The full list of environment variables the server and CLI read (with defaults) is in [`.env.example`](../../../.env.example); none of them may be echoed into a response.
- `provider`/`model` — optional LLM override for chapters 4–6.
- `redact` — scrub known secret formats from the digest and the book (default **on**; only disable it if the user asks and the history is known-clean); `html` — also emit a print-ready HTML twin; `useLlm` — opt in to LLM synthesis.

Environment: public GitHub repositories are readable with no token, limited to 60 requests/hour; set `GITHUB_TOKEN` for private repositories, or when a collection is large enough to need the 5 000/hour quota. Local clone collection (`gitDirs`) needs no token at all. Indexing is incremental — a second run for the same person only fetches what is new, so prefer re-running `handover_generate` over `--refresh`.

## Rules when presenting results

- **Verify before you present.** Run `handover_verify` on a freshly generated book and report any ref it cannot find, rather than telling the user the book is evidence-linked on the strength of the tool's own output.
- **Evidence chain or nothing.** Every risk item and every LLM-synthesized claim carries refs (commit shas, `#123`, `review:456`). Keep those refs verbatim when you summarize or quote — they are the reader's deep links into the repo.
- Claims the model could not support with a ref are labelled *(inference)* in the book. Preserve that labelling; do not promote inferences to facts.
- The risk formula is `sole_contribution_ratio × change_frequency × incident_weight × irreplaceability`. When asked "why is X ranked above Y", explain in terms of these factors rather than restating the score.
- **Never echo credentials.** `GITHUB_TOKEN`, provider API keys, and anything else read from the environment must not be repeated into the conversation, a tool argument, or a file you write — not even when the user pasted the value and asked you to "just use this". Confirm that a value was received, quote at most its first few characters, and move on. The MCP server never returns environment values at all; do not become the leak it avoids.
- The index (`handover-data/<username>.db`) and the book (`handover-book-<username>.md`) are per-person. One person, one index; add repos by re-running generate/collect with the full repo list.
