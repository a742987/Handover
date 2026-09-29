import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The artifact smoke run is itself a gate, so it needs the same treatment the
 * other two guard scripts get: a check that it refuses to pretend. The expensive
 * path (npm install of the tarball, then every command) is exercised by CI, and a
 * smoke run that silently skipped its work would look exactly like a passing one —
 * which is the failure mode this file exists to catch.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts', 'smoke.mjs');

function smoke(args: string[]) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 300_000,
    windowsHide: true,
  });
  return { status: result.status ?? -1, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

describe('scripts/smoke.mjs', () => {
  it('refuses to run without an archive to test', () => {
    const { status, output } = smoke([]);
    expect(status).toBe(2);
    expect(output).toContain('usage: node scripts/smoke.mjs');
  });

  it('reports a missing archive as a failure, with the path it resolved', () => {
    const { status, output } = smoke(['--package', 'nowhere/handover-book-0.0.0.tgz']);
    expect(status).not.toBe(0);
    expect(output).toMatch(/no such|given package archive exists/);
    const reported = output.match(/archive exists — (\S+)/)?.[1] ?? output.match(/archive: (\S+)/)?.[1] ?? '';
    // relative paths are how a CI job ends up testing nothing: the run resolves
    // against the temporary working directory, not the repository
    expect(path.isAbsolute(reported), `reported path was not absolute: ${reported}`).toBe(true);
    expect(output).toMatch(/smoke run that reads nothing|FAILED/);
  });

  it('is wired into CI, so the gate cannot be orphaned by a rename', () => {
    const workflow = readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
    expect(workflow).toContain('node scripts/smoke.mjs --pack');
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.smoke).toContain('scripts/smoke.mjs');
  });

  it('counts its checks and refuses a run that performed too few', () => {
    const source = readFileSync(script, 'utf8');
    expect(source).toMatch(/a smoke run that reads nothing is not a pass/);
    // aborts must land in the report rather than escaping it
    expect(source).toMatch(/smoke aborted:/);
  });

  it('drives shell snippets on stdin, never as -c arguments', () => {
    // Under WSL2 with a Windows node binary, spawning a Linux bash with `-c "<script>"`
    // hands the script through a shell that expands it first: "$VAR" arrives already
    // empty, every case "refuses", and the two must-refuse cases pass by accident.
    // Passing the same script on stdin is the form that actually tests what shipped.
    const source = readFileSync(script, 'utf8');
    expect(source).not.toMatch(/spawnSync\(\s*'bash'\s*,\s*\[\s*'-c'/);
    expect(source).toMatch(/spawnSync\(\s*'bash'\s*,\s*\[\s*'-s'/);
    // and a spawn that never started is not a refusal: /usr/bin/env is simply absent
    // under a Windows node, which made every case report a refusal the same way
    expect(source).toMatch(/guard\.error === undefined/);
    // a refusal must say why, or an unrelated `command not found` would satisfy it
    expect(source).toMatch(/names the fix/);
    // the extraction must be bounded by its own step, checked rather than assumed
    expect(source).toMatch(/stays inside its own step/);
  });
});
