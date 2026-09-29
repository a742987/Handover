import { DatabaseSync } from 'node:sqlite';
import type {
  CapturedAnswer,
  CommitFile,
  CommitRecord,
  CommentRecord,
  IssueRecord,
  PullRequestRecord,
  ReviewCommentRecord,
  ReviewRecord,
} from '../types.js';

type Row = Record<string, unknown>;

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function num(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

function strOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Local SQLite index — one file per person (project plan §3.2). Stores the raw
 * collected evidence; every later stage reads from here, which is what makes
 * second-generation runs near-instant.
 */
export class HandoverStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    // Wait on a locked database (CLI and MCP server can touch the same index)
    // instead of failing mid-write — Windows file locking makes any overlap
    // an instant SQLITE_BUSY otherwise.
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.migrate();
  }

  static inMemory(): HandoverStore {
    return new HandoverStore(':memory:');
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS commits (
        sha TEXT NOT NULL,
        repo TEXT NOT NULL,
        author_login TEXT NOT NULL,
        authored_at TEXT NOT NULL,
        message TEXT NOT NULL,
        additions INTEGER NOT NULL DEFAULT 0,
        deletions INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (repo, sha)
      );

      CREATE TABLE IF NOT EXISTS commit_files (
        repo TEXT NOT NULL,
        sha TEXT NOT NULL,
        path TEXT NOT NULL,
        additions INTEGER NOT NULL DEFAULT 0,
        deletions INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (repo, sha, path)
      );

      CREATE TABLE IF NOT EXISTS pull_requests (
        repo TEXT NOT NULL,
        number INTEGER NOT NULL,
        title TEXT NOT NULL,
        author_login TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT,
        head_sha TEXT,
        merged_at TEXT,
        body TEXT NOT NULL DEFAULT '',
        additions INTEGER NOT NULL DEFAULT 0,
        deletions INTEGER NOT NULL DEFAULT 0,
        changed_files INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (repo, number)
      );

      CREATE TABLE IF NOT EXISTS pr_files (
        repo TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        path TEXT NOT NULL,
        PRIMARY KEY (repo, pr_number, path)
      );

      CREATE TABLE IF NOT EXISTS reviews (
        repo TEXT NOT NULL,
        id INTEGER NOT NULL,
        pr_number INTEGER NOT NULL,
        reviewer_login TEXT NOT NULL,
        state TEXT NOT NULL,
        submitted_at TEXT,
        body TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (repo, id)
      );

      CREATE TABLE IF NOT EXISTS review_comments (
        repo TEXT NOT NULL,
        id INTEGER NOT NULL,
        review_id INTEGER NOT NULL,
        pr_number INTEGER NOT NULL,
        path TEXT NOT NULL,
        body TEXT NOT NULL,
        author_login TEXT NOT NULL,
        PRIMARY KEY (repo, id)
      );

      -- issues and their comments; PR conversations are stored here too
      -- (GitHub uses one shared number namespace for both)
      CREATE TABLE IF NOT EXISTS issues (
        repo TEXT NOT NULL,
        number INTEGER NOT NULL,
        title TEXT NOT NULL,
        author_login TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT,
        closed_at TEXT,
        is_pull_request INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (repo, number)
      );

      CREATE TABLE IF NOT EXISTS issue_labels (
        repo TEXT NOT NULL,
        issue_number INTEGER NOT NULL,
        label TEXT NOT NULL,
        PRIMARY KEY (repo, issue_number, label)
      );

      CREATE TABLE IF NOT EXISTS issue_comments (
        repo TEXT NOT NULL,
        id INTEGER NOT NULL,
        issue_number INTEGER NOT NULL,
        author_login TEXT NOT NULL,
        created_at TEXT NOT NULL,
        body TEXT NOT NULL,
        PRIMARY KEY (repo, id)
      );

      -- first-person answers captured from the departing engineer (handover capture);
      -- they are injected into chapter 6 at render time
      CREATE TABLE IF NOT EXISTS answers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        question TEXT NOT NULL,
        answer TEXT NOT NULL,
        captured_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_review_comments_review_id ON review_comments (repo, review_id);
      CREATE INDEX IF NOT EXISTS idx_issue_comments_issue_number ON issue_comments (repo, issue_number);
      CREATE INDEX IF NOT EXISTS idx_pr_files_pr_number ON pr_files (repo, pr_number);
    `);
    // Databases collected before newer columns existed keep working:
    // the ALTER fails when the column is already there, which is fine.
    for (const statement of [
      'ALTER TABLE pull_requests ADD COLUMN updated_at TEXT',
      'ALTER TABLE issues ADD COLUMN updated_at TEXT',
      'ALTER TABLE pull_requests ADD COLUMN head_sha TEXT',
    ]) {
      try {
        this.db.exec(statement);
      } catch (error) {
        // swallow only "duplicate column name" — surface anything else so
        // a broken schema (readonly db, disk full) is not masked.
        if (!(error instanceof Error && /duplicate column/i.test(error.message))) {
          throw error;
        }
      }
    }
    // schema_version tracks backward-incompatible migrations; a database
    // with a newer version than this code knows must be refused rather than
    // silently corrupted.
    const VERSION = 3;
    this.run('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)', 'schema_version', String(VERSION));
    const row = this.get('SELECT value FROM meta WHERE key = ?', 'schema_version');
    const current = row ? Number(str(row['value'])) : 0;
    if (!Number.isFinite(current) || current < VERSION) {
      // Older schema: the column ADDs above already brought it forward
      // in place, so only the recorded version needs updating.
      this.run('UPDATE meta SET value = ? WHERE key = ?', String(VERSION), 'schema_version');
    } else if (current > VERSION) {
      throw new Error(
        `This index was written by a newer version of handover (schema ${current}, current ${VERSION}) — upgrade handover-book to read it.`,
      );
    }
  }

  private run(sql: string, ...params: (string | number | null)[]): void {
    this.db.prepare(sql).run(...params);
  }

  private all(sql: string, ...params: (string | number | null)[]): Row[] {
    return this.db.prepare(sql).all(...params) as unknown as Row[];
  }

  private get(sql: string, ...params: (string | number | null)[]): Row | undefined {
    return this.db.prepare(sql).get(...params) as unknown as Row | undefined;
  }

  /** SQLite's default SQLITE_MAX_VARIABLE_NUMBER is 32766 — a full history listing
   * of a large repo exceeds it. Small/bounded lists (repo scopes, review ids)
   * stay as chunked NOT IN clauses; unbounded prune lists use the temp table below. */
  private notInClauses(column: string, values: Array<string | number>): { sql: string; values: Array<string | number> } {
    const CHUNK = 5_000;
    const clauses: string[] = [];
    const chunked: Array<string | number> = [];
    for (let i = 0; i < values.length; i += CHUNK) {
      const chunk = values.slice(i, i + CHUNK);
      clauses.push(`${column} NOT IN (${chunk.map(() => '?').join(',')})`);
      chunked.push(...chunk);
    }
    return { sql: clauses.join(' AND '), values: chunked };
  }

  /**
   * Stages a (possibly huge) "seen" list into a temp table so prune deletes can
   * compare against `NOT IN (SELECT value …)` without any bind-variable limit.
   * The column is declared without affinity so stored TEXT and INTEGER values
   * keep their native comparison against sha/number columns. Call
   * clearStagedValues() when done — the temp table is per-connection.
   */
  private stageSeenValues(values: Array<string | number>): void {
    this.db.exec('CREATE TEMP TABLE IF NOT EXISTS seen_values (value)');
    this.db.exec('DELETE FROM seen_values');
    const insert = this.db.prepare('INSERT INTO seen_values (value) VALUES (?)');
    for (const value of values) {
      insert.run(value);
    }
  }

  private clearStagedValues(): void {
    this.db.exec('DELETE FROM seen_values');
  }

  /** Keeps multi-statement upserts (parent + child rows) atomic across a crash. */
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // the transaction was already rolled back or never opened
      }
      throw error;
    }
  }

  // ---- writes -------------------------------------------------------------

  upsertCommit(commit: CommitRecord): void {
    this.transaction(() => {
      this.run(
        `INSERT INTO commits (sha, repo, author_login, authored_at, message, additions, deletions)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (repo, sha) DO UPDATE SET
           author_login = excluded.author_login,
           authored_at = excluded.authored_at,
           message = excluded.message,
           additions = excluded.additions,
           deletions = excluded.deletions`,
        commit.sha,
        commit.repo,
        commit.authorLogin,
        commit.authoredAt,
        commit.message,
        commit.additions,
        commit.deletions,
      );
      this.run('DELETE FROM commit_files WHERE repo = ? AND sha = ?', commit.repo, commit.sha);
      const insert = this.db.prepare(
        'INSERT OR REPLACE INTO commit_files (repo, sha, path, additions, deletions) VALUES (?, ?, ?, ?, ?)',
      );
      for (const file of commit.files) {
        insert.run(commit.repo, commit.sha, file.path, file.additions, file.deletions);
      }
    });
  }

  hasCommit(repo: string, sha: string): boolean {
    return this.get('SELECT 1 AS ok FROM commits WHERE repo = ? AND sha = ?', repo, sha) !== undefined;
  }

  /**
   * True when the PR is already indexed — and, when `updatedAt` is given, still
   * current on GitHub-side activity (comments, reviews, merge state all bump it).
   * Commits are immutable and can skip on existence alone; PRs cannot.
   */
  hasPullRequest(repo: string, number: number, updatedAt?: string, headSha?: string): boolean {
    const row = this.get('SELECT updated_at, head_sha FROM pull_requests WHERE repo = ? AND number = ?', repo, number);
    if (row === undefined) {
      return false;
    }
    if (updatedAt === undefined) {
      return true;
    }
    const stored = strOrNull(row['updated_at']);
    const storedHeadSha = strOrNull(row['head_sha']);
    // updated_at covers comments/reviews/merge; head_sha covers new commits pushed to the branch.
    // A stored NULL head_sha (row predates the column) can never prove freshness —
    // treat it as stale so the PR is refetched once and the column gets filled.
    if (stored === null || stored < updatedAt) {
      return false;
    }
    if (headSha !== undefined && (storedHeadSha === null || storedHeadSha !== headSha)) {
      return false;
    }
    return true;
  }

  /** Same freshness contract as hasPullRequest, for issues. */
  hasIssue(repo: string, number: number, updatedAt?: string): boolean {
    const row = this.get('SELECT updated_at FROM issues WHERE repo = ? AND number = ?', repo, number);
    if (row === undefined) {
      return false;
    }
    if (updatedAt === undefined) {
      return true;
    }
    const stored = strOrNull(row['updated_at']);
    return stored !== null && stored >= updatedAt;
  }

  upsertPullRequest(pr: PullRequestRecord): void {
    this.transaction(() => {
      this.upsertPullRequestRow(pr);
    });
  }

  /** PR row without its own transaction — the bundle composes several of these. */
  private upsertPullRequestRow(pr: PullRequestRecord): void {
    this.run(
        `INSERT INTO pull_requests (repo, number, title, author_login, state, created_at, updated_at, head_sha, merged_at, body, additions, deletions, changed_files)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (repo, number) DO UPDATE SET
           title = excluded.title,
           author_login = excluded.author_login,
           state = excluded.state,
           created_at = excluded.created_at,
           updated_at = COALESCE(excluded.updated_at, updated_at),
           head_sha = COALESCE(excluded.head_sha, head_sha),
           merged_at = excluded.merged_at,
           body = excluded.body,
           additions = excluded.additions,
           deletions = excluded.deletions,
           changed_files = excluded.changed_files`,
        pr.repo,
        pr.number,
        pr.title,
        pr.authorLogin,
        pr.state,
        pr.createdAt,
        pr.updatedAt ?? null,
        pr.headSha ?? null,
        pr.mergedAt,
        pr.body,
        pr.additions,
        pr.deletions,
        pr.changedFiles,
      );
  }

  upsertPrFiles(repo: string, prNumber: number, paths: string[]): void {
    this.transaction(() => {
      this.upsertPrFilesInner(repo, prNumber, paths);
    });
  }

  private upsertPrFilesInner(repo: string, prNumber: number, paths: string[]): void {
    this.run('DELETE FROM pr_files WHERE repo = ? AND pr_number = ?', repo, prNumber);
    const insert = this.db.prepare('INSERT OR REPLACE INTO pr_files (repo, pr_number, path) VALUES (?, ?, ?)');
    for (const p of paths) {
      insert.run(repo, prNumber, p);
    }
  }

  upsertReview(review: ReviewRecord): void {
    this.transaction(() => {
      this.upsertReviewInner(review);
    });
  }

  private upsertReviewInner(review: ReviewRecord): void {
    this.run(
        `INSERT INTO reviews (repo, id, pr_number, reviewer_login, state, submitted_at, body)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (repo, id) DO UPDATE SET
           pr_number = excluded.pr_number,
           reviewer_login = excluded.reviewer_login,
           state = excluded.state,
           submitted_at = excluded.submitted_at,
           body = excluded.body`,
        review.repo,
        review.id,
        review.prNumber,
        review.reviewerLogin,
        review.state,
        review.submittedAt,
        review.body,
      );
      this.run('DELETE FROM review_comments WHERE repo = ? AND review_id = ?', review.repo, review.id);
      const insert = this.db.prepare(
        `INSERT OR REPLACE INTO review_comments (repo, id, review_id, pr_number, path, body, author_login)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const comment of review.comments) {
        insert.run(
          review.repo,
          comment.id,
          comment.reviewId,
          review.prNumber,
          comment.path,
          comment.body,
          comment.authorLogin,
        );
      }
  }

  /**
   * Writes a PR and everything derived from it — file list, reviews with their
   * inline comments, the mirrored issue row, stale-review cleanup — as one
   * transaction. The incremental skip treats a stored PR row as "complete", so
   * the row must never exist without its children (a half-indexed PR would
   * otherwise silently deflate sole-reviewer ratios forever).
   */
  upsertPullRequestBundle(bundle: {
    pr: PullRequestRecord;
    paths: string[];
    reviews: ReviewRecord[];
    /** review ids present on GitHub; others are deleted (stale review cleanup) */
    seenReviewIds: number[];
    issue: IssueRecord;
  }): void {
    this.transaction(() => {
      this.upsertPullRequestRow(bundle.pr);
      this.upsertPrFilesInner(bundle.pr.repo, bundle.pr.number, bundle.paths);
      for (const review of bundle.reviews) {
        this.upsertReviewInner(review);
      }
      this.deleteReviewsNotSeenInner(bundle.pr.repo, bundle.pr.number, bundle.seenReviewIds);
      this.upsertIssueInner(bundle.issue);
    });
  }

  private upsertComments(repo: string, number: number, comments: CommentRecord[]): void {
    const insert = this.db.prepare(
      `INSERT OR REPLACE INTO issue_comments (repo, id, issue_number, author_login, created_at, body)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const comment of comments) {
      insert.run(repo, comment.id, number, comment.authorLogin, comment.createdAt, comment.body);
    }
  }

  /** Removes reviews (and their comments) that were deleted on GitHub side. Called after refetching a PR. */
  deleteReviewsNotSeen(repo: string, prNumber: number, seenReviewIds: number[]): void {
    this.transaction(() => {
      this.deleteReviewsNotSeenInner(repo, prNumber, seenReviewIds);
    });
  }

  private deleteReviewsNotSeenInner(repo: string, prNumber: number, seenReviewIds: number[]): void {
    if (seenReviewIds.length === 0) {
      // all reviews deleted — wipe everything for this PR
      this.run('DELETE FROM review_comments WHERE repo = ? AND pr_number = ?', repo, prNumber);
      this.run('DELETE FROM reviews WHERE repo = ? AND pr_number = ?', repo, prNumber);
      return;
    }
    // build the NOT IN list; reviews not in the seen set are deleted
    const commentsNotSeen = this.notInClauses('review_id', seenReviewIds);
    const reviewsNotSeen = this.notInClauses('id', seenReviewIds);
    this.run(`DELETE FROM review_comments WHERE repo = ? AND pr_number = ? AND ${commentsNotSeen.sql}`, repo, prNumber, ...commentsNotSeen.values);
    this.run(`DELETE FROM reviews WHERE repo = ? AND pr_number = ? AND ${reviewsNotSeen.sql}`, repo, prNumber, ...reviewsNotSeen.values);
  }

  upsertIssue(issue: IssueRecord): void {
    this.transaction(() => {
      this.upsertIssueInner(issue);
    });
  }

  private upsertIssueInner(issue: IssueRecord): void {
    this.run(
        `INSERT INTO issues (repo, number, title, author_login, state, created_at, updated_at, closed_at, is_pull_request)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (repo, number) DO UPDATE SET
           title = excluded.title,
           author_login = excluded.author_login,
           state = excluded.state,
           created_at = excluded.created_at,
           updated_at = COALESCE(excluded.updated_at, updated_at),
           closed_at = excluded.closed_at,
           is_pull_request = excluded.is_pull_request`,
        issue.repo,
        issue.number,
        issue.title,
        issue.authorLogin,
        issue.state,
        issue.createdAt,
        issue.updatedAt ?? null,
        issue.closedAt,
        issue.isPullRequest ? 1 : 0,
      );
      this.run('DELETE FROM issue_labels WHERE repo = ? AND issue_number = ?', issue.repo, issue.number);
      const label = this.db.prepare('INSERT OR REPLACE INTO issue_labels (repo, issue_number, label) VALUES (?, ?, ?)');
      for (const name of issue.labels) {
        label.run(issue.repo, issue.number, name);
      }
      this.run('DELETE FROM issue_comments WHERE repo = ? AND issue_number = ?', issue.repo, issue.number);
      this.upsertComments(
        issue.repo,
        issue.number,
        issue.comments.map((comment) => ({ ...comment, number: issue.number })),
      );
  }

  setMeta(key: string, value: string): void {
    this.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', key, value);
  }

  getMeta(key: string): string | null {
    const row = this.get('SELECT value FROM meta WHERE key = ?', key);
    return row === undefined ? null : str(row['value']);
  }

  // ---- captured answers ----------------------------------------------------

  addAnswer(question: string, answer: string, capturedAt: string): number {
    const row = this.db
      .prepare('INSERT INTO answers (question, answer, captured_at) VALUES (?, ?, ?)')
      .run(question, answer, capturedAt);
    return Number(row.lastInsertRowid);
  }

  listAnswers(): CapturedAnswer[] {
    return this.all('SELECT id, question, answer, captured_at FROM answers ORDER BY id ASC').map((row) => ({
      id: num(row['id']),
      question: str(row['question']),
      answer: str(row['answer']),
      capturedAt: str(row['captured_at']),
    }));
  }

  deleteAnswer(id: number): void {
    this.run('DELETE FROM answers WHERE id = ?', id);
  }

  // ---- reads --------------------------------------------------------------

  /** Clears all data for repositories not in the given list. Called at the start of collect to prevent orphan rows. */
  clearRepositoriesExcept(repos: string[]): void {
    if (repos.length === 0) {
      return;
    }
    const { sql, values } = this.notInClauses('repo', repos);
    this.transaction(() => {
      for (const table of [
        'commits',
        'commit_files',
        'pull_requests',
        'pr_files',
        'reviews',
        'review_comments',
        'issues',
        'issue_labels',
        'issue_comments',
      ]) {
        this.run(`DELETE FROM ${table} WHERE ${sql}`, ...values);
      }
    });
  }

  /**
   * Deletes commits whose SHAs were absent from a complete upstream listing
   * (history rewrites, force-pushes). Only call with a full, unfiltered listing —
   * never after a `--since`-bounded one — and only when the listing was non-empty.
   */
  pruneCommitsNotSeen(repo: string, shas: string[]): void {
    if (shas.length === 0) {
      return;
    }
    this.transaction(() => {
      this.stageSeenValues(shas);
      this.run('DELETE FROM commit_files WHERE repo = ? AND sha NOT IN (SELECT value FROM seen_values)', repo);
      this.run('DELETE FROM commits WHERE repo = ? AND sha NOT IN (SELECT value FROM seen_values)', repo);
      this.clearStagedValues();
    });
  }

  /**
   * Deletes PRs (with their files, reviews, comments and mirrored issue rows)
   * that were absent from a complete upstream listing. Pass only full,
   * unfiltered listings and only when non-empty.
   */
  prunePullRequestsNotSeen(repo: string, numbers: number[]): void {
    if (numbers.length === 0) {
      return;
    }
    this.transaction(() => {
      this.stageSeenValues(numbers);
      this.run('DELETE FROM pr_files WHERE repo = ? AND pr_number NOT IN (SELECT value FROM seen_values)', repo);
      this.run('DELETE FROM review_comments WHERE repo = ? AND pr_number NOT IN (SELECT value FROM seen_values)', repo);
      this.run('DELETE FROM reviews WHERE repo = ? AND pr_number NOT IN (SELECT value FROM seen_values)', repo);
      // The mirrored issue rows of pruned PRs (comments, labels included).
      this.run(
        'DELETE FROM issue_comments WHERE repo = ? AND issue_number NOT IN (SELECT value FROM seen_values) AND issue_number IN (SELECT number FROM issues WHERE repo = ? AND is_pull_request = 1)',
        repo,
        repo,
      );
      this.run(
        'DELETE FROM issue_labels WHERE repo = ? AND issue_number NOT IN (SELECT value FROM seen_values) AND issue_number IN (SELECT number FROM issues WHERE repo = ? AND is_pull_request = 1)',
        repo,
        repo,
      );
      this.run('DELETE FROM issues WHERE repo = ? AND is_pull_request = 1 AND number NOT IN (SELECT value FROM seen_values)', repo);
      this.run('DELETE FROM pull_requests WHERE repo = ? AND number NOT IN (SELECT value FROM seen_values)', repo);
      this.clearStagedValues();
    });
  }

  /** Deletes non-PR issues (labels, comments) absent from a complete upstream listing. */
  pruneIssuesNotSeen(repo: string, numbers: number[]): void {
    if (numbers.length === 0) {
      return;
    }
    this.transaction(() => {
      this.stageSeenValues(numbers);
      this.run(
        'DELETE FROM issue_comments WHERE repo = ? AND issue_number NOT IN (SELECT value FROM seen_values) AND issue_number IN (SELECT number FROM issues WHERE repo = ? AND is_pull_request = 0)',
        repo,
        repo,
      );
      this.run(
        'DELETE FROM issue_labels WHERE repo = ? AND issue_number NOT IN (SELECT value FROM seen_values) AND issue_number IN (SELECT number FROM issues WHERE repo = ? AND is_pull_request = 0)',
        repo,
        repo,
      );
      this.run('DELETE FROM issues WHERE repo = ? AND is_pull_request = 0 AND number NOT IN (SELECT value FROM seen_values)', repo);
      this.clearStagedValues();
    });
  }

  allCommits(): CommitRecord[] {
    const filesByCommit = new Map<string, CommitFile[]>();
    for (const row of this.all('SELECT repo, sha, path, additions, deletions FROM commit_files')) {
      const repo = str(row['repo']);
      const sha = str(row['sha']);
      const key = `${repo}:${sha}`;
      const files = filesByCommit.get(key) ?? [];
      files.push({
        path: str(row['path']),
        additions: num(row['additions']),
        deletions: num(row['deletions']),
      });
      filesByCommit.set(key, files);
    }
    // Deterministic order: same timestamp → same sequence on every machine.
    return this.all('SELECT * FROM commits ORDER BY authored_at ASC, repo ASC, sha ASC').map((row) => {
      const repo = str(row['repo']);
      const sha = str(row['sha']);
      return {
        sha,
        repo,
        authorLogin: str(row['author_login']),
        authoredAt: str(row['authored_at']),
        message: str(row['message']),
        additions: num(row['additions']),
        deletions: num(row['deletions']),
        files: filesByCommit.get(`${repo}:${sha}`) ?? [],
      };
    });
  }

  allPullRequests(): PullRequestRecord[] {
    return this.all('SELECT * FROM pull_requests ORDER BY created_at ASC').map((row) => ({
      repo: str(row['repo']),
      number: num(row['number']),
      title: str(row['title']),
      authorLogin: str(row['author_login']),
      state: str(row['state']),
      createdAt: str(row['created_at']),
      updatedAt: strOrNull(row['updated_at']),
      headSha: strOrNull(row['head_sha']),
      mergedAt: strOrNull(row['merged_at']),
      body: str(row['body']),
      additions: num(row['additions']),
      deletions: num(row['deletions']),
      changedFiles: num(row['changed_files']),
    }));
  }

  allPrFiles(): Map<string, string[]> {
    const map = new Map<string, string[]>();
    for (const row of this.all('SELECT repo, pr_number, path FROM pr_files')) {
      const repo = str(row['repo']);
      const prNumber = num(row['pr_number']);
      const key = `${repo}#${prNumber}`;
      const paths = map.get(key) ?? [];
      paths.push(str(row['path']));
      map.set(key, paths);
    }
    return map;
  }

  allReviews(): ReviewRecord[] {
    const commentsByReview = new Map<string, ReviewCommentRecord[]>();
    for (const row of this.all('SELECT repo, id, review_id, pr_number, path, body, author_login FROM review_comments')) {
      const repo = str(row['repo']);
      const reviewId = num(row['review_id']);
      const key = `${repo}:${reviewId}`;
      const comments = commentsByReview.get(key) ?? [];
      comments.push({
        id: num(row['id']),
        reviewId,
        path: str(row['path']),
        body: str(row['body']),
        authorLogin: str(row['author_login']),
      });
      commentsByReview.set(key, comments);
    }
    return this.all('SELECT * FROM reviews ORDER BY submitted_at ASC').map((row) => {
      const repo = str(row['repo']);
      const id = num(row['id']);
      return {
        id,
        repo,
        prNumber: num(row['pr_number']),
        reviewerLogin: str(row['reviewer_login']),
        state: str(row['state']),
        submittedAt: strOrNull(row['submitted_at']),
        body: str(row['body']),
        comments: commentsByReview.get(`${repo}:${id}`) ?? [],
      };
    });
  }

  allIssues(): IssueRecord[] {
    const labelsByIssue = new Map<string, string[]>();
    for (const row of this.all('SELECT repo, issue_number, label FROM issue_labels')) {
      const key = `${str(row['repo'])}#${num(row['issue_number'])}`;
      const labels = labelsByIssue.get(key) ?? [];
      labels.push(str(row['label']));
      labelsByIssue.set(key, labels);
    }
    const commentsByIssue = new Map<string, CommentRecord[]>();
    for (const row of this.all('SELECT repo, issue_number, id, author_login, created_at, body FROM issue_comments ORDER BY created_at ASC')) {
      const key = `${str(row['repo'])}#${num(row['issue_number'])}`;
      const comments = commentsByIssue.get(key) ?? [];
      comments.push({
        id: num(row['id']),
        number: num(row['issue_number']),
        authorLogin: str(row['author_login']),
        createdAt: str(row['created_at']),
        body: str(row['body']),
      });
      commentsByIssue.set(key, comments);
    }
    return this.all('SELECT * FROM issues ORDER BY created_at ASC').map((row) => {
      const repo = str(row['repo']);
      const number = num(row['number']);
      const key = `${repo}#${number}`;
      return {
        repo,
        number,
        title: str(row['title']),
        authorLogin: str(row['author_login']),
        state: str(row['state']),
        createdAt: str(row['created_at']),
        updatedAt: strOrNull(row['updated_at']),
        closedAt: strOrNull(row['closed_at']),
        isPullRequest: num(row['is_pull_request']) === 1,
        labels: labelsByIssue.get(key) ?? [],
        comments: commentsByIssue.get(key) ?? [],
      };
    });
  }

  close(): void {
    this.db.close();
  }
}
