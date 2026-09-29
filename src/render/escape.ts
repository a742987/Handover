/**
 * Escaping for untrusted user-generated content (PR titles, commit messages,
 * review text, file paths). Everything here eventually reaches a browser via
 * the single-file HTML twin, so HTML-significant characters must never
 * survive: markdown escaping alone leaves `<script>`/`<img onerror>` intact.
 */

export function escapeMarkdown(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([\\`*_{}[\]()#+\-.!|])/g, '\\$1')
    .replace(/\n/g, ' ');
}

/**
 * Chapter headings. escapeMarkdown's full char set is wrong here twice over:
 * `&` becomes a literal "&amp;" in the source markdown, and inside a heading
 * a leading `#`/`-` is the only structural hazard. Escape just what could
 * inject HTML or break the heading, leave `&` readable.
 */
export function escapeHeading(text: string): string {
  return text.replace(/</g, '&lt;').replace(/[\\`]/g, '\\$&');
}

/**
 * Renders untrusted text as a markdown code span. Backslash escapes do not
 * work inside code spans (CommonMark), so instead of escaping the content the
 * delimiter is widened to outgrow any backtick run in it — a module name
 * cannot close the span early and smuggle raw HTML into the rendered book.
 * Set `inTable` for GFM table cells, where pipes need the table-specific
 * `\|` escape even inside code spans.
 */
export function codeSpan(text: string, inTable = false): string {
  const flat = text.replace(/\r?\n/g, ' ');
  const longestRun = [...flat.matchAll(/`+/g)].reduce((max, match) => Math.max(max, match[0].length), 0);
  const fence = '`'.repeat(Math.max(1, longestRun + 1));
  const padded = flat.startsWith('`') || flat.endsWith('`') ? ` ${flat} ` : flat;
  const body = inTable ? padded.replace(/\|/g, '\\|') : padded;
  return `${fence}${body}${fence}`;
}

/** Markdown table cells cannot contain unescaped pipes — or raw HTML — or line breaks. */
export function tableCell(text: string): string {
  return text
    .replace(/\r?\n/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    // the backslash goes first: a literal `a\|b` must become `a\\|b` (escaped
    // backslash, then escaped pipe), not `a\` + a live column separator
    .replace(/([\\`![\]])/g, '\\$1')
    .replace(/\|/g, '\\|');
}

/**
 * Neutralizes HTML-significant characters while leaving markdown structure
 * alone — for prose lines built from untrusted content (risk rationales,
 * captured answers) where markdown-escaping would litter the output.
 *
 * "Structure alone" stops at the characters that make remote content live:
 * `![](` turns attacker-controlled text (a commit message excerpt, a file
 * path) into a tracking pixel or a forged link in the rendered book, and an
 * escaped `[` also kills reference-style link definitions. Backticks stay
 * readable on purpose — prose fields carry legitimate code spans built by the
 * renderer itself (see render/markdown.ts) — and a code span cannot form a
 * link or embed anything, only show text literally.
 */
export function escapeHtmlText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([\\![\]])/g, '\\$1');
}

/** Numeric character references outside Unicode are invalid — clamp instead of
 * letting String.fromCodePoint throw a RangeError that aborts the whole render. */
function fromCodePoint(code: number): string {
  return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '\uFFFD';
}

/**
 * Named entities that can produce a scheme colon or smuggle whitespace past a
 * URL check. Unknown named entities stay literal — without a decoded `:` they
 * cannot form a URL scheme, which is the only thing the scheme check cares
 * about. The lookup table has a null prototype: it is indexed by attacker-
 * chosen entity names, and on a normal object `&constructor;` / `&valueOf;`
 * would resolve to inherited properties and decode into function source text.
 */
const NAMED_ENTITIES: Record<string, string> = Object.assign(Object.create(null), {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  colon: ':',
  sol: '/',
  bsol: '\\',
  Tab: '\t',
  NewLine: '\n',
});

export function decodeHtmlEntities(value: string): string {
  const once = (input: string): string =>
    input
      .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => fromCodePoint(parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, dec: string) => fromCodePoint(Number(dec)))
      .replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (match, name: string) => NAMED_ENTITIES[name] ?? match);
  // double-encoded payloads ("&amp;#106;avascript:") need a second pass to be
  // recognizable as the scheme they really are
  let out = value;
  for (let i = 0; i < 3; i += 1) {
    const next = once(out);
    if (next === out) {
      break;
    }
    out = next;
  }
  return out;
}

/**
 * Scheme allowlist. A denylist after partial decoding cannot enumerate what
 * browsers accept (`javascript&colon;`, entity-encoded tabs inside the scheme
 * word…), so the check is inverted: after decoding entities and stripping the
 * whitespace/control bytes browsers drop from URLs, ANY explicit scheme is
 * rejected unless it is explicitly safe.
 */
export function isSafeUrl(decoded: string): boolean {
  const stripped = decoded.replace(/[\t\n\r\x00-\x20]/g, '').toLowerCase();
  const scheme = /^([a-z][a-z0-9+.-]*):/.exec(stripped);
  if (!scheme) {
    return true; // relative URL or fragment
  }
  return scheme[1] === 'http' || scheme[1] === 'https' || scheme[1] === 'mailto';
}

/** `<` starting a tag (or a comment/CDATA run) — the shape that becomes live markup. */
const MARKUP_START = /<(?=[\/!A-Za-z])/g;

/**
 * Rewrite the target of every `](…)` in model-generated markdown, dropping the
 * ones whose scheme is not http/https/mailto/relative.
 *
 * A regex cannot do this: markdown link targets may contain balanced parentheses
 * (`[a](b(c)d)`), and the target has to be *decoded* before its scheme can be
 * judged. So the span is scanned with a paren counter instead.
 */
function neutralizeLinkTargets(text: string): string {
  let out = '';
  let i = 0;
  for (;;) {
    const open = text.indexOf('](', i);
    if (open === -1) {
      out += text.slice(i);
      return out;
    }
    let depth = 1;
    let j = open + 2;
    while (j < text.length) {
      const ch = text[j]!;
      if (ch === '\\') {
        j += 2;
        continue;
      }
      if (ch === '(') {
        depth += 1;
      } else if (ch === ')') {
        depth -= 1;
        if (depth === 0) {
          break;
        }
      }
      j += 1;
    }
    if (depth !== 0) {
      // unterminated target — leave the rest of the text as it is
      out += text.slice(i);
      return out;
    }
    const raw = text.slice(open + 2, j);
    // an optional title follows the URL: `url "title"` | `url 'title'` | `url (title)`
    const withoutTitle = raw.replace(/\s+(?:"[^"]*"|'[^']*'|\([^)]*\))$/, '');
    const title = raw.slice(withoutTitle.length);
    const safe = isSafeUrl(decodeHtmlEntities(withoutTitle));
    out += text.slice(i, open + 2) + (safe ? raw : `#${title}`) + text[j]!;
    i = j + 1;
  }
}

/**
 * Reference-style link definitions (`[id]: target`) are the second way model
 * output can carry a live `javascript:` link into the .md book — the inline
 * `](…)` scanner cannot see them, because the target sits on a different line
 * than its use. Same allowlist, applied where the target is defined.
 */
const REF_DEFINITION = /^( {0,3}\[[^\]\n]+\]:[ \t]*)(<)?([^\s>]+)(>?)/gm;

function neutralizeReferenceDefinitions(text: string): string {
  return text.replace(
    REF_DEFINITION,
    (match, prefix: string, open: string | undefined, target: string, close: string | undefined) => {
      if (isSafeUrl(decodeHtmlEntities(target))) {
        return match;
      }
      return `${prefix}${open ?? ''}#${close ?? ''}`;
    },
  );
}

/**
 * Neutralize raw markup in LLM-generated chapter text before it is bound into
 * the markdown book.
 *
 * The HTML twin runs a full sanitizer over its output, but the `.md` file is
 * the primary artifact and is opened in editors, wikis and GitHub — where raw
 * HTML from the model is live. The chapter text is derived from untrusted
 * repository content (anyone who can open a PR against an analysed repo can
 * choose its title and body), so this is the injection path that does not go
 * through a browser at all.
 */
export function neutralizeGeneratedMarkup(text: string): string {
  // Reference definitions are rewritten before the `<` pass, while an
  // angle-bracketed target (`[id]: <url>`) is still distinguishable from text.
  return neutralizeLinkTargets(neutralizeReferenceDefinitions(text).replace(MARKUP_START, '&lt;'));
}
