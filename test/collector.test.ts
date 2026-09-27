import { describe, expect, it } from 'vitest';
import type { Octokit } from '@octokit/rest';
import { GitHubCollector, parseRepoSlug } from '../src/collect/github.js';
import { HandoverStore } from '../src/store/sqlite.js';

const FULL_NAME = 'acme/api';
const USERNAME = 'alice';

describe('parseRepoSlug', () => {
  it('splits a well-formed owner/name', () => {
    expect(parseRepoSlug('acme/api')).toEqual({ owner: 'acme', repo: 'api' });
  });

  it('rejects everything that is not exactly owner/name', () => {
    for (const bad of ['', 'acme', 'acme/', '/api', 'a/b/c', 'a/b/c/d']) {
      expect(() => parseRepoSlug(bad)).toThrow(/owner\/name/);
    }
  });
});

interface CommitListItem {
  sha: string;
  author?: { login?: string } | null;
  commit?: { author?: { date?: string }; message?: string };
}

interface PullRequestListItem {
  number: number;
  title?: string;
  user?: { login?: string } | null;
  state?: string;
  created_at?: string;
  updated_at?: string;
  closed_at?: string | null;
  merged_at?: string | null;
  body?: string | null;
  additions?: number;
  deletions?: number;
  changed_files?: number;
}

interface IssueListItem {
  number: number;
  title?: string;
  user?: { login?: string } | null;
  state?: string;
  created_at?: string;
  updated_at?: string;
  closed_at?: string | null;
  pull_request?: unknown;
  labels?: Array<{ name?: string } | string>;
  comments?: number;
}

interface Comment {
  id: number;
  user?: { login?: string } | null;
  created_at?: string;
  body?: string;
}

interface FakeData {
  commits?: CommitListItem[];
  commitListError?: { status: number };
  pullRequests?: PullRequestListItem[];
  issues?: IssueListItem[];
  /** issue-number → comments, shared by PR and issue conversations like on GitHub */
  comments?: Record<number, Comment[]>;
  reviews?: Array<{ id: number; user?: { login?: string } | null; state?: string; submitted_at?: string | null; body?: string }>;
  reviewComments?: Array<{ id: number; pull_request_review_id?: number | null; path?: string; body?: string; user?: { login?: string } | null }>;
  prFiles?: Record<number, Array<{ filename: string; additions?: number; deletions?: number }>>;
}

function commitDetail(item: CommitListItem) {
  return {
    data: {
      files: [{ filename: 'payments/charge.ts', additions: 5, deletions: 1 }],
      stats: { additions: 5, deletions: 1 },
      commit: { message: item.commit?.message, author: { date: item.commit?.author?.date } },
    },
  };
}

/** Minimal Octokit stub shaped exactly around the calls GitHubCollector makes. */
function fakeOctokit(data: FakeData, calls: { getCommit: number }): unknown {
  const rest = {
    repos: {
      listCommits: () => {},
      getCommit: async ({ ref }: { ref: string }) => {
        calls.getCommit += 1;
        return commitDetail(data.commits?.find((commit) => commit.sha === ref) ?? { sha: ref });
      },
    },
    pulls: {
      list: () => {},
      listFiles: ({ pull_number }: { pull_number: number }) => data.prFiles?.[pull_number] ?? [],
      listReviewComments: () => data.reviewComments ?? [],
      listReviews: () => data.reviews ?? [],
    },
    issues: {
      list: () => {},
      listComments: () => {},
    },
  };

  const pagesFor = (route: unknown, params: { pull_number?: number }): unknown[] => {
    if (route === rest.repos.listCommits) {
      if (data.commitListError) {
        throw Object.assign(new Error('empty repo'), data.commitListError);
      }
      return data.commits ?? [];
    }
    if (route === rest.pulls.list) {
      return data.pullRequests ?? [];
    }
    if (route === rest.issues.list) {
      return data.issues ?? [];
    }
    if (route === rest.pulls.listFiles) {
      return data.prFiles?.[params.pull_number ?? -1] ?? [];
    }
    if (route === rest.pulls.listReviewComments) {
      return data.reviewComments ?? [];
    }
    if (route === rest.pulls.listReviews) {
      return data.reviews ?? [];
    }
    throw new Error('unexpected iterator route');
  };

  const paginate = Object.assign(
    async (route: unknown, params: { issue_number?: number }): Promise<Comment[]> => {
      if (route === rest.issues.listComments) {
        return data.comments?.[params.issue_number ?? -1] ?? [];
      }
      throw new Error('unexpected paginate route');
    },
    {
      async *iterator(route: unknown, params: { pull_number?: number }): AsyncGenerator<{ data: unknown[] }> {
        yield { data: pagesFor(route, params) };
      },
    },
  );

  return {
    users: {
      getByUsername: async () => ({ data: { login: USERNAME } }),
    },
    rest,
    paginate,
  };
}

async function collectInto(store: HandoverStore, data: FakeData, options: { since?: string; refresh?: boolean } = {}) {
  const calls = { getCommit: 0 };
  const collector = new GitHubCollector('test-token', fakeOctokit(data, calls) as unknown as Octokit);
  const result = await collector.collectInto(store, USERNAME, [FULL_NAME], { ...options });
  return { result, calls, collector };
}

async function collect(data: FakeData, options: { since?: string; refresh?: boolean } = {}) {
  const store = HandoverStore.inMemory();
  const inner = await collectInto(store, data, options);
  return { store, ...inner };
}

