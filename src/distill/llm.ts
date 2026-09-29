import type { HandoverConfig, LlmProviderName } from '../config.js';

export interface LlmProvider {
  name: LlmProviderName;
  model: string;
  complete(system: string, user: string): Promise<string>;
}

export class MissingCredentialError extends Error {}

const REQUEST_TIMEOUT_MS = 120_000;
const MAX_ATTEMPTS = 3;
let requestTimeoutMs = REQUEST_TIMEOUT_MS;

/** Set from HandoverConfig so the abort path is testable without waiting two minutes. */
export function setLlmRequestTimeout(ms: number | undefined): void {
  requestTimeoutMs = ms && ms > 0 ? ms : REQUEST_TIMEOUT_MS;
}
const BACKOFF_BASE_MS = 1_000;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Posts JSON with bounded retries on rate limits, transient 5xx and network
 * errors. The body is checked to be an object before it comes back: every caller
 * walks it with optional chaining, which reads properties off `null` and
 * primitives and throws an opaque TypeError — the exact failure mode this file
 * is meant to name.
 */
async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(requestTimeoutMs),
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
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed !== 'object' || parsed === null) {
          throw new Error(
            `provider at ${url} replied with a non-object body (HTTP ${response.status}): ${text.slice(0, 200)}`,
          );
        }
        return parsed;
      } catch (error) {
        // A 2xx with a non-JSON body (proxy page, HTML error) needs its own message.
        if (error instanceof SyntaxError) {
          throw new Error(`Unexpected non-JSON response from ${url} (HTTP ${response.status}): ${text.slice(0, 200)}`);
        }
        throw error;
      }
    }
    lastError = new Error(`${response.status} from ${url}: ${text.slice(0, 300)}`);
    if (!RETRYABLE_STATUSES.has(response.status) || attempt === MAX_ATTEMPTS) {
      break;
    }
    const retryAfter = Number(response.headers.get('retry-after'));
    // Cap Retry-After: a hostile or broken proxy must not stall the run for hours.
    await sleep(
      Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 60_000)
        : BACKOFF_BASE_MS * 2 ** attempt,
    );
  }
  throw lastError;
}

/**
 * A provider reply is untrusted input like a commit message is — an
 * `as { choices?: … }` cast only silences the compiler. A non-string `content`
 * reaches `.trim()` one layer up and throws there, which the chapter falls back
 * from, but the failure would be an opaque TypeError instead of a named shape
 * problem, and a hostile Enterprise endpoint could pick exactly that.
 */
function requireText(value: unknown, field: string): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value === undefined || value === null) {
    return '';
  }
  throw new Error(`provider returned ${field} of type ${Array.isArray(value) ? 'array' : typeof value}, expected text`);
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
      // OpenAI's content is a string for the models we call; array-part replies
      // are a shape we do not ask for and must not pretend to understand.
      const content = requireText(choice?.message?.content, 'choices[0].message.content');
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
        .filter((block) => block !== null && typeof block === 'object' && block.type === 'text')
        .map((block) => requireText(block.text, 'content[].text'))
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
      const content = requireText(data.message?.content, 'message.content');
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
  setLlmRequestTimeout(config.llmTimeoutMs);
  switch (config.provider) {
    case 'openai':
      return createOpenAiProvider(config);
    case 'anthropic':
      return createAnthropicProvider(config);
    case 'ollama':
      return createOllamaProvider(config);
  }
}
