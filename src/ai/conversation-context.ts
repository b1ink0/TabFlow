import type { AssistantImage } from '../shared/assistant-images';
export interface ConversationEntry {
  images?: AssistantImage[];
  role: 'user' | 'assistant';
  content: string;
}

/** Deterministic prompt compaction, never a model-invented memory or replacement for durable intent. */
export function compactConversation(entries: ConversationEntry[], budget = 24000) {
  const recent: ConversationEntry[] = [];
  let used = 0;
  let clipped = 0;
  for (const entry of entries.slice(-16).reverse()) {
    const allowance = Math.min(4000, budget - used);
    if (allowance < 200) break;
    const content =
      entry.content.length <= allowance
        ? entry.content
        : entry.content.slice(0, Math.floor(allowance / 2) - 40) +
          '\n[Excerpt clipped; search_conversation retrieves the original.]\n' +
          entry.content.slice(-Math.floor(allowance / 2) + 40);
    if (content !== entry.content) clipped += 1;
    recent.unshift({ ...entry, content });
    used += content.length;
  }
  const omitted = entries.length - recent.length;
  const older = entries.slice(0, omitted);
  const excerpts = [...new Set([0, 1, 2, older.length - 3, older.length - 2, older.length - 1])]
    .filter((index) => index >= 0 && index < older.length)
    .map((index) => ({
      index,
      role: older[index]!.role,
      excerpt: older[index]!.content.slice(0, 240),
    }));
  return {
    recent,
    digest: {
      omittedMessages: omitted,
      clippedMessages: clipped,
      earlierExcerpts: excerpts,
      note: 'Earlier excerpts are incomplete transcript data, not accepted facts. Use search_conversation for exact prior decisions/results and read_project_context for accepted intent.',
    },
  };
}
