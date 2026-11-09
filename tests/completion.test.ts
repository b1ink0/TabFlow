import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { generateCompletion } from '../src/ai/providers/completion';
import { generativeModels } from '../src/ai/providers/models';
import { reviewPermission } from '../src/ai/inference/permission-review';
import { DEFAULTS } from '../src/shared/model';

const settings = { ...DEFAULTS, aiModel: 'generative', aiContextTokens: 32768 };
const reply = (content: string, finish = 'stop', refusal?: string) =>
  new Response(
    JSON.stringify({
      choices: [{ finish_reason: finish, message: { role: 'assistant', content, refusal } }],
      usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
    }),
    { headers: { 'content-type': 'application/json' } },
  );
afterEach(() => vi.unstubAllGlobals());

describe('AI SDK structured generation', () => {
  it('preserves the request model, strict schema and explicit role budget', async () => {
    const schema = z.toJSONSchema(z.object({ accepted: z.boolean() }));
    const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({
        model: 'small-role',
        max_completion_tokens: 1024,
        reasoning_effort: 'none',
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'classification', strict: true, schema },
        },
      });
      expect(body.max_tokens).toBeUndefined();
      expect(body.messages.map((entry: { role: string }) => entry.role)).toEqual([
        'system',
        'user',
      ]);
      return reply('{"accepted":true}');
    });
    vi.stubGlobal('fetch', fetch);
    const result = await generateCompletion(settings, {
      model: 'small-role',
      max_completion_tokens: 1024,
      reasoning_effort: 'none',
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'classification', strict: true, schema },
      },
      messages: [
        { role: 'system', content: 'Classify this evidence.' },
        { role: 'user', content: 'Fixture evidence' },
      ],
    });
    expect(result).toMatchObject({
      text: '{"accepted":true}',
      finishReason: 'stop',
      refused: false,
      toolCalls: 0,
      usage: { inputTokens: 12, outputTokens: 6, totalTokens: 18 },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['length', 'content_filter'])(
    'retains incomplete/refused status for workflow validation (%s)',
    async (finish) => {
      vi.stubGlobal('fetch', async () => reply('{"partial":', finish));
      const result = await generateCompletion(settings, {
        model: 'generative',
        messages: [{ role: 'user', content: 'Fixture' }],
      });
      expect(result.finishReason).toBe(finish);
      expect(result.text).toBe('{"partial":');
      expect(result.refused).toBe(finish === 'content_filter');
    },
  );
});

describe('delegated approval with AI SDK', () => {
  it.each(['length', 'refusal', 'invalid-json'])(
    'rejects an incomplete or refused approval (%s)',
    async (kind) => {
      vi.stubGlobal('chrome', { permissions: { contains: async () => true } });
      const response =
        kind === 'invalid-json' ? '{"decision":' : '{"decision":"allow","reason":"Authorized"}';
      const fetch = vi.fn(async () =>
        reply(
          response,
          kind === 'length' ? 'length' : 'stop',
          kind === 'refusal' ? 'Refused' : undefined,
        ),
      );
      vi.stubGlobal('fetch', fetch);
      await expect(
        reviewPermission(settings, 'Synthetic exact action', new AbortController().signal),
      ).rejects.toThrow();
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it('returns only a validated decision and does not expose execution tools', async () => {
    vi.stubGlobal('chrome', { permissions: { contains: async () => true } });
    vi.stubGlobal('fetch', async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body)).tools).toBeUndefined();
      return reply('{"decision":"ask","reason":"Target is ambiguous"}');
    });
    await expect(
      reviewPermission(settings, 'Synthetic exact action', new AbortController().signal),
    ).resolves.toEqual({ decision: 'ask', reason: 'Target is ambiguous' });
  });
});

describe('validated model discovery', () => {
  it('rejects malformed listings rather than selecting an invented model', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response('{"data":[{"name":"not-an-id"}]}', {
          headers: { 'content-type': 'application/json' },
        }),
    );
    await expect(generativeModels(settings)).rejects.toThrow();
  });

  it('reports an HTTP error without retrying', async () => {
    const fetch = vi.fn(async () => new Response('Forbidden', { status: 403 }));
    vi.stubGlobal('fetch', fetch);
    await expect(generativeModels(settings)).rejects.toThrow('403');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
