import { Octokit } from '@octokit/rest';
import { codeownersMetaKey } from './codeowners.js';
import { markCollectionSource } from '../report/summary.js';
import type {
  CommentRecord,
  CommitRecord,
  IssueRecord,
  PullRequestRecord,
  ReviewCommentRecord,
  ReviewRecord,
} from '../types.js';
import type { HandoverStore } from '../store/sqlite.js';

export interface CollectOptions {
  /** ISO date; only activity created after this is collected */
  since?: string;
  /** re-fetch commit details even when the SHA is already indexed */
  refresh?: boolean;
  /**
   * Repo names collected from other sources (e.g. local git dirs) that run in
   * the same pipeline. The orphan cleanup at the start of collection must not
   * treat them as orphans, or their evidence gets wiped.
   */
  preserveRepos?: string[];
  onProgress?: (message: string) => void;
}

/** Parallel detail fetches per repo; commit details are one request per commit. */
const DETAIL_CONCURRENCY = 8;

const MAX_REQUEST_ATTEMPTS = 4;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Network/system error codes that mean "the request never reached GitHub". */
const TRANSIENT_CODE_RE = /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|UND_ERR|ERR_SOCKET)/;
const TRANSIENT_MESSAGE_RE = /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|socket hang up|premature close|fetch failed|network error|timeout/i;

/** True for failures worth retrying: abuse limits (403/429), transient 5xx, and connection-level drops. */
function isRetryable(error: unknown): boolean {
  const status = (error as { status?: number }).status ?? 0;
  const message = error instanceof Error ? error.message : String(error);
  if (status === 429 || status >= 500) {
    return true;
  }
  // GitHub abuse detection ("You have triggered an abuse detection mechanism") often comes with Retry-After
  if (status === 403 && /rate limit|secondary rate|abuse/i.test(message)) {
    return true;
  }
  // A missing HTTP status means the request failed below the HTTP layer
  // (ECONNRESET, ETIMEDOUT, DNS, socket hang up) — the most common transient
  // failure class on long collect runs, and the reason a run would otherwise
  // abort mid-way with no retry at all.
  if (status === 0) {
    const causeCode = (error as { cause?: { code?: string } }).cause?.code ?? '';
    if (TRANSIENT_CODE_RE.test(causeCode) || TRANSIENT_MESSAGE_RE.test(message)) {
      return true;
    }
  }
  return false;
}

function retryDelayMs(error: unknown, attempt: number): number {
  const headers = (error as { response?: { headers?: Record<string, unknown> } }).response?.headers;
  const retryAfter = Number(headers?.['retry-after']);
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1000, 60_000);
  }
  return Math.min(1000 * 2 ** attempt, 30_000);
}

export interface CollectResult {
  /** GitHub-side canonical login for the collected user (logins are case-insensitive) */
  login: string;
  indexedCommits: number;
  skippedCommits: number;
  pullRequests: number;
  skippedPullRequests: number;
  reviews: number;
  issues: number;
  skippedIssues: number;
}

interface RepoSlug {
  owner: string;
  repo: string;
}

