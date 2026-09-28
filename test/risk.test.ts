import { describe, expect, it } from 'vitest';
import { HandoverStore } from '../src/store/sqlite.js';
import { computeRisk, moduleOf } from '../src/risk/engine.js';
import type { CommitRecord } from '../src/types.js';

const REPO = 'acme/api';
const NOW = new Date('2026-09-27T12:00:00Z');
const DAY = 86_400_000;

function isoDaysAgo(days: number): string {
  return new Date(NOW.getTime() - days * DAY).toISOString();
}

function commit(sha: string, author: string, at: string, path: string, message = `work ${sha}`): CommitRecord {
  return {
    sha,
    repo: REPO,
    authorLogin: author,
    authoredAt: at,
    message,
    additions: 1,
    deletions: 0,
    files: [{ path, additions: 1, deletions: 0 }],
  };
}

describe('moduleOf', () => {
  it('uses the top-level directory and marks root files', () => {
    expect(moduleOf('src/payments/charge.ts')).toBe('src');
    expect(moduleOf('README.md')).toBe('(root)');
  });
});

describe('computeRisk', () => {
  it('ranks the dominant, sole-reviewed, incident-prone module first with evidence', () => {
    const store = HandoverStore.inMemory();

    // payments: 8 commits by alice, 2 by bob, all recent, plus one more alice
    // commit below ("fix crash ... #101") → alice 9/11
    for (let i = 0; i < 8; i += 1) {
      store.upsertCommit(commit(`a${i}`.padEnd(40, '0'), 'alice', isoDaysAgo(1 + i), 'payments/charge.ts'));
    }
    for (let i = 0; i < 2; i += 1) {
      store.upsertCommit(commit(`b${i}`.padEnd(40, '0'), 'bob', isoDaysAgo(1 + i), 'payments/refund.ts'));
    }
    // docs: evenly shared
    for (let i = 0; i < 5; i += 1) {
      store.upsertCommit(commit(`d${i}`.padEnd(40, '0'), 'alice', isoDaysAgo(2 + i), 'docs/guide.md'));
      store.upsertCommit(commit(`e${i}`.padEnd(40, '0'), 'bob', isoDaysAgo(2 + i), 'docs/guide.md'));
    }
    // one alice payments commit references a bug-labelled issue
    store.upsertCommit(commit('f'.padEnd(40, '0'), 'alice', isoDaysAgo(1), 'payments/settle.ts', 'fix crash in settlement (#101)'));

    store.upsertPrFiles(REPO, 1, ['payments/charge.ts']);
    store.upsertReview({
      id: 11, repo: REPO, prNumber: 1, reviewerLogin: 'alice', state: 'APPROVED', submittedAt: isoDaysAgo(1), body: '', comments: [],
    });
    store.upsertPrFiles(REPO, 2, ['payments/refund.ts']);
    store.upsertReview({
      id: 12, repo: REPO, prNumber: 2, reviewerLogin: 'alice', state: 'APPROVED', submittedAt: isoDaysAgo(2), body: '', comments: [],
    });

    store.upsertIssue({
      repo: REPO,
      number: 101,
      title: 'Settlement crashes',
      authorLogin: 'bob',
      state: 'closed',
      createdAt: isoDaysAgo(30),
      closedAt: isoDaysAgo(1),
      labels: ['bug'],
      comments: [],
    });

    const risks = computeRisk(store, 'alice', { now: NOW, windowDays: 90, topN: 5 });

    expect(risks[0]?.module).toBe(`${REPO}:payments`);
    const top = risks[0]!;
    expect(top.factors.soleContributionRatio).toBeCloseTo(9 / 11, 5); // 9/11 payments commits by alice
    expect(top.factors.incidentWeight).toBeGreaterThan(1);
    expect(top.factors.irreplaceability).toBeGreaterThan(1.4); // sole reviewer: both reviews
    expect(top.score).toBeGreaterThan(
      risks.find((risk) => risk.module === `${REPO}:docs`)?.score ?? 0,
    );
    expect(top.evidence.some((ref) => ref.kind === 'commit' && ref.excerpt?.includes('#101'))).toBe(true);
    expect(top.evidence.some((ref) => ref.kind === 'review')).toBe(true);
    expect(top.rationale).toContain('#101');
    // every evidence item deep-links into the repo it came from
    for (const ref of top.evidence) {
      expect(ref.url).toMatch(new RegExp(`^https://github.com/${REPO}/`));
    }
  });

  it('attributes commits and reviews case-insensitively (GitHub logins are)', () => {
    const store = HandoverStore.inMemory();
    for (let i = 0; i < 4; i += 1) {
      // API returns the canonical case; callers pass the lowercase form
      store.upsertCommit(commit(`c${i}`.padEnd(40, '0'), 'Alice-CAN', isoDaysAgo(1 + i), 'payments/charge.ts'));
    }
    store.upsertPrFiles(REPO, 7, ['payments/charge.ts']);
    store.upsertReview({
      id: 21, repo: REPO, prNumber: 7, reviewerLogin: 'Alice-CAN', state: 'APPROVED', submittedAt: isoDaysAgo(1), body: '', comments: [],
    });
    const risks = computeRisk(store, 'alice-can', { now: NOW });
    expect(risks).toHaveLength(1);
    expect(risks[0]?.factors.soleContributionRatio).toBe(1);
    expect(risks[0]?.factors.irreplaceability).toBeGreaterThan(1);
  });

  it('omits GitHub deep links for modules from local-only repositories', () => {
    const store = HandoverStore.inMemory();
    for (let i = 0; i < 3; i += 1) {
      store.upsertCommit({ ...commit(`l${i}`.padEnd(40, '0'), 'alice', isoDaysAgo(1 + i), 'core/main.ts'), repo: 'myproject' });
    }
    const risks = computeRisk(store, 'alice', { now: NOW });
    expect(risks[0]?.module).toBe('myproject:core');
    expect(risks.length).toBe(1);
    for (const ref of risks[0]!.evidence) {
      expect(ref.url).toBeUndefined();
    }
  });

  it('falls back to lifetime activity when the repo has been quiet inside the window', () => {
    const store = HandoverStore.inMemory();
    for (let i = 0; i < 4; i += 1) {
      store.upsertCommit(commit(`p${i}`.padEnd(40, '0'), 'alice', isoDaysAgo(200), 'legacy/core.ts'));
    }
    const risks = computeRisk(store, 'alice', { now: NOW, windowDays: 90, topN: 5 });
    expect(risks[0]?.module).toBe(`${REPO}:legacy`);
    expect(risks[0]?.factors.changeFrequency).toBeGreaterThan(0);
  });

  it('ignores modules the person never touched', () => {
    const store = HandoverStore.inMemory();
    store.upsertCommit(commit('q'.padEnd(40, '0'), 'bob', isoDaysAgo(1), 'ops/runbook.md'));
    expect(computeRisk(store, 'alice', { now: NOW })).toHaveLength(0);
  });

  it('counts a multi-file commit within one module once, not per file', () => {
    const store = HandoverStore.inMemory();
    const multi = commit('m'.padEnd(40, '0'), 'alice', isoDaysAgo(1), 'payments/a.ts');
    store.upsertCommit({
      ...multi,
      files: [
        { path: 'payments/a.ts', additions: 1, deletions: 0 },
        { path: 'payments/b.ts', additions: 1, deletions: 0 },
        { path: 'docs/x.md', additions: 1, deletions: 0 },
      ],
    });
    const risks = computeRisk(store, 'alice', { now: NOW });
    const payments = risks.find((risk) => risk.module === `${REPO}:payments`);
    expect(payments?.factors.soleContributionRatio).toBe(1);
    expect(payments?.factors.changeFrequency).toBe(1); // one commit, not two files' worth
  });
});

describe('unattributed commits', () => {
  it('never counts the "unknown" sentinel as the subject — even for a user named unknown', () => {
    const store = HandoverStore.inMemory();
    store.upsertCommit(commit('a'.repeat(40), 'unknown', isoDaysAgo(10), 'payments/charge.ts'));
    // with the sentinel folding into isUser, the ratio would exceed 1 and the
    // module would rank as sole-owned by nobody
    expect(computeRisk(store, 'unknown', { now: NOW })).toHaveLength(0);
  });
});
