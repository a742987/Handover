import { describe, expect, it } from 'vitest';
import { HandoverStore } from '../src/store/sqlite.js';
import { buildDigest, synthesizeChapters, CHAPTER_TITLES } from '../src/distill/synthesize.js';
import { computeRisk } from '../src/risk/engine.js';
import type { CommitRecord } from '../src/types.js';

const REPO = 'acme/api';
const USERNAME = 'alice';

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

function seedStore(): HandoverStore {
  const store = HandoverStore.inMemory();
  // 9 of 10 payments commits are alice's (ratio 0.9 → dominant-author territory)
  for (let i = 0; i < 9; i += 1) {
    store.upsertCommit(commit(`a${i}`.padEnd(40, '0'), USERNAME, `2026-09-0${(i % 9) + 1}T00:00:00Z`, 'payments/charge.ts'));
  }
  store.upsertCommit(commit('f'.padEnd(40, '0'), 'bob', '2026-09-01T00:00:00Z', 'payments/refund.ts'));
  store.upsertPullRequest({
    repo: REPO,
    number: 1,
    title: 'Switch settlement to idempotent retries',
    authorLogin: USERNAME,
    state: 'closed',
    createdAt: '2026-09-01T00:00:00Z',
    mergedAt: '2026-09-02T00:00:00Z',
    body: 'We retry with the same key so a double-charge is impossible.',
    additions: 100,
    deletions: 40,
    changedFiles: 3,
  });
  store.setMeta('repos', REPO);
  return store;
}

describe('buildDigest', () => {
  it('contains module stats, PRs, reviews, comments and the risk ranking', () => {
    const store = seedStore();
    const risks = computeRisk(store, USERNAME);
    const digest = buildDigest({ username: USERNAME, repos: [REPO], store, risks });
    expect(digest).toContain(`## Module statistics`);
    expect(digest).toContain(`${REPO}:payments`);
    expect(digest).toContain('Switch settlement to idempotent retries');
    expect(digest).toContain('## Risk Top 5');
  });

  it('truncates to the character budget with an explanatory note', () => {
    const store = seedStore();
    const risks = computeRisk(store, USERNAME);
    const digest = buildDigest({ username: USERNAME, repos: [REPO], store, risks }, 500);
    expect(digest.length).toBeLessThanOrEqual(500 + 200); // budget plus the truncation note
    expect(digest).toContain('digest truncated at 500 characters');
  });
});

describe('synthesizeChapters (no provider)', () => {
  it('produces all six chapters in order, deterministic for 1-3 and fallbacks for 4-6', async () => {
    const store = seedStore();
    const risks = computeRisk(store, USERNAME);
    const chapters = await synthesizeChapters(
      {
        username: USERNAME,
        repos: [REPO],
        store,
        risks,
        onProgress: () => {},
      },
      null,
    );

    expect(chapters.map((chapter) => chapter.id)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(chapters.every((chapter) => chapter.title === CHAPTER_TITLES[chapter.id])).toBe(true);
    expect(chapters.slice(0, 3).every((chapter) => chapter.generatedBy === 'deterministic')).toBe(true);
    expect(chapters.slice(3).every((chapter) => chapter.generatedBy === 'deterministic')).toBe(true);

    // chapter 1: module table includes the touched module
    expect(chapters[0]!.content).toContain('payments');
    // chapter 2: flags the sole-author concentration
    expect(chapters[1]!.content).toContain('Sole or dominant author');
    // chapter 3: lists the risk items with the scoring formula
    expect(chapters[2]!.content).toContain('sole_contribution_ratio');
    // chapter 4 fallback: lists the PR rationale instead of a narrative
    expect(chapters[3]!.content).toContain('Switch settlement to idempotent retries');
    // chapter 5 fallback: a week-by-week plan referencing the risk module
    expect(chapters[4]!.content).toContain('Week 1');
    // chapter 6 fallback: the questions to capture before the last day
    expect(chapters[5]!.content).toContain('(answer to be captured)');
  });

  it('says so when no risk items exist', async () => {
    const store = HandoverStore.inMemory();
    const chapters = await synthesizeChapters(
      { username: USERNAME, repos: [REPO], store, risks: [], onProgress: () => {} },
      null,
    );
    expect(chapters[2]!.content).toContain('No risk items');
  });
});
