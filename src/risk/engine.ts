import { sameLogin } from '../identity.js';
import type { EvidenceRef, RiskFactor, RiskItem } from '../types.js';
import type { HandoverStore } from '../store/sqlite.js';

const DAY_MS = 86_400_000;

// Word-boundary match, not substring: a `debugging` label is not an incident,
// and substring matching pushed `bug`-by-prefix onto its score.
const BUG_LABEL_PATTERN = /\b(?:bugs?|incidents?|regressions?|outages?|crashes?)\b/i;

/** Top-level directory of a file path; files at the repo root form the "(root)" module. */
export function moduleOf(path: string): string {
  const slash = path.indexOf('/');
  return slash === -1 ? '(root)' : path.slice(0, slash);
}

export interface RiskOptions {
  now?: Date;
  /** look-back window for change frequency, in days (default 90) */
  windowDays?: number;
  /** how many risk items to rank (default 5) */
  topN?: number;
}

interface ModuleAccumulator {
  key: string;
  total: number;
  byUser: number;
  recent: number;
  bugMentions: number;
  userCommits: Array<{ sha: string; authoredAt: string; message: string }>;
  /** distinct PRs whose reviews touched this module */
  reviewedPrs: Set<number>;
  /** distinct reviewers across those PRs (lowercased logins) */
  reviewers: Set<string>;
  userReviewed: boolean;
  exampleReview: { prNumber: number; id: number } | null;
  bugIssues: Set<number>;
}

