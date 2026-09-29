import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { sameOrBelow } from '../config.js';
import { sanitizeToken } from '../store/sanitize.js';

import { codeownersMetaKey } from './codeowners.js';
import { markCollectionSource } from '../report/summary.js';
import { normalizeSince } from '../args.js';
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

/**
 * The collector is also a library (the MCP server reaches it through the
 * pipeline), so the one value handed to git as an option is re-checked rather
 * than trusted. It uses the CLI's own validator: an earlier version of this
 * guard matched the *shape* only, and a test showed `--since=2026-13-45`
 * slipping through it while `handover --since` rejected the same value.
 */
function assertSinceArg(since: string): string {
  return normalizeSince(since);
}

/** meta key holding { basename → toplevel } so repo keys stay stable across runs */
const TOPLEVELS_META_KEY = 'local_toplevels';

/**
 * Belt-and-braces around repo-local git configuration.
 *
 * An honest note on why these are *not* a proven fix: on git 2.53, the commands
 * this collector runs turned out not to reach the dangerous settings at all —
 * `git log --numstat` never invokes a repo-configured `diff.*.textconv` driver
 * (numstat is computed from the raw blobs), and git disables the pager by itself
 * when stdout is not a TTY. So nothing here blocks an exploit that was shown to
 * be reachable; each flag is cheap, inert for normal repositories, and becomes
 * load-bearing the moment someone widens the log invocation (adding `-p` would
 * put textconv and external diff back on the table). `core.fsmonitor` was not
 * exercised. Treat this list as reducing the blast radius of an untrusted clone,
 * not as sealing it.
 */
const SAFE_GIT_ARGS = [
  '--no-pager',
  // `color.ui = always` in the repo config makes git emit real ANSI escapes
  // with no TTY at all (verified: `\u001b[33m<sha>\u001b[m one`), so colouring
  // is not something "we are not a terminal" protects against.
  '-c', 'color.ui=false',
  '-c', 'core.fsmonitor=false',
  '-c', 'core.pager=cat',
  '-c', 'pager.log=false',
  '-c', 'pager.diff=false',
  '-c', 'diff.external=false',
  '-c', 'core.hooksPath=.handover-no-hooks',
  // Author attribution must not drift with the machine: without this, a global
  // `log.mailmap=true` folds one person's emails into a canonical identity on
  // one box and not on another — and the hasCommit skip freezes whichever
  // attribution the *first* run saw into the index for good.
  '-c', 'log.mailmap=false',
];

/** A hung git (stale lockfile, wedged network filesystem) must not stall the run forever. */
const GIT_TIMEOUT_MS = 10 * 60_000;

/**
 * On Windows, CreateProcess resolves a bare executable name against the calling
 * process's working directory first — and the MCP server's cwd is the workspace
 * the model writes to, so a planted `git.exe` there would be the binary that
 * runs. Resolve git's real location once (System32's own `where.exe`, by
 * absolute path so it cannot be shadowed the same way) and spawn that; on other
 * platforms execvp never searched the cwd, so `git` from PATH is fine.
 */
let cachedGitBinary: string | undefined;
function gitBinary(): string {
  if (cachedGitBinary === undefined) {
    cachedGitBinary = 'git';
    if (process.platform === 'win32') {
      try {
        const where = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'where.exe');
        const out = execFileSync(where, ['git'], {
          encoding: 'utf8',
          windowsHide: true,
          timeout: 10_000,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        const first = out.split(/\r?\n/).map((line) => line.trim()).find((line) => line.toLowerCase().endsWith('.exe'));
        if (first) {
          cachedGitBinary = first;
        }
      } catch {
        // fall back to PATH resolution; a missing git surfaces as a clear spawn error anyway
      }
    }
  }
  return cachedGitBinary;
}

/**
 * Runs git and collects stdout. Spawn-with-accumulation instead of execFile's
 * maxBuffer: a full `git log --numstat` of a large monorepo history can
 * outgrow any fixed buffer, and the tool's whole point is complete history.
 * LC_ALL=C pins the message git uses for "no commits yet" (it is matched below)
 * regardless of the machine's locale; content bytes are unaffected.
 */
async function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(gitBinary(), ['-C', cwd, ...SAFE_GIT_ARGS, ...args], {
      windowsHide: true,
      env: { ...process.env, LC_ALL: 'C' },
      timeout: GIT_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    const chunks: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      const stdout = Buffer.concat(chunks).toString('utf8');
      if (code === 0) {
        resolve(stdout);
        return;
      }
      if (/does not have any commits yet/i.test(stderr)) {
        resolve('');
        return;
      }
      const reason = signal
        ? `terminated (${signal}) after ${GIT_TIMEOUT_MS / 60000} minutes`
        : `exit code ${code}`;
      reject(new Error(`git ${args.join(' ')} failed in ${cwd}: ${stderr.trim().slice(0, 300) || reason}`));
    });
  });
}

