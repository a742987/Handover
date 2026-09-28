/** Escape markdown special characters in untrusted user-generated content (PR titles, commit messages). */
export function escapeMarkdown(text: string): string {
  return text.replace(/([\\`*_{}[\]()#+\-.!|])/g, '\\$1').replace(/\n/g, ' ');
}

/** Markdown table cells cannot contain unescaped pipes. */
export function tableCell(text: string): string {
  return text.replace(/\|/g, '\\|');
}
