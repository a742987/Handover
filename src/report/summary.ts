import type { ActionItem, BookCoverage, RiskItem } from '../types.js';
import type { HandoverStore } from '../store/sqlite.js';

const SOURCE_LABELS: Record<string, string> = {
  github: 'GitHub API (commits, PRs, reviews, issues)',
  'local-git': 'local git clones (commits only)',
};

/** Appends a collection source to the meta list without duplicates. */
export function markCollectionSource(store: HandoverStore, source: string): void {
  const existing = (store.getMeta('collected_via') ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (!existing.includes(source)) {
    existing.push(source);
    store.setMeta('collected_via', existing.join(','));
  }
}

function sourceLabels(store: HandoverStore, repos: string[]): string[] {
  const recorded = (store.getMeta('collected_via') ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (recorded.length > 0) {
    // Known collectors get their audited label; anything else (a programmatically
    // seeded store) passes its own description through verbatim.
    return recorded.map((value) => SOURCE_LABELS[value] ?? value);
  }
  const labels: string[] = [];
  if (repos.some((repo) => /^[^/]+\/[^/]+$/.test(repo))) {
    labels.push(SOURCE_LABELS.github!);
  }
  if (repos.some((repo) => !/^[^/]+\/[^/]+$/.test(repo))) {
    labels.push(SOURCE_LABELS['local-git']!);
  }
  return labels;
}

/**
 * The book's front page is an action page (what to confirm first), not a table of
 * contents. Both builders read only the local index — no network, no LLM.
 */
export function buildCoverage(store: HandoverStore, repos: string[]): BookCoverage {
  const commits = store.allCommits();
  const pullRequests = store.allPullRequests();
  const reviews = store.allReviews();
  const issues = store.allIssues();

  let comments = 0;
  for (const issue of issues) {
    comments += issue.comments.length;
  }

  const authors = new Set<string>();
  let unattributed = 0;
  let from: string | null = null;
  let to: string | null = null;
  for (const commit of commits) {
    if (commit.authorLogin === 'unknown') {
      unattributed += 1;
    } else {
      authors.add(commit.authorLogin);
    }
    if (!from || commit.authoredAt < from) {
      from = commit.authoredAt;
    }
    if (!to || commit.authoredAt > to) {
      to = commit.authoredAt;
    }
  }

  const sources = sourceLabels(store, repos);
  // Indexes collected earlier may hold repos that are no longer in scope; report
  // what the data actually spans, not just what this run asked for.
  for (const repo of new Set([...commits.map((c) => c.repo), ...pullRequests.map((p) => p.repo)])) {
    if (!repos.includes(repo)) {
      repos.push(repo);
    }
  }

  const gaps: string[] = [];
  if (pullRequests.length === 0 && reviews.length === 0) {
    gaps.push(
      'No pull requests or reviews were collected — "why" decisions and review discussions are missing from this book. Collect from GitHub (-r owner/name) to include them.',
    );
  } else if (reviews.length === 0) {
    gaps.push('No reviews were collected — review coverage is invisible in this book.');
  }
  if (issues.length === 0) {
    gaps.push('No issues were collected — incident history is missing from the risk scores.');
  }
  if (unattributed > 0) {
    gaps.push(`${unattributed} commit(s) could not be attributed to an author and were excluded from ownership ratios.`);
  }
  if (store.listAnswers().length === 0) {
    gaps.push('No first-person answers recorded yet — run `handover capture` with the departing engineer before they leave.');
  }

  return {
    repos: [...repos],
    sources,
    commitWindow: { from, to },
    counts: {
      commits: commits.length,
      pullRequests: pullRequests.length,
      reviews: reviews.length,
      issues: issues.length,
      comments,
      capturedAnswers: store.listAnswers().length,
    },
    contributors: authors.size,
    unattributedCommits: unattributed,
    gaps,
  };
}

function questionFor(risk: RiskItem, username: string): string {
  const parts: string[] = [];
  if (risk.factors.soleContributionRatio >= 0.9) {
    parts.push(`Has anyone besides @${username} shipped, deployed or rolled back \`${risk.module}\` — and if not, what was never written down?`);
  }
  if (risk.factors.irreplaceability >= 1.5) {
    parts.push(`Who can review changes to \`${risk.module}\` after @${username} leaves, and is that person confident doing it today?`);
  }
  if (parts.length > 0) {
    return parts.join(' ');
  }
  return `Who else understands \`${risk.module}\` well enough to own it, and what would they need to learn first?`;
}

const LIMITATION =
  'Commit and review counts show authorship, not knowledge: pair programming, verbal decisions and off-repo work are invisible to Git. Treat this as a signal to verify, not a verdict.';

/** Turns the Risk Top 5 into "confirm before the handover" entries for the action page. */
export function buildActions(risks: RiskItem[], username: string): ActionItem[] {
  return risks
    // zero-score modules (one stale commit) are noise on an action page —
    // the full ranking stays in chapter 3
    .filter((risk) => risk.score > 0)
    .slice(0, 5)
    .map((risk) => ({
      module: risk.module,
      finding: risk.rationale,
      question: questionFor(risk, username),
      confirmWith: `@${username} (the departing engineer)`,
      nextStep: `Have the successor read and run \`${risk.module}\`, then walk this item with @${username} and record the answer with \`handover capture\`.`,
      limitation: LIMITATION,
      evidence: risk.evidence,
    }));
}
