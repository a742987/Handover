# Handover — The Day a Developer Leaves, Their Knowledge Shouldn't

> **Note (2026-09-28):** this is the original project plan, kept for reference.
> Where it disagrees with the current implementation, the README and source are
> authoritative. Known divergences: output is markdown + a print-ready HTML twin
> (no PDF reader yet), collection is REST-only (no GraphQL/reactions), chapters
> 1–3 are deterministic and only 4–6 use the LLM (the plan reversed this), and
> the quickstart path is `gen <username> -r owner/name` **or** `-d <clone dir>`
> (the plan's username-only invocation does not work — the tool needs to know
> which repositories to read).

> **One command.** Point Handover at a departing engineer's username, and it reads everything they ever committed, reviewed, and argued for — then produces a bound, evidence-linked *Handover Book* for the person who takes their place.

| | |
|---|---|
| **Document date** | 2026-09-27 |
| **Codename** | Handover (final name TBD, see §8.1) |
| **Type** | Open-source project (GitHub launch incubation) |
| **Competition** | GitHub search `developer offboarding handover generator` returns **0 repositories** (verified 2026-09-27 via GitHub Search API) |
| **Stack** | TypeScript · Node · SQLite · local-first · pluggable LLM |

---

## 1. Problem

### 1.1 The pain

Every engineering team knows the moment: a core developer resigns, and their knowledge walks out the door with them.

**Surface losses** (partially covered by existing tools):

- Unmaintained code
- Missing documentation
- Ownership vacuum

**Implicit losses** (covered by *nothing*):

- *Why* the code is written this way — known only to them
- The landmines they stepped on and quietly defused, never written down
- Modules where they were the sole reviewer or sole maintainer
- Informal agreements with product, ops, and external teams

### 1.2 Why existing tools don't solve it

| Existing approach | What it answers | What it misses |
|---|---|---|
| `git blame`, `CODEOWNERS` | *Who* wrote this | *Why* it was written this way |
| Wikis / docs | Codified intent | Depends on people voluntarily writing; in offboarding, always missing or stale |
| Exit interviews, handover meetings | One-time transfer | Oral, non-searchable, unrepeatable, starts *after* the resignation is announced |
| Repo-biology / "code archaeology" toys (GitHub: all ≤ 3 stars) | New-joiner onboarding | Wrong direction: built for people *arriving*, not for knowledge *leaving* |

**Conclusion:** "Code ownership" is a solved category. "Implicit knowledge loss at departure" is an unsolved, universal, emotionally resonant one.

### 1.3 Market validation (2026-09-27)

GitHub Search API probes:

- `developer offboarding handover generator` → **0 results**
- `agent postmortem report` → 16 results, all ≤ 3 stars (concept exists, no owner)
- `code archaeology ai` → 10 results, all ≤ 3 stars (adjacent, different angle)

Nearest adjacent concepts are unowned toys. The window for first-mover positioning on the word **"handover"** is open now.

---

## 2. Product

### 2.1 One-line pitch

Input a departing developer's username → AI reads their entire commit, PR, code-review, and issue history → outputs the *Handover Book*.

### 2.2 The Handover Book — chapter spec

| # | Chapter | Content | Data source |
|---|---|---|---|
| 1 | **Code Panorama** | Map of every module they touched, current state, and the historical motivation for each | Commits, path clustering, PR descriptions |
| 2 | **Implicit Knowledge Inventory** | Modules where they were the sole reviewer / sole maintainer / design-doc author | Review records, ownership statistics |
| 3 | **Risk Top 5** | "What breaks when they leave," ranked by incident probability × blast radius, each with an evidence chain | Sole-contribution ratio × change frequency × incident correlation |
| 4 | **Decision Archaeology** | "Why we chose this back then," quoting the actual PR/Issue debates | PR discussions, issues, mailing lists |
| 5 | **The 30-Day Path** | Successor's learning plan: what to read first, what to run, whom to ask | Synthesis and ranking of chapters 1–4 |
| 6 | **Letter to the Future** | The 20 questions a successor will most likely ask, answered in the departing dev's own voice (style-transferred from their comment history) | Full comment corpus |

