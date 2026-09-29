import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { HandoverStore } from '../src/store/sqlite.js';
import type { CommitRecord } from '../src/types.js';

/**
 * End-to-end tests for the MCP server — the surface with the most claims
 * attached to it and, until this file existed, no coverage at all:
 *
 *   - risk and search results are secret-scrubbed on the way out *always*, not
 *     only when redaction is asked for, because a tool result is read by a model
 *     and may be echoed onward (the --redact flag does not cover this path);
 *   - `dataDir` is confined, since it is a model-supplied argument that the
 *     pipeline mkdirs and writes into;
 *   - the server starts and exposes the seven documented tools, and every one of
 *     them is named in the model-facing docs an agent actually reads;
 *   - handover_verify distinguishes a citation the index supports from one that
 *     was invented, and cannot be pointed at an arbitrary file.
 *
 * The server is spawned over stdio (through tsx, because CI runs the tests
 * before a build) and driven with raw JSON-RPC lines.
 */
const require = createRequire(import.meta.url);
const tsxCli = require.resolve('tsx/cli');
const mcpTs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'mcp.ts');

const SECRET_IN_COMMIT = 'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const SECRET_IN_BODY = 'api_key: SUPERLEAKEDVALUE12345';

let child: ChildProcessWithoutNullStreams | null = null;
let dataDir = '';
let buffer = '';
const pending = new Map<number, (value: unknown) => void>();
let nextId = 1;

function send(message: Record<string, unknown>): void {
  child!.stdin.write(JSON.stringify(message) + '\n');
}

function request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve as (value: unknown) => void);
    send({ jsonrpc: '2.0', id, method, params });
  });
}

beforeAll(async () => {
  // the server confines dataDir to its own working directory, so the test runs
  // it from the temp dir it is meant to write inside
  dataDir = await mkdtemp(path.join(tmpdir(), 'handover-mcp-'));
  await mkdir(path.join(dataDir, 'handover-data'), { recursive: true });

  const store = new HandoverStore(path.join(dataDir, 'handover-data', 'alice.db'));
  // four commits in one module so the risk engine produces an item, with the
  // secret sitting in a commit message that becomes an evidence excerpt
  for (let i = 0; i < 4; i += 1) {
    const commit: CommitRecord = {
      sha: String(i + 1).padStart(40, '0'),
      repo: 'acme/api',
      authorLogin: 'alice',
      authoredAt: `2026-09-0${i + 1}T00:00:00Z`,
      message: `rotate ${SECRET_IN_COMMIT} in deploy\n\nalso ${SECRET_IN_BODY}`,
      additions: 3,
      deletions: 1,
      files: [{ path: 'payments/charge.ts', additions: 3, deletions: 1 }],
    };
    store.upsertCommit(commit);
  }
  store.setMeta('repos', 'acme/api');
  store.setMeta('collected_for', 'alice');
  store.setMeta('collected_via', 'local-git');
  store.close();

  child = spawn(process.execPath, [tsxCli, mcpTs], {
    cwd: dataDir,
    env: { ...process.env, HANDOVER_NO_LLM: '1' },
    windowsHide: true,
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) {
        try {
          const message = JSON.parse(line) as { id?: number };
          if (typeof message.id === 'number') {
            pending.get(message.id)?.(message);
            pending.delete(message.id);
          }
        } catch {
          // non-JSON noise from a loader or warning line
        }
      }
      index = buffer.indexOf('\n');
    }
  });

  await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'handover-test', version: '1' },
  });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
}, 30_000);

afterAll(async () => {
  // The child holds dataDir as its cwd, so deleting before it exits is EBUSY on
  // Windows: close stdin (the server's stdio transport ends), wait for the exit,
  // and still retry, because the OS releases the handle a moment later.
  const running = child;
  child = null;
  if (running) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        running.kill();
        resolve();
      }, 3_000);
      running.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      running.stdin.end();
    });
  }
  let lastError: unknown;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(dataDir, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError;
});

/** Unwrap an MCP tool result into the text payload the client would read. */
function toolText(result: Record<string, unknown>): string {
  const content = (result as { result?: { content?: Array<{ text?: string }> } }).result?.content ?? [];
  return content.map((part) => part.text ?? '').join('\n');
}