export function firstLine(text: string, max = 120): string {
  const line = text.split('\n')[0] ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * CI bot logins (dependabot[bot], renovate[bot], github-actions[bot], …) are
 * not teammates: counted as authors they deflate sole-contribution ratios and
 * inflate the "who else can take over" headcount.
 */
export function isBotLogin(login: string): boolean {
  return /\[bot\]$/i.test(login);
}

/**
 * Explainable risk scoring (project plan §3.4):
 *
 *   risk = sole_contribution_ratio × change_frequency × incident_weight × irreplaceability
 *
 * Every returned item carries the evidence chain that justifies its score.
 */
export function computeRisk(store: HandoverStore, username: string, options: RiskOptions = {}): RiskItem[] {
  const now = options.now ?? new Date();
  const windowStartMs = now.getTime() - (options.windowDays ?? 90) * DAY_MS;
  const topN = options.topN ?? 5;

  const modules = new Map<string, ModuleAccumulator>();
  const acc = (key: string): ModuleAccumulator => {
    const existing = modules.get(key);
    if (existing) {
      return existing;
    }
    const fresh: ModuleAccumulator = {
      key,
      total: 0,
      byUser: 0,
      recent: 0,
      bugMentions: 0,
      userCommits: [],
      reviewedPrs: new Set<number>(),
      reviewers: new Set<string>(),
      userReviewed: false,
      exampleReview: null,
      bugIssues: new Set<number>(),
    };
    modules.set(key, fresh);
    return fresh;
  };

  // Bug-labelled issues, per repo, for incident correlation. Only the label
  // rows are read: the titles and comment bodies allIssues() returns are not
  // used here, and they are the bulk of the index's text.
  const bugNumbersByRepo = new Map<string, Set<number>>();
  for (const { repo, number, label } of store.issueLabelRows()) {
    if (!BUG_LABEL_PATTERN.test(label)) {
      continue;
    }
    let numbers = bugNumbersByRepo.get(repo);
    if (!numbers) {
      numbers = new Set<number>();
      bugNumbersByRepo.set(repo, numbers);
    }
    numbers.add(number);
  }

  for (const commit of store.iterCommits()) {
    const repoBugs = bugNumbersByRepo.get(commit.repo);
    const referencedBugs = new Set<number>();
    if (repoBugs) {
      for (const match of commit.message.matchAll(/#(\d+)/g)) {
        const issueNumber = Number(match[1]);
        if (issueNumber > 0 && repoBugs.has(issueNumber)) {
          referencedBugs.add(issueNumber);
        }
      }
    }
    const authoredAtMs = Date.parse(commit.authoredAt);
    const isRecent = Number.isFinite(authoredAtMs) && authoredAtMs >= windowStartMs;
    // 'unknown' is the unattributed-author sentinel; even a login literally
    // named "unknown" must not fold unattributed commits into their ratio.
    const isUser = commit.authorLogin !== 'unknown' && sameLogin(commit.authorLogin, username);
    // Exclude 'unknown' authors from total: they are unattributed commits (e.g. email
    // patches, migrations) and would otherwise dilute sole-contribution ratios.
    // Bot logins are excluded for the same reason from the people-side math.
    const isKnownAuthor = commit.authorLogin !== 'unknown' && !isBotLogin(commit.authorLogin);
    // a commit touching several files of one module counts once, not per file
    const countedModules = new Set<string>();
    for (const file of commit.files) {
      const key = `${commit.repo}:${moduleOf(file.path)}`;
      if (countedModules.has(key)) {
        continue;
      }
      countedModules.add(key);
      const module = acc(key);
      if (isKnownAuthor) {
        module.total += 1;
        if (isRecent) {
          module.recent += 1;
        }
      }
      if (isUser) {
        module.byUser += 1;
        module.userCommits.push({
          sha: commit.sha,
          authoredAt: commit.authoredAt,
          message: commit.message,
        });
      }
      if (isUser && referencedBugs.size > 0) {
        module.bugMentions += 1;
        for (const issueNumber of referencedBugs) {
          module.bugIssues.add(issueNumber);
        }
      }
    }
  }

  // Review ownership: which reviewer covered each module's PRs. Counted per
  // distinct reviewer and distinct PR — one person approving the same PR twice
  // (approve → re-request → approve) is still one reviewer, not "all reviews".
  const prFiles = store.allPrFiles();
  for (const review of store.reviewerRows()) {
    const paths = prFiles.get(`${review.repo}#${review.prNumber}`);
    if (!paths) {
      continue;
    }
    const touchedModules = new Set(paths.map((path) => `${review.repo}:${moduleOf(path)}`));
    for (const key of touchedModules) {
      const module = acc(key);
      module.reviewedPrs.add(review.prNumber);
      module.reviewers.add(review.reviewerLogin.toLowerCase());
      if (sameLogin(review.reviewerLogin, username)) {
        module.userReviewed = true;
        module.exampleReview ??= { prNumber: review.prNumber, id: review.id };
      }
    }
  }

  // Normalization base: prefer recent activity; fall back to lifetime activity
  // when nothing happened inside the window (quiet repo). reduce, not
  // Math.max(...spread) — a huge monorepo index overflows the argument limit.
  const modulesList = [...modules.values()].filter((module) => module.byUser > 0);
  const maxRecent = modulesList.reduce((max, module) => Math.max(max, module.recent), 0);
  const useLifetime = maxRecent === 0;
  const maxLifetime = modulesList.reduce((max, module) => Math.max(max, module.total), 0);
  const normalizeBase = useLifetime ? maxLifetime : maxRecent;

  const items: RiskItem[] = modulesList.map((module) => {
    const ratio = module.total > 0 ? module.byUser / module.total : 0;
    const activity = useLifetime ? module.total : module.recent;
    const frequency = normalizeBase > 0 ? activity / normalizeBase : 0;
    const incidentWeight = 1 + Math.min(1, module.bugMentions / Math.max(1, module.total));
    const soleAuthor = module.byUser === module.total && module.total >= 3;
    // Sole coverage of a module's reviewed PRs needs at least two distinct PRs:
    // the threshold keeps a single review on a single PR from reading as
    // "irreplaceable", and distinctness keeps duplicate reviews on one PR from
    // faking depth of coverage.
    const soleReviewer = module.userReviewed && module.reviewers.size === 1 && module.reviewedPrs.size >= 2;
    const irreplaceability = 1 + (soleReviewer ? 0.5 : 0) + (soleAuthor ? 0.25 : 0);

    const factors: RiskFactor = {
      soleContributionRatio: ratio,
      changeFrequency: frequency,
      incidentWeight,
      irreplaceability,
    };

    const evidence: EvidenceRef[] = [];
    // module keys are "owner/name:module" — the repo prefix builds deep links.
    // Repos without the owner/name shape come from local git collection and
    // have no GitHub URL; their evidence stays link-less rather than broken.
    // indexOf without the `|| key` fallback: on a key with no colon it returns
    // -1 and slice(0, -1) would silently truncate the last character.
    const colon = module.key.indexOf(':');
    const repoSlug = colon === -1 ? module.key : module.key.slice(0, colon);
    const isGitHubRepo = /^[^/]+\/[^/]+$/.test(repoSlug);
    const githubUrl = (suffix: string): string | undefined =>
      isGitHubRepo ? `https://github.com/${repoSlug}${suffix}` : undefined;
    const recentCommits = [...module.userCommits]
      .sort((a, b) => b.authoredAt.localeCompare(a.authoredAt))
      .slice(0, 3);
    for (const commit of recentCommits) {
      evidence.push({
        kind: 'commit',
        ref: commit.sha.slice(0, 7),
        url: githubUrl(`/commit/${commit.sha}`),
        excerpt: firstLine(commit.message),
        repo: repoSlug,
      });
    }
    if (soleReviewer && module.exampleReview) {
      evidence.push({
        kind: 'review',
        ref: `#${module.exampleReview.prNumber} review:${module.exampleReview.id}`,
        url: githubUrl(`/pull/${module.exampleReview.prNumber}#pullrequestreview-${module.exampleReview.id}`),
        excerpt: `the only reviewer on all ${module.reviewedPrs.size} reviewed PRs touching this module was @${username}`,
        repo: repoSlug,
      });
    }
    for (const issueNumber of [...module.bugIssues].slice(0, 2)) {
      evidence.push({
        kind: 'issue',
        ref: `#${issueNumber}`,
        url: githubUrl(`/issues/${issueNumber}`),
        excerpt: 'bug-labelled issue referenced from this module',
        repo: repoSlug,
      });
    }

    const parts = [
      `@${username} authored ${module.byUser}/${module.total} commits (${Math.round(ratio * 100)}%) touching ${module.key}`,
    ];
    if (soleReviewer) {
      parts.push(`and was the sole reviewer on all ${module.reviewedPrs.size} reviewed PRs touching this module`);
    }
    if (module.bugMentions > 0) {
      const issueRefs = [...module.bugIssues].map((n) => `#${n}`).join(', ');
      parts.push(`${module.bugMentions} of those commits reference bug-labelled issues (${issueRefs})`);
    }
    parts.push(`recent activity score ${frequency.toFixed(2)} ${useLifetime ? '(lifetime, repo quiet in window)' : '(last ' + (options.windowDays ?? 90) + ' days)'}`);

    return {
      rank: 0,
      module: module.key,
      score: ratio * frequency * incidentWeight * irreplaceability,
      factors,
      evidence,
      rationale: `${parts.join('; ')}.`,
    };
  });

  items.sort(
    (a, b) => b.score - a.score || b.factors.soleContributionRatio - a.factors.soleContributionRatio || a.module.localeCompare(b.module),
  );
  return items.slice(0, topN).map((item, index) => ({ ...item, rank: index + 1 }));
}
