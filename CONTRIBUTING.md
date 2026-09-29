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

To check the thing the unit tests cannot see — the **published artifact** rather than the source tree — run the smoke suite. It packs the tarball, installs it into a throwaway directory the way a first-time user would, then drives every CLI command and the MCP server against a synthetic repository and asserts on exit statuses, output wording, files written, and that no command leaks a terminal control byte:

```bash
npm run build && npm run smoke
```

CI runs it as the `artifact-smoke` job on Ubuntu and Windows. Seven defects were found by doing this by hand (see `docs/install-verification.md`), none of them by reading the code.

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

## Releasing

Releases are **tag-driven and published by CI** (`.github/workflows/release.yml`), not by
typing `npm publish` at a desk. That is a deliberate correction: `0.1.1` was hand-published
with a `gitHead` pointing at the commit tagged `v0.1.0`, and the local `v0.1.1` tag sits on a
third commit — so the version npm served could not be reproduced from any tag.

```bash
# 1. land the changes on main, then tag the commit that carries the release
npm version 0.1.3 --no-git-tag-version   # or edit package.json by hand
# bump plugin/.claude-plugin/plugin.json to the same version
# move the "Unreleased" CHANGELOG block under a dated "## 0.1.3 — YYYY-MM-DD" heading
git commit -am "Release 0.1.3"
git tag -a v0.1.3 -m "Release 0.1.3: <one-line summary>"
git push origin main && git push origin v0.1.3
```

The workflow then checks that the tag matches `package.json`, that the tagged commit is on
`main`, runs typecheck/tests/build, verifies the tarball contains every `bin`/`main`/`exports`
entry and none of `src/`, `test/`, `.env`, `*.db`, and publishes with **provenance** behind the
`npm-publish` environment approval.

`npm publish` from a workstation still works but is guarded: `scripts/check-release.mjs`
(`prepublishOnly`) refuses a dirty tree, a branch other than `main`, and any version whose
annotated tag does not resolve to `HEAD`.

One-time repository setup for this to work — all of it is in GitHub settings, not in git:

1. Create an npm **granular access token** scoped to `handover-book`, publish-only, and store
   it as the repository secret `NPM_TOKEN`. Better: switch the workflow to npm **trusted
   publishing** (OIDC, no token at all) once the package is enrolled.
2. Create the **`npm-publish`** environment, protect it with required reviewers, and allow only
   the `release.yml` workflow to use it.
3. Protect `main`: require the `CI` checks (both jobs) and a review before merge. Releases hang
   off `main`, so this is what stops an unreviewed commit from becoming an npm artifact.
   **Current state (checked 2026-09-29 via the GitHub API): not protected** — `main` reports
   `protected: false` with status-check enforcement `off`, and the repository has no rulesets.
   Until this is set, anyone with push access can land a commit that `release.yml` will happily
   publish, because the workflow only requires the tagged commit to be an ancestor of `main`.
4. Enable **private vulnerability reporting** (referenced by `SECURITY.md`).
5. ~~Pin the actions to commit SHAs~~ — **done**: every `uses:` in `.github/workflows/` and
   `examples/` is pinned to a full SHA with a version comment, and the CI `Third-party actions
   are pinned to commit SHAs` step fails if a mutable tag reappears. Dependabot's
   `github-actions` ecosystem bumps SHA and comment together.

### Tag history that does not match the artifacts

Two tags are already wrong and cannot be corrected silently, because they were pushed:

| Tag | Problem | Remediation |
|---|---|---|
| `v0.0.1` | points at commit `e02fddf`, whose `package.json` says **0.1.0** — the tag and the tree it names disagree with each other | the tag has a GitHub Release but no npm version (both were checked via the API); move it to the commit that actually carried `0.0.1`, or leave it and record here that it points at a tree whose own manifest says `0.1.0` |
| `v0.1.0` | names the commit that npm `0.1.1` was actually published from (`gitHead: fd11eac`) | GitHub Release exists, npm has no `0.1.0`. Leave as is and rely on `npm view <pkg>@<ver> gitHead` as the provenance record; retagging cannot retroactively bind the artifact |
| `v0.1.1` | **lightweight** (the others are annotated) and points at `3b400d5`, while a dangling annotated tag object for `v0.1.1` still points at `dc4c193` — the tag was moved after publishing | re-create it as an annotated tag, and treat `0.1.1` on npm as unreproducible; `npm view handover-book@0.1.1 gitHead` is the record |

Moving a published tag is a rewrite that breaks anyone who has fetched it, so it needs a
deliberate decision rather than a cleanup commit:

```bash
git tag -d v0.1.1
git tag -a v0.1.1 <commit-that-produced-the-published-0.1.1> -m "v0.1.1 (retagged; see CHANGELOG)"
git push --delete origin v0.1.1 && git push origin v0.1.1
```

Prefer adding a `## 0.1.1` note in the CHANGELOG saying which commit it was built from, and
make `0.1.3` onward correct, unless someone already depends on the old tag positions.

## Reporting problems

Use the issue templates: bug report, install problem, false positive / missing finding, feature request. For "the book claimed X but the repo says Y" reports, include the evidence ref from the appendix so the citation can be checked directly. Sensitive material does not belong in issues — redact repos, tokens and names first.

## Code of conduct

Be specific and kind. We discuss tool behavior, not people. Reports about maintenance concentration describe Git signals, never judgments of the engineers involved — keep that framing in code, docs and discussions alike.
