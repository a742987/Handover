#!/usr/bin/env node
/**
 * MCP server for Handover.
 *
 * Exposes the pipeline as seven tools — generate, collect, risk, capture,
 * search, render, verify — so any MCP client (Claude Code, Codex, Cursor, ZCode, …)
 * can drive it without shelling out. stdio transport; launch with
 * `handover-mcp`.
 */
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { confineDataDir, confineGitDir, loadConfig, type LlmProviderName } from './config.js';
import { printLine } from './print.js';
import { sanitizeProse } from './store/sanitize.js';
import { sameLogin } from './identity.js';
import { parseSince } from './args.js';
import { applyAnswers } from './capture.js';
import { generateHandoverBook, renderHandoverBook } from './pipeline.js';
import { GitHubCollector } from './collect/github.js';
import { GitDirectoryCollector, previewLocalRepoKeys, recordedLocalRepoKeys } from './collect/git.js';
import { computeRisk } from './risk/engine.js';
import { redact as redactSecrets } from './render/redact.js';
import { searchIndex, type SearchResultItem } from './search.js';
import { verifyCitations } from './verify.js';
import { HandoverStore } from './store/sqlite.js';
import { requireIndex } from './store/index-check.js';
import type { RiskItem } from './types.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

const providerSchema = z
  .enum(['openai', 'anthropic', 'ollama'])
  .optional()
  .describe('LLM provider for chapters 4-6; omit to use HANDOVER_PROVIDER or the anthropic default');

const dataDirDescription =
  'directory for the SQLite index and the generated book; must be inside the directory this server was launched from (or inside HANDOVER_DATA_ROOT). Defaults to handover-data.';

const dataDirSchema = z
  .string()
  .optional()
  .transform((value, ctx) => {
    if (value === undefined) {
      return undefined;
    }
    try {
      return confineDataDir(value);
    } catch (error) {
      ctx.addIssue({ code: 'custom', message: error instanceof Error ? error.message : String(error) });
      return z.NEVER;
    }
  })
  .describe(dataDirDescription);

// Same confinement discipline as dataDir: gitDirs makes the collector read a
// git repository from disk, so a model-supplied path must stay inside roots the
// operator chose — otherwise one injected instruction reads any clone on the
// machine into the transcript.
const gitDirsDescription =
  'local git clone directories to read (no network or token needed); each must be inside the directory this server was launched from, HANDOVER_DATA_ROOT, or an operator-configured HANDOVER_GIT_ROOT';

const gitDirsSchema = z
  .array(z.string())
  .optional()
  .transform((value, ctx) => {
    if (value === undefined) {
      return undefined;
    }
    const out: string[] = [];
    for (const dir of value) {
      try {
        out.push(confineGitDir(dir));
      } catch (error) {
        ctx.addIssue({ code: 'custom', message: error instanceof Error ? error.message : String(error) });
        return z.NEVER;
      }
    }
    return out;
  })
  .describe(gitDirsDescription);

// owner/name is the shape every downstream URL builder and store key assumes;
// rejecting anything else here surfaces a readable error instead of a raw
// GitHub API 404 for a mangled repo string.
const reposSchema = z
  .array(
    z
      .string()
      .regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/, 'expects owner/name, e.g. acme/api'),
  )
  .max(100)
  .describe('owner/name repositories to read, e.g. ["acme/api", "acme/web"]');

// render's repos list accepts the index's own keys, which include local clone
// basenames (no owner/name shape), so it is length-bounded rather than
// shape-checked — but it is still a model-supplied list and cannot be unbounded.
const renderReposSchema = z
  .array(z.string().max(512))
  .max(100)
  .optional()
  .describe('owner/name repositories (defaults to the ones recorded in the index)');

