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
    const owners = parts.slice(1).filter((owner) => owner.length > 0);
    if (owners.length === 0) {
      continue;
    }
    rules.push({ pattern, owners });
  }
  return rules;
}

function ruleMatches(pattern: string, path: string): boolean {
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
  const body = p
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '.*');
  const source = `${anyDepth ? '(?:.*/)?' : ''}${body}${dirPrefix ? '/.*' : '(?:$|/.*)'}`;
  return new RegExp(`^${source}$`).test(path);
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
