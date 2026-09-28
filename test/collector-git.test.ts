import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GitDirectoryCollector, resolveNumstatPath } from '../src/collect/git.js';
import { HandoverStore } from '../src/store/sqlite.js';

const execFileAsync = promisify(execFile);

function gitIn(cwd: string, args: string[]): Promise<string> {
  return execFileAsync('git', ['-C', cwd, ...args]).then(({ stdout }) => stdout);
}

async function commitFile(
  dir: string,
  name: string,
  email: string,
  file: string,
  content: string,
  message: string,
): Promise<void> {
  const target = path.join(dir, file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
  await gitIn(dir, ['add', '--', file]);
  await gitIn(dir, ['-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit', '-q', '-m', message]);
}

const tempDirs: string[] = [];

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'handover-git-'));
  tempDirs.push(dir);
  await gitIn(dir, ['init', '-q', '-b', 'main']);
  return dir;
}

const ALICE = { name: 'Alice Zhang', email: 'alice@example.com' };
const BOB = { name: 'Bob', email: 'bob@corp.dev' };

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('resolveNumstatPath', () => {
  it('keeps plain paths', () => {
    expect(resolveNumstatPath('src/payments/charge.ts')).toBe('src/payments/charge.ts');
  });

  it('resolves brace renames to the destination', () => {
    expect(resolveNumstatPath('src/{old => new}/a.ts')).toBe('src/new/a.ts');
    expect(resolveNumstatPath('a/{b.ts => c.ts}')).toBe('a/c.ts');
  });

  it('resolves full-path renames and quoted paths', () => {
    expect(resolveNumstatPath('old.ts => new.ts')).toBe('new.ts');
    expect(resolveNumstatPath('"spaced file.ts"')).toBe('spaced file.ts');
  });
});

describe('GitDirectoryCollector', () => {
  it('indexes commits, classifies the subject and the team', async () => {
    const dir = await makeRepo();
    await commitFile(dir, ALICE.name, ALICE.email, 'payments/charge.ts', 'export const a = 1;\n', 'settle idempotently');
    await commitFile(dir, ALICE.name, ALICE.email, 'payments/charge.ts', 'export const a = 1;\nexport const b = 2;\n', 'add refund guard');
    await commitFile(dir, BOB.name, BOB.email, 'docs/runbook.md', '# runbook\n', 'document deploy');

    const store = HandoverStore.inMemory();
    const collector = new GitDirectoryCollector();
    const result = await collector.collectInto(store, 'alice', [dir]);

    expect(result.indexedCommits).toBe(3);
    expect(result.repos).toHaveLength(1);
    const commits = store.allCommits();
    expect(commits).toHaveLength(3);
    // subject commits get the canonical login; teammates keep their email
    expect(commits.filter((commit) => commit.authorLogin === 'alice')).toHaveLength(2);
    expect(commits.find((commit) => commit.message === 'document deploy')?.authorLogin).toBe('bob@corp.dev');
    expect(store.getMeta('source')).toBe('local-git');
    expect(store.getMeta('collected_for')).toBe('alice');
    expect(store.getMeta('repos')).toBe(path.basename(dir));
    // additions parsed from numstat
    expect(commits[1]?.additions).toBe(1);
    expect(commits[1]?.files[0]?.path).toBe('payments/charge.ts');
  });

  it('skips already-indexed commits on the second run', async () => {
    const dir = await makeRepo();
    await commitFile(dir, ALICE.name, ALICE.email, 'core/a.ts', 'x\n', 'first');

    const store = HandoverStore.inMemory();
    const collector = new GitDirectoryCollector();
    await collector.collectInto(store, 'alice', [dir]);
    const second = await collector.collectInto(store, 'alice', [dir]);
    expect(second.indexedCommits).toBe(0);
    expect(second.skippedCommits).toBe(1);
    const refreshed = await collector.collectInto(store, 'alice', [dir], { refresh: true });
    expect(refreshed.indexedCommits).toBe(1);
  });

  it('honors --since and matches a custom identity', async () => {
    const dir = await makeRepo();
    await commitFile(dir, 'Zhang', 'zhang@corp.dev', 'core/a.ts', 'x\n', 'hers');

    const store = HandoverStore.inMemory();
    const collector = new GitDirectoryCollector();
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const none = await collector.collectInto(store, 'alice', [dir], { since: future });
    expect(none.indexedCommits).toBe(0);

    const byName = await collector.collectInto(store, 'alice', [dir], { identity: 'zhang@corp.dev', refresh: true });
    expect(byName.indexedCommits).toBe(1);
    expect(store.allCommits()[0]?.authorLogin).toBe('alice');
  });

  it('resolves renames to the destination path', async () => {
    const dir = await makeRepo();
    await commitFile(dir, ALICE.name, ALICE.email, 'payments/old.ts', 'x\n', 'start');
    await gitIn(dir, ['mv', 'payments/old.ts', 'payments/new.ts']);
    await gitIn(dir, ['-c', `user.name=${ALICE.name}`, '-c', `user.email=${ALICE.email}`, 'commit', '-q', '-m', 'rename']);

    const store = HandoverStore.inMemory();
    await new GitDirectoryCollector().collectInto(store, 'alice', [dir]);
    const rename = store.allCommits().find((commit) => commit.message === 'rename');
    expect(rename?.files.map((file) => file.path)).toEqual(['payments/new.ts']);
  });

  it('fails with an actionable error for a non-repository directory', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'handover-nogit-'));
    tempDirs.push(dir);
    await expect(new GitDirectoryCollector().collectInto(HandoverStore.inMemory(), 'alice', [dir]))
      .rejects.toThrow(/Not a git repository/);
  });

  it('treats a freshly initialized repo with no commits as empty', async () => {
    const dir = await makeRepo();
    const store = HandoverStore.inMemory();
    const result = await new GitDirectoryCollector().collectInto(store, 'alice', [dir]);
    expect(result.indexedCommits).toBe(0);
    expect(result.skippedCommits).toBe(0);
  });
});
