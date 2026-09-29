import { afterEach, describe, expect, it } from 'vitest';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

/**
 * CLI-level regression for the `--no-llm` flag: commander stores a negatable
 * flag under the positive name (`llm: false`), and the flag used to be read as
 * `options.noLlm` — always undefined — so repo content was sent to the LLM
 * provider even when the user passed --no-llm. This spawns the real CLI
 * (through tsx, since CI tests run before build) with a dummy API key present
 * and asserts the off-switch wins.
 */
const require = createRequire(import.meta.url);
const tsxCli = require.resolve('tsx/cli');
const cliTs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.ts');

function gitIn(cwd: string, args: string[]): Promise<string> {
  return execFileAsync('git', ['-C', cwd, ...args]).then(({ stdout }) => stdout);
}

function runCli(args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsxCli, cliTs, ...args], { cwd, env: { ...process.env, ...env }, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('handover gen --no-llm', () => {
  it('keeps synthesis deterministic even with a key configured — nothing leaves the machine', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'handover-cli-repo-'));
    const dataDir = await mkdtemp(path.join(tmpdir(), 'handover-cli-data-'));
    tempDirs.push(repo, dataDir);
    await gitIn(repo, ['init', '-q', '-b', 'main']);
    await mkdir(path.join(repo, 'payments'), { recursive: true });
    await writeFile(path.join(repo, 'payments/charge.ts'), 'export const a = 1;\n', 'utf8');
    await gitIn(repo, ['add', '--', 'payments/charge.ts']);
    await execFileAsync('git', ['-C', repo, 'commit', '-q', '-m', 'settle idempotently'], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Alice',
        GIT_AUTHOR_EMAIL: 'alice@example.com',
        GIT_COMMITTER_NAME: 'Alice',
        GIT_COMMITTER_EMAIL: 'alice@example.com',
      },
    });

    const { code, stdout, stderr } = await runCli(
      ['gen', 'alice', '--git-dir', repo, '--data-dir', dataDir, '--no-llm'],
      { ANTHROPIC_API_KEY: 'sk-ant-dummy-present-but-unused' },
      tmpdir(),
    );

    expect(stderr).not.toContain('error:');
    expect(code).toBe(0);
    expect(stdout).toContain('LLM synthesis disabled');
    expect(stdout).not.toContain('synthesizing');
    expect(stdout).toContain('Book:');
  }, 60_000);
});
