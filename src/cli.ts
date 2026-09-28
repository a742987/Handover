#!/usr/bin/env node
import { createRequire } from 'node:module';
import { mkdir, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Command, InvalidArgumentError } from 'commander';
import { loadConfig, type LlmProviderName } from './config.js';
import { parseRepos, parseSince, parseUsername } from './args.js';
import { sameLogin } from './identity.js';
import { applyAnswers, parseAnswersJson, runInteractiveCapture } from './capture.js';
import { generateHandoverBook, renderHandoverBook } from './pipeline.js';
import { verifyCitations } from './verify.js';
import { GitHubCollector, countCollected } from './collect/github.js';
import { GitDirectoryCollector } from './collect/git.js';
import { computeRisk } from './risk/engine.js';
import { computeBusFactor } from './risk/busfactor.js';
import { matchTouchedModules, renderGateComment } from './risk/gate.js';
import { HandoverStore } from './store/sqlite.js';
import { requireIndex } from './store/index-check.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

function printRiskTable(risks: Array<{ rank: number; module: string; score: number; rationale: string }>): void {
  if (risks.length === 0) {
    console.log('\nRisk Top 5: (no items)');
    return;
  }
  console.log('\nRisk Top 5:');
  for (const risk of risks) {
    console.log(`  ${risk.rank}. ${risk.module.padEnd(40)} score ${risk.score.toFixed(3)}`);
    console.log(`     ${risk.rationale}`);
  }
}

