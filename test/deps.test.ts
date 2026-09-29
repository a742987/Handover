import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The audit's dependency phase asked three questions that are usually answered by
 * reading `package.json` and hoping: is anything unmaintained, is the split
 * between runtime and dev real, and does the lockfile actually pin what CI
 * installs. The first is answered out-of-band (registry queries, recorded in
 * `docs/install-verification.md`); these two are properties of the repository, so
 * they can be checked in on every commit instead.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8')) as {
  name?: string;
  version?: string;
  lockfileVersion?: number;
  packages?: Record<string, { version?: string; integrity?: string; link?: boolean }>;
};

function sources(dir: string, into: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      sources(full, into);
    } else if (entry.name.endsWith('.ts')) {
      into.push(readFileSync(full, 'utf8'));
    }
  }
  return into;
}

const imported = new Set<string>();
for (const text of sources(path.join(root, 'src'))) {
  for (const match of text.matchAll(/from\s+'([^']+)'/g)) {
    const spec = match[1] ?? '';
    if (spec.startsWith('.') || spec.startsWith('node:')) {
      continue;
    }
    const parts = spec.split('/');
    imported.add(spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!);
  }
}

describe('the dependency split is real', () => {
  it('declares no runtime dependency that nothing imports', () => {
    const unused = Object.keys(pkg.dependencies ?? {}).filter((name) => !imported.has(name));
    expect(unused).toEqual([]);
  });

  it('never imports a dev dependency from shipped source', () => {
    const leaked = Object.keys(pkg.devDependencies ?? {}).filter((name) => imported.has(name));
    expect(leaked).toEqual([]);
  });

  it('ships a lockfile whose root identity matches package.json', () => {
    // A version bump that skips `npm install` leaves the lockfile root behind.
    // npm ci tolerates the drift, so nothing else in the pipeline notices —
    // the 0.1.3 bump left the lockfile saying 0.1.2 until this check caught it.
    expect(lock.name).toBe(pkg.name);
    expect(lock.version).toBe(pkg.version);
  });

  it('ships a lockfile that pins exact resolutions with integrity hashes', () => {
    expect(lock.lockfileVersion).toBe(3);
    // Top-level entries only (transitive copies under node_modules/*/node_modules
    // are resolved by their own entry) — and scoped packages count: the filter
    // used to drop everything containing a slash, which quietly excluded every
    // @-scoped runtime dependency from this check.
    const entries = Object.entries(lock.packages ?? {}).filter(([name, meta]) => {
      if (!name.startsWith('node_modules/') || meta.link) {
        return false;
      }
      const rel = name.slice('node_modules/'.length);
      const top = rel.startsWith('@') ? rel.split('/').slice(0, 2).join('/') : rel.split('/')[0];
      return top !== undefined && !rel.slice(top.length + 1).includes('/');
    });
    expect(entries.length).toBeGreaterThan(0);
    const loose = entries.filter(([, meta]) => !/^\d+\.\d+\.\d+(-[\w.+]*)?$/.test(String(meta.version)));
    const unhashed = entries.filter(([, meta]) => !meta.integrity).map(([name]) => name);
    // npm ci installs from these entries; a missing integrity hash is a
    // supply-chain hole, and a range here would mean CI resolves at install time
    expect(loose.map(([name]) => name)).toEqual([]);
    expect(unhashed).toEqual([]);
    // and every declared dependency is actually among them — a dependency the
    // lockfile never pinned would resolve at install time in CI
    const topLevel = new Set(
      entries.map(([name]) => {
        const rel = name.slice('node_modules/'.length);
        return rel.startsWith('@') ? rel.split('/').slice(0, 2).join('/') : rel.split('/')[0];
      }),
    );
    const unpinned = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((name) => !topLevel.has(name));
    expect(unpinned).toEqual([]);
  });
});
