import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { ModelMessage } from 'ai';
import type { Settings } from '../../shared/types';
import { boundOrchestratorRequest } from '../context/request-context';
import type { ConversationPromptMessage } from '../runtime/model-runner';
import { completionOptions } from './transport';

/** Preserve configured wire options and context limits without model-name heuristics. */
export function compatibleModel(
  settings: Settings,
  modelId: string,
  transformRequestBody: (raw: Record<string, unknown>) => Record<string, unknown>,
) {
  return createOpenAICompatible({
    name: 'tabflow',
    baseURL: settings.aiBase,
    apiKey: settings.aiKey || 'local',
    fetch: (input, init) =>
      fetch(input, {
        ...init,
        signal: AbortSignal.any([
          ...(init?.signal ? [init.signal] : []),
          AbortSignal.timeout(300000),
        ]),
      }),
    transformRequestBody,
  }).chatModel(modelId);
}

export function conversationModel(settings: Settings) {
  return compatibleModel(settings, settings.aiModel, (raw) => {
    const body: Record<string, unknown> = {
      ...raw,
      ...completionOptions(settings),
      parallel_tool_calls: false,
    };
    if (settings.aiReasoningEffort === 'server') delete body.reasoning_effort;
    if (settings.aiTokenField === 'max_completion_tokens') delete body.max_tokens;
    else delete body.max_completion_tokens;
    return settings.aiContextTokens
      ? boundOrchestratorRequest(
          body,
          (settings.aiContextTokens - settings.aiCompletionTokens - 1024) * 3,
        )
      : body;
  });
}

export function modelMessages(messages: ConversationPromptMessage[]): ModelMessage[] {
  return messages.map((message): ModelMessage => {
    if (typeof message.content === 'string')
      return { role: message.role, content: message.content };
    return {
      role: 'user',
      content: message.content.map((part) =>
        part.type === 'text'
          ? { type: 'text', text: part.text }
          : {
              type: 'file',
              data: part.image_url.url,
              mediaType: part.image_url.url.slice(5, part.image_url.url.indexOf(';')),
            },
      ),
    };
  });
}
