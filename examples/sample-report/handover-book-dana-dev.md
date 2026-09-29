# Handover Book — @dana\-dev

*When a developer leaves, their knowledge shouldn't.*

- **Repositories:** demo\-shop
- **Generated:** 2026-09-29T11:01:37.155Z
- **Chapters:** 6
- **Synthesis:** deterministic (no LLM key configured)
- **Redaction:** known secret formats were scrubbed from this rendering (best effort, not a guarantee).

> This book is **a gift for the successor**, not an audit of the leaver. It was generated locally from Git history and GitHub metadata; nothing was uploaded anywhere. Claims without an evidence ref are labelled *(inference)*.

## Action summary — read this first

Where the data comes from, what it misses, and the few things worth confirming before the handover. The chapters below hold the detail.

### What this analysis covers

- **Repositories:** demo-shop
- **Sources:** local git clones (commits only) + synthetic PR/review/issue fixtures (demo data — in real use: GitHub API)
- **Commit window:** 2026-03-01 → 2026-08-24 (author dates)
- **Collected:** 25 commits · 4 PRs · 4 reviews · 3 issues · 0 comments · 3 captured answer(s)
- **Contributors:** 3 distinct attributed author(s)
- **Synthesis:** deterministic (no LLM output in this book)

### Confirm before the handover (top 3)

**1. `demo-shop:payments`**

