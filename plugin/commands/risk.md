---
description: Print the Risk Top 5 from an existing Handover index
argument-hint: <username>
allowed-tools: Bash(handover:*)
---

!`handover risk $ARGUMENTS`

The command output above is the Risk Top 5 computed from the local SQLite index (no network). Present it as a table (rank, module, score, one-line rationale) and preserve the evidence refs — each one is a deep link into the repo.

If it failed with "No index found", the user must run `/handover:gen <username> --repo owner/name` (or `handover collect`) first — the index lives at `handover-data/<username>.db`.
