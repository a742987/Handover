---
description: Generate the full Handover Book for a departing engineer (collect → risk → render)
argument-hint: <username> --repo owner/name [--since 2024-01-01]
allowed-tools: Bash(handover:*)
---

!`handover gen $ARGUMENTS`

The command output above contains the run's progress messages, the Risk Top 5, and the paths to the generated book and SQLite index. Summarize it for the user:

1. Report the Risk Top 5 as a table (rank, module, score, one-line rationale) — keep each rationale's evidence refs (commit shas, #PR, #issue) intact, they are deep links into the repo.
2. Give the book path (`handover-data/handover-book-<username>.md`) and offer to walk through a chapter.
3. If the command failed, diagnose before retrying: a missing `GITHUB_TOKEN` (export it in the environment), a wrong `owner/name`, or an invalid `--since` date are the usual causes. Never regenerate silently — tell the user what failed.