describe('handover MCP server', () => {
  it('starts and exposes the seven documented tools', async () => {
    const listed = await request('tools/list', {});
    const tools = (listed as { result?: { tools?: Array<{ name: string }> } }).result?.tools ?? [];
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [
        'handover_capture',
        'handover_collect',
        'handover_generate',
        'handover_render',
        'handover_risk',
        'handover_search',
        'handover_verify',
      ].sort(),
    );
  }, 30_000);

  it('reports the tool count and names it documents — a model reads that list, not the source', async () => {
    // codex/handover.md and the plugin skill each enumerate the tools an agent
    // may call; a tool that exists but is not written down is invisible to every
    // agent session, which is how handover_verify came to be missing from both.
    const listed = await request('tools/list', {});
    const names = (((listed as { result?: { tools?: Array<{ name: string }> } }).result?.tools ?? []).map((tool) => tool.name));
    for (const doc of ['../codex/handover.md', '../plugin/skills/handover/SKILL.md']) {
      const text = readFileSync(fileURLToPath(new URL(doc, import.meta.url)), 'utf8');
      const undocumented = names.filter((name) => !text.includes(name));
      expect(undocumented, `${doc} does not mention ${undocumented.join(', ')}`).toEqual([]);
    }
  }, 30_000);

  it('says so when there is no book to verify yet', async () => {
    const result = await request('tools/call', { name: 'handover_verify', arguments: { username: 'alice' } });
    const text = toolText(result);
    expect(text).toContain('error: no book at');
    // the path it names is inside the confined data directory — there is no
    // argument through which a model could point this tool at some other file
    expect(text).toContain(path.join('handover-data', 'handover-book-alice.md'));
  }, 30_000);

  it('verifies a book, naming the citations the index cannot support', async () => {
    // the book's real citation shape is a bracketed ref — `[`sha`]`, `[#7]` — which
    // is what the renderer emits and what the extractor reads; bare backticks are
    // prose, and a fixture written in prose would silently verify nothing
    const book = [
      '# Handover Book — @alice',
      '',
      '- settled retries in [`0000000`]',
      '- removed [`deadbee`] from the queue',
      '- tracked as [#7]',
    ].join('\n');
    await writeFile(path.join(dataDir, 'handover-data', 'handover-book-alice.md'), book, 'utf8');

    const result = await request('tools/call', { name: 'handover_verify', arguments: { username: 'alice' } });
    const text = toolText(result);
    const payload = JSON.parse(text.slice(text.indexOf('{'))) as {
      citations: number;
      missingCount: number;
      missing: Array<{ ref: string }>;
    };
    const refs = payload.missing.map((item) => item.ref);
    expect(payload.citations).toBe(3);
    // `0000000` is a prefix of the four indexed shas; `deadbee` and #7 were never
    // collected. The tool's whole value is naming those two instead of waving them
    // through — and the passing ref has to be absent, or "missing" proves nothing.
    expect(payload.missingCount).toBe(2);
    expect(refs).toContain('deadbee');
    expect(refs).toContain('#7');
    expect(refs).not.toContain('0000000');
  }, 30_000);

  it('refuses to invent an index when the person has none', async () => {
    const result = await request('tools/call', { name: 'handover_verify', arguments: { username: 'nobody' } });
    expect(toolText(result)).toContain('error:');
  }, 30_000);

  it('scrubs secret formats out of risk evidence — the path --redact does not cover', async () => {
    const result = await request('tools/call', {
      name: 'handover_risk',
      arguments: { username: 'alice' },
    });
    const text = toolText(result);
    expect(text, 'a GitHub PAT survived an MCP tool result').not.toContain(SECRET_IN_COMMIT);
    expect(text, 'a key=value secret survived an MCP tool result').not.toContain('SUPERLEAKEDVALUE12345');
    // and it really did have content to scrub, otherwise both assertions above
    // would pass on an empty answer
    expect(text).toContain('[REDACTED]');
    expect(text).toContain('payments');
  }, 30_000);

  it('scrubs the search excerpts too, which quote raw repository text', async () => {
    const result = await request('tools/call', {
      name: 'handover_search',
      arguments: { username: 'alice', query: 'rotate' },
    });
    const text = toolText(result);
    expect(text).not.toContain(SECRET_IN_COMMIT);
    expect(text).toContain('[REDACTED]');
    expect(text).toContain('rotate');
  }, 30_000);

  it('refuses a dataDir outside the server working directory', async () => {
    const result = await request('tools/call', {
      name: 'handover_risk',
      arguments: { username: 'alice', dataDir: '../../../../etc' },
    });
    const text = toolText(result);
    expect(text).toMatch(/outside the permitted roots/);
    expect((result as { result?: { isError?: boolean } }).result?.isError).toBe(true);
  }, 30_000);

  it('accepts a dataDir inside the working directory', async () => {
    const result = await request('tools/call', {
      name: 'handover_risk',
      arguments: { username: 'alice', dataDir: 'handover-data' },
    });
    expect((result as { result?: { isError?: boolean } }).result?.isError).not.toBe(true);
    expect(toolText(result)).toContain('payments');
  }, 30_000);

  it('refuses a gitDir outside the permitted roots — reading a clone is reading everything in it', async () => {
    // gitDirs makes the collector read a git repository from disk; without the
    // confinement one injected tool call could aim it at any clone on the machine
    const result = await request('tools/call', {
      name: 'handover_collect',
      arguments: { username: 'alice', repos: [], gitDirs: ['../../../../..'] },
    });
    const text = toolText(result);
    expect(text).toMatch(/outside the permitted roots/);
    expect((result as { result?: { isError?: boolean } }).result?.isError).toBe(true);
  }, 30_000);

  it('refuses to collect nothing without leaving an empty index behind', async () => {
    // no repos and no gitDirs must fail *before* the store opens, or the empty
    // index defeats requireIndex for every read tool that follows
    const result = await request('tools/call', {
      name: 'handover_collect',
      arguments: { username: 'ghost', repos: [] },
    });
    expect(toolText(result)).toMatch(/pass repos/);
    expect((result as { result?: { isError?: boolean } }).result?.isError).toBe(true);
  }, 30_000);
});
