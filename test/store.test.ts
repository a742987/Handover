import { describe, expect, it } from 'vitest';
import { HandoverStore } from '../src/store/sqlite.js';
import type { CommitRecord, IssueRecord, ReviewRecord } from '../src/types.js';

const REPO = 'acme/api';

function commit(sha: string, author: string, at: string, paths: string[], message = `commit ${sha}`): CommitRecord {
  return {
    sha,
    repo: REPO,
    authorLogin: author,
    authoredAt: at,
    message,
    additions: 10,
    deletions: 2,
    files: paths.map((path) => ({ path, additions: 5, deletions: 1 })),
  };
}

describe('HandoverStore', () => {
  it('round-trips commits with their files', () => {
    const store = HandoverStore.inMemory();
    store.upsertCommit(commit('a'.repeat(40), 'alice', '2026-09-01T00:00:00Z', ['payments/charge.ts']));
    const commits = store.allCommits();
    expect(commits).toHaveLength(1);
    expect(commits[0]?.authorLogin).toBe('alice');
    expect(commits[0]?.files).toEqual([{ path: 'payments/charge.ts', additions: 5, deletions: 1 }]);
    expect(store.hasCommit(REPO, 'a'.repeat(40))).toBe(true);
    expect(store.hasCommit(REPO, 'b'.repeat(40))).toBe(false);
  });

  it('upserting the same commit twice does not duplicate rows', () => {
    const store = HandoverStore.inMemory();
    const sha = 'c'.repeat(40);
    store.upsertCommit(commit(sha, 'alice', '2026-09-01T00:00:00Z', ['src/a.ts']));
    store.upsertCommit(commit(sha, 'alice', '2026-09-01T00:00:00Z', ['src/a.ts']));
    expect(store.allCommits()).toHaveLength(1);
    expect(store.allCommits()[0]?.files).toHaveLength(1);
  });

  it('round-trips reviews with inline comments', () => {
    const store = HandoverStore.inMemory();
    const review: ReviewRecord = {
      id: 7,
      repo: REPO,
      prNumber: 1,
      reviewerLogin: 'alice',
      state: 'CHANGES_REQUESTED',
      submittedAt: '2026-08-30T10:00:00Z',
      body: 'This will break the settlement job.',
      comments: [{ id: 70, reviewId: 7, path: 'payments/settle.ts', body: 'Off-by-one here.', authorLogin: 'alice' }],
    };
    store.upsertReview(review);
    const loaded = store.allReviews();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.comments).toHaveLength(1);
    expect(loaded[0]?.comments[0]?.body).toContain('Off-by-one');
  });

  it('round-trips issues with labels and comments, replacing stale labels', () => {
    const store = HandoverStore.inMemory();
    const issue: IssueRecord = {
      repo: REPO,
      number: 101,
      title: 'Settlement job crashes on leap days',
      authorLogin: 'bob',
      state: 'closed',
      createdAt: '2026-02-28T00:00:00Z',
      closedAt: '2026-03-01T00:00:00Z',
      labels: ['bug'],
      comments: [{ id: 5, number: 101, authorLogin: 'alice', createdAt: '2026-02-28T05:00:00Z', body: 'Root cause: timezone math.' }],
    };
    store.upsertIssue(issue);
    store.upsertIssue({ ...issue, labels: ['bug', 'incident'] });

    const issues = store.allIssues();
    expect(issues).toHaveLength(1);
    expect(issues[0]?.labels).toEqual(['bug', 'incident']);
    expect(issues[0]?.comments[0]?.body).toContain('timezone');
  });

  it('keeps PR file paths for review-ownership analysis', () => {
    const store = HandoverStore.inMemory();
    store.upsertPrFiles(REPO, 42, ['payments/a.ts', 'payments/b.ts']);
    store.upsertPrFiles(REPO, 42, ['payments/a.ts', 'payments/b.ts', 'docs/x.md']);
    const map = store.allPrFiles();
    expect(map.get(`${REPO}#42`)).toEqual(['payments/a.ts', 'payments/b.ts', 'docs/x.md']);
  });

  it('reports which PRs and issues are already indexed', () => {
    const store = HandoverStore.inMemory();
    store.upsertPullRequest({
      repo: REPO, number: 1, title: 't', authorLogin: 'alice', state: 'open',
      createdAt: '2026-09-01T00:00:00Z', mergedAt: null, body: '', additions: 0, deletions: 0, changedFiles: 0,
    });
    store.upsertIssue({
      repo: REPO, number: 10, title: 't', authorLogin: 'bob', state: 'open',
      createdAt: '2026-09-01T00:00:00Z', closedAt: null, labels: [], comments: [],
    });
    expect(store.hasPullRequest(REPO, 1)).toBe(true);
    expect(store.hasPullRequest(REPO, 2)).toBe(false);
    expect(store.hasIssue(REPO, 10)).toBe(true);
    expect(store.hasIssue(REPO, 11)).toBe(false);
  });

  it('treats a changed head sha as stale even when updated_at is current', () => {
    const store = HandoverStore.inMemory();
    store.upsertPullRequest({
      repo: REPO, number: 1, title: 't', authorLogin: 'alice', state: 'open',
      createdAt: '2026-09-01T00:00:00Z', mergedAt: null, body: '', additions: 0, deletions: 0, changedFiles: 0,
      updatedAt: '2026-09-02T00:00:00Z', headSha: 'aaaa',
    });
    // same updated_at + same head sha → fresh; new push (different sha) → stale
    expect(store.hasPullRequest(REPO, 1, '2026-09-02T00:00:00Z', 'aaaa')).toBe(true);
    expect(store.hasPullRequest(REPO, 1, '2026-09-02T00:00:00Z', 'bbbb')).toBe(false);
    // newer GitHub-side activity than the cache is stale regardless of sha
    expect(store.hasPullRequest(REPO, 1, '2026-09-03T00:00:00Z', 'aaaa')).toBe(false);
    // a cached row newer than what GitHub reports is still fresh
    expect(store.hasPullRequest(REPO, 1, '2026-09-01T00:00:00Z', 'aaaa')).toBe(true);
  });

  it('clears every table for repos outside the given scope, keeping the rest', () => {
    const store = HandoverStore.inMemory();
    const other = 'other/repo';
    store.upsertCommit(commit('a'.repeat(40), 'alice', '2026-09-01T00:00:00Z', ['payments/a.ts']));
    store.upsertCommit({ ...commit('b'.repeat(40), 'bob', '2026-09-01T00:00:00Z', ['src/b.ts']), repo: other });
    store.upsertIssue({
      repo: other, number: 1, title: 't', authorLogin: 'bob', state: 'open',
      createdAt: '2026-09-01T00:00:00Z', closedAt: null, labels: ['bug'],
      comments: [{ id: 5, number: 1, authorLogin: 'alice', createdAt: '2026-09-01T00:00:00Z', body: 'x' }],
    });
    store.clearRepositoriesExcept([REPO]);

    expect(store.allCommits().map((c) => c.repo)).toEqual([REPO]);
    expect(store.allIssues()).toHaveLength(0);
    // meta survives repo cleanup
    store.setMeta('repos', REPO);
    expect(store.getMeta('repos')).toBe(REPO);
  });

  it('deletes reviews (and their comments) that were not seen on refetch', () => {
    const store = HandoverStore.inMemory();
    const review = (id: number): ReviewRecord => ({
      id, repo: REPO, prNumber: 1, reviewerLogin: 'alice', state: 'APPROVED',
      submittedAt: '2026-09-01T00:00:00Z', body: '',
      comments: [{ id: id * 10, reviewId: id, path: 'payments/a.ts', body: 'note', authorLogin: 'alice' }],
    });
    store.upsertReview(review(1));
    store.upsertReview(review(2));

    store.deleteReviewsNotSeen(REPO, 1, [1]);
    const reviews = store.allReviews();
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.id).toBe(1);
    expect(reviews[0]?.comments).toHaveLength(1);
  });

  it('wipes all reviews for a PR when none were seen on refetch', () => {
    const store = HandoverStore.inMemory();
    store.upsertReview({
      id: 1, repo: REPO, prNumber: 1, reviewerLogin: 'alice', state: 'APPROVED',
      submittedAt: '2026-09-01T00:00:00Z', body: '', comments: [],
    });
    store.deleteReviewsNotSeen(REPO, 1, []);
    expect(store.allReviews()).toHaveLength(0);
  });
});