### 2.3 The killer demo

Demo GIF script: type a username → progress animation ("Reading 1,847 comments written over 3 years…") → 30 seconds later a typeset Handover Book PDF appears, page-turn animation landing on the Risk Top 5 page. The *page-turn* is the shareable moment — not a feature list.

### 2.4 Users and buying trigger

| User | Role | Why they matter |
|---|---|---|
| Engineering Manager / Tech Lead | Primary | Has the pain, the budget, and the audience — the sharing engine |
| The successor | Consumer of the book | Daily active use post-generation |
| HR / Eng-effectiveness teams | Buyer | Org-wide risk maps (V1.0 upsell) |

**Narrative ladder** (each rung is a second launch wave): offboarding (launch) → long leave / rotation (v0.2) → project sunset "obituary" (v0.3) → org-wide capability risk map (v1.0).

---

## 3. Technical design

### 3.1 Architecture

```
┌──────────────┐   ┌───────────────┐   ┌──────────────┐   ┌───────────────┐
│  Collect     │ → │  Distill      │ → │  Risk Engine │ → │  Render       │
│ GitHub API   │   │ LLM synthesis │   │ Sole-contrib │   │ PDF / HTML    │
│ (Octokit,    │   │ Topic clusters│   │ Change freq  │   │ book + local  │
│ GraphQL)     │   │ Q&A pair      │   │ Incident     │   │ web reader    │
│ git log      │   │ extraction    │   │ correlation  │   │ Markdown out  │
└──────────────┘   └───────────────┘   └──────────────┘   └───────────────┘
         └──────────── SQLite index (one file per person, cacheable) ─────────┘
```

### 3.2 Key decisions and rationale