// Same validation (and UTC normalization) as the CLI's --since flag — the shape
// check alone let impossible dates like 2024-13-45 through to the GitHub API.
const sinceSchema = z
  .string()
  .transform((value, ctx) => {
    try {
      return parseSince(value);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'expects an ISO date, e.g. 2024-01-01 or 2024-01-01T10:00:00Z' });
      return z.NEVER;
    }
  })
  .optional()
  .describe('only collect activity created after this ISO date, e.g. 2024-01-01');

const usernameSchema = z
  .string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/, 'GitHub username must match [A-Za-z0-9-]')
  .max(39)
  .describe('GitHub username of the departing engineer (case-insensitive; lowercased server-side)');

/** GitHub logins are case-insensitive — one canonical form for files and comparisons. */
function canon(username: string): string {
  return username.toLowerCase();
}

/**
 * LLM synthesis is opt-in: absent both arguments the default (off) from the
 * environment/config applies. An explicit noLlm=true always wins.
 */
function resolveNoLlm(noLlm: boolean | undefined, useLlm: boolean | undefined): boolean | undefined {
  if (noLlm === true) {
    return true;
  }
  return useLlm === true ? false : undefined;
}

function textResult(payload: unknown, progress: string[]): {
  content: Array<{ type: 'text'; text: string }>;
} {
  return {
    content: [
      { type: 'text', text: sanitizeProse(progress.join('\n')) },
      { type: 'text', text: sanitizeProse(JSON.stringify(payload, null, 2)) },
    ],
  };
}

function errorResult(error: unknown): {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
} {
  return {
    content: [
      {
        type: 'text',
        text: sanitizeProse(`error: ${error instanceof Error ? error.message : String(error)}`),
      },
    ],
    isError: true,
  };
}

/**
 * Tool results go to an LLM client — a second egress path the redact flag does
 * not cover — so evidence excerpts and rationales are always secret-scrubbed.
 */
function scrubRisks(risks: RiskItem[]): RiskItem[] {
  return risks.map((risk) => ({
    ...risk,
    rationale: redactSecrets(risk.rationale),
    evidence: risk.evidence.map((ref) => (ref.excerpt ? { ...ref, excerpt: redactSecrets(ref.excerpt) } : ref)),
  }));
}

