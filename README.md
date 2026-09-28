# Handover

[**English**](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md) | [Español](README.es.md) | [Français](README.fr.md) | [Русский](README.ru.md) | [Deutsch](README.de.md) | [Монгол](README.mn.md) | [العربية](README.ar.md)

> **When a developer leaves, their knowledge shouldn't.**
> Point Handover at a departing engineer's username, and it reads everything they ever committed, reviewed, and argued for — then produces a bound, evidence-linked **Handover Book** for the person who takes their place.

One command. Runs locally. When an LLM provider is configured (the default), collected repository content is sent to it for synthesis; without an API key, everything stays deterministic and local.

```bash
handover gen <username> --repo owner/name
```

---

## Why

`git blame` tells you *who* wrote a line. It cannot tell you *why* — or which modules will silently lose their only reviewer, or which "weird" design decision is actually load-bearing. Wikis depend on people voluntarily writing, and exit meetings start after the resignation is announced and end before the knowledge is transferred.

Handover covers the implicit losses nothing else covers:

1. **Code Panorama** — every module they touched, its state, and its history
2. **Implicit Knowledge Inventory** — modules where they were the *sole* author or *sole* reviewer
3. **Risk Top 5** — "what breaks when they leave," ranked and scored, each item with an evidence chain
4. **Decision Archaeology** — "why we chose this back then," quoting the actual PR/issue debates
5. **The 30-Day Path** — the successor's learning plan
6. **Letter to the Future** — the questions the successor will ask, answered in the departing dev's own voice

## Quick start

Requirements: **Node ≥ 22.13** (ships with built-in SQLite — no native compilation), a GitHub token for reasonable rate limits.

```bash
git clone https://github.com/a742987/Handover.git && cd Handover
npm install

export GITHUB_TOKEN=ghp_...          # repo scope for private repos
npm run dev -- gen <username> --repo owner/name

# or with no token at all — read the person's local clones directly:
npm run dev -- gen <username> --git-dir ~/work/api --git-dir ~/work/web
```

Output lands in `handover-data/`:

- `handover-data/<username>.db` — the local SQLite index (one file per person; second runs are incremental and near-instant)
- `handover-data/handover-book-<username>.md` — the bound book

### Commands

| Command | What it does |
|---|---|
| `gen <username> -r owner/name` | collect → analyze → render the full book |
| `gen <username> -d ~/clone/dir` | same, but from **local git clones** — no token, no network, works for GitLab/Gitee too |
| `collect <username> -r owner/name [-d dir]` | index history only (already-indexed commits, PRs, reviews and issues are skipped) |
| `capture <username>` | sit down with the departing engineer and record their own answers; they are bound into chapter 6 (`--answers q.json` for agents and scripts) |
| `risk <username> [--json]` | print the Risk Top 5 from the local index |
| `bus-factor <username>` | team view: which modules only one person commits to, merged with CODEOWNERS when the repo has one |
| `gate <username> --files changed.txt` | CI check: does this change set touch sole-owned modules? (`--comment`, `--fail-on-match`; see [`examples/sole-owner-gate-action.yml`](examples/sole-owner-gate-action.yml)) |
| `render <username>` | re-render the book from the index without GitHub access (chapters 4-6 call the LLM provider only if an API key is set; pass `-r` to override the repositories recorded in the index) |

Common flags: `--provider openai|anthropic|ollama`, `--model <model>`, `--since <ISO date>`, `--data-dir <dir>`, `--refresh` (re-fetch what is already indexed), `--html` (also write a print-ready single-file HTML twin — browser print gives you the PDF), `--redact` (scrub known secret formats from the LLM digest and the book; also `HANDOVER_REDACT=1`).

### LLM providers

Chapters 1–3 are computed deterministically from the index — they always work, with or without an API key. Chapters 4–6 are synthesized by an LLM; **without a key they fall back to deterministic summaries** instead of failing.

