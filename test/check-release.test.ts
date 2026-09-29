import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Tests for the publish guard itself.
 *
 * `scripts/check-release.mjs` is the last thing standing between a mistake and
 * an irreversible public npm release, so "it refuses" is only half the contract:
 * a guard that refuses *everything* is just as broken, and that is exactly what
 * happened when it was first written — it compared HEAD to `git rev-parse
 * refs/tags/vX`, which for an annotated tag answers with the tag object's id, so
 * no annotated release ever matched. Every case below is here because it catches
 * one of the two directions of failure.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const guard = path.join(repoRoot, 'scripts', 'check-release.mjs');
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'handover-release-guard-'));
  tempDirs.push(dir);
  await mkdir(path.join(dir, 'scripts'), { recursive: true });
  writeFileSync(path.join(dir, 'scripts', 'check-release.mjs'), readFileSync(guard, 'utf8'));
  // the real guard runs inside a repo whose .gitignore keeps handover-data/ out
  // of commits; mirror that, otherwise this fixture tests a repo shape that
  // cannot exist
  writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\nhandover-data/\n*.db\n');
  git(dir, ['init', '-q', '-b', 'main']);
  return dir;
}

function git(dir: string, args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Releaser',
      GIT_AUTHOR_EMAIL: 'r@example.test',
      GIT_COMMITTER_NAME: 'Releaser',
      GIT_COMMITTER_EMAIL: 'r@example.test',
    },
  });
}

function setVersion(dir: string, version: string): void {
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'handover-book', version }, null, 2) + '\n');
}

function commit(dir: string, message: string): void {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', message]);
}

function runGuard(dir: string): { code: number; out: string } {
  const result = spawnSync(process.execPath, [path.join(dir, 'scripts', 'check-release.mjs')], {
    cwd: dir,
    encoding: 'utf8',
    windowsHide: true,
  });
  return { code: result.status ?? 1, out: `${result.stdout}${result.stderr}` };
}

describe('check-release guard', () => {
  it('allows a clean tree whose HEAD carries an annotated tag matching the version', async () => {
    const dir = await makeRepo();
    setVersion(dir, '1.0.0');
    commit(dir, 'release 1.0.0');
    git(dir, ['tag', '-a', 'v1.0.0', '-m', 'Release v1.0.0']);
    const { code, out } = runGuard(dir);
    // a guard that refuses everything is as broken as one that refuses nothing,
    // so the pass path is asserted by its confirmation line, not just its exit code
    expect(code).toBe(0);
    expect(out).toMatch(/matches tag v1\.0\.0 at [0-9a-f]{7} on main\./);
  });

  it('refuses when no tag matches the version', async () => {
    const dir = await makeRepo();
    setVersion(dir, '1.0.0');
    commit(dir, 'release 1.0.0');
    const { code, out } = runGuard(dir);
    expect(code).toBe(1);
    expect(out).toMatch(/no tag v1\.0\.0/);
  });

  it('refuses a moved tag — the version is on a different commit than HEAD', async () => {
    const dir = await makeRepo();
    setVersion(dir, '1.0.0');
    commit(dir, 'release 1.0.0');
    git(dir, ['tag', '-a', 'v1.0.0', '-m', 'Release v1.0.0']);
    setVersion(dir, '1.0.1');
    commit(dir, 'release 1.0.1');
    git(dir, ['tag', '-a', 'v1.0.1', 'HEAD~1', '-m', 'misplaced']);
    const { code, out } = runGuard(dir);
    expect(code).toBe(1);
    expect(out).toMatch(/points at .* but HEAD is/);
  });

  it('refuses a lightweight release tag', async () => {
    const dir = await makeRepo();
    setVersion(dir, '1.0.0');
    commit(dir, 'release 1.0.0');
    git(dir, ['tag', 'v1.0.0']); // no -a: what 0.1.1 shipped with
    const { code, out } = runGuard(dir);
    expect(code).toBe(1);
    expect(out).toMatch(/lightweight/);
  });

  it('refuses staged and untracked changes alike', async () => {
    for (const stage of ['staged', 'untracked']) {
      const dir = await makeRepo();
      setVersion(dir, '1.0.0');
      commit(dir, 'release 1.0.0');
      git(dir, ['tag', '-a', 'v1.0.0', '-m', 'Release v1.0.0']);
      await writeFile(path.join(dir, 'loose.txt'), 'work in progress\n', 'utf8');
      if (stage === 'staged') {
        git(dir, ['add', '--', 'loose.txt']);
      }
      const { code, out } = runGuard(dir);
      expect(code, stage).toBe(1);
      expect(out, stage).toMatch(/uncommitted changes/);
    }
  });

  it('ignores changes confined to the local data directory', async () => {
    const dir = await makeRepo();
    setVersion(dir, '1.0.0');
    commit(dir, 'release 1.0.0');
    git(dir, ['tag', '-a', 'v1.0.0', '-m', 'Release v1.0.0']);
    await mkdir(path.join(dir, 'handover-data'), { recursive: true });
    await writeFile(path.join(dir, 'handover-data', 'alice.db'), 'index\n', 'utf8');
    // the guard treats the untracked-but-ignored-shaped data dir as noise, which
    // is only true while .gitignore keeps it out — so assert both together
    const ignored = spawnSync('git', ['-C', dir, 'check-ignore', 'handover-data/alice.db'], { encoding: 'utf8' });
    expect(ignored.status, 'handover-data must be git-ignored for this to be safe').toBe(0);
    expect(runGuard(dir).code).toBe(0);
  });
});