/** Resolves a directory to its git toplevel; null when it is not a repository. */
export async function resolveToplevel(dir: string): Promise<string | null> {
  try {
    const toplevel = (await git(dir, ['rev-parse', '--show-toplevel'])).trim();
    return toplevel || null;
  } catch {
    return null;
  }
}

/**
 * Same, plus the confinement the caller's authorization implies: the toplevel
 * git reports is influenced by the repository itself — a `.git` *file*
 * (`gitdir: …`) or a repo-configured `core.worktree` can resolve it anywhere on
 * disk. The caller authorized a directory, so the toplevel must live at or
 * below it; anything else is refused instead of read.
 *
 * Both sides go through `realpathSync.native`, not plain realpath: on Windows,
 * git answers with long paths (`C:/Users/Alice/…`) while the process may have
 * been handed the 8.3 short form of the same directory (`ADMINI~1`), and plain
 * realpath preserves the short name verbatim — the two spellings of one
 * directory would compare unequal and reject every legitimate repo.
 */
function nativeRealpath(value: string): string {
  try {
    return realpathSync.native(value);
  } catch {
    return realpathSync(value);
  }
}

async function resolveConfinedToplevel(dir: string): Promise<string | null> {
  const toplevel = await resolveToplevel(dir);
  if (!toplevel) {
    return null;
  }
  if (!sameOrBelow(nativeRealpath(toplevel), nativeRealpath(dir))) {
    throw new Error(
      `git toplevel "${toplevel}" is outside the requested directory "${dir}" — a .git pointer file or core.worktree may be redirecting it; refusing to read it.`,
    );
  }
  return toplevel;
}

/**
 * The map lives in the index database, which is attacker-writable in any model
 * where a database file is handed around. Validate it as string→string instead
 * of casting: the values are compared against resolved paths, and a nested
 * object or prototype-influencing key would produce nonsense rather than an
 * error. The null prototype matters as much as the filter — basenames like
 * `constructor` or `__proto__` are legal directory names, and on a normal
 * object literal `toplevels[basename]` would read inherited properties and
 * `toplevels[key] = …` would silently hit a setter instead of recording.
 */
function readToplevels(store: HandoverStore): Record<string, string> {
  // Every return path shares this: a plain `{}` carries Object.prototype, and the
  // map is indexed by directory basenames, which are attacker-chosen.
  const toplevels: Record<string, string> = Object.create(null);
  const raw = store.getMeta(TOPLEVELS_META_KEY);
  if (!raw) {
    return toplevels;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return toplevels;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return toplevels;
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'string') {
      toplevels[key] = value;
    }
  }
  return toplevels;
}

/**
 * Directory basenames become repo keys, and the store sanitizes every key it
 * writes — a basename carrying an invisible character would otherwise exist in
 * two spellings (raw here, stripped in the index) and the two would never
 * match in prune/coverage comparisons. Sanitize once, at derivation.
 */
function repoBasename(toplevel: string): string {
  return sanitizeToken(path.basename(toplevel));
}

