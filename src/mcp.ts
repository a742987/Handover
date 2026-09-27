#!/usr/bin/env node
/**
 * MCP server for Handover.
 *
 * Exposes the CLI's four commands as tools so any MCP client (Claude Code,
 * Codex, Cursor, ZCode, …) can drive the pipeline without shelling out.
 * stdio transport; launch with `handover-mcp`.
 */
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig, type LlmProviderName } from './config.js';
import { generateHandoverBook, renderHandoverBook } from './pipeline.js';
import { GitHubCollector } from './collect/github.js';
import { computeRisk } from './risk/engine.js';
import { HandoverStore } from './store/sqlite.js';
import { requireIndex } from './store/index-check.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

const providerSchema = z
  .enum(['openai', 'anthropic', 'ollama'])
  .optional()
  .describe('LLM provider for chapters 4-6; omit to use HANDOVER_PROVIDER or the anthropic default');

const dataDirSchema = z
  .string()
  .optional()
  .describe('directory for the SQLite index and the generated book (default: handover-data, or HANDOVER_DATA_DIR)');

const reposSchema = z
  .array(z.string())
  .describe('owner/name repositories to read, e.g. ["acme/api", "acme/web"]');

function textResult(payload: unknown, progress: string[]): {
  content: Array<{ type: 'text'; text: string }>;
} {
  return {
    content: [
      { type: 'text', text: progress.join('\n') },
      { type: 'text', text: JSON.stringify(payload, null, 2) },
    ],
  };
}

function errorResult(error: unknown): {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
} {
  return {
    content: [{ type: 'text', text: `error: ${error instanceof Error ? error.message : String(error)}` }],
    isError: true,
  };
}

const server = new McpServer({
  name: 'handover',
  version: pkg.version,
});

server.registerTool(
  'handover_generate',
  {
    title: 'Generate Handover Book',
    description:
      'Full pipeline: collect a departing engineer’s GitHub history (commits, PRs, reviews, issues) into a local ' +
      'SQLite index, compute the Risk Top 5, and render the bound, evidence-linked Handover Book. ' +
      'Second runs for the same person are incremental and near-instant. Requires GITHUB_TOKEN in the environment.',
    inputSchema: {
      username: z.string().describe('GitHub username of the departing engineer'),
      repos: reposSchema,
      since: z.string().optional().describe('only collect activity created after this ISO date, e.g. 2024-01-01'),
      provider: providerSchema,
      model: z.string().optional().describe('LLM model override'),
      dataDir: dataDirSchema,
      refresh: z.boolean().optional().describe('re-fetch commit details even for already-indexed commits (default false)'),
    },
  },
  async ({ username, repos, since, provider, model, dataDir, refresh }) => {
    const progress: string[] = [];
    try {
      const result = await generateHandoverBook({
        username,
        repos,
        since,
        provider: provider as LlmProviderName | undefined,
        model,
        dataDir,
        refresh,
        onProgress: (message) => progress.push(message),
      });
      return textResult(
        {
          bookPath: result.bookPath,
          dbPath: result.dbPath,
          chapters: result.book.chapters.map((chapter) => ({
            id: chapter.id,
            title: chapter.title,
            generatedBy: chapter.generatedBy,
          })),
          risks: result.risks,
        },
        progress,
      );
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  'handover_collect',
  {
    title: 'Collect GitHub History',
    description:
      'Index a departing engineer’s GitHub history (commits, PRs, reviews, issues) into the local SQLite index ' +
      'without rendering the book. Already-indexed items are skipped. Use this to build or refresh an index ' +
      'before generating or while exploring. Requires GITHUB_TOKEN in the environment.',
    inputSchema: {
      username: z.string().describe('GitHub username of the departing engineer'),
      repos: reposSchema,
      since: z.string().optional().describe('only collect activity created after this ISO date, e.g. 2024-01-01'),
      dataDir: dataDirSchema,
      refresh: z.boolean().optional().describe('re-fetch commit details even for already-indexed commits (default false)'),
    },
  },
  async ({ username, repos, since, dataDir, refresh }) => {
    const progress: string[] = [];
    try {
      const config = loadConfig({ dataDir });
      await mkdir(config.dataDir, { recursive: true });
      const store = new HandoverStore(path.join(config.dataDir, `${username}.db`));
      try {
        const collector = new GitHubCollector(config.githubToken);
        const collected = await collector.collectInto(store, username, repos, {
          since,
          refresh,
          onProgress: (message) => progress.push(message),
        });
        return textResult({ username, repos, collected }, progress);
      } finally {
        store.close();
      }
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  'handover_risk',
  {
    title: 'Risk Top 5',
    description:
      'Compute the Risk Top 5 from an existing local index — the modules most likely to break when the engineer ' +
      'leaves, each with the exact commits, reviews, and issues that justify its score. No network access; ' +
      'run handover_generate or handover_collect first.',
    inputSchema: {
      username: z.string().describe('GitHub username the index was collected for'),
      dataDir: dataDirSchema,
    },
  },
  async ({ username, dataDir }) => {
    const progress: string[] = [];
    try {
      const config = loadConfig({ dataDir });
      await requireIndex(config.dataDir, username, 'run the handover_generate or handover_collect tool first.');
      const store = new HandoverStore(path.join(config.dataDir, `${username}.db`));
      try {
        return textResult({ username, risks: computeRisk(store, username) }, progress);
      } finally {
        store.close();
      }
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  'handover_render',
  {
    title: 'Render Handover Book',
    description:
      'Re-render the Handover Book from an existing local index without touching the network. Chapters 4-6 use ' +
      'the configured LLM provider, or deterministic fallbacks when no API key is available.',
    inputSchema: {
      username: z.string().describe('GitHub username the index was collected for'),
      repos: z.array(z.string()).optional().describe('owner/name repositories (defaults to the ones recorded in the index)'),
      provider: providerSchema,
      model: z.string().optional().describe('LLM model override'),
      dataDir: dataDirSchema,
    },
  },
  async ({ username, repos, provider, model, dataDir }) => {
    const progress: string[] = [];
    try {
      const config = loadConfig({ dataDir });
      await requireIndex(config.dataDir, username, 'run the handover_generate or handover_collect tool first.');
      const result = await renderHandoverBook({
        username,
        repos,
        provider: provider as LlmProviderName | undefined,
        model,
        dataDir,
        onProgress: (message) => progress.push(message),
      });
      return textResult(
        {
          bookPath: result.bookPath,
          dbPath: result.dbPath,
          chapters: result.book.chapters.map((chapter) => ({
            id: chapter.id,
            title: chapter.title,
            generatedBy: chapter.generatedBy,
          })),
          risks: result.risks,
        },
        progress,
      );
    } catch (error) {
      return errorResult(error);
    }
  },
);

await server.connect(new StdioServerTransport());
