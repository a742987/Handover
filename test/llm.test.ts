import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProvider, MissingCredentialError } from '../src/distill/llm.js';
import { loadConfig } from '../src/config.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('createProvider', () => {
  it('throws MissingCredentialError when the hosted provider key is absent', () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    expect(() => createProvider(loadConfig({ provider: 'openai' }))).toThrow(MissingCredentialError);
    expect(() => createProvider(loadConfig({ provider: 'anthropic' }))).toThrow(MissingCredentialError);
  });
});

describe('ollama provider', () => {
  const config = loadConfig({ provider: 'ollama', model: 'test-model', ollamaUrl: 'http://127.0.0.1:11434' });

  it('returns the message content from a successful chat response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ message: { content: 'hello from ollama' } }), { status: 200 })),
    );
    const provider = createProvider(config);
    await expect(provider.complete('system', 'user')).resolves.toBe('hello from ollama');
  });

  it('throws when the response was truncated (done_reason=length)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ message: { content: 'partial' }, done_reason: 'length' }), { status: 200 })),
    );
    await expect(createProvider(config).complete('system', 'user')).rejects.toThrow(/truncated/);
  });

  it('surfaces non-retryable HTTP errors with the status code', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad request', { status: 400 })));
    await expect(createProvider(config).complete('system', 'user')).rejects.toThrow(/400 from/);
  });

  it('retries a 429 once and then succeeds', async () => {
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(new Response('slow down', { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: { content: 'ok' } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(createProvider(config).complete('system', 'user')).resolves.toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  }, 10_000);
});
