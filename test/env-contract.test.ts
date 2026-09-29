import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

/**
 * `.env.example` is the only place this tool's environment contract is written
 * down, and it is documentation nobody executes: a variable can be read by the
 * code and absent from the file (an invisible knob), or listed in the file and
 * read by nothing (a promise that does not exist — which is exactly how
 * `HANDOVER_NO_LLM` ended up described as working in eleven translated READMEs
 * while no code read it). This pins the two sets against each other.
 *
 * The comparison is limited to this tool's own variable namespaces on purpose:
 * the runtime reads nothing else that matters here, and an allow-list that grows
 * to accommodate unrelated variables stops being a contract.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OWN_NAMESPACE = /^(HANDOVER_|GITHUB_|OLLAMA_|OPENAI_API_KEY$|ANTHROPIC_API_KEY$)/;

/** Documented, deliberately not read. Each entry needs a reason, not just a name. */
const INTENTIONALLY_INERT = new Map<string, string>([
  // the 0.1.2-era explicit-on spelling for redaction, which is the default now;
  // the file and every translation say it is redundant, and reading it could only
  // mean letting it outrank the documented opt-out
  ['HANDOVER_REDACT', 'legacy explicit-on spelling; redaction is on by default'],
]);

function sourceFiles(dir: string, into: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      sourceFiles(full, into);
    } else if (entry.name.endsWith('.ts')) {
      into.push(full);
    }
  }
  return into;
}

function varsReadByCode(): Set<string> {
  const pattern = /(?:env|truthy|envNumber)\(\s*'([A-Z][A-Z0-9_]+)'|process\.env\.([A-Z][A-Z0-9_]+)|process\.env\['([A-Z][A-Z0-9_]+)'\]/g;
  const found = new Set<string>();
  for (const file of sourceFiles(path.join(root, 'src'))) {
    for (const match of readFileSync(file, 'utf8').matchAll(pattern)) {
      const name = match[1] ?? match[2] ?? match[3];
      if (name && OWN_NAMESPACE.test(name)) {
        found.add(name);
      }
    }
  }
  return found;
}

function varsDocumented(): Set<string> {
  const text = readFileSync(path.join(root, '.env.example'), 'utf8');
  const found = new Set<string>();
  for (const match of text.matchAll(/^\s*#?\s*([A-Z][A-Z0-9_]{2,})\s*=/gm)) {
    const name = match[1];
    if (name && OWN_NAMESPACE.test(name)) {
      found.add(name);
    }
  }
  return found;
}

describe('the environment contract in .env.example', () => {
  it('documents every variable the code reads', () => {
    const undocumented = [...varsReadByCode()].filter((name) => !varsDocumented().has(name));
    expect(undocumented).toEqual([]);
  });

  it('reads every variable it documents, except the ones declared inert here', () => {
    const unread = [...varsDocumented()].filter((name) => !varsReadByCode().has(name) && !INTENTIONALLY_INERT.has(name));
    expect(unread).toEqual([]);
  });

  it('keeps the inert list honest — a variable that starts being read must be removed from it', () => {
    const read = varsReadByCode();
    const stale = [...INTENTIONALLY_INERT.keys()].filter((name) => read.has(name));
    expect(stale).toEqual([]);
  });

  it('actually honours the off-switches it promises', () => {
    // the contract test above proves the name exists in both places; this proves
    // the two switches that matter for data leaving the machine behave as the
    // documentation describes, with the off-switch winning when both are set
    const saved = ['HANDOVER_LLM', 'HANDOVER_NO_LLM', 'HANDOVER_NO_REDACT', 'HANDOVER_REDACT'];
    const previous = saved.map((name) => [name, process.env[name]] as const);
    for (const name of saved) delete process.env[name];
    try {
      process.env.HANDOVER_LLM = '1';
      process.env.HANDOVER_NO_LLM = '1';
      expect(loadConfig().noLlm).toBe(true);
      delete process.env.HANDOVER_NO_LLM;
      expect(loadConfig().noLlm).toBe(false);
      process.env.HANDOVER_NO_REDACT = '1';
      process.env.HANDOVER_REDACT = '1';
      expect(loadConfig().redact).toBe(false);
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});
