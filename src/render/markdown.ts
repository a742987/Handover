import type { EvidenceRef, HandoverBook } from '../types.js';
import { CHAPTER_TITLES } from '../distill/synthesize.js';

function evidenceKey(ref: EvidenceRef): string {
  return `${ref.kind}:${ref.ref}`;
}

/**
 * Renders the bound book as markdown. The layout is deliberately "print-like":
 * title page, ethics note, table of contents, numbered chapters, evidence appendix.
 */
export function renderBook(book: HandoverBook): string {
  const lines: string[] = [];

  lines.push(`# Handover Book — @${book.username}`, '');
  lines.push(`*When a developer leaves, their knowledge shouldn't.*`, '');
  lines.push(`- **Repositories:** ${book.repos.join(', ')}`);
  lines.push(`- **Generated:** ${book.generatedAt}`);
  lines.push(`- **Chapters:** ${book.chapters.length}`);
  lines.push(
    `- **Synthesis:** ${book.chapters.some((chapter) => chapter.generatedBy === 'llm') ? 'LLM + deterministic' : 'deterministic (no LLM key configured)'}`,
    '',
  );
  lines.push(
    `> This book is **a gift for the successor**, not an audit of the leaver. It was generated locally from Git history and GitHub metadata; nothing was uploaded anywhere. Claims without an evidence ref are labelled *(inference)*.`,
    '',
  );

  lines.push('## Contents', '');
  for (const chapter of book.chapters) {
    lines.push(`${chapter.id}. ${CHAPTER_TITLES[chapter.id]}${chapter.generatedBy === 'llm' ? '' : ' *(deterministic)*'}`);
  }
  lines.push('');

  for (const chapter of book.chapters) {
    lines.push(`## ${chapter.id}. ${chapter.title}`, '');
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
    lines.push('| Kind | Ref | Excerpt |', '|---|---|---|');
    for (const ref of allEvidence) {
      lines.push(`| ${ref.kind} | \`${ref.ref}\` | ${ref.excerpt ?? '—'} |`);
    }
  }
  lines.push('');

  return lines.join('\n');
}
