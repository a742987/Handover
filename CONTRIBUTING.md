# Contributing to Handover

Thanks for helping make engineering handovers less lossy. This document gets you from clone to merged PR with the least friction.

## Local setup

Requirements: **Node ≥ 22.13** (the built-in `node:sqlite` needs 22.13+; no native compilation).

```bash
git clone https://github.com/a742987/Handover && cd Handover
npm install
npm run build       # dist/
npm test            # vitest
npm run typecheck   # tsc --noEmit (main + test configs)
npm run dev -- gen <username> --git-dir <any/local/clone>   # run the CLI from source, no token needed
```

To exercise the full pipeline without touching a real project, generate the committed sample:

```bash
npm run sample      # rebuilds examples/sample-report/ from a synthetic repo
```

## Pull requests

1. **Open or claim an issue first** for anything beyond a typo fix — say what you propose in one paragraph so we can agree on scope before you write code.
2. One topic per PR. Include tests for behavior changes; `npm run typecheck && npm test` must pass (CI runs both, plus the build, on Node 22 and 24, Windows and Ubuntu).
3. Keep the evidence rules intact: rendered claims cite their refs, unsupported claims are labelled *(inference)*, and first-person content comes only from `handover capture`. If your change touches report rendering or LLM prompts, regenerate the sample (`npm run sample`) and mention it in the PR description.
4. Match the existing code style — no semicolons, double quotes, descriptive errors with actionable hints (see `src/cli.ts` for the tone).

## Good first issues

Issues labelled `good first issue` have context, a completion condition, and a contact person in the description. Examples of the kind we keep open:

- improving an error message to cover a failure mode you actually hit,
- adding a test for an untested collector branch,
- docs: keeping a translated README consistent with the English one (install steps and the data-flow table).

## Reporting problems

Use the issue templates: bug report, install problem, false positive / missing finding, feature request. For "the book claimed X but the repo says Y" reports, include the evidence ref from the appendix so the citation can be checked directly. Sensitive material does not belong in issues — redact repos, tokens and names first.

## Code of conduct

Be specific and kind. We discuss tool behavior, not people. Reports about maintenance concentration describe Git signals, never judgments of the engineers involved — keep that framing in code, docs and discussions alike.
