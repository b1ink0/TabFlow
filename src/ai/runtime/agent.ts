import { aiSdkAgentRuntime } from './ai-sdk-conversation';
import type { AgentRuntime } from './contracts';

/** The composition point for extension-owned and future service-backed execution. */
export const agentRuntime: AgentRuntime = aiSdkAgentRuntime;

export const answerWorkQuestion: AgentRuntime['answer'] = (...args) => agentRuntime.answer(...args);
