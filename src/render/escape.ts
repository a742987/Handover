/**
 * Escaping for untrusted user-generated content (PR titles, commit messages,
 * review text, file paths). Everything here eventually reaches a browser via
 * the single-file HTML twin, so HTML-significant characters must never
 * survive: markdown escaping alone leaves `<script>`/`<img onerror>` intact.
 */

export function escapeMarkdown(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([\\`*_{}[\]()#+\-.!|])/g, '\\$1')
    .replace(/\n/g, ' ');
}

/**
 * Chapter headings. escapeMarkdown's full char set is wrong here twice over:
 * `&` becomes a literal "&amp;" in the source markdown, and inside a heading
 * a leading `#`/`-` is the only structural hazard. Escape just what could
 * inject HTML or break the heading, leave `&` readable.
 */
export function escapeHeading(text: string): string {
  return text.replace(/</g, '&lt;').replace(/[\\`]/g, '\\$&');
}

/**
 * Renders untrusted text as a markdown code span. Backslash escapes do not
 * work inside code spans (CommonMark), so instead of escaping the content the
 * delimiter is widened to outgrow any backtick run in it — a module name
 * cannot close the span early and smuggle raw HTML into the rendered book.
 * Set `inTable` for GFM table cells, where pipes need the table-specific
 * `\|` escape even inside code spans.
 */
export function codeSpan(text: string, inTable = false): string {
  const flat = text.replace(/\r?\n/g, ' ');
  const longestRun = [...flat.matchAll(/`+/g)].reduce((max, match) => Math.max(max, match[0].length), 0);
  const fence = '`'.repeat(Math.max(1, longestRun + 1));
  const padded = flat.startsWith('`') || flat.endsWith('`') ? ` ${flat} ` : flat;
  const body = inTable ? padded.replace(/\|/g, '\\|') : padded;
  return `${fence}${body}${fence}`;
}

/** Markdown table cells cannot contain unescaped pipes — or raw HTML — or line breaks. */
export function tableCell(text: string): string {
  return text
    .replace(/\r?\n/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\|/g, '\\|');
}

/**
 * Neutralizes HTML-significant characters while leaving markdown structure
 * alone — for prose lines built from untrusted content (risk rationales,
 * captured answers) where markdown-escaping would litter the output.
 */
export function escapeHtmlText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
