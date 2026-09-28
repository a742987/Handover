import { firstLine } from './risk/engine.js';
import type { HandoverStore } from './store/sqlite.js';

export type SearchKind = 'commit' | 'pr' | 'review' | 'issue' | 'comment';

export interface SearchFilter {
  /** free-text match against messages, titles and bodies (case-insensitive substring) */
  query?: string;
  kind?: SearchKind | 'all';
  /** restrict to one author login; omit to search everyone in the index */
  author?: string;
  /** ISO date; only activity at/after this point */
  since?: string;
  /** "owner/name" restriction */
  repo?: string;
  limit?: number;
}

export interface SearchResultItem {
  kind: SearchKind;
  repo: string;
  /** short sha, or "#123", "review:456", "comment:789" */
  ref: string;
  author: string;
  date: string | null;
  excerpt: string;
  url?: string;
}

function githubUrl(kind: SearchKind, repo: string, ref: string): string | undefined {
  if (!/^[^/]+\/[^/]+$/.test(repo)) {
    return undefined;
  }
  switch (kind) {
    case 'commit':
      return `https://github.com/${repo}/commit/${ref}`;
    case 'pr':
      return `https://github.com/${repo}/pull/${ref.slice(1)}`;
    case 'issue':
      return `https://github.com/${repo}/issues/${ref.slice(1)}`;
    default:
      return undefined;
  }
}

/**
 * Read-only evidence search over the local index — what the MCP tool uses to
 * let an agent answer follow-up questions like "what did she say about the
 * queue?" without any network access.
 */
export function searchIndex(store: HandoverStore, filter: SearchFilter = {}): { count: number; results: SearchResultItem[] } {
  const query = filter.query?.toLowerCase() ?? '';
  const author = filter.author?.toLowerCase();
  const kind = filter.kind ?? 'all';
  const limit = Math.max(1, Math.min(200, filter.limit ?? 20));
  const items: SearchResultItem[] = [];

  const matches = (text: string, when: string | null, who: string): boolean => {
    if (author && who.toLowerCase() !== author) {
      return false;
    }
    if (filter.since && when && when < filter.since) {
      return false;
    }
    if (query && !text.toLowerCase().includes(query)) {
      return false;
    }
    return true;
  };

  const repoAllowed = (repo: string): boolean => {
    if (!filter.repo) {
      return true;
    }
    if (repo === filter.repo) {
      return true;
    }
    // A bare name ("api") may match "owner/api" — but "acme/api" must never
    // match a second owner's repo with the same basename.
    return !filter.repo.includes('/') && repo.split('/').pop() === filter.repo;
  };

  if (kind === 'all' || kind === 'commit') {
    for (const commit of store.allCommits()) {
      if (!repoAllowed(commit.repo) || !matches(commit.message, commit.authoredAt, commit.authorLogin)) {
        continue;
      }
      items.push({
        kind: 'commit',
        repo: commit.repo,
        ref: commit.sha.slice(0, 7),
        author: commit.authorLogin,
        date: commit.authoredAt,
        excerpt: firstLine(commit.message, 300),
        url: githubUrl('commit', commit.repo, commit.sha),
      });
    }
  }
  if (kind === 'all' || kind === 'pr') {
    for (const pr of store.allPullRequests()) {
      const text = `${pr.title}\n${pr.body}`;
      if (!repoAllowed(pr.repo) || !matches(text, pr.createdAt, pr.authorLogin)) {
        continue;
      }
      items.push({
        kind: 'pr',
        repo: pr.repo,
        ref: `#${pr.number}`,
        author: pr.authorLogin,
        date: pr.createdAt,
        excerpt: firstLine(pr.title, 300),
        url: githubUrl('pr', pr.repo, `#${pr.number}`),
      });
    }
  }
  if (kind === 'all' || kind === 'review' || kind === 'comment') {
    for (const review of store.allReviews()) {
      if ((kind === 'all' || kind === 'review') && repoAllowed(review.repo) && matches(review.body, review.submittedAt, review.reviewerLogin)) {
        items.push({
          kind: 'review',
          repo: review.repo,
          ref: `review:${review.id}`,
          author: review.reviewerLogin,
          date: review.submittedAt,
          excerpt: firstLine(review.body || review.state, 300),
          url: githubUrl('pr', review.repo, `#${review.prNumber}`),
        });
      }
      // Inline, per-path review comments are the most substantive text in a
      // review — searchable alongside issue/PR conversation comments.
      if (kind === 'all' || kind === 'comment') {
        for (const comment of review.comments) {
          if (!repoAllowed(review.repo) || !matches(comment.body, review.submittedAt, comment.authorLogin)) {
            continue;
          }
          items.push({
            kind: 'comment',
            repo: review.repo,
            ref: `#${review.prNumber} review:${review.id} comment:${comment.id}`,
            author: comment.authorLogin,
            date: review.submittedAt,
            excerpt: firstLine(comment.body, 300),
            url: githubUrl('pr', review.repo, `#${review.prNumber}`),
          });
        }
      }
    }
  }
  if (kind === 'all' || kind === 'issue' || kind === 'comment') {
    for (const issue of store.allIssues()) {
      const isPr = issue.isPullRequest;
      if (kind === 'issue' && isPr) {
        continue;
      }
      if ((kind === 'all' || kind === 'issue') && repoAllowed(issue.repo) && matches(issue.title, issue.createdAt, issue.authorLogin)) {
        items.push({
          kind: isPr ? 'pr' : 'issue',
          repo: issue.repo,
          ref: `#${issue.number}`,
          author: issue.authorLogin,
          date: issue.createdAt,
          excerpt: firstLine(issue.title, 300),
          url: githubUrl(isPr ? 'pr' : 'issue', issue.repo, `#${issue.number}`),
        });
      }
      if (kind === 'all' || kind === 'comment') {
        for (const comment of issue.comments) {
          if (!repoAllowed(issue.repo) || !matches(comment.body, comment.createdAt, comment.authorLogin)) {
            continue;
          }
          items.push({
            kind: 'comment',
            repo: issue.repo,
            ref: `#${issue.number} comment:${comment.id}`,
            author: comment.authorLogin,
            date: comment.createdAt,
            excerpt: firstLine(comment.body, 300),
            url: githubUrl(isPr ? 'pr' : 'issue', issue.repo, `#${issue.number}`),
          });
        }
      }
    }
  }

  // PRs live in both pull_requests and the mirrored issue namespace — report each once
  const seen = new Set<string>();
  const unique = items.filter((item) => {
    const key = `${item.kind}:${item.repo}:${item.ref}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });

  unique.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
  return { count: unique.length, results: unique.slice(0, limit) };
}