| Decision | Choice | Rationale |
|---|---|---|
| Runtime shape | **Local CLI + local web reader** (local-first, no server) | Handover data is maximally sensitive — a tool that reads your code history must never ask you to upload it. Local-first also rides the current trend (univer, openbao on today's Trending both trade on trust narratives) |
| Language | TypeScript / Node | Octokit is the most mature GitHub client; the audience (EMs, full-stack) can contribute PRs |
| LLM | Pluggable provider: OpenAI / Anthropic / **Ollama (fully local)** | Same trust story; local models make the security argument airtight |
| Storage | SQLite, one file per person | Cacheable, incremental, archivable — the file itself becomes the handover artifact |
| Privacy | Optional anonymization: real names → role codes | Books get forwarded around; leave room for HR contexts |

### 3.3 Collection layer

- REST + GraphQL: commits, PRs (incl. review comments), issues, reactions; configurable time window (default: full history)
- Incremental indexing in SQLite; second-generation runs are near-instant
- Non-GitHub remotes (GitLab / self-hosted git): degraded `git log` support post-MVP

### 3.4 Risk engine — explainable by design

```
risk = sole_contribution_ratio
     × module_change_frequency_90d
     × module_incident_weight
     × irreplaceability (sole reviewer? sole author?)
```

**Every** Top-5 risk item must cite its evidence chain (the exact commits/reviews that justify the score). Unverifiable claims are labeled "inference" in the rendered book. Explainability is the precondition for an EM trusting the tool — and the primary mitigation for LLM hallucination.

---

## 4. Roadmap

### 4.1 MVP — weeks 1–3

- [ ] CLI: `npx handover gen <username>`
- [ ] GitHub collection + SQLite index
- [ ] LLM synthesis: Code Panorama, Implicit Knowledge Inventory, Decision Archaeology
- [ ] Risk Top 5 with evidence chains
- [ ] Markdown / PDF output
- [ ] One shareable demo GIF

**Explicitly out of scope:** team edition, hosted web service, GitLab, non-GitHub sources, accounts.

### 4.2 v0.2 — weeks 4–6

- [ ] 30-Day Path
- [ ] Letter to the Future (style-transfer Q&A)
- [ ] Local web reader (page-turn, search, evidence-chain deep links)
- [ ] Ollama support

### 4.3 v1.0 — months 2–3

- [ ] Org view: run the whole team → "team capability risk map"
- [ ] GitLab / self-hosted git
- [ ] Scheduled snapshots: the book refreshes monthly so offboarding needs zero preparation

---

## 5. Go-to-market

### 5.1 Narrative

Lead with the human story — **"writing a biography for the colleague who left"** — not the tool story ("knowledge management").

- HN title: `Show HN: When a developer leaves, their knowledge shouldn't`
- CN social: `我用 AI 给离职同事写了本"传记"，才发现他默默扛了多少坑`
- The demo's shareable unit is the page-turn moment, not the feature list

### 5.2 Launch cadence

| When | Action |
|---|---|
| T−2 weeks | Build in public on Twitter/X, Jike, Xiaohongshu; tease the Risk Top 5 page alone |
| T | GitHub v0.1 + Show HN + V2EX + r/ExperiencedDevs (EM-dense) |
| T+1 week | Ship the "project obituary" easter egg — second news wave |
| T+2 weeks | 3–5 tech creators run it on a *real* departing teammate and publish the reaction |

### 5.3 Content flywheel

Every run produces a shareable, redacted Handover Book → built-in content material → feeds the next cycle. A "real handover stories" issue template collects testimonials.

---

## 6. Business model (later, but designed for now)

| Tier | What | Price |
|---|---|---|
| Core (OSS) | Single-person Handover Book, local | Free — growth engine |
| Team | Org view, risk map, scheduled snapshots | Per-seat SaaS or self-hosted license |
| Enterprise | SSO, audit trail, HRIS integration, on-prem LLM | Annual |

The OSS core stays genuinely useful forever — the business lives in the org layer, which requires a server anyway.

---

## 7. Risks and mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| LLM fabricates "why he wrote this" | High | Evidence-chain-or-nothing; unlabeled inference forbidden in the book format; §3.4 |
| Privacy / how the departing dev feels | High | Local-first + anonymization; positioned as *a gift for the successor*, never *an audit of the leaver*; explicit ethics section in README |
| API rate limits and LLM cost on huge repos | Medium | SQLite incremental cache; token budgeting; prioritize last 2 years + high-frequency modules |
| Copied by a big player once proven | Medium | Speed: own the word "handover" in mindshare now; moat deepens in org-layer territory |
| Low-frequency need (people don't leave daily) | Medium | Scheduled snapshots + team risk map convert a rare event into a continuously running tool |

---

## 8. Naming and immediate actions

### 8.1 Naming candidates (check GitHub / npm / trademark before committing)

1. **Handover** — plain, ownable, exactly the job to be done
2. **Legacy** — emotional but overloaded
3. **Successor** — reads well on HN
4. **Departure Notes** — softer, HR-friendly

### 8.2 This week

1. Name check and repo scaffold: CLI + Octokit collection + SQLite
2. First real test on a famous public repo with rich PR debates (e.g., a VS Code submodule)
3. Demo GIF script locked before features are finished — the demo defines the MVP, not the other way around
4. Draft the README's ethics section early; it *is* marketing for this product

### 8.3 Milestones and acceptance criteria

| Milestone | When | Acceptance |
|---|---|---|
| M1 MVP works | End of week 3 | Full Handover Book generated for any real public repo; Risk Top 5 manually verified, no major errors |
| M2 Public launch | Week 5 | ≥ 300 stars in week one; demo GIF ≥ 10k views |
| M3 v1.0 | Week 10 | Org view live; ≥ 3 real teams (5+ engineers) used it in a real departure and gave testimonials |
