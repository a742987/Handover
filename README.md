# Handover

[**English**](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md) | [Español](README.es.md) | [Français](README.fr.md) | [Русский](README.ru.md) | [Deutsch](README.de.md) | [Монгол](README.mn.md) | [العربية](README.ar.md)

> Community translations may lag behind the English README on install steps and data-flow details.

[![CI](https://github.com/a742987/Handover/actions/workflows/ci.yml/badge.svg)](https://github.com/a742987/Handover/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/handover-book)](https://www.npmjs.com/package/handover-book)

**When a developer leaves, their knowledge shouldn't.**

Turn Git history and PR discussions into an evidence-linked handover for the next maintainer. Handover finds maintenance concentrations, revisits past decisions with their original discussions, and lists the questions to confirm before the handover — every claim linked back to the commit, PR, review, or issue it came from.

![Sample Handover Book: the action summary with data coverage and the top items to confirm before the handover](docs/report-screenshot.png)

**[Read the sample handover](examples/sample-report/handover-book-dana-dev.md)** · **[See the demo script](docs/demo-script.md)** · **[Get started](#quick-start)**

Runs locally. Remote LLM synthesis sends selected repository material to your configured provider; local Git with deterministic output is the simpler starting path — see [data flow](#data-flow--limits--read-this-before-you-choose-a-path).

## Why

`git blame` tells you *who* wrote a line. It cannot tell you *why* — or which modules will silently lose their only reviewer, or which "weird" design decision is actually load-bearing. Wikis depend on people voluntarily writing, and exit meetings start after the resignation is announced and end before the knowledge is transferred.

The book has six chapters, computed from your repositories:

1. **Code Panorama** — every module they touched, its state, and its history
2. **Implicit Knowledge Inventory** — modules where they were the *sole* author or *sole* reviewer
3. **Risk Top 5** — "what breaks when they leave," ranked and scored, each item with an evidence chain
4. **Decision Archaeology** — "why we chose this back then," quoting the actual PR/issue debates
5. **The 30-Day Path** — the successor's learning plan
6. **Questions & Draft Answers** — what to ask before the last day, plus the departing engineer's own recorded answers

Every book opens with an **action summary**: what the data covers, what it misses, and the few things worth confirming first. Every claim cites its evidence; unproven judgments are labelled *(inference)*; only answers recorded with `handover capture` speak in the departing engineer's voice. `handover verify` checks that every cited ref actually exists in the index.

## Quick start

The shortest path — one command, no clone (needs Node ≥ 22.13):

```bash
npm install -g handover-book

# from GitHub (needs a token for reasonable rate limits):
export GITHUB_TOKEN=ghp_...
handover gen <username> --repo owner/name --html

# or with no token, no network — read the person's local clones directly:
handover gen <username> --git-dir ~/work/api --git-dir ~/work/web
```

Output lands in `handover-data/`:

- `handover-data/<username>.db` — the local SQLite index (one file per person; second runs are incremental and near-instant)
- `handover-data/handover-book-<username>.md` — the bound book (with `--html`, a print-ready single-file HTML twin; browser print gives you the PDF)

Prefer running from source? `git clone https://github.com/a742987/Handover && cd Handover && npm install && npm run dev -- gen <username> --repo owner/name`.

**Windows / WSL:** keep the index on a native filesystem (`C:\…`), not a WSL-mounted drive path (`/mnt/d/…`). SQLite takes byte-range locks that 9P-mounted paths do not honor reliably, so a `--data-dir` under `/mnt/...` can intermittently report `database is locked` and wait out the 5-second busy timeout. The same applies to `HANDOVER_DATA_DIR`.

Not sure it's worth it? [Read the full sample report first](examples/sample-report/handover-book-dana-dev.md) — a complete, unmodified book for a labelled synthetic scenario, including the verification record for its claims.

Something in a generated report looks wrong? That's the most useful feedback we can get: [open a report-quality issue](../../issues/new?template=false_positive.yml) with the claim and its evidence ref.

### Commands

| Command | What it does |
|---|---|
| `gen <username> -r owner/name` | collect → analyze → render the full book |
| `gen <username> -d ~/clone/dir` | same, but from **local git clones** — no token, no network, works for GitLab/Gitee too |
| `collect <username> -r owner/name [-d dir]` | index history only (already-indexed commits, PRs, reviews and issues are skipped) |
| `capture <username>` | sit down with the departing engineer and record their own answers; they are bound into chapter 6 (`--answers q.json` for agents and scripts) |
| `risk <username> [--json]` | print the Risk Top 5 from the local index |
| `bus-factor <username>` | team view: which modules only one person commits to, merged with CODEOWNERS when the repo has one |
| `gate <username> --files changed.txt` | CI check: does this change set touch sole-owned modules? (`--comment`, `--fail-on-match` (exit 1 on a hit — a failed run also exits 1, so check stderr before treating it as a signal), `--repo owner/name` to scope a multi-repo index; see [`examples/sole-owner-gate-action.yml`](examples/sole-owner-gate-action.yml)) |
| `verify <username>` | citation existence check: every ref cited in the rendered book must exist in the index (exit 1 on missing refs — CI-friendly, `--json` for machines) |
| `render <username>` | re-render the book from the index without GitHub access (chapters 4-6 call the LLM provider only with `--use-llm` and a key; pass `-r` to override the repositories recorded in the index) |

Common flags: `--provider openai|anthropic|ollama`, `--model <model>`, `--since <ISO date>` (zoneless times are treated as UTC), `--data-dir <dir>`, `--refresh` (re-fetch what is already indexed), `--html` (print-ready HTML twin), `--use-llm` (**opt in** to LLM synthesis — content leaves the machine; also `HANDOVER_LLM=1`), `--no-redact` (opt **out** of secret scrubbing, which is on by default; also `HANDOVER_NO_REDACT=1`). `--no-llm` remains accepted and is now the default. `gen` and `collect` accept `--author <identity>` to match the departing engineer's name/email in local clones; `capture --list` prints captured answers; `bus-factor` takes `--top <n>`, `--window <days>` and `--json` for CI. GitHub Enterprise Server: set `GITHUB_API_URL` to your instance's API base (e.g. `https://ghe.example.com/api/v3`) **and** `HANDOVER_GHE_HOST` to that hostname. `GITHUB_API_URL` decides where `GITHUB_TOKEN` is sent, so an https URL on an unlisted host is refused rather than followed. Every variable this tool reads is listed, with its default and its consequence, in [`.env.example`](.env.example).

## Data flow & limits — read this before you choose a path

Collection and indexing always run on your machine. What happens next depends on the path you pick:

| Path | Good for | What you need to know |
|---|---|---|
| **Local Git + deterministic** (`--git-dir`; the default — no LLM call at all) | first trials, sensitive code, sharing the tool with locked-down teams | No GitHub PR / review / issue discussions — "why" decisions and review coverage are missing; chapters 4-6 are deterministic summaries. The book's action page states this gap explicitly. |
| **GitHub + deterministic** (`-r owner/name`; LLM off by default) | teams who want discussion records but no LLM | Works with no token for public repositories, at 60 requests/hour; set `GITHUB_TOKEN` for private repos (repo scope) or larger collections. Chapters 4-6 are deterministic digests of the richest discussions. |
| **GitHub / local Git + remote LLM** (`--use-llm` plus `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`) | narrative chapters 4-6 | Collected repository material is sent to the configured provider for synthesis. **This is opt-in**: without `--use-llm` / `HANDOVER_LLM=1` the run never contacts an LLM, even when a key is present in your environment. Without a key it falls back to deterministic chapters instead of failing. |
| **Local Git + local model** (`--provider ollama --use-llm`) | synthesis that stays on your machine | Requires [Ollama](https://ollama.com) running locally; model quality for synthesis is untested — verify the output. |

`--use-llm` / `HANDOVER_LLM=1` is the explicit **on**-switch, and it is off by default: a key that happens to be in your environment for other tooling does not authorize an upload. `--no-llm` / `HANDOVER_NO_LLM=1` still force it off. Secret redaction (`--redact`, on unless you pass `--no-redact`) scrubs known credential formats from the digest and the book, and is deliberately not a guarantee — anything committed as plaintext can survive the patterns.

### LLM providers

Chapters 1–3 are computed deterministically from the index — they always work, with or without an API key. Chapters 4–6 are synthesized by an LLM only when you pass `--use-llm` (or `HANDOVER_LLM=1`) and a key is configured.

- **Anthropic** — set `ANTHROPIC_API_KEY` (default provider once synthesis is enabled)
- **OpenAI** — set `OPENAI_API_KEY`, run with `--provider openai`
- **Ollama** — fully local, no key: start Ollama and run with `--provider ollama --use-llm`. `--use-llm` is required — `--provider` only selects *which* provider; LLM synthesis itself is opt-in.

Every LLM chapter operates under one hard rule: **evidence chain or nothing.** Claims the model cannot support with a commit, PR, review, or issue ref must be labelled *(inference)*. Chapter 6 never impersonates the departing engineer: draft answers are marked as drafts to confirm, and only `handover capture` answers are first-person. Run `handover verify` to check every citation in a rendered book.

## How risk is scored (and why you can trust it)

```
risk = sole_contribution_ratio
     × change_frequency            (last 90 days, normalized)
     × incident_weight             (commits referencing bug-labelled issues)
     × irreplaceability            (sole reviewer +0.5, sole author +0.25)
```

Every Risk Top 5 item lists the exact commits, reviews, and issues that justify its score — each one a deep link into the repo. The score is a maintenance/ownership **signal from Git records**, not a prediction of incidents and not a measure of a person's knowledge or value; every book says so, and the action page asks a human to confirm each item. The formula lives in [`src/risk/engine.ts`](src/risk/engine.ts) — read it, challenge it, tune it.

## Architecture

```
┌──────────────┐   ┌───────────────┐   ┌──────────────┐   ┌───────────────┐
│  Collect     │ → │  Distill      │ → │  Risk Engine │ → │  Render       │
│  GitHub API  │   │  LLM synthesis│   │  sole-contrib│   │  Markdown +   │
│  (Octokit)   │   │  topic clusters│  │  change freq │   │  print-ready  │
│  Local git   │   │  Q&A capture  │  │  incidents   │   │  HTML book    │
└──────────────┘   └───────────────┘   └──────────────┘   └───────────────┘
          └────────── SQLite index (one file per person, cacheable) ─────────┘
```

## Editor plugins

The same CLI drives three integrations. The common layer is a **built-in MCP server** (`handover-mcp`, ships in the npm package) that exposes `handover_generate`, `handover_collect`, `handover_risk`, `handover_capture`, `handover_search` (read-only evidence lookup for follow-up questions), `handover_render`, and `handover_verify` (checks every evidence citation against the index) as tools — any MCP client can use it without shelling out to the CLI.

```bash
npm install -g handover-book   # puts both `handover` and `handover-mcp` on PATH
```

**Claude Code** — install the bundled plugin:

```
/plugin marketplace add a742987/Handover
/plugin install handover@handover
```

The plugin registers the `handover` MCP server automatically (via the `mcpServers` field in [`plugin/.claude-plugin/plugin.json`](plugin/.claude-plugin/plugin.json)) and adds:

- `/handover:gen <username> --repo owner/name` — full pipeline, then a summarized Risk Top 5
- `/handover:risk <username>` — Risk Top 5 from an existing index
- a skill that teaches the agent when and how to run the pipeline ([`plugin/skills/handover/SKILL.md`](plugin/skills/handover/SKILL.md))

**Codex** — two lines:

1. Register the MCP server in `~/.codex/config.toml`:
   ```toml
   [mcp_servers.handover]
   command = "handover-mcp"
   ```
2. Copy [`codex/handover.md`](codex/handover.md) to `~/.codex/prompts/handover.md`, then run `/handover <username> --repo owner/name`.

**Any other MCP client** (Cursor, ZCode, …) — register `handover-mcp` as a stdio server; same seven tools everywhere.

## Privacy and ethics — read this before you run it for someone

- **A gift, not an audit.** Handover exists to hand a successor the map, never to grade the person leaving. Run it *with* the departing engineer, not around them. Their review comments and commit messages are quoted back to colleagues — if they wouldn't say it in a farewell doc, it doesn't belong in the book.
- **Local-first, stated precisely.** Collection, indexing, and rendering all run on your machine. The only network calls are to GitHub's API and your configured LLM provider. With `--no-llm` (or Ollama), no repository content reaches any third party; with a remote provider configured, selected material is sent to it for synthesis.
- **The index is sensitive.** `handover-data/*.db` contains your team's full commit history. It is gitignored by default; treat the file like a credential.
- **Hallucination is a bug, not a quirk.** LLM output must cite evidence refs; unsupported claims must be labelled *(inference)*. Draft Q&A in chapter 6 is marked for confirmation — only captured answers speak as the person. Run `handover verify` before you circulate a book.
- **Secret scrubbing.** On by default (`--no-redact` / `HANDOVER_NO_REDACT=1` to turn it off; `--redact` and the older `HANDOVER_REDACT=1` remain accepted but are redundant). It strips known secret formats (GitHub/AWS/Slack/GitLab tokens, `key: value` assignments, private key blocks) before anything reaches an LLM and from the rendered book — best effort, not a guarantee.
- **Anonymization** (real names → role codes, for HR contexts) is on the roadmap before any team/enterprise tier ships.

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest
npm run build       # dist/
npm run dev -- ...  # run the CLI from source
npm run sample      # regenerate the committed sample book (examples/sample-report/)
```

Stack: TypeScript · Node (built-in `node:sqlite`) · Octokit · pluggable LLM providers. CI runs typecheck + tests + build on pushes to main and on every pull request. See [CONTRIBUTING.md](CONTRIBUTING.md) for the PR flow and good first issues, and [ROADMAP.md](ROADMAP.md) for what is planned, in progress, and deliberately out of scope.

## Roadmap

- [x] Repo scaffold: CLI + Octokit collection + SQLite index + risk engine + Markdown book
- [x] MCP server (`handover-mcp`) + Claude Code plugin + Codex prompt
- [x] Local git clone collection (`--git-dir`) — no token, no network
- [x] `handover capture` — first-person Q&A bound into chapter 6 (CLI + MCP)
- [x] `handover bus-factor` — team view with CODEOWNERS merge
- [x] Print-ready single-file HTML twin (`--html`; browser print → PDF)
- [x] CI integration — `risk --json`, `gate` command + example workflow
- [x] `handover_search` MCP tool + `--redact` secret scrubbing
- [x] Action-summary first page with data coverage, `handover verify` citation check, explicit `--no-llm` off-switch
- [x] Committed sample book with verification record (`examples/sample-report/`)
- [x] Clean-environment end-to-end from the published npm package: install → `gen` (local Git, `--no-llm`) → `verify` ([verification record](docs/install-verification.md))
- [x] Anonymous `-r owner/name` collection end-to-end on a public repo ([verification record](docs/install-verification.md), Record 3)
- [ ] Authenticated collection (`GITHUB_TOKEN`) end-to-end — private repos, deep pagination, and one Unix environment in the clean run
- [ ] Local web reader with evidence deep links (v0.2)
- [ ] Org-wide capability risk map (v1.0)

## Naming

The npm package is `handover-book` (`handover` is occupied by a deprecated package); the CLI command is `handover`. The final product name is still open — see §8.1 of the project plan.

## License

[MIT](LICENSE)
