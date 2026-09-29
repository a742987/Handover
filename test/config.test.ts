import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sep } from 'node:path';
import { confineDataDir, confineGitDir, loadConfig, DEFAULT_MODELS } from '../src/config.js';

const ENV_KEYS = [
  'GITHUB_TOKEN',
  'GITHUB_API_URL',
  'HANDOVER_GHE_HOST',
  'HANDOVER_PROVIDER',
  'HANDOVER_MODEL',
  'HANDOVER_DATA_DIR',
  'HANDOVER_REDACT',
  'HANDOVER_NO_REDACT',
  'HANDOVER_NO_LLM',
  'HANDOVER_LLM',
  'OLLAMA_URL',
  'HANDOVER_DATA_ROOT',
  'HANDOVER_GIT_ROOT',
] as const;

function withEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>, run: () => void): void {
  const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  try {
    for (const key of ENV_KEYS) {
      delete process.env[key];
    }
    for (const [key, value] of Object.entries(values)) {
      process.env[key] = value;
    }
    run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

afterEach(() => {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
});

describe('loadConfig', () => {
  it('applies documented defaults', () => {
    withEnv({}, () => {
      const config = loadConfig();
      expect(config.provider).toBe('anthropic');
      expect(config.model).toBe(DEFAULT_MODELS.anthropic);
      expect(config.dataDir).toBe('handover-data');
      expect(config.ollamaUrl).toBe('http://localhost:11434');
      // both safety defaults: nothing uploaded, secrets scrubbed
      expect(config.noLlm).toBe(true);
      expect(config.redact).toBe(true);
    });
  });

  it('rejects an unknown provider with the valid names listed', () => {
    withEnv({ HANDOVER_PROVIDER: 'gemini' }, () => {
      expect(() => loadConfig()).toThrow(/openai, anthropic, ollama/);
    });
  });

  it('respects environment variables and overrides', () => {
    withEnv({ GITHUB_TOKEN: 'tok', HANDOVER_PROVIDER: 'ollama', HANDOVER_DATA_DIR: 'elsewhere' }, () => {
      const config = loadConfig({ dataDir: 'cli-flag', model: 'llama3.1' });
      expect(config.githubToken).toBe('tok');
      expect(config.provider).toBe('ollama');
      expect(config.dataDir).toBe('cli-flag'); // override beats env
      expect(config.model).toBe('llama3.1');
    });
  });

  it('keeps redaction on by default and lets it be turned off explicitly', () => {
    withEnv({ HANDOVER_NO_REDACT: '1' }, () => {
      expect(loadConfig().redact).toBe(false);
      expect(loadConfig({ redact: true }).redact).toBe(true); // override beats env
    });
    withEnv({ HANDOVER_REDACT: '1' }, () => {
      // the legacy explicit-on spelling: accepted, and no longer changes anything —
      // which is the same observable result as the default, so the assertion that
      // carries information is the one below
      expect(loadConfig().redact).toBe(true);
    });
    withEnv({ HANDOVER_REDACT: '0' }, () => {
      // a legacy spelling nobody documented as an off-switch cannot become one:
      // only HANDOVER_NO_REDACT changes this, in one direction
      expect(loadConfig().redact).toBe(true);
    });
    withEnv({ HANDOVER_REDACT: '1', HANDOVER_NO_REDACT: '1' }, () => {
      // both set: the documented opt-out wins
      expect(loadConfig().redact).toBe(false);
    });
    withEnv({}, () => {
      expect(loadConfig().redact).toBe(true);
    });
  });

  it('treats LLM synthesis as an opt-in', () => {
    withEnv({ HANDOVER_LLM: '1' }, () => {
      expect(loadConfig().noLlm).toBe(false);
      expect(loadConfig({ noLlm: true }).noLlm).toBe(true); // an explicit off wins
    });
    withEnv({ HANDOVER_NO_LLM: '1' }, () => {
      expect(loadConfig().noLlm).toBe(true);
      expect(loadConfig({ noLlm: false }).noLlm).toBe(false);
    });
    withEnv({ HANDOVER_NO_LLM: '1', HANDOVER_LLM: '1' }, () => {
      // the case that gives the 0.1.2-era off-switch meaning: an inherited
      // "stay offline" is never outranked by an opt-in sitting in the same
      // environment. Without the off-switch being read, this uploads.
      expect(loadConfig().noLlm).toBe(true);
    });
    withEnv({ HANDOVER_NO_LLM: '0', HANDOVER_LLM: '1' }, () => {
      // only a set value counts as "asked to stay off"; HANDOVER_NO_LLM=0 is not a
      // way to force synthesis on without --use-llm
      expect(loadConfig().noLlm).toBe(false);
    });
    withEnv({}, () => {
      // the regression this guards: a developer who exports ANTHROPIC_API_KEY for
      // other tooling used to have their repositories uploaded by `handover gen`
      expect(loadConfig().noLlm).toBe(true);
    });
  });

  it('only accepts an https GitHub API base on an allowed host', () => {
    withEnv({ GITHUB_API_URL: 'https://api.github.com' }, () => {
      expect(loadConfig().githubApiUrl).toBe('https://api.github.com');
    });
    withEnv({ GITHUB_API_URL: 'http://api.github.com' }, () => {
      expect(() => loadConfig()).toThrow(/must use https/);
    });
    withEnv({ GITHUB_API_URL: 'https://evil.example/intercept' }, () => {
      expect(() => loadConfig()).toThrow(/HANDOVER_GHE_HOST/);
    });
    withEnv({ GITHUB_API_URL: 'https://ghe.example.com/api/v3', HANDOVER_GHE_HOST: 'ghe.example.com' }, () => {
      expect(loadConfig().githubApiUrl).toBe('https://ghe.example.com/api/v3');
    });
    withEnv({ GITHUB_API_URL: 'https://user:pass@api.github.com' }, () => {
      expect(() => loadConfig()).toThrow(/must not embed credentials/);
    });
    withEnv({}, () => {
      expect(loadConfig().githubApiUrl).toBeUndefined();
    });
  });

  it('compares the host with its port, so a hostname match cannot launder one', () => {
    // hostname matching alone waved https://api.github.com:8443/ through — the
    // token's destination port was never covered by the allow-list
    withEnv({ GITHUB_API_URL: 'https://api.github.com:8443' }, () => {
      expect(() => loadConfig()).toThrow(/HANDOVER_GHE_HOST/);
    });
    withEnv({ GITHUB_API_URL: 'https://api.github.com:443' }, () => {
      expect(loadConfig().githubApiUrl).toBe('https://api.github.com');
    });
    withEnv({ GITHUB_API_URL: 'https://ghe.example.com:8443/api/v3', HANDOVER_GHE_HOST: 'ghe.example.com:8443' }, () => {
      expect(loadConfig().githubApiUrl).toBe('https://ghe.example.com:8443/api/v3');
    });
    withEnv({ GITHUB_API_URL: 'https://ghe.example.com:8443/api/v3', HANDOVER_GHE_HOST: 'ghe.example.com' }, () => {
      expect(() => loadConfig()).toThrow(/HANDOVER_GHE_HOST/);
    });
  });
});

describe('confineDataDir — the MCP server\'s model-supplied path argument', () => {
  const root = process.cwd();
  const join = (...parts: string[]) => parts.join(sep);

  it('accepts the root itself and anything below it', () => {
    expect(confineDataDir('handover-data', [root])).toBe(join(root, 'handover-data'));
    expect(confineDataDir(join(root, 'a', 'b'), [root])).toBe(join(root, 'a', 'b'));
  });

  it('rejects traversal out of the root and sibling-prefix look-alikes', () => {
    expect(() => confineDataDir('../elsewhere', [root])).toThrow(/outside the permitted roots/);
    expect(() => confineDataDir(join(root, 'handover-data', '..', '..', 'x'), [root])).toThrow(/outside/);
    // <root>-evil is NOT inside <root>
    expect(() => confineDataDir(`${root}-evil`, [root])).toThrow(/outside/);
    expect(() => confineDataDir(join(root, '..'), [root])).toThrow(/outside/);
  });

  it('rejects a NUL byte rather than letting the platform truncate the path', () => {
    expect(() => confineDataDir('handover-data\0.png', [root])).toThrow(/NUL/);
  });

  it('honours an extra operator-configured root', () => {
    const extra = path.join(path.dirname(root), 'handover-allowed-root');
    mkdirSync(extra, { recursive: true });
    try {
      withEnv({ HANDOVER_DATA_ROOT: extra }, () => {
        expect(confineDataDir(path.join(extra, 'idx'))).toBe(path.join(extra, 'idx'));
        expect(() => confineDataDir(path.join(path.dirname(extra), 'not-allowed'))).toThrow(/outside/);
      });
    } finally {
      rmSync(extra, { recursive: true, force: true });
    }
  });

  it('resolves a symlink or junction before the check, so one cannot launder a path out', () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'handover-outside-'));
    const inside = path.join(root, 'handover-junction-test');
    symlinkSync(outside, inside, process.platform === 'win32' ? 'junction' : 'dir');
    try {
      // the literal path sits under the root; its destination does not
      expect(() => confineDataDir(inside, [root])).toThrow(/outside/);
      expect(() => confineDataDir(path.join(inside, 'deeper'), [root])).toThrow(/outside/);
    } finally {
      rmSync(inside, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("confineGitDir — the MCP server's model-supplied clone paths", () => {
  const root = process.cwd();
  const join = (...parts: string[]) => parts.join(sep);

  it('accepts a clone below an allowed root', () => {
    expect(confineGitDir('some-clone', [root])).toBe(join(root, 'some-clone'));
    expect(confineGitDir(join(root, 'work', 'repo'), [root])).toBe(join(root, 'work', 'repo'));
  });

  it('refuses traversal out of the root and sibling-prefix look-alikes', () => {
    expect(() => confineGitDir('../elsewhere', [root])).toThrow(/outside the permitted roots/);
    expect(() => confineGitDir(`${root}-evil`, [root])).toThrow(/outside/);
    expect(() => confineGitDir(join(root, '..', 'elsewhere'), [root])).toThrow(/outside/);
  });

  it('rejects a NUL byte rather than letting the platform truncate the path', () => {
    expect(() => confineGitDir('clone\0.png', [root])).toThrow(/NUL/);
  });

  it('honours HANDOVER_GIT_ROOT for clones that live outside the workspace', () => {
    const extra = path.join(path.dirname(root), 'handover-git-root');
    mkdirSync(extra, { recursive: true });
    try {
      withEnv({ HANDOVER_GIT_ROOT: extra }, () => {
        expect(confineGitDir(path.join(extra, 'repo'))).toBe(path.join(extra, 'repo'));
        expect(() => confineGitDir(path.join(path.dirname(extra), 'not-allowed'))).toThrow(/outside/);
      });
    } finally {
      rmSync(extra, { recursive: true, force: true });
    }
  });

  it('resolves a junction before the check, so a link cannot point at a clone outside', () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'handover-clone-outside-'));
    const inside = path.join(root, 'handover-clone-junction-test');
    symlinkSync(outside, inside, process.platform === 'win32' ? 'junction' : 'dir');
    try {
      expect(() => confineGitDir(inside, [root])).toThrow(/outside/);
    } finally {
      rmSync(inside, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
