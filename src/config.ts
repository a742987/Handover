export type LlmProviderName = 'openai' | 'anthropic' | 'ollama';

export interface HandoverConfig {
  githubToken: string;
  provider: LlmProviderName;
  model: string;
  ollamaUrl: string;
  /** directory holding the per-person SQLite index and the generated book */
  dataDir: string;
}

export const DEFAULT_MODELS: Record<LlmProviderName, string> = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-sonnet-4-5',
  ollama: 'llama3.2',
};

const PROVIDERS: readonly LlmProviderName[] = ['openai', 'anthropic', 'ollama'];

function env(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
}

export function loadConfig(overrides: Partial<HandoverConfig> = {}): HandoverConfig {
  const providerName: string = overrides.provider ?? env('HANDOVER_PROVIDER') ?? 'anthropic';
  if (!(PROVIDERS as readonly string[]).includes(providerName)) {
    throw new Error(`Unknown LLM provider "${providerName}" (expected one of: ${PROVIDERS.join(', ')})`);
  }
  const provider = providerName as LlmProviderName;
  return {
    githubToken: overrides.githubToken ?? env('GITHUB_TOKEN') ?? '',
    provider,
    model: overrides.model ?? env('HANDOVER_MODEL') ?? DEFAULT_MODELS[provider],
    ollamaUrl: env('OLLAMA_URL') ?? 'http://localhost:11434',
    dataDir: overrides.dataDir ?? env('HANDOVER_DATA_DIR') ?? 'handover-data',
  };
}
