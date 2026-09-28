# Roadmap

Three buckets, updated as usage changes the priorities. Done items live in the README changelog/roadmap; this file is about what is next, what is being explored, and what is deliberately out of scope.

## Near term (validating with real handovers)

- **`npx handover-book gen` end-to-end on a real public repo** — the sample is synthetic; the next milestone is a full run on a well-known public repository, published as a second sample with maintainer-visible verification.
- **First-30-minutes experience** — actionable errors for the common failures (no token, empty data, wrong repo shape, rate limits), measured by whether a stranger can go from README to first report unaided.
- **45-second demo video** — scripted in [docs/demo-script.md](docs/demo-script.md), to be recorded against a real run.
- **Feedback loop from real usage** — every report of a false positive or missing context becomes a fix, a test, or a documented limit.

## Exploring (prototypes only, not promises)

- **Local web reader** with evidence deep links (v0.2 idea) — the print-ready HTML twin covers sharing today; a reader would add navigation and filtering.
- **User-initiated share summaries** — an opt-in, redacted excerpt that a team can choose to publish; the full private book is never uploaded anywhere.
- **Org-wide capability risk map** (v1.0 idea) — aggregated ownership signals across teams; blocked on calibration and on making the "signal, not verdict" framing unmistakable in the UI.
- **Anonymization** (real names → role codes) before any HR-adjacent tier.

## Not planned (for now)

- SaaS, accounts, SSO, HRIS integrations — Handover is a local CLI; the book belongs to the team that generated it.
- Replacing GitHub/code-hosting APIs with scrapers, or supporting arbitrary forges beyond what git/GitHub APIs offer.
- Risk scores as calibrated incident predictions — the formula is an ownership signal; presenting it as a probability would be dishonest.

## How priorities are decided

Work that reduces first-run failures, improves the correctness of conclusions, or drives an actual handover action comes first. Feature requests that do not serve the single promise — *the successor knows what to read, what to verify, and what to ask* — wait until that promise holds for real teams.
