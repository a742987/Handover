import { describe, expect, it } from 'vitest';
import { HandoverStore } from '../src/store/sqlite.js';
import { parseCodeowners, ownersFor } from '../src/collect/codeowners.js';
import { computeBusFactor } from '../src/risk/busfactor.js';
import { codeownersMetaKey } from '../src/collect/codeowners.js';
import type { CommitRecord } from '../src/types.js';

const REPO = 'acme/api';
const NOW = new Date('2026-09-27T12:00:00Z');
const DAY = 86_400_000;

describe('parseCodeowners / ownersFor', () => {
  const rules = parseCodeowners(`
# team map
*                 @acme/platform
/docs/            @tech-writers
/payments/        @alice @bob
*.md              @docs-team
legacy/**         @carol
`);

  it('skips comments and ownerless lines', () => {
    expect(rules.every((rule) => rule.owners.length > 0)).toBe(true);
    expect(rules).toHaveLength(5);
  });

  it('applies last-match-wins precedence', () => {
    // docs/README.md matches * and /docs/ and *.md — the latest wins
    expect(ownersFor(rules, 'docs/README.md')).toEqual(['@docs-team']);
    expect(ownersFor(rules, 'payments/settle.ts')).toEqual(['@alice', '@bob']);
    expect(ownersFor(rules, 'legacy/db.sql')).toEqual(['@carol']);
  });

  it('root-anchors leading slashes and matches basenames at any depth', () => {
    expect(ownersFor(rules, 'payments/deep/settle.ts')).toEqual(['@alice', '@bob']);
    expect(ownersFor(rules, 'services/legacy/old.txt')).toEqual(['@acme/platform']);
    expect(ownersFor(rules, 'anything.txt')).toEqual(['@acme/platform']);
  });

  it('returns nothing when no rule matches', () => {
    expect(ownersFor(parseCodeowners('/only-deep/** @x'), 'top.ts')).toEqual([]);
  });
});

function commit(sha: string, author: string, path: string): CommitRecord {
  return {
    sha,
    repo: REPO,
    authorLogin: author,
    authoredAt: new Date(NOW.getTime() - DAY).toISOString(),
    message: `work ${sha}`,
    additions: 1,
    deletions: 0,
    files: [{ path, additions: 1, deletions: 0 }],
  };
}

describe('computeBusFactor', () => {
  it('ranks critical modules first, then fragile, with owners from CODEOWNERS', () => {
    const store = HandoverStore.inMemory();
    // payments: alice sole author (critical)
    for (let i = 0; i < 4; i += 1) {
      store.upsertCommit(commit(`p${i}`.padEnd(40, '0'), 'alice', 'payments/charge.ts'));
    }
    // docs: alice 7, bob 3 → 70% top share with two authors (fragile)
    for (let i = 0; i < 7; i += 1) {
      store.upsertCommit(commit(`d${i}`.padEnd(40, '0'), 'alice', 'docs/guide.md'));
    }
    for (let i = 0; i < 3; i += 1) {
      store.upsertCommit(commit(`e${i}`.padEnd(40, '0'), 'bob', 'docs/guide.md'));
    }
    // ops: three authors (shared)
    store.upsertCommit(commit('o1'.padEnd(40, '0'), 'alice', 'ops/runbook.md'));
    store.upsertCommit(commit('o2'.padEnd(40, '0'), 'bob', 'ops/runbook.md'));
    store.upsertCommit(commit('o3'.padEnd(40, '0'), 'carol', 'ops/runbook.md'));
    store.setMeta(codeownersMetaKey(REPO), '/payments/ @alice @bob\nops/ @sre\n');

    const items = computeBusFactor(store, { now: NOW });
    expect(items.map((item) => item.status)).toEqual(['critical', 'fragile', 'shared']);
    expect(items[0]?.module).toBe(`${REPO}:payments`);
    expect(items[0]?.distinctAuthors).toBe(1);
    expect(items[0]?.owners).toEqual(['@alice', '@bob']);
    expect(items[1]?.topAuthor).toBe('alice');
    expect(items[1]?.topAuthorShare).toBeCloseTo(0.7, 5);
    expect(items[2]?.distinctAuthors).toBe(3);
    expect(items[2]?.owners).toEqual(['@sre']);
    expect(items[0]?.recent).toBe(true);
  });

  it('marks modules quiet outside the window', () => {
    const store = HandoverStore.inMemory();
    store.upsertCommit({
      ...commit('q'.padEnd(40, '0'), 'alice', 'legacy/core.ts'),
      authoredAt: new Date(NOW.getTime() - 200 * DAY).toISOString(),
    });
    const items = computeBusFactor(store, { now: NOW });
    expect(items[0]?.recent).toBe(false);
  });

  it('ignores unattributed commits', () => {
    const store = HandoverStore.inMemory();
    store.upsertCommit(commit('u'.padEnd(40, '0'), 'unknown', 'x/y.ts'));
    expect(computeBusFactor(store, { now: NOW })).toHaveLength(0);
  });
});
