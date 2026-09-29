import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { codeownersMetaKey } from './codeowners.js';
import { markCollectionSource } from '../report/summary.js';
import type { CommitFile, CommitRecord } from '../types.js';
import type { HandoverStore } from '../store/sqlite.js';

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
  /** local repo keys (directory basenames, disambiguated on collision) that were read */
  repos: string[];
}

/** Field/record markers embedded via git's --format hex escapes. */
const FIELD = '\x1f';
const RECORD = '\x1e';

const SHA_RE = /^[0-9a-f]{7,40}$/;

/** meta key holding { basename → toplevel } so repo keys stay stable across runs */
const TOPLEVELS_META_KEY = 'local_toplevels';

/**
 * Runs git and collects stdout. Spawn-with-accumulation instead of execFile's
 * maxBuffer: a full `git log --numstat` of a large monorepo history can
 * outgrow any fixed buffer, and the tool's whole point is complete history.
 */
async function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', cwd, ...args], { windowsHide: true });
    const chunks: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      const stdout = Buffer.concat(chunks).toString('utf8');
      if (code === 0) {
        resolve(stdout);
        return;
      }
      if (/does not have any commits yet/i.test(stderr)) {
        resolve('');
        return;
      }
      reject(new Error(`git ${args.join(' ')} failed in ${cwd}: ${stderr.trim().slice(0, 300) || `exit code ${code}`}`));
    });
  });
}

/** Resolves a directory to its git toplevel; null when it is not a repository. */
async function resolveToplevel(dir: string): Promise<string | null> {
  try {
    const toplevel = (await git(dir, ['rev-parse', '--show-toplevel'])).trim();
    return toplevel || null;
  } catch {
    return null;
  }
}

