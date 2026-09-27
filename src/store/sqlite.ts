import { DatabaseSync } from 'node:sqlite';
import type {
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

      CREATE INDEX IF NOT EXISTS idx_commits_author ON commits (repo, author_login);
      CREATE INDEX IF NOT EXISTS idx_commit_files_path ON commit_files (repo, path);
      CREATE INDEX IF NOT EXISTS idx_reviews_reviewer ON reviews (repo, reviewer_login);
      CREATE INDEX IF NOT EXISTS idx_issue_comments_author ON issue_comments (repo, author_login);
    `);
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

  // ---- writes -------------------------------------------------------------

  upsertCommit(commit: CommitRecord): void {
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
  }

  hasCommit(repo: string, sha: string): boolean {
    return this.get('SELECT 1 AS ok FROM commits WHERE repo = ? AND sha = ?', repo, sha) !== undefined;
  }

  upsertPullRequest(pr: PullRequestRecord): void {
    this.run(
      `INSERT INTO pull_requests (repo, number, title, author_login, state, created_at, merged_at, body, additions, deletions, changed_files)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (repo, number) DO UPDATE SET
         title = excluded.title,
         author_login = excluded.author_login,
         state = excluded.state,
         created_at = excluded.created_at,
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
      pr.mergedAt,
      pr.body,
      pr.additions,
      pr.deletions,
      pr.changedFiles,
    );
  }

  upsertPrFiles(repo: string, prNumber: number, paths: string[]): void {
    this.run('DELETE FROM pr_files WHERE repo = ? AND pr_number = ?', repo, prNumber);
    const insert = this.db.prepare('INSERT OR REPLACE INTO pr_files (repo, pr_number, path) VALUES (?, ?, ?)');
    for (const p of paths) {
      insert.run(repo, prNumber, p);
    }
  }

  upsertReview(review: ReviewRecord): void {
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

  upsertComments(repo: string, number: number, comments: CommentRecord[]): void {
    const insert = this.db.prepare(
      `INSERT OR REPLACE INTO issue_comments (repo, id, issue_number, author_login, created_at, body)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const comment of comments) {
      insert.run(repo, comment.id, number, comment.authorLogin, comment.createdAt, comment.body);
    }
  }

  upsertIssue(issue: IssueRecord): void {
    this.run(
      `INSERT INTO issues (repo, number, title, author_login, state, created_at, closed_at, is_pull_request)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (repo, number) DO UPDATE SET
         title = excluded.title,
         author_login = excluded.author_login,
         state = excluded.state,
         created_at = excluded.created_at,
         closed_at = excluded.closed_at,
         is_pull_request = excluded.is_pull_request`,
      issue.repo,
      issue.number,
      issue.title,
      issue.authorLogin,
      issue.state,
      issue.createdAt,
      issue.closedAt,
      0,
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

  // ---- reads --------------------------------------------------------------

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
    return this.all('SELECT * FROM commits ORDER BY authored_at ASC').map((row) => {
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
        closedAt: strOrNull(row['closed_at']),
        labels: labelsByIssue.get(key) ?? [],
        comments: commentsByIssue.get(key) ?? [],
      };
    });
  }

  close(): void {
    this.db.close();
  }
}
