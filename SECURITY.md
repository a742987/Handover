name: Security

## What counts as a security issue here

Handover reads a repository's history and writes two local artifacts: a SQLite
index of commit messages, PR/review/issue text, and a Markdown/HTML book. The
inputs it treats as **untrusted** are therefore the analyzed repository's own
content — a commit message, a PR title or body, a review comment, a file path, a
`CODEOWNERS` line — and anything reachable through them:

- **Renderer injection.** Book content is built from repository text. A crafted
  commit or PR that produces live markup or a `javascript:` target in the book
  (either the `.md` or the HTML twin) is a security issue: books get opened in
  editors, wikis and browsers, and shared with people who did not write them.
- **Denial of service from repo content.** A `CODEOWNERS` pattern or file path
  that makes `handover bus-factor` / `gen` hang or exhaust memory.
- **Credential exposure.** Anything that can get `GITHUB_TOKEN`,
  `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` into a log, the index, the book, or an
  outbound request the user did not opt into.
- **Unintended egress.** LLM synthesis is opt-in (`--use-llm` / `HANDOVER_LLM=1`).
  A path that sends repository content to a provider without that opt-in is a
  security issue. So is `GITHUB_API_URL` sending the token anywhere other than
  `api.github.com` or the `HANDOVER_GHE_HOST` you configured.
- **Publishing integrity.** A tarball on npm that no tag or commit in this
  repository reproduces (this happened for `0.1.1` — see the changelog), or a CI
  change that lets a pull request reach a secret or a privileged token.

Not a vulnerability: a book that mis-ranks a module, missing evidence, or a
deterministic chapter reading awkwardly. Open a normal issue for those —
report-quality feedback is the thing this project most wants.

## Reporting

Use **GitHub private vulnerability reporting** on this repository
(Security ▸ Report a vulnerability) if it is enabled. If it is not, open a
regular issue that says only "security report — please enable private reporting"
and the maintainer will contact you there; do not post details publicly.

Expect an acknowledgement within a week. This is a small project run by one
maintainer, so fixes are usually quick but disclosure timing is theirs to decide.

## Hardening the example workflow matters too

`examples/sole-owner-gate-action.yml` is copied into other people's repositories.
A weakness there is reported the same way, and is treated as high severity even
though it cannot be exploited in this repository.
