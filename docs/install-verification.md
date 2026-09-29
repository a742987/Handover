# Installation verification — clean environment

Three records live here. The newest supersedes the older for the current
package; the older are kept as-run rather than edited, because a verification
record is evidence about a specific build, not documentation.

- **2026-09-29 — `handover-book@0.1.3`, GitHub API path** (local artifact, unauthenticated `-r owner/name`, Windows) — found four defects, all fixed
- **2026-09-29 — `handover-book@0.1.3`** (local artifact, CLI + MCP, Windows)
- **2026-09-28 — `handover-book@0.1.1`** (published from the registry, CLI only, Windows)

---

## Record 3 — 2026-09-29, `handover-book@0.1.3`, the GitHub collection path

Record 2 said plainly that the `-r owner/name` path had never been run. Running
it once against the real API, from the installed artifact, with no token, produced
four defects that no amount of reading the code had surfaced.

| Item | Value |
|---|---|
| OS / Node | Windows 10.0.26200, Node v24.12.0 |
| Directory | `…\AppData\Local\Temp\hb-verify-013-api`, fresh `npm init -y` |
| Install | `npm install <handover-book-0.1.3.tgz>` → 0 vulnerabilities |
| Auth | none — `GITHUB_TOKEN` deliberately unset, so the anonymous path is what ran |

```bash
npx handover gen a742987 -r a742987/Handover --data-dir ./api-data --html
# → 17 commits indexed, book + HTML twin + index written
npx handover verify a742987 --data-dir ./api-data
# → Checked 12 citation(s) against 1 repo(s) in scope. All cited refs exist.
```

### What running it found

1. **[高] Issues were collected from the wrong endpoint.** `octokit.rest.issues.list`
   is `GET /issues` — *issues assigned to the authenticated user, in any
   repository*. The repository-scoped call is `listForRepo` (`GET /repos/{owner}/{repo}/issues`).
   Unauthenticated this failed outright (401 "Requires authentication"); with a
   token it would have collected the wrong person's issues and stamped them with
   the analyzed repository's key, so `verify` would have blessed citations
   pointing at issues in unrelated repositories. Fixed, with the endpoint routes
   printed from the installed `@octokit` package as evidence, and a test that
   asserts the URLs a real Octokit puts on the wire.
2. **[中] A doomed request was retried four times.** GitHub's *primary* rate limit
   (quota spent, resets on the hour) came back as a retryable 403, so every
   remaining request paid the whole backoff ladder before failing: measured at
   **14.0 s and four identical requests** where the fix needs one and 0.5 s.
   Primary and secondary limits are now told apart by their headers
   (`x-ratelimit-remaining: 0` with no `Retry-After` vs a limit that says when to
   come back), and the error reports the reset time.
3. **[中] A failed collect deleted index data it never replaced.** The out-of-scope
   cleanup ran *before* the first repository was fetched, so a collect that died
   on request forty had already wiped every repository the command line did not
   name. The cleanup now runs only after a successful collect. Pinned by a test
   that fails on the old ordering (`a failed collect must not delete what it
   never replaced`).
4. **[低, Windows only] The error path aborted the runtime.** `fail()` called
   `process.exit(1)`, which on this machine tore libuv handles down mid-flight
   after a failed collect and printed
   `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c:76`
   *below* its own error message. It now sets `process.exitCode` and lets the loop
   drain: same status, no abort. Verified by re-running the exact command that
   produced it.

### Same artifact, the rest of the surface

The four findings above came from the path nobody had run, so the remaining
commands and the MCP tools were driven from the same install too.

| What ran | Result |
|---|---|
| `collect --git-dir <clone>` | 17 commits into the index |
| `risk`, `bus-factor`, `render --html`, `verify` | all fine; `verify` reports **2 repo(s) in scope** and every citation resolves after mixing a GitHub-collected repo with a local one — the orphan-preservation invariant holds |
| `gate --files changed.txt` / `--repo owner/name` / `--comment` | 2 modules flagged; `--repo` scopes to 1 and accepts a mixed-case slug; comment renders as intended |
| `capture --answers answers.json`, `capture --list` | 1 of 2 stored — a blank answer is skipped by design — and it reads back |
| `gate --files -` piped to `node` directly | works, and produced the correct verdict |
| MCP `initialize` → `tools/list` → `handover_generate` | 671 ms, six deterministic chapters, book written, nothing sent off the machine; `dataDir: "../../outside"` still rejected |
| MCP `handover_verify` on that book | 2 citations checked, 0 unsupported — the artifact's own output satisfies the artifact's own citation checker |

