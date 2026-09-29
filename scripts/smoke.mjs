#!/usr/bin/env node
/**
 * Runs the *shipped artifact*, not the source tree.
 *
 * Everything else in this repository's testing can pass while the published
 * package is broken: the `--no-llm` defect (0.1.2) lived in the seam between
 * commander and the pipeline in a form that only showed up once the code was
 * packed, and four more defects in the audit's ㉕–㉖ rounds were found by nothing
 * more clever than executing commands nobody had ever executed. This script makes
 * that a gate: install the tarball into a throwaway directory, drive every CLI
 * command and the MCP server against a synthetic repository, and assert on exit
 * statuses, on the words in the output, and on the files that must appear on disk.
 *
 * Two rules it enforces on itself:
 *   - every check is counted, and the run fails if too few checks ran, so an
 *     early return cannot present itself as a pass (the lesson of the two CI
 *     gates that printed "clean" after reading nothing);
 *   - no command may emit a terminal control byte, whichever layer produced it —
 *     the sanitizer contract is asserted on the wire rather than assumed from
 *     the unit tests.
 *
 * Usage: node scripts/smoke.mjs --package <path/to/handover-book-x.y.z.tgz>
 *        node scripts/smoke.mjs --pack        (npm pack first, then the same)
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CONTROL_BYTES = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
// A run that performed far fewer checks than this suite owns is not a pass; the
// current count is 93, so this trips only when whole sections were skipped.
const MIN_CHECKS = 60;

const argv = process.argv.slice(2);
function flag(name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

const pkg = flag('--package');
const wantsPack = argv.includes('--pack');
if (!pkg && !wantsPack) {
  console.error('usage: node scripts/smoke.mjs --package <tarball> | --pack');
  process.exit(2);
}

const work = mkdtempSync(path.join(tmpdir(), 'handover-smoke-'));
let checks = 0;
const failures = [];
// filled in once the artifact is installed
let CLI = '';
let MCP = '';

function check(label, condition, detail = '') {
  checks += 1;
  if (condition) {
    return true;
  }
  failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
  return false;
}

/** Runs a command and asserts nothing leaked terminal controls, then returns it. */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? work,
    encoding: 'utf8',
    env: { ...process.env, ...options.env },
    input: options.input,
    shell: options.shell ?? false,
    timeout: options.timeout ?? 180_000,
    windowsHide: true,
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  if (!check(`${command} ${args.join(' ')} produced no terminal control bytes`, !CONTROL_BYTES.test(stdout + stderr))) {
    const line = (stdout + stderr).split('\n').find((l) => CONTROL_BYTES.test(l)) ?? '';
    failures.push(`  offending output: ${JSON.stringify(line.slice(0, 160))}`);
  }
  if (result.error) {
    failures.push(`${command} failed to start: ${result.error.message}`);
    checks += 1;
  }
  return { status: result.status, stdout, stderr };
}

function npm(args, options = {}) {
  // npm is a .cmd shim, which Node will only run through a shell on Windows. The
  // command is assembled as one string so the shell does not have to re-split an
  // argument list (and does not warn about doing so); callers quote the paths
  // they interpolate, and the only interpolated values come from our own argv.
  return run(`npm ${args.join(' ')}`, [], { ...options, shell: true });
}

function cliCli(args, options = {}) {
  return run(process.execPath, [CLI, ...args], options);
}

