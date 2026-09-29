import type { ActionItem, BookCoverage, EvidenceRef, HandoverBook } from '../types.js';
import { CHAPTER_TITLES } from '../distill/synthesize.js';
import { codeSpan, escapeHeading, escapeHtmlText, escapeMarkdown, tableCell } from './escape.js';
import { evidenceLink, formatRef } from './refs.js';

function evidenceKey(ref: EvidenceRef): string {
  // refs collide across repositories (#12 exists in every repo), so the repo
  // qualifier the risk engine attaches is part of the identity
  return `${ref.kind}:${ref.repo ?? ''}:${ref.ref}`;
}

function evidenceList(refs: EvidenceRef[], multiRepo: boolean): string {
  return refs.map((ref) => evidenceLink(ref, multiRepo)).join(' ');
}

function renderCoverage(book: HandoverBook, coverage: BookCoverage): string[] {
  const lines: string[] = ['### What this analysis covers', ''];
  // Prose fields keep markdown structure (backticks etc.) alive — only
  // HTML-significant characters are neutralized, same as risk rationales.
  lines.push(`- **Repositories:** ${coverage.repos.map(escapeHtmlText).join(', ') || '—'}`);
  if (coverage.sources.length > 0) {
    lines.push(`- **Sources:** ${coverage.sources.map(escapeHtmlText).join(' + ')}`);
  }
  if (coverage.commitWindow.from && coverage.commitWindow.to) {
    lines.push(
      `- **Commit window:** ${coverage.commitWindow.from.slice(0, 10)} → ${coverage.commitWindow.to.slice(0, 10)} (author dates)`,
    );
  }
  const c = coverage.counts;
  lines.push(
    `- **Collected:** ${c.commits} commits · ${c.pullRequests} PRs · ${c.reviews} reviews · ${c.issues} issues · ${c.comments} comments · ${c.capturedAnswers} captured answer(s)`,
  );
  lines.push(`- **Contributors:** ${coverage.contributors} distinct attributed author(s)`);
  lines.push(`- **Synthesis:** ${book.chapters.some((chapter) => chapter.generatedBy === 'llm') ? 'LLM + deterministic' : 'deterministic (no LLM output in this book)'}`);
  lines.push('');
  if (coverage.gaps.length > 0) {
    lines.push('### Known gaps', '');
    for (const gap of coverage.gaps) {
      lines.push(`- ${escapeHtmlText(gap)}`);
    }
    lines.push('');
  }
  return lines;
}

function renderActionItem(index: number, item: ActionItem, multiRepo: boolean): string[] {
  const lines: string[] = [`**${index + 1}. ${codeSpan(item.module)}**`, ''];
  lines.push(`- **Finding:** ${escapeHtmlText(item.finding)}`);
  lines.push(`- **Confirm with ${escapeHtmlText(item.confirmWith)}:** ${escapeHtmlText(item.question)}`);
  if (item.evidence.length > 0) {
    lines.push(`- **Evidence:** ${evidenceList(item.evidence, multiRepo)}`);
  }
  lines.push(`- **Next step:** ${escapeHtmlText(item.nextStep)}`);
  lines.push(`- **Limitation:** ${escapeHtmlText(item.limitation)}`);
  lines.push('');
  return lines;
}

/**
 * Renders the bound book as markdown. The layout is deliberately "print-like":
 * title page, ethics note, action page, table of contents, numbered chapters,
 * evidence appendix.
 */
export function renderBook(book: HandoverBook): string {
  const lines: string[] = [];
  const multiRepo = book.repos.length > 1;

  lines.push(`# Handover Book — @${escapeMarkdown(book.username)}`, '');
  lines.push(`*When a developer leaves, their knowledge shouldn't.*`, '');
  lines.push(`- **Repositories:** ${book.repos.map(escapeMarkdown).join(', ')}`);
  lines.push(`- **Generated:** ${book.generatedAt}`);
  lines.push(`- **Chapters:** ${book.chapters.length}`);
  lines.push(
    `- **Synthesis:** ${book.chapters.some((chapter) => chapter.generatedBy === 'llm') ? 'LLM + deterministic' : 'deterministic (no LLM key configured)'}`,
  );
  if (book.redacted) {
    lines.push('- **Redaction:** known secret formats were scrubbed from this rendering (best effort, not a guarantee).');
  }
  lines.push('');
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

  lines.push('## Action summary — read this first', '');
  lines.push(
    'Where the data comes from, what it misses, and the few things worth confirming before the handover. The chapters below hold the detail.',
    '',
  );
  if (book.coverage) {
    lines.push(...renderCoverage(book, book.coverage));
  }

  if (book.actions && book.actions.length > 0) {
    lines.push(`### Confirm before the handover (top ${book.actions.length})`, '');
    book.actions.forEach((item, index) => lines.push(...renderActionItem(index, item, multiRepo)));
  }

  lines.push('### How to read the labels', '');
  lines.push('- **Cited ref** (`a1b2c3d`, `#123`, `review:456`) — a fact from the collected history; the appendix lists them all.');
  lines.push('- ***(inference)*** — a judgement the model or the scoring made that no cited ref directly supports.');
  lines.push('- **Recorded answers** — first-person answers from the departing engineer, captured with `handover capture`; the only truly first-person content in this book.');
  lines.push('- Risk scores are ownership/maintenance signals from Git records — not a measure of a person\'s knowledge, value, or an incident prediction.');
  lines.push('');

  lines.push('## Contents', '');
  for (const chapter of book.chapters) {
    lines.push(`${chapter.id}. ${CHAPTER_TITLES[chapter.id]}${chapter.generatedBy === 'llm' ? '' : ' *(deterministic)*'}`);
  }
  lines.push('');

  for (const chapter of book.chapters) {
    lines.push(`## ${chapter.id}. ${escapeHeading(chapter.title)}`, '');
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
      lines.push(`| ${ref.kind} | ${evidenceLink(ref, multiRepo)} | ${ref.excerpt ? tableCell(ref.excerpt) : '—'} |`);
    }
  }
  lines.push('');

  return lines.join('\n');
}
