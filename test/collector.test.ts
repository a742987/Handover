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
  /** GitHub-side canonical login returned by users.getByUsername (defaults to USERNAME) */
  login?: string;
  /** served at path "CODEOWNERS"; other paths 404 */
  codeowners?: string;
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
      getContent: async ({ path: filePath }: { path: string }) => {
        if (filePath === 'CODEOWNERS' && data.codeowners !== undefined) {
          return { data: { content: Buffer.from(data.codeowners, 'utf8').toString('base64'), encoding: 'base64' } };
        }
        throw Object.assign(new Error('Not Found'), { status: 404 });
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
      getByUsername: async () => ({ data: { login: data.login ?? USERNAME } }),
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
  it('returns the GitHub-side canonical login and records it in meta', async () => {
    const store = HandoverStore.inMemory();
    const collector = new GitHubCollector('test-token', fakeOctokit({ login: 'Alice-Real' }, { getCommit: 0 }) as unknown as Octokit);
    const result = await collector.collectInto(store, 'alice-real', [FULL_NAME], {});
    expect(result.login).toBe('Alice-Real');
    expect(store.getMeta('collected_for')).toBe('Alice-Real');
  });

  it('deduplicates the requested repository list', async () => {
    const store = HandoverStore.inMemory();
    const calls = { getCommit: 0 };
    const collector = new GitHubCollector('test-token', fakeOctokit({ commits: [] }, calls) as unknown as Octokit);
    await collector.collectInto(store, USERNAME, [FULL_NAME, FULL_NAME, 'other/repo'], {});
    expect(store.getMeta('repos')).toBe(`${FULL_NAME},other/repo`);
  });

  it('stores repo CODEOWNERS text for the bus-factor view', async () => {
    const { store } = await collect({ commits: [], codeowners: '* @acme/platform\n/payments/ @alice @bob\n' });
    expect(store.getMeta('codeowners:acme/api')).toContain('/payments/');
  });

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

  it('spares preserved repos (local git rows) from the orphan cleanup', async () => {
    const store = HandoverStore.inMemory();
    store.upsertCommit({
      sha: 'b'.repeat(40),
      repo: 'local-api',
      authorLogin: USERNAME,
      authoredAt: '2026-09-01T00:00:00Z',
      message: 'local work',
      additions: 1,
      deletions: 0,
      files: [{ path: 'src/x.ts', additions: 1, deletions: 0 }],
    });
    const calls = { getCommit: 0 };
    const collector = new GitHubCollector('test-token', fakeOctokit({ commits: [{ sha: 'a'.repeat(40), author: { login: USERNAME }, commit: { author: { date: '2026-09-01T00:00:00Z' }, message: 'remote work' } }] }, calls) as unknown as Octokit);
    await collector.collectInto(store, USERNAME, [FULL_NAME], { preserveRepos: ['local-api'] });
    expect(store.allCommits().some((commit) => commit.repo === 'local-api')).toBe(true);
    expect(store.allCommits().some((commit) => commit.repo === FULL_NAME)).toBe(true);
  });

  it('still clears orphans outside the scope when nothing is preserved', async () => {
    const store = HandoverStore.inMemory();
    store.upsertCommit({
      sha: 'c'.repeat(40),
      repo: 'stale/repo',
      authorLogin: USERNAME,
      authoredAt: '2026-09-01T00:00:00Z',
      message: 'stale',
      additions: 1,
      deletions: 0,
      files: [{ path: 'src/x.ts', additions: 1, deletions: 0 }],
    });
    await collectInto(store, { commits: [] });
    expect(store.allCommits()).toHaveLength(0);
  });

  it('prunes commits that no longer exist upstream when the listing is complete', async () => {
    const shaA = 'a'.repeat(40);
    const shaB = 'b'.repeat(40);
    const listing = (shas: string[]): FakeData => ({
      commits: shas.map((sha, index) => ({
        sha,
        author: { login: USERNAME },
        commit: { author: { date: `2026-09-0${index + 1}T00:00:00Z` }, message: `work ${index}` },
      })),
    });
    const { store } = await collect(listing([shaA, shaB]));
    expect(store.allCommits()).toHaveLength(2);
    const second = await collectInto(store, listing([shaA]));
    expect(second.result.skippedCommits).toBe(1);
    expect(store.allCommits().map((commit) => commit.sha)).toEqual([shaA]);
  });

  it('never prunes from a --since-bounded (partial) listing', async () => {
    const shaA = 'a'.repeat(40);
    const shaB = 'b'.repeat(40);
    const listing = (shas: string[]): FakeData => ({
      commits: shas.map((sha, index) => ({
        sha,
        author: { login: USERNAME },
        commit: { author: { date: `2026-09-0${index + 1}T00:00:00Z` }, message: `work ${index}` },
      })),
    });
    const { store } = await collect(listing([shaA, shaB]));
    await collectInto(store, listing([shaA]), { since: '2030-01-01T00:00:00Z' });
    // the window only saw part of the history — older commits must survive
    expect(store.allCommits()).toHaveLength(2);
  });

  it('prunes PRs deleted upstream together with their children', async () => {
    const pr = (number: number, created: string): PullRequestListItem => ({
      number,
      title: `PR ${number}`,
      user: { login: USERNAME },
      state: 'closed',
      created_at: created,
      updated_at: created,
      merged_at: null,
      body: '',
      additions: 1,
      deletions: 1,
      changed_files: 1,
    });
    const data: FakeData = {
      commits: [],
      pullRequests: [pr(1, '2026-09-01T00:00:00Z'), pr(2, '2026-09-02T00:00:00Z')],
      reviews: [{ id: 55, user: { login: 'bob' }, state: 'COMMENTED', submitted_at: '2026-09-01T04:00:00Z', body: 'note' }],
      prFiles: { 1: [{ filename: 'payments/charge.ts' }], 2: [{ filename: 'ops/x.ts' }] },
      comments: {},
    };
    const { store } = await collect(data);
    expect(store.allPullRequests()).toHaveLength(2);

    const second = await collectInto(store, {
      commits: [],
      pullRequests: [pr(2, '2026-09-02T00:00:00Z')],
      reviews: [],
      prFiles: { 2: [{ filename: 'ops/x.ts' }] },
      comments: {},
    });
    expect(store.allPullRequests().map((entry) => entry.number)).toEqual([2]);
    expect(store.allPrFiles().get(`${FULL_NAME}#1`)).toBeUndefined();
    // the fake serves the same review list for every PR, so review 55 is
    // re-parented to PR 2 — what matters is that nothing references PR 1
    expect(store.allReviews().every((entry) => entry.prNumber !== 1)).toBe(true);
    const mirrored = store.allIssues().find((issue) => issue.number === 1);
    expect(mirrored).toBeUndefined();
    store.close();
  });
});