export function parseRepoSlug(fullName: string): RepoSlug {
  const parts = fullName.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid repository "${fullName}" — expected "owner/name"`);
  }
  // GitHub repos are case-insensitive; one canonical key keeps "Acme/API" and
  // "acme/api" from being collected (and counted) as two repositories.
  return { owner: parts[0].toLowerCase(), repo: parts[1].toLowerCase() };
}

/** Adds a hint for the two failures users actually hit: bad token and rate limits. */
function explainGitHubError(error: unknown): Error {
  const status = (error as { status?: number }).status;
  const message = error instanceof Error ? error.message : String(error);
  if (status === 401) {
    return new Error(`GitHub rejected the credentials (401) — check that GITHUB_TOKEN is valid. (${message})`);
  }
  if (status === 403 && /rate limit/i.test(message)) {
    return new Error(
      `GitHub rate limit exceeded (403). Set GITHUB_TOKEN to raise the limit from 60 to 5000 requests/hour. (${message})`,
    );
  }
  return error instanceof Error ? error : new Error(message);
}

/**
 * Collects everything a person committed, reviewed, and argued about — plus
 * the team-wide activity needed to compute sole-contribution ratios (§3.4).
 * Everything lands in the SQLite index so second runs are near-instant.
 */
export class GitHubCollector {
  private readonly octokit: Octokit;
  private readonly octokitTokenWasProvided: boolean;

  constructor(token: string, octokit?: Octokit) {
    this.octokitTokenWasProvided = token.trim().length > 0;
    this.octokit =
      octokit ??
      new Octokit({
        auth: token || undefined,
        userAgent: 'handover-book',
        // GitHub Enterprise Server: GITHUB_API_URL is the variable GitHub's own
        // Actions runtime sets, so CI-picked-up config "just works" locally too.
        ...(process.env.GITHUB_API_URL ? { baseUrl: process.env.GITHUB_API_URL } : {}),
      });
    this.installRequestBackoff();
  }

  /**
   * Retries every GitHub request through the request hook — pagination and
   * detail fetches alike — with exponential backoff plus Retry-After support.
   * A large --refresh run then degrades slowly instead of aborting mid-way.
   */
  private installRequestBackoff(): void {
    const hookable = this.octokit as unknown as {
      hook?: {
        wrap?: (
          name: string,
          handler: (request: (options: unknown) => Promise<unknown>, options: unknown) => Promise<unknown>,
        ) => void;
      };
    };
    hookable.hook?.wrap?.('request', async (request, options) => {
      let lastError: unknown;
      for (let attempt = 1; attempt <= MAX_REQUEST_ATTEMPTS; attempt += 1) {
        try {
          return await request(options);
        } catch (error) {
          lastError = error;
          if (!isRetryable(error) || attempt === MAX_REQUEST_ATTEMPTS) {
            break;
          }
          await sleep(retryDelayMs(error, attempt));
        }
      }
      throw lastError;
    });
  }

  async collectInto(
    store: HandoverStore,
    username: string,
    repos: string[],
    options: CollectOptions = {},
  ): Promise<CollectResult> {
    if (!this.octokitTokenWasProvided) {
      options.onProgress?.(
        'warning: no GITHUB_TOKEN set — unauthenticated requests are limited to 60/hour and private repos are invisible.',
      );
    }
    try {
      return await this.collectIntoInner(store, username, repos, options);
    } catch (error) {
      throw explainGitHubError(error);
    }
  }

  private async collectIntoInner(
    store: HandoverStore,
    username: string,
    repos: string[],
    options: CollectOptions,
  ): Promise<CollectResult> {
    const progress = options.onProgress ?? (() => {});
    const login = await this.resolveLogin(username);
    progress(`GitHub user resolved as @${login}`);

    const result: CollectResult = {
      login,
      indexedCommits: 0,
      skippedCommits: 0,
      pullRequests: 0,
      skippedPullRequests: 0,
      reviews: 0,
      issues: 0,
      skippedIssues: 0,
    };

    // Clear orphan data from repos not in the current collection scope. Repos
    // collected from other sources (local git dirs, collected later in the same
    // run) must be part of that scope or their rows are wiped with no warning.
    // Repo rows are keyed by the lowercased slug, so the scope must be
    // normalized the same way — SQLite's NOT IN is case-sensitive, and a
    // mixed-case `-r Acme/API` would otherwise wipe everything collected as
    // `acme/api` and re-fetch it from scratch.
    const scope = [
      ...new Set(
        repos.map((fullName) => {
          const { owner, repo } = parseRepoSlug(fullName);
          return `${owner}/${repo}`;
        }),
      ),
    ];
    const preserveRepos = options.preserveRepos ?? [];
    store.clearRepositoriesExcept([...scope, ...preserveRepos]);

    for (const fullName of scope) {
      const { owner, repo } = parseRepoSlug(fullName);
      const name = `${owner}/${repo}`;
      progress(`Collecting ${name} …`);
      await this.collectCommits(store, owner, repo, options, result);
      await this.collectPullRequests(store, owner, repo, options, result);
      await this.collectIssues(store, owner, repo, options, result);
      const codeowners = await this.fetchCodeowners(owner, repo, options.onProgress);
      if (codeowners !== null) {
        store.setMeta(codeownersMetaKey(name), codeowners);
      }
    }

    store.setMeta('last_collected_at', new Date().toISOString());
    store.setMeta('collected_for', login);
    markCollectionSource(store, 'github');
    // The orphan cleanup above wiped everything outside scope ∪ preserve, so
    // the recorded repo list must match exactly that — keeping stale entries
    // would leave the book citing repos with no data behind them.
    store.setMeta('repos', [...new Set([...scope, ...preserveRepos])].join(','));
    return result;
  }

  private async resolveLogin(username: string): Promise<string> {
    try {
      const response = await this.octokit.users.getByUsername({ username });
      return response.data.login ?? username;
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 404) {
        throw new Error(`GitHub user "${username}" not found`);
      }
      throw error;
    }
  }

  /**
   * Best-effort CODEOWNERS fetch (feeds the bus-factor view): the first of the
   * three documented locations wins; missing files, 404s and API stubs all
   * just mean "no ownership metadata for this repo". A 403/429 is different —
   * it means the API refused the request, and silently treating that as "no
   * CODEOWNERS" would make ownership data vanish mid-run.
   */
  private async fetchCodeowners(owner: string, repo: string, onProgress?: (message: string) => void): Promise<string | null> {
    for (const candidate of ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS']) {
      try {
        const response = await this.octokit.rest.repos.getContent({ owner, repo, path: candidate });
        const data = response.data as { content?: string; encoding?: string };
        if (typeof data.content === 'string' && (data.encoding ?? 'base64') === 'base64') {
          return Buffer.from(data.content, 'base64').toString('utf8');
        }
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (status === 403 || status === 429) {
          onProgress?.(`warning: CODEOWNERS check for ${owner}/${repo} failed (HTTP ${status}) — bus-factor ownership data may be missing for this repo.`);
        }
        // try the next candidate
      }
    }
    return null;
  }

  private async *paginate<T>(route: 'listCommits' | 'listPullRequests' | 'listIssues', slug: RepoSlug, since?: string): AsyncGenerator<T> {
    const { owner, repo } = slug;
    if (route === 'listCommits') {
      for await (const { data } of this.octokit.paginate.iterator(this.octokit.rest.repos.listCommits, {
        owner,
        repo,
        since,
        per_page: 100,
      })) {
        for (const item of data as unknown as T[]) {
          yield item;
        }
      }
      return;
    }
    if (route === 'listPullRequests') {
      for await (const { data } of this.octokit.paginate.iterator(this.octokit.rest.pulls.list, {
        owner,
        repo,
        state: 'all',
        sort: 'created',
        direction: 'desc',
        per_page: 100,
      })) {
        for (const item of data as unknown as T[]) {
          yield item;
        }
      }
      return;
    }
    for await (const { data } of this.octokit.paginate.iterator(this.octokit.rest.issues.list, {
      owner,
      repo,
      state: 'all',
      sort: 'created',
      direction: 'desc',
      per_page: 100,
    })) {
      for (const item of data as unknown as T[]) {
        yield item;
      }
    }
  }

  private async collectCommits(
    store: HandoverStore,
    owner: string,
    repo: string,
    options: CollectOptions,
    result: CollectResult,
  ): Promise<void> {
    const name = `${owner}/${repo}`;
    const pending: Array<{ sha: string; authorLogin: string; authoredAt?: string; message?: string }> = [];
    const seenShas: string[] = [];
    let listingComplete = false;
    try {
      for await (const item of this.paginate<{ sha?: string; author?: { login?: string } | null; commit?: { author?: { date?: string }; message?: string } }>(
        'listCommits',
        { owner, repo },
        options.since,
      )) {
        const sha = item.sha ?? '';
        if (!sha) {
          continue;
        }
        seenShas.push(sha);
        if (!options.refresh && store.hasCommit(name, sha)) {
          result.skippedCommits += 1;
          continue;
        }
        pending.push({
          sha,
          authorLogin: item.author?.login ?? 'unknown',
          authoredAt: item.commit?.author?.date,
          message: item.commit?.message,
        });
      }
      // Without a --since filter the pagination covered the repo's full default
      // branch — anything in the index but not in this listing no longer exists
      // upstream (force-push, history rewrite) and would otherwise haunt the
      // risk ratios forever. A --since listing is partial, so pruning there
      // would delete valid older history.
      listingComplete = !options.since;
    } catch (error) {
      // An empty repository fails the commit listing itself — nothing to collect.
      if ((error as { status?: number }).status === 409) {
        return;
      }
      throw error;
    }
    if (listingComplete) {
      store.pruneCommitsNotSeen(name, seenShas);
    }

    // Commit details are one request per commit; bounded concurrency keeps
    // large repos from crawling while staying polite to the API.
    let next = 0;
    let done = 0;
    let firstError: unknown = null;
    const worker = async (): Promise<void> => {
      while (next < pending.length) {
        if (firstError !== null) {
          return; // stop taking new work; other workers finish their current commit
        }
        const item = pending[next++]!;
        try {
          const detail = await this.octokit.rest.repos.getCommit({ owner, repo, ref: item.sha });
          // repos.getCommit returns at most 300 files with no pagination — for
          // the rare commit above that, files beyond the cap are invisible and
          // under-attribute its modules. `stats` still covers the whole commit.
          const files = (detail.data.files ?? [])
            .filter((file) => typeof file.filename === 'string')
            .map((file) => ({
              path: file.filename as string,
              additions: file.additions ?? 0,
              deletions: file.deletions ?? 0,
            }));
          const commit: CommitRecord = {
            sha: item.sha,
            repo: name,
            authorLogin: item.authorLogin,
            // An unknown date must not be fabricated as "now" — that would drop
            // the commit into the recent-activity window and inflate its risk.
            // Empty string sorts oldest and never reads as recent.
            authoredAt: item.authoredAt ?? detail.data.commit.author?.date ?? '',
            message: item.message ?? detail.data.commit.message ?? '',
            additions: detail.data.stats?.additions ?? files.reduce((sum, file) => sum + file.additions, 0),
            deletions: detail.data.stats?.deletions ?? files.reduce((sum, file) => sum + file.deletions, 0),
            files,
          };
          store.upsertCommit(commit);
          result.indexedCommits += 1;
          done += 1;
          if (done % 50 === 0) {
            options.onProgress?.(`  indexed ${done} new commits in ${name} …`);
          }
        } catch (error) {
          firstError ??= error;
          return;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(DETAIL_CONCURRENCY, pending.length) }, worker));
    if (firstError !== null) {
      throw firstError;
    }
  }

  private async collectPullRequests(
    store: HandoverStore,
    owner: string,
    repo: string,
    options: CollectOptions,
    result: CollectResult,
  ): Promise<void> {
    const name = `${owner}/${repo}`;
    const seenNumbers: number[] = [];
    for await (const pr of this.paginate<{
      number?: number;
      title?: string;
      user?: { login?: string } | null;
      state?: string;
      created_at?: string;
      updated_at?: string;
      closed_at?: string | null;
      merged_at?: string | null;
      body?: string | null;
      head?: { sha?: string } | null;
      additions?: number;
      deletions?: number;
      changed_files?: number;
    }>('listPullRequests', { owner, repo })) {
      const number = pr.number;
      if (number === undefined) {
        continue;
      }
      seenNumbers.push(number);
      const createdAt = pr.created_at ?? '';
      if (options.since && createdAt < options.since) {
        // PRs are listed newest-first by creation, so every later page is older too.
        break;
      }
      const updatedAt = pr.updated_at ?? null;
      const headSha = pr.head?.sha ?? null;
      // Unlike commits, PRs change over time (merge state, reviews, comments all
      // bump updated_at; new commits push head.sha without bumping updated_at) —
      // skip only when the cached row is still current on both axes.
      if (!options.refresh && store.hasPullRequest(name, number, updatedAt ?? undefined, headSha ?? undefined)) {
        result.skippedPullRequests += 1;
        continue;
      }
      // pulls.list items carry no additions/deletions/changed_files — sum them
      // from the file pages fetched below instead of persisting zeros. (The
      // pagination caps at 3,000 files per PR, so larger PRs under-count.)
      const paths: string[] = [];
      let additions = 0;
      let deletions = 0;
      for await (const { data: filePage } of this.octokit.paginate.iterator(this.octokit.rest.pulls.listFiles, {
        owner,
        repo,
        pull_number: number,
        per_page: 100,
      })) {
        for (const file of filePage) {
          if (typeof file.filename === 'string') {
            paths.push(file.filename);
          }
          additions += file.additions ?? 0;
          deletions += file.deletions ?? 0;
        }
      }

      const record: PullRequestRecord = {
        repo: name,
        number,
        title: pr.title ?? '',
        authorLogin: pr.user?.login ?? 'unknown',
        state: pr.state ?? 'unknown',
        createdAt,
        updatedAt,
        headSha,
        mergedAt: pr.merged_at ?? null,
        body: pr.body ?? '',
        additions,
        deletions,
        changedFiles: paths.length,
      };

      const reviewCommentsByReview = new Map<number, ReviewCommentRecord[]>();
      for await (const { data: commentPage } of this.octokit.paginate.iterator(
        this.octokit.rest.pulls.listReviewComments,
        { owner, repo, pull_number: number, per_page: 100 },
      )) {
        for (const comment of commentPage) {
          const reviewId = comment.pull_request_review_id;
          if (reviewId === null || reviewId === undefined) {
            continue;
          }
          const list = reviewCommentsByReview.get(reviewId) ?? [];
          list.push({
            id: comment.id,
            reviewId,
            path: comment.path ?? '',
            body: comment.body ?? '',
            authorLogin: comment.user?.login ?? 'unknown',
          });
          reviewCommentsByReview.set(reviewId, list);
        }
      }

      const reviewRecords: ReviewRecord[] = [];
      const reviewIdsSeen = new Set<number>();
      for await (const { data: reviewPage } of this.octokit.paginate.iterator(this.octokit.rest.pulls.listReviews, {
        owner,
        repo,
        pull_number: number,
        per_page: 100,
      })) {
        for (const review of reviewPage) {
          reviewIdsSeen.add(review.id);
          reviewRecords.push({
            id: review.id,
            repo: name,
            prNumber: number,
            reviewerLogin: review.user?.login ?? 'unknown',
            state: review.state ?? 'COMMENTED',
            submittedAt: review.submitted_at ?? null,
            body: review.body ?? '',
            comments: reviewCommentsByReview.get(review.id) ?? [],
          });
        }
      }

      // PR conversations live in the issue-comment namespace
      const prComments = await this.octokit.paginate(this.octokit.rest.issues.listComments, {
        owner,
        repo,
        issue_number: number,
        per_page: 100,
      });
      const comments: CommentRecord[] = prComments.map((comment) => ({
        id: comment.id,
        number,
        authorLogin: comment.user?.login ?? 'unknown',
        createdAt: comment.created_at ?? '',
        body: comment.body ?? '',
      }));
      const mirroredIssue: IssueRecord = {
        repo: name,
        number,
        title: pr.title ?? '',
        authorLogin: pr.user?.login ?? 'unknown',
        state: pr.state ?? 'unknown',
        createdAt,
        updatedAt,
        closedAt: pr.closed_at ?? null,
        labels: [],
        comments,
        isPullRequest: true,
      };

      // One transaction: the PR row is only visible to the incremental skip
      // together with its files, reviews and conversation. A crash mid-fetch
      // leaves the previous state intact and retriable, never a half-indexed PR.
      store.upsertPullRequestBundle({
        pr: record,
        paths,
        reviews: reviewRecords,
        seenReviewIds: [...reviewIdsSeen],
        issue: mirroredIssue,
      });
      result.pullRequests += 1;
      result.reviews += reviewRecords.length;
    }
    // Same completeness contract as commits: without --since the listing covered
    // every PR, so anything still in the index was deleted upstream.
    if (!options.since) {
      store.prunePullRequestsNotSeen(name, seenNumbers);
    }
  }

  private async collectIssues(
    store: HandoverStore,
    owner: string,
    repo: string,
    options: CollectOptions,
    result: CollectResult,
  ): Promise<void> {
    const name = `${owner}/${repo}`;
    const seenNumbers: number[] = [];
    for await (const issue of this.paginate<{
      number?: number;
      title?: string;
      user?: { login?: string } | null;
      state?: string;
      created_at?: string;
      updated_at?: string;
      closed_at?: string | null;
      pull_request?: unknown;
      labels?: Array<{ name?: string } | string>;
      comments?: number;
    }>('listIssues', { owner, repo })) {
      const number = issue.number;
      if (number === undefined) {
        continue;
      }
      const createdAt = issue.created_at ?? '';
      if (options.since && createdAt < options.since) {
        // issues are listed newest-first by creation — stop at the first old one.
        // Note: this means reviews/comments on older PRs/issues (created before --since
        // but with activity after) are silently skipped; this is a documented limitation.
        break;
      }
      // PR entries appear in the issues listing too; their conversations are
      // already collected by collectPullRequests, so skip them here.
      if (issue.pull_request !== undefined) {
        continue;
      }
      seenNumbers.push(number);
      const updatedAt = issue.updated_at ?? null;
      if (!options.refresh && store.hasIssue(name, number, updatedAt ?? undefined)) {
        result.skippedIssues += 1;
        continue;
      }
      const comments: CommentRecord[] = [];
      if ((issue.comments ?? 0) > 0) {
        const fetched = await this.octokit.paginate(this.octokit.rest.issues.listComments, {
          owner,
          repo,
          issue_number: number,
          per_page: 100,
        });
        for (const comment of fetched) {
          comments.push({
            id: comment.id,
            number,
            authorLogin: comment.user?.login ?? 'unknown',
            createdAt: comment.created_at ?? '',
            body: comment.body ?? '',
          });
        }
      }
      const record: IssueRecord = {
        repo: name,
        number,
        title: issue.title ?? '',
        authorLogin: issue.user?.login ?? 'unknown',
        state: issue.state ?? 'unknown',
        createdAt,
        updatedAt,
        closedAt: issue.closed_at ?? null,
        labels: (issue.labels ?? []).map((label) => (typeof label === 'string' ? label : label.name ?? '')),
        comments,
        isPullRequest: false,
      };
      store.upsertIssue(record);
      result.issues += 1;
    }
    // Completeness contract as above: without --since the listing saw every issue.
    if (!options.since) {
      store.pruneIssuesNotSeen(name, seenNumbers);
    }
  }
}

/** Total rows touched (indexed + skipped) — the "did we find anything" check. */
export function countCollected(result: CollectResult): number {
  return (
    result.indexedCommits +
    result.skippedCommits +
    result.pullRequests +
    result.skippedPullRequests +
    result.reviews +
    result.issues +
    result.skippedIssues
  );
}
