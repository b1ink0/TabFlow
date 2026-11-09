import type { AssistantMessage, AssistantThread } from './assistant';
export function messageParent(thread: AssistantThread, message: AssistantMessage): string | null {
  if (message.parentMessageId !== undefined) return message.parentMessageId;
  if (message.retryOfMessageId && message.requestMessageId) return message.requestMessageId;
  return (
    thread.messages[thread.messages.findIndex((item) => item.id === message.id) - 1]?.id || null
  );
}
export function conversationBranch(thread?: AssistantThread): AssistantMessage[] {
  if (!thread) return [];
  const byId = new Map(thread.messages.map((item) => [item.id, item]));
  const seen = new Set<string>();
  const path: AssistantMessage[] = [];
  let id = thread.selectedLeafId || thread.messages.at(-1)?.id;
  while (id && !seen.has(id)) {
    seen.add(id);
    const message = byId.get(id);
    if (!message) break;
    path.push(message);
    id = messageParent(thread, message) || undefined;
  }
  return path.reverse();
}
export function answerBranches(thread: AssistantThread | undefined, message: AssistantMessage) {
  if (!thread || message.role !== 'assistant') return [];
  const parent = messageParent(thread, message);
  return thread.messages.filter(
    (item) => item.role === 'assistant' && messageParent(thread, item) === parent,
  );
}
export function branchTip(thread: AssistantThread, id: string) {
  const seen = new Set<string>();
  let tip = id;
  while (!seen.has(tip)) {
    seen.add(tip);
    const child = thread.messages.filter((item) => messageParent(thread, item) === tip).at(-1);
    if (!child) break;
    tip = child.id;
  }
  return tip;
}
