import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The model-facing instructions — `codex/handover.md` and the plugin skill — are
 * what an agent actually reads. A stale flag or a missing command there does not
 * fail a build; it quietly changes what an agent does with someone's data, which
 * is the class of defect the audit's own environment-contract test was written
 * for. This applies the same idea one layer up: the documented surface and the
 * real surface are compared, in both directions.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string): string => readFileSync(path.join(root, relative), 'utf8');

const cliSource = read('src/cli.ts');
const agentDocs = ['codex/handover.md', 'plugin/skills/handover/SKILL.md', 'plugin/commands/gen.md', 'plugin/commands/risk.md'];

/** Commands the CLI actually registers. */
function realCommands(): Set<string> {
  return new Set([...cliSource.matchAll(/\.command\('([a-z-]+)/g)].map((match) => match[1] as string));
}

/** Every option token the CLI declares, e.g. `-r, --repo <repo...>` → both names. */
function realOptions(): Set<string> {
  const names = new Set<string>();
  // `.option(...)` and `.requiredOption(...)` on the command, plus the
  // `new Option(...)` form the grouped safety flags use
  const pattern = /\.(?:required)?[oO]ption\('([^']+)'|new Option\(\s*'([^']+)'/g;
  for (const match of cliSource.matchAll(pattern)) {
    for (const token of (match[1] ?? match[2] ?? '').split(/[ ,]+/)) {
      if (token.startsWith('-')) {
        names.add(token.replace(/[<[].*$/, ''));
      }
    }
  }
  return names;
}

function documentedText(): string {
  return agentDocs.map(read).join('\n');
}

describe('the agent-facing instructions match the real CLI', () => {
  it('documents every command the CLI offers', () => {
    const missing = [...realCommands()].filter((command) => !new RegExp(`handover ${command}\\b`).test(documentedText()));
    // an undocumented command is invisible to every agent session, which is how
    // `verify` — the tool's own evidence check — went missing from both files
    expect(missing, `undocumented commands: ${missing.join(', ')}`).toEqual([]);
  });

  it('invents no command that the CLI does not have', () => {
    const invented = [...documentedText().matchAll(/handover ([a-z-]+)\b/g)]
      .map((match) => match[1] as string)
      .filter((word) => !realCommands().has(word) && !['install', 'i', 'mcp'].includes(word));
    expect(invented).toEqual([]);
  });

  it('invents no flag that the CLI does not accept', () => {
    const options = realOptions();
    const documented = [...documentedText().matchAll(/(--[a-z-]+|-r|-d)\b/g)].map((match) => match[1] as string);
    const invented = [...new Set(documented)].filter((flag) => !options.has(flag));
    expect(invented, `flags documented but not implemented: ${invented.join(', ')}`).toEqual([]);
  });

  it('keeps the two promises that decide whether data leaves the machine', () => {
    const text = documentedText();
    // both files must say synthesis is opt-in, and neither may claim a GitHub
    // token is required to read a public repository — the second one sends
    // agents asking for credentials they do not need
    expect(text).toMatch(/opt-in|opt in/i);
    expect(text).not.toMatch(/GITHUB_TOKEN must be set/i);
    expect(text).toMatch(/60 requests\/hour|without a token|no token/i);
  });
});

/**
 * The translated READMEs are hand-maintained copies, so they drift in the quiet
 * direction: nine of them documented `--no-llm` and never `--use-llm`, which
 * leaves a reader with an off-switch for a feature they cannot find out how to
 * turn on — and one of them said a key in the environment was what decided it.
 * Flag names are code tokens, so this check needs no translation to enforce.
 */
describe('the translated READMEs keep the switches discoverable', () => {
  const readmes = [
    'README.md',
    'README.ar.md',
    'README.de.md',
    'README.es.md',
    'README.fr.md',
    'README.ja.md',
    'README.mn.md',
    'README.ru.md',
    'README.zh-CN.md',
    'README.zh-TW.md',
  ];

  it('mentions the opt-in wherever it mentions the opt-out', () => {
    const missing = readmes
      .map((file) => ({ file, text: readFileSync(path.join(root, file), 'utf8') }))
      .filter(({ text }) => text.includes('--no-llm') && !text.includes('--use-llm'))
      .map(({ file }) => file);
    expect(missing).toEqual([]);
  });

  it('never claims a GitHub token is required to read the network', () => {
    // the accurate form is "a token raises the rate limit / unlocks private repos";
    // "requires a token" is what every README said before the anonymous path was run
    const forbidden = /(requires? a github token|github token.*(is )?required|must be set for anything that touches github|需要 github token)/i;
    const offenders = readmes
      .filter((file) => forbidden.test(readFileSync(path.join(root, file), 'utf8')))
      .concat(agentDocs.filter((file) => forbidden.test(readFileSync(path.join(root, file), 'utf8'))));
    expect(offenders).toEqual([]);
  });

  it('documents every command in every language', () => {
    // the commands are the product's surface; a translation that lists seven of
    // eight leaves a reader who never learns `verify` or `gate` exists
    const commands = [...realCommands()];
    const gaps: string[] = [];
    for (const file of readmes) {
      const text = readFileSync(path.join(root, file), 'utf8');
      for (const command of commands) {
        const documented = new RegExp(`\`${command}( \\S*)?\\s*<username>|handover ${command}\\b`).test(text);
        if (!documented) {
          gaps.push(`${file} → ${command}`);
        }
      }
    }
    expect(gaps).toEqual([]);
  });

  it('documents the weakening switch wherever it documents the strengthening one', () => {
    const missing = readmes
      .filter((file) => {
        const text = readFileSync(path.join(root, file), 'utf8');
        return text.includes('--redact') && !text.includes('--no-redact');
      })
      .concat(
        agentDocs.filter((file) => {
          const text = readFileSync(path.join(root, file), 'utf8');
          return text.includes('--redact') && !text.includes('--no-redact');
        }),
      );
    expect(missing).toEqual([]);
  });

  it('carries the env spelling the CLI itself names for every safety override', () => {
    // A token-presence rule was not enough: nine translated READMEs listed
    // `--no-redact` as a bare flag while describing `--redact` as something you turn
    // on, which reads as "secrets are copied into the book unless you opt in" — the
    // opposite of the default. So the requirement is taken from the CLI's own help
    // string, where each override in the safety group spells its environment form.
    const grouped = [...cliSource.matchAll(/new Option\(\s*'(--[a-z-]+)',\s*'([^']+)'[^)]*\)\s*\.helpGroup\(SAFETY_OVERRIDE_HEADING\)/gs)];
    const overrides = new Map<string, string>();
    for (const [, flag, help] of grouped) {
      const envName = help?.match(/\(or (HANDOVER_[A-Z_]+)(?:=1)?\)/)?.[1];
      if (flag !== undefined && envName !== undefined) {
        overrides.set(flag, envName);
      }
    }
    // both members of the group are expected to name an env spelling, or this test
    // would silently pass on an empty list
    expect([...overrides.keys()].sort(), `unexpected safety-override parsing: ${[...overrides.keys()]}`).toEqual(['--no-redact', '--use-llm']);
    const gaps: string[] = [];
    for (const file of [...readmes, ...agentDocs]) {
      const text = readFileSync(path.join(root, file), 'utf8');
      for (const [flag, envName] of overrides) {
        if (text.includes(flag) && !text.includes(envName)) {
          gaps.push(`${file} → ${flag} without ${envName}`);
        }
      }
    }
    expect(gaps).toEqual([]);
  });

  it('sends every reader to the complete variable inventory', () => {
    // .env.example is contract-tested against the code (test/env-contract.test.ts),
    // so a link to it is the one way a translated README can carry the full list
    // without anyone having to translate it. The per-command plugin snippets are
    // deliberately excluded: they show one command each.
    const inventoryDocs = [...readmes, 'codex/handover.md', 'plugin/skills/handover/SKILL.md'];
    const missing = inventoryDocs.filter((file) => !readFileSync(path.join(root, file), 'utf8').includes('.env.example'));
    expect(missing).toEqual([]);
  });

  it('lists every MCP tool in every README', () => {
    // tool names are code tokens, so this needs no translation — and it pins the
    // exact gap that shipped before: the READMEs said "six tools" and never
    // mentioned handover_verify, while the server registered seven
    const mcpSource = read('src/mcp.ts');
    const tools = [...mcpSource.matchAll(/registerTool\(\s*'([a-z_]+)'/g)].map((match) => match[1] as string);
    expect(tools.length, 'no MCP tools parsed from src/mcp.ts — the check reads nothing').toBeGreaterThan(0);
    const gaps: string[] = [];
    for (const file of readmes) {
      const text = readFileSync(path.join(root, file), 'utf8');
      const missing = tools.filter((tool) => !text.includes(tool));
      if (missing.length > 0) {
        gaps.push(`${file} → ${missing.join(', ')}`);
      }
    }
    expect(gaps).toEqual([]);
  });

  it('keeps the plugin skill from repeating credential values back to a model', () => {
    const skill = readFileSync('plugin/skills/handover/SKILL.md', 'utf8');
    expect(skill).toMatch(/never echo|may not be echoed|do not echo|never.*echo/i);
  });

  it('points its links at files that exist', () => {
    // the translations now link back to the English README for the safety detail
    // each of them cannot restate reliably, so a dead relative link would be the
    // one instruction every reader follows
    const targets = [...readmes, ...agentDocs, 'docs/install-verification.md', 'SECURITY.md', 'CONTRIBUTING.md'];
    const broken: string[] = [];
    for (const file of targets) {
      const dir = path.dirname(path.join(root, file));
      for (const match of readFileSync(path.join(root, file), 'utf8').matchAll(/\]\(([^)\s#]+)(?:#[^)]*)?\)/g)) {
        const href = match[1] ?? '';
        // query strings are the hosting convention (`../../issues/new?template=…`),
        // not a path that exists in the tree — every other target must
        if (/^(https?:|mailto:)/.test(href) || href.includes('?')) {
          continue;
        }
        if (!existsSync(path.resolve(dir, href))) {
          broken.push(`${file} → ${href}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it('opens issues against templates that exist', () => {
    // the link rule above skips query strings, because `…/issues/new?template=x.yml`
    // is a hosting convention — but the template file it names is still ours to ship.
    // This scans CHANGELOG.md too, so prose that *describes* the pattern has to write
    // it as `<name>.yml`: a literal placeholder filename is read as a real one.
    const wanted = new Set<string>();
    for (const file of [...readmes, ...agentDocs, 'docs/install-verification.md', 'SECURITY.md', 'CONTRIBUTING.md', 'CHANGELOG.md']) {
      for (const match of readFileSync(path.join(root, file), 'utf8').matchAll(/template=([\w-]+\.yml)/g)) {
        wanted.add(match[1] as string);
      }
    }
    const missing = [...wanted].filter((name) => !existsSync(path.join(root, '.github', 'ISSUE_TEMPLATE', name)));
    expect(wanted.size, 'no template is referenced anywhere, so this check reads nothing').toBeGreaterThan(0);
    expect(missing, `referenced but not shipped under .github/ISSUE_TEMPLATE/ — or a placeholder written as a real filename`).toEqual([]);
  });
});
