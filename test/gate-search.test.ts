import { describe, expect, it } from 'vitest';
import { matchTouchedModules, renderGateComment } from '../src/risk/gate.js';
import { searchIndex } from '../src/search.js';
import { HandoverStore } from '../src/store/sqlite.js';
import type { RiskItem } from '../src/types.js';

function risk(module: string, score = 0.5): RiskItem {
  return {
    rank: 1,
    module,
    score,
    factors: { soleContributionRatio: 1, changeFrequency: 1, incidentWeight: 1, irreplaceability: 1 },
    evidence: [{ kind: 'commit', ref: 'a1b2c3d', url: `https://github.com/acme/api/commit/${'a'.repeat(40)}`, excerpt: 'settle' }],
    rationale: 'because',
  };
}

describe('matchTouchedModules', () => {
  const risks = [risk('acme/api:payments'), risk('acme/api:ops')];

  it('matches changed paths by their top-level module', () => {
    const matches = matchTouchedModules(risks, ['payments/charge.ts', 'README.md']);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.module).toBe('acme/api:payments');
  });

  it('tolerates blank lines and reports nothing when all paths are safe', () => {
    expect(matchTouchedModules(risks, ['', '  ', 'src/app.ts'])).toEqual([]);
  });

  it('renders a comment naming every risky module and its evidence', () => {
    const comment = renderGateComment(matchTouchedModules(risks, ['ops/runbook.md']), 'alice');
    expect(comment).toContain('acme/api:ops');
    expect(comment).toContain('a1b2c3d');
    expect(renderGateComment([], 'alice')).toContain('does not touch');
  });

  it('restricts matching to one repository when the index holds several', () => {
    const multi = [risk('acme/api:payments'), risk('acme/web:payments')];
    const all = matchTouchedModules(multi, ['payments/x.ts']).map((match) => match.module);
    expect(all).toEqual(['acme/api:payments', 'acme/web:payments']);
    const scoped = matchTouchedModules(multi, ['payments/x.ts'], 'acme/web').map((match) => match.module);
    expect(scoped).toEqual(['acme/web:payments']);
  });
});

describe('searchIndex', () => {
  function seedStore(): HandoverStore {
    const s = HandoverStore.inMemory();
    s.upsertCommit({
      sha: 'c'.repeat(40),
      repo: 'acme/api',
      authorLogin: 'alice',
      authoredAt: '2026-09-05T00:00:00Z',
      message: 'tune the queue consumer batch size',
      additions: 1,
      deletions: 0,
      files: [{ path: 'queue/consume.ts', additions: 1, deletions: 0 }],
    });
    s.upsertPullRequest({
      repo: 'acme/api',
      number: 9,
      title: 'Queue redesign',
      authorLogin: 'alice',
      state: 'closed',
      createdAt: '2026-09-06T00:00:00Z',
      mergedAt: null,
      body: 'We batch by size, not by timeout.',
      additions: 10,
      deletions: 2,
      changedFiles: 1,
    });
    s.upsertIssue({
      repo: 'acme/api',
      number: 12,
      title: 'Queue backlog after deploys',
      authorLogin: 'bob',
      state: 'open',
      createdAt: '2026-09-07T00:00:00Z',
      closedAt: null,
      labels: [],
      comments: [{ id: 77, number: 12, authorLogin: 'alice', createdAt: '2026-09-08T00:00:00Z', body: 'known quirk: the consumer stalls on shutdown' }],
      isPullRequest: false,
    });
    // mirrored PR conversation (as the collector writes it)
    s.upsertIssue({
      repo: 'acme/api',
      number: 9,
      title: 'Queue redesign',
      authorLogin: 'alice',
      state: 'closed',
      createdAt: '2026-09-06T00:00:00Z',
      closedAt: null,
      labels: [],
      comments: [],
      isPullRequest: true,
    });
    // an inline, per-path review comment (the most substantive review text)
    s.upsertReview({
      id: 900,
      repo: 'acme/api',
      prNumber: 9,
      reviewerLogin: 'carol',
      state: 'COMMENTED',
      submittedAt: '2026-09-01T00:00:00Z',
      body: '',
      comments: [{ id: 901, reviewId: 900, path: 'queue/consume.ts', body: 'the queue consumer needs a poison-pill guard', authorLogin: 'carol' }],
    });
    return s;
  }

  const store = seedStore();

  it('finds evidence across record types with newest first', () => {
    const { count, results } = searchIndex(store, { query: 'queue' });
    expect(count).toBeGreaterThan(0);
    expect(results[0]?.kind).toBe('issue'); // issue #12 is the newest match
    expect(results[0]?.ref).toBe('#12');
    const kinds = new Set(results.map((item) => item.kind));
    expect(kinds.has('commit')).toBe(true);
    expect(kinds.has('pr')).toBe(true);
    expect(kinds.has('issue')).toBe(true);
  });

  it('filters by kind, author, since and repo', () => {
    expect(searchIndex(store, { kind: 'commit', query: 'queue' }).results.every((r) => r.kind === 'commit')).toBe(true);
    expect(searchIndex(store, { query: 'shutdown', author: 'alice' }).count).toBe(1);
    expect(searchIndex(store, { query: 'shutdown', author: 'carol' }).count).toBe(0);
    expect(searchIndex(store, { kind: 'issue', since: '2026-09-07T00:00:01Z' }).count).toBe(0);
    expect(searchIndex(store, { query: 'queue', repo: 'other/repo' }).count).toBe(0);
    expect(searchIndex(store, { query: 'queue', repo: 'acme/api' }).count).toBeGreaterThan(0);
  });

  it('deduplicates the PR mirrored into the issue namespace', () => {
    const prs = searchIndex(store, { kind: 'all', query: 'Queue redesign' }).results.filter((r) => r.kind === 'pr');
    expect(prs).toHaveLength(1);
  });

  it('limits results', () => {
    expect(searchIndex(store, { query: 'queue', limit: 2 }).results).toHaveLength(2);
  });

  it('searches inline review comments too', () => {
    const { results } = searchIndex(store, { query: 'poison-pill', kind: 'comment' });
    expect(results).toHaveLength(1);
    expect(results[0]?.ref).toContain('review:900');
    expect(results[0]?.ref).toContain('comment:901');
    expect(results[0]?.author).toBe('carol');
  });

  it('matches a repo basename but never across owners', () => {
    expect(searchIndex(store, { query: 'queue', repo: 'api' }).count).toBeGreaterThan(0);
    expect(searchIndex(store, { query: 'queue', repo: 'evil/api' }).count).toBe(0);
  });

  it('excludes undated records from a since-restricted query', () => {
    // a pending review carries submittedAt = null — it cannot prove it is in-window
    const undated = HandoverStore.inMemory();
    undated.upsertCommit({
      sha: 'd'.repeat(40),
      repo: 'acme/api',
      authorLogin: 'alice',
      authoredAt: '',
      message: 'date unknown',
      additions: 1,
      deletions: 0,
      files: [{ path: 'queue/consume.ts', additions: 1, deletions: 0 }],
    });
    undated.upsertReview({
      id: 901,
      repo: 'acme/api',
      prNumber: 9,
      reviewerLogin: 'carol',
      state: 'PENDING',
      submittedAt: null,
      body: 'pending review text',
      comments: [],
    });
    expect(searchIndex(undated, { since: '2020-01-01T00:00:00Z' }).count).toBe(0);
    // without the since filter the same records are searchable
    expect(searchIndex(undated, { query: 'pending review' }).count).toBe(1);
    undated.close();
  });

  it('compares since by timestamp, not by string', () => {
    // indexed dates carry no milliseconds ("…:00Z") while a since value
    // normalizes to "…:00.000Z"; lexicographically "Z" > ".", so a record at
    // exactly the boundary used to slip *into* a window that starts after it
    expect(searchIndex(store, { kind: 'issue', since: '2026-09-07T00:00:00.500Z' }).count).toBe(0);
    expect(searchIndex(store, { kind: 'issue', since: '2026-09-07T00:00:00Z' }).count).toBe(1);
  });
});

