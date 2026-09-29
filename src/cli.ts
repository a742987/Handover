#!/usr/bin/env node
import { createRequire } from 'node:module';
import { mkdir, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Command, InvalidArgumentError, Option } from 'commander';
import { loadConfig, type LlmProviderName } from './config.js';
import { printLine } from './print.js';
import { redact as redactSecrets } from './render/redact.js';
import { parseRepos, parseSince, parseUsername } from './args.js';
import { sameLogin } from './identity.js';
import { applyAnswers, parseAnswersJson, runInteractiveCapture } from './capture.js';
import { generateHandoverBook, renderHandoverBook } from './pipeline.js';
import { verifyCitations } from './verify.js';
import { GitHubCollector, countCollected } from './collect/github.js';
import { GitDirectoryCollector, previewLocalRepoKeys, recordedLocalRepoKeys } from './collect/git.js';
import { computeRisk } from './risk/engine.js';
import { computeBusFactor } from './risk/busfactor.js';
import { matchTouchedModules, renderGateComment } from './risk/gate.js';
import { HandoverStore } from './store/sqlite.js';
import { requireIndex } from './store/index-check.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

function printRiskTable(risks: Array<{ rank: number; module: string; score: number; rationale: string }>): void {
  if (risks.length === 0) {
    printLine(process.stdout, '\nRisk Top 5: (no items)');
    return;
  }
  printLine(process.stdout, '\nRisk Top 5:');
  for (const risk of risks) {
    printLine(process.stdout, `  ${risk.rank}. ${risk.module.padEnd(40)} score ${risk.score.toFixed(3)}`);
    printLine(process.stdout, `     ${risk.rationale}`);
  }
}

/**
 * Every line this CLI prints goes through printLine() — see src/print.ts for why
 * that is a security property and not a style rule.
 */

function fail(error: unknown): void {
  printLine(process.stderr, `error: ${error instanceof Error ? error.message : String(error)}`);
  // Not process.exit(): that tears libuv handles down mid-flight, and on Windows
  // a failed GitHub collect then aborted the runtime *after* printing its message
  // (`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c`) —
  // a native crash stacked on an error, with an exit status nobody could rely on.
  // Setting the code and letting the loop drain exits the same way, cleanly.
  process.exitCode = 1;
}

/**
 * A `--no-x` flag makes commander default `x` to true, so the parsed value alone
 * cannot tell "the user chose this" from "nobody said anything" — and an
 * implicit true would silently outrank HANDOVER_NO_REDACT / HANDOVER_LLM.
 * Only a value the user actually typed may override the environment.
 */
function explicit<T>(command: Command, name: string, value: T | undefined): T | undefined {
  return command.getOptionValueSource(name) === 'cli' ? value : undefined;
}

/**
 * Two flags switch a safety default off — sending evidence to a provider, and
 * keeping secret formats in the book — and both are easy to miss in a flat option
 * list. They get their own help heading, so the cost is visible before the flag is
 * typed rather than in the report afterwards.
 */
const SAFETY_OVERRIDE_HEADING = '⚠  overrides a safety default';

