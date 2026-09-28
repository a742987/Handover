# Handover Book

Generate or work with a Handover Book for: $ARGUMENTS

Handover turns a departing engineer's GitHub history into a bound, evidence-linked offboarding document. Collection and rendering run locally; when an LLM provider is configured, collected content is sent to it for synthesis.

If an MCP server named `handover` is available in this session, use its tools:

- `handover_generate` — full pipeline (collect → risk → render the book)
- `handover_collect` — index history only, without rendering
- `handover_risk` — Risk Top 5 from an existing index
- `handover_capture` — append the departing engineer's own Q&A answers (chapter 6)
- `handover_search` — substring search over the local evidence index (no network)
- `handover_render` — re-render the book from an existing index (no GitHub network; LLM chapters use the configured provider if an API key is available)

Otherwise use the `handover` CLI (install with `npm install -g handover-book` if missing):

```bash
handover gen <username> -r owner/name [--since 2024-01-01]   # full pipeline
handover gen <username> -d ~/work/api                        # local clones only — no token, no network
handover collect <username> -r owner/name                    # index only, no book
handover capture <username>                                  # record first-person answers into chapter 6
handover risk <username>                                     # Risk Top 5 from index
handover bus-factor <username>                               # team view: sole-owned modules (+CODEOWNERS)
handover gate <username> --files changed.txt                 # CI check: touched sole-owned modules?
handover render <username>                                   # re-render, no GitHub network
```

Input defaults: arguments are `<username> --repo owner/name`; ask the user for anything missing (never guess repo names). `GITHUB_TOKEN` must be set in the environment for anything that touches GitHub. Indexing is incremental — re-running `gen` for the same person only fetches new activity.

Output: `handover-data/<username>.db` (SQLite index) and `handover-data/handover-book-<username>.md` (the book, six chapters).

When presenting results:

1. Report the Risk Top 5 as a table (rank, module, score, one-line rationale). Risk is scored as `sole_contribution_ratio × change_frequency × incident_weight × irreplaceability` — explain rankings in terms of these factors.
2. Keep every evidence ref (commit shas, `#123`, `review:456`) verbatim; they are deep links into the repo. The book's rule is evidence chain or nothing: unref'd claims are labelled *(inference)* — preserve that labelling, never promote inferences to facts.
3. If a command fails, diagnose before retrying (missing `GITHUB_TOKEN`, wrong `owner/name`, invalid `--since`) and tell the user what failed instead of silently regenerating.
