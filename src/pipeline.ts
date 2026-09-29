import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sameLogin } from './identity.js';
import type { HandoverBook, RiskItem } from './types.js';
import { loadConfig, type HandoverConfig, type LlmProviderName } from './config.js';
import { parseUsername } from './args.js';
import { HandoverStore } from './store/sqlite.js';
import { requireIndex } from './store/index-check.js';
import { GitHubCollector, countCollected } from './collect/github.js';
import { GitDirectoryCollector, previewLocalRepoKeys, recordedLocalRepoKeys, resolveToplevel } from './collect/git.js';
import { computeRisk } from './risk/engine.js';
import { synthesizeChapters, DIGEST_CHAR_BUDGET } from './distill/synthesize.js';
import { createProvider, type LlmProvider } from './distill/llm.js';
import { buildActions, buildCoverage } from './report/summary.js';
import { renderBook } from './render/markdown.js';
import { renderBookHtml } from './render/html.js';
import { redact } from './render/redact.js';

export interface GenerateOptions {
  username: string;
  /** GitHub repositories (owner/name); pass at least one of repos/gitDirs */
  repos: string[];
  /** local git clone directories to read instead of / in addition to GitHub */
  gitDirs?: string[];
  /** git author name/email substring identifying the engineer in local repos (defaults to username) */
  authorIdentity?: string;
  dataDir?: string;
  githubToken?: string;
  provider?: LlmProviderName;
  model?: string;
  since?: string;
  refresh?: boolean;
  /** override the default-on secret scrubbing for this run */
  redact?: boolean;
  /** also write a print-ready single-file HTML twin of the book */
  html?: boolean;
  /** skip LLM synthesis (the default); set false only via --use-llm / HANDOVER_LLM=1 */
  noLlm?: boolean;
  onProgress?: (message: string) => void;
}

export interface GenerateResult {
  book: HandoverBook;
  risks: RiskItem[];
  dbPath: string;
  bookPath: string;
  /** set when html=true */
  htmlPath?: string;
}

function bookPathFor(config: HandoverConfig, username: string): string {
  return path.join(config.dataDir, `handover-book-${username}.md`);
}

function dbPathFor(config: HandoverConfig, username: string): string {
  return path.join(config.dataDir, `${username}.db`);
}

/** Resolve the LLM provider; a missing credential degrades to deterministic synthesis. */
function tryCreateProvider(config: HandoverConfig, onProgress: (message: string) => void): LlmProvider | null {
  if (config.noLlm) {
    onProgress('LLM synthesis disabled (--no-llm is the default; enable with --use-llm or HANDOVER_LLM=1); chapters 4-6 use deterministic fallbacks. Nothing leaves this machine.');
    return null;
  }
  try {
    const provider = createProvider(config);
    // Explicit consent record: the flag is opt-in, but say what it now does.
    onProgress(
      `LLM synthesis enabled — sending the collected evidence digest (up to ${DIGEST_CHAR_BUDGET.toLocaleString()} characters) to ${provider.name}/${provider.model}. Known secret formats are scrubbed from it on the way out; \`--no-redact\` / HANDOVER_NO_REDACT=1 turns that off, which only makes sense if you know this history is clean.`,
    );
    return provider;
  } catch (error) {
    onProgress(`LLM synthesis disabled (${error instanceof Error ? error.message : String(error)}); chapters 4-6 will use deterministic fallbacks.`);
    return null;
  }
}

/**
 * Warn when the index and the generated book land inside a git working tree:
 * they hold verbatim commit messages, PR bodies and review text from the
 * analysed repositories, and a data dir outside the repo's own .gitignore is a
 * realistic way to commit them by accident.
 */
async function warnIfInsideWorkTree(dataDir: string, onProgress: (message: string) => void): Promise<void> {
  try {
    const top = await resolveToplevel(path.resolve(dataDir));
    if (top) {
      onProgress(
        `warning: "${dataDir}" is inside the git working tree ${top} — the SQLite index and the book quote repository content verbatim. Keep handover-data/ out of commits (add it to .gitignore) or pass --data-dir outside the repo.`,
      );
    }
  } catch {
    // the warning is best-effort; never fail a run over it
  }
}

async function finishFromStore(
  store: HandoverStore,
  config: HandoverConfig,
  username: string,
  repos: string[],
  onProgress: (message: string) => void,
  /** GitHub's canonical login for display; `username` stays the lowercase file key. */
  display = username,
  flags: { redact?: boolean; html?: boolean } = {},
): Promise<GenerateResult> {
  const doRedact = flags.redact ?? config.redact;
  onProgress('Computing Risk Top 5 …');
  const risks = computeRisk(store, display);
  const coverage = buildCoverage(store, [...repos]);
  const actions = buildActions(risks, display);

  const provider = tryCreateProvider(config, onProgress);
  onProgress('Synthesizing chapters …');
  const chapters = await synthesizeChapters({ username: display, repos, store, risks, redact: doRedact, onProgress }, provider);

  const book: HandoverBook = {
    username: display,
    repos,
    generatedAt: new Date().toISOString(),
    chapters,
    llmProvider: provider?.name,
    llmModel: provider?.model,
    redacted: doRedact || undefined,
    coverage,
    actions,
  };
  const bookPath = bookPathFor(config, username);
  let markdown = renderBook(book);
  if (doRedact) {
    markdown = redact(markdown);
  }
  await writeFile(bookPath, markdown, 'utf8');
  onProgress(`Handover Book written to ${bookPath}`);

  let htmlPath: string | undefined;
  if (flags.html) {
    htmlPath = `${bookPath.slice(0, -3)}.html`;
    await writeFile(htmlPath, renderBookHtml(book, markdown), 'utf8');
    onProgress(`HTML twin written to ${htmlPath}`);
  }

  return { book, risks, dbPath: dbPathFor(config, username), bookPath, htmlPath };
}

