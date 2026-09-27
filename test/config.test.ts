import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, DEFAULT_MODELS } from '../src/config.js';

const ENV_KEYS = ['GITHUB_TOKEN', 'HANDOVER_PROVIDER', 'HANDOVER_MODEL', 'HANDOVER_DATA_DIR', 'OLLAMA_URL'] as const;

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
});
