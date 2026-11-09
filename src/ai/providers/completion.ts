import { generateText } from 'ai';
import { z } from 'zod';
import type { Settings } from '../../shared/types';
import { compatibleModel } from './ai-sdk';

/** Workflow requests retain their exact schema and role budget for receipts and retries. */
export interface CompletionRequest {
  model: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  stream?: false;
  max_tokens?: number;
  max_completion_tokens?: number;
  reasoning_effort?: string;
  response_format?: {
    type: 'json_schema';
    json_schema: { name: string; strict?: boolean; schema: Record<string, unknown> };
  };
}

export interface CompletionResult {
  text: string;
  finishReason: string;
  refused: boolean;
  toolCalls: number;
  usage: {
    inputTokens: number | undefined;
    outputTokens: number | undefined;
    totalTokens: number | undefined;
  };
}

const refusalSchema = z.object({
  choices: z.array(z.object({ message: z.object({ refusal: z.string().nullish() }) })),
});

export async function generateCompletion(
  settings: Settings,
  request: CompletionRequest,
  options: { signal?: AbortSignal } = {},
): Promise<CompletionResult> {
  options.signal?.throwIfAborted();
  const { model, messages, stream: _stream, ...wireOptions } = request;
  const result = await generateText({
    model: compatibleModel(settings, model, (raw) => ({ ...raw, ...wireOptions })),
    instructions: messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n'),
    messages: messages.filter((message) => message.role !== 'system'),
    maxRetries: 0,
    abortSignal: options.signal,
  });
  const refusal = refusalSchema.safeParse(result.response.body);
  return {
    text: result.text,
    finishReason: result.rawFinishReason ?? result.finishReason,
    refused:
      result.finishReason === 'content-filter' ||
      (refusal.success && refusal.data.choices.some((entry) => Boolean(entry.message.refusal))),
    toolCalls: result.toolCalls.length,
    usage: {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      totalTokens: result.usage.totalTokens,
    },
  };
}
