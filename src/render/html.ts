import { marked } from 'marked';
import type { HandoverBook } from '../types.js';

const STYLE = `
  :root { color-scheme: light; }
  body { margin: 0; background: #f5f3ee; color: #1f2328; font: 16px/1.65 Georgia, 'Times New Roman', serif; }
  main { max-width: 860px; margin: 0 auto; padding: 3rem 2rem 6rem; background: #fff; box-shadow: 0 0 24px rgba(0,0,0,.08); }
  h1, h2, h3, h4 { font-family: Helvetica, Arial, sans-serif; line-height: 1.25; }
  h1 { border-bottom: 3px double #999; padding-bottom: .4rem; }
  h2 { margin-top: 2.5rem; border-bottom: 1px solid #ddd; padding-bottom: .3rem; }
  a { color: #0b5cad; text-decoration: none; }
  a:hover { text-decoration: underline; }
  code { font: 85% ui-monospace, 'Cascadia Code', Consolas, monospace; background: #f0eee8; padding: .1em .3em; border-radius: 3px; }
  table { border-collapse: collapse; width: 100%; margin: 1rem 0; font-size: 92%; font-family: Helvetica, Arial, sans-serif; }
  th, td { border: 1px solid #d8d4ca; padding: .45rem .6rem; text-align: left; vertical-align: top; }
  th { background: #efece4; }
  blockquote { margin: 1rem 0; padding: .2rem 1rem; border-left: 4px solid #c9b98a; background: #faf8f2; color: #444; }
  hr { border: none; border-top: 1px solid #ddd; margin: 2rem 0; }
  @media print { body { background: #fff; } main { box-shadow: none; max-width: none; padding: 0; } a { color: inherit; } }
`;

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]!);
}

function decodeHtmlEntities(value: string): string {
  const once = (input: string): string =>
    input
      .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
      .replace(/&(amp|lt|gt|quot|apos);/gi, (_, name: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[name.toLowerCase()]!);
  // double-encoded payloads ("&amp;#106;avascript:") need a second pass to be
  // recognizable as the scheme they really are
  let out = value;
  for (let i = 0; i < 3; i += 1) {
    const next = once(out);
    if (next === out) {
      break;
    }
    out = next;
  }
  return out;
}

const UNSAFE_SCHEME = /^(javascript|vbscript|data)\s*:/i;

const DANGEROUS_ELEMENTS = /\s*<(script|style|iframe|object|embed|form|link|meta|base)\b[\s\S]*?<\/\1\s*>\s*/gi;
const DANGEROUS_ELEMENTS_OPEN = /<(script|style|iframe|object|embed|form|link|meta|base)\b[^>]*\/?>/gi;
const EVENT_ATTRIBUTES = /\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
const URL_ATTRIBUTES = /(\s+(?:xlink:)?(?:href|src)\s*=\s*)("[^"]*"|'[^']*'|[^\s>]+)/gi;

/**
 * Defense-in-depth pass over the rendered chapter HTML. Repo-derived text is
 * already escaped at its source (see render/escape.ts), but LLM chapters quote
 * that content back and can emit markup of their own — so the final HTML must
 * not trust it: dangerous elements are dropped, event handlers are stripped,
 * and script-bearing URLs are neutralized.
 */
function sanitizeBookHtml(html: string): string {
  return html
    .replace(DANGEROUS_ELEMENTS, '')
    .replace(DANGEROUS_ELEMENTS_OPEN, '')
    .replace(EVENT_ATTRIBUTES, '')
    .replace(URL_ATTRIBUTES, (match, prefix: string, raw: string) => {
      const quoted = raw.length >= 2 && (raw.startsWith('"') || raw.startsWith("'"));
      const value = quoted ? raw.slice(1, -1) : raw;
      const decoded = decodeHtmlEntities(value).trim();
      return UNSAFE_SCHEME.test(decoded) ? `${prefix}"#"` : match;
    });
}

/** Single-file, print-ready HTML twin of the markdown book (browser print → PDF). */
export function renderBookHtml(book: HandoverBook, markdown: string): string {
  let body = marked.parse(markdown, { async: false }) as string;
  body = sanitizeBookHtml(body);
  body = body.replace(/<a href="(https?:\/\/[^"]*)"/g, '<a target="_blank" rel="noopener noreferrer" href="$1"');
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>Handover Book — ${escapeHtml(book.username)}</title>`,
    `<style>${STYLE}</style>`,
    '</head>',
    '<body>',
    `<main>${body}</main>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}
