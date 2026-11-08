import OpenAI from 'openai';
import { z } from 'zod';
import type { Settings } from '../shared/types';
import { boundOrchestratorRequest } from './request-context';

/** These responses require configuration/permission changes, not another identical request. */
export function throwPermanentModelFailure(error: unknown) {
  const result = z.object({ status: z.number() }).safeParse(error);
  if (result.success && [401, 403, 404].includes(result.data.status)) throw error;
}

/** Keep server-specific reasoning state within one tool run, never in exported chat history. */
export const reasoningResponseSchema = z.object({
  choices: z.array(
    z.object({
      message: z.object({
        reasoning_content: z.string().nullable().optional(),
        tool_calls: z.array(z.object({ id: z.string() })).optional(),
      }),
    }),
  ),
});
const requestSchema = z
  .object({
    messages: z.array(
      z
        .object({
          role: z.string(),
          tool_calls: z.array(z.object({ id: z.string() }).passthrough()).optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export function modelClient(settings: Settings, reasoning?: Map<string, string>) {
  return new OpenAI({
    baseURL: settings.aiBase,
    apiKey: settings.aiKey || 'local',
    dangerouslyAllowBrowser: true,
    maxRetries: 0,
    timeout: 300000,
    ...(reasoning
      ? {
          fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
            if (typeof init?.body !== 'string') return fetch(input, init);
            const parsed = requestSchema.safeParse(JSON.parse(init.body));
            if (!parsed.success) return fetch(input, init);
            for (const message of parsed.data.messages) {
              if (message.role !== 'assistant') continue;
              const value = message.tool_calls
                ?.map((call) => reasoning.get(call.id))
                .find((entry) => entry !== undefined);
              if (value !== undefined) message.reasoning_content = value;
            }
            const bounded = settings.aiContextTokens
              ? // This is an estimate, not the provider's tokenizer. Three UTF-8 bytes per
                // token leaves headroom for ordinary English/schema tool conversations.
                boundOrchestratorRequest(
                  parsed.data,
                  (settings.aiContextTokens - settings.aiCompletionTokens - 1024) * 3,
                )
              : parsed.data;
            return fetch(input, { ...init, body: JSON.stringify(bounded) });
          },
        }
      : {}),
  });
}

/** No model-name heuristics: transport options are selected separately for each chat role. */
export function completionOptions(settings: Settings, role: 'generative' | 'small' = 'generative') {
  const effort = role === 'small' ? settings.smallReasoningEffort : settings.aiReasoningEffort;
  const budget = role === 'small' ? settings.smallCompletionTokens : settings.aiCompletionTokens;
  const field = role === 'small' ? settings.smallTokenField : settings.aiTokenField;
  return {
    ...(field === 'max_completion_tokens'
      ? { max_completion_tokens: budget }
      : { max_tokens: budget }),
    ...(effort === 'server' ? {} : { reasoning_effort: effort }),
  };
}