describe('collection scope normalization', () => {
  it('treats a mixed-case repo name as the same repo, not an orphan to wipe', async () => {
    const { store } = await collect({
      commits: [{ sha: 'a'.repeat(40), author: { login: USERNAME }, commit: { author: { date: '2026-09-01T00:00:00Z' }, message: 'first' } }],
    });
    expect(store.allCommits()).toHaveLength(1);

    // A later run passes the same repo with different casing — SQLite's NOT IN
    // is case-sensitive, so the unnormalized scope would wipe `acme/api` rows.
    const calls = { getCommit: 0 };
    const collector = new GitHubCollector('test-token', fakeOctokit({ commits: [] }, calls) as unknown as Octokit);
    await collector.collectInto(store, USERNAME, ['Acme/API'], {});
    expect(store.allCommits()).toHaveLength(1);
    expect(store.getMeta('repos')).toBe('acme/api');
    store.close();
  });

  it('sums PR additions/deletions from the file pages (pulls.list does not carry them)', async () => {
    const { store } = await collect({
      commits: [],
      pullRequests: [
        {
          number: 3,
          title: 'big change',
          user: { login: USERNAME },
          state: 'closed',
          created_at: '2026-09-01T00:00:00Z',
          updated_at: '2026-09-01T00:00:00Z',
        },
      ],
      prFiles: { 3: [{ filename: 'a.ts', additions: 30, deletions: 4 }, { filename: 'b.ts', additions: 12, deletions: 2 }] },
    });
    const pr = store.allPullRequests()[0];
    expect(pr?.additions).toBe(42);
    expect(pr?.deletions).toBe(6);
    expect(pr?.changedFiles).toBe(2);
    store.close();
  });

  it('records the collection source for the book front page', async () => {
    const { store } = await collect({ commits: [] });
    expect(store.getMeta('collected_via')).toBe('github');
    store.close();
  });
});
