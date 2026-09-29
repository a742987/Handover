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

describe('a provider reply is validated, not cast', () => {
  // `as { choices?: … }` silenced the compiler but checked nothing; the endpoint
  // (a GitHub Enterprise relay, a local Ollama, a proxy returning HTML) is as
  // untrusted as a commit message. A malformed reply must read as a named shape
  // problem that falls the chapter back, not as a TypeError from `.trim()`.
  const cases: Array<[string, Record<string, unknown>]> = [
    ['openai content as a part array', { choices: [{ message: { content: [{ type: 'text', text: 'hi' }] } }] }],
    ['openai content as a number', { choices: [{ message: { content: 17 } }] }],
    ['openai content as an object', { choices: [{ message: { content: { evil: true } } }] }],
  ];

  it.each(cases)('rejects %s instead of throwing a TypeError', async (_label, body) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');
    const provider = createProvider(loadConfig({ provider: 'openai' }));
    await expect(provider.complete('system', 'user')).rejects.toThrow(/expected text/);
  });

  it('accepts the null and missing shapes as empty text (a filtered reply)', async () => {
    for (const body of [{ choices: [{ message: { content: null } }] }, { choices: [{ message: {} }] }, { choices: [] }]) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
      vi.stubEnv('OPENAI_API_KEY', 'sk-test');
      const provider = createProvider(loadConfig({ provider: 'openai' }));
      // empty results are then rejected by the chapter's length floor, not by a crash
      await expect(provider.complete('system', 'user')).resolves.toBe('');
    }
  });

  it('rejects an Anthropic content block whose text is not a string', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ content: [{ type: 'text', text: { a: 1 } }] }), { status: 200 })),
    );
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test');
    const provider = createProvider(loadConfig({ provider: 'anthropic' }));
    await expect(provider.complete('system', 'user')).rejects.toThrow(/expected text/);
  });

  it('rejects an Ollama message whose content is an array', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ message: { content: ['a', 'b'] } }), { status: 200 })),
    );
    const config = loadConfig({ provider: 'ollama', model: 'test-model', ollamaUrl: 'http://127.0.0.1:11434' });
    await expect(createProvider(config).complete('system', 'user')).rejects.toThrow(/expected text/);
  });

  it('rejects a reply whose whole body is not an object', async () => {
    // Optional chaining reads properties off null and primitives, so `null` used
    // to reach `data.message` and die with a TypeError at the far end of the call.
    for (const body of ['null', '42', '"just a string"', 'true']) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })));
      const config = loadConfig({ provider: 'ollama', model: 'test-model', ollamaUrl: 'http://127.0.0.1:11434' });
      await expect(createProvider(config).complete('system', 'user')).rejects.toThrow(/non-object body/);
    }
  });

  it('tolerates a null entry inside an Anthropic content array', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ content: [null, 'bare string', { type: 'text', text: 'kept' }] }), { status: 200 })),
    );
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test');
    const provider = createProvider(loadConfig({ provider: 'anthropic' }));
    await expect(provider.complete('system', 'user')).resolves.toBe('kept');
  });
});