- **Finding:** @dana-dev authored 11/13 commits (85%) touching demo-shop:payments; and was the sole reviewer on all 2 reviews of its PRs; 2 of those commits reference bug-labelled issues (#9); recent activity score 1.00 (last 90 days).
- **Confirm with @dana-dev (the departing engineer):** Who can review changes to `demo-shop:payments` after @dana-dev leaves, and is that person confident doing it today?
- **Evidence:** `3c994a1` `320d6cd` `ee9b679` `#17 review:105` `#9`
- **Next step:** Have the successor read and run `demo-shop:payments`, then walk this item with @dana-dev and record the answer with `handover capture`.
- **Limitation:** Commit and review counts show authorship, not knowledge: pair programming, verbal decisions and off-repo work are invisible to Git. Treat this as a signal to verify, not a verdict.

**2. `demo-shop:infra`**

- **Finding:** @dana-dev authored 4/4 commits (100%) touching demo-shop:infra; 1 of those commits reference bug-labelled issues (#31); recent activity score 0.33 (last 90 days).
- **Confirm with @dana-dev (the departing engineer):** Has anyone besides @dana-dev shipped, deployed or rolled back `demo-shop:infra` — and if not, what was never written down?
- **Evidence:** `82bc28f` `559cef2` `84a5fe3` `#31`
- **Next step:** Have the successor read and run `demo-shop:infra`, then walk this item with @dana-dev and record the answer with `handover capture`.
- **Limitation:** Commit and review counts show authorship, not knowledge: pair programming, verbal decisions and off-repo work are invisible to Git. Treat this as a signal to verify, not a verdict.

**3. `demo-shop:auth`**

- **Finding:** @dana-dev authored 2/6 commits (33%) touching demo-shop:auth; recent activity score 0.67 (last 90 days).
- **Confirm with @dana-dev (the departing engineer):** Who else understands `demo-shop:auth` well enough to own it, and what would they need to learn first?
- **Evidence:** `0c62dbb` `baf88e0`
- **Next step:** Have the successor read and run `demo-shop:auth`, then walk this item with @dana-dev and record the answer with `handover capture`.
- **Limitation:** Commit and review counts show authorship, not knowledge: pair programming, verbal decisions and off-repo work are invisible to Git. Treat this as a signal to verify, not a verdict.

### How to read the labels

- **Cited ref** (`a1b2c3d`, `#123`, `review:456`) — a fact from the collected history; the appendix lists them all.
- ***(inference)*** — a judgement the model or the scoring made that no cited ref directly supports.
- **Recorded answers** — first-person answers from the departing engineer, captured with `handover capture`; the only truly first-person content in this book.
- Risk scores are ownership/maintenance signals from Git records — not a measure of a person's knowledge, value, or an incident prediction.

## Contents

1. Code Panorama *(deterministic)*
2. Implicit Knowledge Inventory *(deterministic)*
3. Risk Top 5 *(deterministic)*
4. Decision Archaeology *(deterministic)*
5. The 30-Day Path *(deterministic)*
6. Questions & Draft Answers *(deterministic)*

## 1. Code Panorama

@dana-dev touched 5 modules across 1 repository.

### demo-shop

| Module | Commits | @dana-dev share | Last touched |
|---|---|---|---|
| `payments` | 13 | 85% | 2026-08-17 |
| `infra` | 4 | 100% | 2026-08-24 |
| `auth` | 6 | 33% | 2026-08-10 |
| `(root)` | 1 | 100% | 2026-03-01 |
| `docs` | 1 | 0% | 2026-05-02 |

Their centre of gravity: `payments` in demo-shop, `infra` in demo-shop, `auth` in demo-shop, `(root)` in demo-shop, `docs` in demo-shop.

## 2. Implicit Knowledge Inventory

Modules where the knowledge is concentrated in one person — the successor has no fallback author or reviewer there.

### Sole or dominant author

- `demo-shop:infra` — 100% of commits by @dana-dev
- `demo-shop:(root)` — 100% of commits by @dana-dev

### Sole reviewer

- `demo-shop:payments` — every review on this module's PRs was by @dana-dev [#17 review:105]

## 3. Risk Top 5

Scored as `sole_contribution_ratio × change_frequency × incident_weight × irreplaceability`. Every item lists its evidence chain.

### 1. `demo-shop:payments` — score 1.464

- sole contribution: 85%
- change frequency: 1.00
- incident weight: 1.15
- irreplaceability: ×1.50

@dana-dev authored 11/13 commits (85%) touching demo-shop:payments; and was the sole reviewer on all 2 reviews of its PRs; 2 of those commits reference bug-labelled issues (#9); recent activity score 1.00 (last 90 days).

Evidence: [3c994a1] [320d6cd] [ee9b679] [#17 review:105] [#9]

### 2. `demo-shop:infra` — score 0.521

- sole contribution: 100%
- change frequency: 0.33
- incident weight: 1.25
- irreplaceability: ×1.25

@dana-dev authored 4/4 commits (100%) touching demo-shop:infra; 1 of those commits reference bug-labelled issues (#31); recent activity score 0.33 (last 90 days).

Evidence: [82bc28f] [559cef2] [84a5fe3] [#31]

### 3. `demo-shop:auth` — score 0.222

- sole contribution: 33%
- change frequency: 0.67
- incident weight: 1.00
- irreplaceability: ×1.00

@dana-dev authored 2/6 commits (33%) touching demo-shop:auth; recent activity score 0.67 (last 90 days).

Evidence: [0c62dbb] [baf88e0]

### 4. `demo-shop:(root)` — score 0.000

- sole contribution: 100%
- change frequency: 0.00
- incident weight: 1.00
- irreplaceability: ×1.00

@dana-dev authored 1/1 commits (100%) touching demo-shop:(root); recent activity score 0.00 (last 90 days).

Evidence: [5cac95e]

## 4. Decision Archaeology

LLM synthesis was not available for this run, so this chapter lists the PRs with the richest written rationale instead of a narrative.

- [#12] **Extract retry policy into payments/retry\.ts** (demo-shop) — The provider drops connections after 30s, so a fixed 250ms/1s/4s backoff covers the three realistic failure modes\. We discussed exponential backoff, but the provider throttles bursts, so exponential fire\-hoses them\. Keep the table literal and hand\-tuned\.
- [#17] **Idempotency keys for /charge and partial refunds** (demo-shop) — Fixes the double\-fire from \#9\. Every charge carries a client\-supplied idempotency key; partial refunds derive theirs from \(charge key, refund id\)\. Do not "simplify" this to server\-generated keys — a retried request must hit the same key\.
- [#23] **Deploy script: canary step \+ 30s health check** (demo-shop) — Canary rides the same script; the 30s health\-check timeout matches the load balancer, anything shorter flaps in the EU region \(\#31\)\.

## 5. The 30-Day Path

A starting plan built from the risk ranking (LLM synthesis was unavailable).

- Week 1: read and run `demo-shop:payments`; reconcile the evidence in [3c994a1] [320d6cd] [ee9b679] [#17 review:105] [#9].
- Week 2: read and run `demo-shop:infra`; reconcile the evidence in [82bc28f] [559cef2] [84a5fe3] [#31].
- Week 3: read and run `demo-shop:auth`; reconcile the evidence in [0c62dbb] [baf88e0].
- Week 4: read and run `demo-shop:(root)`; reconcile the evidence in [5cac95e].

- Before the last day: walk each Risk Top 5 item with the departing engineer and record answers in this book.

## 6. Questions & Draft Answers

LLM style-transfer was unavailable; these are the questions the successor should ask @dana-dev before the last day.

1. Which module would you fix first if you had one more week, and why?
   - (answer to be captured)
2. Which piece of the system looks wrong but must not be "fixed" — and what broke the last time someone tried?
   - (answer to be captured)
3. Which deploy/migration quirk is load-bearing?
   - (answer to be captured)
4. Who outside the team do you call when X breaks?
   - (answer to be captured)
5. What did you promise product/ops that was never written down?
   - (answer to be captured)

### Recorded answers from @dana-dev

Captured in the departing engineer’s own words with `handover capture` — the only first-person material in this book.

1. **Which module would you fix first if you had one more week, and why?**

> payments/webhooks.ts. The replay guard works but the capture window is keyed off an in-memory map — one pod restart and we re-process webhooks. I would make it durable before touching anything else.

   — captured 2026-09-29
2. **Which piece of the system looks wrong but must not be "fixed" — and what broke the last time someone tried?**

> The double-submit in checkout looks like a bug; it is how we dedupe against the provider. Removing it caused issue #9 (double charges on retry). The idempotency keys in PR #17 are the fix — do not remove them.

   — captured 2026-09-29
3. **Which deploy/migration quirk is load\-bearing?**

> The canary health-check timeout in infra/deploy.sh must stay at 30s to match the load balancer; anything shorter flaps the EU region (issue #31). And always run the migration dry-run first — the users table has a hand-patched index from the 2024 incident.

   — captured 2026-09-29

## Appendix — evidence register

| Kind | Evidence | Excerpt |
|---|---|---|
| commit | `82bc28f` | fix: canary health check timeout (#31) |
| commit | `559cef2` | chore: note deploy key rotation in docs |
| commit | `84a5fe3` | fix: migrate down guard |
| issue | `#31` | bug-labelled issue referenced from this module |
| commit | `5cac95e` | init: demo shop |
| commit | `3c994a1` | fix: replay guard for captured webhooks |
| commit | `320d6cd` | chore: bump provider sdk |
| commit | `ee9b679` | perf: batch charge inserts |
| review | `#17 review:105` | all 2 reviews on this module's PRs were by @dana-dev |
| issue | `#9` | bug-labelled issue referenced from this module |
| commit | `0c62dbb` | fix: clock skew on token validation |
| commit | `baf88e0` | feat: refresh token rotation |
