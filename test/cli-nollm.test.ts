import { afterEach, describe, expect, it } from 'vitest';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

/**
 * CLI-level regressions for the switches that decide whether repository content
 * leaves the machine, and for the safety surface around them — the help text that
 * names them, the exit status a failure leaves behind, and a gate that must not
 * read "I got nothing" as "all clear". These spawn the real CLI (through tsx,
 * since CI runs the tests before a build) because both original defects lived in
 * the seam between commander's flag parsing and the pipeline:
 *
 *   - `--no-llm` was read from `options.noLlm`, which commander never sets for
 *     a negatable flag, so published 0.1.2 contacted the provider anyway;
 *   - synthesis then became default-on for anyone who exported an API key.
 *
 * A unit test over loadConfig() could not have caught either one.
 */
const require = createRequire(import.meta.url);
const tsxCli = require.resolve('tsx/cli');
const cliTs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.ts');

function gitIn(cwd: string, args: string[]): Promise<string> {
  return execFileAsync('git', ['-C', cwd, ...args]).then(({ stdout }) => stdout);
}

function runCli(
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  stdin?: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
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
    if (stdin !== undefined) {
      child.stdin?.end(stdin);
    }
  });
}

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A throwaway local clone — the fixture every case below collects from. */
async function makeRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), 'handover-cli-repo-'));
  tempDirs.push(repo);
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
  return repo;
}

async function runGen(repo: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'handover-cli-data-'));
  tempDirs.push(dataDir);
  const result = await runCli(['gen', 'alice', '--git-dir', repo, '--data-dir', dataDir, ...args], env, tmpdir());
  return { ...result, dataDir };
}

// Nothing here may reach a real provider. Ollama on a closed port fails fast and
// deterministically, and "did it try to call out" stays observable in the output.
const UNREACHABLE = { OLLAMA_URL: 'http://127.0.0.1:1' };

describe('handover gen LLM opt-in — end to end through the real CLI', () => {
  // This is the exact defect that shipped: 0.1.2 read commander's --no-* flag
  // from options.noLlm, which commander never sets, so the published package
  // contacted the provider despite the user asking it not to.
  it('--no-llm stays deterministic even with a credential present', async () => {
    const { code, stdout, stderr } = await runGen(await makeRepo(), ['--no-llm'], {
      ANTHROPIC_API_KEY: 'sk-ant-dummy-present-but-unused',
    });
    expect(stderr).not.toContain('error:');
    expect(code).toBe(0);
    expect(stdout).toContain('LLM synthesis disabled');
    expect(stdout).not.toContain('synthesizing');
    expect(stdout).toContain('Book:');
  }, 60_000);

  it('does not contact a provider unless asked (the default)', async () => {
    const { code, stdout } = await runGen(await makeRepo(), ['--provider', 'ollama'], UNREACHABLE);
    expect(code).toBe(0);
    expect(stdout).toContain('LLM synthesis disabled');
    expect(stdout).not.toContain('synthesizing');
  }, 60_000);

  it('--use-llm is the opt-in: synthesis is attempted, and the run says so', async () => {
    const { code, stdout } = await runGen(await makeRepo(), ['--provider', 'ollama', '--use-llm'], UNREACHABLE);
    // the provider is unreachable on purpose; chapters fall back, exit stays 0
    expect(code).toBe(0);
    expect(stdout).toContain('LLM synthesis enabled');
    expect(stdout).toMatch(/synthesizing "Decision Archaeology" with ollama/);
    expect(stdout).toContain('deterministic fallback');
  }, 60_000);

  // HANDOVER_LLM=1 takes the same path through loadConfig as --use-llm does
  // through commander, and the environment half is covered in config.test.ts.
  // Re-running the whole unreachable-provider pipeline here cost ~19s per case
  // for no additional coverage.

  it('redacts by default, and --no-redact is the only opt-out', async () => {
    const repo = await makeRepo();
    const redacted = await runGen(repo, []);
    const book = await readFile(path.join(redacted.dataDir, 'handover-book-alice.md'), 'utf8');
    expect(book).toContain('**Redaction:**');

    const plain = await runGen(repo, ['--no-redact']);
    const plainBook = await readFile(path.join(plain.dataDir, 'handover-book-alice.md'), 'utf8');
    expect(plainBook).not.toContain('**Redaction:**');
  }, 120_000);

  it('exits with status 1 and no runtime abort when a command fails', async () => {
    // fail() used to call process.exit(1). On Windows, a collect that died with
    // sockets still in flight then tore libuv handles down mid-close and printed
    // `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` after its own error
    // message — a native crash stacked on an error. The live command that
    // reproduced it needs an https API host, which the URL allow-list correctly
    // refuses for a local fake, so what is pinned here is the contract the crash
    // broke: status 1, one error line, no runtime abort.
    const { code, stderr } = await runCli(['gen', 'alice', '--data-dir', './nowhere'], {}, tmpdir());
    expect(code).toBe(1);
    expect(stderr).toContain('error: Nothing to collect — pass at least one');
    expect(stderr).not.toMatch(/Assertion failed|UV_HANDLE_CLOSING|abort\(\)/i);
  }, 60_000);

  it('shows both safety overrides in their own --help section, and keeps the defaults visible', async () => {
    // The default is the safe one, so the only way an override gets typed is if
    // someone looks for it. Grouping them under one heading is a claim about the
    // help surface, and a commander upgrade can undo it silently.
    for (const command of ['gen', 'render']) {
      const { code, stdout } = await runCli([command, '--help'], {}, tmpdir());
      expect(code, `${command} --help exited non-zero`).toBe(0);
      const heading = stdout.indexOf('⚠  overrides a safety default');
      expect(heading, `${command} --help lost the safety-override heading`).toBeGreaterThan(-1);
      const overrides = stdout.slice(heading);
      expect(overrides).toContain('--use-llm');
      expect(overrides).toContain('--no-redact');
      // the safe side of each pair stays in the main list, where the rest of the
      // flags are — hiding it would make the override look like the norm
      const main = stdout.slice(0, heading);
      expect(main).toContain('--no-llm');
      expect(main).toContain('--redact ');
    }
  }, 60_000);
});