/** Pure key derivation against a shared basename→toplevel map. */
function localRepoKeyFrom(toplevels: Record<string, string>, toplevel: string): string {
  const basename = repoBasename(toplevel);
  const recorded = toplevels[basename];
  if (recorded === undefined || recorded === toplevel) {
    return basename;
  }
  const suffix = createHash('sha256').update(toplevel).digest('hex').slice(0, 6);
  return `${basename}-${suffix}`;
}

/** Records a resolved toplevel in the shared map (and marks the map changed). */
function rememberToplevel(toplevels: Record<string, string>, toplevel: string): boolean {
  const basename = repoBasename(toplevel);
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
    const toplevel = await resolveConfinedToplevel(dir);
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

/** Control bytes that would corrupt the \x1e/\x1f-split parsing of `git log`. */
const CONTROL_CHARS_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/**
 * Turns a numstat path (renames, quoted non-ASCII) into the resulting file path.
 * Control bytes are stripped last — the octal un-escaping above can introduce
 * them (`\000`, `\036`) — so a path can never carry a byte that would corrupt
 * the `\x1e`/`\x1f`-delimited stream it came from, or a NUL that truncates the
 * module name wherever the book is opened.
 */
export function resolveNumstatPath(raw: string): string {
  let p = raw.trim();
  if (p.startsWith('"') && p.endsWith('"')) {
    p = p.slice(1, -1);
  }
  if (/\\\d{3}/.test(p)) {
    // C-style octal escapes (git's core.quotePath) encode UTF-8 bytes — decode
    // the whole string byte-wise, then reinterpret as UTF-8. ("支払/a.ts")
    // Non-ASCII characters outside the escapes (quotePath=false leaves them
    // literal) must re-enter the byte stream as their own UTF-8 encoding:
    // pushing charCodeAt straight into a Buffer truncates every code above 255.
    const bytes: number[] = [];
    for (let i = 0; i < p.length; i += 1) {
      if (p[i] === '\\' && /^[0-7]{3}$/.test(p.slice(i + 1, i + 4))) {
        bytes.push(parseInt(p.slice(i + 1, i + 4), 8));
        i += 3;
      } else {
        const code = p.codePointAt(i)!;
        if (code > 0x7f) {
          bytes.push(...Buffer.from(String.fromCodePoint(code), 'utf8'));
        } else {
          bytes.push(code);
        }
        i += String.fromCodePoint(code).length - 1;
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
  return p.replace(CONTROL_CHARS_RE, '').trim();
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
      const toplevel = await resolveConfinedToplevel(dir);
      if (!toplevel) {
        throw new Error(`Not a git repository: ${dir} — pass the clone's directory to --git-dir.`);
      }
      const repoName = localRepoKeyFrom(toplevels, toplevel);
      result.repos.push(repoName);
      if (rememberToplevel(toplevels, toplevel)) {
        toplevelsDirty = true;
      }
      progress(`Reading local repository ${repoName} (${toplevel}) …`);

      // Same precedence as GitHub's own CODEOWNERS lookup: root, .github/, docs/.
      for (const candidate of ['CODEOWNERS', '.github/CODEOWNERS', 'docs/CODEOWNERS']) {
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
      // --no-ext-diff suppresses external diff and textconv drivers. Verified on
      // git 2.53 that --numstat does not run them anyway, so this is insurance
      // against the invocation widening later, not a fix for a live vector.
      // `--since=<value>` (not the two-token form) so the value can never be
      // read as another option.
      const out = await git(toplevel, [
        '-c',
        'core.quotePath=false',
        'log',
        `--format=${RECORD}%H${FIELD}%an${FIELD}%ae${FIELD}%aI${FIELD}%B${FIELD}`,
        '--numstat',
        '--no-color',
        '--no-ext-diff',
        ...(options.since ? [`--since=${assertSinceArg(options.since)}`] : []),
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
      // An *empty* log is different: it means the checkout currently has no
      // commits reachable from HEAD (an orphan branch, an empty clone), not
      // that the indexed history is stale — pruning then would wipe the repo's
      // whole evidence on a mere branch switch.
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

      if (!options.since && seenShas.length > 0) {
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
