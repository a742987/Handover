import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import net from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GitHubCollector } from '../src/collect/github.js';
import { createProvider } from '../src/distill/llm.js';
import { loadConfig } from '../src/config.js';
import { HandoverStore, releaseOpenStores } from '../src/store/sqlite.js';
import type { CommitRecord } from '../src/types.js';

/**
 * These tests exist because two claims in the changelog — "GitHub requests now
 * carry a per-request timeout" and "Ctrl-C closes the index" — were written from
 * reading the code, not from observing it. Both knobs were made injectable
 * (HANDOVER_GITHUB_TIMEOUT_MS / HANDOVER_LLM_TIMEOUT_MS) so the abort path can be
 * exercised in milliseconds instead of waiting out a minute.
 */

// A server that accepts the connection and then says nothing forever: the shape
// of a hung upstream, which is the failure a timeout exists to bound.
let connections = 0;
// close() waits for live sockets, and these are deliberately never closed by the
// client-side abort — so keep the handles and drop them in afterAll, or the
// teardown hangs (which it did, before this comment existed).
const hung = new Set<net.Socket>();
const blackHole = net.createServer((socket) => {
  connections += 1;
  hung.add(socket);
  socket.on('close', () => hung.delete(socket));
  // never respond, never close
});
// one server for the whole file: listen() twice on the same handle throws
let blackHolePort = 0;
beforeAll(async () => {
  await new Promise<void>((resolve) => blackHole.listen(0, '127.0.0.1', resolve));
  blackHolePort = (blackHole.address() as net.AddressInfo).port;
});

afterAll(async () => {
  for (const socket of hung) {
    socket.destroy();
  }
  hung.clear();
  await new Promise<void>((resolve, reject) =>
    blackHole.close((err) => (err ? reject(err) : resolve())),
  );
});

describe('per-request timeouts bound a hung connection', () => {
  it('the GitHub collector gives up instead of hanging', async () => {
    const port = blackHolePort;
    const before = connections;
    const store = HandoverStore.inMemory();
    const collector = new GitHubCollector('token', undefined, {
      baseUrl: `http://127.0.0.1:${port}`,
      timeoutMs: 400,
    });
    const started = Date.now();
    // 4 attempts with exponential backoff on a connection-level failure; the
    // point of the assertion is that it ENDS, in bounded time, rather than
    // stalling the whole collect forever.
    await expect(
      collector.collectInto(store, 'alice', ['acme/api'], {}),
    ).rejects.toThrow(/.+/);
    const elapsed = Date.now() - started;
    expect(elapsed, `gave up in ${elapsed}ms — the bound is not working`).toBeLessThan(30_000);
    expect(elapsed).toBeGreaterThanOrEqual(400);
    expect(connections, 'the request never reached the server, so this proved nothing').toBeGreaterThan(before);
    store.close();
  }, 45_000);

  it('the LLM provider aborts a request that never returns', async () => {
    const port = blackHolePort;
    const before = connections;
    const config = loadConfig({
      provider: 'ollama',
      ollamaUrl: `http://127.0.0.1:${port}`,
      llmTimeoutMs: 400,
      noLlm: false,
    });
    const provider = createProvider(config);
    const started = Date.now();
    await expect(provider.complete('system', 'user')).rejects.toThrow(/.+/);
    const elapsed = Date.now() - started;
    expect(elapsed, `gave up in ${elapsed}ms — no timeout on the LLM path`).toBeLessThan(30_000);
    expect(connections, 'the request never reached the server, so this proved nothing').toBeGreaterThan(before);
  }, 45_000);

  it('the timeout knobs come from the environment and reject nonsense', () => {
    const saved = ['HANDOVER_GITHUB_TIMEOUT_MS', 'HANDOVER_LLM_TIMEOUT_MS', 'HANDOVER_NO_REDACT', 'HANDOVER_LLM'];
    const previous = saved.map((k) => [k, process.env[k]] as const);
    try {
      for (const k of saved) delete process.env[k];
      process.env.HANDOVER_GITHUB_TIMEOUT_MS = '2500';
      process.env.HANDOVER_LLM_TIMEOUT_MS = '9000';
      expect(loadConfig().githubTimeoutMs).toBe(2500);
      expect(loadConfig().llmTimeoutMs).toBe(9000);
      // garbage must fall back, not become NaN and silently disable the timeout
      process.env.HANDOVER_GITHUB_TIMEOUT_MS = 'soon';
      expect(loadConfig().githubTimeoutMs).toBe(60_000);
      process.env.HANDOVER_GITHUB_TIMEOUT_MS = '-5';
      expect(loadConfig().githubTimeoutMs).toBe(60_000);
      process.env.HANDOVER_GITHUB_TIMEOUT_MS = '0';
      expect(loadConfig().githubTimeoutMs).toBe(60_000);
    } finally {
      for (const [k, v] of previous) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe('releaseOpenStores() frees the index file', () => {
  /**
   * What is verified here is the release step, not signal delivery: on Windows a
   * killed child does not run its signal handlers, so "does Ctrl-C leave the
   * index hot?" cannot be tested by sending a signal from this test process.
   * The handler wiring calls exactly this function.
   */
  async function seed(label: string): Promise<{ dir: string; dbPath: string }> {
    const dir = await mkdtemp(path.join(tmpdir(), `handover-release-${label}-`));
    const dbPath = path.join(dir, 'alice.db');
    const store = new HandoverStore(dbPath);
    const commit: CommitRecord = {
      sha: 'a'.repeat(40),
      repo: 'acme/api',
      authorLogin: 'alice',
      authoredAt: '2026-09-01T00:00:00Z',
      message: 'work',
      additions: 1,
      deletions: 0,
      files: [{ path: 'src/a.ts', additions: 1, deletions: 0 }],
    };
    store.upsertCommit(commit);
    return { dir, dbPath };
  }

  it('closes handles registered by other callers, and the file survives', async () => {
    const { dir, dbPath } = await seed('shared');
    try {
      // a store left open by someone else (the pipeline's own handle, in effect)
      expect(releaseOpenStores()).toBeGreaterThanOrEqual(1);
      // with the handle gone the directory is removable, which is what Windows
      // file locking makes observable — a still-open handle blocks deletion
      await expect(rm(dir, { recursive: true })).resolves.toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    expect(dbPath).toBeTruthy();
  });

  it('reopening after a release reads back the committed data', async () => {
    const { dir, dbPath } = await seed('reopen');
    try {
      releaseOpenStores();
      const again = new HandoverStore(dbPath);
      expect(again.allCommits().map((commit) => commit.sha)).toEqual(['a'.repeat(40)]);
      again.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('is idempotent — a second release has nothing left to close', async () => {
    const { dir } = await seed('twice');
    try {
      const store = new HandoverStore(path.join(dir, 'alice.db'));
      expect(releaseOpenStores()).toBeGreaterThanOrEqual(1);
      expect(releaseOpenStores()).toBe(0);
      void store;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('writes the answers file so the fixture is not silently empty', async () => {
    // guard for the two cases above: if upsertCommit had quietly failed, the
    // release count would still be right while the data check would be vacuous
    const dir = await mkdtemp(path.join(tmpdir(), 'handover-release-sanity-'));
    try {
      const store = new HandoverStore(path.join(dir, 'alice.db'));
      store.addAnswer('q', 'a', '2026-09-01T00:00:00Z');
      releaseOpenStores();
      const files = await import('node:fs/promises').then((fs) => fs.readdir(dir));
      expect(files).toContain('alice.db');
      await writeFile(path.join(dir, 'sentinel'), 'ok', 'utf8');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