function fail(error: unknown): never {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const program = new Command();

program
  .name('handover')
  .description("When a developer leaves, their knowledge shouldn't — generate a bound, evidence-linked Handover Book.")
  .version(pkg.version);

program
  .command('gen')
  .description('collect, analyze and render the Handover Book for a departing engineer')
  .argument('<username>', 'GitHub username of the departing engineer', parseUsername)
  .option('-r, --repo <repo...>', 'owner/name repositories to read (repeat the flag or comma-separate)', parseRepos, [])
  .option('-d, --git-dir <dir...>', 'local git clone directories to read (no token needed)')
  .option('--author <identity>', 'git author name/email substring for --git-dir matching (default: the username)')
  .option('--provider <provider>', 'LLM provider: openai | anthropic | ollama')
  .option('--model <model>', 'LLM model override')
  .option('--since <date>', 'only collect activity created after this ISO date (zoneless times are treated as UTC)', parseSince)
  .option('--data-dir <dir>', 'directory for the SQLite index and the generated book (default: handover-data, or HANDOVER_DATA_DIR)')
  .option('--refresh', 're-fetch commit details even for already-indexed commits', false)
  .option('--redact', 'scrub known secret formats from the LLM digest and the rendered book (or HANDOVER_REDACT=1)')
  .option('--html', 'also write a print-ready single-file HTML twin of the book')
  .option('--no-llm', 'skip LLM synthesis even when an API key is configured — chapters 4-6 use deterministic fallbacks and nothing leaves this machine (or HANDOVER_NO_LLM=1)')
  .action(async (username: string, options: {
    repo: string[];
    gitDir?: string[];
    author?: string;
    provider?: string;
    model?: string;
    since?: string;
    dataDir?: string;
    refresh?: boolean;
    redact?: boolean;
    html?: boolean;
    noLlm?: boolean;
  }) => {
    try {
      const result = await generateHandoverBook({
        username,
        repos: options.repo,
        gitDirs: options.gitDir,
        authorIdentity: options.author,
        dataDir: options.dataDir,
        provider: options.provider as LlmProviderName | undefined,
        model: options.model,
        since: options.since,
        refresh: options.refresh,
        redact: options.redact,
        html: options.html,
        noLlm: options.noLlm,
        onProgress: (message) => console.log(message),
      });
      printRiskTable(result.risks);
      console.log(`\nBook:  ${result.bookPath}`);
      if (result.htmlPath) {
        console.log(`HTML:  ${result.htmlPath}`);
      }
      console.log(`Index: ${result.dbPath}`);
    } catch (error) {
      fail(error);
    }
  });

program
  .command('collect')
  .description('collect GitHub history into the local index without rendering the book')
  .argument('<username>', 'GitHub username of the departing engineer', parseUsername)
  .option('-r, --repo <repo...>', 'owner/name repositories to read', parseRepos, [])
  .option('-d, --git-dir <dir...>', 'local git clone directories to read (no token needed)')
  .option('--author <identity>', 'git author name/email substring for --git-dir matching (default: the username)')
  .option('--since <date>', 'only collect activity created after this ISO date (zoneless times are treated as UTC)', parseSince)
  .option('--data-dir <dir>', 'directory for the SQLite index (default: handover-data, or HANDOVER_DATA_DIR)')
  .option('--refresh', 're-fetch commit details even for already-indexed commits', false)
  .action(async (username: string, options: {
    repo: string[];
    gitDir?: string[];
    author?: string;
    since?: string;
    dataDir?: string;
    refresh?: boolean;
  }) => {
    if (options.repo.length === 0 && !options.gitDir?.length) {
      fail(new Error('pass at least one -r owner/name (GitHub) or -d <clone dir> (local git)'));
    }
    try {
      const config = loadConfig({ dataDir: options.dataDir });
      await mkdir(config.dataDir, { recursive: true });
      const store = new HandoverStore(path.join(config.dataDir, `${username}.db`));
      let found = 0;
      try {
        if (options.repo.length > 0) {
          const collector = new GitHubCollector(config.githubToken);
          const collected = await collector.collectInto(store, username, options.repo, {
            since: options.since,
            refresh: options.refresh,
            onProgress: (message) => console.log(message),
          });
          console.log(
            `Collected: ${collected.indexedCommits} new commits (${collected.skippedCommits} cached), ${collected.pullRequests} PRs (${collected.skippedPullRequests} cached), ${collected.reviews} reviews, ${collected.issues} issues (${collected.skippedIssues} cached).`,
          );
          found += countCollected(collected);
        }
        if (options.gitDir?.length) {
          const local = await new GitDirectoryCollector().collectInto(store, username, options.gitDir, {
            since: options.since,
            refresh: options.refresh,
            identity: options.author,
            onProgress: (message) => console.log(message),
          });
          console.log(`Collected locally: ${local.indexedCommits} new commits (${local.skippedCommits} cached) from ${local.repos.join(', ')}.`);
          found += local.indexedCommits + local.skippedCommits;
        }
        if (found === 0) {
          console.warn(
            `warning: no activity found for @${username} in ${[...options.repo, ...(options.gitDir ?? [])].join(', ')} — check the username, the repo names/dirs, and the --since window.`,
          );
        }
      } finally {
        store.close();
      }
    } catch (error) {
      fail(error);
    }
  });

program
  .command('risk')
  .description('print the Risk Top 5 from an existing index')
  .argument('<username>', 'GitHub username', parseUsername)
  .option('--data-dir <dir>', 'directory holding the SQLite index (default: handover-data, or HANDOVER_DATA_DIR)')
  .option('--json', 'machine-readable output for CI')
  .action(async (username: string, options: { dataDir?: string; json?: boolean }) => {
    try {
      const config = loadConfig({ dataDir: options.dataDir });
      await requireIndex(config.dataDir, username, `run "handover collect ${username} -r owner/name" first.`);
      const store = new HandoverStore(path.join(config.dataDir, `${username}.db`));
      try {
        const collectedFor = store.getMeta('collected_for');
        const display = collectedFor && sameLogin(collectedFor, username) ? collectedFor : username;
        const risks = computeRisk(store, display);
        if (options.json) {
          console.log(JSON.stringify(risks, null, 2));
          return;
        }
        printRiskTable(risks);
      } finally {
        store.close();
      }
    } catch (error) {
      fail(error);
    }
  });

program
  .command('capture')
  .description('record the departing engineer’s own answers into the index; they render into chapter 6')
  .argument('<username>', 'GitHub username of the departing engineer', parseUsername)
  .option('--data-dir <dir>', 'directory holding the SQLite index (default: handover-data, or HANDOVER_DATA_DIR)')
  .option('--answers <file>', 'non-interactive: JSON array of {"question","answer"} objects to append')
  .option('--list', 'print the answers already captured and exit')
  .action(async (username: string, options: { dataDir?: string; answers?: string; list?: boolean }) => {
    try {
      const config = loadConfig({ dataDir: options.dataDir });
      await requireIndex(config.dataDir, username, `run "handover collect ${username} -r owner/name" first.`);
      const store = new HandoverStore(path.join(config.dataDir, `${username}.db`));
      try {
        if (options.list) {
          const answers = store.listAnswers();
          if (answers.length === 0) {
            console.log('No captured answers yet.');
            return;
          }
          for (const answer of answers) {
            console.log(`Q: ${answer.question}\nA: ${answer.answer}\n`);
          }
          return;
        }
        if (options.answers) {
          const raw = await readFile(options.answers, 'utf8');
          const stored = applyAnswers(store, parseAnswersJson(raw));
          console.log(`Captured ${stored} answer(s). Re-render the book with "handover render ${username}".`);
          return;
        }
        if (!process.stdin.isTTY) {
          throw new Error('stdin is not a terminal — use --answers <file.json> for non-interactive capture.');
        }
        const stored = await runInteractiveCapture(store, username);
        console.log(`Captured ${stored} answer(s). Re-render the book with "handover render ${username}".`);
      } finally {
        store.close();
      }
    } catch (error) {
      fail(error);
    }
  });

program
  .command('bus-factor')
  .description('team view of the index: which modules one person owns, with CODEOWNERS where available')
  .argument('<username>', 'GitHub username owning the index', parseUsername)
  .option('--data-dir <dir>', 'directory holding the SQLite index (default: handover-data, or HANDOVER_DATA_DIR)')
  .option('--top <n>', 'how many modules to list', (value: string) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) {
      throw new InvalidArgumentError('--top must be a positive integer');
    }
    return n;
  })
  .option('--window <days>', 'activity window in days', (value: string) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) {
      throw new InvalidArgumentError('--window must be a positive number of days');
    }
    return n;
  })
  .option('--json', 'machine-readable output for CI')
  .action(async (username: string, options: { dataDir?: string; top?: number; window?: number; json?: boolean }) => {
    try {
      const config = loadConfig({ dataDir: options.dataDir });
      await requireIndex(config.dataDir, username, `run "handover collect ${username} -r owner/name" first.`);
      const store = new HandoverStore(path.join(config.dataDir, `${username}.db`));
      let items;
      try {
        items = computeBusFactor(store, { topN: options.top ?? 20, windowDays: options.window ?? 90 });
      } finally {
        store.close();
      }
      if (options.json) {
        console.log(JSON.stringify(items, null, 2));
        return;
      }
      if (items.length === 0) {
        console.log('Bus factor: the index has no commit activity for any module.');
        return;
      }
      console.log('\nBus factor map (most exposed first):');
      for (const item of items) {
        const flag = item.status === 'critical' ? 'ONE PERSON' : item.status === 'fragile' ? 'thin cover' : 'shared';
        const owners = item.owners.length > 0 ? `  owners ${item.owners.join(' ')}` : '';
        console.log(
          `  ${item.module.padEnd(44)} ${String(item.distinctAuthors).padStart(2)} author(s), top ${item.topAuthor} ${Math.round(item.topAuthorShare * 100)}%  [${flag}]${item.recent ? '' : '  quiet 90d'}${owners}`,
        );
      }
    } catch (error) {
      fail(error);
    }
  });

