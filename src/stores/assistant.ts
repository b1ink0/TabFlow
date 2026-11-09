import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { z } from 'zod';
import * as db from '../core/db';
import type { AssistantAuditEntry, CollectionAnalysis } from '../shared/types';
import {
  assistantThreadSchema,
  assistantMessageSchema,
  type AssistantMessage,
  type AssistantThread,
} from '../shared/assistant/assistant';
import { branchTip } from '../shared/assistant/assistant-branches';
import { canRetry } from '../shared/assistant/assistant-retry';

export const useAssistantConversations = defineStore('assistant-conversations', () => {
  const threads = ref<AssistantThread[]>([]);
  const activeId = ref('');
  const hasMoreChats = ref(false);
  let historyOffset = 0;
  let historyQuery = '';
  let historyGeneration = 0;
  let loadingHistory = false;
  async function loadMoreChats(query = historyQuery, reset = false) {
    if (loadingHistory && !reset && query === historyQuery) return;
    const generation = reset || query !== historyQuery ? ++historyGeneration : historyGeneration;
    loadingHistory = true;
    try {
      if (reset || query !== historyQuery) {
        historyOffset = 0;
        historyQuery = query;
      }
      const offset = historyOffset;
      const needle = query.trim().toLocaleLowerCase();
      const matchingProjects = new Set(
        needle
          ? (await db.all('projects'))
              .filter((project) => project.name.toLocaleLowerCase().includes(needle))
              .map((project) => project.id)
          : [],
      );
      const count = await db.database.assistantThreads.count();
      if ((await db.database.assistantThreadSummaries.count()) !== count) {
        // One-time repair for older databases/direct imported writes; normal reads use summaries.
        await db.database.transaction(
          'rw',
          db.database.assistantThreads,
          db.database.assistantThreadSummaries,
          async () => {
            await db.database.assistantThreadSummaries.clear();
            await db.database.assistantThreads.each((thread) => {
              const { messages: _messages, ...summary } = thread;
              void db.database.assistantThreadSummaries.put(summary);
            });
          },
        );
      }
      const rows = await db.database.assistantThreadSummaries
        .orderBy('updatedAt')
        .reverse()
        .filter(
          (item) =>
            !needle ||
            item.title.toLocaleLowerCase().includes(needle) ||
            Boolean(item.projectId && matchingProjects.has(item.projectId)),
        )
        .offset(offset)
        .limit(51)
        .toArray();
      if (generation !== historyGeneration) return;
      hasMoreChats.value = rows.length > 50;
      const full = threads.value.filter(
        (item) => item.id === activeId.value || item.status === 'running',
      );
      const next = reset ? [] : threads.value;
      const byId = new Map(
        [...next, ...rows.slice(0, 50).map((item) => ({ ...item, messages: [] })), ...full].map(
          (item) => [item.id, item],
        ),
      );
      threads.value = [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
      historyOffset += Math.min(50, rows.length);
    } finally {
      if (generation === historyGeneration) loadingHistory = false;
    }
  }
  const analysisLaunch = ref<{ threadId: string; messageId: string }>();
  const cancelAnalysisId = ref('');
  const runningAnalysisId = ref('');
  let writes: Promise<unknown> = Promise.resolve();
  let ownedThread = '';
  const lockName = (id: string) => `tabloom-chat:${id}`;
  const locks = () => (typeof navigator !== 'undefined' ? navigator.locks : undefined);
  async function heldElsewhere(id: string) {
    return (
      ownedThread !== id &&
      Boolean((await locks()?.query())?.held?.some((lock) => lock.name === lockName(id)))
    );
  }
  async function exclusive<T>(action: () => Promise<T>) {
    if (!current.value) await create(null);
    const id = activeId.value;
    const manager = locks();
    const run = async () => {
      const latest = await db.get('assistantThreads', id);
      if (latest) {
        const parsed = assistantThreadSchema.parse(latest);
        const index = threads.value.findIndex((thread) => thread.id === id);
        threads.value[index] = parsed;
      }
      ownedThread = id;
      try {
        return await action();
      } finally {
        ownedThread = '';
      }
    };
    return manager
      ? manager.request(lockName(id), { ifAvailable: true }, async (lock) => {
          if (!lock)
            throw new Error(
              'This conversation is active in another TabFlow view. Use a new conversation or wait for it to finish.',
            );
          return run();
        })
      : run();
  }
  const current = computed(() => threads.value.find((thread) => thread.id === activeId.value));
  async function save() {
    if (!current.value) return;
    if (await heldElsewhere(current.value.id)) return;
    current.value.updatedAt = Date.now();
    const snapshot = assistantThreadSchema.parse(current.value);
    const write = writes.catch(() => undefined).then(() => db.put('assistantThreads', snapshot));
    writes = write;
    await write;
  }
  async function appendAudit(messageId: string, data: Pick<AssistantAuditEntry, 'text' | 'event'>) {
    await db.database.transaction('rw', db.database.assistantAudit, async () => {
      const last = await db.database.assistantAudit
        .where('[messageId+sequence]')
        .between([messageId, 0], [messageId, Number.MAX_SAFE_INTEGER])
        .last();
      await db.put('assistantAudit', {
        ...data,
        id: crypto.randomUUID(),
        messageId,
        sequence: (last?.sequence || 0) + 1,
        createdAt: data.event?.createdAt || Date.now(),
      });
    });
  }
  async function updateMessage(id: string, patch: Partial<AssistantMessage>) {
    const message = current.value?.messages.find((item) => item.id === id);
    if (!message) throw new Error('Conversation message is no longer available.');
    const next = assistantMessageSchema.safeParse({ ...message, ...patch });
    if (!next.success)
      throw new Error(
        'Could not save assistant progress because it contained invalid conversation data. The previous message was retained.',
        { cause: next.error },
      );
    Object.assign(message, next.data);
    await save();
  }
  async function create(projectId: string | null) {
    const timestamp = Date.now();
    const thread: AssistantThread = {
      id: crypto.randomUUID(),
      title: 'New conversation',
      createdAt: timestamp,
      updatedAt: timestamp,
      projectId,
      status: 'ready',
      messages: [],
    };
    threads.value.unshift(thread);
    activeId.value = thread.id;
    await save();
    await chrome.storage.local.set({ activeAssistantThread: activeId.value });
  }
  async function select(id: string) {
    if (!threads.value.some((thread) => thread.id === id)) return;
    for (const item of threads.value)
      if (item.id !== id && item.status !== 'running') item.messages = [];
    activeId.value = id;
    const latest = await db.get('assistantThreads', id);
    if (latest)
      threads.value[threads.value.findIndex((thread) => thread.id === id)] =
        assistantThreadSchema.parse(latest);
    await chrome.storage.local.set({ activeAssistantThread: id });
  }
  async function refreshRunningThread(id: string) {
    if (ownedThread === id) return;
    const saved = await db.get('assistantThreads', id);
    if (!saved || ownedThread === id) return;
    const index = threads.value.findIndex((thread) => thread.id === id);
    if (index >= 0) threads.value[index] = assistantThreadSchema.parse(saved);
  }
  async function moveToProject(id: string, projectId: string | null) {
    const move = async () => {
      const saved = await db.get('assistantThreads', id);
      if (!saved) throw new Error('Conversation no longer available. Refresh saved chats.');
      const thread = assistantThreadSchema.parse(saved);
      if (thread.status === 'running')
        throw new Error('Wait for this conversation to finish before moving it.');
      thread.projectId = projectId;
      thread.updatedAt = Date.now();
      await db.put('assistantThreads', thread);
      const index = threads.value.findIndex((item) => item.id === id);
      if (index >= 0) threads.value[index] = thread;
      threads.value.sort((a, b) => b.updatedAt - a.updatedAt);
    };
    const manager = locks();
    if (!manager) return move();
    return manager.request(lockName(id), { ifAvailable: true }, async (lock) => {
      if (!lock)
        throw new Error(
          'This conversation is active in another TabFlow view. Move it after the run finishes.',
        );
      return move();
    });
  }
  async function append(
    role: 'user' | 'assistant',
    content: string,
    fields: Partial<AssistantMessage> = {},
  ) {
    if (!current.value) await create(null);
    const message = {
      ...fields,
      parentMessageId:
        fields.parentMessageId === undefined
          ? current.value!.selectedLeafId || current.value!.messages.at(-1)?.id || null
          : fields.parentMessageId,
      id: crypto.randomUUID(),
      role,
      content,
      createdAt: Date.now(),
      sources: fields.sources || [],
      activity: fields.activity || [],
      completedArtifacts: fields.completedArtifacts || [],
      toolEvents: fields.toolEvents || [],
    };
    current.value!.messages.push(message);
    current.value!.selectedLeafId = message.id;
    if (role === 'user' && current.value!.title === 'New conversation')
      current.value!.title = content.slice(0, 80);
    await save();
    return message.id;
  }
  async function load() {
    await loadMoreChats('', true);
    for (const thread of threads.value) {
      if (thread.status !== 'running') continue;
      if (await heldElsewhere(thread.id)) continue;
      const latest = await db.get('assistantThreads', thread.id);
      if (latest) Object.assign(thread, assistantThreadSchema.parse(latest));
      thread.status = 'interrupted';
      for (const message of thread.messages) {
        if (message.deliveryStatus === 'generating') message.deliveryStatus = 'interrupted';
      }
      await db.put('assistantThreads', assistantThreadSchema.parse(thread));
    }
    const saved = await chrome.storage.local.get(['activeAssistantThread', 'chat']);
    if (!threads.value.length) {
      const legacy = z
        .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(100000) }))
        .safeParse(saved.chat);
      if (legacy.success && legacy.data.length) {
        await create(null);
        for (const message of legacy.data) await append(message.role, message.content);
        await chrome.storage.local.remove('chat');
      }
    }
    const savedActive =
      typeof saved.activeAssistantThread === 'string'
        ? await db.get('assistantThreads', saved.activeAssistantThread)
        : undefined;
    if (savedActive && !threads.value.some((item) => item.id === savedActive.id))
      threads.value.unshift(assistantThreadSchema.parse(savedActive));
    activeId.value =
      typeof saved.activeAssistantThread === 'string' &&
      threads.value.some((thread) => thread.id === saved.activeAssistantThread)
        ? saved.activeAssistantThread
        : threads.value[0]?.id || '';
    if (activeId.value) await select(activeId.value);
  }
  async function manageThread(id: string, title?: string) {
    const change = async () => {
      await writes;
      const saved = await db.get('assistantThreads', id);
      if (!saved) throw new Error('Chat is no longer available.');
      if (saved.status === 'running') throw new Error('Stop the chat before changing it.');
      if (title !== undefined) {
        saved.title = z.string().trim().min(1).max(160).parse(title);
        saved.updatedAt = Date.now();
        await db.put('assistantThreads', saved);
        const local = threads.value.find((item) => item.id === id);
        if (local) local.title = saved.title;
      } else {
        await db.database.transaction(
          'rw',
          [
            db.database.assistantThreads,
            db.database.assistantThreadSummaries,
            db.database.assistantAudit,
            db.database.permissionReviews,
          ],
          async () => {
            for (const message of saved.messages)
              await db.database.assistantAudit.where('messageId').equals(message.id).delete();
            await db.database.permissionReviews.where('threadId').equals(id).delete();
            await db.remove('assistantThreads', id);
            await db.remove('assistantThreadSummaries', id);
          },
        );
        const storage = await chrome.storage.local.get('assistantPermissionPolicies');
        const policies = z
          .record(z.string(), z.unknown())
          .catch({})
          .parse(storage.assistantPermissionPolicies);
        delete policies[id];
        await chrome.storage.local.set({ assistantPermissionPolicies: policies });
        threads.value = threads.value.filter((item) => item.id !== id);
        if (activeId.value === id) {
          activeId.value = '';
          if (threads.value[0]) await select(threads.value[0].id);
        }
      }
    };
    const manager = locks();
    return manager
      ? manager.request(lockName(id), { ifAvailable: true }, async (lock) => {
          if (!lock) throw new Error('This chat is active in another view.');
          return change();
        })
      : change();
  }
  async function connectCollectionAnalysis(analysis: CollectionAnalysis, instruction: string) {
    if (current.value?.status === 'running')
      throw new Error(
        'The current chat is running. Wait for it to finish before linking another analysis.',
      );
    await writes;
    const saved = (await db.all('assistantThreads'))
      .flatMap((value) => {
        const parsed = assistantThreadSchema.safeParse(value);
        return parsed.success ? [parsed.data] : [];
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const exact = saved.find((thread) =>
      thread.messages.some((message) => message.collectionAnalysisId === analysis.id),
    );
    const sourceProposalId = analysis.sourceAnalysisId?.startsWith('proposal:')
      ? analysis.sourceAnalysisId.slice(9)
      : undefined;
    const origin =
      exact ||
      saved.find((thread) =>
        thread.messages.some(
          (message) =>
            (analysis.sourceAnalysisId &&
              message.collectionAnalysisId === analysis.sourceAnalysisId) ||
            (sourceProposalId && message.collectionProposalId === sourceProposalId),
        ),
      );
    const id = origin?.id || crypto.randomUUID();
    const connect = async () => {
      const latest = await db.get('assistantThreads', id);
      const thread: AssistantThread = latest
        ? assistantThreadSchema.parse(latest)
        : {
            id,
            title: 'Collection organization',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            projectId: null,
            status: 'ready',
            messages: [],
          };
      if (thread.status === 'running')
        throw new Error(
          'This chat is already running. Open it to review its progress before starting another analysis.',
        );
      const existing = [...thread.messages]
        .reverse()
        .find(
          (message) => message.collectionAnalysisId === analysis.id && canRetry(thread, message),
        );
      let messageId = existing?.id;
      if (!messageId) {
        const sourceMessage = [...thread.messages]
          .reverse()
          .find((message) => message.collectionAnalysisId === analysis.sourceAnalysisId);
        const request = {
          task: 'work' as const,
          recordIds: analysis.scope.map((item) => item.id),
          projectId: thread.projectId,
          selectedRecordIds: [],
          allowCrossWindowMove: false,
          allowSleepWake: false,
        };
        const userId = crypto.randomUUID();
        thread.messages.push(
          assistantMessageSchema.parse({
            id: userId,
            role: 'user',
            content: instruction,
            createdAt: Date.now(),
            request,
          }),
        );
        messageId = crypto.randomUUID();
        thread.messages.push(
          assistantMessageSchema.parse({
            id: messageId,
            role: 'assistant',
            content:
              'Saved analysis is ready to resume. Completed compatible batches are retained.',
            createdAt: Date.now(),
            request,
            requestMessageId: userId,
            collectionAnalysisId: analysis.id,
            collectionProposalId:
              analysis.purpose === 'reclassify' ? sourceMessage?.collectionProposalId : undefined,
            deliveryStatus: 'interrupted',
          }),
        );
      }
      thread.updatedAt = Date.now();
      await db.put('assistantThreads', thread);
      const index = threads.value.findIndex((item) => item.id === id);
      if (index < 0) threads.value.unshift(thread);
      else threads.value[index] = thread;
      await select(id);
      return { threadId: id, messageId };
    };
    const manager = locks();
    return manager
      ? manager.request(lockName(id), { ifAvailable: true }, async (lock) => {
          if (!lock)
            throw new Error(
              'The source chat is active in another view. Its analysis and draft are retained.',
            );
          return connect();
        })
      : connect();
  }
  async function selectBranch(id: string) {
    if (
      !current.value ||
      current.value.status === 'running' ||
      !current.value.messages.some((item) => item.id === id)
    )
      return;
    current.value.selectedLeafId = branchTip(current.value, id);
    await save();
  }
  return {
    manageThread,
    loadMoreChats,
    hasMoreChats,
    selectBranch,
    analysisLaunch,
    cancelAnalysisId,
    runningAnalysisId,
    connectCollectionAnalysis,
    refreshRunningThread,
    appendAudit,
    updateMessage,
    threads,
    current,
    activeId,
    create,
    select,
    moveToProject,
    append,
    save,
    load,
    exclusive,
  };
});
