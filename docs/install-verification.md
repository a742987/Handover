# Installation verification — clean environment, published package

Verification record for the guide's first acceptance gate: **a first-time user can generate a valid report from the published npm package, without any local checkout.** Run date: 2026-09-28.

## Environment

| Item | Value |
|---|---|
| Package | `handover-book@0.1.1` from the public npm registry (`npm install`, not a link or tarball) |
| OS | Windows 10.0.26200 (Git Bash) |
| Node / npm | v24.12.0 / 11.6.2 (package `engines` floor: >=22.13.0) |
| Directory | Empty temp directory with a fresh `npm init -y`; no clone of this repo, no reused `node_modules` |
| Analyzed input | The Handover repository itself, via `--git-dir` (local Git only, no token) |

## Steps and results

```bash
mkdir handover-verify && cd handover-verify && npm init -y
npm install handover-book@latest            # 117 packages, no errors
npx handover --version                      # 0.1.1

npx handover gen <author> \
  --git-dir <path-to-repo> --author <email> \
  --no-llm --redact --html --data-dir ./demo-data
# → 14 commits indexed, book + HTML twin + SQLite index written

npx handover verify <author> --data-dir ./demo-data
# → Checked 8 citation(s) against 1 repo(s) in scope.
#   All cited evidence refs exist in the index. (exit 0)
```

Observed behaviour worth noting:

- The generated book opens with the action summary: data coverage, known gaps (no PRs/reviews/issues from local-git collection), and confirm-items each carrying evidence refs, a next step and a stated limitation.
- With no API key configured, synthesis reported `deterministic (no LLM key configured)`; `--no-llm` additionally pins that even configured keys are skipped.
- `npm pack` contents match `package.json` `files`: `dist/`, `codex/`, README, LICENSE (npm auto-includes the other `README.*` translations).

## What this record does **not** claim

- **GitHub-token collection path not exercised.** The run used local Git only (`--git-dir`). The `-r owner/name` Octokit path still needs a tokened clean-environment run.
- **One OS only.** The guide asks for Windows plus at least one Unix; Unix is pending.
- **Small repo, deterministic mode.** Large/multi-repo runtime was not measured; chapters 4–6 were the deterministic fallbacks, so LLM-path quality is untested here.
- **Report correctness ≠ citation existence.** `verify` proves cited refs exist in the index; semantic spot-checks against the source history remain a manual step (see `examples/sample-report/VERIFICATION.md` for that method).
