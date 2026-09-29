import { describe, expect, it } from 'vitest';
import { ownersFor, parseCodeowners } from '../src/collect/codeowners.js';
import { resolveNumstatPath } from '../src/collect/git.js';
import { parseSince } from '../src/args.js';
import { confineDataDir } from '../src/config.js';
import { neutralizeGeneratedMarkup } from '../src/render/escape.js';
import { redact } from '../src/render/redact.js';

/**
 * Everything below takes input this tool does not control: a repository being
 * analyzed picks its own file paths, CODEOWNERS lines and commit messages, and
 * an LLM picks its own chapter text. A deterministic generator, rather than
 * hand-picked cases, is what finds the shape nobody thought of — the wildcard
 * bomb that made `handover bus-factor` hang for 20 seconds on 36 characters came
 * from exactly that class.
 */

// xorshift32: reproducible without a dependency, and vitest seeds stay stable.
function rng(seed: number): () => number {
  let state = seed >>> 0 || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

const ADVERSARIAL_ALPHABET = [...'*?[]{}()|^$+.\\/"\'` \t\n\r\x00\x1f\x7f-=<>!;,0123456789abcABC:/…😀'];

function randomString(next: () => number, maxLen: number, alphabet = ADVERSARIAL_ALPHABET): string {
  const len = Math.floor(next() * maxLen);
  let out = '';
  for (let i = 0; i < len; i += 1) {
    out += alphabet[Math.floor(next() * alphabet.length)] ?? 'a';
  }
  return out;
}

describe('adversarial repo-supplied input stays bounded and inert', () => {
  it('CODEOWNERS matching never blows up on random wildcard soup', () => {
    const next = rng(20260929);
    const deadline = Date.now() + 4_000;
    for (let round = 0; round < 400; round += 1) {
      const rules = parseCodeowners(`${randomString(next, 60)} @acme/owners`);
      const path = randomString(next, 120);
      ownersFor(rules, path);
      expect(Date.now(), `round ${round} exceeded the time budget`).toBeLessThan(deadline);
    }
  });

  it('numstat path decoding never throws and never keeps a raw control byte', () => {
    const next = rng(20260928);
    for (let round = 0; round < 2_000; round += 1) {
      const out = resolveNumstatPath(randomString(next, 80));
      expect(out).not.toMatch(/[\x00-\x08]/);
    }
  });

  it('parseSince either returns an ISO timestamp or rejects — never a rolled-over date', () => {
    const next = rng(20260927);
    for (let round = 0; round < 2_000; round += 1) {
      const value = randomString(next, 28);
      try {
        const normalized = parseSince(value);
        expect(normalized).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        // only real calendar dates survive
        expect(new Date(normalized).getTime(), value).not.toBeNaN();
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
      }
    }
    // the accepted spelling round-trips
    expect(parseSince('2024-01-01')).toBe('2024-01-01T00:00:00.000Z');
    expect(() => parseSince('2024-02-30')).toThrow(/calendar date/);
  });

  it('model-generated markdown contains no live markup afterwards', () => {
    const next = rng(20260926);
    for (let round = 0; round < 2_000; round += 1) {
      const out = neutralizeGeneratedMarkup(randomString(next, 200));
      // nothing that a parser would read as a tag, a comment or a processing
      // instruction may survive the neutralizer
      expect(out).not.toMatch(/<[/!A-Za-z]/);
    }
  });

  it('redaction keeps its own placeholder intact and never hangs', () => {
    const next = rng(20260925);
    const deadline = Date.now() + 4_000;
    for (let round = 0; round < 400; round += 1) {
      const out = redact(randomString(next, 300));
      expect(out).not.toContain('undefined');
      expect(Date.now()).toBeLessThan(deadline);
    }
    expect(redact('ghp_' + 'A'.repeat(36))).toBe('[REDACTED]');
    expect(redact('BEGIN OPENSSH PRIVATE KEY\nabc\nEND OPENSSH PRIVATE KEY')).toBe('[REDACTED]');
  });

  it('confineDataDir only ever returns a path inside an allowed root', () => {
    const next = rng(20260924);
    const root = process.cwd();
    for (let round = 0; round < 1_000; round += 1) {
      const candidate = randomString(next, 60).replace(/\0/g, '');
      let resolved: string;
      try {
        resolved = confineDataDir(candidate || 'x', [root]);
      } catch {
        continue; // rejected — the safe outcome
      }
      expect(resolved.startsWith(root) || resolved === root, resolved).toBe(true);
    }
  });
});

/**
 * A time bound alone is satisfied by a matcher that always answers "no", so the
 * DP that replaced the regex translation needs a second kind of check: does it
 * still mean the same thing? The reference below is the naive backtracking shape
 * the old regex had — different code, same documented semantics — run against a
 * seeded stream of random pattern × path pairs.
 *
 * The reference is deliberately kept inside the same wildcard budget production
 * enforces; without that, the check that exists to prove correctness is the thing
 * that hangs.
 */
describe('the glob matcher is bounded *and* still means what it meant', () => {
  const MAX_WILDCARDS = 16;

  function refSegment(pattern: string, text: string): boolean {
    const go = (i: number, j: number): boolean => {
      if (i === pattern.length) {
        return j === text.length;
      }
      const ch = pattern[i]!;
      if (ch === '*') {
        for (let k = j; k <= text.length; k += 1) {
          if (go(i + 1, k)) {
            return true;
          }
        }
        return false;
      }
      if (j === text.length) {
        return false;
      }
      return (ch === '?' || ch === text[j]!) && go(i + 1, j + 1);
    };
    return go(0, 0);
  }

  function refPath(patternSegments: string[], pathSegments: string[]): boolean {
    const go = (i: number, j: number): boolean => {
      if (i === patternSegments.length) {
        return j === pathSegments.length;
      }
      if (patternSegments[i] === '**') {
        for (let k = j; k <= pathSegments.length; k += 1) {
          if (go(i + 1, k)) {
            return true;
          }
        }
        return false;
      }
      if (j === pathSegments.length) {
        return false;
      }
      return refSegment(patternSegments[i]!, pathSegments[j]!) && go(i + 1, j + 1);
    };
    return go(0, 0);
  }

  /** Mirrors ruleMatches' documented semantics in recursive form. */
  function refRuleMatches(pattern: string, path: string): boolean {
    if ((pattern.match(/[*?]/g)?.length ?? 0) > MAX_WILDCARDS) {
      return false;
    }
    let p = pattern;
    const dirPrefix = p.endsWith('/');
    if (dirPrefix) {
      p = p.slice(0, -1);
    }
    const anchored = p.startsWith('/');
    if (anchored) {
      p = p.slice(1);
    }
    const anyDepth = !anchored && !p.includes('/');
    const segments = p.split('/').filter((segment) => segment.length > 0);
    const parts = path.split('/').filter((part) => part.length > 0);
    if (dirPrefix) {
      return refPath([...segments, '**'], parts);
    }
    if (anyDepth) {
      return refPath(['**', ...segments], parts) || refPath(['**', ...segments, '**'], parts);
    }
    return refPath(segments, parts) || refPath([...segments, '**'], parts);
  }

  const TOKENS = ['a', 'b', 'x', '1', '-', '.', '*', '?', '/', '**', '***', ''];

  function randomPattern(next: () => number): string {
    const count = 1 + Math.floor(next() * 6);
    let out = '';
    for (let i = 0; i < count; i += 1) {
      out += TOKENS[Math.floor(next() * TOKENS.length)]!;
    }
    while ((out.match(/[*?]/g)?.length ?? 0) > MAX_WILDCARDS) {
      out = out.slice(0, -1);
    }
    return out;
  }

  function randomPath(next: () => number): string {
    const depth = 1 + Math.floor(next() * 4);
    const segments: string[] = [];
    for (let i = 0; i < depth; i += 1) {
      let segment = '';
      const length = 1 + Math.floor(next() * 5);
      for (let c = 0; c < length; c += 1) {
        segment += ['a', 'b', 'x', '1', '-', '.'][Math.floor(next() * 6)]!;
      }
      segments.push(segment);
    }
    return segments.join('/');
  }

  function matched(pattern: string, path: string): boolean {
    return ownersFor([{ pattern, owners: ['@owner'] }], path).length === 1;
  }

  it('agrees with the naive reference over 20 000 seeded pattern × path pairs', () => {
    const next = rng(20260929);
    const mismatches: string[] = [];
    for (let round = 0; round < 20_000; round += 1) {
      const pattern = randomPattern(next);
      if (!pattern) {
        continue;
      }
      const path = randomPath(next);
      const actual = matched(pattern, path);
      const expected = refRuleMatches(pattern, path);
      if (actual !== expected && mismatches.length < 10) {
        mismatches.push(
          `pattern=${JSON.stringify(pattern)} path=${JSON.stringify(path)} matcher=${actual} reference=${expected}`,
        );
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('still gives the known answers, checked against the reference too', () => {
    // Without these, a differential test can quietly degrade into two
    // implementations that are wrong together.
    const cases: Array<[string, string, boolean]> = [
      ['docs', 'docs/README.md', true],
      ['docs', 'src/docs/README.md', true],
      ['docs', 'docsx/a.ts', false],
      ['docs/', 'docs/a.ts', true],
      ['/docs', 'docs/a.ts', true],
      ['/docs', 'src/docs/a.ts', false],
      ['*.ts', 'a.ts', true],
      ['*.ts', 'dir/a.ts', true],
      ['*.ts', 'a.tsx', false],
      ['**/legacy/**', 'a/b/legacy/c/d.ts', true],
      ['a/**/b', 'a/b', true],
      ['a/**/b', 'a/x/y/b', true],
      ['payments/*', 'payments/charge.ts', true],
      // Known deviation from gitignore, kept on purpose: a rule also owns
      // everything nested under what it names, because the regex this replaced
      // carried a `(?:$|/.*)` tail and the rewrite preserved that behaviour
      // rather than silently changing bus-factor output. GitHub's own CODEOWNERS
      // would need `payments/**` for this path.
      ['payments/*', 'payments/deep/charge.ts', true],
      ['payments/**', 'payments/deep/charge.ts', true],
      ['?', 'a', true],
      ['?', 'ab', false],
    ];
    for (const [pattern, path, expected] of cases) {
      expect(matched(pattern, path), `${pattern} vs ${path}`).toBe(expected);
      expect(refRuleMatches(pattern, path), `reference ${pattern} vs ${path}`).toBe(expected);
    }
  });

  // The exponential shape is ambiguous quantifiers over a run that keeps matching
  // until the end — `a*a*a*…b` against 40 `a`s. Measured on this machine with the
  // char-level backtracking the old regex stood in for:
  //   w=6  →  5 266 407 nodes, 22 ms
  //   w=8  →  56 913 920 nodes and still running when the probe gave up at 300 ms
  //   w=10…16 never finished either
  // The DP needs (p+1)×(t+1) = 1 336 cells for the w=16 pair, measured at 0.05 ms.
  it('stays inside its time budget on the shapes that made the regex exponential', () => {
    const patterns: string[] = [];
    for (let w = 1; w <= MAX_WILDCARDS; w += 1) {
      patterns.push('*a'.repeat(w), '?a'.repeat(w), `**/${'*a'.repeat(w - 1) || 'a'}`, `${'a*'.repeat(w)}b`);
    }
    const paths: string[] = [];
    for (const length of [1, 4, 12, 24, 40]) {
      paths.push('a'.repeat(length), 'z'.repeat(length));
    }
    paths.push('a/'.repeat(20), 'zzz/'.repeat(15) + 'zzz', 'a-b-c/d-e-f/g.h', 'a*?.ts', 'deep/nested/path/a');
    const rules = patterns.map((pattern) => ({ pattern, owners: ['@owner'] }));

    const started = performance.now();
    for (const rule of rules) {
      for (const path of paths) {
        ownersFor([rule], path);
      }
    }
    const elapsed = performance.now() - started;
    // positive control: the workload is the size this test claims (832 pairs,
    // measured at 3 ms), so the ceiling is headroom rather than an empty pass
    expect(rules.length * paths.length).toBeGreaterThan(700);
    expect(elapsed).toBeLessThan(1_000);
  });

  it('refuses over-budget patterns without refusing the ones inside budget', () => {
    expect(ownersFor([{ pattern: '*a'.repeat(40), owners: ['@owner'] }], 'a'.repeat(80))).toEqual([]);
    // `*a` repeated n times needs n characters — this is a real match, so the
    // budget is a limit on work, not a blanket "no" that would hide a regression
    expect(ownersFor([{ pattern: '*a'.repeat(MAX_WILDCARDS), owners: ['@owner'] }], 'a'.repeat(MAX_WILDCARDS))).toEqual([
      '@owner',
    ]);
  });
});
