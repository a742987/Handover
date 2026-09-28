import type { EvidenceRef, HandoverBook } from '../types.js';
import { CHAPTER_TITLES } from '../distill/synthesize.js';

function evidenceKey(ref: EvidenceRef): string {
  return `${ref.kind}:${ref.ref}`;
}

/** Markdown table cells cannot contain unescaped pipes. */
function tableCell(text: string): string {
  return text.replace(/\|/g, '\\|');
}

/** Escape markdown special characters in untrusted user-generated content (PR titles, commit messages). */
function escapeMarkdown(text: string): string {
  return text.replace(/([\\`*_{}[\]()#+\-.!|])/g, '\\$1').replace(/\n/g, ' ');
}

function evidenceLink(ref: EvidenceRef): string {
  return ref.url ? `[\`${ref.ref}\`](${ref.url})` : `\`${ref.ref}\``;
}

/**
 * Renders the bound book as markdown. The layout is deliberately "print-like":
 * title page, ethics note, table of contents, numbered chapters, evidence appendix.
 */
export function renderBook(book: HandoverBook): string {
  const lines: string[] = [];

  lines.push(`# Handover Book — @${escapeMarkdown(book.username)}`, '');
  lines.push(`*When a developer leaves, their knowledge shouldn't.*`, '');
  lines.push(`- **Repositories:** ${book.repos.map(escapeMarkdown).join(', ')}`);
  lines.push(`- **Generated:** ${book.generatedAt}`);
  lines.push(`- **Chapters:** ${book.chapters.length}`);
  lines.push(
    `- **Synthesis:** ${book.chapters.some((chapter) => chapter.generatedBy === 'llm') ? 'LLM + deterministic' : 'deterministic (no LLM key configured)'}`,
    '',
  );
  const usedLlm = book.chapters.some((chapter) => chapter.generatedBy === 'llm');
  const provider = `${book.llmProvider ?? 'an external LLM provider'}${book.llmModel ? ` (${book.llmModel})` : ''}`;
  // Privacy claim: if LLM was configured (llmProvider is set), content was sent regardless of whether
  // chapters succeeded. Only claim "nothing uploaded" when no provider was configured at all.
  const llmWasConfigured = book.llmProvider !== undefined;
  lines.push(
    usedLlm
      ? `> This book is **a gift for the successor**, not an audit of the leaver. It was generated locally from Git history and GitHub metadata; the LLM-synthesized chapters were written by ${provider}, to which collected repository content was sent. Claims without an evidence ref are labelled *(inference)*.`
      : llmWasConfigured
        ? `> This book is **a gift for the successor**, not an audit of the leaver. It was generated locally from Git history and GitHub metadata; an LLM provider was configured and collected content was sent to it, but synthesis failed and deterministic fallbacks were used. Claims without an evidence ref are labelled *(inference)*.`
        : `> This book is **a gift for the successor**, not an audit of the leaver. It was generated locally from Git history and GitHub metadata; nothing was uploaded anywhere. Claims without an evidence ref are labelled *(inference)*.`,
    '',
  );

  lines.push('## Contents', '');
  for (const chapter of book.chapters) {
    lines.push(`${chapter.id}. ${CHAPTER_TITLES[chapter.id]}${chapter.generatedBy === 'llm' ? '' : ' *(deterministic)*'}`);
  }
  lines.push('');

  for (const chapter of book.chapters) {
    lines.push(`## ${chapter.id}. ${escapeMarkdown(chapter.title)}`, '');
    lines.push(chapter.content.trim(), '');
  }

  const seen = new Set<string>();
  const allEvidence: EvidenceRef[] = [];
  for (const chapter of book.chapters) {
    for (const ref of chapter.evidence) {
      const key = evidenceKey(ref);
      if (!seen.has(key)) {
        seen.add(key);
        allEvidence.push(ref);
      }
    }
  }
  lines.push('## Appendix — evidence register', '');
  if (allEvidence.length === 0) {
    lines.push('Evidence refs are cited inline within chapter bodies.');
  } else {
    lines.push('| Kind | Evidence | Excerpt |', '|---|---|---|');
    for (const ref of allEvidence) {
      lines.push(`| ${ref.kind} | ${evidenceLink(ref)} | ${ref.excerpt ? tableCell(ref.excerpt) : '—'} |`);
    }
  }
  lines.push('');

  return lines.join('\n');
}
