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
  at?: string,
): Promise<void> {
  const target = path.join(dir, file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
  await gitIn(dir, ['add', '--', file]);
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email };
  if (at) {
    // deterministic timestamps: same-second commits tie-break nondeterministically
    env.GIT_AUTHOR_DATE = at;
    env.GIT_COMMITTER_DATE = at;
  }
  await execFileAsync('git', ['-C', dir, 'commit', '-q', '-m', message], { env });
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
    await commitFile(dir, ALICE.name, ALICE.email, 'payments/charge.ts', 'export const a = 1;\n', 'settle idempotently', '2026-09-01T00:00:00Z');
    await commitFile(dir, ALICE.name, ALICE.email, 'payments/charge.ts', 'export const a = 1;\nexport const b = 2;\n', 'add refund guard', '2026-09-02T00:00:00Z');
    await commitFile(dir, BOB.name, BOB.email, 'docs/runbook.md', '# runbook\n', 'document deploy', '2026-09-03T00:00:00Z');

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
    // additions parsed from numstat — found by message, not position:
    // allCommits() sorts by authored_at, and a positional index breaks
    // whenever any timestamp deviates (the flake this once produced)
    const refund = commits.find((entry) => entry.message === 'add refund guard');
    expect(refund?.additions).toBe(1);
    expect(refund?.files[0]?.path).toBe('payments/charge.ts');
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

  it('stores non-ASCII paths decoded, not octal-escaped', async () => {
    const dir = await makeRepo();
    await commitFile(dir, ALICE.name, ALICE.email, '支付/charge.ts', 'export const a = 1;\n', 'unicode module');
    const store = HandoverStore.inMemory();
    await new GitDirectoryCollector().collectInto(store, 'alice', [dir]);
    const commit = store.allCommits().find((entry) => entry.message === 'unicode module');
    expect(commit?.files[0]?.path).toBe('支付/charge.ts');
  });

  it('keeps commits whose message contains ASCII control bytes', async () => {
    const dir = await makeRepo();
    await commitFile(dir, ALICE.name, ALICE.email, 'src/a.ts', 'x\n', 'first\x1esplit\x1fpart', '2026-09-01T00:00:00Z');
    await commitFile(dir, ALICE.name, ALICE.email, 'src/b.ts', 'y\n', 'second', '2026-09-02T00:00:00Z');
    const store = HandoverStore.inMemory();
    const result = await new GitDirectoryCollector().collectInto(store, 'alice', [dir]);
    expect(result.indexedCommits).toBe(2);
    const first = store.allCommits().find((entry) => entry.message.startsWith('first'));
    expect(first?.message).toBe('first split part');
    // the record reassembly must not corrupt the numstat that follows
    expect(first?.files.map((file) => file.path)).toEqual(['src/a.ts']);
    expect(store.allCommits().some((entry) => entry.message === 'second')).toBe(true);
  });

  it('keys same-basename clones apart instead of merging their history', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'handover-collide-'));
    tempDirs.push(base);
    const one = path.join(base, 'one', 'api');
    const two = path.join(base, 'two', 'api');
    await mkdir(one, { recursive: true });
    await mkdir(two, { recursive: true });
    await gitIn(one, ['init', '-q', '-b', 'main']);
    await gitIn(two, ['init', '-q', '-b', 'main']);
    await commitFile(one, ALICE.name, ALICE.email, 'src/one.ts', 'x\n', 'from one');
    await commitFile(two, BOB.name, BOB.email, 'src/two.ts', 'x\n', 'from two');

    const store = HandoverStore.inMemory();
    const result = await new GitDirectoryCollector().collectInto(store, 'alice', [one, two]);
    expect(new Set(result.repos).size).toBe(2);
    const byRepo = new Map(store.allCommits().map((entry) => [entry.repo, entry.message]));
    expect(byRepo.size).toBe(2);
    expect([...byRepo.values()]).toContain('from one');
    expect([...byRepo.values()]).toContain('from two');

    // the disambiguated key is stable, so incremental skips keep working
    const second = await new GitDirectoryCollector().collectInto(store, 'alice', [one, two]);
    expect(second.indexedCommits).toBe(0);
    expect(second.skippedCommits).toBe(2);
  });

  it('warns when the cached index was collected with a different identity', async () => {
    const dir = await makeRepo();
    await commitFile(dir, 'Zhang', 'zhang@corp.dev', 'src/a.ts', 'x\n', 'hers');
    const store = HandoverStore.inMemory();
    const messages: string[] = [];
    const progress = (message: string): void => {
      messages.push(message);
    };
    await new GitDirectoryCollector().collectInto(store, 'alice', [dir], { identity: 'zhang@corp.dev', onProgress: progress });
    messages.length = 0;
    await new GitDirectoryCollector().collectInto(store, 'alice', [dir], { onProgress: progress });
    expect(messages.some((message) => message.includes('collected with author identity'))).toBe(true);
  });
});