/** Same always-on scrubbing for search results: excerpts quote raw repo text. */
function scrubSearch(payload: { count: number; results: SearchResultItem[] }): { count: number; results: SearchResultItem[] } {
  return {
    ...payload,
    results: payload.results.map((item) => ({ ...item, excerpt: redactSecrets(item.excerpt) })),
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
      'Full pipeline: collect a departing engineer’s history (commits, PRs, reviews, issues — from GitHub ' +
      'repos and/or local git clones) into a local SQLite index, compute the Risk Top 5, and render the bound, ' +
      'evidence-linked Handover Book. Second runs for the same person are incremental and near-instant. ' +
      'Public GitHub repos need no token (60 requests/hour); set GITHUB_TOKEN for private repos or a large ' +
      'collection. gitDirs reads local clones and needs neither.',
    inputSchema: {
      username: usernameSchema,
      repos: reposSchema.describe('owner/name GitHub repositories to read (may be empty when gitDirs is set)'),
      gitDirs: gitDirsSchema,
      authorIdentity: z
        .string()
        .max(320)
        .optional()
        .describe('git author name/email substring identifying the engineer in local repos (default: username)'),
      since: sinceSchema,
      provider: providerSchema,
      model: z.string().optional().describe('LLM model override'),
      dataDir: dataDirSchema,
      refresh: z.boolean().optional().describe('re-fetch commit details even for already-indexed commits (default false)'),
      redact: z.boolean().optional().describe('scrub known secret formats from the digest and the book (default: on)'),
      html: z.boolean().optional().describe('also write a print-ready single-file HTML twin of the book'),
      noLlm: z
        .boolean()
        .optional()
        .describe('force deterministic chapters 4-6 — nothing leaves this machine (already the default)'),
      useLlm: z
        .boolean()
        .optional()
        .describe('opt IN to LLM synthesis of chapters 4-6: the collected evidence digest is sent to the configured provider'),
    },
  },
  async ({ username, repos, gitDirs, authorIdentity, since, provider, model, dataDir, refresh, redact: redactOn, html, noLlm, useLlm }) => {
    const progress: string[] = [];
    try {
      const result = await generateHandoverBook({
        username: canon(username),
        repos: [...new Set(repos)],
        gitDirs,
        authorIdentity,
        since,
        provider: provider as LlmProviderName | undefined,
        model,
        dataDir,
        refresh,
        redact: redactOn,
        html,
        noLlm: resolveNoLlm(noLlm, useLlm),
        onProgress: (message) => progress.push(message),
      });
      return textResult(
        {
          bookPath: result.bookPath,
          dbPath: result.dbPath,
          htmlPath: result.htmlPath,
          chapters: result.book.chapters.map((chapter) => ({
            id: chapter.id,
            title: chapter.title,
            generatedBy: chapter.generatedBy,
          })),
          risks: scrubRisks(result.risks),
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
    title: 'Collect History',
    description:
      'Index a departing engineer’s history (commits, PRs, reviews, issues) into the local SQLite index ' +
      'without rendering the book. Already-indexed items are skipped. Use this to build or refresh an index ' +
      'before generating or while exploring. Public GitHub repos work with no token, at 60 requests/hour; ' +
      'GITHUB_TOKEN is needed for private repos and to raise that limit. gitDirs reads local clones ' +
      'with no token.',
    inputSchema: {
      username: usernameSchema,
      repos: reposSchema.describe('owner/name GitHub repositories to read (may be empty when gitDirs is set)'),
      gitDirs: gitDirsSchema,
      authorIdentity: z
        .string()
        .max(320)
        .optional()
        .describe('git author name/email substring identifying the engineer in local repos (default: username)'),
      since: sinceSchema,
      dataDir: dataDirSchema,
      refresh: z.boolean().optional().describe('re-fetch commit details even for already-indexed commits (default false)'),
    },
  },
  async ({ username, repos, gitDirs, authorIdentity, since, dataDir, refresh }) => {
    const progress: string[] = [];
    try {
      // Validate before anything is created: failing after the store opens
      // would leave an empty index behind and defeat requireIndex for every
      // read tool that follows.
      if (repos.length === 0 && !gitDirs?.length) {
        throw new Error('pass repos (owner/name) and/or gitDirs (local clone paths)');
      }
      const user = canon(username);
      const config = loadConfig({ dataDir });
      await mkdir(config.dataDir, { recursive: true });
      const store = new HandoverStore(path.join(config.dataDir, `${user}.db`));
      try {
        // Local repo keys — this run's dirs plus every local clone already in
        // the index — so the GitHub collector's orphan cleanup spares
        // locally-collected history.
        const preserve: string[] = [
          ...new Set([
            ...(gitDirs?.length ? await previewLocalRepoKeys(store, gitDirs) : []),
            ...recordedLocalRepoKeys(store),
          ]),
        ];
        let collected = null;
        if (repos.length > 0) {
          const collector = new GitHubCollector(config.githubToken, undefined, { baseUrl: config.githubApiUrl });
          collected = await collector.collectInto(store, user, [...new Set(repos)], {
            since,
            refresh,
            preserveRepos: preserve,
            onProgress: (message) => progress.push(message),
          });
        }
        let local = null;
        if (gitDirs?.length) {
          local = await new GitDirectoryCollector().collectInto(store, user, gitDirs, {
            since,
            refresh,
            identity: authorIdentity,
            onProgress: (message) => progress.push(message),
          });
        }
        if (!collected && !local) {
          throw new Error('pass repos (owner/name) and/or gitDirs (local clone paths)');
        }
        return textResult({ username: user, repos, gitDirs: local?.repos ?? [], collected, local }, progress);
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
      username: usernameSchema,
      dataDir: dataDirSchema,
    },
  },
  async ({ username, dataDir }) => {
    const progress: string[] = [];
    try {
      const user = canon(username);
      const config = loadConfig({ dataDir });
      await requireIndex(config.dataDir, user, 'run the handover_generate or handover_collect tool first.');
      const store = new HandoverStore(path.join(config.dataDir, `${user}.db`));
      try {
        const collectedFor = store.getMeta('collected_for');
        const display = collectedFor && sameLogin(collectedFor, user) ? collectedFor : user;
        return textResult({ username: display, risks: scrubRisks(computeRisk(store, display)) }, progress);
      } finally {
        store.close();
      }
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  'handover_capture',
  {
    title: 'Capture First-Person Answers',
    description:
      'Append Q&A answers in the departing engineer’s own words to the local index; they render into ' +
      'chapter 6 of the book. Use clear=true to replace all previously captured answers. No network access. ' +
      'Ask the questions from handover_render output or the standard capture question set.',
    inputSchema: {
      username: usernameSchema,
      dataDir: dataDirSchema,
      answers: z
        .array(
          z.object({
            question: z.string().min(1).max(10_000),
            answer: z.string().min(1).max(10_000),
          }),
        )
        .max(100)
        .describe('question/answer pairs to capture'),
      clear: z.boolean().optional().describe('delete existing captured answers first (default false)'),
    },
  },
  async ({ username, dataDir, answers, clear }) => {
    const progress: string[] = [];
    try {
      const user = canon(username);
      const config = loadConfig({ dataDir });
      await requireIndex(config.dataDir, user, 'run the handover_generate or handover_collect tool first.');
      const store = new HandoverStore(path.join(config.dataDir, `${user}.db`));
      try {
        if (clear) {
          for (const existing of store.listAnswers()) {
            store.deleteAnswer(existing.id);
          }
          progress.push('Cleared previously captured answers.');
        }
        const stored = applyAnswers(store, answers);
        return textResult({ username: user, captured: stored, total: store.listAnswers().length }, progress);
      } finally {
        store.close();
      }
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  'handover_search',
  {
    title: 'Search the Evidence Index',
    description:
      'Read-only substring search over the local evidence index (commits, PRs, reviews, issues, comments) — ' +
      'the way to answer follow-up questions about the departing engineer’s history, e.g. "what did they say ' +
      'about the queue?" No network access; run handover_generate or handover_collect first.',
    inputSchema: {
      username: usernameSchema,
      dataDir: dataDirSchema,
      query: z.string().optional().describe('case-insensitive substring over messages, titles and bodies'),
      kind: z.enum(['all', 'commit', 'pr', 'review', 'issue', 'comment']).optional().describe('record type filter (default all)'),
      author: z.string().optional().describe('restrict to one author login; omit for everyone in the index'),
      since: sinceSchema,
      repo: z.string().optional().describe('restrict to one repository (owner/name or local dir name)'),
      limit: z.number().int().min(1).max(200).optional().describe('max results (default 20, newest first)'),
    },
  },
  async ({ username, dataDir, query, kind, author, since, repo, limit }) => {
    const progress: string[] = [];
    try {
      const user = canon(username);
      const config = loadConfig({ dataDir });
      await requireIndex(config.dataDir, user, 'run the handover_generate or handover_collect tool first.');
      const store = new HandoverStore(path.join(config.dataDir, `${user}.db`));
      try {
        return textResult(scrubSearch(searchIndex(store, { query, kind, author, since, repo, limit })), progress);
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
      'Re-render the Handover Book from an existing local index. No GitHub network access. Chapters 4-6 use the ' +
      'configured LLM provider when its API key is set in the environment; otherwise deterministic fallbacks are used.',
    inputSchema: {
      username: usernameSchema,
      repos: renderReposSchema,
      provider: providerSchema,
      model: z.string().optional().describe('LLM model override'),
      dataDir: dataDirSchema,
      redact: z.boolean().optional().describe('scrub known secret formats from the digest and the book (default: on)'),
      html: z.boolean().optional().describe('also write a print-ready single-file HTML twin of the book'),
      noLlm: z
        .boolean()
        .optional()
        .describe('force deterministic chapters 4-6 (already the default)'),
      useLlm: z
        .boolean()
        .optional()
        .describe('opt IN to LLM synthesis: the index digest is sent to the configured provider'),
    },
  },
  async ({ username, repos, provider, model, dataDir, redact: redactOn, html, noLlm, useLlm }) => {
    const progress: string[] = [];
    try {
      const config = loadConfig({ dataDir });
      await requireIndex(config.dataDir, canon(username), 'run the handover_generate or handover_collect tool first.');
      const result = await renderHandoverBook({
        username: canon(username),
        repos,
        provider: provider as LlmProviderName | undefined,
        model,
        dataDir,
        redact: redactOn,
        html,
        noLlm: resolveNoLlm(noLlm, useLlm),
        onProgress: (message) => progress.push(message),
      });
      return textResult(
        {
          bookPath: result.bookPath,
          dbPath: result.dbPath,
          htmlPath: result.htmlPath,
          chapters: result.book.chapters.map((chapter) => ({
            id: chapter.id,
            title: chapter.title,
            generatedBy: chapter.generatedBy,
          })),
          risks: scrubRisks(result.risks),
        },
        progress,
      );
    } catch (error) {
      return errorResult(error);
    }
  },
);

/**
 * The agent-facing citation check. Without it a model can present a book it never
 * verified — the one property this tool exists to guarantee — so it is exposed
 * here as well as on the CLI.
 *
 * Deliberately no `file` argument: the book's location is derived from the
 * (confined) data directory and the username. A model-supplied path would turn a
 * citation checker into a read-anything primitive, and anything it read could be
 * echoed back into the transcript.
 */
server.registerTool(
  'handover_verify',
  {
    title: 'Verify Book Citations',
    description:
      'Check that every evidence ref cited in a generated Handover Book (commit shas, PR/issue numbers, review ' +
      'ids) actually exists in the local index, and report the ones that do not. No network access. Run this ' +
      'after handover_generate or handover_render before presenting the book as verified.',
    inputSchema: {
      username: usernameSchema,
      dataDir: dataDirSchema,
    },
  },
  async ({ username, dataDir }) => {
    const progress: string[] = [];
    try {
      const user = canon(username);
      const config = loadConfig({ dataDir });
      await requireIndex(config.dataDir, user, 'run the handover_generate or handover_collect tool first.');
      const bookPath = path.join(config.dataDir, `handover-book-${user}.md`);
      const markdown = await readFile(bookPath, 'utf8').catch(() => {
        throw new Error(`no book at ${bookPath} — run handover_generate or handover_render first.`);
      });
      const store = new HandoverStore(path.join(config.dataDir, `${user}.db`));
      let report;
      try {
        report = verifyCitations(store, bookPath, markdown);
      } finally {
        store.close();
      }
      const missing = report.checked.filter((item) => !item.ok);
      progress.push(
        `Checked ${report.checked.length} citation(s) against ${report.repos.length} repo(s) in scope.`,
      );
      return textResult(
        {
          username: user,
          bookPath,
          repos: report.repos,
          citations: report.checked.length,
          missingCount: report.missingCount,
          // the model's job is to report or fix these, so they come back in full;
          // the passing list would only spend context
          missing: missing.map((item) => ({
            ref: item.raw,
            expectedIn: item.repo ?? report.repos.join(', '),
          })),
        },
        progress,
      );
    } catch (error) {
      return errorResult(error);
    }
  },
);

try {
  await server.connect(new StdioServerTransport());
} catch (error) {
  // a failed transport start should not surface as an unhandled rejection with
  // a raw stack — the client gets one clean line on stderr instead
  printLine(process.stderr, `error: failed to start the MCP server: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}