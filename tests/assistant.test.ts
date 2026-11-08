import { conversationBranch, answerBranches } from '../src/shared/assistant-branches';
import 'fake-indexeddb/auto';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { database } from '../src/core/db';
import { useAssistantConversations } from '../src/stores/assistant';
import { compactConversation } from '../src/ai/conversation-context';
import { canRetry, retryTurn } from '../src/shared/assistant-retry';
import type { CollectionAnalysis } from '../src/shared/types';

beforeEach(async () => {
  await database.assistantThreads.clear();
  const local: Record<string, unknown> = {};
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async (keys: string | string[]) =>
          Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, local[key]])),
        set: async (values: Record<string, unknown>) => Object.assign(local, values),
        remove: async (key: string) => {
          delete local[key];
        },
      },
    },
  });
  setActivePinia(createPinia());
});
afterEach(() => vi.unstubAllGlobals());
describe('local assistant continuity', () => {
  it('finds paged chat summaries by their current project name without loading message bodies', async () => {
    await database.projects.put({
      id: 'search-project',
      name: 'Orchard research',
      purpose: '',
      revision: 1,
      updatedAt: 1,
      maintainReviewQueue: false,
    });
    const chat = useAssistantConversations();
    await chat.create('search-project');
    const id = chat.activeId;
    chat.current!.title = 'Reference notes';
    await chat.save();
    await chat.create(null);
    setActivePinia(createPinia());
    const reloaded = useAssistantConversations();
    await reloaded.loadMoreChats('Orchard', true);
    expect(reloaded.threads.map((thread) => thread.id)).toEqual([id]);
    expect(reloaded.threads[0]?.messages).toEqual([]);
    await database.projects.delete('search-project');
  });
  it('keeps alternate answers and their continuations isolated across reload', async () => {
    const chat = useAssistantConversations();
    await chat.create(null);
    const user = await chat.append('user', 'Organize a reference');
    const first = await chat.append('assistant', 'First answer', {
      requestMessageId: user,
      parentMessageId: user,
      deliveryStatus: 'complete',
    });
    const followup = await chat.append('user', 'Continue first');
    const continuation = await chat.append('assistant', 'First continuation');
    const second = await chat.append('assistant', 'Alternate answer', {
      requestMessageId: user,
      parentMessageId: user,
      retryOfMessageId: first,
      deliveryStatus: 'complete',
    });
    expect(conversationBranch(chat.current).map((item) => item.id)).toEqual([user, second]);
    expect(answerBranches(chat.current, chat.current!.messages.at(-1)!)).toHaveLength(2);
    await chat.selectBranch(first);
    expect(conversationBranch(chat.current).map((item) => item.id)).toEqual([
      user,
      first,
      followup,
      continuation,
    ]);
    await chat.load();
    expect(conversationBranch(chat.current).at(-1)?.id).toBe(continuation);
    const retry = retryTurn(chat.current!, first, true);
    expect(retry.user.id).toBe(user);
    expect(chat.current!.messages).toHaveLength(5);
  });

  it('links a Projects repair to its source chat without overwriting its proposal or using an unrelated active chat', async () => {
    const chat = useAssistantConversations();
    await chat.create(null);
    const sourceId = chat.activeId;
    await chat.append('user', 'Organize my collection');
    await chat.append('assistant', 'Saved original proposal', {
      collectionProposalId: 'original-draft',
    });
    const original = structuredClone((await database.assistantThreads.get(sourceId))!.messages);
    await chat.create(null);
    const unrelated = chat.activeId;
    const analysis: CollectionAnalysis = {
      id: 'repair-analysis',
      sourceAnalysisId: 'proposal:original-draft',
      createdAt: 1,
      updatedAt: 1,
      revision: 1,
      purpose: 'proposal',
      instruction: '',
      reuseAcceptedTaxonomyOnly: false,
      scope: [{ id: 'tab', url: 'https://example.test/', navigationVersion: 0 }],
      discoveredIds: [],
      classifiedIds: [],
      projects: [],
      summaries: [],
      assignments: [],
      unresolvedRecordIds: [],
    };
    const link = await chat.connectCollectionAnalysis(analysis, 'Rebuild project structure');
    expect(link.threadId).toBe(sourceId);
    expect(chat.activeId).not.toBe(unrelated);
    expect(chat.current?.messages.slice(0, original.length)).toEqual(original);
    expect(chat.current?.messages.at(-1)?.collectionAnalysisId).toBe(analysis.id);
    expect(chat.current?.messages.at(-1)?.collectionProposalId).toBeUndefined();
    expect(canRetry(chat.current, chat.current!.messages.at(-1)!)).toBe(true);
    expect(await chat.connectCollectionAnalysis(analysis, 'Resume same repair')).toEqual(link);
    expect(chat.current?.messages).toHaveLength(original.length + 2);
    expect((await database.assistantThreads.get(sourceId))?.messages[1]?.collectionProposalId).toBe(
      'original-draft',
    );
  });
  it('creates a dedicated chat for an unlinked analysis and refuses to switch away from a running chat', async () => {
    const chat = useAssistantConversations();
    await chat.create(null);
    const unrelated = chat.activeId;
    const analysis: CollectionAnalysis = {
      id: 'standalone',
      createdAt: 1,
      updatedAt: 1,
      revision: 1,
      purpose: 'proposal',
      instruction: '',
      reuseAcceptedTaxonomyOnly: false,
      scope: [],
      discoveredIds: [],
      classifiedIds: [],
      projects: [],
      summaries: [],
      assignments: [],
      unresolvedRecordIds: [],
    };
    const link = await chat.connectCollectionAnalysis(analysis, 'Organize collection');
    expect(link.threadId).not.toBe(unrelated);
    chat.current!.status = 'running';
    await expect(
      chat.connectCollectionAnalysis({ ...analysis, id: 'other' }, 'Other analysis'),
    ).rejects.toThrow('current chat is running');
    expect(chat.activeId).toBe(link.threadId);
  });
  it('refreshes remote chat progress without marking the run interrupted or overwriting its result', async () => {
    const chat = useAssistantConversations();
    await chat.create(null);
    const id = chat.activeId;
    await chat.append('assistant', 'Preparing', {
      deliveryStatus: 'generating',
      collectionAnalysisId: 'remote-analysis',
    });
    const saved = (await database.assistantThreads.get(id))!;
    saved.status = 'running';
    saved.messages[0]!.activity = ['Classified 40 of 100'];
    await database.assistantThreads.put(saved);
    await chat.refreshRunningThread(id);
    expect(chat.current?.status).toBe('running');
    expect(chat.current?.messages[0]?.activity).toEqual(['Classified 40 of 100']);
    saved.status = 'ready';
    saved.messages[0]!.deliveryStatus = 'complete';
    saved.messages[0]!.collectionProposalId = 'finished-proposal';
    await database.assistantThreads.put(saved);
    await chat.refreshRunningThread(id);
    expect(chat.current?.messages[0]?.collectionProposalId).toBe('finished-proposal');
    expect(chat.current?.status).toBe('ready');
  });
  it('offers retry for older complete turns containing unfinished tool output', async () => {
    const chat = useAssistantConversations();
    await chat.create(null);
    const userId = await chat.append('user', 'Inspect my selected reference');
    const id = await chat.append(
      'assistant',
      '<tool_call><function=list_tabs></function></tool_call>',
      { deliveryStatus: 'complete', requestMessageId: userId },
    );
    expect(canRetry(chat.current, chat.current!.messages.at(-1)!)).toBe(true);
    expect(retryTurn(chat.current!, id).user.id).toBe(userId);
    chat.current!.messages.at(-1)!.content = 'Partial results saved.';
    chat.current!.messages.at(-1)!.activity = [
      'Tool round limit reached; summarizing completed results',
    ];
    expect(canRetry(chat.current, chat.current!.messages.at(-1)!)).toBe(true);
    chat.current!.messages.at(-1)!.activity = [];
    expect(canRetry(chat.current, chat.current!.messages.at(-1)!)).toBe(false);
  });
  it('moves a saved chat between projects without changing its messages', async () => {
    const chat = useAssistantConversations();
    await chat.create(null);
    const id = chat.activeId;
    await chat.append('user', 'Keep this conversation');
    await chat.moveToProject(id, 'project-1');
    expect(chat.current?.projectId).toBe('project-1');
    setActivePinia(createPinia());
    const reloaded = useAssistantConversations();
    await reloaded.load();
    expect(reloaded.current?.projectId).toBe('project-1');
    expect(reloaded.current?.messages[0]?.content).toBe('Keep this conversation');
    await reloaded.moveToProject(id, null);
    expect(reloaded.current?.projectId).toBeNull();
  });
  it('reloads a failed request with its original scope and allows only the latest explicit attempt', async () => {
    const first = useAssistantConversations();
    await first.create('project-1');
    const request = {
      task: 'classify' as const,
      recordIds: ['tab-a', 'tab-b'],
      projectId: 'project-1',
      selectedRecordIds: ['tab-a'],
      allowCrossWindowMove: false,
      allowSleepWake: false,
    };
    const userId = await first.append('user', 'Classify these tabs', { request });
    const failedId = await first.append('assistant', 'Partial result', {
      requestMessageId: userId,
      deliveryStatus: 'error',
      outcome: 'Provider failed',
    });
    setActivePinia(createPinia());
    const resumed = useAssistantConversations();
    await resumed.load();
    const turn = retryTurn(resumed.current!, failedId);
    expect(turn.request).toEqual(request);
    expect(canRetry(resumed.current, turn.failed)).toBe(true);
    expect(resumed.current?.messages.filter((message) => message.role === 'user')).toHaveLength(1);
    const secondId = await resumed.append('assistant', '', {
      request: { ...request, allowSleepWake: true },
      requestMessageId: userId,
      retryOfMessageId: failedId,
      deliveryStatus: 'error',
    });
    expect(canRetry(resumed.current, turn.failed)).toBe(false);
    expect(retryTurn(resumed.current!, secondId).request).toEqual({
      ...request,
      allowSleepWake: true,
    });
    expect(resumed.current?.messages.filter((message) => message.role === 'user')).toHaveLength(1);
  });
  it('keeps a live conversation running when another extension view opens, and excludes concurrent writers', async () => {
    const held = new Set<string>();
    vi.stubGlobal('navigator', {
      locks: {
        query: async () => ({ held: [...held].map((name) => ({ name })) }),
        request: async (
          name: string,
          _options: unknown,
          callback: (lock: { name: string } | null) => Promise<unknown>,
        ) => {
          if (held.has(name)) return callback(null);
          held.add(name);
          try {
            return await callback({ name });
          } finally {
            held.delete(name);
          }
        },
      },
    });
    const first = useAssistantConversations();
    await first.create(null);
    await first.append('assistant', 'Live progress', { deliveryStatus: 'generating' });
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ready = () => {};
    const running = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const turn = first.exclusive(async () => {
      first.current!.status = 'running';
      await first.save();
      ready();
      await gate;
      first.current!.status = 'ready';
      first.current!.messages[0]!.deliveryStatus = 'complete';
      await first.save();
    });
    await running;
    setActivePinia(createPinia());
    const second = useAssistantConversations();
    await second.load();
    expect(second.current?.status).toBe('running');
    second.current!.messages[0]!.content = 'Stale view must not overwrite progress';
    await second.save();
    expect((await database.assistantThreads.get(first.activeId))?.messages[0]?.content).toBe(
      'Live progress',
    );
    await expect(second.exclusive(async () => {})).rejects.toThrow(/another TabFlow view/);
    await expect(second.moveToProject(first.activeId, 'project-1')).rejects.toThrow(
      /another TabFlow view/,
    );
    release();
    await turn;
    await second.select(first.activeId);
    expect(second.current?.status).toBe('ready');
    expect(second.current?.messages[0]?.content).toBe('Live progress');
    await second.moveToProject(first.activeId, 'project-1');
    expect(second.current?.projectId).toBe('project-1');
  });
  it('refreshes a stale thread under an exclusive action so completed artifacts are not replayed', async () => {
    const first = useAssistantConversations();
    await first.create(null);
    await first.append('assistant', 'Reviewed project', {
      projectDraft: { name: 'Project', purpose: '', areaId: null },
    });
    setActivePinia(createPinia());
    const second = useAssistantConversations();
    await second.load();
    first.current!.messages[0]!.completedArtifacts.push('project');
    await first.save();
    await second.exclusive(async () => {
      expect(second.current?.messages[0]?.completedArtifacts).toContain('project');
    });
  });
  it('preserves partial text and completed tool evidence when the dashboard reloads mid-turn', async () => {
    const first = useAssistantConversations();
    await first.create(null);
    first.current!.status = 'running';
    await first.append('assistant', 'Partial server reply', {
      deliveryStatus: 'generating',
      toolEvents: [
        {
          id: 'call',
          tool: 'read_workspace',
          phase: 'returned',
          summary: 'Inventory result',
          createdAt: 1,
        },
      ],
    });
    setActivePinia(createPinia());
    const resumed = useAssistantConversations();
    await resumed.load();
    expect(resumed.current?.status).toBe('interrupted');
    expect(resumed.current?.messages[0]).toMatchObject({
      content: 'Partial server reply',
      deliveryStatus: 'interrupted',
      toolEvents: [{ tool: 'read_workspace', phase: 'returned' }],
    });
  });
  it('bounds long prompt history with explicit omission metadata while retaining the original searchable messages', () => {
    const history = Array.from({ length: 100 }, (_, index) => ({
      role: index % 2 ? ('assistant' as const) : ('user' as const),
      content: `${index}:` + 'long message '.repeat(1000),
    }));
    const compacted = compactConversation(history);
    expect(
      compacted.recent.reduce((size, entry) => size + entry.content.length, 0),
    ).toBeLessThanOrEqual(24000);
    expect(compacted.digest.omittedMessages).toBeGreaterThan(0);
    expect(compacted.digest.clippedMessages).toBeGreaterThan(0);
    expect(compacted.recent.at(-1)?.content.startsWith('99:')).toBe(true);
    expect(history[99]?.content.length).toBeGreaterThan(4000);
    expect(compacted.digest.note).toContain('search_conversation');
  });
  it('serializes progress saves so an earlier checkpoint cannot overwrite later evidence', async () => {
    const chat = useAssistantConversations();
    await chat.create(null);
    await chat.append('assistant', 'First fragment', { deliveryStatus: 'generating' });
    const firstSave = chat.save();
    chat.current!.messages[0]!.content = 'Final fragment';
    chat.current!.messages[0]!.deliveryStatus = 'complete';
    const secondSave = chat.save();
    await Promise.all([firstSave, secondSave]);
    expect((await database.assistantThreads.get(chat.activeId))?.messages[0]?.content).toBe(
      'Final fragment',
    );
  });
  it('restores saved linked results after restart and marks an interrupted run without replaying it', async () => {
    const first = useAssistantConversations();
    await first.create('project-1');
    await first.append('user', 'Find my project references');
    await first.append('assistant', 'One saved reference.', {
      sources: [
        {
          recordId: 'occurrence-1',
          title: 'Reference',
          url: 'https://example.com',
          capturedAt: null,
        },
      ],
      collectionProposalId: 'proposal-1',
      activity: ['Read workspace structure'],
    });
    first.current!.status = 'running';
    await first.save();
    setActivePinia(createPinia());
    const resumed = useAssistantConversations();
    await resumed.load();
    expect(resumed.current?.status).toBe('interrupted');
    expect(resumed.current?.projectId).toBe('project-1');
    expect(resumed.current?.messages).toHaveLength(2);
    expect(resumed.current?.messages[1]?.collectionProposalId).toBe('proposal-1');
    expect(resumed.current?.messages[1]?.sources[0]?.recordId).toBe('occurrence-1');
    expect((await database.assistantThreads.get(first.activeId))?.status).toBe('interrupted');
  });
  it('keeps conversations in separate project contexts', async () => {
    const chat = useAssistantConversations();
    await chat.create('work');
    const workId = chat.activeId;
    await chat.append('user', 'Work project context');
    await chat.create('personal');
    await chat.append('user', 'Personal routine context');
    await chat.select(workId);
    expect(chat.current?.projectId).toBe('work');
    expect(chat.current?.messages.map((message) => message.content)).toEqual([
      'Work project context',
    ]);
    expect(await database.assistantThreads.count()).toBe(2);
  });
});