/** Full run: collect → index → risk → synthesis → rendered book. */
export async function generateHandoverBook(options: GenerateOptions): Promise<GenerateResult> {
  // Library callers bypass the CLI/MCP argument parsers, and the index file and
  // book file names derive from the username — validate at this boundary too,
  // or "../.." would write outside the data directory.
  const username = parseUsername(options.username);
  const config = loadConfig({
    githubToken: options.githubToken,
    provider: options.provider,
    model: options.model,
    dataDir: options.dataDir,
    redact: options.redact,
    noLlm: options.noLlm,
  });
  const onProgress = options.onProgress ?? (() => {});
  const repos = [...new Set(options.repos)];
  const gitDirs = options.gitDirs ?? [];
  if (repos.length === 0 && gitDirs.length === 0) {
    throw new Error('Nothing to collect — pass at least one -r owner/name (GitHub) or --git-dir <clone> (local).');
  }
  await mkdir(config.dataDir, { recursive: true });
  await warnIfInsideWorkTree(config.dataDir, onProgress);

  const store = new HandoverStore(dbPathFor(config, username));
  try {
    let display = username;
    let collectedTotal = 0;
    const scope = [...repos];

    // Local repo keys up front — the ones passed to this run and every local
    // clone already recorded in this index — so the GitHub collector's orphan
    // cleanup never wipes locally-collected history (a later -r-only run
    // cannot re-collect it from GitHub).
    const preserveRepos = [
      ...new Set([
        ...(gitDirs.length > 0 ? await previewLocalRepoKeys(store, gitDirs) : []),
        ...recordedLocalRepoKeys(store),
      ]),
    ];

    if (repos.length > 0) {
      onProgress(`Collecting GitHub history for @${username} …`);
      const collector = new GitHubCollector(config.githubToken, undefined, { baseUrl: config.githubApiUrl });
      const collected = await collector.collectInto(store, username, repos, {
        since: options.since,
        refresh: options.refresh,
        preserveRepos,
        onProgress,
      });
      onProgress(
        `Collection done: ${collected.indexedCommits} new commits indexed (${collected.skippedCommits} already cached), ${collected.pullRequests} PRs (${collected.skippedPullRequests} cached), ${collected.reviews} reviews, ${collected.issues} issues (${collected.skippedIssues} cached).`,
      );
      display = collected.login || display;
      collectedTotal += countCollected(collected);
    }

    if (gitDirs.length > 0) {
      onProgress(`Reading ${gitDirs.length} local git repositor${gitDirs.length === 1 ? 'y' : 'ies'} …`);
      const local = await new GitDirectoryCollector().collectInto(store, username, gitDirs, {
        since: options.since,
        refresh: options.refresh,
        identity: options.authorIdentity,
        onProgress,
      });
      onProgress(
        `Local collection done: ${local.indexedCommits} new commits indexed (${local.skippedCommits} already cached) from ${local.repos.join(', ')}.`,
      );
      collectedTotal += local.indexedCommits + local.skippedCommits;
      scope.push(...local.repos);
    }

    if (collectedTotal === 0) {
      onProgress(
        `warning: no activity found for @${username} in ${scope.join(', ')} — check the username, the names/dirs, and the --since window.`,
      );
    }
    return await finishFromStore(store, config, username, [...new Set(scope)], onProgress, display, {
      redact: options.redact,
      html: options.html,
    });
  } finally {
    store.close();
  }
}

/** Re-render the book from an existing SQLite index, without touching the network.
 *  When `repos` is omitted, the list recorded at collect time is used. */
export async function renderHandoverBook(
  options: Omit<GenerateOptions, 'since' | 'refresh' | 'githubToken' | 'repos'> & { repos?: string[] },
): Promise<GenerateResult> {
  const config = loadConfig({
    dataDir: options.dataDir,
    provider: options.provider,
    model: options.model,
    noLlm: options.noLlm,
  });
  const onProgress = options.onProgress ?? (() => {});
  // Same library-boundary validation as generateHandoverBook: file names here
  // are derived from the username as well. requireIndex runs *before* the store
  // opens: better-sqlite3 would otherwise create an empty `<user>.db` just to
  // fail on the missing meta rows — and that empty file then satisfies the
  // guard forever, making a later `handover risk` answer "(no items)" instead
  // of "run collect first".
  const username = parseUsername(options.username);
  await requireIndex(config.dataDir, username, `run "handover collect ${username} -r owner/name" first.`);
  await mkdir(config.dataDir, { recursive: true });
  const store = new HandoverStore(dbPathFor(config, username));
  try {
    let repos = options.repos ?? [];
    if (repos.length === 0) {
      repos = (store.getMeta('repos') ?? '')
        .split(',')
        .map((repo) => repo.trim())
        .filter(Boolean);
      if (repos.length === 0) {
        throw new Error(
          `The index for @${username} does not record any repositories — pass -r owner/name, or collect first.`,
        );
      }
      onProgress(`Using repositories from the index: ${repos.join(', ')}`);
    }
    // Prefer the canonical login recorded at collect time for display.
    const collectedFor = store.getMeta('collected_for');
    const display = collectedFor && sameLogin(collectedFor, username) ? collectedFor : username;
    return await finishFromStore(store, config, username, repos, onProgress, display, {
      redact: options.redact,
      html: options.html,
    });
  } finally {
    store.close();
  }
}
