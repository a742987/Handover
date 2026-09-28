import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { requireIndex } from '../src/store/index-check.js';

/** Temp dirs created by tests in this file; removed again in afterEach. */
const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'handover-idx-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('requireIndex', () => {
  it('returns the db path when the index exists', async () => {
    const dir = await makeTempDir();
    await writeFile(path.join(dir, 'alice.db'), '');
    const dbPath = await requireIndex(dir, 'alice', 'run collect first.');
    expect(dbPath).toBe(path.join(dir, 'alice.db'));
  });

  it('fails with the full path and the given hint when it is missing', async () => {
    const dir = await makeTempDir();
    await expect(requireIndex(dir, 'nobody', 'run collect first.')).rejects.toThrow(
      /No index found at .*nobody\.db — run collect first\./,
    );
  });
});