try {
  // --pack builds the archive itself, so neither CI nor a human has to glob a
  // versioned filename into existence
  let archive;
  if (wantsPack) {
    const packDir = path.join(work, 'pack');
    mkdirSync(packDir, { recursive: true });
    const packed = npm(['pack', '--pack-destination', `"${packDir}"`], { cwd: process.cwd(), timeout: 300_000 });
    const name = packed.stdout.trim().split('\n').filter(Boolean).pop() ?? '';
    archive = path.join(packDir, name);
    if (!check('npm pack produced an archive', packed.status === 0 && name.length > 0 && existsSync(archive), `${packed.status} ${packed.stderr.slice(0, 200)}`)) {
      throw new Error('cannot build a smoke environment');
    }
  } else {
    archive = path.resolve(pkg ?? '');
    if (!check('the given package archive exists', existsSync(archive), archive)) {
      throw new Error('cannot build a smoke environment');
    }
  }

  console.log(`installing ${path.basename(archive)} into ${work} …`);
  const init = npm(['init', '-y'], { cwd: work });
  if (!check('npm init -y succeeded', init.status === 0, init.stderr.slice(0, 200))) {
    throw new Error('cannot build a smoke environment');
  }
  // shell:true is how npm gets found on Windows, and it re-parses the joined
  // command line — so the paths that could contain a space need their own quotes
  const installed = npm(['install', '--no-audit', '--no-fund', `"${archive}"`], { cwd: work, timeout: 600_000 });
  if (!check('npm install of the packed artifact succeeded', installed.status === 0, installed.stderr.slice(0, 400))) {
    throw new Error('cannot build a smoke environment');
  }

  CLI = path.join(work, 'node_modules', 'handover-book', 'dist', 'cli.js');
  MCP = path.join(work, 'node_modules', 'handover-book', 'dist', 'mcp.js');
  check('the installed CLI entry point exists', existsSync(CLI), CLI);
  check('the installed MCP server entry point exists', existsSync(MCP), MCP);

  // ---- a synthetic repository to collect ------------------------------------
  const fixture = path.join(work, 'fixture-repo');
  const dataDir = path.join(work, 'index');
  const bookDir = path.join(work, 'book');
  writeFileSync(path.join(work, 'changed.txt'), 'payments/charge.ts\n', 'utf8');
  writeFileSync(
    path.join(work, 'answers.json'),
    JSON.stringify([
      { question: 'What breaks at 3am?', answer: 'The settlement worker; it retries without a backoff.' },
      { question: 'Skipped on purpose', answer: '   ' },
    ]),
    'utf8',
  );

  const git = (args) => run('git', ['-C', fixture, ...args]);
  const identity = ['-c', 'user.name=Dana Deva', '-c', 'user.email=dana@example.com'];
  const initialized = run('git', ['-C', work, 'init', '-q', '-b', 'main', 'fixture-repo']);
  check('the fixture repository was created', initialized.status === 0, initialized.stderr.slice(0, 200));
  writeFileSync(path.join(fixture, 'README.md'), '# fixture\n', 'utf8');
  git(['add', 'README.md']);
  git([...identity, 'commit', '-q', '-m', 'init']);
  writeFileSync(path.join(fixture, 'charge.ts'), 'export const charge = 1;\n', 'utf8');
  git(['add', 'charge.ts']);
  const committed = git([...identity, 'commit', '-q', '-m', 'settle idempotently']);
  check('the fixture repository has commits', committed.status === 0, committed.stderr.slice(0, 200));

  // ---- every command, asserting on the words it says ------------------------
  const version = cliCli(['--version']);
  check('--version prints a semver', /^\d+\.\d+\.\d+/m.test(version.stdout + version.stderr), version.stdout);

  const collected = cliCli(['collect', 'dana-dev', '--git-dir', fixture, '--author', 'dana@example.com', '--data-dir', dataDir]);
  check('collect exits 0', collected.status === 0, collected.stderr.slice(0, 300));
  check('collect reports indexed commits', /commits/i.test(collected.stdout) && /(cached|indexed)/i.test(collected.stdout), collected.stdout.slice(0, 300));

  const risk = cliCli(['risk', 'dana-dev', '--data-dir', dataDir]);
  check('risk exits 0', risk.status === 0, risk.stderr.slice(0, 300));
  check('risk prints the Top 5 heading', /Risk Top 5/.test(risk.stdout), risk.stdout.slice(0, 300));

  const riskJson = cliCli(['risk', 'dana-dev', '--json', '--data-dir', dataDir]);
  let parsedRisk = null;
  try {
    parsedRisk = JSON.parse(riskJson.stdout);
  } catch {
    /* reported by the check below */
  }
  check('risk --json is parseable JSON', Array.isArray(parsedRisk) && parsedRisk.length > 0, riskJson.stdout.slice(0, 200));

  const bus = cliCli(['bus-factor', 'dana-dev', '--data-dir', dataDir]);
  check('bus-factor exits 0 and prints a map', bus.status === 0 && /author/i.test(bus.stdout), bus.stderr.slice(0, 200));

  const gate = cliCli(['gate', 'dana-dev', '--files', path.join(work, 'changed.txt'), '--data-dir', dataDir]);
  check('gate prints a verdict', /Gate:/.test(gate.stdout), gate.stdout.slice(0, 300));

  const gateEmpty = cliCli(['gate', 'dana-dev', '--files', '-', '--data-dir', dataDir], { input: '' });
  check('a gate with no paths refuses to answer rather than passing', gateEmpty.status !== 0, `exit=${gateEmpty.status} ${gateEmpty.stdout.slice(0, 200)}`);
  check('and it explains why', /nothing to gate/i.test(gateEmpty.stderr), gateEmpty.stderr.slice(0, 300));

  const captured = cliCli(['capture', 'dana-dev', '--answers', path.join(work, 'answers.json'), '--data-dir', dataDir]);
  check('capture stores only the non-blank answer', /Captured 1 answer/.test(captured.stdout), captured.stdout.slice(0, 200));

  const listed = cliCli(['capture', 'dana-dev', '--list', '--data-dir', dataDir]);
  check('capture --list reads it back', /3am/.test(listed.stdout), listed.stdout.slice(0, 200));

  const gen = cliCli(['gen', 'dana-dev', '--git-dir', fixture, '--author', 'dana@example.com', '--html', '--data-dir', bookDir]);
  check('gen exits 0', gen.status === 0, gen.stderr.slice(0, 400));
  check('gen says nothing left the machine', /Nothing leaves this machine|LLM synthesis disabled/i.test(gen.stdout), gen.stdout.slice(0, 400));
  const bookPath = path.join(bookDir, 'handover-book-dana-dev.md');
  const htmlPath = path.join(bookDir, 'handover-book-dana-dev.html');
  check('gen wrote the book', existsSync(bookPath), bookPath);
  check('gen wrote the HTML twin', existsSync(htmlPath), htmlPath);
  if (existsSync(bookPath)) {
    const book = readFileSync(bookPath, 'utf8');
    check('the book states its redaction', /Redaction/.test(book), book.slice(0, 400));
    // the front page is the action summary: coverage, gaps, and what to confirm
    check('the book opens with its action summary', /Action summary/.test(book), book.slice(0, 400));
    check('the book has the six chapters and the evidence register', /## 6\./.test(book) && /evidence register/i.test(book), book.slice(0, 400));
  }

  const verified = cliCli(['verify', 'dana-dev', '--data-dir', bookDir]);
  check('verify exits 0 and counts citations', verified.status === 0 && /citation/.test(verified.stdout), `${verified.stdout} ${verified.stderr}`.slice(0, 300));

  const rendered = cliCli(['render', 'dana-dev', '--data-dir', bookDir]);
  check('render re-renders from the index', rendered.status === 0 && /Book/i.test(rendered.stdout), rendered.stderr.slice(0, 300));

  const unknown = cliCli(['definitely-not-a-command']);
  check('an unknown command exits non-zero', unknown.status !== 0, `exit=${unknown.status}`);
  check('and the failure is printed, not crashed', !/Assertion failed|Traceback|at .*\.ts:\d+/.test(unknown.stderr), unknown.stderr.slice(0, 300));

  const noIndex = cliCli(['risk', 'nobody-here', '--data-dir', path.join(work, 'empty-dir')]);
  check('a missing index produces an actionable error', noIndex.status !== 0 && /run "handover collect/i.test(noIndex.stderr), noIndex.stderr.slice(0, 300));

  // ---- the README's own instructions, executed ------------------------------
  // "npm install -g handover-book" then "handover gen …" is the entire quick
  // start, and until now nothing had ever exercised the global bin shim: a
  // package whose CLI is correct when run through npx and broken when installed
  // globally is exactly what a first-time user would find.
  const prefix = path.join(work, 'global');
  const globalInstall = npm(['install', '-g', '--prefix', `"${prefix}"`, `"${archive}"`], { cwd: work, timeout: 600_000 });
  checks += 1;
  if (globalInstall.status !== 0) {
    failures.push(`npm install -g --prefix failed: ${globalInstall.stderr.slice(0, 300)}`);
  }
  // npm drops .cmd shims directly in the prefix on Windows and in <prefix>/bin elsewhere
  const shim = path.join(process.platform === 'win32' ? prefix : path.join(prefix, 'bin'), 'handover.cmd');
  const shimPosix = path.join(prefix, 'bin', 'handover');
  const bin = existsSync(shim) ? shim : existsSync(shimPosix) ? shimPosix : '';
  checks += 2;
  if (bin === '') {
    failures.push(`no global handover shim under ${prefix} — the package's bin entry does not survive a global install`);
  } else {
    // Node refuses to spawn a .cmd without a shell (and needs one anyway to honour
    // PATHEXT). Build one quoted command line rather than handing an argument array
    // to the shell: that both works and avoids Node's "arguments are only
    // concatenated" deprecation. Every argument here is a path we created.
    const quote = (value) => `"${String(value).replace(/"/g, '')}"`;
    const runBin = (args, options = {}) =>
      bin.endsWith('.cmd')
        ? run([`"${bin}"`, ...args.map(quote)].join(' '), [], { ...options, shell: true })
        : run(bin, args, options);
    const globalVersion = runBin(['--version']);
    check('the globally installed CLI reports a version', /^\d+\.\d+\.\d+/m.test(globalVersion.stdout + globalVersion.stderr), globalVersion.stdout + globalVersion.stderr);

    // and one real run through that shim, in a directory of its own, writing
    // the handover-data/ layout the README promises. The key is blanked rather
    // than left alone: a developer machine running this has one set for other
    // tooling, and the point of the default is that it then still changes nothing
    const globalHome = path.join(work, 'global-home');
    mkdirSync(globalHome, { recursive: true });
    const globalGen = runBin(['gen', 'dana-dev', '--git-dir', fixture, '--author', 'dana@example.com'], {
      cwd: globalHome,
      env: { OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' },
    });
    check('gen works from the global shim', globalGen.status === 0, globalGen.stderr.slice(0, 300));
    checks += 3;
    if (!/Nothing leaves this machine|LLM synthesis disabled/i.test(globalGen.stdout)) {
      failures.push(`the global run did not report the deterministic default: ${globalGen.stdout.slice(0, 300)}`);
    }
    if (!existsSync(path.join(globalHome, 'handover-data', 'dana-dev.db'))) {
      failures.push('the SQLite index did not land in handover-data/ as the README states');
    }
    if (!existsSync(path.join(globalHome, 'handover-data', 'handover-book-dana-dev.md'))) {
      failures.push('the book did not land in handover-data/ as the README states');
    }
    const globalVerify = runBin(['verify', 'dana-dev'], { cwd: globalHome });
    check('verify works from the global shim and finds its citations', globalVerify.status === 0 && /citation/.test(globalVerify.stdout), `${globalVerify.stdout} ${globalVerify.stderr}`.slice(0, 300));
  }

  // ---- the README's other install route: running from source ----------------
  // contributors are told `npm install && npm run dev -- gen …`. The argument
  // passthrough is an npm behaviour, not a code path, so nothing else in the
  // suite would notice it breaking — and this only applies when smoke is run
  // from a checkout, not from an installed copy.
  const sourceManifest = path.join(process.cwd(), 'package.json');
  if (existsSync(sourceManifest) && readFileSync(sourceManifest, 'utf8').includes('"dev":')) {
    const devHome = path.join(work, 'dev-home');
    mkdirSync(devHome, { recursive: true });
    const dev = npm(['run', 'dev', '--', 'gen', 'dana-dev', '--git-dir', `"${fixture}"`, '--author', 'dana@example.com', '--data-dir', `"${devHome}"`], {
      cwd: process.cwd(),
      timeout: 300_000,
    });
    checks += 2;
    if (dev.status !== 0) {
      failures.push(`npm run dev -- gen … failed (the README's source route): ${`${dev.stdout}${dev.stderr}`.slice(-400)}`);
    }
    if (!existsSync(path.join(devHome, 'handover-book-dana-dev.md'))) {
      failures.push(`npm run dev -- gen … exited ${dev.status} but wrote no book to ${devHome}`);
    }
  }

  // ---- the example workflow downstream teams copy, executed ----------------
  // examples/sole-owner-gate-action.yml is the one part of this repository whose
  // failure mode is silent in someone else's CI: if its "did this PR touch a
  // sole-owned module?" test stops matching the CLI's output, the bot goes quiet
  // and every PR passes. So run the two guards it depends on, reading them out of
  // the file rather than restating them here.
  const examplePath = path.join(process.cwd(), 'examples', 'sole-owner-gate-action.yml');
  if (existsSync(examplePath)) {
    const example = readFileSync(examplePath, 'utf8');
    const runBlock = (stepName) => {
      const lines = example.split('\n');
      const named = lines.findIndex((line) => line.includes(`name: ${stepName}`));
      if (named < 0) {
        return '';
      }
      // the body runs from this step's own `run: |` line until a line is dedented
      // past its first body line — YAML's rule for a literal block scalar. Two
      // shortcuts get it wrong: including the marker hands bash a command named
      // `run:`, and dedenting by the least indented line of the rest of the file
      // swallows every later step, so the snippet fails for someone else's reason.
      const marker = lines.findIndex((line, index) => index > named && /^\s*run: \|\s*$/.test(line));
      if (marker < 0) {
        return '';
      }
      const rest = lines.slice(marker + 1);
      const first = rest.find((line) => line.trim() !== '');
      if (first === undefined) {
        return '';
      }
      const bodyIndent = first.search(/\S/);
      if (bodyIndent <= lines[marker].search(/\S/)) {
        return ''; // not a block belonging to this step
      }
      const out = [];
      for (const line of rest) {
        if (line.trim() !== '' && line.search(/\S/) < bodyIndent) {
          break;
        }
        out.push(line.slice(bodyIndent));
      }
      return out.join('\n');
    };

    const refuseBlock = runBlock('Refuse to run unpinned');
    const gateBlock = runBlock('Gate');
    check('the example exposes its unpinned-version guard', refuseBlock.includes('HANDOVER_VERSION'), refuseBlock);
    // The anchor for the extraction itself, because a guard that runs the wrong
    // text still exits 1: the first draft dedented by the least indented line of
    // the whole rest of the file, so every block ran to the end of the workflow and
    // the two "must refuse" cases passed on someone else's `npm install` failure.
    check('each extracted block stays inside its own step', !refuseBlock.includes('npm install') && !gateBlock.includes('gh pr comment'), `${refuseBlock}\n---\n${gateBlock}`);

    // The snippet is a `run:` step, so what matters is that a real bash executes it.
    // Probe for bash rather than for a platform: `process.platform !== 'win32'`
    // skipped these four cases on every WSL checkout that resolves node to the
    // Windows binary, which is the same silent-coverage hole the check count exists
    // to catch. Where bash is genuinely absent, the ubuntu CI leg still covers it.
    const hasBash = spawnSync('bash', ['--version'], { encoding: 'utf8', timeout: 10_000 }).status === 0;
    if (!hasBash) {
      console.log('(no bash on this host: the example workflow guard cases were skipped — the ubuntu CI leg runs them)');
    }
    if (hasBash && refuseBlock.includes('HANDOVER_VERSION')) {
      for (const [value, shouldRefuse] of [['', true], ['latest', true], ['0.1.3', false]]) {
        // The snippet goes in on stdin, not as `bash -c "<script>"`. Under WSL, a
        // Windows node spawning a Linux bash hands the -c string through a shell
        // that expands it first: "$HANDOVER_VERSION" arrived already empty, every
        // case refused, and two of them looked like correct refusals. The env option
        // is not a way out either — Windows env vars do not reach that bash at all.
        const guard = spawnSync('bash', ['-s'], {
          encoding: 'utf8',
          cwd: work,
          timeout: 30_000,
          input: `HANDOVER_VERSION=${JSON.stringify(value)}\n${refuseBlock}\n`,
        });
        // A spawn that never started is not a refusal. `/usr/bin/env` looked like the
        // portable spelling here and is simply absent under a Windows node, which
        // made every case report "refused" and passed two of them by accident.
        if (check(`the guard actually ran for HANDOVER_VERSION=${JSON.stringify(value)}`, guard.error === undefined, String(guard.error?.message ?? ''))) {
          const refused = guard.status !== 0;
          check(
            `expected the shipped example to ${shouldRefuse ? 'refuse' : 'accept'} HANDOVER_VERSION=${JSON.stringify(value)}, but it did the opposite`,
            refused === shouldRefuse,
            `status=${guard.status} stderr=${guard.stderr.trim()}`,
          );
          // and a refusal is only a refusal if it says why — otherwise an unrelated
          // `command not found` would satisfy the two cases above
          if (shouldRefuse) {
            check(`the refusal for HANDOVER_VERSION=${JSON.stringify(value)} names the fix`, /exact published handover-book version/.test(String(guard.stderr ?? '')), guard.stderr.trim());
          }
        }
      }
    }

    // the detector: pull the grep pattern out of the Gate step and apply it to the
    // comment the installed CLI really prints
    const detector = /grep -c '([^']+)'/.exec(gateBlock)?.[1] ?? '';
    if (check('the example exposes its gate comment detector', detector.length > 0, gateBlock)) {
      const hitList = path.join(work, 'changed-hit.txt');
      const missList = path.join(work, 'changed-clean.txt');
      writeFileSync(hitList, 'charge.ts\n', 'utf8');
      writeFileSync(missList, 'nothing/here.ts\n', 'utf8');
      const hit = cliCli(['gate', 'dana-dev', '--files', hitList, '--comment', '--data-dir', bookDir]);
      const miss = cliCli(['gate', 'dana-dev', '--files', missList, '--comment', '--data-dir', bookDir]);
      const matched = (output) => output.split('\n').filter((line) => new RegExp(detector).test(line));
      checks += 2;
      if (matched(hit.stdout).length === 0) {
        failures.push(`the example's detector (${detector}) matches nothing in a real gate comment — downstream the bot would stay silent:\n${hit.stdout.slice(0, 400)}`);
      }
      if (matched(miss.stdout).length !== 0) {
        failures.push(`the example's detector matched a clean PR: ${miss.stdout.slice(0, 400)}`);
      }
    }
  }

  // ---- the MCP server, over stdio ------------------------------------------
  const mcp = await driveMcp(MCP, work);
  for (const failure of mcp.failures) {
    failures.push(failure);
  }
  checks += mcp.checks;
} catch (error) {
  // An abort is a result, not a reason to print nothing: the first draft of this
  // script threw past its own report and exited 0 with the failures unsaid.
  failures.push(`smoke aborted: ${error instanceof Error ? error.message : String(error)}`);
  checks += 1;
} finally {
  // Windows can refuse to delete a directory a process still holds open, and a
  // teardown failure must not replace the report it follows. CI runners wipe
  // their own temp between jobs, so leaving it behind is noise, not a leak.
  try {
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (error) {
    console.log(`(could not remove ${work}: ${error.code ?? error.message})`);
  }
}

if (checks < MIN_CHECKS) {
  failures.push(`only ${checks} checks ran; a smoke run that reads nothing is not a pass`);
}

if (failures.length > 0) {
  console.error(`\nsmoke FAILED (${checks} checks, ${failures.length} problem(s)):`);
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exitCode = 1;
} else {
  console.log(`\nsmoke: ${checks} checks passed against the packed artifact.`);
}

/**
 * Speaks JSON-RPC to the installed MCP server: a real handshake, the tool list,
 * a full generate, and the dataDir confinement the model-facing surface depends
 * on. Asserts on the results rather than on the connection surviving.
 */
async function driveMcp(server, cwd) {
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [server], { cwd, windowsHide: true });
  const failures = [];
  let checks = 0;
  const pending = new Map();
  let nextId = 1;
  let buffer = '';

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.id !== undefined) {
        pending.get(message.id)?.(message);
        pending.delete(message.id);
      }
    }
  });
  child.stderr.on('data', () => {
    /* warnings; the control-byte sweep below is what matters */
  });
  // A server that died early turns the next stdin write into an unhandled EPIPE
  // that would crash the whole smoke run and hide every remaining check. The
  // pending call's own timeout reports the missing reply as a failure instead.
  child.stdin.on('error', () => {});

  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  /** The structured payload a tool call appended after its progress text, if any. */
  function lastJsonBlock(reply) {
    const blocks = reply?.result?.content ?? [];
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      const text = blocks[index]?.text;
      if (typeof text !== 'string') {
        continue;
      }
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object') {
          return parsed;
        }
      } catch {
        // progress text; keep looking
      }
    }
    return undefined;
  }
  const call = (method, params, timeoutMs = 120_000) =>
    new Promise((resolve, reject) => {
      const id = nextId;
      nextId += 1;
      const timer = setTimeout(() => reject(new Error(`no reply to ${method}`)), timeoutMs);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      send({ jsonrpc: '2.0', id, method, params });
    });

  try {
    const init = await call('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'smoke', version: '0' },
    });
    checks += 1;
    if (!init.result?.serverInfo) failures.push('MCP initialize returned no serverInfo');
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    const tools = await call('tools/list', {});
    const names = (tools.result?.tools ?? []).map((tool) => tool.name);
    checks += 1;
    if (names.length < 7) failures.push(`MCP tools/list returned ${names.length} tools: ${names.join(', ')}`);

    const generated = await call('tools/call', {
      name: 'handover_generate',
      arguments: { username: 'dana-dev', repos: [], gitDirs: [path.join(cwd, 'fixture-repo')], authorIdentity: 'dana@example.com', dataDir: 'mcp-book' },
    });
    const text = JSON.stringify(generated.result ?? generated.error ?? '');
    checks += 1;
    if (CONTROL_BYTES.test(text)) failures.push('MCP tool output carried terminal control bytes');
    // the payload is a JSON block inside a JSON-RPC envelope — assert on the
    // parsed values, not on substrings of an escaped form
    const made = lastJsonBlock(generated);
    checks += 3;
    // the book path is the one thing the caller needs back
    if (typeof made?.bookPath !== 'string' || made.bookPath.length === 0) {
      failures.push(`MCP handover_generate returned no book path: ${text.slice(0, 400)}`);
    }
    const chapters = Array.isArray(made?.chapters) ? made.chapters : [];
    if (chapters.length < 6) failures.push(`MCP handover_generate produced ${chapters.length} chapters, expected 6`);
    // and every chapter must say it was written deterministically: the default is
    // "nothing leaves this machine", so an LLM chapter here is the bug
    const synthesized = chapters.filter((chapter) => chapter.generatedBy !== 'deterministic');
    if (synthesized.length > 0) failures.push(`MCP generated chapters without being asked: ${synthesized.map((c) => `${c.id}:${c.generatedBy}`).join(', ')}`);

    const verified = await call('tools/call', { name: 'handover_verify', arguments: { username: 'dana-dev', dataDir: 'mcp-book' } });
    // the payload is a JSON block inside a JSON-RPC envelope, so match the parsed
    // value: a string test against the escaped form asserted nothing and "failed"
    // on a book that had passed
    const verdict = lastJsonBlock(verified);
    checks += 2;
    if (verdict === undefined) {
      failures.push(`handover_verify returned no JSON result: ${JSON.stringify(verified.result ?? verified.error).slice(0, 300)}`);
    } else {
      if (!(verdict.citations > 0)) failures.push(`handover_verify found no citations to check: ${JSON.stringify(verdict).slice(0, 300)}`);
      // the artifact's own book must satisfy the artifact's own citation checker
      if (verdict.missingCount !== 0) failures.push(`the generated book cites refs the index cannot support: ${JSON.stringify(verdict.missing).slice(0, 300)}`);
    }

    const escaped = await call('tools/call', { name: 'handover_risk', arguments: { username: 'dana-dev', dataDir: '../../outside' } });
    const escapeText = JSON.stringify(escaped.result ?? escaped.error ?? '');
    checks += 1;
    if (!/outside the permitted roots|isError":true/.test(escapeText)) {
      failures.push(`MCP accepted a dataDir outside the permitted roots: ${escapeText.slice(0, 200)}`);
    }
  } catch (error) {
    failures.push(`MCP round trip: ${error.message}`);
    checks += 1;
  } finally {
    child.stdin.end();
    child.kill();
    // our ends of the pipes have to go, or the parent waits on a dead child
    child.stdout.destroy();
    child.stderr.destroy();
  }
  return { checks, failures };
}