describe('GitHubCollector', () => {
  it('indexes commits with their files', async () => {
    const { store, result, calls } = await collect({
      commits: [{ sha: 'a'.repeat(40), author: { login: USERNAME }, commit: { author: { date: '2026-09-01T00:00:00Z' }, message: 'fix crash (#101)' } }],
    });
    expect(result.indexedCommits).toBe(1);
    expect(calls.getCommit).toBe(1);
    const commits = store.allCommits();
    expect(commits).toHaveLength(1);
    expect(commits[0]?.authorLogin).toBe(USERNAME);
    expect(commits[0]?.files[0]?.path).toBe('payments/charge.ts');
  });

  it('treats an empty repository (409) as nothing to collect, not an error', async () => {
    const { result } = await collect({ commitListError: { status: 409 } });
    expect(result.indexedCommits).toBe(0);
    expect(result.pullRequests).toBe(0);
  });

  it('mirrors a PR conversation into the shared issue namespace', async () => {
    const { store, result } = await collect({
      commits: [],
      pullRequests: [
        {
          number: 1,
          title: 'Switch settlement to idempotent retries',
          user: { login: USERNAME },
          state: 'closed',
          created_at: '2026-09-01T00:00:00Z',
          updated_at: '2026-09-02T00:00:00Z',
          merged_at: '2026-09-02T00:00:00Z',
          body: 'We retry with the same key.',
        },
      ],
      comments: { 1: [{ id: 900, user: { login: 'bob' }, created_at: '2026-09-01T05:00:00Z', body: 'Why not exponential backoff?' }] },
      reviews: [{ id: 55, user: { login: 'bob' }, state: 'CHANGES_REQUESTED', submitted_at: '2026-09-01T04:00:00Z', body: 'Please add a test.' }],
      prFiles: { 1: [{ filename: 'payments/charge.ts' }] },
    });
    expect(result.pullRequests).toBe(1);
    expect(result.reviews).toBe(1);

    const prs = store.allPullRequests();
    expect(prs).toHaveLength(1);
    expect(prs[0]?.mergedAt).toBe('2026-09-02T00:00:00Z');

    // the PR row lands in the issues namespace so its comments are readable
    const issues = store.allIssues();
    const mirrored = issues.find((issue) => issue.number === 1);
    expect(mirrored?.isPullRequest).toBe(true);
    expect(mirrored?.title).toBe('Switch settlement to idempotent retries');
    expect(mirrored?.comments).toHaveLength(1);
    expect(mirrored?.comments[0]?.body).toContain('exponential backoff');

    const reviews = store.allReviews();
    expect(reviews[0]?.prNumber).toBe(1);
    expect(reviews[0]?.state).toBe('CHANGES_REQUESTED');
  });

  it('skips PRs that are still current and re-fetches ones that changed', async () => {
    const data: FakeData = {
      commits: [],
      pullRequests: [
        { number: 1, title: 'old', user: { login: USERNAME }, state: 'open', created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z' },
        { number: 2, title: 'fresh', user: { login: USERNAME }, state: 'open', created_at: '2026-09-02T00:00:00Z', updated_at: '2026-09-02T00:00:00Z' },
      ],
      comments: {},
      prFiles: {},
    };
    const { store, result } = await collect(data);
    expect(result.pullRequests).toBe(2);

    // PR 2 gains activity (updated_at bumps); PR 1 stays untouched
    const changed: FakeData = {
      ...data,
      pullRequests: [
        data.pullRequests![0]!,
        { ...data.pullRequests![1]!, updated_at: '2026-09-05T00:00:00Z' },
      ],
    };
    const second = await collectInto(store, changed);
    expect(second.result.pullRequests).toBe(1); // only the changed PR re-indexed
    expect(second.result.skippedPullRequests).toBe(1);
    store.close();
  });

  it('skips issues that are still current via updated_at', async () => {
    const issue: IssueListItem = {
      number: 101,
      title: 'Settlement crashes',
      user: { login: 'bob' },
      state: 'closed',
      created_at: '2026-02-28T00:00:00Z',
      updated_at: '2026-03-01T00:00:00Z',
      labels: [{ name: 'bug' }],
      comments: 1,
    };
    const data: FakeData = {
      commits: [],
      issues: [issue],
      comments: { 101: [{ id: 7, user: { login: 'bob' }, created_at: '2026-02-28T05:00:00Z', body: 'Root cause: timezone math.' }] },
    };
    const { store, result } = await collect(data);
    expect(result.issues).toBe(1);
    expect(store.allIssues()[0]?.labels).toEqual(['bug']);

    const second = await collectInto(store, data);
    expect(second.result.issues).toBe(0);
    expect(second.result.skippedIssues).toBe(1);
    store.close();
  });

  it('stops PR and issue collection at the --since boundary', async () => {
    const { result, store } = await collect(
      {
        commits: [],
        pullRequests: [
          { number: 5, title: 'new', user: { login: USERNAME }, state: 'open', created_at: '2026-09-05T00:00:00Z', updated_at: '2026-09-05T00:00:00Z' },
          { number: 1, title: 'old', user: { login: USERNAME }, state: 'open', created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z' },
        ],
        issues: [
          { number: 50, title: 'new issue', user: { login: 'bob' }, state: 'open', created_at: '2026-09-04T00:00:00Z', updated_at: '2026-09-04T00:00:00Z' },
          { number: 10, title: 'old issue', user: { login: 'bob' }, state: 'open', created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-01T00:00:00Z' },
        ],
      },
      { since: '2026-09-01T00:00:00Z' },
    );
    expect(result.pullRequests).toBe(1);
    expect(result.issues).toBe(1);
    expect(store.allPullRequests().map((pr) => pr.number)).toEqual([5]);
    // issue 50 plus the mirrored row for PR 5 (shared namespace)
    expect(store.allIssues().map((issue) => issue.number)).toEqual([50, 5]);
    store.close();
  });
});