- **Anthropic** — set `ANTHROPIC_API_KEY` (default provider)
- **OpenAI** — set `OPENAI_API_KEY`, run with `--provider openai`
- **Ollama** — fully local, no key: start Ollama and run with `--provider ollama`

Every LLM chapter operates under one hard rule: **evidence chain or nothing.** Claims the model cannot support with a commit, PR, review, or issue ref must be labelled *(inference)* — unverifiable assertions have no place in a handover document.

## How risk is scored (and why you can trust it)

```
risk = sole_contribution_ratio
     × change_frequency            (last 90 days, normalized)
     × incident_weight             (commits referencing bug-labelled issues)
     × irreplaceability            (sole reviewer +0.5, sole author +0.25)
```

Every Risk Top 5 item lists the exact commits, reviews, and issues that justify its score — each one a deep link into the repo. The formula lives in [`src/risk/engine.ts`](src/risk/engine.ts) — read it, challenge it, tune it.

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

The same CLI drives three integrations. The common layer is a **built-in MCP server** (`handover-mcp`, ships in the npm package) that exposes `handover_generate`, `handover_collect`, `handover_risk`, `handover_capture`, `handover_search` (read-only evidence lookup for follow-up questions), and `handover_render` as tools — any MCP client can use it without shelling out to the CLI.

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

**Any other MCP client** (Cursor, ZCode, …) — register `handover-mcp` as a stdio server; same six tools everywhere.

## Privacy and ethics — read this before you run it for someone

- **A gift, not an audit.** Handover exists to hand a successor the map, never to grade the person leaving. Run it *with* the departing engineer, not around them. Their review comments and commit messages are quoted back to colleagues — if they wouldn't say it in a farewell doc, it doesn't belong in the book.
- **Local-first.** Collection, indexing, and rendering all run on your machine. The only network calls are to GitHub's API and your configured LLM provider. Choose **Ollama** and not a single byte of repository content reaches any third party.
- **The index is sensitive.** `handover-data/*.db` contains your team's full commit history. It is gitignored by default; treat the file like a credential.
- **Hallucination is a bug, not a quirk.** LLM output must cite evidence refs; unsupported claims must be labelled *(inference)*. Don't trust a chapter you haven't spot-checked against its evidence chain.
- **Secret scrubbing.** `--redact` / `HANDOVER_REDACT=1` strips known secret formats (GitHub/AWS/Slack/GitLab tokens, `key: value` assignments, private key blocks) before anything reaches an LLM and from the rendered book — best effort, not a guarantee.
- **Anonymization** (real names → role codes, for HR contexts) is on the roadmap before any team/enterprise tier ships.

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest
npm run build       # dist/
npm run dev -- ...  # run the CLI from source
```

Stack: TypeScript · Node (built-in `node:sqlite`) · Octokit · pluggable LLM providers. CI runs typecheck + tests + build on every push.

## Roadmap

- [x] Repo scaffold: CLI + Octokit collection + SQLite index + risk engine + Markdown book
- [x] MCP server (`handover-mcp`) + Claude Code plugin + Codex prompt
- [x] Local git clone collection (`--git-dir`) — no token, no network
- [x] `handover capture` — first-person Q&A bound into chapter 6 (CLI + MCP)
- [x] `handover bus-factor` — team view with CODEOWNERS merge
- [x] Print-ready single-file HTML twin (`--html`; browser print → PDF)
- [x] CI integration — `risk --json`, `gate` command + example workflow
- [x] `handover_search` MCP tool + `--redact` secret scrubbing
- [ ] `npx handover-book gen` end-to-end on a real public repo (MVP, weeks 1–3)
- [ ] Local web reader with evidence deep links (v0.2)
- [ ] Org-wide capability risk map (v1.0)

## Naming

The npm package is `handover-book` (`handover` is occupied by a deprecated package); the CLI command is `handover`. The final product name is still open — see §8.1 of the project plan.

## License

[MIT](LICENSE)