Three further defects came out of that sweep, all in the "silent" family:

- **[medium] `gate --files -` failed open on empty input.** "0 changed path(s),
  none in sole-owned modules" and exit 0 — an all-clear about data that never
  arrived. Reachable by accident because npm/npx does not forward stdin to child
  processes on Windows: `cat changed.txt | npx handover gate … --files -` reads
  nothing, while the same command through `node dist/cli.js` works. A gate that
  received nothing now errors (behaviour change).
- **[low] `--files <file>` help described the value as the paths themselves**
  ("newline-separated changed paths"), while the code reads a file at that path.
  The example workflow used the correct form; the audit tripped on the wording.
- **[low] Two MCP tool descriptions told models that GitHub collection "requires
  `GITHUB_TOKEN`"**, which this record's own first run disproved for public
  repositories. A model-facing string that overstates a credential requirement
  makes an agent ask for a token it does not need, or refuse to try.

### This sweep is now a gate

Records like this rot if nobody repeats them. `scripts/smoke.mjs` does what the
two sections above did by hand — pack, install into a throwaway directory, drive
every CLI command and the MCP server against a synthetic repository, assert on exit
statuses, wording, files written and the absence of terminal control bytes in any
output — and CI job `artifact-smoke` runs it on **ubuntu-latest and
windows-latest** on every push and pull request. `npm run smoke` runs it locally.

The gate also reads `examples/sole-owner-gate-action.yml`, pulls the two shell
snippets out of it and *runs* them, because that file is the one artifact whose
failure mode lives in somebody else's repository: if its `grep -c` detector stops
matching `gate --comment` output, the bot goes silent and every PR passes.

### A second interop hazard, found by the gate that checks a shell snippet

Writing that check produced a false green on this machine, and the mechanism is
worth recording because it will recur for any test here that spawns a shell:

- `examples/…yml` runs on `ubuntu-latest`, so the snippet was tested by spawning
  `bash`. Under WSL2 this instance has no Linux Node runtime, so `node` is the
  Windows binary (`process.platform === 'win32'`) and `bash` is the Linux one.
- **A `-c` script string crossing that boundary is expanded before `bash` parses
  it.** `bash -c 'HANDOVER_VERSION="0.1.3"'$'\n''…[ -z "$HANDOVER_VERSION" ]…'`
  reported an empty variable — `"$BASH_VERSION"` arrived already substituted, with
  the `(1)` in its value, which is only possible if a shell expanded the argument.
  Every case then "refused", so the two `must refuse` assertions passed by accident
  and only the pinned-version case looked broken. Passing the same snippet on
  **stdin** (`bash -s`) gives refuse / refuse / accept, as written.
- **The `env` option does not cross either.** With `env: { HB: 'plain' }` the child
  saw an unset variable (`set -u` reported `HB: unbound variable`), so "pass the
  value through the environment instead" is not a way out.

Three rules fall out of it, all now applied in `scripts/smoke.mjs`: feed shell
snippets on stdin rather than as `-c` arguments; treat a spawn error as *not a
refusal* (`/usr/bin/env`, absent under a Windows node, made every case report a
refusal the same way); and assert the refusal's **message**, since any unrelated
`command not found` also exits non-zero. The extraction is checked too — a block
that has walked past its own step is reported as a failure rather than run.

### Not covered by this record

- **The authenticated path is still unrun.** `GITHUB_TOKEN` was deliberately
  unset; with a token the private-repository and 5 000-request behaviour is
  untested end to end.
- **Small repository, shallow history.** 17 commits, no pull requests or issues
  to collect, so pagination and the `--since` boundary saw no real data — and
  defect 1 above needed a repository *with* issues to show up, which the second
  run (`-r actions/checkout`, stopped by the anonymous quota) only reached
  partway. That partial run is what surfaced defects 2 and 4.
- **One OS.** The guide asks for Windows plus a Unix; Unix is still pending, and
  defect 4 is Windows-only by nature, so a Unix run would not have found it.
  Checked rather than assumed: this WSL2 instance has no Linux Node runtime —
  `which -a node` resolves to `/mnt/c/Program Files/nodejs/node.exe` and
  `process.platform` is `win32` — so a Unix run needs a runtime installed first,
  which is a change to the machine rather than to this repository.
