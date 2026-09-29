import { describe, expect, it } from 'vitest';
import { HandoverStore } from '../src/store/sqlite.js';
import { buildDigest, synthesizeChapters, CHAPTER_TITLES } from '../src/distill/synthesize.js';
import { computeRisk } from '../src/risk/engine.js';
import type { CommitRecord } from '../src/types.js';

const REPO = 'acme/api';
const USERNAME = 'alice';
// Fixed clock after every seeded commit — without it computeRisk's 90-day
// window slides past the seeds and the assertions silently drift.
const NOW = new Date('2026-09-10T00:00:00Z');

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
    const risks = computeRisk(store, USERNAME, { now: NOW });
    const digest = buildDigest({ username: USERNAME, repos: [REPO], store, risks });
    expect(digest).toContain(`## Module statistics`);
    expect(digest).toContain(`${REPO}:payments`);
    expect(digest).toContain('Switch settlement to idempotent retries');
    expect(digest).toContain('## Risk Top 5');
  });

  it('truncates to the character budget with an explanatory note', () => {
    const store = seedStore();
    const risks = computeRisk(store, USERNAME, { now: NOW });
    const digest = buildDigest({ username: USERNAME, repos: [REPO], store, risks }, 500);
    expect(digest.length).toBeLessThanOrEqual(500 + 200); // budget plus the truncation note
    expect(digest).toContain('digest truncated at 500 characters');
  });

  it('HTML-escapes repository content so markup cannot reach the LLM verbatim', () => {
    const store = seedStore();
    store.upsertPullRequest({
      repo: REPO,
      number: 2,
      title: '<img src=x onerror=alert(1)>',
      authorLogin: USERNAME,
      state: 'open',
      createdAt: '2026-09-03T00:00:00Z',
      mergedAt: null,
      body: 'see <script>alert(1)</script>',
      additions: 1,
      deletions: 0,
      changedFiles: 1,
    });
    const risks = computeRisk(store, USERNAME, { now: NOW });
    const digest = buildDigest({ username: USERNAME, repos: [REPO], store, risks });
    expect(digest).not.toContain('<img');
    expect(digest).not.toContain('<script>');
    expect(digest).toContain('&lt;img');
  });
});

describe('synthesizeChapters (no provider)', () => {
  it('produces all six chapters in order, deterministic for 1-3 and fallbacks for 4-6', async () => {
    const store = seedStore();
    const risks = computeRisk(store, USERNAME, { now: NOW });
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

describe('synthesizeChapters (with provider)', () => {
  const chapterText =
    '### Determined\n\nThe retry key must stay stable [a000000], argued in [#1], with ample content to pass the minimum length gate.';

  it('wraps the digest in nonce-delimited untrusted blocks before the Task instruction', async () => {
    const store = seedStore();
    const risks = computeRisk(store, USERNAME, { now: NOW });
    const seen: Array<{ system: string; user: string }> = [];
    const provider = {
      name: 'anthropic' as const,
      model: 'test',
      complete: async (system: string, user: string) => {
        seen.push({ system, user });
        return chapterText;
      },
    };
    const chapters = await synthesizeChapters(
      { username: USERNAME, repos: [REPO], store, risks, onProgress: () => {} },
      provider,
    );
    expect(chapters[3]!.generatedBy).toBe('llm');
    expect(seen).toHaveLength(3); // chapters 4-6
    for (const { system, user } of seen) {
      const open = /<untrusted-evidence-([0-9a-f]+)>/.exec(user);
      expect(open).not.toBeNull();
      expect(user).toContain(`</untrusted-evidence-${open![1]}>`);
      // evidence first, instruction last — the digest cannot forge a Task line
      // ahead of the real one without the wrapper making that visible
      expect(user.indexOf('<untrusted-evidence-')).toBeLessThan(user.lastIndexOf('Task: '));
      expect(system).toContain('untrusted');
    }
  });
});

describe('module-name injection', () => {
  it('renders a module name containing backticks and markup as an inert code span', async () => {
    const { marked } = await import('marked');
    const store = HandoverStore.inMemory();
    store.upsertCommit(commit('e'.padEnd(40, '0'), USERNAME, '2026-09-01T00:00:00Z', 'evil`<img src=x onerror=alert(1)>`b/file.ts'));
    store.setMeta('repos', REPO);
    const risks = computeRisk(store, USERNAME, { now: NOW });
    const chapters = await synthesizeChapters({ username: USERNAME, repos: [REPO], store, risks }, null);
    const risksChapter = chapters.find((chapter) => chapter.id === 3)!;
    // the raw module text survives as evidence text, but fenced so marked escapes it
    expect(risksChapter.content).toContain('``acme/api:evil`');
    const html = marked.parse(risksChapter.content, { async: false }) as string;
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
    store.close();
  });
});
