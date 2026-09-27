import type { BookChapter, ChapterId, RiskItem } from '../types.js';
import type { HandoverStore } from '../store/sqlite.js';
import { computeRisk, moduleOf } from '../risk/engine.js';
import type { LlmProvider } from './llm.js';

export const CHAPTER_TITLES: Record<ChapterId, string> = {
  1: 'Code Panorama',
  2: 'Implicit Knowledge Inventory',
  3: 'Risk Top 5',
  4: 'Decision Archaeology',
  5: 'The 30-Day Path',
  6: 'Letter to the Future',
};

export interface SynthesisInput {
  username: string;
  repos: string[];
  store: HandoverStore;
  risks: RiskItem[];
  onProgress?: (message: string) => void;
}

function firstLine(text: string, max = 160): string {
  const line = text.split('\n')[0] ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function excerpt(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

interface ModuleStat {
  key: string;
  repo: string;
  module: string;
  total: number;
  byUser: number;
  lastTouchedAt: string;
}

function computeModuleStats(store: HandoverStore, username: string): ModuleStat[] {
  const stats = new Map<string, ModuleStat>();
  for (const commit of store.allCommits()) {
    for (const file of commit.files) {
      const module = moduleOf(file.path);
      const key = `${commit.repo}:${module}`;
      let stat = stats.get(key);
      if (!stat) {
        stat = { key, repo: commit.repo, module, total: 0, byUser: 0, lastTouchedAt: '' };
        stats.set(key, stat);
      }
      stat.total += 1;
      if (commit.authoredAt > stat.lastTouchedAt) {
        stat.lastTouchedAt = commit.authoredAt;
      }
      if (commit.authorLogin === username) {
        stat.byUser += 1;
      }
    }
  }
  return [...stats.values()].sort((a, b) => b.byUser - a.byUser || b.total - a.total);
}

/** Compact, evidence-tagged digest of everything the LLM chapters are allowed to know. */
export function buildDigest(input: SynthesisInput): string {
  const { store, username } = input;
  const parts: string[] = [];

  parts.push(`## Module statistics (commits; share = commits authored by @${username})`);
  for (const stat of computeModuleStats(store, username)) {
    parts.push(`- ${stat.key}: ${stat.total} commits, @${username} share ${formatPercent(stat.byUser / Math.max(1, stat.total))}, last touched ${stat.lastTouchedAt.slice(0, 10)}`);
  }

  parts.push(`\n## Pull requests authored by @${username} (most recent first)`);
  const prs = store
    .allPullRequests()
    .filter((pr) => pr.authorLogin === username)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 30);
  if (prs.length === 0) {
    parts.push('- (none found)');
  }
  for (const pr of prs) {
    parts.push(`- [#${pr.number}] ${pr.title} (${pr.repo}, ${pr.mergedAt ? 'merged ' + pr.mergedAt.slice(0, 10) : pr.state})${pr.body ? ` — ${excerpt(pr.body, 200)}` : ''}`);
  }

  parts.push(`\n## Reviews by @${username} (with inline comments)`);
  const reviews = store
    .allReviews()
    .filter((review) => review.reviewerLogin === username)
    .slice(-30);
  if (reviews.length === 0) {
    parts.push('- (none found)');
  }
  for (const review of reviews) {
    parts.push(`- PR [#${review.prNumber}] ${review.state} (${review.repo})${review.body ? ` — ${excerpt(review.body, 160)}` : ''}`);
    for (const comment of review.comments) {
      parts.push(`  - on \`${comment.path}\`: ${excerpt(comment.body, 160)}`);
    }
  }

  parts.push(`\n## Issue and PR comments by @${username}`);
  const comments = store
    .allIssues()
    .flatMap((issue) => issue.comments.map((comment) => ({ issue, comment })))
    .filter(({ comment }) => comment.authorLogin === username)
    .slice(-40);
  if (comments.length === 0) {
    parts.push('- (none found)');
  }
  for (const { issue, comment } of comments) {
    parts.push(`- [#${issue.number}] ${issue.title} (${issue.repo}) — ${excerpt(comment.body, 200)}`);
  }

  parts.push('\n## Risk Top 5 (precomputed, explainable)');
  for (const risk of input.risks) {
    parts.push(`- ${risk.rank}. ${risk.module} — score ${risk.score.toFixed(3)}; ${risk.rationale}`);
  }

  return parts.join('\n');
}

const SYSTEM_PROMPT = `You are the ghostwriter of a "Handover Book": a bound, evidence-linked document written for the engineer taking over a departing colleague's work.

Hard rules:
- Every factual claim must cite evidence in square brackets using the refs present in the material: a commit like [a1b2c3d], a PR or issue like [#123], or a review like [review:456].
- If you state something the material does not support, you MUST prefix that claim with "(inference)".
- Be concrete and technical. No filler, no flattery, no speculation about feelings.
- Output markdown only, starting at "###" level; the chapter heading is added by the renderer.`;

async function llmChapter(
  id: ChapterId,
  instruction: string,
  digest: string,
  provider: LlmProvider,
  onProgress?: (message: string) => void,
): Promise<BookChapter> {
  onProgress?.(`  synthesizing "${CHAPTER_TITLES[id]}" with ${provider.name}/${provider.model} …`);
  const content = await provider.complete(SYSTEM_PROMPT, `${digest}\n\n---\n\nTask: ${instruction}`);
  return { id, title: CHAPTER_TITLES[id], content: content.trim(), evidence: [], generatedBy: 'llm' };
}

function codePanorama(input: SynthesisInput): BookChapter {
  const stats = computeModuleStats(input.store, input.username);
  const byRepo = new Map<string, ModuleStat[]>();
  for (const stat of stats) {
    const list = byRepo.get(stat.repo) ?? [];
    list.push(stat);
    byRepo.set(stat.repo, list);
  }
  const lines: string[] = [
    `@${input.username} touched ${stats.length} modules across ${byRepo.size} ${byRepo.size === 1 ? 'repository' : 'repositories'}.`,
    '',
  ];
  for (const [repo, modules] of byRepo) {
    lines.push(`### ${repo}`, '');
    lines.push('| Module | Commits | @' + input.username + ' share | Last touched |');
    lines.push('|---|---|---|---|');
    for (const module of modules.slice(0, 25)) {
      lines.push(
        `| \`${module.module}\` | ${module.total} | ${formatPercent(module.byUser / Math.max(1, module.total))} | ${module.lastTouchedAt.slice(0, 10) || '—'} |`,
      );
    }
    lines.push('');
  }
  const top = stats.slice(0, 5).map((stat) => `\`${stat.module}\` in ${stat.repo}`);
  if (top.length > 0) {
    lines.push(`Their centre of gravity: ${top.join(', ')}.`);
  }
  return { id: 1, title: CHAPTER_TITLES[1], content: lines.join('\n'), evidence: [], generatedBy: 'deterministic' };
}

function implicitKnowledge(input: SynthesisInput): BookChapter {
  const all = computeRisk(input.store, input.username, { topN: 1000 });
  const soleMaintainer = all.filter((item) => item.factors.soleContributionRatio >= 0.9);
  const soleReviewer = all.filter((item) => item.factors.irreplaceability >= 1.5);
  const lines: string[] = [
    'Modules where the knowledge is concentrated in one person — the successor has no fallback author or reviewer there.',
    '',
  ];
  if (soleMaintainer.length > 0) {
    lines.push('### Sole or dominant author', '');
    for (const item of soleMaintainer) {
      lines.push(`- \`${item.module}\` — ${formatPercent(item.factors.soleContributionRatio)} of commits by @${input.username}`);
    }
    lines.push('');
  }
  if (soleReviewer.length > 0) {
    lines.push('### Sole reviewer', '');
    for (const item of soleReviewer) {
      lines.push(`- \`${item.module}\` — every review on this module's PRs was by @${input.username} ${item.evidence.find((e) => e.kind === 'review') ? `[${item.evidence.find((e) => e.kind === 'review')?.ref}]` : ''}`);
    }
    lines.push('');
  }
  if (soleMaintainer.length === 0 && soleReviewer.length === 0) {
    lines.push('No single-person knowledge concentrations were detected in the collected history.');
  }
  return { id: 2, title: CHAPTER_TITLES[2], content: lines.join('\n'), evidence: [], generatedBy: 'deterministic' };
}

function riskChapter(risks: RiskItem[]): BookChapter {
  const lines: string[] = [
    'Scored as `sole_contribution_ratio × change_frequency × incident_weight × irreplaceability`. Every item lists its evidence chain.',
    '',
  ];
  for (const risk of risks) {
    lines.push(`### ${risk.rank}. \`${risk.module}\` — score ${risk.score.toFixed(3)}`, '');
    lines.push(
      `- sole contribution: ${formatPercent(risk.factors.soleContributionRatio)}`,
      `- change frequency: ${risk.factors.changeFrequency.toFixed(2)}`,
      `- incident weight: ${risk.factors.incidentWeight.toFixed(2)}`,
      `- irreplaceability: ×${risk.factors.irreplaceability.toFixed(2)}`,
      '',
    );
    lines.push(risk.rationale, '');
    if (risk.evidence.length > 0) {
      lines.push('Evidence: ' + risk.evidence.map((ref) => `[${ref.ref}]`).join(' '), '');
    }
  }
  if (risks.length === 0) {
    lines.push('No risk items — was any history collected?');
  }
  return { id: 3, title: CHAPTER_TITLES[3], content: lines.join('\n'), evidence: [], generatedBy: 'deterministic' };
}

function decisionFallback(input: SynthesisInput): BookChapter {
  const prs = input.store
    .allPullRequests()
    .filter((pr) => pr.authorLogin === input.username)
    .sort((a, b) => b.body.length - a.body.length)
    .slice(0, 10);
  const lines: string[] = [
    'LLM synthesis was not available for this run, so this chapter lists the PRs with the richest written rationale instead of a narrative.',
    '',
  ];
  if (prs.length === 0) {
    lines.push('No PRs authored by the departing engineer were found in the index.');
  }
  for (const pr of prs) {
    lines.push(`- [#${pr.number}] **${pr.title}** (${pr.repo})${pr.body ? ` — ${excerpt(pr.body, 400)}` : ''}`);
  }
  return { id: 4, title: CHAPTER_TITLES[4], content: lines.join('\n'), evidence: [], generatedBy: 'deterministic' };
}

function pathFallback(input: SynthesisInput): BookChapter {
  const lines: string[] = ['A starting plan built from the risk ranking (LLM synthesis was unavailable).', ''];
  for (const risk of input.risks) {
    lines.push(`- Week 1: read and run \`${risk.module}\`; reconcile the evidence in ${risk.evidence.map((ref) => `[${ref.ref}]`).join(' ') || 'the appendix'}.`);
  }
  lines.push('', '- Before the last day: walk each Risk Top 5 item with the departing engineer and record answers in this book.');
  return { id: 5, title: CHAPTER_TITLES[5], content: lines.join('\n'), evidence: [], generatedBy: 'deterministic' };
}

function letterFallback(input: SynthesisInput): BookChapter {
  const questions = [
    'Which module would you fix first if you had one more week, and why?',
    'Which piece of the system looks wrong but must not be "fixed" — and what broke the last time someone tried?',
    'Which deploy/migration quirk is load-bearing?',
    'Who outside the team do you call when X breaks?',
    'What did you promise product/ops that was never written down?',
  ];
  const lines: string[] = [
    'LLM style-transfer was unavailable; these are the questions the successor should ask @' + input.username + ' before the last day.',
    '',
  ];
  questions.forEach((question, index) => {
    lines.push(`${index + 1}. ${question}`);
    lines.push('   - (answer to be captured)');
  });
  return { id: 6, title: CHAPTER_TITLES[6], content: lines.join('\n'), evidence: [], generatedBy: 'deterministic' };
}

function decisionInstruction(username: string): string {
  return `Write chapter 4, "Decision Archaeology": identify the 3-5 most consequential technical decisions visible in @${username}'s merged PRs and issue discussions below. For each: what was decided, what alternatives were argued, and by whom. Quote or closely paraphrase the actual discussion and cite the refs. Anything you cannot support must be prefixed "(inference)".`;
}

function pathInstruction(username: string): string {
  return `Write chapter 5, "The 30-Day Path": a concrete four-week learning plan for the successor, ordered by the precomputed Risk Top 5 and the module statistics. For each step say what to read (cite refs), what to run, and whom to ask. End with the single most valuable thing to capture from @${username} before they leave.`;
}

function letterInstruction(username: string): string {
  return `Write chapter 6, "Letter to the Future": the 10 questions a successor will most likely ask, each answered in @${username}'s own voice — mirror the phrasing, directness and humour visible in their comments below. Cite refs where the answer rests on evidence; prefix "(inference)" where it rests on judgement.`;
}

/** Chapters 1-3 are deterministic; 4-6 use the LLM when one is available, and fall back otherwise. */
export async function synthesizeChapters(
  input: SynthesisInput,
  provider: LlmProvider | null,
): Promise<BookChapter[]> {
  const digest = buildDigest(input);

  const chapters: BookChapter[] = [codePanorama(input), implicitKnowledge(input), riskChapter(input.risks)];

  const llmTasks: Array<{ id: ChapterId; instruction: string; fallback: () => BookChapter }> = [
    { id: 4, instruction: decisionInstruction(input.username), fallback: () => decisionFallback(input) },
    { id: 5, instruction: pathInstruction(input.username), fallback: () => pathFallback(input) },
    { id: 6, instruction: letterInstruction(input.username), fallback: () => letterFallback(input) },
  ];

  for (const task of llmTasks) {
    if (!provider) {
      chapters.push(task.fallback());
      continue;
    }
    try {
      chapters.push(await llmChapter(task.id, task.instruction, digest, provider, input.onProgress));
    } catch (error) {
      input.onProgress?.(
        `  LLM synthesis of "${CHAPTER_TITLES[task.id]}" failed (${error instanceof Error ? error.message : String(error)}); using deterministic fallback.`,
      );
      chapters.push(task.fallback());
    }
  }

  return chapters.sort((a, b) => a.id - b.id);
}
