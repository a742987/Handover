import type { HandoverConfig, LlmProviderName } from '../config.js';

export interface LlmProvider {
  name: LlmProviderName;
  model: string;
  complete(system: string, user: string): Promise<string>;
}

export class MissingCredentialError extends Error {}

const REQUEST_TIMEOUT_MS = 120_000;

function parseBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${response.status} from ${url}: ${text.slice(0, 300)}`);
  }
  return JSON.parse(text) as unknown;
}

function createOpenAiProvider(config: HandoverConfig): LlmProvider {
  const apiKey = process.env['OPENAI_API_KEY'];
  if (!apiKey) {
    throw new MissingCredentialError('OPENAI_API_KEY is not set');
  }
  return {
    name: 'openai',
    model: config.model,
    async complete(system, user) {
      const data = (await postJson(
        'https://api.openai.com/v1/chat/completions',
        { authorization: `Bearer ${apiKey}` },
        {
          model: config.model,
          temperature: 0.2,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        },
      )) as { choices?: Array<{ message?: { content?: string } }> };
      return data.choices?.[0]?.message?.content ?? '';
    },
  };
}

function createAnthropicProvider(config: HandoverConfig): LlmProvider {
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) {
    throw new MissingCredentialError('ANTHROPIC_API_KEY is not set');
  }
  return {
    name: 'anthropic',
    model: config.model,
    async complete(system, user) {
      const data = (await postJson(
        'https://api.anthropic.com/v1/messages',
        { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        {
          model: config.model,
          max_tokens: 4096,
          temperature: 0.2,
          system,
          messages: [{ role: 'user', content: user }],
        },
      )) as { content?: Array<{ type?: string; text?: string }> };
      return (data.content ?? [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('');
    },
  };
}

function createOllamaProvider(config: HandoverConfig): LlmProvider {
  return {
    name: 'ollama',
    model: config.model,
    async complete(system, user) {
      const data = (await postJson(
        `${parseBaseUrl(config.ollamaUrl)}/api/chat`,
        {},
        {
          model: config.model,
          stream: false,
          options: { temperature: 0.2 },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        },
      )) as { message?: { content?: string } };
      return data.message?.content ?? '';
    },
  };
}

/** Builds the provider named by the config; throws MissingCredentialError when its key is absent. */
export function createProvider(config: HandoverConfig): LlmProvider {
  switch (config.provider) {
    case 'openai':
      return createOpenAiProvider(config);
    case 'anthropic':
      return createAnthropicProvider(config);
    case 'ollama':
      return createOllamaProvider(config);
  }
}