program
  .command('gate')
  .description('check whether a set of changed files touches sole-owned modules (for CI)')
  .argument('<username>', 'GitHub username whose index to consult', parseUsername)
  .requiredOption('--files <file>', 'newline-separated changed paths, or - for stdin')
  .option('--data-dir <dir>', 'directory holding the SQLite index (default: handover-data, or HANDOVER_DATA_DIR)')
  .option('--repo <owner/name>', 'restrict matching to one repository (a multi-repo index can hold the same module name twice)')
  .option('--comment', 'print a markdown PR comment instead of a table')
  .option('--fail-on-match', 'exit 1 when a sole-owned module is touched')
  .action(async (username: string, options: { files: string; dataDir?: string; repo?: string; comment?: boolean; failOnMatch?: boolean }) => {
    try {
      const config = loadConfig({ dataDir: options.dataDir });
      await requireIndex(config.dataDir, username, `run "handover collect ${username} -r owner/name" first.`);
      const raw = options.files === '-' ? readFileSync(0, 'utf8') : await readFile(options.files, 'utf8');
      const changed = raw.split('\n').map((line) => line.trim()).filter(Boolean);
      const store = new HandoverStore(path.join(config.dataDir, `${username}.db`));
      let matches;
      try {
        const collectedFor = store.getMeta('collected_for');
        const display = collectedFor && sameLogin(collectedFor, username) ? collectedFor : username;
        matches = matchTouchedModules(computeRisk(store, display, { topN: 1000 }), changed, options.repo);
      } finally {
        store.close();
      }
      if (options.comment) {
        console.log(renderGateComment(matches, username));
      } else if (matches.length === 0) {
        console.log(`Gate: ${changed.length} changed path(s), none in sole-owned modules.`);
      } else {
        console.log(`Gate: ${matches.length} sole-owned module(s) touched:`);
        for (const match of matches) {
          console.log(`  ${match.module}  score ${match.score.toFixed(3)}`);
          console.log(`  ${match.rationale}`);
        }
      }
      if (options.failOnMatch && matches.length > 0) {
        process.exitCode = 1;
      }
    } catch (error) {
      fail(error);
    }
  });

