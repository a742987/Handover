import type { HandoverConfig, LlmProviderName } from '../config.js';

export interface LlmProvider {
  name: LlmProviderName;
  model: string;
  complete(system: string, user: string): Promise<string>;
}

export class MissingCredentialError extends Error {}

const REQUEST_TIMEOUT_MS = 120_000;
const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 1_000;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Posts JSON with bounded retries on rate limits, transient 5xx and network errors. */
async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      lastError = error;
      if (attempt === MAX_ATTEMPTS) {
        break;
      }
      await sleep(BACKOFF_BASE_MS * 2 ** attempt);
      continue;
    }
    const text = await response.text();
    if (response.ok) {
      try {
        return JSON.parse(text) as unknown;
      } catch {
        // A 2xx with a non-JSON body (proxy page, HTML error) needs its own message.
        throw new Error(`Unexpected non-JSON response from ${url} (HTTP ${response.status}): ${text.slice(0, 200)}`);
      }
    }
    lastError = new Error(`${response.status} from ${url}: ${text.slice(0, 300)}`);
    if (!RETRYABLE_STATUSES.has(response.status) || attempt === MAX_ATTEMPTS) {
      break;
    }
    const retryAfter = Number(response.headers.get('retry-after'));
    await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : BACKOFF_BASE_MS * 2 ** attempt);
  }
  throw lastError;
}

function parseBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
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
      )) as { choices?: Array<{ message?: { content?: string }; finish_reason?: string }> };
      const choice = data.choices?.[0];
      const content = choice?.message?.content ?? '';
      // finish_reason === 'length' means the response hit the provider's cap — fail the
      // chapter so the caller falls back to deterministic synthesis with a clean reason.
      if (choice?.finish_reason === 'length') {
        throw new Error('OpenAI response was truncated (finish_reason=length) — shorten the input (the request sets no max_tokens, so only the provider default applies)');
      }
      return content;
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
          max_tokens: 8192,
          temperature: 0.2,
          system,
          messages: [{ role: 'user', content: user }],
        },
      )) as { content?: Array<{ type?: string; text?: string }>; stop_reason?: string };
      const content = (data.content ?? [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('');
      // stop_reason === 'max_tokens' means the response was truncated
      if (data.stop_reason === 'max_tokens') {
        throw new Error('Anthropic response was truncated (stop_reason=max_tokens) — increase max_tokens or shorten input');
      }
      return content;
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
      )) as { message?: { content?: string }; done_reason?: string };
      const content = data.message?.content ?? '';
      // done_reason === 'length' means the response was truncated
      if (data.done_reason === 'length') {
        throw new Error('Ollama response was truncated (done_reason=length) — shorten the input (the request sets no num_predict, so only the model default applies)');
      }
      return content;
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
