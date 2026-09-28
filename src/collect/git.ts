import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { codeownersMetaKey } from './codeowners.js';
import type { CommitFile, CommitRecord } from '../types.js';
import type { HandoverStore } from '../store/sqlite.js';

const execFileAsync = promisify(execFile);

export interface LocalCollectOptions {
  /** ISO date; only commits after this date (git --since, committer date) */
  since?: string;
  /** re-index commits already present in the store */
  refresh?: boolean;
  /**
   * Identity that marks "the departing engineer" in `git log` author names or
   * emails (case-insensitive substring). Defaults to the username argument —
   * which works when the login appears in the email (alice@example.com).
   */
  identity?: string;
  onProgress?: (message: string) => void;
}

export interface LocalCollectResult {
  indexedCommits: number;
  skippedCommits: number;
  /** local repo names (directory basenames) that were read */
  repos: string[];
}

/** Field/record markers embedded via git's --format hex escapes. */
const FIELD = '\x1f';
const RECORD = '\x1e';

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? '';
    if (/does not have any commits yet/i.test(stderr)) {
      return '';
    }
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${stderr.trim().slice(0, 300) || String(error)}`);
  }
}

/** Turns a numstat path (renames, quoted non-ASCII) into the resulting file path. */
export function resolveNumstatPath(raw: string): string {
  let p = raw.trim();
  if (p.startsWith('"') && p.endsWith('"')) {
    p = p.slice(1, -1);
  }
  if (p.includes('=>')) {
    // "dir/{old => new}/file" → "dir/new/file"; "old => new" → "new"
    p = p.replace(/\{([^{}]*) => ([^{}]*)\}/g, '$2');
    if (p.includes('=>')) {
      p = p.split('=>').pop() ?? p;
    }
    p = p.replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, '');
  }
  return p.trim();
}

/**
 * Collects commits from local git clones into the same SQLite index as the
 * GitHub collector — no token, no network, works for GitLab/Gitee users too.
 * PRs/reviews/issues have no local equivalent, so those chapters degrade to
 * empty; risk scoring and the panorama run on commit evidence.
 */
export class GitDirectoryCollector {
  async collectInto(
    store: HandoverStore,
    username: string,
    dirs: string[],
    options: LocalCollectOptions = {},
  ): Promise<LocalCollectResult> {
    const progress = options.onProgress ?? (() => {});
    const identity = (options.identity ?? username).toLowerCase();
    const result: LocalCollectResult = { indexedCommits: 0, skippedCommits: 0, repos: [] };

    for (const dir of [...new Set(dirs)]) {
      let toplevel: string;
      try {
        toplevel = (await git(dir, ['rev-parse', '--show-toplevel'])).trim();
      } catch {
        throw new Error(`Not a git repository: ${dir} — pass the clone's directory to --git-dir.`);
      }
      if (!toplevel) {
        throw new Error(`Not a git repository: ${dir}`);
      }
      const repoName = path.basename(toplevel);
      result.repos.push(repoName);
      progress(`Reading local repository ${repoName} (${toplevel}) …`);

      for (const candidate of ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS']) {
        try {
          store.setMeta(codeownersMetaKey(repoName), await readFile(path.join(toplevel, candidate), 'utf8'));
          break;
        } catch {
          // try the next candidate location
        }
      }

      const out = await git(toplevel, [
        'log',
        `--format=${RECORD}%H${FIELD}%an${FIELD}%ae${FIELD}%aI${FIELD}%B${FIELD}`,
        '--numstat',
        '--no-color',
        ...(options.since ? ['--since', options.since] : []),
      ]);

      for (const record of out.split(RECORD)) {
        if (!record.trim()) {
          continue;
        }
        const fields = record.split(FIELD);
        const sha = (fields[0] ?? '').trim();
        if (!/^[0-9a-f]{7,40}$/.test(sha)) {
          continue;
        }
        if (!options.refresh && store.hasCommit(repoName, sha)) {
          result.skippedCommits += 1;
          continue;
        }
        const authorName = (fields[1] ?? '').trim();
        const authorEmail = (fields[2] ?? '').trim();
        const authoredAt = (fields[3] ?? '').trim();
        const message = (fields[4] ?? '').trim();
        const numstat = fields[5] ?? '';

        const files: CommitFile[] = [];
        let additions = 0;
        let deletions = 0;
        for (const line of numstat.split('\n')) {
          const parts = line.split('\t');
          if (parts.length !== 3) {
            continue;
          }
          const [add, del] = parts;
          const filePath = resolveNumstatPath(parts[2] ?? '');
          if (!filePath) {
            continue;
          }
          // binary files show "- - path"
          const fileAdd = add === '-' || add === '' ? 0 : Number(add) || 0;
          const fileDel = del === '-' || del === '' ? 0 : Number(del) || 0;
          additions += fileAdd;
          deletions += fileDel;
          files.push({ path: filePath, additions: fileAdd, deletions: fileDel });
        }

        const isSubject =
          authorEmail.toLowerCase().includes(identity) || authorName.toLowerCase().includes(identity);
        const commit: CommitRecord = {
          sha,
          repo: repoName,
          // subject commits are stored under the same login the GitHub path uses
          // so risk/synthesis comparisons stay uniform; others keep their email
          authorLogin: isSubject ? username : authorEmail || authorName || 'unknown',
          authoredAt: authoredAt || new Date().toISOString(),
          message,
          additions,
          deletions,
          files,
        };
        store.upsertCommit(commit);
        result.indexedCommits += 1;
        if (result.indexedCommits % 200 === 0) {
          progress(`  indexed ${result.indexedCommits} commits in ${repoName} …`);
        }
      }
    }

    const existing = (store.getMeta('repos') ?? '')
      .split(',')
      .map((repo) => repo.trim())
      .filter(Boolean);
    store.setMeta('repos', [...new Set([...existing, ...result.repos])].join(','));
    store.setMeta('collected_for', username);
    store.setMeta('source', 'local-git');
    store.setMeta('last_collected_at', new Date().toISOString());
    return result;
  }
}