program
  .command('render')
  .description('re-render the Handover Book from an existing index (no GitHub network; LLM chapters use the configured provider if an API key is available)')
  .argument('<username>', 'GitHub username', parseUsername)
  .option('-r, --repo [repo...]', 'owner/name repositories (defaults to the ones recorded in the index)', parseRepos, [])
  .option('--provider <provider>', 'LLM provider: openai | anthropic | ollama')
  .option('--model <model>', 'LLM model override')
  .option('--data-dir <dir>', 'directory holding the SQLite index (default: handover-data, or HANDOVER_DATA_DIR)')
  .option('--redact', 'scrub known secret formats from the LLM digest and the rendered book (or HANDOVER_REDACT=1)')
  .option('--html', 'also write a print-ready single-file HTML twin of the book')
  .option('--no-llm', 'skip LLM synthesis even when an API key is configured — chapters 4-6 use deterministic fallbacks (or HANDOVER_NO_LLM=1)')
  .action(async (username: string, options: { repo: string[]; provider?: string; model?: string; dataDir?: string; redact?: boolean; html?: boolean; noLlm?: boolean }) => {
    try {
      const config = loadConfig({ dataDir: options.dataDir });
      await requireIndex(config.dataDir, username, `run "handover collect ${username} -r owner/name" first.`);
      const result = await renderHandoverBook({
        username,
        repos: options.repo,
        dataDir: options.dataDir,
        provider: options.provider as LlmProviderName | undefined,
        model: options.model,
        redact: options.redact,
        html: options.html,
        noLlm: options.noLlm,
        onProgress: (message) => console.log(message),
      });
      console.log(`\nBook:  ${result.bookPath}`);
      if (result.htmlPath) {
        console.log(`HTML:  ${result.htmlPath}`);
      }
      console.log(`Index: ${result.dbPath}`);
    } catch (error) {
      fail(error);
    }
  });

program
  .command('verify')
  .description('check that every evidence ref cited in the rendered book exists in the local index (exit 1 on missing refs)')
  .argument('<username>', 'GitHub username whose index and book to check', parseUsername)
  .option('--data-dir <dir>', 'directory holding the SQLite index and the book (default: handover-data, or HANDOVER_DATA_DIR)')
  .option('--file <path>', 'book file to check (default: <data-dir>/handover-book-<username>.md)')
  .option('--json', 'machine-readable report for CI')
  .action(async (username: string, options: { dataDir?: string; file?: string; json?: boolean }) => {
    try {
      const config = loadConfig({ dataDir: options.dataDir });
      await requireIndex(config.dataDir, username, `run "handover collect ${username} -r owner/name" first.`);
      const file = options.file ?? path.join(config.dataDir, `handover-book-${username}.md`);
      const markdown = await readFile(file, 'utf8').catch(() => {
        throw new Error(`book file not found at ${file} — run "handover gen" or "handover render" first, or pass --file <path>.`);
      });
      const store = new HandoverStore(path.join(config.dataDir, `${username}.db`));
      let report;
      try {
        report = verifyCitations(store, file, markdown);
      } finally {
        store.close();
      }
      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(`Checked ${report.checked.length} citation(s) against ${report.repos.length} repo(s) in scope.`);
        if (report.missingCount > 0) {
          console.error(`\nMissing refs (${report.missingCount}):`);
          for (const ref of report.checked.filter((item) => !item.ok)) {
            console.error(`  [${ref.raw}] — not found${ref.repo ? ` in ${ref.repo}` : ` in any of: ${report.repos.join(', ')}`}`);
          }
        } else {
          console.log('All cited evidence refs exist in the index.');
        }
      }
      if (report.missingCount > 0) {
        process.exitCode = 1;
      }
    } catch (error) {
      fail(error);
    }
  });

program.parseAsync(process.argv).catch(fail);
