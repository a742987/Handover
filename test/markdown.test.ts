import { describe, expect, it } from 'vitest';
import { renderBook } from '../src/render/markdown.js';
import { CHAPTER_TITLES } from '../src/distill/synthesize.js';
import type { BookChapter, BookCoverage, HandoverBook } from '../src/types.js';

function chapter(id: BookChapter['id'], content: string): BookChapter {
  return { id, title: CHAPTER_TITLES[id], content, evidence: [], generatedBy: 'deterministic' };
}

const book: HandoverBook = {
  username: 'alice',
  repos: ['acme/api'],
  generatedAt: '2026-09-27T12:00:00Z',
  chapters: [
    chapter(1, '@alice touched 2 modules.'),
    chapter(3, 'See the table below.'),
    {
      id: 4,
      title: CHAPTER_TITLES[4],
      content: 'Settlement moved to T+1 [abc1234]. (inference) Alice preferred Sundays.',
      evidence: [{ kind: 'commit', ref: 'abc1234', excerpt: 'fix crash in settlement (#101)' }],
      generatedBy: 'llm',
    },
  ],
};

describe('renderBook', () => {
  it('renders a title page, ethics note, contents and chapters', () => {
    const markdown = renderBook(book);
    expect(markdown).toContain('# Handover Book — @alice');
    expect(markdown).toContain('a gift for the successor');
    expect(markdown).toContain('## Contents');
    expect(markdown).toContain('## 1. Code Panorama');
    expect(markdown).toContain('## 3. Risk Top 5');
    expect(markdown).toContain('*(deterministic)*');
  });

  it('includes the evidence register appendix', () => {
    const markdown = renderBook(book);
    expect(markdown).toContain('## Appendix — evidence register');
    expect(markdown).toContain('`abc1234`');
    expect(markdown).toContain('fix crash in settlement (#101)');
  });

  it('renders evidence URLs as links and escapes pipes in excerpts', () => {
    const withLinks: HandoverBook = {
      ...book,
      chapters: [
        {
          id: 4,
          title: CHAPTER_TITLES[4],
          content: 'Settlement moved to T+1 [abc1234].',
          evidence: [
            { kind: 'commit', ref: 'abc1234', url: 'https://github.com/acme/api/commit/abc1234', excerpt: 'fix | crash' },
            { kind: 'issue', ref: '#101', excerpt: 'plain excerpt' },
          ],
          generatedBy: 'llm',
        },
      ],
    };
    const markdown = renderBook(withLinks);
    expect(markdown).toContain('[`abc1234`](https://github.com/acme/api/commit/abc1234)');
    expect(markdown).toContain('`#101`'); // no URL → plain code span
    expect(markdown).toContain('fix \\| crash');
  });

  it('lists all six chapter titles in order', () => {
    expect(CHAPTER_TITLES[1]).toBe('Code Panorama');
    expect(CHAPTER_TITLES[2]).toBe('Implicit Knowledge Inventory');
    expect(CHAPTER_TITLES[3]).toBe('Risk Top 5');
    expect(CHAPTER_TITLES[4]).toBe('Decision Archaeology');
    expect(CHAPTER_TITLES[5]).toBe('The 30-Day Path');
    expect(CHAPTER_TITLES[6]).toBe('Questions & Draft Answers');
  });

  it('discloses the LLM provider when any chapter was LLM-synthesized', () => {
    const markdown = renderBook({ ...book, llmProvider: 'anthropic', llmModel: 'claude-sonnet-4-5' });
    expect(markdown).toContain('repository content was sent');
    expect(markdown).toContain('anthropic (claude-sonnet-4-5)');
    expect(markdown).not.toContain('nothing was uploaded anywhere');
  });

  it('keeps the local-only note for deterministic-only books', () => {
    const deterministic: HandoverBook = {
      ...book,
      chapters: book.chapters.map((chapter) => ({ ...chapter, generatedBy: 'deterministic' })),
    };
    const markdown = renderBook(deterministic);
    expect(markdown).toContain('nothing was uploaded anywhere');
  });

  it('renders the action page with coverage, gaps and confirm-before-handover items', () => {
    const coverage: BookCoverage = {
      repos: ['acme/api'],
      sources: ['GitHub API (commits, PRs, reviews, issues)'],
      commitWindow: { from: '2026-01-05T00:00:00Z', to: '2026-09-01T00:00:00Z' },
      counts: { commits: 12, pullRequests: 3, reviews: 4, issues: 2, comments: 9, capturedAnswers: 0 },
      contributors: 2,
      unattributedCommits: 1,
      gaps: ['No first-person answers recorded yet — run `handover capture` with the departing engineer before they leave.'],
    };
    const withActionPage: HandoverBook = {
      ...book,
      coverage,
      actions: [
        {
          module: 'acme/api:payments/',
          finding: '@alice authored 12/12 commits (100%) touching acme/api:payments/.',
          question: 'Has anyone besides @alice shipped, deployed or rolled back `acme/api:payments/` — and if not, what was never written down?',
          confirmWith: '@alice (the departing engineer)',
          nextStep: 'Have the successor read and run `acme/api:payments/`, then walk this item with @alice and record the answer with `handover capture`.',
          limitation: 'Commit and review counts show authorship, not knowledge.',
          evidence: [{ kind: 'commit', ref: 'abc1234', url: 'https://github.com/acme/api/commit/abc1234', repo: 'acme/api' }],
        },
      ],
    };
    const markdown = renderBook(withActionPage);
    expect(markdown).toContain('## Action summary — read this first');
    expect(markdown).toContain('### What this analysis covers');
    expect(markdown).toContain('**Commit window:** 2026-01-05 → 2026-09-01');
    expect(markdown).toContain('### Known gaps');
    expect(markdown).toContain('### Confirm before the handover (top 1)');
    expect(markdown).toContain('**Confirm with @alice (the departing engineer):**');
    expect(markdown).toContain('### How to read the labels');
    expect(markdown).toContain('not a measure of a person');
    // the action page comes before the contents and the chapters
    expect(markdown.indexOf('## Action summary')).toBeLessThan(markdown.indexOf('## Contents'));
  });

  it('qualifies numeric evidence refs with the repo prefix when the book spans several repos', () => {
    const multiRepoBook: HandoverBook = {
      ...book,
      repos: ['acme/api', 'acme/web'],
      chapters: [
        {
          id: 3,
          title: CHAPTER_TITLES[3],
          content: 'Evidence: [acme/api#101] [acme/api#7 review:42]',
          evidence: [
            { kind: 'issue', ref: '#101', repo: 'acme/api', url: 'https://github.com/acme/api/issues/101' },
            { kind: 'review', ref: '#7 review:42', repo: 'acme/api' },
          ],
          generatedBy: 'deterministic',
        },
      ],
    };
    const markdown = renderBook(multiRepoBook);
    expect(markdown).toContain('[`acme/api#101`](https://github.com/acme/api/issues/101)');
    expect(markdown).toContain('`acme/api#7 review:42`');
    expect(markdown).not.toContain('`#101`'); // ambiguous bare ref must not leak into a multi-repo book
  });
});
