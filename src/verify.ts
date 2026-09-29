import { readFile } from 'node:fs/promises';
import type { HandoverStore } from './store/sqlite.js';

/**
 * Citation existence check for a rendered book: every commit sha, PR/issue
 * number and review id cited in the markdown must exist in the local index.
 * Refs may carry an explicit `owner/name` prefix (multi-repo books qualify
 * `#123` as `owner/name#123`); a prefixed ref that exists only in another
 * repository is reported as missing, because that is how cross-repo miscites
 * slip past a reader.
 */

export type VerifyKind = 'commit' | 'number' | 'review';

export interface VerifyRef {
  /** token exactly as found in the book, without brackets */
  raw: string;
  kind: VerifyKind;
  sha?: string;
  /** explicit owner/name prefix, when the citation carried one */
  repo?: string;
  number?: number;
  reviewId?: number;
  /** repositories in scope where the ref was found */
  foundIn: string[];
  ok: boolean;
}

export interface VerifyReport {
  file: string;
  repos: string[];
  checked: VerifyRef[];
  okCount: number;
  missingCount: number;
}

const COMMIT_TOKEN = /\[`?([0-9a-f]{7,40})`?\]/g;
const NUM_TOKEN = /\[`?([A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*)?#(\d+)(?:\s+review:(\d+))?`?\]/g;
// Bare review citations ("[review:456]") are the exact format the LLM system
// prompt instructs the model to emit, so they must be checked, not skipped.
const REVIEW_TOKEN = /\[`?([A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*)?\s*review:(\d+)`?\]/g;

interface FoundToken {
  raw: string;
  kind: VerifyKind;
  sha?: string;
  repo?: string;
  number?: number;
  reviewId?: number;
}

/** Extracts citation tokens from rendered book markdown (appendix links included). */
export function extractCitations(markdown: string): FoundToken[] {
  const tokens = new Map<string, FoundToken>();
  for (const match of markdown.matchAll(COMMIT_TOKEN)) {
    const sha = match[1] ?? '';
    if (!sha) {
      continue;
    }
    if (!tokens.has(sha)) {
      tokens.set(sha, { raw: sha, kind: 'commit', sha });
    }
  }
  for (const match of markdown.matchAll(NUM_TOKEN)) {
    const repo = match[1];
    const number = Number(match[2]);
    const reviewId = match[3] ? Number(match[3]) : undefined;
    const raw = repo ? `${repo}#${number}${reviewId ? ` review:${reviewId}` : ''}` : `#${number}${reviewId ? ` review:${reviewId}` : ''}`;
    if (!tokens.has(raw)) {
      tokens.set(raw, {
        raw,
        kind: reviewId ? 'review' : 'number',
        repo,
        number,
        reviewId,
      });
    }
  }
  for (const match of markdown.matchAll(REVIEW_TOKEN)) {
    const repo = match[1];
    const reviewId = Number(match[2]);
    const raw = repo ? `${repo} review:${reviewId}` : `review:${reviewId}`;
    if (!tokens.has(raw)) {
      tokens.set(raw, { raw, kind: 'review', repo, reviewId });
    }
  }
  return [...tokens.values()];
}

function reposInScope(store: HandoverStore): string[] {
  const recorded = (store.getMeta('repos') ?? '')
    .split(',')
    .map((repo) => repo.trim())
    .filter(Boolean);
  if (recorded.length > 0) {
    return recorded;
  }
  const seen = new Set<string>();
  for (const commit of store.allCommits()) {
    seen.add(commit.repo);
  }
  for (const pr of store.allPullRequests()) {
    seen.add(pr.repo);
  }
  return [...seen];
}

/** Checks each extracted citation against the index. */
export function verifyCitations(store: HandoverStore, file: string, markdown: string): VerifyReport {
  const repos = reposInScope(store);
  const reviews = store.allReviews();
  // Books cite short shas (7 chars); the index stores full ones — match by prefix.
  const shasByRepo = new Map<string, string[]>();
  for (const commit of store.allCommits()) {
    const shas = shasByRepo.get(commit.repo) ?? [];
    shas.push(commit.sha);
    shasByRepo.set(commit.repo, shas);
  }
  const hasCommitPrefix = (repo: string, short: string): boolean =>
    (shasByRepo.get(repo) ?? []).some((sha) => sha.startsWith(short));

  const checked = extractCitations(markdown).map<VerifyRef>((token) => {
    const candidates = token.repo ? [token.repo] : repos;
    const foundIn: string[] = [];
    for (const repo of candidates) {
      let found = false;
      switch (token.kind) {
        case 'commit':
          found = token.sha !== undefined && hasCommitPrefix(repo, token.sha);
          break;
        case 'number':
          found = token.number !== undefined && (store.hasPullRequest(repo, token.number) || store.hasIssue(repo, token.number));
          break;
        case 'review':
          found =
            token.reviewId !== undefined &&
            reviews.some((review) => review.repo === repo && review.id === token.reviewId && (token.number === undefined || review.prNumber === token.number));
          break;
      }
      if (found) {
        foundIn.push(repo);
      }
    }
    return { ...token, foundIn, ok: foundIn.length > 0 };
  });

  return {
    file,
    repos,
    checked,
    okCount: checked.filter((ref) => ref.ok).length,
    missingCount: checked.filter((ref) => !ref.ok).length,
  };
}

export async function readBookFile(file: string): Promise<string> {
  return readFile(file, 'utf8');
}