function readToplevels(store: HandoverStore): Record<string, string> {
  const raw = store.getMeta(TOPLEVELS_META_KEY);
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

/** Pure key derivation against a shared basename→toplevel map. */
function localRepoKeyFrom(toplevels: Record<string, string>, toplevel: string): string {
  const basename = path.basename(toplevel);
  const recorded = toplevels[basename];
  if (recorded === undefined || recorded === toplevel) {
    return basename;
  }
  const suffix = createHash('sha256').update(toplevel).digest('hex').slice(0, 6);
  return `${basename}-${suffix}`;
}

/** Records a resolved toplevel in the shared map (and marks the map changed). */
function rememberToplevel(toplevels: Record<string, string>, toplevel: string): boolean {
  const basename = path.basename(toplevel);
  const key = localRepoKeyFrom(toplevels, toplevel);
  let dirty = false;
  if (toplevels[key] !== toplevel) {
    toplevels[key] = toplevel;
    dirty = true;
  }
  if (toplevels[basename] === undefined) {
    toplevels[basename] = toplevel;
    dirty = true;
  }
  return dirty;
}

/**
 * The repo keys a set of local clone directories will be indexed under,
 * without collecting them (non-repositories are skipped — the collector will
 * raise the actionable error). One shared basename map, so collisions resolve
 * exactly the way they will at collect time. Callers use this to compute the
 * full collection scope up front, so the GitHub collector's orphan cleanup can
 * spare local repos.
 */
export async function previewLocalRepoKeys(store: HandoverStore, dirs: string[]): Promise<string[]> {
  const toplevels = readToplevels(store);
  const keys: string[] = [];
  for (const dir of dirs) {
    const toplevel = await resolveToplevel(dir);
    if (!toplevel) {
      continue;
    }
    keys.push(localRepoKeyFrom(toplevels, toplevel));
    rememberToplevel(toplevels, toplevel);
  }
  return keys;
}

/**
 * Repo keys of every local clone ever collected into this index (the shared
 * basename→toplevel map is written by each local collection run). Callers
 * union these into the GitHub collector's preserve list so a later -r-only
 * run cannot orphan — and wipe — locally-collected history.
 */
export function recordedLocalRepoKeys(store: HandoverStore): string[] {
  return Object.keys(readToplevels(store));
}

/**
 * GitHub-side timestamps are UTC ("Z"), while git's %aI keeps the author's
 * original UTC offset — and every timestamp comparison downstream is
 * lexicographic (commit windows, recency sorting, staleness). Store both
 * collection paths in the same UTC form.
 */
export function toUtcIso(value: string): string {
  if (!value) {
    return value;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return value;
  }
  return new Date(parsed).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Turns a numstat path (renames, quoted non-ASCII) into the resulting file path. */
export function resolveNumstatPath(raw: string): string {
  let p = raw.trim();
  if (p.startsWith('"') && p.endsWith('"')) {
    p = p.slice(1, -1);
  }
  if (/\\\d{3}/.test(p)) {
    // C-style octal escapes (git's core.quotePath) encode UTF-8 bytes — decode
    // the whole string byte-wise, then reinterpret as UTF-8. ("支払/a.ts")
    const bytes: number[] = [];
    for (let i = 0; i < p.length; i += 1) {
      if (p[i] === '\\' && /^[0-7]{3}$/.test(p.slice(i + 1, i + 4))) {
        bytes.push(parseInt(p.slice(i + 1, i + 4), 8));
        i += 3;
      } else {
        bytes.push(p.charCodeAt(i));
      }
    }
    p = Buffer.from(bytes).toString('utf8');
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

/** Control bytes that would corrupt the \x1e/\x1f-split parsing of `git log`. */
const CONTROL_CHARS_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

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

    // Commit attribution is derived from `identity` at collect time and frozen
    // into the index by the hasCommit skip. A silently changed identity would
    // re-attribute nothing — surface it instead of letting the index stay wrong.
    const previousIdentity = store.getMeta('collected_identity');
    if (!options.refresh && previousIdentity !== null && previousIdentity !== identity) {
      progress(
        `warning: this index was collected with author identity "${previousIdentity}", now "${identity}" — pass --refresh to re-attribute the commits.`,
      );
    }

    const toplevels = readToplevels(store);
    let toplevelsDirty = false;

    for (const dir of [...new Set(dirs)]) {
      const toplevel = await resolveToplevel(dir);
      if (!toplevel) {
        throw new Error(`Not a git repository: ${dir} — pass the clone's directory to --git-dir.`);
      }
      const repoName = localRepoKeyFrom(toplevels, toplevel);
      result.repos.push(repoName);
      if (rememberToplevel(toplevels, toplevel)) {
        toplevelsDirty = true;
      }
      progress(`Reading local repository ${repoName} (${toplevel}) …`);

      for (const candidate of ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS']) {
        try {
          store.setMeta(codeownersMetaKey(repoName), await readFile(path.join(toplevel, candidate), 'utf8'));
          break;
        } catch {
          // try the next candidate location
        }
      }

      // core.quotePath=false keeps non-ASCII paths readable instead of
      // C-style-escaped ("\346\224\257\344\273\230/…") — module names would
      // otherwise be garbage for any repo with a unicode directory.
      const out = await git(toplevel, [
        '-c',
        'core.quotePath=false',
        'log',
        `--format=${RECORD}%H${FIELD}%an${FIELD}%ae${FIELD}%aI${FIELD}%B${FIELD}`,
        '--numstat',
        '--no-color',
        ...(options.since ? ['--since', options.since] : []),
      ]);

      // A \x1e byte inside a commit message splits the record: the fragment
      // that follows has no sha and is the previous record's message tail.
      const records: string[] = [];
      for (const raw of out.split(RECORD)) {
        if (!raw.trim()) {
          continue;
        }
        const sha = (raw.split(FIELD)[0] ?? '').trim();
        if (!SHA_RE.test(sha) && records.length > 0) {
          records[records.length - 1] += RECORD + raw;
          continue;
        }
        records.push(raw);
      }

      // Without --since the log covered the branch's full history — anything
      // still in the index but absent here was rewritten away (amend, rebase,
      // force-push) and would otherwise haunt the risk ratios forever. A
      // --since log is partial, so pruning there would delete valid history.
      const seenShas: string[] = [];

      for (const record of records) {
        const fields = record.split(FIELD);
        const sha = (fields[0] ?? '').trim();
        if (!SHA_RE.test(sha)) {
          continue;
        }
        seenShas.push(sha);
        if (!options.refresh && store.hasCommit(repoName, sha)) {
          result.skippedCommits += 1;
          continue;
        }
        const authorName = (fields[1] ?? '').trim();
        const authorEmail = (fields[2] ?? '').trim();
        const authoredAt = (fields[3] ?? '').trim();
        // A \x1f byte inside %B shifts the fields; everything between the
        // message and the trailing numstat is message. Either way the message
        // is stripped of the raw control bytes the format relies on.
        const numstat = fields[fields.length - 1] ?? '';
        const message =
          fields.length > 6 ? fields.slice(4, -1).join(FIELD) : (fields[4] ?? '');
        const messageClean = message.replace(CONTROL_CHARS_RE, ' ').trim();

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
          // never fabricate "now" for an unknown date — it would read as recent
          // activity and inflate the module's change frequency
          authoredAt: toUtcIso(authoredAt),
          message: messageClean,
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

      if (!options.since) {
        store.pruneCommitsNotSeen(repoName, seenShas);
      }
    }

    if (toplevelsDirty) {
      store.setMeta(TOPLEVELS_META_KEY, JSON.stringify(toplevels));
    }
    const existing = (store.getMeta('repos') ?? '')
      .split(',')
      .map((repo) => repo.trim())
      .filter(Boolean);
    store.setMeta('repos', [...new Set([...existing, ...result.repos])].join(','));
    // GitHub collection records the canonical login here first; keep it rather
    // than downgrading the display name to the raw CLI argument.
    if (store.getMeta('collected_for') === null) {
      store.setMeta('collected_for', username);
    }
    store.setMeta('collected_identity', identity);
    markCollectionSource(store, 'local-git');
    store.setMeta('last_collected_at', new Date().toISOString());
    return result;
  }
}
