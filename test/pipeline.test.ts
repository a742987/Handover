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

afterEach(async () => {
  vi.unstubAllEnvs();
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
});
