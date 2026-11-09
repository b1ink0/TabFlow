import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { aiSdkAgentRuntime } from '../src/ai/runtime/ai-sdk-conversation';
import { DEFAULTS } from '../src/shared/model';
import type { AppState } from '../src/shared/types';

function fixture(): AppState {
  return {
    records: [],
    windows: [],
    groups: [],
    projects: [],
    areas: [],
    workItems: [],
    categories: [],
    memberships: [],
    proposals: [],
    collectionProposals: [],
    organizationJobs: [],
    snapshots: [],
    operations: [],
    jobs: [],
    version: '0.1.0',
    settings: { ...DEFAULTS, aiModel: 'fixture', aiStreamResponses: false },
  };
}
const call = (id: string, name: string) => ({
  id,
  type: 'function',
  function: { name, arguments: '{}' },
});
const reply = (calls?: ReturnType<typeof call>[], stream = false) => {
  if (stream)
    return new Response(
      `data: ${JSON.stringify({
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              content: calls ? null : 'Workspace checked.',
              tool_calls: calls?.map((entry, index) => ({ ...entry, index })),
            },
            finish_reason: null,
          },
        ],
      })}\n\n` +
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: calls ? 'tool_calls' : 'stop' }] })}\n\n` +
        'data: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    );
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            role: 'assistant',
            content: calls ? null : 'Workspace checked.',
            tool_calls: calls,
          },
          finish_reason: calls ? 'tool_calls' : 'stop',
        },
      ],
    }),
    { headers: { 'content-type': 'application/json' } },
  );
};
afterEach(() => vi.unstubAllGlobals());

describe('AI SDK execution boundaries', () => {
  it.each([false, true])(
    'concludes repeated successful empty reads before step exhaustion (stream=%s)',
    async (stream) => {
      let requests = 0;
      vi.stubGlobal('fetch', async (_url: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        requests++;
        if (requests < 4)
          return reply(
            [
              {
                ...call(`lookup-${requests}`, 'list_tags'),
                function: { name: 'list_tags', arguments: '{"query":"absent","offset":0}' },
              },
            ],
            stream,
          );
        expect(body.tools?.length || 0).toBe(0);
        expect(body.messages[0].content).toContain('Tool execution is now disabled');
        return reply(undefined, stream);
      });
      const result = await aiSdkAgentRuntime.answer(
        { ...fixture(), settings: { ...fixture().settings, aiStreamResponses: stream } },
        'Find a missing tag',
      );
      expect(requests).toBe(4);
      expect(result.answer).toBe('Workspace checked.');
      expect(result.command).toBeUndefined();
    },
  );

  it('returns a scoped explanation if a model ignores the tool-free conclusion', async () => {
    let requests = 0;
    vi.stubGlobal('fetch', async () => {
      requests++;
      return reply([
        {
          ...call(`lookup-${requests}`, 'list_tags'),
          function: { name: 'list_tags', arguments: '{"query":"absent","offset":0}' },
        },
      ]);
    });
    const result = await aiSdkAgentRuntime.answer(fixture(), 'Find a missing tag');
    expect(requests).toBe(4);
    expect(result.answer).toContain('stopped the repeated calls');
    expect(result.answer).not.toContain('Tool round limit');
    expect(result.command).toBeUndefined();
  });

  it.each([false, true])(
    'serializes calls and correlates audit IDs (stream=%s)',
    async (stream) => {
      let requests = 0;
      const events: string[] = [];
      vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (++requests === 1)
          return reply([call('first', 'read_workspace'), call('second', 'read_workspace')], stream);
        const body = z
          .object({
            messages: z.array(z.object({ role: z.string(), tool_call_id: z.string().optional() })),
          })
          .parse(JSON.parse(String(init?.body)));
        expect(
          body.messages.filter((entry) => entry.role === 'tool').map((entry) => entry.tool_call_id),
        ).toEqual(['first', 'second']);
        return reply(undefined, stream);
      });
      const result = await aiSdkAgentRuntime.answer(
        { ...fixture(), settings: { ...fixture().settings, aiStreamResponses: stream } },
        'Read workspace twice',
        [],
        undefined,
        {
          onToolEvent: async (event) => {
            events.push(`${event.id}:${event.phase}`);
          },
        },
      );
      expect(events).toEqual([
        'first:requested',
        'first:returned',
        'second:requested',
        'second:returned',
      ]);
      expect(result.answer).toBe('Workspace checked.');
      expect(requests).toBe(2);
    },
  );

  it.each([false, true])('stops after checkpoint failure (stream=%s)', async (stream) => {
    const failure = new Error('Checkpoint storage unavailable');
    const fetch = vi.fn(async () =>
      reply([call('first', 'read_workspace'), call('second', 'read_workspace')], stream),
    );
    const events: string[] = [];
    vi.stubGlobal('fetch', fetch);
    await expect(
      aiSdkAgentRuntime.answer(
        { ...fixture(), settings: { ...fixture().settings, aiStreamResponses: stream } },
        'Read workspace',
        [],
        undefined,
        {
          onToolEvent: async (event) => {
            events.push(`${event.id}:${event.phase}`);
          },
          onCheckpoint: async () => {
            throw failure;
          },
        },
      ),
    ).rejects.toBe(failure);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['first:requested', 'first:returned']);
  });

  it('honors cancellation before any request or tool activity', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const controller = new AbortController();
    controller.abort();
    await expect(
      aiSdkAgentRuntime.answer(fixture(), 'Read workspace', [], controller.signal),
    ).rejects.toThrow(/abort/i);
    expect(fetch).not.toHaveBeenCalled();
  });
});
