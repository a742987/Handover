import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The tarball gate has to be shown to fail, not just to pass. Both of its shell
 * predecessors reported success while reading nothing: `tar tzf … | grep …` fell
 * through to `echo clean` when tar could not open the file, and a glob matching
 * two archives made tar treat the second one as a member name. Each case builds
 * its own artifact, so the assertion is about the gate rather than a fixture that
 * happens to look right.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(repoRoot, 'scripts', 'check-package.mjs');
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function work(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'handover-package-'));
  tempDirs.push(dir);
  return dir;
}

/** A tarball whose top level is `package/`, the way npm packs. */
async function pack(dir: string, files: Record<string, string>, manifest: string): Promise<string> {
  const root = path.join(dir, 'stage', 'package');
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents, 'utf8');
  }
  await writeFile(path.join(root, 'package.json'), manifest, 'utf8');
  const archive = path.join(dir, 'out.tgz');
  // The archive name must be relative with cwd at `dir`: GNU tar reads a
  // leading `C:` as a remote host ("Cannot connect to C: resolve failed") and
  // bsdtar has no --force-local — a relative name works on both.
  execFileSync('tar', ['-czf', 'out.tgz', '-C', path.join(dir, 'stage'), 'package'], { cwd: dir, windowsHide: true });
  return archive;
}

function run(archive: string): { code: number; out: string } {
  const result = spawnSync(process.execPath, [script, archive], { encoding: 'utf8', windowsHide: true });
  return { code: result.status ?? 1, out: `${result.stdout}${result.stderr}` };
}

const manifest = JSON.stringify(
  {
    name: 'handover-book',
    version: '9.9.9',
    main: 'dist/index.js',
    types: 'dist/index.d.ts',
    bin: { handover: 'dist/cli.js', 'handover-mcp': 'dist/mcp.js' },
    exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } },
  },
  null,
  2,
);

const COMPLETE: Record<string, string> = {
  'dist/index.js': 'export {};\n',
  'dist/index.d.ts': 'export {};\n',
  'dist/cli.js': '#!/usr/bin/env node\n',
  'dist/mcp.js': '#!/usr/bin/env node\n',
  'README.md': '# handover\n',
  LICENSE: 'MIT\n',
};

describe('check-package gate', () => {
  it('accepts an artifact with every promised entry and no local data', async () => {
    const dir = await work();
    const { code, out } = run(await pack(dir, COMPLETE, manifest));
    expect(out).toContain('ok —');
    expect(code).toBe(0);
  });

  it('refuses an artifact missing a bin entry', async () => {
    const dir = await work();
    const files = { ...COMPLETE };
    delete files['dist/cli.js'];
    const { code, out } = run(await pack(dir, files, manifest));
    expect(code).toBe(1);
    expect(out).toMatch(/promised entry is missing from the tarball: dist\/cli\.js/);
  });

  it('refuses an artifact carrying source, tests, dotfiles or an index', async () => {
    const dir = await work();
    const archive = await pack(
      dir,
      {
        ...COMPLETE,
        'src/index.ts': 'export {};\n',
        'test/x.test.ts': '',
        '.env': 'GITHUB_TOKEN=x\n',
        'alice.db': 'sqlite\n',
        'handover-data/book.md': '',
      },
      manifest,
    );
    const { code, out } = run(archive);
    expect(code).toBe(1);
    for (const forbidden of ['src/index.ts', '.env', 'alice.db', 'handover-data/book.md']) {
      expect(out, forbidden).toContain(`forbidden content in the tarball: ${forbidden}`);
    }
  });

  it('refuses a .git directory sneaking into the artifact', async () => {
    const dir = await work();
    const archive = await pack(dir, { ...COMPLETE, '.git/config': '[core]\n\tpager = cat\n' }, manifest);
    const { code, out } = run(archive);
    expect(code).toBe(1);
    expect(out).toMatch(/forbidden content in the tarball: \.git\/config/);
  });

  it('refuses a files entry whose glob matched nothing', async () => {
    // a renamed screenshot or a moved examples/ tree silently drops out of the
    // tarball — npm does not warn, so the gate has to catch it
    const dir = await work();
    const filesManifest = JSON.stringify({ ...JSON.parse(manifest), files: ['dist', 'docs/report-screenshot.png'] }, null, 2);
    const { code, out } = run(await pack(dir, COMPLETE, filesManifest));
    expect(code).toBe(1);
    expect(out).toMatch(/files entry matched nothing in the tarball: docs\/report-screenshot\.png/);
  });

  it('accepts a files entry that is present in the artifact', async () => {
    const dir = await work();
    const filesManifest = JSON.stringify({ ...JSON.parse(manifest), files: ['dist'] }, null, 2);
    const { code, out } = run(await pack(dir, COMPLETE, filesManifest));
    expect(out).toContain('ok —');
    expect(code).toBe(0);
  });

  it('refuses rather than blesses an artifact it cannot read', async () => {
    const dir = await work();
    // the exact blind spot the shell version had: tar fails, grep matches
    // nothing, and `|| echo clean` turned that into a pass
    const { code, out } = run(path.join(dir, 'does-not-exist.tgz'));
    expect(code).toBe(1);
    expect(out).toMatch(/does not exist/);
  });

  it('refuses an artifact with nothing in it', async () => {
    const dir = await work();
    await mkdir(path.join(dir, 'stage'), { recursive: true });
    const archive = path.join(dir, 'empty.tgz');
    // relative archive name with cwd at `dir` — see the note in pack()
    execFileSync('tar', ['-czf', 'empty.tgz', '-C', path.join(dir, 'stage'), '.'], { cwd: dir, windowsHide: true });
    const { code, out } = run(archive);
    expect(code).toBe(1);
    expect(out).toMatch(/no entries|missing from the tarball/);
  });

  it('demands the tarball argument instead of assuming one', () => {
    const result = spawnSync(process.execPath, [script], { encoding: 'utf8', windowsHide: true });
    expect(result.status).toBe(2);
    expect(`${result.stdout}${result.stderr}`).toMatch(/pass the tarball/);
  });
});
