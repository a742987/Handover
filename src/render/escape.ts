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

/** Markdown table cells cannot contain unescaped pipes — or raw HTML. */
export function tableCell(text: string): string {
  return text
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
