#!/usr/bin/env node
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Command } from 'commander';
import { loadConfig, type LlmProviderName } from './config.js';
import { generateHandoverBook, renderHandoverBook } from './pipeline.js';
import { GitHubCollector } from './collect/github.js';
import { computeRisk } from './risk/engine.js';
import { HandoverStore } from './store/sqlite.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

function parseRepos(value: string, previous: string[]): string[] {
  const repos = previous ?? [];
  for (const part of value.split(',')) {
    const repo = part.trim();
    if (repo) {
      repos.push(repo);
    }
  }
  return repos;
}

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
  .argument('<username>', 'GitHub username of the departing engineer')
  .requiredOption('-r, --repo <repo...>', 'owner/name repositories to read (repeat the flag or comma-separate)', parseRepos)
  .option('--provider <provider>', 'LLM provider: openai | anthropic | ollama')
  .option('--model <model>', 'LLM model override')
  .option('--since <date>', 'only collect activity created after this ISO date')
  .option('--data-dir <dir>', 'directory for the SQLite index and the generated book', 'handover-data')
  .option('--refresh', 're-fetch commit details even for already-indexed commits', false)
  .action(async (username: string, options: {
    repo: string[];
    provider?: string;
    model?: string;
    since?: string;
    dataDir: string;
    refresh?: boolean;
  }) => {
    try {
      const result = await generateHandoverBook({
        username,
        repos: options.repo,
        dataDir: options.dataDir,
        provider: options.provider as LlmProviderName | undefined,
        model: options.model,
        since: options.since,
        refresh: options.refresh,
        onProgress: (message) => console.log(message),
      });
      printRiskTable(result.risks);
      console.log(`\nBook:  ${result.bookPath}`);
      console.log(`Index: ${result.dbPath}`);
    } catch (error) {
      fail(error);
    }
  });

program
  .command('collect')
  .description('collect GitHub history into the local index without rendering the book')
  .argument('<username>', 'GitHub username of the departing engineer')
  .requiredOption('-r, --repo <repo...>', 'owner/name repositories to read', parseRepos)
  .option('--since <date>', 'only collect activity created after this ISO date')
  .option('--data-dir <dir>', 'directory for the SQLite index', 'handover-data')
  .option('--refresh', 're-fetch commit details even for already-indexed commits', false)
  .action(async (username: string, options: { repo: string[]; since?: string; dataDir: string; refresh?: boolean }) => {
    try {
      const config = loadConfig({ dataDir: options.dataDir });
      await mkdir(config.dataDir, { recursive: true });
      const store = new HandoverStore(path.join(config.dataDir, `${username}.db`));
      try {
        const collector = new GitHubCollector(config.githubToken);
        const collected = await collector.collectInto(store, username, options.repo, {
          since: options.since,
          refresh: options.refresh,
          onProgress: (message) => console.log(message),
        });
        console.log(
          `Collected: ${collected.indexedCommits} new commits (${collected.skippedCommits} cached), ${collected.pullRequests} PRs, ${collected.reviews} reviews, ${collected.issues} issues.`,
        );
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
  .argument('<username>', 'GitHub username')
  .option('--data-dir <dir>', 'directory holding the SQLite index', 'handover-data')
  .action(async (username: string, options: { dataDir: string }) => {
    try {
      const config = loadConfig({ dataDir: options.dataDir });
      const store = new HandoverStore(path.join(config.dataDir, `${username}.db`));
      try {
        printRiskTable(computeRisk(store, username));
      } finally {
        store.close();
      }
    } catch (error) {
      fail(error);
    }
  });

program
  .command('render')
  .description('re-render the Handover Book from an existing index (no network)')
  .argument('<username>', 'GitHub username')
  .requiredOption('-r, --repo <repo...>', 'owner/name repositories that were collected', parseRepos)
  .option('--provider <provider>', 'LLM provider: openai | anthropic | ollama')
  .option('--model <model>', 'LLM model override')
  .option('--data-dir <dir>', 'directory holding the SQLite index', 'handover-data')
  .action(async (username: string, options: { repo: string[]; provider?: string; model?: string; dataDir: string }) => {
    try {
      const result = await renderHandoverBook({
        username,
        repos: options.repo,
        dataDir: options.dataDir,
        provider: options.provider as LlmProviderName | undefined,
        model: options.model,
        onProgress: (message) => console.log(message),
      });
      console.log(`\nBook:  ${result.bookPath}`);
      console.log(`Index: ${result.dbPath}`);
    } catch (error) {
      fail(error);
    }
  });

program.parseAsync(process.argv).catch(fail);
