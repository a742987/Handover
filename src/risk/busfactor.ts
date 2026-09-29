import { moduleOf, isBotLogin } from './engine.js';
import { codeownersMetaKey, ownersFor, parseCodeowners } from '../collect/codeowners.js';
import type { HandoverStore } from '../store/sqlite.js';

const DAY_MS = 86_400_000;

export interface BusFactorOptions {
  now?: Date;
  /** look-back window marking a module as still active, in days (default 90) */
  windowDays?: number;
  topN?: number;
}

export type BusFactorStatus = 'critical' | 'fragile' | 'shared';

export interface BusFactorItem {
  /** "repo:module" key */
  module: string;
  distinctAuthors: number;
  totalCommits: number;
  topAuthor: string;
  topAuthorShare: number;
  status: BusFactorStatus;
  recent: boolean;
  /** CODEOWNERS owners for a representative path, when the repo has a CODEOWNERS file */
  owners: string[];
}

/**
 * Team-level view of the same evidence the risk engine uses: for every module,
 * how many people actually commit to it and how concentrated that is.
 * critical = exactly one author ever; fragile = two authors and the top one
 * holds ≥70% of the commits.
 */
export function computeBusFactor(store: HandoverStore, options: BusFactorOptions = {}): BusFactorItem[] {
  const now = options.now ?? new Date();
  const windowStartMs = now.getTime() - (options.windowDays ?? 90) * DAY_MS;

  interface Acc {
    byAuthor: Map<string, number>;
    total: number;
    recent: boolean;
    samplePath: string;
  }
  const modules = new Map<string, Acc>();
  const rulesByRepo = new Map<string, ReturnType<typeof parseCodeowners>>();

  for (const commit of store.allCommits()) {
    if (commit.authorLogin === 'unknown' || isBotLogin(commit.authorLogin)) {
      continue;
    }
    const authoredAtMs = Date.parse(commit.authoredAt);
    const isRecent = Number.isFinite(authoredAtMs) && authoredAtMs >= windowStartMs;
    const counted = new Set<string>();
    for (const file of commit.files) {
      const key = `${commit.repo}:${moduleOf(file.path)}`;
      if (counted.has(key)) {
        continue;
      }
      counted.add(key);
      let acc = modules.get(key);
      if (!acc) {
        acc = { byAuthor: new Map<string, number>(), total: 0, recent: false, samplePath: file.path };
        modules.set(key, acc);
      }
      acc.total += 1;
      acc.byAuthor.set(commit.authorLogin, (acc.byAuthor.get(commit.authorLogin) ?? 0) + 1);
      if (isRecent) {
        acc.recent = true;
      }
    }
  }

  const items: BusFactorItem[] = [];
  for (const [key, acc] of modules) {
    const repo = key.slice(0, key.indexOf(':')) || key;
    let topAuthor = '';
    let topCount = 0;
    for (const [author, count] of acc.byAuthor) {
      if (count > topCount) {
        topAuthor = author;
        topCount = count;
      }
    }
    let rules = rulesByRepo.get(repo);
    if (rules === undefined) {
      const text = store.getMeta(codeownersMetaKey(repo));
      rules = text ? parseCodeowners(text) : [];
      rulesByRepo.set(repo, rules);
    }
    const share = acc.total > 0 ? topCount / acc.total : 0;
    const status: BusFactorStatus =
      acc.byAuthor.size <= 1 ? 'critical' : acc.byAuthor.size === 2 && share >= 0.7 ? 'fragile' : 'shared';
    items.push({
      module: key,
      distinctAuthors: acc.byAuthor.size,
      totalCommits: acc.total,
      topAuthor,
      topAuthorShare: share,
      status,
      recent: acc.recent,
      owners: ownersFor(rules, acc.samplePath),
    });
  }

  const order: Record<BusFactorStatus, number> = { critical: 0, fragile: 1, shared: 2 };
  items.sort(
    (a, b) =>
      order[a.status] - order[b.status] ||
      a.distinctAuthors - b.distinctAuthors ||
      b.topAuthorShare - a.topAuthorShare ||
      a.module.localeCompare(b.module),
  );
  return items.slice(0, options.topN ?? items.length);
}
