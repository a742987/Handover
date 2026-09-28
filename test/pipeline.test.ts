import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { renderHandoverBook } from '../src/pipeline.js';
import { HandoverStore } from '../src/store/sqlite.js';
import type { CommitRecord } from '../src/types.js';

const REPO = 'acme/api';
const USERNAME = 'alice';
const NOW = new Date('2026-09-10T00:00:00Z');

/** Temp dirs created by tests in this file; removed again in afterEach. */
const tempDirs: string[] = [];
const progress: string[] = [];

async function makeDataDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'handover-pipeline-'));
  tempDirs.push(dir);
  return dir;
}

function commit(sha: string, author: string, at: string): CommitRecord {
  return {
    sha,
    repo: REPO,
    authorLogin: author,
    authoredAt: at,
    message: `work ${sha}`,
    additions: 1,
    deletions: 0,
    files: [{ path: 'payments/charge.ts', additions: 1, deletions: 0 }],
  };
}

/** Seeds a persistent index at <dataDir>/<username>.db exactly where render looks for it. */
async function seedIndex(dataDir: string): Promise<void> {
  const store = new HandoverStore(path.join(dataDir, `${USERNAME}.db`));
  try {
    store.upsertCommit(commit('a'.padEnd(40, '0'), USERNAME, '2026-09-01T00:00:00Z'));
    store.setMeta('repos', REPO);
  } finally {
    store.close();
  }
}

async function seedIndexWithSecret(dataDir: string): Promise<void> {
  const store = new HandoverStore(path.join(dataDir, `${USERNAME}.db`));
  try {
    store.upsertCommit({
      ...commit('s'.padEnd(40, '0'), USERNAME, '2026-09-01T00:00:00Z'),
      message: 'rotate api_key: SUPERLEAKED123456 today',
    });
    store.setMeta('repos', REPO);
  } finally {
    store.close();
  }
}

afterEach(async () => {
  vi.unstubAllEnvs();
  progress.length = 0;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('renderHandoverBook', () => {
  it('fails with an actionable error when the index records no repositories', async () => {
    const dataDir = await makeDataDir();
    const store = new HandoverStore(path.join(dataDir, `${USERNAME}.db`));
    store.close();

    await expect(renderHandoverBook({ username: USERNAME, dataDir })).rejects.toThrow(/does not record any repositories/);
  });

  it('renders a deterministic book from a seeded index without network access', async () => {
    // Force the missing-credential path so the test never calls a real LLM,
    // even on a machine that happens to have API keys in its environment.
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const dataDir = await makeDataDir();
    await seedIndex(dataDir);

    const result = await renderHandoverBook({
      username: USERNAME,
      dataDir,
      provider: 'openai',
      onProgress: () => {},
    });

    expect(result.book.repos).toEqual([REPO]);
    expect(result.book.chapters).toHaveLength(6);
    expect(result.book.chapters.every((chapter) => chapter.generatedBy === 'deterministic')).toBe(true);
    // repos list came from the index meta, not from the caller
    const markdown = await readFile(result.bookPath, 'utf8');
    expect(markdown).toContain(`# Handover Book — @${USERNAME}`);
    expect(markdown).toContain('nothing was uploaded anywhere');
    expect(markdown).toContain('payments');
  });

  it('keeps chapters deterministic when noLlm is set, even with a credential present', async () => {
    // A key IS configured, but the explicit off-switch must win — this is what
    // lets a user on a locked-down machine say "nothing leaves this machine".
    vi.stubEnv('OPENAI_API_KEY', 'sk-test-present');
    const dataDir = await makeDataDir();
    await seedIndex(dataDir);

    const result = await renderHandoverBook({
      username: USERNAME,
      dataDir,
      provider: 'openai',
      noLlm: true,
      onProgress: (message) => progress.push(message),
    });

    expect(result.book.llmProvider).toBeUndefined();
    expect(result.book.chapters.every((chapter) => chapter.generatedBy === 'deterministic')).toBe(true);
    expect(progress.some((message) => message.includes('--no-llm'))).toBe(true);
    const markdown = await readFile(result.bookPath, 'utf8');
    expect(markdown).toContain('nothing was uploaded anywhere');
    expect(markdown).toContain('## Action summary — read this first');
  });

  it('scrubs secrets from the book and writes the HTML twin when asked', async () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const dataDir = await makeDataDir();
    await seedIndexWithSecret(dataDir);

    const result = await renderHandoverBook({ username: USERNAME, dataDir, redact: true, html: true, onProgress: () => {} });

    const markdown = await readFile(result.bookPath, 'utf8');
    expect(markdown).not.toContain('SUPERLEAKED123456');
    expect(markdown).toContain('[REDACTED]');
    expect(markdown).toContain('**Redaction:**');

    expect(result.htmlPath).toBeDefined();
    const html = await readFile(result.htmlPath!, 'utf8');
    expect(html).toContain('<!doctype html>');
    expect(html).not.toContain('SUPERLEAKED123456');
  });
});
