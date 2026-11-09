import {
  generateText,
  isStepCount,
  streamText,
  tool,
  ToolChoiceViolationError,
  type ToolSet,
} from 'ai';
import { conversationModel, modelMessages } from '../providers/ai-sdk';
import { discoverableTools } from '../tools/catalog';
import { createConversationSession } from '../tools/conversation-session';
import { ToolProgress } from '../tools/progress';
import type { AgentRuntime } from './contracts';

const outputText = (output: unknown) =>
  typeof output === 'string' ? output : (JSON.stringify(output) ?? '');

export const aiSdkAgentRuntime: AgentRuntime = {
  id: 'ai-sdk',
  async answer(app, question, conversation = [], signal, options = {}) {
    const controller = new AbortController();
    const runSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try {
      runSignal.throwIfAborted();
      const session = await createConversationSession(
        app,
        question,
        conversation,
        runSignal,
        options,
      );
      if (!('request' in session)) return session;
      let failure: unknown;
      let hasFailure = false;
      let finalReason: string;
      let answer = '';
      let reasoning = '';
      const progress = new ToolProgress();
      const available = session.request.tools.map((definition) => progress.wrap(definition));
      let finalizing = false;
      const tools: ToolSet = Object.fromEntries(
        [
          ...available,
          ...discoverableTools(available).map((definition) => progress.wrap(definition)),
        ].map((definition) => [
          definition.name,
          tool({
            description: definition.description,
            inputSchema: definition.parameters,
            execute: async (input, { toolCallId, abortSignal }) => {
              abortSignal?.throwIfAborted();
              if (hasFailure) throw failure;
              // These tools prepare reviewed effects. Background authority is unchanged.
              session.requested(toolCallId, definition.name, JSON.stringify(input));
              try {
                const result = finalizing
                  ? JSON.stringify({
                      ok: false,
                      applied: false,
                      error:
                        'This run is concluding from existing evidence. Further tool execution is disabled.',
                    })
                  : await definition.execute(input);
                session.returned(toolCallId, definition.name, outputText(result));
                await session.checkpoint();
                return result;
              } catch (error) {
                failure = error;
                hasFailure = true;
                throw error;
              }
            },
            toModelOutput: ({ output }) => ({ type: 'text', value: outputText(output) }),
          }),
        ]),
      );
      const instructions = session.request.messages
        .filter((message) => message.role === 'system')
        .map((message) => message.content)
        .join('\n');
      const request = {
        model: conversationModel(app.settings),
        instructions,
        messages: modelMessages(
          session.request.messages.filter((message) => message.role !== 'system'),
        ),
        tools,
        toolCallConcurrency: 1,
        maxRetries: 0,
        abortSignal: runSignal,
        stopWhen: [isStepCount(10), () => hasFailure || session.shouldStop() || finalizing],
        prepareStep: async () => {
          if (hasFailure) throw failure;
          runSignal.throwIfAborted();
          if (progress.stalled) {
            finalizing = true;
            options.onProgress?.(
              'Repeated lookup returned unchanged results; preparing an answer.',
            );
            return {
              toolChoice: 'none' as const,
              activeTools: [],
              instructions: `${instructions}\n${progress.guidance()}\nTool execution is now disabled for this conclusion. Answer from the existing results, state the scoped evidence gap, or ask one useful clarification. Do not claim the original task was completed if it was not.`,
            };
          }
          if (progress.warning) return { instructions: `${instructions}\n${progress.guidance()}` };
          return {};
        },
        onStepStart: () => {
          answer = '';
          reasoning = '';
        },
      };
      try {
        if (app.settings.aiStreamResponses) {
          const result = streamText(request);
          for await (const part of result.fullStream) {
            if (part.type === 'error') throw part.error;
            if (part.type === 'text-delta') {
              answer += part.text;
              options.onText?.(answer);
            }
            if (part.type === 'reasoning-delta') {
              reasoning += part.text;
              options.onReasoning?.(reasoning.slice(0, 100000), true);
            }
            if (part.type === 'finish-step') {
              if (reasoning) options.onReasoning?.(reasoning.slice(0, 100000), false);
              if (part.finishReason === 'length')
                throw new Error(
                  'Model exhausted its completion budget. Increase the thinking/output token budget in Settings. Prepared proposals remain available for review.',
                );
            }
          }
          finalReason = await result.finishReason;
          answer = await result.text;
        } else {
          const result = await generateText(request);
          finalReason = result.finishReason;
          answer = result.text;
          for (const step of result.steps)
            if (step.reasoningText)
              options.onReasoning?.(step.reasoningText.slice(0, 100000), false);
          options.onText?.(answer);
          if (result.steps.some((step) => step.finishReason === 'length'))
            throw new Error(
              'Model exhausted its completion budget. Increase the thinking/output token budget in Settings. Prepared proposals remain available for review.',
            );
        }
      } catch (error) {
        if (
          !finalizing ||
          !progress.stalled ||
          !ToolChoiceViolationError.isInstance(error) ||
          runSignal.aborted ||
          hasFailure
        )
          throw error;
        finalReason = 'stop';
        answer = progress.fallback();
        options.onText?.(answer);
      }
      if (hasFailure) throw failure;
      runSignal.throwIfAborted();
      await session.checkpoint();
      if (progress.stalled && (finalReason === 'tool-calls' || !answer.trim())) {
        answer = progress.fallback();
        options.onText?.(answer);
      }
      return await session.finish(
        answer,
        finalReason === 'tool-calls' && !session.shouldStop() && !progress.stalled,
      );
    } finally {
      controller.abort();
    }
  },
};
