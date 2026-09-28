import { describe, expect, it } from 'vitest';
import { renderBookHtml } from '../src/render/html.js';
import { renderBook } from '../src/render/markdown.js';
import type { HandoverBook } from '../src/types.js';

function sampleBook(): HandoverBook {
  return {
    username: 'alice',
    repos: ['acme/api'],
    generatedAt: '2026-09-20T00:00:00Z',
    chapters: [
      {
        id: 3,
        title: 'Risk Top 5',
        content: 'Scored module [a1b2c3d](https://github.com/acme/api/commit/a1b2c3d).',
        evidence: [{ kind: 'commit', ref: 'a1b2c3d', url: 'https://github.com/acme/api/commit/a1b2c3d', excerpt: 'settle' }],
        generatedBy: 'deterministic',
      },
    ],
  };
}

describe('renderBookHtml', () => {
  it('produces a single self-contained document with the rendered markdown', () => {
    const html = renderBookHtml(sampleBook(), renderBook(sampleBook()));
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('<title>Handover Book — alice</title>');
    expect(html).toContain('<h1>');
    expect(html).toContain('<style>');
    // the evidence appendix table survives the conversion
    expect(html).toContain('<table>');
    expect(html).toContain('commit');
  });

  it('opens external links safely in a new tab', () => {
    const html = renderBookHtml(sampleBook(), renderBook(sampleBook()));
    expect(html).toContain('target="_blank" rel="noopener noreferrer" href="https://github.com/acme/api/commit/a1b2c3d"');
  });

  it('escapes metacharacters in the page title', () => {
    const html = renderBookHtml({ ...sampleBook(), username: 'a&<b' } as HandoverBook, '# x');
    expect(html).toContain('<title>Handover Book — a&amp;&lt;b</title>');
  });
});
