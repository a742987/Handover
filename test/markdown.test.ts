import { describe, expect, it } from 'vitest';
import { renderBook } from '../src/render/markdown.js';
import { CHAPTER_TITLES } from '../src/distill/synthesize.js';
import type { BookChapter, HandoverBook } from '../src/types.js';

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
    expect(CHAPTER_TITLES[6]).toBe('Letter to the Future');
  });
});
