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

  it('escapes HTML-significant characters in evidence excerpts at the markdown layer', () => {
    const book = sampleBook();
    book.chapters[0]!.evidence[0]!.excerpt = '<img src=x onerror=alert(1)>y';
    const markdown = renderBook(book);
    expect(markdown).not.toContain('<img');
    const html = renderBookHtml(book, markdown);
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('strips event handlers and dangerous elements injected via chapter content', () => {
    const book = sampleBook();
    book.chapters[0]!.content = 'hello <script>alert(1)</script> world <img src="x" onerror="alert(1)">';
    const html = renderBookHtml(book, renderBook(book));
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onerror');
    expect(html).toContain('<img src="x">');
  });

  it('neutralizes javascript: links, including entity-encoded ones', () => {
    const book = sampleBook();
    book.chapters[0]!.content = '[click](javascript:alert(1)) [ent](&#106;avascript:alert(1))';
    const html = renderBookHtml(book, renderBook(book));
    const lowered = html.toLowerCase();
    expect(lowered).not.toContain('javascript:');
    expect(lowered).not.toContain('&#106;avascript');
  });

  it('neutralizes HTML5-named-entity scheme smuggling (javascript&colon;)', () => {
    const book = sampleBook();
    book.chapters[0]!.content = '[c](javascript&colon;alert(1)) and <a href="javascript&colon;alert(1)">raw</a>';
    const html = renderBookHtml(book, renderBook(book));
    const lowered = html.toLowerCase();
    expect(lowered).not.toContain('&colon;');
    expect(lowered).not.toContain('javascript:');
  });

  it('strips entity-encoded whitespace hidden inside the scheme word', () => {
    const book = sampleBook();
    book.chapters[0]!.content = '[nl](jav&#x0A;ascript:alert(1)) [tab](jav&#x09;ascript:alert(1))';
    const html = renderBookHtml(book, renderBook(book));
    const lowered = html.toLowerCase();
    expect(lowered).not.toContain('&#x0a;');
    expect(lowered).not.toContain('&#x09;');
    expect(lowered).not.toContain('avascript:alert');
  });

  it('clamps out-of-range numeric character references instead of crashing', () => {
    const book = sampleBook();
    book.chapters[0]!.content = '[big](&#x110000;next)';
    expect(() => renderBookHtml(book, renderBook(book))).not.toThrow();
    expect(renderBookHtml(book, renderBook(book))).toContain('big');
  });

  it('drops SVG animate elements that could animate a href into a scheme', () => {
    const book = sampleBook();
    book.chapters[0]!.content = '<svg><a id="x"><animate attributeName="href" values="javascript:alert(1)"/></a></svg>';
    const html = renderBookHtml(book, renderBook(book));
    const lowered = html.toLowerCase();
    expect(lowered).not.toContain('<animate');
    expect(lowered).not.toContain('javascript:');
  });

  it('keeps the rest of the book when chapter content carries a malformed script tag', () => {
    const book = sampleBook();
    book.chapters[0]!.content = 'evil <script >alert(1)</script > tail';
    const html = renderBookHtml(book, renderBook(book));
    expect(html).not.toContain('<script');
    // the appendix after the poisoned chapter must survive the round-trip
    expect(html).toContain('Appendix — evidence register');
  });

  it('lets safe schemes and relative links through untouched', () => {
    const book = sampleBook();
    book.chapters[0]!.content = '[web](https://example.com/x?a=1&b=2) [mail](mailto:ops@example.com) [rel](docs/runbook.md) [frag](#appendix)';
    const html = renderBookHtml(book, renderBook(book));
    expect(html).toContain('example.com/x?a=1');
    expect(html).toContain('href="mailto:ops@example.com"');
    expect(html).toContain('href="docs/runbook.md"');
    expect(html).toContain('href="#appendix"');
  });
});
