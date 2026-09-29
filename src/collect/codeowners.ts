/**
 * CODEOWNERS parsing — a practical subset of the gitignore-like syntax GitHub
 * supports: comments, `*`/`?` wildcards, dir prefixes, root anchoring and
 * last-match-wins precedence. Enough to answer "who owns this path" without
 * pulling a matcher library.
 */

export interface CodeownersRule {
  pattern: string;
  /** owner tokens as written, e.g. "@acme/platform" or "user@example.com" */
  owners: string[];
}

export function parseCodeowners(text: string): CodeownersRule[] {
  const rules: CodeownersRule[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const parts = line.split(/\s+/);
    const pattern = parts[0]!;
    // owner handles end up in `handover bus-factor` output, so the same
    // control-byte strip the evidence index applies is done here too
    const owners = parts
      .slice(1)
      .filter((owner) => owner.length > 0)
      .map(sanitizeToken);
    if (owners.length === 0) {
      continue;
    }
    rules.push({ pattern, owners });
  }
  return rules;
}

/**
 * Wildcard characters that would translate into a backtracking regex group.
 * A CODEOWNERS line is a hand-written path pattern, so a run of these is a
 * crafted input (a poisoned repo is exactly what this tool is asked to analyze)
 * rather than a rule anyone intends to match — refuse it instead of evaluating
 * it: `*a*a*a*a*…` against a path that does not match is exponential work.
 */
import { sanitizeToken } from '../store/sanitize.js';

const WILDCARD_RE = /[*?]/g;
const MAX_WILDCARDS = 16;

/**
 * Glob match of one path segment against one pattern segment, without a regex.
 * `*` spans any run of characters, `?` one character, everything else literal.
 * The DP is bounded by pattern length × path length.
 */
function segmentMatches(pattern: string, text: string): boolean {
  const p = pattern.length;
  const t = text.length;
  if (!/[?*]/.test(pattern)) {
    return pattern === text;
  }
  if (p * t > MAX_WILDCARDS * 4_096) {
    return false;
  }
  // match[i][j] — do the first i pattern chars match the first j text chars
  const match: boolean[] = new Array((p + 1) * (t + 1)).fill(false);
  const at = (i: number, j: number): boolean => match[i * (t + 1) + j]!;
  match[0] = true;
  for (let i = 1; i <= p; i += 1) {
    if (pattern[i - 1] === '*') {
      for (let j = 0; j <= t; j += 1) {
        match[i * (t + 1) + j] = at(i - 1, j) || (j > 0 && at(i, j - 1));
      }
    } else {
      for (let j = 1; j <= t; j += 1) {
        const ch = pattern[i - 1] === '?' || pattern[i - 1] === text[j - 1];
        match[i * (t + 1) + j] = ch && at(i - 1, j - 1);
      }
    }
  }
  return at(p, t);
}

/**
 * Path-level match: `**` spans any number of segments (including none), a
 * pattern segment matches exactly one path segment. Iterative DP over the two
 * segment lists — no regex, so no catastrophic backtracking.
 */
function pathMatches(patternSegments: string[], pathSegments: string[]): boolean {
  const p = patternSegments.length;
  const t = pathSegments.length;
  if (p * t > MAX_WILDCARDS * 4_096) {
    return false;
  }
  const match: boolean[] = new Array((p + 1) * (t + 1)).fill(false);
  const at = (i: number, j: number): boolean => match[i * (t + 1) + j]!;
  match[0] = true;
  for (let i = 1; i <= p; i += 1) {
    if (patternSegments[i - 1] === '**') {
      for (let j = 0; j <= t; j += 1) {
        match[i * (t + 1) + j] = at(i - 1, j) || (j > 0 && at(i, j - 1));
      }
    } else {
      for (let j = 1; j <= t; j += 1) {
        match[i * (t + 1) + j] =
          segmentMatches(patternSegments[i - 1]!, pathSegments[j - 1]!) && at(i - 1, j - 1);
      }
    }
  }
  return at(p, t);
}

function ruleMatches(pattern: string, path: string): boolean {
  if ((pattern.match(WILDCARD_RE)?.length ?? 0) > MAX_WILDCARDS) {
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
  // patterns without a slash match a basename at any depth (gitignore semantics)
  const anyDepth = !anchored && !p.includes('/');
  const segments = p.split('/').filter((segment) => segment.length > 0);
  const parts = path.split('/').filter((part) => part.length > 0);
  if (dirPrefix) {
    // a directory rule owns everything below it; `**/` matches zero segments too
    return pathMatches([...segments, '**'], parts);
  }
  if (anyDepth) {
    // `docs` is a basename rule: it matches a file called docs anywhere, and
    // anything inside a *directory* called docs at any depth
    return pathMatches(['**', ...segments], parts) || pathMatches(['**', ...segments, '**'], parts);
  }
  // a file rule also matches paths nested under it (the previous regex carried
  // the `(?:$|/.*)` tail); a directory-without-slash rule like `legacy` is the
  // same thing
  return pathMatches(segments, parts) || pathMatches([...segments, '**'], parts);
}

/** Owners of a path under last-match-wins precedence; [] when no rule matches. */
export function ownersFor(rules: CodeownersRule[], path: string): string[] {
  for (let i = rules.length - 1; i >= 0; i -= 1) {
    const rule = rules[i]!;
    if (ruleMatches(rule.pattern, path)) {
      return rule.owners;
    }
  }
  return [];
}

/** The meta key under which each repo's CODEOWNERS text is indexed. */
export function codeownersMetaKey(repo: string): string {
  return `codeowners:${repo}`;
}
