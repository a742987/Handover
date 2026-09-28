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

/** Single-file, print-ready HTML twin of the markdown book (browser print → PDF). */
export function renderBookHtml(book: HandoverBook, markdown: string): string {
  let body = marked.parse(markdown, { async: false }) as string;
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
