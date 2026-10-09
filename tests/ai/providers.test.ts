import { afterEach, describe, expect, it } from 'vitest';

import { loadEnv } from '../../src/config/env';
import { createAiProvider, createFakeProvider, createOpenAiProvider } from '../../src/core/ai';
import { AppError } from '../../src/shared/errors/app-error';
import { json, useStubServer } from '../helpers/stub-server';

const stub = useStubServer();
afterEach(() => stub.reset());

const sleeps: number[] = [];
const provider = () =>
  createOpenAiProvider({
    apiKey: 'sk-test-not-real',
    baseUrl: `${stub.url}/v1/`,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });
const chatRequest = {
  model: 'gpt-4.1-mini',
  temperatureTenths: 6,
  maxOutputTokens: 300,
  messages: [
    { role: 'system' as const, content: 'You are helpful.' },
    { role: 'user' as const, content: 'maine pay kar diya' },
    {
      role: 'assistant' as const,
      content: '',
      toolCalls: [{ id: 'c1', name: 'check_payment_status', arguments: '{}' }],
    },
    { role: 'tool' as const, toolCallId: 'c1', content: '{"status":"paid"}' },
  ],
  tools: [
    {
      name: 'check_payment_status',
      description: 'Checks the payment',
      parameters: {
        type: 'object' as const,
        properties: {},
        required: [],
        additionalProperties: false as const,
      },
    },
  ],
};
const chatOk = (message: object, finish = 'stop') =>
  json(200, {
    choices: [{ message, finish_reason: finish }],
    usage: { prompt_tokens: 120, completion_tokens: 30 },
  });

