#!/usr/bin/env node
/**
 * Release gate, wired to `prepublishOnly`.
 *
 * Every published version of this package so far was produced by hand from a
 * working copy, and it shows: `0.1.1` carries a gitHead pointing at the commit
 * that `v0.1.0` tags, and the local `v0.1.1` tag points at a third commit
 * entirely. There is no tag that reproduces what npm served. This script makes
 * the two directions of that mistake impossible from a workstation:
 *
 *   - publishing from a dirty tree (the artifact contains code no commit has), and
 *   - publishing a version that has no tag, so nothing identifies its source.
 *
 * The tag-driven workflow in .github/workflows/release.yml is the supported path;
 * this is the guard rail for anyone still typing `npm publish` locally.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const version = pkg.version;
const tag = `v${version}`;

function git(args) {
  try {
    return execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/** Changed paths, from the three lists git maintains — never by slicing porcelain. */
function changedPaths() {
  const sets = [
    git(['diff', '--name-only']),
    git(['diff', '--cached', '--name-only']),
    git(['ls-files', '--others', '--exclude-standard']),
  ];
  return [...new Set(sets.filter(Boolean).flatMap((out) => out.split('\n')).map((f) => f.trim()).filter(Boolean))];
}

const problems = [];

if (git(['rev-parse', '--is-inside-work-tree']) !== 'true') {
  console.error('check-release: not inside a git work tree — publish from a checkout of this repository');
  process.exit(1);
}

if (git(['rev-parse', 'HEAD']) === null) {
  problems.push('HEAD does not resolve; is this a repository with commits?');
} else {
  const important = changedPaths().filter((f) => !f.startsWith('handover-data/'));
  if (important.length > 0) {
    problems.push(
      `the working tree has uncommitted changes (${important.slice(0, 5).join(', ')}${important.length > 5 ? ', …' : ''}) — the tarball would contain code that no commit has`,
    );
  }
}

const head = git(['rev-parse', 'HEAD']);
// `rev-parse refs/tags/vX` answers with the *tag object* id when the tag is
// annotated, which never equals a commit id — comparing those directly made
// every annotated release look like a moved tag and blocked all publishing.
// Dereference to the commit, and check the object type separately.
const tagRef = git(['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`]);
const taggedCommit = tagRef ? git(['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`]) : null;
const tagType = tagRef ? git(['cat-file', '-t', tagRef]) : null;

if (!tagRef) {
  problems.push(`no tag ${tag}; create the release tag first (git tag -a ${tag} -m "Release ${tag}")`);
} else {
  if (tagType !== 'tag') {
    problems.push(
      `tag ${tag} is lightweight (${tagType}); release tags must be annotated (git tag -a) so the tagger and message are part of the artifact's provenance — v0.1.1 shipped as a lightweight tag and its history could not be reconstructed`,
    );
  }
  if (taggedCommit && head && taggedCommit !== head) {
    problems.push(
      `tag ${tag} points at ${taggedCommit.slice(0, 7)} but HEAD is ${head.slice(0, 7)} — the tag moved after the fact and no longer identifies this code`,
    );
  }
}

const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
if (branch && branch !== 'main' && taggedCommit !== head) {
  problems.push(`publishing from branch "${branch}" — cut releases from main or from the tagged commit`);
}

if (problems.length > 0) {
  console.error(`check-release: refusing to publish ${pkg.name}@${version}`);
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  console.error('Use the Release workflow instead: push the tag and let CI build and publish it with provenance.');
  process.exit(1);
}

console.log(`check-release: ${pkg.name}@${version} matches tag ${tag} at ${head.slice(0, 7)} on ${branch || 'detached HEAD'}.`);
