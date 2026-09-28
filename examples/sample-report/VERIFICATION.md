# Sample verification record

Hand-check of key judgments in the committed sample book ([handover-book-dana-dev.md](handover-book-dana-dev.md)), per the project's verification template. The sample is a **synthetic demo**, so there is no real maintainer to confirm with: the "confirmation" column is checked against the fixture ground truth defined in [`scripts/make-sample.mjs`](../../scripts/make-sample.mjs), which also generates the git history. Types: **fact** = cited record, **inference** = computed score/judgment, **confirmed** = captured first-person answer.

This table records the check for *this* sample only — it says nothing about the correctness of future books on other repositories.

| # | Judgment (book wording) | Type | Evidence | Support | Confirmation & result |
|---|---|---|---|---|---|
| 1 | `demo-shop:payments`: 85% of commits (11/13) by @dana-dev | fact | commit records, e.g. `3c994a1`, `320d6cd`, `ee9b679` | fully supported | ground truth: 11 dana + 2 sam of 13 payments commits. kept |
| 2 | @dana-dev was the sole reviewer on all 2 reviews of payments PRs | fact | `#17 review:105` (reviews 101, 105 both by dana) | fully supported | review fixtures match. kept |
| 3 | 2 payments commits reference bug-labelled issue #9 | fact | `#9`; commits `fix: charge double-fire on retry (#9)`, `fix: idempotency key collision … (#9)` | fully supported | issue #9 has the `bug` label. kept |
| 4 | `demo-shop:infra`: 4/4 commits (100%) by @dana-dev | fact | `82bc28f`, `559cef2`, `84a5fe3` | fully supported | ground truth: all 4 infra commits are dana's. kept |
| 5 | payments risk score 1.464, rank 1 | inference | formula + factors 0.85 × 1.00 × 1.15 × 1.50 | supported | arithmetic verified (0.8462 × 1.1538 × 1.5 = 1.4646). kept |
| 6 | `demo-shop:auth`: 33% (2/6) by @dana-dev, no concentration flag | fact | `0c62dbb`, `baf88e0` | fully supported | 2 of 6 auth commits are dana's. kept |
| 7 | PR #12: fixed backoff chosen because the provider drops connections after 30s; exponential rejected as it throttles bursts | fact | `#12` PR body | fully supported | quoted from fixture. kept |
| 8 | PR #17: refund idempotency keys derive from (charge key, refund id); server-generated keys would break retries | fact | `#17` PR body, review comment `review:105` | fully supported | body and inline comment agree. kept |
| 9 | 30s canary health check matches the load balancer; shorter values flap the EU region | fact | `#31`, `#23`, commit `82bc28f` | fully supported | PR #23 body + bug issue #31. kept |
| 10 | The checkout double-submit is intentional dedupe; removing it caused issue #9 | confirmed | captured answer 2 | consistent with records | first-person capture; matches issue #9 and PR #17. kept |
| 11 | The webhook replay guard keeps its capture window in an in-memory map | confirmed | captured answer 1 | consistent | first-person capture; **not independently verifiable from Git** — exactly the kind of knowledge Git cannot show. kept, and labelled as captured |
| 12 | Coverage: 25 commits, 4 PRs, 4 reviews, 3 issues collected | fact | action page | fully supported | counts match the seeded history. kept |
| 13 | Sources line discloses synthetic PR fixtures instead of claiming GitHub collection | fact | action page | fully supported | intentional disclosure for this demo. kept |

Process notes:

- `handover verify dana-dev` was run on the exact committed book: 15 citations checked, 0 missing.
- Judgments 1–9 were checkable mechanically against fixture ground truth because the output is deterministic; on a real repository, the "confirmation" column requires the actual maintainer, and high-impact items should be confirmed by them before the handover.
- No claim in the book was found asserting something the records do not support; the two first-person answers are labelled as captured, not as facts derived from history.