describe('renderGateComment — the comment a bot posts into someone else\u2019s pull request', () => {
  const tick = String.fromCharCode(96);

  /**
   * The module name is a top-level directory from the pull request and the ref
   * is collected history, so both are attacker-editable. They used to be
   * emitted inside a single-backtick span, where one backtick in a directory
   * name closed the span and the remainder rendered as the gate bot's own
   * message — text reviewers are trained to trust.
   */
  it('cannot be broken out of by a backtick in a module name', () => {
    const module = `payments${tick} @everyone **approve this PR**`;
    const comment = renderGateComment(
      [{ module, score: 0.5, rationale: 'r', evidence: [] }],
      'alice',
    );
    // the code span must have widened itself rather than been closed early
    expect(comment).toContain(`\`\`${module}\`\``);
    // and nothing from the module name may survive outside a code span
    const outsideSpans = comment.replace(/``[^`]*``/g, '').replace(/`[^`]*`/g, '');
    expect(outsideSpans).not.toContain('@everyone');
    expect(outsideSpans).not.toContain('approve this PR');
  });

  it('escapes the evidence ref the same way', () => {
    const comment = renderGateComment(
      [{ module: 'payments', score: 0.5, rationale: 'r', evidence: [{ kind: 'pr' as const, ref: `#1${tick}x${tick}` }] }],
      'alice',
    );
    const outsideSpans = comment.replace(/``[^`]*``/g, '').replace(/`[^`]*`/g, '');
    expect(outsideSpans).not.toContain('x');
  });

  it('only ever links to https github.com, and drops anything else', () => {
    const comment = renderGateComment(
      [
        {
          module: 'payments',
          score: 0.5,
          rationale: 'r',
          evidence: [
            { kind: 'pr' as const, ref: '#1', url: 'javascript:alert(1)' },
            { kind: 'commit' as const, ref: 'abc1234', url: 'https://evil.test/phish' },
            { kind: 'pr' as const, ref: '#2', url: 'https://github.com/acme/api/pull/2' },
          ],
        },
      ],
      'alice',
    );
    expect(comment).not.toContain('javascript:');
    expect(comment).not.toContain('evil.test');
    expect(comment).toContain('https://github.com/acme/api/pull/2');
  });
});