/** Resolve the LLM opt-in from --use-llm / --no-llm; undefined leaves it to HANDOVER_LLM. */
function resolveNoLlm(command: Command, options: { llm?: boolean; useLlm?: boolean }): boolean | undefined {
  if (explicit(command, 'llm', options.llm) === false) {
    return true;
  }
  return options.useLlm === true ? false : undefined;
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
  .option('--redact', 'scrub known secret formats from the LLM digest and the rendered book (on by default)')
  .addOption(
    new Option(
      '--no-redact',
      'keep repository text verbatim, including any secret formats in it (or HANDOVER_NO_REDACT=1)',
    ).helpGroup(SAFETY_OVERRIDE_HEADING),
  )
  .option('--html', 'also write a print-ready single-file HTML twin of the book')
  .addOption(
    new Option(
      '--use-llm',
      'enable LLM synthesis for chapters 4-6 — collected evidence is sent to the configured provider (or HANDOVER_LLM=1)',
    ).helpGroup(SAFETY_OVERRIDE_HEADING),
  )
  .option('--no-llm', 'never call an LLM provider; chapters 4-6 use deterministic fallbacks and nothing leaves this machine (the default)')
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
    llm?: boolean;
    useLlm?: boolean;
  }, command: Command) => {
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
        redact: explicit(command, 'redact', options.redact),
        html: options.html,
        noLlm: resolveNoLlm(command, options),
        onProgress: (message) => printLine(process.stdout, message),
      });
      printRiskTable(result.risks);
      printLine(process.stdout, `\nBook:  ${result.bookPath}`);
      if (result.htmlPath) {
        printLine(process.stdout, `HTML:  ${result.htmlPath}`);
      }
      printLine(process.stdout, `Index: ${result.dbPath}`);
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
      // fail() only sets the exit code — without this return the run would go on
      // to create an empty index and mask the "run collect first" guard elsewhere.
      return;
    }
    try {
      const config = loadConfig({ dataDir: options.dataDir });
      await mkdir(config.dataDir, { recursive: true });
      const store = new HandoverStore(path.join(config.dataDir, `${username}.db`));
      let found = 0;
      try {
        if (options.repo.length > 0) {
          // Local repo keys — both the ones passed to this run and every local
          // clone already recorded in this index — so the GitHub collector's
          // orphan cleanup spares locally-collected history (a later -r-only
          // run must not wipe it).
          const preserveRepos = [
            ...new Set([
              ...(options.gitDir?.length ? await previewLocalRepoKeys(store, options.gitDir) : []),
              ...recordedLocalRepoKeys(store),
            ]),
          ];
          const collector = new GitHubCollector(config.githubToken, undefined, { baseUrl: config.githubApiUrl });
          const collected = await collector.collectInto(store, username, options.repo, {
            since: options.since,
            refresh: options.refresh,
            preserveRepos,
            onProgress: (message) => printLine(process.stdout, message),
          });
          printLine(
            process.stdout,
            `Collected: ${collected.indexedCommits} new commits (${collected.skippedCommits} cached), ${collected.pullRequests} PRs (${collected.skippedPullRequests} cached), ${collected.reviews} reviews, ${collected.issues} issues (${collected.skippedIssues} cached).`,
          );
          found += countCollected(collected);
        }
        if (options.gitDir?.length) {
          const local = await new GitDirectoryCollector().collectInto(store, username, options.gitDir, {
            since: options.since,
            refresh: options.refresh,
            identity: options.author,
            onProgress: (message) => printLine(process.stdout, message),
          });
          printLine(
            process.stdout,
            `Collected locally: ${local.indexedCommits} new commits (${local.skippedCommits} cached) from ${local.repos.join(', ')}.`,
          );
          found += local.indexedCommits + local.skippedCommits;
        }
        if (found === 0) {
          printLine(
            process.stderr,
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
          // The MCP path scrubs every risk it returns, and --json exists for CI —
          // where the output lands in logs. Excerpts quote commit messages
          // verbatim, so they get the same redaction here.
          const scrubbed = risks.map((risk) => ({
            ...risk,
            rationale: redactSecrets(risk.rationale),
            evidence: risk.evidence.map((ref) => (ref.excerpt ? { ...ref, excerpt: redactSecrets(ref.excerpt) } : ref)),
          }));
          printLine(process.stdout, JSON.stringify(scrubbed, null, 2));
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
            printLine(process.stdout, 'No captured answers yet.');
            return;
          }
          for (const answer of answers) {
            printLine(process.stdout, `Q: ${answer.question}\nA: ${answer.answer}`);
          }
          return;
        }
        if (options.answers) {
          const raw = await readFile(options.answers, 'utf8').catch(() => {
            throw new Error(`--answers file not found: ${options.answers} — pass the path to a JSON file of {"question","answer"} objects.`);
          });
          const stored = applyAnswers(store, parseAnswersJson(raw));
          printLine(process.stdout, `Captured ${stored} answer(s). Re-render the book with "handover render ${username}".`);
          return;
        }
        if (!process.stdin.isTTY) {
          throw new Error('stdin is not a terminal — use --answers <file.json> for non-interactive capture.');
        }
        const stored = await runInteractiveCapture(store, username);
        printLine(process.stdout, `Captured ${stored} answer(s). Re-render the book with "handover render ${username}".`);
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
        printLine(process.stdout, JSON.stringify(items, null, 2));
        return;
      }
      if (items.length === 0) {
        printLine(process.stdout, 'Bus factor: the index has no commit activity for any module.');
        return;
      }
      printLine(process.stdout, '\nBus factor map (most exposed first):');
      const windowDays = Math.round(options.window ?? 90);
      for (const item of items) {
        const flag = item.status === 'critical' ? 'ONE PERSON' : item.status === 'fragile' ? 'thin cover' : 'shared';
        const owners = item.owners.length > 0 ? `  owners ${item.owners.join(' ')}` : '';
        printLine(
          process.stdout,
          `  ${item.module.padEnd(44)} ${String(item.distinctAuthors).padStart(2)} author(s), top ${item.topAuthor} ${Math.round(item.topAuthorShare * 100)}%  [${flag}]${item.recent ? '' : `  quiet ${windowDays}d`}${owners}`,
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
  .requiredOption('--files <file>', 'path to a file of newline-separated changed paths, or - for stdin')
  .option('--data-dir <dir>', 'directory holding the SQLite index (default: handover-data, or HANDOVER_DATA_DIR)')
  .option('--repo <owner/name>', 'restrict matching to one repository (a multi-repo index can hold the same module name twice)')
  .option('--comment', 'print a markdown PR comment instead of a table')
  .option('--fail-on-match', 'exit 1 when a sole-owned module is touched')
  .action(async (username: string, options: { files: string; dataDir?: string; repo?: string; comment?: boolean; failOnMatch?: boolean }) => {
    try {
      const config = loadConfig({ dataDir: options.dataDir });
      await requireIndex(config.dataDir, username, `run "handover collect ${username} -r owner/name" first.`);
      if (options.files === '-' && process.stdin.isTTY) {
        throw new Error('--files - reads the changed paths from stdin — pipe them in, e.g. `git diff --name-only main | handover gate ' + username + ' --files -`.');
      }
      const raw = options.files === '-' ? readFileSync(0, 'utf8') : await readFile(options.files, 'utf8');
      const changed = raw.split('\n').map((line) => line.trim()).filter(Boolean);
      if (options.files === '-' && changed.length === 0) {
        // A gate that received nothing cannot answer the question, and the old
        // behaviour was to print "none in sole-owned modules" and exit 0 — failing
        // open, silently. This is not hypothetical: `npx handover gate --files -`
        // reaches this branch on Windows even when the caller piped a real list,
        // because npm does not forward stdin to the child.
        throw new Error(
          '--files - received no paths on stdin, so there is nothing to gate. Pass --files <path> to a file of newline-separated paths instead (npm/npx does not forward stdin to child processes on Windows), or run the installed binary directly.',
        );
      }
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
        printLine(process.stdout, renderGateComment(matches, username));
      } else if (matches.length === 0) {
        printLine(process.stdout, `Gate: ${changed.length} changed path(s), none in sole-owned modules.`);
      } else {
        printLine(process.stdout, `Gate: ${matches.length} sole-owned module(s) touched:`);
        for (const match of matches) {
          printLine(process.stdout, `  ${match.module}  score ${match.score.toFixed(3)}`);
          printLine(process.stdout, `  ${match.rationale}`);
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
  .option('--redact', 'scrub known secret formats from the LLM digest and the rendered book (on by default)')
  .addOption(
    new Option(
      '--no-redact',
      'keep repository text verbatim, including any secret formats in it (or HANDOVER_NO_REDACT=1)',
    ).helpGroup(SAFETY_OVERRIDE_HEADING),
  )
  .option('--html', 'also write a print-ready single-file HTML twin of the book')
  .addOption(
    new Option(
      '--use-llm',
      'enable LLM synthesis for chapters 4-6 — the index digest is sent to the configured provider (or HANDOVER_LLM=1)',
    ).helpGroup(SAFETY_OVERRIDE_HEADING),
  )
  .option('--no-llm', 'never call an LLM provider; chapters 4-6 use deterministic fallbacks (the default)')
  .action(async (username: string, options: { repo: string[]; provider?: string; model?: string; dataDir?: string; redact?: boolean; html?: boolean; llm?: boolean; useLlm?: boolean }, command: Command) => {
    try {
      const config = loadConfig({ dataDir: options.dataDir });
      await requireIndex(config.dataDir, username, `run "handover collect ${username} -r owner/name" first.`);
      const result = await renderHandoverBook({
        username,
        repos: options.repo,
        dataDir: options.dataDir,
        provider: options.provider as LlmProviderName | undefined,
        model: options.model,
        redact: explicit(command, 'redact', options.redact),
        html: options.html,
        noLlm: resolveNoLlm(command, options),
        onProgress: (message) => printLine(process.stdout, message),
      });
      printLine(process.stdout, `\nBook:  ${result.bookPath}`);
      if (result.htmlPath) {
        printLine(process.stdout, `HTML:  ${result.htmlPath}`);
      }
      printLine(process.stdout, `Index: ${result.dbPath}`);
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
        printLine(process.stdout, JSON.stringify(report, null, 2));
      } else {
        printLine(process.stdout, `Checked ${report.checked.length} citation(s) against ${report.repos.length} repo(s) in scope.`);
        if (report.missingCount > 0) {
          printLine(process.stderr, `\nMissing refs (${report.missingCount}):`);
          for (const ref of report.checked.filter((item) => !item.ok)) {
            printLine(process.stderr, `  [${ref.raw}] — not found${ref.repo ? ` in ${ref.repo}` : ` in any of: ${report.repos.join(', ')}`}`);
          }
        } else {
          printLine(process.stdout, 'All cited evidence refs exist in the index.');
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
