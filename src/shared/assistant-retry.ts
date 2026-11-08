import type { AssistantMessage, AssistantThread } from './assistant';

export function incompleteToolTurn(message: AssistantMessage) {
  return (
    message.role === 'assistant' &&
    (message.activity.some((step) => step.startsWith('Tool round limit reached')) ||
      /^\s*(?:```(?:xml|html)?\s*)?<tool_call>/i.test(message.content))
  );
}

export function retryTurn(thread: AssistantThread, messageId: string, regenerate = false) {
  const index = thread.messages.findIndex((message) => message.id === messageId);
  const failed = thread.messages[index];
  if (
    !failed ||
    failed.role !== 'assistant' ||
    (!regenerate &&
      !['error', 'interrupted'].includes(failed.deliveryStatus || '') &&
      !incompleteToolTurn(failed))
  )
    throw new Error('Only a failed or interrupted assistant turn can be retried.');
  const user = failed.requestMessageId
    ? thread.messages.find(
        (message) => message.id === failed.requestMessageId && message.role === 'user',
      )
    : thread.messages
        .slice(0, index)
        .reverse()
        .find((message) => message.role === 'user');
  if (!user) throw new Error('The original request is unavailable. Send a new request.');
  if (
    !regenerate &&
    thread.messages
      .slice(index + 1)
      .some((message) => message.role === 'assistant' && message.requestMessageId === user.id)
  )
    throw new Error('Use the latest attempt for this request.');
  return {
    user,
    failed,
    request: failed.request ||
      user.request || {
        task: 'work' as const,
        recordIds: [],
        projectId: thread.projectId,
        selectedRecordIds: [],
        allowCrossWindowMove: false,
        allowSleepWake: false,
      },
  };
}

export function canRetry(thread: AssistantThread | undefined, message: AssistantMessage) {
  if (!thread) return false;
  try {
    retryTurn(thread, message.id);
    return true;
  } catch {
    return false;
  }
}
