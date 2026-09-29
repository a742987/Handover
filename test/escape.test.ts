import { describe, expect, it } from 'vitest';
import { codeSpan, escapeHeading, escapeHtmlText, escapeMarkdown, isSafeUrl, neutralizeGeneratedMarkup, tableCell } from '../src/render/escape.js';

describe('neutralizeGeneratedMarkup — the markdown book has no sanitizer', () => {
  it('strips raw HTML the model emits so a .md reader cannot execute it', () => {
    const out = neutralizeGeneratedMarkup('see <img src=x onerror=alert(1)> and <script>alert(2)</script>');
    expect(out).not.toContain('<img');
    expect(out).not.toContain('<script');
    expect(out).toContain('&lt;img');
  });

  it('closes a markup-looking comment and CDATA opener', () => {
    expect(neutralizeGeneratedMarkup('<!-- conditional -->')).toBe('&lt;!-- conditional -->');
    expect(neutralizeGeneratedMarkup('<![CDATA[x]]>')).toContain('&lt;![CDATA');
  });

  it('rewrites a scripted link target but keeps the link text', () => {
    const out = neutralizeGeneratedMarkup('[payments](javascript:alert(1))');
    expect(out).toBe('[payments](#)');
    expect(neutralizeGeneratedMarkup('[docs](https://acme.test/a)')).toBe('[docs](https://acme.test/a)');
    expect(neutralizeGeneratedMarkup('[anchor](#chapter-4)')).toBe('[anchor](#chapter-4)');
  });

  it('catches the entity-encoded scheme forms the HTML sanitizer guards against', () => {
    expect(neutralizeGeneratedMarkup('[x](javascript&colon;alert(1))')).toBe('[x](#)');
    expect(neutralizeGeneratedMarkup('[x](java\tscript:alert(1))')).toBe('[x](#)');
  });

  it('keeps targets that contain balanced parentheses and titles', () => {
    expect(neutralizeGeneratedMarkup('[a](https://x.test/a(b)c "note")')).toBe('[a](https://x.test/a(b)c "note")');
    expect(neutralizeGeneratedMarkup('[a](javascript:foo(bar) "note")')).toBe('[a](# "note")');
  });

  it('neutralizes unsafe reference-style link definitions', () => {
    // the inline ](…) scanner cannot see these: the target sits on another line
    expect(neutralizeGeneratedMarkup('[a]: javascript:alert(1)')).toBe('[a]: #');
    expect(neutralizeGeneratedMarkup('[a]: <javascript:alert(1)>')).toBe('[a]: <#>');
    expect(neutralizeGeneratedMarkup('[a]: javascript&colon;alert(1)')).toBe('[a]: #');
    expect(neutralizeGeneratedMarkup('[a]: https://acme.test/x')).toBe('[a]: https://acme.test/x');
  });

  it('leaves prose and code spans alone', () => {
    const prose = 'risk = a < b when `sole_ratio` > 0.9 and the count is 3/4';
    expect(neutralizeGeneratedMarkup(prose)).toBe(prose);
  });
});

describe('isSafeUrl', () => {
  it('accepts only http, https, mailto and relative targets', () => {
    expect(isSafeUrl('https://a.test')).toBe(true);
    expect(isSafeUrl('mailto:a@b.test')).toBe(true);
    expect(isSafeUrl('#frag')).toBe(true);
    expect(isSafeUrl('data:text/html,<script>')).toBe(false);
    expect(isSafeUrl('view-source:https://a.test')).toBe(false);
  });
});

describe('escaping primitives still behave for the deterministic chapters', () => {
  it('widens code fences around backticks in a module name', () => {
    expect(codeSpan('pay`ments')).toBe('``pay`ments``');
    expect(tableCell('a|b <c>')).toBe('a\\|b &lt;c&gt;');
    // escapeHeading neutralizes `<` and markup-active backslash/backtick only —
    // a bare `>` carries no markdown meaning inside a heading
    expect(escapeHeading('A \\ `B` <c>')).toBe('A \\\\ \\`B\\` &lt;c>');
    expect(escapeMarkdown('a & < b > c')).toBe('a &amp; &lt; b &gt; c');
    expect(escapeHtmlText('a<b>c')).toBe('a&lt;b&gt;c');
  });

  it('neutralizes the markdown that turns an excerpt into live remote content', () => {
    // a commit message can carry `![x](http://evil/pixel)` verbatim; escaping
    // only `<` left it a live tracking pixel in the rendered book
    const pixel = 'fix ![x](http://evil/pixel?u=me) please';
    expect(tableCell(pixel)).toBe('fix \\!\\[x\\](http://evil/pixel?u=me) please');
    expect(escapeHtmlText(pixel)).toBe('fix \\!\\[x\\](http://evil/pixel?u=me) please');
    // reference-style link definitions carry no `](` — the brackets are the kill
    expect(escapeHtmlText('[1]: javascript:alert(1)')).toBe('\\[1\\]: javascript:alert(1)');
    // links and images are equally dead in both helpers
    expect(escapeHtmlText('[click](https://evil.test)')).toBe('\\[click\\](https://evil.test)');
  });

  it('escapes the backslash before the pipe so a cell cannot split its column', () => {
    // `a\|b` with only the pipe escaped became `a\\|b` — a literal backslash
    // followed by a live column separator
    expect(tableCell('a\\|b')).toBe('a\\\\\\|b');
    expect(tableCell('path\\to\\file')).toBe('path\\\\to\\\\file');
  });

  it('keeps legitimate code spans in prose alive', () => {
    // the renderer itself builds backticked module names into prose fields —
    // escaping them would litter the book with visible backslashes
    expect(escapeHtmlText('read and run `payments` first')).toBe('read and run `payments` first');
  });
});
