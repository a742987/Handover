#!/usr/bin/env node
/**
 * Regenerates the committed sample Handover Book in examples/sample-report/.
 *
 * The sample is a **clearly-labelled synthetic demo**: a throwaway git repository
 * ("demo-shop") with a hypothetical maintainer handover, collected from local git
 * only, rendered in deterministic mode (--no-llm), so the output is reproducible
 * and nothing is sent anywhere. Pull-request / review / issue records are synthetic
 * fixtures inserted through the store API to demonstrate the GitHub-backed
 * chapters; in real use they are collected from GitHub. Run `npm run build` first.
 *
 * The committed book (md + html) is the tool's unmodified output; only the sample
 * README.md and VERIFICATION.md next to it are hand-written.
 */
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, 'dist', 'cli.js');
const outDir = path.join(root, 'examples', 'sample-report');
const USERNAME = 'dana-dev';

if (!existsSync(cli)) {
  console.error('dist/cli.js not found — run `npm run build` first.');
  process.exit(1);
}

function run(cmd, args, options = {}) {
  execFileSync(cmd, args, { stdio: options.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', ...options });
}

/** One synthetic commit with pinned author/dates so the history is reproducible. */
function commit(repoDir, author, date, message, files) {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: author.name,
    GIT_COMMITTER_EMAIL: author.email,
    GIT_COMMITTER_DATE: date,
  };
  for (const [file, content] of Object.entries(files)) {
    const full = path.join(repoDir, file);
    execFileSync('node', ['-e', `fs.mkdirSync(require('path').dirname(process.argv[1]),{recursive:true});fs.writeFileSync(process.argv[1],process.argv[2])`, full, content], { env });
    run('git', ['-C', repoDir, 'add', file]);
  }
  run('git', ['-C', repoDir, '-c', `user.name=${author.name}`, '-c', `user.email=${author.email}`, 'commit', '-m', message], { env });
}

const dana = { name: 'Dana Deva', email: 'dana@example.com' };
const sam = { name: 'Sam Rivera', email: 'sam@example.com' };
const chris = { name: 'Chris Lee', email: 'chris@example.com' };

const HISTORY = [
  ['2026-03-01T09:00:00Z', dana, 'init: demo shop', { 'README.md': '# demo shop\n\nA synthetic e-commerce service used to generate the sample handover book.\n' }],
  ['2026-03-02T10:00:00Z', dana, 'feat: charge endpoint with basic validation', { 'payments/charge.ts': 'export function charge() {}\n' }],
  ['2026-03-09T10:00:00Z', dana, 'feat: retry with fixed backoff for provider timeouts', { 'payments/retry.ts': 'export const BACKOFF_MS = [250, 1000, 4000];\n' }],
  ['2026-03-15T10:00:00Z', dana, 'feat: refresh token rotation', { 'auth/tokens.ts': 'export function rotate() {}\n' }],
  ['2026-03-23T10:00:00Z', dana, 'fix: charge double-fire on retry (#9)', { 'payments/charge.ts': 'export function charge() { /* idempotent */ }\n' }],
  ['2026-04-01T10:00:00Z', dana, 'ci: deploy script with canary step', { 'infra/deploy.sh': '#!/bin/sh\n# canary first\n' }],
  ['2026-04-06T10:00:00Z', dana, 'refactor: extract provider client', { 'payments/provider.ts': 'export class ProviderClient {}\n' }],
  ['2026-04-12T10:00:00Z', sam, 'feat: login rate limiting', { 'auth/ratelimit.ts': 'export const LIMIT = 10;\n' }],
  ['2026-04-20T10:00:00Z', dana, 'fix: idempotency key collision on partial refunds (#9)', { 'payments/charge.ts': 'export function charge() { /* idempotency key v2 */ }\n' }],
  ['2026-04-28T10:00:00Z', dana, 'fix: migrate down guard', { 'infra/migrate.sh': '#!/bin/sh\nset -eu\n' }],
  ['2026-05-02T10:00:00Z', chris, 'docs: runbook draft', { 'docs/runbook.md': '# Runbook (draft)\n' }],
  ['2026-05-04T10:00:00Z', sam, 'fix: currency rounding on refunds', { 'payments/refund.ts': 'export function refund() {}\n' }],
  ['2026-05-11T10:00:00Z', dana, 'chore: provider sandbox fixtures', { 'payments/fixtures/sandbox.json': '{ "mode": "sandbox" }\n' }],
  ['2026-05-20T10:00:00Z', sam, 'fix: session cookie SameSite', { 'auth/session.ts': 'export const SAME_SITE = "Lax";\n' }],
  ['2026-05-25T10:00:00Z', dana, 'feat: settlement batch exporter', { 'payments/settlement.ts': 'export function exportBatch() {}\n' }],
  ['2026-06-08T10:00:00Z', dana, 'fix: settlement window off-by-one across DST', { 'payments/settlement.ts': 'export function exportBatch() { /* DST aware */ }\n' }],
  ['2026-06-14T10:00:00Z', dana, 'chore: note deploy key rotation in docs', { 'infra/deploy.md': '# Deploy notes\n' }],
  ['2026-06-22T10:00:00Z', dana, 'perf: batch charge inserts', { 'payments/charge.ts': 'export function charge() { /* batched */ }\n' }],
  ['2026-06-30T10:00:00Z', sam, 'feat: OIDC callback', { 'auth/oidc.ts': 'export function callback() {}\n' }],
  ['2026-07-06T10:00:00Z', dana, 'chore: bump provider sdk', { 'payments/provider.ts': 'export class ProviderClient {} // sdk v3\n' }],
  ['2026-07-21T10:00:00Z', dana, 'fix: clock skew on token validation', { 'auth/tokens.ts': 'export function rotate() { /* skew tolerance */ }\n' }],
  ['2026-08-03T10:00:00Z', dana, 'fix: replay guard for captured webhooks', { 'payments/webhooks.ts': 'export function verify() {}\n' }],
  ['2026-08-10T10:00:00Z', sam, 'chore: auth test fixtures', { 'auth/fixtures.ts': 'export const USERS = [];\n' }],
  ['2026-08-17T10:00:00Z', sam, 'test: refund edge cases', { 'payments/refund.test.ts': 'it("rounds", () => {});\n' }],
  ['2026-08-24T10:00:00Z', dana, 'fix: canary health check timeout (#31)', { 'infra/deploy.sh': '#!/bin/sh\n# canary, 30s health check\n' }],
];

async function main() {
  const work = await mkdtemp(path.join(tmpdir(), 'handover-sample-'));
  const repoDir = path.join(work, 'demo-shop');
  const dataDir = path.join(work, 'data');
  try {
    await mkdir(repoDir, { recursive: true });
    run('git', ['-C', repoDir, 'init', '-b', 'main']);
    for (const [date, author, message, files] of HISTORY) {
      commit(repoDir, author, date, message, files);
    }
    console.log(`synthetic repo ready: ${repoDir} (${HISTORY.length} commits)`);

    // 1. Collect from local git and render the deterministic book.
    run('node', [
      cli, 'gen', USERNAME,
      '--git-dir', repoDir,
      '--author', 'dana',
      '--data-dir', dataDir,
      '--html',
      '--no-llm',
    ]);

    // 2. Seed clearly-labelled synthetic PR/review/issue fixtures into the index
    //    (in real use these come from GitHub collection).
    const { HandoverStore } = await import(pathToFileURL(path.join(root, 'dist', 'store', 'sqlite.js')).href);
    const store = new HandoverStore(path.join(dataDir, `${USERNAME}.db`));
    try {
      const repo = 'demo-shop';
      store.upsertPullRequest({
        repo, number: 12, title: 'Extract retry policy into payments/retry.ts',
        authorLogin: USERNAME, state: 'merged', createdAt: '2026-03-09T11:00:00Z', mergedAt: '2026-03-10T09:00:00Z',
        body: 'The provider drops connections after 30s, so a fixed 250ms/1s/4s backoff covers the three realistic failure modes. We discussed exponential backoff, but the provider throttles bursts, so exponential fire-hoses them. Keep the table literal and hand-tuned.',
        additions: 42, deletions: 6, changedFiles: 1,
      });
      store.upsertPrFiles(repo, 12, ['payments/retry.ts']);
      store.upsertPullRequest({
        repo, number: 17, title: 'Idempotency keys for /charge and partial refunds',
        authorLogin: USERNAME, state: 'merged', createdAt: '2026-04-20T11:00:00Z', mergedAt: '2026-04-21T09:00:00Z',
        body: 'Fixes the double-fire from #9. Every charge carries a client-supplied idempotency key; partial refunds derive theirs from (charge key, refund id). Do not "simplify" this to server-generated keys — a retried request must hit the same key.',
        additions: 88, deletions: 14, changedFiles: 2,
      });
      store.upsertPrFiles(repo, 17, ['payments/charge.ts', 'payments/provider.ts']);
      store.upsertPullRequest({
        repo, number: 21, title: 'OIDC callback + refresh token rotation',
        authorLogin: 'sam-dev', state: 'merged', createdAt: '2026-06-30T11:00:00Z', mergedAt: '2026-07-01T09:00:00Z',
        body: 'Standard OIDC callback; rotation reuses the existing auth/tokens.ts path.',
        additions: 130, deletions: 9, changedFiles: 1,
      });
      store.upsertPrFiles(repo, 21, ['auth/oidc.ts', 'auth/tokens.ts']);
      store.upsertPullRequest({
        repo, number: 23, title: 'Deploy script: canary step + 30s health check',
        authorLogin: USERNAME, state: 'merged', createdAt: '2026-08-24T11:00:00Z', mergedAt: '2026-08-25T09:00:00Z',
        body: 'Canary rides the same script; the 30s health-check timeout matches the load balancer, anything shorter flaps in the EU region (#31).',
        additions: 21, deletions: 3, changedFiles: 1,
      });
      store.upsertPrFiles(repo, 23, ['infra/deploy.sh']);
      store.upsertReview({
        id: 101, repo, prNumber: 12, reviewerLogin: USERNAME, state: 'APPROVED', submittedAt: '2026-03-10T08:00:00Z',
        body: 'Backoff table matches the provider sandbox traces; ship it.', comments: [],
      });
      store.upsertReview({
        id: 105, repo, prNumber: 17, reviewerLogin: USERNAME, state: 'CHANGES_REQUESTED', submittedAt: '2026-04-20T15:00:00Z',
        body: 'Refund keys must include the refund id, otherwise two partial refunds collide.',
        comments: [{ id: 9001, reviewId: 105, path: 'payments/charge.ts', body: 'derive refund key from (charge key, refund id)', authorLogin: USERNAME }],
      });
      store.upsertReview({
        id: 110, repo, prNumber: 21, reviewerLogin: 'sam-dev', state: 'APPROVED', submittedAt: '2026-06-30T18:00:00Z',
        body: 'Self-approved after pairing with Dana on the rotation path.', comments: [],
      });
      store.upsertReview({
        id: 112, repo, prNumber: 23, reviewerLogin: USERNAME, state: 'COMMENTED', submittedAt: '2026-08-24T16:00:00Z',
        body: 'Timeout must equal the LB value (30s), see #31.', comments: [],
      });
      store.upsertIssue({
        repo, number: 9, title: 'Charge double-fires when the provider times out mid-retry',
        authorLogin: 'sam-dev', state: 'closed', createdAt: '2026-03-20T09:00:00Z', closedAt: '2026-04-21T10:00:00Z',
        labels: ['bug'], comments: [],
      });
      store.upsertIssue({
        repo, number: 14, title: 'Quarterly signing key rotation',
        authorLogin: 'chris-lee', state: 'open', createdAt: '2026-05-01T09:00:00Z', closedAt: null,
        labels: ['ops'], comments: [],
      });
      store.upsertIssue({
        repo, number: 31, title: 'Canary check flaps in EU region',
        authorLogin: 'sam-dev', state: 'closed', createdAt: '2026-08-20T09:00:00Z', closedAt: '2026-08-25T10:00:00Z',
        labels: ['bug'], comments: [],
      });
      // The PR/review/issue rows above are synthetic demo fixtures, not GitHub
      // collections — label the sources accordingly so the book's coverage
      // section stays truthful.
      store.setMeta('collected_via', 'local-git,synthetic PR/review/issue fixtures (demo data — in real use: GitHub API)');
      console.log('PR/review/issue fixtures seeded (synthetic, labelled in the sample README).');
    } finally {
      store.close();
    }

    // 3. Record first-person answers as the departing engineer, then re-render.
    const answers = path.join(work, 'answers.json');
    await writeFile(answers, JSON.stringify([
      {
        question: 'Which module would you fix first if you had one more week, and why?',
        answer: 'payments/webhooks.ts. The replay guard works but the capture window is keyed off an in-memory map — one pod restart and we re-process webhooks. I would make it durable before touching anything else.',
      },
      {
        question: 'Which piece of the system looks wrong but must not be "fixed" — and what broke the last time someone tried?',
        answer: 'The double-submit in checkout looks like a bug; it is how we dedupe against the provider. Removing it caused issue #9 (double charges on retry). The idempotency keys in PR #17 are the fix — do not remove them.',
      },
      {
        question: 'Which deploy/migration quirk is load-bearing?',
        answer: 'The canary health-check timeout in infra/deploy.sh must stay at 30s to match the load balancer; anything shorter flaps the EU region (issue #31). And always run the migration dry-run first — the users table has a hand-patched index from the 2024 incident.',
      },
    ], null, 2));
    run('node', [cli, 'capture', USERNAME, '--answers', answers, '--data-dir', dataDir]);
    run('node', [cli, 'render', USERNAME, '--data-dir', dataDir, '--html', '--no-llm']);

    // 4. Citation existence check must pass on the committed sample.
    run('node', [cli, 'verify', USERNAME, '--data-dir', dataDir]);

    // 5. Publish the book (unmodified tool output) into the repo.
    await mkdir(outDir, { recursive: true });
    const md = path.join(dataDir, `handover-book-${USERNAME}.md`);
    const html = path.join(dataDir, `handover-book-${USERNAME}.html`);
    await cp(md, path.join(outDir, 'handover-book-dana-dev.md'));
    await cp(html, path.join(outDir, 'handover-book-dana-dev.html'));
    console.log(`\nsample book copied to ${outDir}`);
    console.log('remember: examples/sample-report/README.md and VERIFICATION.md are hand-maintained.');
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