describe('handover gate must not fail open', () => {
  // `--files -` reads the change list from stdin, and npm/npx does not forward
  // stdin to child processes on Windows — the pipe arrives empty even though the
  // caller piped a real list. The command used to answer "0 changed path(s), none
  // in sole-owned modules" and exit 0: a review gate reporting an all-clear on
  // data it never received.
  it('refuses to treat an empty stdin as a pass, and still answers a real one', async () => {
    const repo = await makeRepo();
    const { dataDir } = await runGen(repo, ['--no-llm']);

    const empty = await runCli(['gate', 'alice', '--files', '-', '--data-dir', dataDir], {}, tmpdir(), '');
    expect(empty.code).not.toBe(0);
    expect(empty.stderr).toContain('nothing to gate');

    const filled = await runCli(
      ['gate', 'alice', '--files', '-', '--data-dir', dataDir],
      {},
      tmpdir(),
      'payments/charge.ts\n',
    );
    // positive control: the same command with real input is a normal verdict
    expect(filled.stderr).not.toContain('nothing to gate');
    expect(filled.stdout).toMatch(/sole-owned module\(s\) touched|none in sole-owned modules/);
    expect(filled.stdout).toContain('Gate:');
    expect(filled.stdout).toMatch(/payments/);
  }, 120_000);
});

/**
 * Round seventeen found that a repository key reaches the terminal without
 * passing any writer that sanitises it, and that on Linux/macOS a directory name
 * may contain ESC. Windows forbids that filename, so the *clone directory* half of
 * the vector cannot be built on this machine — but the other half can, because an
 * index database is a hand-around file: whoever receives one can put anything in
 * its columns, past every writer. So the poison goes straight into the SQLite
 * file, and what is asserted is what the CLI puts on the wire.
 */
describe('the printing layer is the last line of defence for a hostile index', () => {
  it('strips control bytes from a pre-poisoned index while keeping the text', async () => {
    const repo = await makeRepo();
    const { dataDir } = await runGen(repo, ['--no-llm']);
    const hostile = 'pay\u001b[2J\u001b[1;31mGATE-APPROVED\u001b[0m';

    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(dataDir, 'alice.db'));
    let changed = 0;
    try {
      // every table keyed by repository, not just the one that seemed enough:
      // risk joins commits to their files, so renaming one side yields an index
      // that prints "(no items)" and proves nothing.
      for (const table of [
        'commits',
        'commit_files',
        'pull_requests',
        'pr_files',
        'reviews',
        'review_comments',
        'issues',
        'issue_labels',
        'issue_comments',
      ]) {
        changed += Number(db.prepare(`UPDATE ${table} SET repo = ?`).run(hostile).changes);
      }
    } finally {
      db.close();
    }
    expect(changed, 'the poison never landed in the index').toBeGreaterThan(0);
    const changes = path.join(dataDir, 'changed.txt');
    await writeFile(changes, 'payments/charge.ts\n', 'utf8');

    for (const args of [
      ['risk', 'alice', '--data-dir', dataDir],
      ['gate', 'alice', '--files', changes, '--data-dir', dataDir],
    ]) {
      const { code, stdout, stderr } = await runCli(args, {}, tmpdir());
      expect(code, `${args[0]} exited: ${stderr}`).toBe(0);
      const wire = `${stdout}${stderr}`;
      // positive control: the poisoned key really is what got printed, so the
      // assertion below cannot pass on an output that never reached it
      expect(wire, `${args[0]} never printed the repository key at all`).toContain('GATE-APPROVED');
      expect(wire, `${args[0]} let a control byte through`).not.toMatch(/[\u001b\u0007\u0080-\u009f]/);
    }
  }, 120_000);
});