- **The POSIX half of one earlier finding stays unmeasured.** A follow-up showed
  that "a repository key can carry terminal escapes" is reproducible on Windows
  after all, by planting the key directly in the index database (a hand-around
  file): with the CLI's `printLine` sanitiser disabled, `handover risk` emits
  `pay\u001b[2J\u001b[1;31mGATE-APPROVED\u001b[0m:(root)` verbatim, and with it enabled both
  `risk` and `gate` reduce it to inert text. What still needs a Unix machine is the
  entry point — a clone directory whose *name* contains `ESC`.

---

## Record 2 — 2026-09-29, `handover-book@0.1.3`

Second gate run, against the **built artifact** rather than the registry (0.1.3
was not published when this was run, so the package came from `npm pack`;
everything else about the environment is a clean install — dependencies resolve
from the public registry, and nothing is linked or copied from this checkout).

| Item | Value |
|---|---|
| OS / Node | Windows 10.0.26200, Node v24.12.0 |
| Directory | Fresh `C:\Users\…\Temp\hb-install-verify-013` with `npm init -y` |
| Install | `npm install <handover-book-0.1.3.tgz>` → **added 117 packages**, no errors, no warnings |

```bash
npx handover --version                                   # → 0.1.3
npx handover gen a742987 --git-dir <repo> --author a742987 --html --data-dir ./demo-data
# → LLM synthesis disabled (--no-llm is the default; …) Nothing leaves this machine.
#   Book / HTML twin / index written
npx handover verify a742987 --data-dir ./demo-data
# → Checked 10 citation(s) against 1 repo(s) in scope. All cited refs exist.
```

Artifact contents checked: `dist/cli.js`, `dist/mcp.js`, `dist/index.d.ts` all
present; no `src/`, no `test/`, no `.env.example` in the installed package.

**MCP server, checked from the installed binary for the first time:**

```
initialize        → server handover@0.1.3
tools/list        → handover_generate, handover_collect, handover_risk,
                    handover_capture, handover_search, handover_render
handover_risk(dataDir: "demo-data")     → ok
handover_risk(dataDir: "../../evil")    → isError=true, input validation:
                    dataDir "../../evil" is outside the permitted roots
```

### Not covered by this record

- **Not the registry copy.** Re-run these same commands after 0.1.3 is published;
  the artifact is built from the same tree, but the gate is about the install path.
- **Linux / macOS still unverified**, and the WSL case has a known wrinkle
  documented in the README: an index on a `/mnt/...` path can report
  `database is locked` (9P byte-range locks).
- **The `-r owner/name` GitHub-collection path is still unexercised** in a clean
  environment — as it was in the first record. It needs a token.
- **No LLM call.** The default-off setting was verified by observation (the
  run says `LLM synthesis disabled`); no provider was contacted in either direction.

---

## Dependency facts — where each one is checked

| Question | Answered by | Evidence |
|---|---|---|
| Vulnerable packages (high and above) | CI, every push | `npm audit --audit-level=high` in `release-readiness`; clean install of the packed artifact reported 0 vulnerabilities |
| Packages with install scripts | CI, every push | allowlist gate (`esbuild`, `fsevents`); verified by injecting a package with `hasInstallScript` and watching it fail |
| Exact pinning + integrity | `test/deps.test.ts` | lockfile v3, every top-level entry with an exact version and an `integrity` hash; CI installs with `npm ci` |
| Runtime/dev split, unused deps | `test/deps.test.ts` | every declared dependency is imported by `src/`; no dev dependency is imported by shipped source |
| Deprecated or abandoned packages | queried 2026-09-29 (cannot be a repo test) | `npm view … deprecated` for all 9 direct dependencies: none deprecated. Last publishes: `@octokit/rest@22.0.1` 2025-10-31 (oldest, current major), `commander@15.0.0` 2026-05-29, `zod@4.6.5` 2026-09-13, `marked@18.0.14` 2026-09-22, `tsx@4.23.15` 2026-09-20, `vitest@5.0.2` 2026-09-25, `@modelcontextprotocol/sdk@1.31.0` 2026-09-28 |
| Version currency | same query | all runtime deps at latest published except `@modelcontextprotocol/sdk` (installed 1.30.1 vs 1.31.0, one minor); Dependabot's `npm` ecosystem covers it |

---

## Record 1 — 2026-09-28, `handover-book@0.1.1`

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