describe('OpenAI provider', () => {
  it('sends chat with tools and maps text replies', async () => {
    stub.next(chatOk({ content: 'Dhanyavaad!' }));
    const result = await provider().chat(chatRequest);
    expect(result).toEqual({
      content: 'Dhanyavaad!',
      toolCalls: [],
      usage: { inputTokens: 120, outputTokens: 30 },
      finishReason: 'stop',
    });
    const req = stub.requests[0];
    expect(req?.url).toBe('/v1/chat/completions');
    expect(req?.headers.authorization).toBe('Bearer sk-test-not-real');
    const body = JSON.parse(req?.body ?? '{}') as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'gpt-4.1-mini',
      temperature: 0.6,
      max_completion_tokens: 300,
      tool_choice: 'auto',
      tools: [{ type: 'function', function: { name: 'check_payment_status' } }],
    });
    expect(body.messages).toEqual([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'maine pay kar diya' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'c1',
            type: 'function',
            function: { name: 'check_payment_status', arguments: '{}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', content: '{"status":"paid"}' },
    ]);
  });

  it('maps tool calls and other finish reasons; omits tools when none', async () => {
    stub.next(
      chatOk(
        {
          content: null,
          tool_calls: [
            {
              id: 't1',
              type: 'function',
              function: { name: 'end_call', arguments: '{"reason":"x"}' },
            },
          ],
        },
        'tool_calls',
      ),
      json(200, { choices: [{ message: { content: 'cut' }, finish_reason: 'content_filter' }] }),
    );
    const tools = await provider().chat(chatRequest);
    expect(tools.toolCalls).toEqual([{ id: 't1', name: 'end_call', arguments: '{"reason":"x"}' }]);
    expect(tools.finishReason).toBe('tool_calls');
    const other = await provider().chat({ ...chatRequest, tools: [] });
    expect(other).toMatchObject({
      content: 'cut',
      finishReason: 'other',
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    expect(JSON.parse(stub.requests[1]?.body ?? '{}')).not.toHaveProperty('tools');
  });

  it('retries 429 with Retry-After and 5xx with backoff, then gives up as unavailable', async () => {
    sleeps.length = 0;
    stub.next(json(429, {}, { 'retry-after': '1' }), chatOk({ content: 'ok' }));
    await expect(provider().chat(chatRequest)).resolves.toMatchObject({ content: 'ok' });
    expect(sleeps).toEqual([1000]);
    sleeps.length = 0;
    stub.next(json(500, {}), json(502, {}), json(503, {}));
    const err = await provider()
      .chat(chatRequest)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      status: 503,
      details: [{ path: 'provider', message: 'openai 503' }],
    });
    expect(sleeps).toEqual([500, 2000]);
    expect(String((err as Error).message)).not.toContain('sk-test');
  });

  it('caps Retry-After and ignores a bad one', async () => {
    sleeps.length = 0;
    stub.next(
      json(429, {}, { 'retry-after': '120' }),
      json(429, {}, { 'retry-after': 'soon' }),
      chatOk({ content: 'ok' }),
    );
    await provider().chat(chatRequest);
    expect(sleeps).toEqual([10_000, 2000]);
  });

  it('does not retry rejected requests and reports malformed answers', async () => {
    stub.next(json(401, { error: { message: 'bad key' } }));
    await expect(provider().chat(chatRequest)).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      status: 502,
    });
    expect(stub.requests).toHaveLength(1);
    stub.next((_q, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{not json');
    });
    await expect(provider().chat(chatRequest)).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      details: [{ message: 'openai invalid_json' }],
    });
    stub.next(json(200, { choices: [] }));
    await expect(provider().chat(chatRequest)).rejects.toMatchObject({
      details: [{ message: 'openai no_choice' }],
    });
  });

  it('treats network failures and timeouts as unavailable', async () => {
    const down = createOpenAiProvider({
      apiKey: 'k',
      baseUrl: 'http://127.0.0.1:9',
      sleep: () => Promise.resolve(),
    });
    await expect(down.chat(chatRequest)).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      details: [{ message: 'openai network' }],
    });
    const slow = createOpenAiProvider({
      apiKey: 'k',
      baseUrl: stub.url,
      sleep: () => Promise.resolve(),
      timeoutsMs: { chat: 50, embed: 50 },
    });
    stub.always((_q, res) => {
      setTimeout(() => res.writeHead(200).end('{}'), 300);
    });
    await expect(slow.chat(chatRequest)).rejects.toMatchObject({
      details: [{ message: 'openai timeout' }],
    });
    stub.always(null);
    const controller = new AbortController();
    controller.abort();
    await expect(provider().chat({ ...chatRequest, signal: controller.signal })).rejects.toThrow();
  });

  it('embeds in order and reports usage', async () => {
    stub.next(
      json(200, {
        data: [
          { index: 1, embedding: [0, 1] },
          { index: 0, embedding: [1, 0] },
        ],
        usage: { total_tokens: 7 },
      }),
    );
    const out = await provider().embed({ model: 'text-embedding-3-small', inputs: ['a', 'b'] });
    expect(out).toEqual({
      vectors: [
        [1, 0],
        [0, 1],
      ],
      usage: { tokens: 7 },
    });
    expect(JSON.parse(stub.requests[0]?.body ?? '{}')).toEqual({
      model: 'text-embedding-3-small',
      input: ['a', 'b'],
    });
    await expect(provider().embed({ model: 'm', inputs: [] })).resolves.toEqual({
      vectors: [],
      usage: { tokens: 0 },
    });
    stub.next(json(200, { data: [{ index: 0, embedding: [1] }] }));
    await expect(provider().embed({ model: 'm', inputs: ['a', 'b'] })).rejects.toMatchObject({
      details: [{ message: 'openai embedding_count' }],
    });
  });
});

describe('createAiProvider', () => {
  it('picks the provider from env', () => {
    expect(createAiProvider(loadEnv({})).name).toBe('fake');
    expect(createAiProvider(loadEnv({ OPENAI_API_KEY: 'k' })).name).toBe('openai');
    expect(createFakeProvider().name).toBe('fake');
  });
});
