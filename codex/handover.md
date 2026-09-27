# Handover Book

Generate or work with a Handover Book for: $ARGUMENTS

Handover turns a departing engineer's GitHub history into a bound, evidence-linked offboarding document. Everything runs locally; only GitHub is read.

If an MCP server named `handover` is available in this session, use its tools:

- `handover_generate` — full pipeline (collect → risk → render the book)
- `handover_collect` — index GitHub history only, without rendering
- `handover_risk` — Risk Top 5 from an existing index
- `handover_render` — re-render the book from an existing index (no network)

Otherwise use the `handover` CLI (install with `npm install -g handover-book` if missing):

```bash
handover gen <username> -r owner/name [--since 2024-01-01]   # full pipeline
handover risk <username>                                     # Risk Top 5 from index
handover render <username>                                   # re-render, no network
```

Input defaults: arguments are `<username> --repo owner/name`; ask the user for anything missing (never guess repo names). `GITHUB_TOKEN` must be set in the environment for anything that touches GitHub. Indexing is incremental — re-running `gen` for the same person only fetches new activity.

Output: `handover-data/<username>.db` (SQLite index) and `handover-data/handover-book-<username>.md` (the book, six chapters).

When presenting results:

1. Report the Risk Top 5 as a table (rank, module, score, one-line rationale). Risk is scored as `sole_contribution_ratio × change_frequency × incident_weight × irreplaceability` — explain rankings in terms of these factors.
2. Keep every evidence ref (commit shas, `#123`, `review:456`) verbatim; they are deep links into the repo. The book's rule is evidence chain or nothing: unref'd claims are labelled *(inference)* — preserve that labelling, never promote inferences to facts.
3. If a command fails, diagnose before retrying (missing `GITHUB_TOKEN`, wrong `owner/name`, invalid `--since`) and tell the user what failed instead of silently regenerating.
