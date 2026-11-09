import type { ExecutableTool } from '../tools/definition';
import type { imageMessageContent } from '../../shared/assistant/assistant-images';
import type { ConversationResult } from './contracts';

export type ConversationPromptMessage =
  | { role: 'system' | 'assistant'; content: string }
  | { role: 'user'; content: ReturnType<typeof imageMessageContent> };

export interface ConversationRequest {
  messages: ConversationPromptMessage[];
  tools: ExecutableTool[];
}

export interface ConversationSession {
  request: ConversationRequest;
  shouldStop: () => boolean;
  checkpoint: () => Promise<void>;
  requested: (id: string, name: string, args: string) => void;
  returned: (id: string, name: string, result: string) => void;
  finish: (answer: string | null, exhausted: boolean) => Promise<ConversationResult>;
}
