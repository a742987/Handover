#!/usr/bin/env node
/**
 * Audit a built tarball before it can be published.
 *
 *   node scripts/check-package.mjs <path/to/handover-book-x.y.z.tgz>
 *
 * Replaces two `run:` blocks that had a blind spot each: `tar tzf … | grep …`
 * reported "clean" when tar itself could not open the file, so a failed pack or
 * an unexpanded glob satisfied the gate without it reading a single byte. Both
 * directions now have to be provable — a gate that cannot be made to fail is not
 * a gate.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const tarball = process.argv[2];
if (!tarball) {
  console.error('check-package: pass the tarball to audit (node scripts/check-package.mjs <file.tgz>)');
  process.exit(2);
}
if (!existsSync(tarball)) {
  console.error(`check-package: ${tarball} does not exist — refusing to call an unread artifact clean`);
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

// Every path the package promises consumers. A missing one is a broken install
// that only surfaces when someone runs `handover`, so it is checked here instead.
const promised = new Set(
  [
    ...Object.values(pkg.bin ?? {}),
    pkg.main,
    pkg.types,
    ...Object.values(pkg.exports ?? {}).flatMap((entry) =>
      Object.values(typeof entry === 'string' ? { default: entry } : (entry ?? {})),
    ),
  ]
    .filter((value) => typeof value === 'string')
    .map((value) => value.replace(/^\.\//, '')),
);

// Files that must never leave this machine. The index holds verbatim commit and
// PR text; a secret in a dotfile is self-explanatory.
const FORBIDDEN = [
  /(^|\/)\.env(\.|$)/,
  /(^|\/)[^/]*\.db$/,
  /(^|\/)handover-data\//,
  /(^|\/)(src|test)\//,
  /(^|\/)\.git\//,
];

function listingOf(tarballPath) {
  try {
    // Run tar with cwd at the archive's directory and a relative name: GNU tar
    // reads a leading `C:` as a remote host on Windows ("Cannot connect to C:
    // resolve failed"), and bsdtar has no --force-local. A relative name works
    // on both, and the script keeps accepting absolute tarball paths.
    const dir = path.dirname(path.resolve(tarballPath));
    return execFileSync('tar', ['tzf', path.basename(path.resolve(tarballPath))], {
      cwd: dir,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (error) {
    console.error(`check-package: tar could not list ${tarballPath} (${error instanceof Error ? error.message : String(error)})`);
    process.exit(1);
  }
}

const entries = listingOf(tarball).map((line) => line.replace(/^\.?\//, '').replace(/^package\//, ''));
if (entries.length === 0) {
  console.error('check-package: the tarball listed no entries at all');
  process.exit(1);
}

const problems = [];

for (const wanted of promised) {
  if (!entries.includes(wanted)) {
    problems.push(`promised entry is missing from the tarball: ${wanted}`);
  }
}

// Every `files` entry must have contributed at least one tarball path. A glob
// that matches nothing (a renamed screenshot, a moved examples/ tree) ships an
// empty directory and npm does not warn — the bin/exports check above cannot
// see it, and README badges and plugin docs depend on exactly these files.
// The list is read from the artifact's *own* package.json (npm always packs
// it), so the gate audits what this artifact promises, not what the checkout
// it may have drifted from does.
function filesOf(tarballPath, dir) {
  try {
    return JSON.parse(
      execFileSync('tar', ['-xzOf', path.basename(path.resolve(tarballPath)), 'package/package.json'], {
        cwd: dir,
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
      }),
    ).files;
  } catch {
    // no package.json in the artifact — the promised-entry check will speak for it
    return undefined;
  }
}

for (const wanted of ((filesOf(tarball, path.dirname(path.resolve(tarball))) ?? []).map((entry) =>
  String(entry).replace(/^\.\//, '').replace(/\/+$/, ''),
))) {
  if (!entries.some((entry) => entry === wanted || entry.startsWith(`${wanted}/`))) {
    problems.push(`files entry matched nothing in the tarball: ${wanted}`);
  }
}

for (const entry of entries) {
  if (FORBIDDEN.some((pattern) => pattern.test(entry))) {
    problems.push(`forbidden content in the tarball: ${entry}`);
  }
}

if (problems.length > 0) {
  console.error(`check-package: refusing ${path.basename(tarball)} (${entries.length} entries)`);
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  process.exit(1);
}

console.log(`check-package: ${path.basename(tarball)} ok — ${entries.length} entries, ${promised.size} promised entry/entries present, no local data`);
