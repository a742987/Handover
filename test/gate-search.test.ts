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
});
