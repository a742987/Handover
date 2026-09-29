import { describe, expect, it } from 'vitest';
import { extractCitations, verifyCitations } from '../src/verify.js';
import { HandoverStore } from '../src/store/sqlite.js';
import type { IssueRecord, PullRequestRecord, ReviewRecord } from '../src/types.js';

const sha = (short: string): string => short.padEnd(40, '0');

function seed(): HandoverStore {
  const store = HandoverStore.inMemory();
  store.upsertCommit({
    sha: sha('abc1234'),
    repo: 'acme/api',
    authorLogin: 'alice',
    authoredAt: '2026-08-01T00:00:00Z',
    message: 'add payments retry',
    additions: 10,
    deletions: 2,
    files: [{ path: 'payments/retry.ts', additions: 10, deletions: 2 }],
  });
  const pr: PullRequestRecord = {
    repo: 'acme/api',
    number: 5,
    title: 'payments retry',
    authorLogin: 'alice',
    state: 'merged',
    createdAt: '2026-08-01T00:00:00Z',
    mergedAt: '2026-08-02T00:00:00Z',
    body: 'why retries exist',
    additions: 10,
    deletions: 2,
    changedFiles: 1,
  };
  store.upsertPullRequest(pr);
  store.upsertPullRequest({ ...pr, repo: 'other/web', body: '' });
  const issue: IssueRecord = {
    repo: 'acme/api',
    number: 9,
    title: 'payments crash',
    authorLogin: 'bob',
    state: 'closed',
    createdAt: '2026-07-01T00:00:00Z',
    closedAt: '2026-07-02T00:00:00Z',
    labels: ['bug'],
    comments: [],
  };
  store.upsertIssue(issue);
  const review: ReviewRecord = {
    id: 42,
    repo: 'acme/api',
    prNumber: 5,
    reviewerLogin: 'bob',
    state: 'APPROVED',
    submittedAt: '2026-08-01T12:00:00Z',
    body: 'lgtm',
    comments: [],
  };
  store.upsertReview(review);
  store.setMeta('repos', 'acme/api,other/web');
  return store;
}

describe('extractCitations', () => {
  it('finds commit, PR/issue and review tokens, deduplicated', () => {
    const markdown = [
      'See [`abc1234`](https://github.com/acme/api/commit/abc1234) and [abc1234] again.',
      'PRs: [#5], [other/web#5], [acme/api#9], [#5 review:42], and a missing [other/web#5 review:999].',
      'Not a citation: (#5) or [see the docs](https://example.com).',
    ].join('\n');
    const tokens = extractCitations(markdown);
    const raws = tokens.map((token) => token.raw);
    expect(raws).toContain('abc1234');
    expect(raws).toContain('#5');
    expect(raws).toContain('other/web#5');
    expect(raws).toContain('acme/api#9');
    expect(raws).toContain('#5 review:42');
    expect(raws).toContain('other/web#5 review:999');
    expect(raws).toHaveLength(6);
  });

  it('does not read bracketed dates, counters or ids in prose as commit shas', () => {
    // Chapter 6 embeds the departing engineer's free-text answers verbatim, so
    // "[20240101]" used to fail `handover verify` on a perfectly clean book.
    const markdown = 'Planned the migration for [20240101], see ticket [1234567] and [9999999].';
    const raws = extractCitations(markdown).map((token) => token.raw);
    expect(raws).toEqual([]);
  });

  it('still accepts the null sha and a short sha with hex letters', () => {
    const raws = extractCitations('[0000000] and [deadbee] and a full [0123456789abcdef0123456789abcdef01234567]').map(
      (token) => token.raw,
    );
    expect(raws).toEqual(['0000000', 'deadbee', '0123456789abcdef0123456789abcdef01234567']);
  });
});

describe('verifyCitations', () => {
  it('accepts refs that exist in scope and flags missing or cross-repo miscites', () => {
    const store = seed();
    try {
      const markdown = [
        'Commit [`abc1234`](https://github.com/acme/api/commit/abc1234) exists, [dead123] does not.',
        'Bare [#5] matches either repo; [acme/api#5] is precise; [other/web#99] is missing.',
        'Review [#5 review:42] exists; [#5 review:999] does not; [other/web#5 review:42] points at the wrong repo.',
        'Issue [acme/api#9] exists.',
      ].join('\n');
      const report = verifyCitations(store, 'book.md', markdown);

      expect(report.repos).toEqual(['acme/api', 'other/web']);
      expect(report.okCount).toBe(5);
      expect(report.missingCount).toBe(4);
      const missing = report.checked.filter((ref) => !ref.ok).map((ref) => ref.raw);
      expect(missing).toEqual(['dead123', 'other/web#99', '#5 review:999', 'other/web#5 review:42']);
      const bareNumber = report.checked.find((ref) => ref.raw === '#5');
      expect(bareNumber?.foundIn.sort()).toEqual(['acme/api', 'other/web']);
    } finally {
      store.close();
    }
  });

  it('extracts and checks bare review citations ([review:42]) — the format the LLM prompt mandates', () => {
    const markdown = 'Guidance from [review:42] and repo-qualified [acme/api review:42], plus a missing [review:999].';
    const raws = extractCitations(markdown).map((token) => token.raw);
    expect(raws).toContain('review:42');
    expect(raws).toContain('acme/api review:42');

    const store = seed();
    try {
      const report = verifyCitations(store, 'book.md', markdown);
      expect(report.checked.find((ref) => ref.raw === 'review:42')?.ok).toBe(true);
      expect(report.checked.find((ref) => ref.raw === 'acme/api review:42')?.ok).toBe(true);
      expect(report.checked.find((ref) => ref.raw === 'review:999')?.ok).toBe(false);
    } finally {
      store.close();
    }
  });

  it('accepts upper-case commit citations by normalizing the sha', () => {
    const store = seed();
    try {
      const report = verifyCitations(store, 'book.md', 'Cited [ABC1234] in caps, and [`ABC1234`] backticked.');
      expect(report.missingCount).toBe(0);
      expect(report.checked).toHaveLength(1);
      expect(report.checked[0]?.raw).toBe('ABC1234');
      expect(report.checked[0]?.sha).toBe('abc1234');
      expect(report.checked[0]?.ok).toBe(true);
    } finally {
      store.close();
    }
  });

  it('returns an empty report for a book without citations', () => {
    const store = seed();
    try {
      const report = verifyCitations(store, 'book.md', '# Handover Book\n\nNo refs here. (inference)');
      expect(report.checked).toHaveLength(0);
      expect(report.missingCount).toBe(0);
    } finally {
      store.close();
    }
  });
});
