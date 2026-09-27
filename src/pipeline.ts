import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { HandoverBook, RiskItem } from './types.js';
import { loadConfig, type HandoverConfig, type LlmProviderName } from './config.js';
import { HandoverStore } from './store/sqlite.js';
import { GitHubCollector } from './collect/github.js';
import { computeRisk } from './risk/engine.js';
import { synthesizeChapters } from './distill/synthesize.js';
import { createProvider, type LlmProvider } from './distill/llm.js';
import { renderBook } from './render/markdown.js';

export interface GenerateOptions {
  username: string;
  repos: string[];
  dataDir?: string;
  githubToken?: string;
  provider?: LlmProviderName;
  model?: string;
  since?: string;
  refresh?: boolean;
  onProgress?: (message: string) => void;
}

export interface GenerateResult {
  book: HandoverBook;
  risks: RiskItem[];
  dbPath: string;
  bookPath: string;
}

function bookPathFor(config: HandoverConfig, username: string): string {
  return path.join(config.dataDir, `handover-book-${username}.md`);
}

function dbPathFor(config: HandoverConfig, username: string): string {
  return path.join(config.dataDir, `${username}.db`);
}

/** Resolve the LLM provider; a missing credential degrades to deterministic synthesis. */
function tryCreateProvider(config: HandoverConfig, onProgress: (message: string) => void): LlmProvider | null {
  try {
    return createProvider(config);
  } catch (error) {
    onProgress(`LLM synthesis disabled (${error instanceof Error ? error.message : String(error)}); chapters 4-6 will use deterministic fallbacks.`);
    return null;
  }
}

async function finishFromStore(
  store: HandoverStore,
  config: HandoverConfig,
  username: string,
  repos: string[],
  onProgress: (message: string) => void,
): Promise<GenerateResult> {
  onProgress('Computing Risk Top 5 …');
  const risks = computeRisk(store, username);

  const provider = tryCreateProvider(config, onProgress);
  onProgress('Synthesizing chapters …');
  const chapters = await synthesizeChapters({ username, repos, store, risks, onProgress }, provider);

  const book: HandoverBook = {
    username,
    repos,
    generatedAt: new Date().toISOString(),
    chapters,
  };
  const bookPath = bookPathFor(config, username);
  await writeFile(bookPath, renderBook(book), 'utf8');
  onProgress(`Handover Book written to ${bookPath}`);

  return { book, risks, dbPath: dbPathFor(config, username), bookPath };
}

/** Full run: collect → index → risk → synthesis → rendered book. */
export async function generateHandoverBook(options: GenerateOptions): Promise<GenerateResult> {
  const config = loadConfig({
    githubToken: options.githubToken,
    provider: options.provider,
    model: options.model,
    dataDir: options.dataDir,
  });
  const onProgress = options.onProgress ?? (() => {});
  await mkdir(config.dataDir, { recursive: true });

  const store = new HandoverStore(dbPathFor(config, options.username));
  try {
    onProgress(`Collecting GitHub history for @${options.username} …`);
    const collector = new GitHubCollector(config.githubToken);
    const collected = await collector.collectInto(store, options.username, options.repos, {
      since: options.since,
      refresh: options.refresh,
      onProgress,
    });
    onProgress(
      `Collection done: ${collected.indexedCommits} new commits indexed (${collected.skippedCommits} already cached), ${collected.pullRequests} PRs (${collected.skippedPullRequests} cached), ${collected.reviews} reviews, ${collected.issues} issues (${collected.skippedIssues} cached).`,
    );
    const collectedTotal =
      collected.indexedCommits +
      collected.skippedCommits +
      collected.pullRequests +
      collected.skippedPullRequests +
      collected.reviews +
      collected.issues +
      collected.skippedIssues;
    if (collectedTotal === 0) {
      onProgress(
        `warning: no GitHub activity found for @${options.username} in ${options.repos.join(', ')} — check the username, the repo names, and the --since window.`,
      );
    }
    return await finishFromStore(store, config, options.username, options.repos, onProgress);
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
  });
  const onProgress = options.onProgress ?? (() => {});
  const store = new HandoverStore(dbPathFor(config, options.username));
  try {
    let repos = options.repos ?? [];
    if (repos.length === 0) {
      repos = (store.getMeta('repos') ?? '')
        .split(',')
        .map((repo) => repo.trim())
        .filter(Boolean);
      if (repos.length === 0) {
        throw new Error(
          `The index for @${options.username} does not record any repositories — pass -r owner/name, or collect first.`,
        );
      }
      onProgress(`Using repositories from the index: ${repos.join(', ')}`);
    }
    return await finishFromStore(store, config, options.username, repos, onProgress);
  } finally {
    store.close();
  }
}
