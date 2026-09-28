import type { EvidenceRef, RiskFactor, RiskItem } from '../types.js';
import type { HandoverStore } from '../store/sqlite.js';

const DAY_MS = 86_400_000;

const BUG_LABEL_PATTERN = /bug|incident|regression|outage|crash/i;

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
  reviewTotal: number;
  userReviews: number;
  exampleReview: { prNumber: number; id: number } | null;
  bugIssues: Set<number>;
}

export function firstLine(text: string, max = 120): string {
  const line = text.split('\n')[0] ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
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
      reviewTotal: 0,
      userReviews: 0,
      exampleReview: null,
      bugIssues: new Set<number>(),
    };
    modules.set(key, fresh);
    return fresh;
  };

  // Bug-labelled issues, per repo, for incident correlation.
  const bugNumbersByRepo = new Map<string, Set<number>>();
  for (const issue of store.allIssues()) {
    if (!issue.labels.some((label) => BUG_LABEL_PATTERN.test(label))) {
      continue;
    }
    let numbers = bugNumbersByRepo.get(issue.repo);
    if (!numbers) {
      numbers = new Set<number>();
      bugNumbersByRepo.set(issue.repo, numbers);
    }
    numbers.add(issue.number);
  }

  const commits = store.allCommits();
  for (const commit of commits) {
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
    const isUser = commit.authorLogin === username;
    // Exclude 'unknown' authors from total: they are unattributed commits (e.g. email
    // patches, migrations) and would otherwise dilute sole-contribution ratios.
    const isKnownAuthor = commit.authorLogin !== 'unknown';
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

  // Review ownership: which reviewer covered each module's PRs.
  const prFiles = store.allPrFiles();
  const reviews = store.allReviews();
  for (const review of reviews) {
    const paths = prFiles.get(`${review.repo}#${review.prNumber}`);
    if (!paths) {
      continue;
    }
    const touchedModules = new Set(paths.map((path) => `${review.repo}:${moduleOf(path)}`));
    for (const key of touchedModules) {
      const module = acc(key);
      module.reviewTotal += 1;
      if (review.reviewerLogin === username) {
        module.userReviews += 1;
        module.exampleReview = { prNumber: review.prNumber, id: review.id };
      }
    }
  }

  // Normalization base: prefer recent activity; fall back to lifetime activity
  // when nothing happened inside the window (quiet repo).
  const modulesList = [...modules.values()].filter((module) => module.byUser > 0);
  const maxRecent = Math.max(0, ...modulesList.map((module) => module.recent));
  const useLifetime = maxRecent === 0;
  const maxLifetime = Math.max(0, ...modulesList.map((module) => module.total));
  const normalizeBase = useLifetime ? maxLifetime : maxRecent;

  const items: RiskItem[] = modulesList.map((module) => {
    const ratio = module.total > 0 ? module.byUser / module.total : 0;
    const activity = useLifetime ? module.total : module.recent;
    const frequency = normalizeBase > 0 ? activity / normalizeBase : 0;
    const incidentWeight = 1 + Math.min(1, module.bugMentions / Math.max(1, module.total));
    const soleAuthor = module.byUser === module.total && module.total >= 3;
    const soleReviewer = module.reviewTotal >= 2 && module.userReviews === module.reviewTotal;
    const irreplaceability = 1 + (soleReviewer ? 0.5 : 0) + (soleAuthor ? 0.25 : 0);

    const factors: RiskFactor = {
      soleContributionRatio: ratio,
      changeFrequency: frequency,
      incidentWeight,
      irreplaceability,
    };

    const evidence: EvidenceRef[] = [];
    // module keys are "owner/name:module" — the repo prefix builds deep links
    const repoSlug = module.key.slice(0, module.key.indexOf(':')) || module.key;
    const recentCommits = [...module.userCommits]
      .sort((a, b) => b.authoredAt.localeCompare(a.authoredAt))
      .slice(0, 3);
    for (const commit of recentCommits) {
      evidence.push({
        kind: 'commit',
        ref: commit.sha.slice(0, 7),
        url: `https://github.com/${repoSlug}/commit/${commit.sha}`,
        excerpt: firstLine(commit.message),
      });
    }
    if (soleReviewer && module.exampleReview) {
      evidence.push({
        kind: 'review',
        ref: `#${module.exampleReview.prNumber} review:${module.exampleReview.id}`,
        url: `https://github.com/${repoSlug}/pull/${module.exampleReview.prNumber}#pullrequestreview-${module.exampleReview.id}`,
        excerpt: `all ${module.reviewTotal} reviews on this module's PRs were by @${username}`,
      });
    }
    for (const issueNumber of [...module.bugIssues].slice(0, 2)) {
      evidence.push({
        kind: 'issue',
        ref: `#${issueNumber}`,
        url: `https://github.com/${repoSlug}/issues/${issueNumber}`,
        excerpt: 'bug-labelled issue referenced from this module',
      });
    }

    const parts = [
      `@${username} authored ${module.byUser}/${module.total} commits (${Math.round(ratio * 100)}%) touching ${module.key}`,
    ];
    if (soleReviewer) {
      parts.push(`and was the sole reviewer on all ${module.reviewTotal} reviews of its PRs`);
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