describe('durable long-run audit', () => {
  it('stores and reloads more than one hundred events independently of bounded message caches', async () => {
    await database.assistantAudit.clear();
    const chat = useAssistantConversations();
    await chat.create(null);
    const messageId = await chat.append('assistant', 'Running');
    for (let i = 0; i < 125; i++)
      await chat.appendAudit(messageId, { text: `Decision batch ${i}` });
    await chat.appendAudit(messageId, {
      event: {
        id: 'call',
        tool: 'list_tabs',
        phase: 'requested',
        summary: 'Requested',
        createdAt: Date.now(),
      },
    });
    await chat.appendAudit(messageId, {
      event: {
        id: 'call',
        tool: 'list_tabs',
        phase: 'returned',
        summary: 'Returned',
        createdAt: Date.now(),
      },
    });
    await chat.save();
    setActivePinia(createPinia());
    const events = await database.assistantAudit
      .where('[messageId+sequence]')
      .between([messageId, 0], [messageId, Number.MAX_SAFE_INTEGER])
      .toArray();
    expect(events).toHaveLength(127);
    expect(events[124]?.text).toBe('Decision batch 124');
    expect(events[125]?.event?.phase).toBe('requested');
    expect(events[126]?.event?.phase).toBe('returned');
    expect(new Set(events.map((item) => item.sequence)).size).toBe(127);
  });
});
