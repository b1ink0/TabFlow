import { stubFetch } from './taxonomy-fixture';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { z } from 'zod';
import {
  generateOrganizationDraft,
  generatePlan,
  models,
  generativeModels,
  decisionModels,
  smallModels,
  generateDailyFocus,
  answerWorkQuestion,
  generateCollectionDraft,
} from '../src/ai/client';
import { DEFAULTS, newRecord } from '../src/shared/model';
import {
  context,
  evidenceBatches,
  modelRequestBudget,
  decisionContextRetryBudget,
} from '../src/ai/context';
import type {
  AppState,
  CollectionAnalysis,
  CollectionDraft,
  CollectionProposal,
} from '../src/shared/types';
import { collectionAnalysisSchema } from '../src/shared/collection-analysis';
import { actionAnalysisSchema } from '../src/shared/action-analysis';
import type { ActionAnalysis } from '../src/shared/types';
const record = {
  ...newRecord('https://github.com/example-org/atlas_planner'),
  title: 'Atlas Planner repository',
  windowId: 1,
  live: true,
};
const app: AppState = {
  records: [record],
  windows: [{ id: 1, focused: true, projectId: null }],
  projects: [],
  areas: [],
  workItems: [],
  categories: [],
  memberships: [],
  proposals: [],
  collectionProposals: [],
  organizationJobs: [],
  groups: [],
  snapshots: [],
  operations: [],
  jobs: [],
  settings: {
    ...DEFAULTS,
    aiMaxAttempts: 3,
    aiModel: 'test-model',
    smallModel: 'small',
    aiStreamResponses: false,
    aiContextTokens: 32768,
    smallContextTokens: 32768,
    decisionContextTokens: 32768,
  },
  version: '0.1.0',
};
const response = (value: unknown) =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
const chatRequestSchema = z.object({
  stream: z.boolean().optional(),
  messages: z.array(
    z.object({
      role: z.string(),
      content: z.string().nullable().optional(),
      reasoning_content: z.string().optional(),
      tool_call_id: z.string().optional(),
      tool_calls: z.array(z.object({ id: z.string() })).optional(),
    }),
  ),
});
afterEach(() => vi.unstubAllGlobals());
describe('SDK adapters', () => {
  it('returns a category proposal without tag requests, including after a saved tag failure', async () => {
    const projects = [
      {
        name: 'Work',
        purpose: 'References',
        areaName: 'Work',
        categories: [{ name: 'Docs', description: 'Documentation' }],
      },
    ];
    const assignment = {
      recordId: record.id,
      url: record.url,
      navigationVersion: record.navigationVersion,
      projectName: 'Work',
      categoryName: 'Docs',
      reason: 'Saved category',
      confidence: 0.9,
    };
    let saved: CollectionAnalysis = {
      id: 'categories-ready',
      decisionContract: 'isolated-evidence-v2',
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
      purpose: 'proposal',
      instruction: '',
      reuseAcceptedTaxonomyOnly: true,
      scope: [{ id: record.id, url: record.url, navigationVersion: record.navigationVersion }],
      discoveredIds: [record.id],
      classifiedIds: [record.id],
      projects,
      assignments: [assignment],
      unresolvedRecordIds: [],
      summaries: [],
      tagVocabulary: Array.from({ length: 300 }, (_, i) => `tag-${i}`),
      failedBatch: {
        stage: 'tagging',
        recordIds: [record.id],
        attempts: 3,
        error: 'Unavailable tag server',
        failedAt: 1,
      },
    };
    const fetchMock = vi.fn(() => {
      throw new Error('No model request should be needed');
    });
    vi.stubGlobal('fetch', fetchMock);
    const draft = await generateCollectionDraft(app, {
      reuseAcceptedTaxonomyOnly: true,
      seedProjects: projects,
      checkpoint: { id: saved.id, load: async () => saved, save: async (row) => (saved = row) },
    });
    expect(draft.assignments).toEqual([assignment]);
    expect(draft.unresolvedRecordIds).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(saved.failedBatch).toBeUndefined();
  });
  it('reserves chat output only for chat roles and learns an explicit server context rejection', () => {
    const fixture = {
      ...app,
      settings: { ...app.settings, decisionContextTokens: 4096, smallCompletionTokens: 65536 },
    };
    expect(modelRequestBudget(fixture, 'decision')).toBe(3072);
    expect(() => modelRequestBudget(fixture, 'small')).toThrow(/thinking\/output/);
    expect(
      decisionContextRetryBudget(
        new Error(
          '400 request (6040 tokens) exceeds the available context size (4096 tokens), try increasing it',
        ),
        { state: 'x'.repeat(6000) },
        7168,
      ),
    ).toBeLessThanOrEqual(3072);
    expect(decisionContextRetryBudget(new Error('500 unavailable'), {}, 3072)).toBeUndefined();
  });
  for (const failedStage of ['category', 'tag'] as const) {
    it(`resumes isolated ${failedStage} failures across 100 occurrences and 200 proposed-tag verifications`, async () => {
      const records = Array.from({ length: 100 }, (_, index) => ({
        ...record,
        id: `isolated-${index}`,
        title: `Reference ${index}`,
        url: `https://fixture.test/r/${index}`,
      }));
      const fixture = {
        ...app,
        records,
        tagVocabulary: ['reference', 'research'],
        settings: {
          ...app.settings,
          useDedicatedDecisionModel: true,
          decisionModel: 'bounded',
          decisionBase: 'http://127.0.0.1:8080',
          decisionContextTokens: 4096,
          smallCompletionTokens: 2048,
          smallModel: 'tag-chat',
          smallContextTokens: 32768,
          tagVerification: 'decision' as const,
        },
      };
      let saved: CollectionAnalysis | undefined,
        fail = true;
      const completed: string[] = [],
        tagKeys: string[] = [];
      let categoryAttempts = 0,
        tagAttempts = 0;
      const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const raw = JSON.parse(String(init?.body));
        if (raw.messages)
          return response({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    tags: [
                      { name: 'reference', source: 'title', quote: 'Reference' },
                      { name: 'research', source: 'url', quote: 'fixture.test' },
                    ],
                    newTags: [],
                    uncertain: false,
                  }),
                },
                finish_reason: 'stop',
              },
            ],
          });
        const request = z
          .object({
            state: z.string(),
            questions: z.record(
              z.string(),
              z.object({ type: z.string(), instructions: z.string() }),
            ),
          })
          .parse(JSON.parse(String(init?.body)));
        const isTag = Object.keys(request.questions)[0]?.startsWith('tag_');
        if (!isTag) {
          const match = /fixture\.test\/r\/(\d+)/.exec(
            Object.values(request.questions)[0]!.instructions,
          );
          if (!match) throw Error('Missing isolated page evidence');
          expect(Object.keys(request.questions)).toHaveLength(1);
          if (failedStage === 'category' && fail && completed.length >= 10) {
            categoryAttempts++;
            return response({
              model: 'bounded',
              answers: {},
              usage: { input_tokens: 40, output_tokens: 0 },
            });
          }
          completed.push(`isolated-${match[1]}`);
          return response({
            model: 'bounded',
            answers: {
              tab_0: {
                type: 'choice',
                choice: 'c0',
                confidence: 0.95,
                probabilities: { c0: 0.95, keep: 0.05 },
              },
            },
            usage: { input_tokens: 40, output_tokens: 0 },
          });
        }
        const state = z
          .object({ page: z.object({ url: z.string() }) })
          .parse(JSON.parse(request.state));
        const entries = Object.entries(request.questions).map(([key, q]) => {
          const match = /tag ("[^"\n]+")/.exec(q.instructions);
          if (!match) throw Error('Missing literal tag');
          return { key, tag: z.string().parse(JSON.parse(match[1]!)) };
        });
        if (failedStage === 'tag' && fail && tagKeys.length) {
          tagAttempts++;
          return response({
            model: 'bounded',
            answers: {},
            usage: { input_tokens: 40, output_tokens: 0 },
          });
        }
        tagKeys.push(
          ...entries.map((item) =>
            JSON.stringify([`isolated-${/r\/(\d+)/.exec(state.page.url)?.[1]}`, item.tag]),
          ),
        );
        return response({
          model: 'bounded',
          answers: Object.fromEntries(
            entries.map((item) => [
              item.key,
              {
                type: 'choice',
                choice: 'yes',
                confidence: 0.95,
                probabilities: { yes: 0.95, no: 0.05 },
              },
            ]),
          ),
          usage: { input_tokens: 40, output_tokens: 0 },
        });
      });
      stubFetch('fetch', fetchMock, { tags: false });
      const tagRows = new Map<string, import('../src/shared/tag-analysis').TagAnalysis>();
      const options = {
        reuseAcceptedTaxonomyOnly: true,
        includeTags: true,
        seedProjects: [
          {
            name: 'Work',
            purpose: 'References',
            areaName: 'Work',
            categories: [{ name: 'Docs', description: 'Reference documentation' }],
          },
        ],
        checkpoint: {
          id: `isolated-${failedStage}`,
          tags: {
            analysisId: `isolated-${failedStage}`,
            load: async () => [...tagRows.values()],
            save: async (row: import('../src/shared/tag-analysis').TagAnalysis) => {
              tagRows.set(row.id, structuredClone(row));
            },
          },
          load: async () => saved,
          save: async (value: CollectionAnalysis) => {
            saved = collectionAnalysisSchema.parse(value);
            return saved;
          },
        },
      };
      await expect(generateCollectionDraft(fixture, options)).rejects.toThrow(
        'failed after 3 attempts',
      );
      expect(saved?.classifiedIds.length).toBeGreaterThanOrEqual(10);
      if (failedStage === 'tag')
        expect([...tagRows.values()].some((row) => row.decisions.length)).toBe(true);
      fail = false;
      const draft = await generateCollectionDraft(
        { ...fixture, settings: { ...fixture.settings, decisionModel: 'replacement' } },
        options,
      );
      expect(draft.assignments).toHaveLength(100);
      expect(completed).toHaveLength(100);
      expect(new Set(completed).size).toBe(100);
      expect(tagKeys).toHaveLength(200);
      expect(new Set(tagKeys).size).toBe(200);
      expect(draft.assignments.every((item) => item.suggestedTags?.length === 2)).toBe(true);
      expect(failedStage === 'tag' ? tagAttempts : categoryAttempts).toBe(
        failedStage === 'tag' ? 300 : 3,
      );
    });
  }
  it('gives AI explicit Inbox membership rather than a bound-window project hint', () => {
    const inboxRecord = { ...record, projectId: 'project' };
    const evidence = context(
      {
        ...app,
        records: [inboxRecord],
        projects: [
          {
            id: 'project',
            name: 'Research',
            purpose: '',
            areaId: null,
            updatedAt: 1,
            revision: 1,
            maintainReviewQueue: false,
          },
        ],
        memberships: [
          { recordId: record.id, projectId: null, categoryId: null, source: 'owner', updatedAt: 1 },
        ],
      },
      [inboxRecord],
    );
    expect(evidence.tabs[0]?.project).toBeNull();
  });
  it('bounds cached evidence without changing originals or dropping duplicate occurrences', () => {
    const records = Array.from({ length: 40 }, (_, index) => ({
      ...record,
      id: `bounded-${index}`,
      note: 'n'.repeat(10000),
      content: {
        title: record.title,
        url: record.url,
        description: 'd'.repeat(1000),
        headings: Array.from({ length: 30 }, () => 'h'.repeat(300)),
        text: 'x'.repeat(100000),
        capturedAt: 1,
        scroll: 0,
        dirty: false,
        playing: false,
      },
    }));
    const batches = evidenceBatches(app, records, 40, 16000);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flat().map((item) => item.id)).toEqual(records.map((item) => item.id));
    for (const batch of batches)
      expect(JSON.stringify(context(app, batch).tabs).length).toBeLessThan(16100);
    expect(context(app, records).tabs[0]?.content).toMatchObject({ truncated: true });
    expect(context(app, records, false).tabs[0]?.content).toBeNull();
    expect(records[0]?.content.text.length).toBe(100000);
    expect(records[0]?.note.length).toBe(10000);
    expect(
      evidenceBatches(
        { ...app, settings: { ...app.settings, aiEvidenceCharacters: 0 } },
        records,
        40,
      ),
    ).toHaveLength(1);
    expect(context(app, records).tabs[0]?.content?.text.length).toBe(app.settings.textLimit);
  });
  it('reports exhausted reasoning/output budgets before parsing incomplete JSON', async () => {
    stubFetch(
      'fetch',
      vi.fn(async () =>
        response({ choices: [{ finish_reason: 'length', message: { content: '{"summary":' } }] }),
      ),
    );
    await expect(generatePlan(app, [record], 'Group this reference')).rejects.toThrow(
      /thinking\/output budget/,
    );
  });
  it.each([
    {
      query: '',
      projectId: null,
      windowId: null,
      offset: 0,
      total: 329,
      count: 30,
      nextOffset: 30,
    },
    {
      query: '',
      projectId: null,
      windowId: null,
      offset: 300,
      total: 329,
      count: 29,
      nextOffset: null,
    },
    {
      query: '',
      projectId: null,
      windowId: null,
      offset: 330,
      total: 329,
      count: 0,
      nextOffset: null,
      emptyReason: 'offset_past_end',
    },
    {
      query: 'no-matching-title',
      projectId: null,
      windowId: null,
      offset: 0,
      total: 0,
      count: 0,
      nextOffset: null,
      emptyReason: 'no_filter_matches',
    },
    {
      query: '',
      projectId: 'project-id',
      windowId: null,
      offset: 0,
      total: 1,
      count: 1,
      nextOffset: null,
    },
    { query: '', projectId: null, windowId: 0, offset: 0, total: 329, count: 30, nextOffset: 30 },
    {
      query: '',
      projectId: 'missing-project',
      windowId: null,
      offset: 0,
      error: 'Unknown projectId',
    },
    { query: '', projectId: null, windowId: 9999, offset: 0, error: 'Unknown windowId' },
    {
      query: '',
      projectId: 'null',
      windowId: null,
      offset: 0,
      total: 329,
      count: 30,
      nextOffset: 30,
    },
  ])(
    'keeps tab inventory and filters explicit: $query/$projectId/$windowId/$offset',
    async (testCase) => {
      const records = Array.from({ length: 329 }, (_, index) => ({
        ...record,
        id: `occurrence-${index}`,
        windowId: index < 200 ? 1 : 2,
        suspended: true,
      }));
      const inventory: AppState = {
        ...app,
        records: [...records, { ...record, id: 'closed-occurrence', live: false }],
        windows: [...app.windows, { id: 2, focused: false, projectId: null }],
        projects: [
          {
            id: 'project-id',
            name: 'Project',
            purpose: '',
            updatedAt: 1,
            revision: 1,
            maintainReviewQueue: false,
          },
        ],
        memberships: [
          {
            recordId: records[0]!.id,
            projectId: 'project-id',
            categoryId: null,
            source: 'owner',
            updatedAt: 1,
          },
        ],
      };
      const args = {
        query: testCase.query,
        projectId: testCase.projectId,
        windowId: testCase.windowId,
        offset: testCase.offset,
      };
      let calls = 0;
      const results: string[] = [];
      const fetchMock = vi.fn(async (_input, init) => {
        const body = chatRequestSchema.parse(JSON.parse(String(init?.body)));
        const step = calls++;
        if (step > 0) results.push(body.messages.at(-1)?.content || '');
        return response({
          id: `listing-${step}`,
          object: 'chat.completion',
          created: 1,
          model: 'test-model',
          choices: [
            {
              index: 0,
              finish_reason: step < 2 ? 'tool_calls' : 'stop',
              message:
                step < 2
                  ? {
                      role: 'assistant',
                      content: null,
                      tool_calls: [
                        {
                          id: `listing-call-${step}`,
                          type: 'function',
                          function: {
                            name: step === 0 ? 'read_workspace' : 'list_tabs',
                            arguments: step === 0 ? '{}' : JSON.stringify(args),
                          },
                        },
                      ],
                    }
                  : { role: 'assistant', content: 'Inventory checked.' },
            },
          ],
        });
      });
      stubFetch('fetch', fetchMock);
      const audit: string[] = [];
      const result = await answerWorkQuestion(inventory, 'List my tabs', [], undefined, {
        onToolEvent: async (event) => {
          if (event.phase === 'requested') audit.push(event.summary);
        },
      });
      expect(
        z
          .object({ tabCount: z.number(), storedOccurrenceCount: z.number() })
          .parse(JSON.parse(results[0]!)),
      ).toEqual({ tabCount: 329, storedOccurrenceCount: 330 });
      if (testCase.error) {
        const failure = z
          .object({ ok: z.boolean(), error: z.string() })
          .parse(JSON.parse(results[1]!));
        expect(failure.ok).toBe(false);
        expect(failure.error).toContain(testCase.error);
      } else {
        const page = z
          .object({
            total: z.number(),
            liveTabCount: z.number(),
            offset: z.number(),
            nextOffset: z.number().nullable(),
            tabs: z.array(z.object({ id: z.string(), suspended: z.boolean() })),
            emptyReason: z.string().optional(),
            filters: z.object({
              query: z.string(),
              projectId: z.string().nullable(),
              windowId: z.number().nullable(),
            }),
          })
          .parse(JSON.parse(results[1]!));
        expect(page).toMatchObject({
          total: testCase.total,
          liveTabCount: 329,
          offset: testCase.offset,
          nextOffset: testCase.nextOffset,
          filters: {
            query: args.query,
            projectId: args.projectId === 'null' ? null : args.projectId,
            windowId: args.windowId === 0 ? null : args.windowId,
          },
        });
        expect(page.tabs).toHaveLength(testCase.count!);
        expect(new Set(page.tabs.map((tab) => tab.id)).size).toBe(testCase.count);
        expect(page.tabs.every((tab) => tab.suspended)).toBe(true);
        expect(page.emptyReason).toBe(testCase.emptyReason);
        expect(result.sources).toHaveLength(testCase.count!);
      }
      expect(audit[1]).toContain(JSON.stringify(args));
    },
  );
  it('supports a first-position-only system template through a non-streaming tool continuation', async () => {
    let calls = 0;
    const fetchMock = vi.fn(async (_input, init) => {
      const body = chatRequestSchema.parse(JSON.parse(String(init?.body)));
      if (body.messages.some((message, index) => message.role === 'system' && index !== 0))
        return new Response(
          JSON.stringify({
            error: { message: 'System message must be at the beginning.', type: 'server_error' },
          }),
          { status: 500, headers: { 'content-type': 'application/json' } },
        );
      expect(body.messages[0]?.role).toBe('system');
      const first = calls++ === 0;
      if (!first)
        expect(body.messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'read-call' });
      return response({
        id: `completion-${calls}`,
        object: 'chat.completion',
        created: 1,
        model: 'test-model',
        choices: [
          {
            index: 0,
            finish_reason: first ? 'tool_calls' : 'stop',
            message: first
              ? {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'read-call',
                      type: 'function',
                      function: { name: 'read_workspace', arguments: '{}' },
                    },
                  ],
                }
              : { role: 'assistant', content: 'Workspace checked.' },
          },
        ],
      });
    });
    stubFetch('fetch', fetchMock);
    const result = await answerWorkQuestion(app, 'Check my workspace', [
      { role: 'user', content: 'Previous request' },
      { role: 'assistant', content: 'Previous reply' },
    ]);
    expect(result.answer).toBe('Workspace checked.');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('streams real text, checkpoints tool results, and carries streamed reasoning into the next tool request', async () => {
    const thoughts: Array<{ text: string; streaming: boolean }> = [];
    const events: Array<{ tool: string; phase: string }> = [];
    const texts: string[] = [];
    const sse = (id: string, deltas: unknown[]) =>
      new Response(
        deltas
          .map(
            (delta) =>
              `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [delta] })}\n\n`,
          )
          .join('') + 'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async (_input, init) => {
        const body = chatRequestSchema.parse(JSON.parse(String(init?.body)));
        expect(body.stream).toBe(true);
        expect(body.messages.map((message) => message.role)).toEqual([
          'system',
          'user',
          'assistant',
          'user',
        ]);
        expect(body.messages[0]?.content).toContain('compactedConversationData');
        expect(body.messages[0]?.content).toContain('changesRequireOwnerApply');
        expect(body.messages[1]?.content).toBe('Earlier question');
        expect(body.messages[2]?.content).toBe('Earlier answer');
        return sse('first', [
          {
            index: 0,
            delta: {
              role: 'assistant',
              reasoning_content: 'Actual server reasoning',
              tool_calls: [
                {
                  index: 0,
                  id: 'workspace-call',
                  type: 'function',
                  function: { name: 'read_workspace', arguments: '{}' },
                },
              ],
            },
            finish_reason: null,
          },
          { index: 0, delta: {}, finish_reason: 'tool_calls' },
        ]);
      })
      .mockImplementationOnce(async (_input, init) => {
        const body = chatRequestSchema.parse(JSON.parse(String(init?.body)));
        expect(body.messages.filter((message) => message.role === 'system')).toHaveLength(1);
        expect(body.messages[0]?.role).toBe('system');
        expect(body.messages.at(-1)).toMatchObject({
          role: 'tool',
          tool_call_id: 'workspace-call',
        });
        expect(
          body.messages.find((message) =>
            message.tool_calls?.some((call) => call.id === 'workspace-call'),
          )?.reasoning_content,
        ).toBe('Actual server reasoning');
        expect(events.map((event) => event.phase)).toEqual(['requested', 'returned']);
        return sse('second', [
          { index: 0, delta: { role: 'assistant', content: 'Grounded ' }, finish_reason: null },
          { index: 0, delta: { content: 'answer.' }, finish_reason: null },
          { index: 0, delta: {}, finish_reason: 'stop' },
        ]);
      });
    stubFetch('fetch', fetchMock);
    const checkpoint = vi.fn(async () => {});
    const answer = await answerWorkQuestion(
      { ...app, settings: { ...app.settings, aiStreamResponses: true } },
      'Read my workspace',
      [
        { role: 'user', content: 'Earlier question' },
        { role: 'assistant', content: 'Earlier answer' },
      ],
      undefined,
      {
        onText: (text) => texts.push(text),
        onReasoning: (text, streaming) => thoughts.push({ text, streaming }),
        onToolEvent: async (event) => {
          events.push(event);
        },
        onCheckpoint: checkpoint,
      },
    );
    expect(answer.answer).toBe('Grounded answer.');
    expect(texts).toContain('Grounded ');
    expect(texts.at(-1)).toBe('Grounded answer.');
    expect(checkpoint).toHaveBeenCalledTimes(2);
    expect(events.every((event) => event.tool === 'read_workspace')).toBe(true);
    expect(thoughts).toContainEqual({ text: 'Actual server reasoning', streaming: true });
    expect(thoughts).toContainEqual({ text: 'Actual server reasoning', streaming: false });
    expect(JSON.stringify(answer)).not.toContain('Actual server reasoning');
    expect(JSON.stringify(events)).not.toContain('Actual server reasoning');
  });
  it('classifies a bounded new-tab scope using accepted taxonomy and only the small model', async () => {
    const untouched = { ...newRecord('https://example.com/personal'), live: true };
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      expect(String(url)).toContain('localhost:8080/v1/chat/completions');
      const body = JSON.parse(String(init?.body)) as { model: string };
      expect(body.model).toBe('small-classifier');
      return response({
        choices: [
          {
            message: {
              content: JSON.stringify({
                assignments: [
                  {
                    recordId: record.id,
                    choice: 'c0',
                    confidence: 0.9,
                    reason: 'Known source repository',
                  },
                ],
              }),
            },
          },
        ],
      });
    });
    stubFetch('fetch', fetchMock);
    const draft = await generateCollectionDraft(
      {
        ...app,
        records: [record, untouched],
        projects: [
          {
            id: 'p',
            name: 'Atlas Planner',
            purpose: 'Project source',
            areaId: null,
            updatedAt: 1,
            revision: 1,
            maintainReviewQueue: false,
          },
        ],
        categories: [
          {
            id: 'c',
            projectId: 'p',
            name: 'Source',
            description: 'Source repository',
            order: 0,
            updatedAt: 1,
            revision: 1,
          },
        ],
        settings: {
          ...DEFAULTS,
          smallContextTokens: 32768,
          aiModel: '',
          smallModelBase: 'http://localhost:8080/v1',
          smallModel: 'small-classifier',
        },
      },
      { recordIds: [record.id], reuseAcceptedTaxonomyOnly: true },
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(draft.scopeRecordIds).toEqual([record.id]);
    expect(draft.unresolvedRecordIds).toEqual([]);
    expect(draft.assignments[0]?.projectName).toBe('Atlas Planner');
  });
  it('prepares an inspection action with original-page fingerprints and never queues it during inference', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'inspect-call',
                    type: 'function',
                    function: {
                      name: 'prepare_page_inspection',
                      arguments: JSON.stringify({ recordIds: [record.id] }),
                    },
                  },
                ],
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        response({
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'Review inspection of the source page before granting access.',
              },
            },
          ],
        }),
      );
    stubFetch('fetch', fetchMock);
    const result = await answerWorkQuestion(app, 'Inspect this source to understand the project');
    expect(result.command).toMatchObject({
      kind: 'inspect',
      recordIds: [record.id],
      expected: { [record.id]: { url: record.url, navigationVersion: record.navigationVersion } },
    });
    expect(app.jobs).toEqual([]);
  });
  it('preserves a local thinking model’s reasoning across SDK tool calls and uses its configured budget', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                reasoning_content: 'Private server reasoning state',
                tool_calls: [
                  {
                    id: 'reasoning-call',
                    type: 'function',
                    function: {
                      name: 'search_work',
                      arguments: JSON.stringify({ query: 'Atlas Planner' }),
                    },
                  },
                ],
              },
            },
          ],
        }),
      )
      .mockImplementationOnce(async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as {
          reasoning_effort: string;
          max_completion_tokens: number;
          temperature?: number;
          messages: Array<{ role: string; reasoning_content?: string }>;
        };
        expect(body.reasoning_effort).toBe('high');
        expect(body.max_completion_tokens).toBe(16384);
        expect(body.temperature).toBeUndefined();
        expect(
          body.messages.find((message) => message.role === 'assistant')?.reasoning_content,
        ).toBe('Private server reasoning state');
        return response({
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'Your Atlas Planner source is an open reference.',
              },
            },
          ],
        });
      });
    stubFetch('fetch', fetchMock);
    const result = await answerWorkQuestion(
      {
        ...app,
        settings: {
          ...app.settings,
          aiReasoningEffort: 'high',
          aiCompletionTokens: 16384,
          aiTokenField: 'max_completion_tokens',
        },
      },
      'Find the Atlas Planner reference',
    );
    expect(result.sources).toMatchObject([
      { recordId: record.id, url: record.url, capturedAt: null },
    ]);
    expect(result.activity).toContain('Searched work and tabs · Atlas Planner');
    expect(JSON.stringify(result)).not.toContain('Private server reasoning state');
  });
  it('lets the large orchestrator prepare a saved collection proposal while the small model makes final choices', async () => {
    const draftResult = {
      summary: 'Source references',
      projects: [
        {
          name: 'Atlas Planner',
          purpose: 'Understand the source',
          areaName: 'Work',
          categories: [{ name: 'Sources', description: 'Original source repositories' }],
        },
      ],
      assignments: [
        {
          recordId: record.id,
          projectName: 'Atlas Planner',
          categoryName: 'Sources',
          reason: 'Source repository',
          confidence: 0.9,
        },
      ],
      unresolvedRecordIds: [],
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'organize-call',
                    type: 'function',
                    function: {
                      name: 'prepare_whole_collection_organization',
                      arguments: JSON.stringify({ confirmation: 'prepare_reviewable_proposal' }),
                    },
                  },
                ],
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        response({ choices: [{ message: { content: JSON.stringify(draftResult) } }] }),
      )
      .mockImplementationOnce(async (input, init) => {
        const body = JSON.parse(String(init?.body)) as { model: string };
        expect(body.model).toBe('small-classifier');
        expect(String(input)).toContain('localhost:8080/v1/chat/completions');
        return response({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  assignments: [
                    {
                      recordId: record.id,
                      choice: 'c0',
                      confidence: 0.9,
                      reason: 'Actual source repository URL',
                    },
                  ],
                }),
              },
            },
          ],
        });
      })
      .mockResolvedValueOnce(
        response({
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'I prepared the Atlas Planner organization. Review before applying.',
              },
            },
          ],
        }),
      );
    stubFetch('fetch', fetchMock);
    const persist = vi.fn(async (_draft: CollectionDraft) => {});
    const result = await answerWorkQuestion(
      {
        ...app,
        settings: {
          ...app.settings,
          smallModelBase: 'http://localhost:8080/v1',
          smallModel: 'small-classifier',
        },
      },
      'Organize my whole collection into projects',
      [],
      undefined,
      { onCollectionDraft: persist },
    );
    expect(result.collectionPrepared).toBe(true);
    expect(persist).toHaveBeenCalledOnce();
    expect(persist.mock.calls[0]?.[0].assignments).toMatchObject([
      { recordId: record.id, projectName: 'Atlas Planner' },
    ]);
    expect(persist.mock.calls[0]?.[0].model).toBe('test-model → small-classifier');
    expect(app.memberships).toEqual([]);
  });
  it('refines the same pending taxonomy and persists conversational assignment corrections for review', async () => {
    const pending: CollectionProposal = {
      id: 'saved-proposal',
      createdAt: 1,
      status: 'pending',
      summary: 'Source references',
      projects: [
        {
          name: 'Work',
          purpose: '',
          areaName: 'Work',
          categories: [{ name: 'Research', description: '' }],
        },
      ],
      assignments: [
        {
          recordId: record.id,
          url: record.url,
          navigationVersion: record.navigationVersion,
          projectName: 'Work',
          categoryName: 'Research',
          reason: 'Repository',
          confidence: 0.9,
        },
      ],
      unresolvedRecordIds: [],
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'refine-call',
                    type: 'function',
                    function: {
                      name: 'refine_organization_proposal',
                      arguments: JSON.stringify({
                        proposalId: pending.id,
                        projectEdits: [
                          {
                            previousName: 'Work',
                            name: 'Atlas Planner',
                            purpose: 'Read source code',
                            areaName: 'Work',
                          },
                        ],
                        categoryEdits: [
                          {
                            projectName: 'Atlas Planner',
                            previousName: 'Research',
                            name: 'Reference material',
                            description: 'Sources to read',
                          },
                        ],
                        tagEdits: [{ recordId: record.id, suggestedTags: ['reference', 'Vue'] }],
                        assignments: [
                          {
                            recordId: record.id,
                            projectName: 'Atlas Planner',
                            categoryName: 'Reference material',
                          },
                        ],
                      }),
                    },
                  },
                ],
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        response({
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'I revised the saved proposal. Your correction is recorded for review.',
              },
            },
          ],
        }),
      );
    stubFetch('fetch', fetchMock);
    const persist = vi.fn(async (_draft: CollectionDraft, _id?: string) => {});
    const result = await answerWorkQuestion(
      { ...app, collectionProposals: [pending] },
      'Rename Work to Atlas Planner and keep this source as reference material',
      [],
      undefined,
      { onCollectionDraft: persist },
    );
    expect(result.collectionPrepared).toBe(true);
    expect(persist.mock.calls[0]?.[1]).toBe(pending.id);
    expect(persist.mock.calls[0]?.[0].ownerAssignedRecordIds).toEqual([record.id]);
    expect(persist.mock.calls[0]?.[0].assignments[0]).toMatchObject({
      projectName: 'Atlas Planner',
      categoryName: 'Reference material',
      reason: 'Owner correction through conversation.',
      suggestedTags: ['reference', 'Vue'],
    });
    expect(pending.projects[0]?.name).toBe('Work');
  });
  it('keeps low-scored collection choices uncertain and supplies native group names as evidence', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
        expect(body.messages.at(-1)?.content).toContain('Owner source references');
        expect(body.messages[0]?.content).toContain(
          'Multiple projects can share one browser window',
        );
        expect(body.messages[0]?.content).not.toContain(
          'Each assigned project creates a native browser window',
        );
        return response({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  summary: 'Source references',
                  projects: [
                    {
                      name: 'Work',
                      purpose: '',
                      areaName: 'Work',
                      categories: [{ name: 'Sources', description: '' }],
                    },
                  ],
                  assignments: [
                    {
                      recordId: record.id,
                      projectName: 'Work',
                      categoryName: 'Sources',
                      reason: 'Repository',
                      confidence: 0.9,
                    },
                  ],
                  unresolvedRecordIds: [],
                }),
              },
            },
          ],
        });
      })
      .mockResolvedValueOnce(
        response({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  assignments: [
                    {
                      recordId: record.id,
                      choice: 'c0',
                      confidence: 0.2,
                      reason: 'Ambiguous context',
                    },
                  ],
                }),
              },
            },
          ],
        }),
      );
    stubFetch('fetch', fetchMock);
    const result = await generateCollectionDraft({
      ...app,
      records: [{ ...record, groupId: 9 }],
      groups: [
        {
          id: 9,
          windowId: 1,
          title: 'Owner source references',
          color: 'grey',
          collapsed: false,
          shared: false,
        },
      ],
      settings: { ...app.settings, smallModel: 'small' },
    });
    expect(result.assignments).toEqual([]);
    expect(result.unresolvedRecordIds).toEqual([record.id]);
  });
  it('retries a malformed classifier batch without dropping the remaining collection', async () => {
    const second = {
      ...newRecord('https://example.com/second'),
      id: 'second-occurrence',
      title: 'Second',
      windowId: 1,
      live: true,
    };
    let smallCalls = 0;
    stubFetch(
      'fetch',
      vi.fn(async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { model: string };
        if (body.model === 'small-classifier') {
          smallCalls++;
          const request = chatRequestSchema.parse(JSON.parse(String(init?.body)));
          const targets = z
            .object({ tabs: z.array(z.object({ id: z.string() })) })
            .parse(JSON.parse(request.messages.at(-1)?.content || '{}')).tabs;
          return response({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    assignments:
                      smallCalls === 1
                        ? [
                            { recordId: 'invented', choice: 'c0', reason: '', confidence: 0.9 },
                            { recordId: 'invented', choice: 'c0', reason: '', confidence: 0.9 },
                          ]
                        : targets.map(({ id }) => ({
                            recordId: id,
                            choice: 'c0',
                            reason: 'Reference URL',
                            confidence: 0.9,
                          })),
                  }),
                },
              },
            ],
          });
        }
        return response({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  summary: 'Reference collection',
                  projects: [
                    {
                      name: 'Research',
                      purpose: 'References',
                      areaName: 'Personal',
                      categories: [{ name: 'Sources', description: 'Reference tabs' }],
                    },
                  ],
                }),
              },
            },
          ],
        });
      }),
    );
    const draft = await generateCollectionDraft({
      ...app,
      records: [record, second],
      settings: { ...app.settings, smallModel: 'small-classifier', aiBatchSize: 2 },
    });
    expect(smallCalls).toBe(3);
    expect(draft.scopeRecordIds).toEqual([record.id, second.id]);
    expect(draft.assignments.map((item) => item.recordId)).toEqual([record.id, second.id]);
  });
  it('drafts a validated semantic project structure without browser actions', async () => {
    const project = {
      id: 'project-1',
      name: 'Research',
      purpose: 'Compare source material',
      revision: 1,
      updatedAt: 1,
      maintainReviewQueue: false,
    };
    stubFetch(
      'fetch',
      vi.fn(async (_url, init) =>
        JSON.parse(String(init?.body)).model === 'small-classifier'
          ? response({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      assignments: [
                        {
                          recordId: record.id,
                          choice: 'c0',
                          reason: 'Small model independently matched the source repository.',
                          confidence: 0.86,
                        },
                      ],
                    }),
                  },
                },
              ],
            })
          : response({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      summary: 'Repository source for the research project.',
                      projectSuggestion: {
                        name: 'Atlas Planner research',
                        purpose: 'Understand the Atlas Planner project and its implementation.',
                      },
                      categories: [
                        { name: 'Primary sources', description: 'Original project repositories.' },
                      ],
                      assignments: [
                        {
                          recordId: record.id,
                          categoryName: 'Primary sources',
                          reason: 'The title identifies the source repository.',
                          confidence: 0.91,
                        },
                      ],
                      unresolvedRecordIds: [],
                    }),
                  },
                },
              ],
            }),
      ),
    );
    const draft = await generateOrganizationDraft(
      { ...app, settings: { ...app.settings, smallModel: 'small-classifier' } },
      project,
      [record],
    );
    expect(draft.projectRevision).toBe(project.revision);
    expect(draft.projectSuggestion?.name).toBe('Atlas Planner research');
    expect(draft.categories[0]?.name).toBe('Primary sources');
    expect(draft.assignments[0]).toMatchObject({ recordId: record.id, url: record.url });
    expect(draft.assignments[0]?.reason).toBe(
      'Small model independently matched the source repository.',
    );
    expect(draft.assignments[0]?.confidence).toBe(0.86);
  });
  it('rejects an invented classifier occurrence after three attempts', async () => {
    const project = {
      id: 'project-1',
      name: 'Research',
      purpose: '',
      revision: 1,
      updatedAt: 1,
      maintainReviewQueue: false,
    };
    let turn = 0;
    stubFetch(
      'fetch',
      vi.fn(async () =>
        response({
          choices: [
            {
              message: {
                content: JSON.stringify(
                  turn++ === 0
                    ? {
                        summary: '',
                        projectSuggestion: { name: 'Research', purpose: '' },
                        categories: [{ name: 'Research', description: '' }],
                      }
                    : {
                        assignments: [
                          { recordId: 'invented', choice: 'c0', reason: '', confidence: 0.9 },
                        ],
                      },
                ),
              },
            },
          ],
        }),
      ),
    );
    await expect(
      generateOrganizationDraft(
        { ...app, settings: { ...app.settings, smallModel: 'small-classifier' } },
        project,
        [record],
      ),
    ).rejects.toThrow(/occurrence IDs/);
    expect(turn).toBe(4);
  });
  it('resumes a project draft from its failed classifier batch without repeating completed model calls', async () => {
    const project = {
      id: 'project-1',
      name: 'Research',
      purpose: '',
      revision: 1,
      updatedAt: 1,
      maintainReviewQueue: false,
    };
    const second = { ...record, id: 'second-occurrence', title: 'Second reference' };
    const state: AppState = {
      ...app,
      records: [record, second],
      categories: [
        {
          id: 'sources',
          projectId: project.id,
          name: 'Sources',
          description: 'References',
          order: 0,
          updatedAt: 1,
          revision: 1,
        },
      ],
      settings: { ...app.settings, aiBatchSize: 1, smallModel: 'small-classifier' },
    };
    let saved: CollectionAnalysis | undefined;
    let recovered = false;
    let discoveryCalls = 0;
    const classifierCalls: string[] = [];
    stubFetch(
      'fetch',
      vi.fn(async (_url, init) => {
        const body = z
          .object({
            model: z.string(),
            messages: z.array(z.object({ content: z.string().nullable().optional() })),
          })
          .parse(JSON.parse(String(init?.body)));
        const input = body.messages.at(-1)?.content || '';
        if (body.model === 'test-model') {
          discoveryCalls++;
          return response({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    summary: 'Reference grouping',
                    projectSuggestion: { name: 'Research', purpose: '' },
                    categories: [{ name: 'Sources', description: 'References' }],
                  }),
                },
              },
            ],
          });
        }
        const id = input.includes(second.id) ? second.id : record.id;
        classifierCalls.push(id);
        return response({
          choices: [
            {
              message: {
                content:
                  id === second.id && !recovered
                    ? 'malformed'
                    : JSON.stringify({
                        assignments: [
                          { recordId: id, choice: 'c0', reason: 'Reference', confidence: 0.9 },
                        ],
                      }),
              },
            },
          ],
        });
      }),
    );
    const checkpoint = {
      id: 'project-analysis:project-1',
      load: async () => saved,
      save: async (value: CollectionAnalysis) => {
        saved = collectionAnalysisSchema.parse(structuredClone(value));
        return saved;
      },
    };
    await expect(
      generateOrganizationDraft(state, project, [record, second], { checkpoint }),
    ).rejects.toThrow(/Classifier batch failed/);
    expect(saved?.classifiedIds).toEqual([record.id]);
    expect(saved?.failedBatch?.recordIds).toEqual([second.id]);
    expect(discoveryCalls).toBe(2);
    recovered = true;
    const draft = await generateOrganizationDraft(state, project, [record, second], { checkpoint });
    expect(draft.assignments.map((entry) => entry.recordId)).toEqual([record.id, second.id]);
    expect(discoveryCalls).toBe(2);
    expect(classifierCalls.filter((id) => id === record.id)).toHaveLength(1);
  });
  it('sends OpenAI-compatible structured output and validates returned tab ids', async () => {
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      expect(request.model).toBe('test-model');
      expect(request.response_format.type).toBe('json_schema');
      return response({
        id: 'test',
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: 'Repository tabs',
                matchIds: [],
                actions: [
                  {
                    type: 'group',
                    recordIds: [record.id],
                    windowId: 1,
                    name: 'Code',
                    color: 'blue',
                    reason: 'Repository',
                    confidence: 0.9,
                  },
                ],
              }),
            },
          },
        ],
      });
    });
    stubFetch('fetch', fetch);
    const plan = await generatePlan(app, [record], 'Organize my tabs');
    expect(plan.actions[0]?.name).toBe('Code');
    expect(plan.expected?.[record.id]?.url).toBe(record.url);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('splits a malformed action batch after bounded retries and covers both occurrences', async () => {
    const second = { ...record, id: 'action-second', title: 'Second code reference' };
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = z
        .object({ messages: z.array(z.object({ content: z.string().nullable().optional() })) })
        .parse(JSON.parse(String(init?.body)));
      const request = z
        .object({ context: z.object({ tabs: z.array(z.object({ id: z.string() })) }) })
        .parse(JSON.parse(body.messages.at(-1)?.content || '{}'));
      const ids = request.context.tabs.map((tab) => tab.id);
      return response({
        choices: [
          {
            message: {
              content:
                ids.length > 1
                  ? 'malformed'
                  : JSON.stringify({
                      summary: 'Found a code reference',
                      actions: [],
                      matchIds: ids,
                    }),
            },
          },
        ],
      });
    });
    stubFetch('fetch', fetch);
    const plan = await generatePlan(
      { ...app, records: [record, second], settings: { ...app.settings, aiBatchSize: 2 } },
      [record, second],
      'Find both code references',
      { readOnly: true },
    );
    expect(plan.matchIds).toEqual([record.id, second.id]);
    expect(fetch).toHaveBeenCalledTimes(5);
  });
  it('resumes only the failed action batch from a persisted checkpoint after changing model', async () => {
    const second = { ...record, id: 'action-resume-second', title: 'Second tab' };
    let saved: ActionAnalysis | undefined;
    let failSecond = true;
    const seen: string[] = [];
    const checkpoint = {
      id: 'action-resume-test',
      load: async () => saved,
      rebase: async () => saved!,
      save: async (value: ActionAnalysis) =>
        (saved = actionAnalysisSchema.parse(structuredClone(value))),
    };
    stubFetch(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        const evidence = JSON.parse(body.messages.at(-1).content);
        const id = evidence.context.tabs[0].id;
        seen.push(id);
        if (id === second.id && failSecond)
          return response({ choices: [{ message: { content: 'broken' } }] });
        return response({
          choices: [
            {
              message: {
                content: JSON.stringify({ summary: 'Reviewed', actions: [], matchIds: [id] }),
              },
            },
          ],
        });
      }),
    );
    const workspace = {
      ...app,
      records: [record, second],
      settings: { ...app.settings, aiBatchSize: 1 },
    };
    await expect(
      generatePlan(workspace, [record, second], 'Find references', {
        readOnly: true,
        actionCheckpoint: checkpoint,
      }),
    ).rejects.toThrow(/Completed batches were saved/);
    expect(saved?.completedIds).toEqual([record.id]);
    expect(saved?.failedBatch?.recordIds).toEqual([second.id]);
    failSecond = false;
    const plan = await generatePlan(
      { ...workspace, settings: { ...workspace.settings, aiModel: 'replacement-model' } },
      [record, second],
      'Find references',
      { readOnly: true, actionCheckpoint: checkpoint },
    );
    expect(plan.matchIds).toEqual([record.id, second.id]);
    expect(plan.provenance?.model).toContain('replacement-model');
    expect(seen.filter((id) => id === record.id)).toHaveLength(1);
    expect(saved?.status).toBe('complete');
  });
  it('stops an action run without discarding its completed batch', async () => {
    const second = { ...record, id: 'action-stop-second', title: 'Second tab' };
    let saved: ActionAnalysis | undefined;
    const controller = new AbortController();
    const checkpoint = {
      id: 'action-stop-test',
      load: async () => saved,
      rebase: async () => saved!,
      save: async (value: ActionAnalysis) =>
        (saved = actionAnalysisSchema.parse(structuredClone(value))),
    };
    const seen: string[] = [];
    stubFetch(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        const id = JSON.parse(body.messages.at(-1).content).context.tabs[0].id;
        seen.push(id);
        if (id === second.id && !controller.signal.aborted) {
          controller.abort();
          throw new DOMException('Stopped', 'AbortError');
        }
        return response({
          choices: [
            {
              message: {
                content: JSON.stringify({ summary: 'Reviewed', actions: [], matchIds: [id] }),
              },
            },
          ],
        });
      }),
    );
    const workspace = {
      ...app,
      records: [record, second],
      settings: { ...app.settings, aiBatchSize: 1 },
    };
    await expect(
      generatePlan(workspace, [record, second], 'Find references', {
        readOnly: true,
        signal: controller.signal,
        actionCheckpoint: checkpoint,
      }),
    ).rejects.toThrow();
    expect(saved?.completedIds).toEqual([record.id]);
    expect(saved?.failedBatch).toBeUndefined();
    await generatePlan(workspace, [record, second], 'Find references', {
      readOnly: true,
      actionCheckpoint: checkpoint,
    });
    expect(saved?.completedIds).toEqual([record.id, second.id]);
    expect(seen.filter((id) => id === record.id)).toHaveLength(1);
  });
  it('resumes a workspace-chat action tool directly without rerunning the orchestrator', async () => {
    const second = { ...record, id: 'workspace-action-second', title: 'Second tab' };
    let saved: ActionAnalysis | undefined = {
      id: 'workspace-action-resume',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      revision: 1,
      status: 'pending',
      instruction: 'Find references',
      mode: 'generative',
      readOnly: true,
      allowCrossWindowMove: false,
      allowSleepWake: false,
      scope: [record, second].map((item) => ({
        id: item.id,
        url: item.url,
        navigationVersion: item.navigationVersion,
        windowId: item.windowId,
        groupId: item.groupId,
      })),
      completedIds: [record.id],
      actions: [],
      matchIds: [record.id],
      summaries: [{ recordIds: [record.id], text: 'First found', model: 'old-model' }],
    };
    const checkpoint = {
      id: saved.id,
      load: async () => saved,
      rebase: async () => saved!,
      save: async (value: ActionAnalysis) =>
        (saved = actionAnalysisSchema.parse(structuredClone(value))),
    };
    const ids: string[] = [];
    stubFetch(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        const id = JSON.parse(body.messages.at(-1).content).context.tabs[0].id;
        ids.push(id);
        return response({
          choices: [
            {
              message: {
                content: JSON.stringify({ summary: 'Second found', actions: [], matchIds: [id] }),
              },
            },
          ],
        });
      }),
    );
    const result = await answerWorkQuestion(
      { ...app, records: [record, second], settings: { ...app.settings, aiBatchSize: 1 } },
      'Resume the action plan',
      [],
      undefined,
      {
        actionCheckpoint: checkpoint,
        resume: {
          id: 'failed-action-message',
          role: 'assistant',
          content: '',
          createdAt: Date.now(),
          actionAnalysisId: saved.id,
          sources: [],
          activity: [],
          toolEvents: [],
          completedArtifacts: [],
        },
      },
    );
    expect(ids).toEqual([second.id]);
    expect(result.plan?.matchIds).toEqual([record.id, second.id]);
    expect(result.answer).toContain('First found');
  });
  it('does not apply model hallucinations', async () => {
    stubFetch(
      'fetch',
      vi.fn(async () =>
        response({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  summary: '',
                  matchIds: [],
                  actions: [
                    {
                      type: 'wake',
                      recordIds: ['made-up'],
                      windowId: -1,
                      name: '',
                      color: 'grey',
                      reason: '',
                      confidence: 1,
                    },
                  ],
                }),
              },
            },
          ],
        }),
      ),
    );
    await expect(generatePlan(app, [record], 'Wake this tab')).rejects.toThrow(/no longer open/);
  });
  it('blocks unrequested cross-window actions', async () => {
    stubFetch(
      'fetch',
      vi.fn(async () =>
        response({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  summary: '',
                  matchIds: [],
                  actions: [
                    {
                      type: 'group',
                      recordIds: [record.id],
                      windowId: 2,
                      name: 'Code',
                      color: 'blue',
                      reason: '',
                      confidence: 0.9,
                    },
                  ],
                }),
              },
            },
          ],
        }),
      ),
    );
    await expect(
      generatePlan(
        { ...app, windows: [...app.windows, { id: 2, focused: false, projectId: null }] },
        [record],
        'Organize by topic in their existing windows. Do not move tabs.',
      ),
    ).rejects.toThrow(/cross-window/);
  });
  it('uses the official TypeSafe SDK at a Bud System One endpoint', async () => {
    const fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      expect(String(url)).toBe('http://127.0.0.1:8420/v1/systemone');
      const body = JSON.parse(String(init?.body));
      expect(body.questions.category.type).toBe('choice');
      return response({
        model: 'laya',
        answers: {
          category: {
            type: 'choice',
            choice: 'g0',
            confidence: 0.9,
            probabilities: { g0: 0.9, keep: 0.1 },
          },
        },
        usage: { input_tokens: 20, output_tokens: 0, cost: 0 },
      });
    });
    stubFetch('fetch', fetch);
    const plan = await generatePlan(
      {
        ...app,
        groups: [
          { id: 10, windowId: 1, title: 'Code', color: 'blue', collapsed: false, shared: false },
        ],
        settings: {
          ...app.settings,
          useDedicatedDecisionModel: true,
          decisionProvider: 'bud',
          decisionModel: 'laya',
          decisionBase: 'http://127.0.0.1:8420',
          aiProvider: 'lmstudio',
        },
      },
      [record],
      'Categorize',
      { useDecisionModel: true },
    );
    expect(plan.actions[0]?.name).toBe('Code');
  });
  it('routes a loaded llama.cpp decision model through its Jev-compatible System One endpoint', async () => {
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      expect(String(url)).toBe('http://127.0.0.1:8080/v1/systemone');
      const body = JSON.parse(String(init?.body)) as {
        model: string;
        questions: { category: { type: string } };
      };
      expect(body.model).toBe('openjev-local');
      expect(body.questions.category.type).toBe('choice');
      return response({
        model: 'openjev-local',
        answers: {
          category: {
            type: 'choice',
            choice: 'g0',
            confidence: 0.9,
            probabilities: { g0: 0.9, keep: 0.1 },
          },
        },
        usage: { input_tokens: 20, output_tokens: 0 },
      });
    });
    stubFetch('fetch', fetchMock);
    const plan = await generatePlan(
      {
        ...app,
        groups: [
          { id: 10, windowId: 1, title: 'Code', color: 'blue', collapsed: false, shared: false },
        ],
        settings: {
          ...app.settings,
          useDedicatedDecisionModel: true,
          decisionProvider: 'jev',
          decisionModel: 'openjev-local',
          decisionBase: 'http://127.0.0.1:8080',
        },
      },
      [record],
      'Categorize',
      { useDecisionModel: true },
    );
    expect(plan.actions[0]?.name).toBe('Code');
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it('uses a llama.cpp System One decision model for final whole-collection assignments', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === 'http://127.0.0.1:8080/v1/systemone') {
        const body = JSON.parse(String(init?.body)) as {
          model: string;
          questions: Record<string, { type: string }>;
        };
        expect(body.model).toBe('openjev-local');
        expect(body.questions.tab_0?.type).toBe('choice');
        return response({
          model: 'openjev-local',
          answers: {
            tab_0: {
              type: 'choice',
              choice: 'c0',
              confidence: 0.94,
              probabilities: { c0: 0.94, keep: 0.06 },
            },
          },
          usage: { input_tokens: 40, output_tokens: 0 },
        });
      }
      return response({
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: 'Work reference.',
                projects: [
                  {
                    name: 'Work',
                    purpose: 'Work references.',
                    areaName: 'Work',
                    categories: [{ name: 'Research', description: 'Research sources.' }],
                  },
                ],
                assignments: [
                  {
                    recordId: record.id,
                    url: record.url,
                    navigationVersion: 0,
                    projectName: 'Work',
                    categoryName: 'Research',
                    reason: 'The source repository is work-related.',
                    confidence: 0.9,
                  },
                ],
                unresolvedRecordIds: [],
              }),
            },
          },
        ],
      });
    });
    stubFetch('fetch', fetchMock);
    const draft = await generateCollectionDraft({
      ...app,
      settings: {
        ...app.settings,
        useDedicatedDecisionModel: true,
        decisionProvider: 'jev',
        decisionBase: 'http://127.0.0.1:8080',
        decisionModel: 'openjev-local',
      },
    });
    expect(draft.assignments[0]).toMatchObject({
      recordId: record.id,
      projectName: 'Work',
      categoryName: 'Research',
      confidence: 0.94,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('routes classification through the selected OpenAI-compatible small model', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      expect(body.model).toBe('fixture-small');
      return response({
        choices: [
          {
            message: {
              content: '{"choice":"g0","confidence":0.91,"reason":"Repository matches Code."}',
            },
          },
        ],
      });
    });
    stubFetch('fetch', fetchMock);
    const plan = await generatePlan(
      {
        ...app,
        groups: [
          { id: 10, windowId: 1, title: 'Code', color: 'blue', collapsed: false, shared: false },
        ],
        settings: {
          ...app.settings,
          smallModelBase: 'http://127.0.0.1:8080/v1',
          smallModel: 'fixture-small',
        },
      },
      [record],
      'Categorize',
      { useDecisionModel: true },
    );
    expect(plan.actions[0]?.name).toBe('Code');
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('127.0.0.1:8080/v1/chat/completions');
  });
  it('lists Bud models through the supported SDK response format', async () => {
    stubFetch(
      'fetch',
      vi.fn(async () =>
        response({
          models: [{ name: 'laya', description: 'Local classifier', release_date: '2026-01-01' }],
        }),
      ),
    );
    expect(await models({ ...DEFAULTS, aiProvider: 'bud' })).toEqual(['laya']);
  });
  it('discovers generative and decision models independently from their endpoints', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      return url.includes(':1234')
        ? response({ data: [{ id: 'large-chat' }] })
        : response({
            models: [
              { name: 'small-choice', description: 'Decision model', release_date: '2026-01-01' },
            ],
          });
    });
    stubFetch('fetch', fetchMock);
    const settings = {
      ...DEFAULTS,
      aiBase: 'http://127.0.0.1:1234/v1',
      aiKey: 'generative-token',
      decisionBase: 'http://127.0.0.1:8420',
      decisionModel: 'small-choice',
      decisionKey: 'decision-token',
      decisionProvider: 'bud' as const,
    };
    expect(await generativeModels(settings)).toEqual(['large-chat']);
    expect(await decisionModels(settings)).toEqual(['small-choice']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('discovers a small OpenAI-compatible chat model at its own endpoint', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
      response({ data: [{ id: 'fixture-small' }] }),
    );
    stubFetch('fetch', fetchMock);
    const settings = {
      ...DEFAULTS,
      smallModelBase: 'http://127.0.0.1:1235/v1',
      smallModel: '',
      smallModelKey: 'local-token',
    };
    expect(await smallModels(settings)).toEqual(['fixture-small']);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('127.0.0.1:1235/v1/models');
  });
  it('discovers Jev decision models from LM Studio model-list API', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe('http://127.0.0.1:1234/v1/models');
      return response({ data: [{ id: 'llama-decision' }] });
    });
    stubFetch('fetch', fetchMock);
    expect(
      await decisionModels({
        ...DEFAULTS,
        decisionProvider: 'jev',
        decisionBase: 'http://127.0.0.1:1234',
        decisionModel: '',
      }),
    ).toEqual(['llama-decision']);
  });
  it('organizes a foreign-suspended tab by its recovered original URL without waking it', async () => {
    const suspended = {
      ...record,
      id: 'suspended-occurrence',
      url: 'https://mail.example.com/inbox?view=work',
      title: 'Work inbox',
      suspended: true,
      foreignSuspended: true,
    };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as {
        model: string;
        messages: Array<{ role: string; content: string }>;
      };
      if (request.model === 'fixture-small')
        return response({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  assignments: [
                    {
                      recordId: 'suspended-occurrence',
                      choice: 'c0',
                      reason: 'The recovered title and mail domain identify an inbox.',
                      confidence: 0.88,
                    },
                  ],
                }),
              },
            },
          ],
        });
      const payload = JSON.parse(request.messages[1]!.content) as {
        tabs: Array<{ id: string; url: string; suspended: boolean; foreignSuspended: boolean }>;
      };
      expect(payload.tabs).toMatchObject([
        {
          id: 'suspended-occurrence',
          url: 'https://mail.example.com/inbox?view=work',
          suspended: true,
          foreignSuspended: true,
        },
      ]);
      return response({
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: 'Recovered and classified from the saved original address.',
                projects: [
                  {
                    name: 'Daily work',
                    purpose: 'Handle routine work communication.',
                    areaName: 'Work',
                    categories: [{ name: 'Email', description: 'Mail and follow-ups.' }],
                  },
                ],
                assignments: [
                  {
                    recordId: 'suspended-occurrence',
                    url: 'https://mail.example.com/inbox?view=work',
                    navigationVersion: 0,
                    projectName: 'Daily work',
                    categoryName: 'Email',
                    reason: 'The saved title and original URL identify the work inbox.',
                    confidence: 0.92,
                  },
                ],
                unresolvedRecordIds: [],
              }),
            },
          },
        ],
      });
    });
    stubFetch('fetch', fetchMock);
    const draft = await generateCollectionDraft({
      ...app,
      records: [suspended],
      settings: { ...app.settings, smallModel: 'fixture-small' },
    });
    expect(draft.assignments[0]?.recordId).toBe('suspended-occurrence');
    expect(draft.assignments[0]?.url).toBe('https://mail.example.com/inbox?view=work');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('covers 1,000 distinct occurrences in bounded collection batches', async () => {
    const records = Array.from({ length: 1000 }, (_, index) => ({
      ...newRecord(`https://example.com/page/${Math.floor(index / 2)}`, `occurrence-${index}`),
      title: `Page ${index}`,
      live: true,
      windowId: index % 3,
      content:
        index % 9 === 0
          ? {
              title: `Page ${index}`,
              url: `https://example.com/page/${Math.floor(index / 2)}`,
              description: 'Useful background'.repeat(30),
              headings: ['Reference', 'Tasks'],
              text: 'Original cached content '.repeat(200),
              capturedAt: 1,
              scroll: 0,
              dirty: false,
              playing: false,
            }
          : null,
    }));
    let discoveryCount = 0;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as {
        model: string;
        messages: Array<{ role: string; content: string }>;
      };
      const limit =
        request.model === 'fixture-small'
          ? 32768 - app.settings.smallCompletionTokens - 1024
          : 32768 - app.settings.aiCompletionTokens - 1024;
      expect(new TextEncoder().encode(String(init?.body)).length).toBeLessThanOrEqual(limit);
      const payload = JSON.parse(request.messages[1]!.content) as {
        tabs: Array<{ id: string }>;
      };
      if (request.model === 'fixture-small')
        return response({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  assignments: payload.tabs.map((tab) => ({
                    recordId: tab.id,
                    choice: 'c0',
                    reason: 'Synthetic scale fixture.',
                    confidence: 0.8,
                  })),
                }),
              },
            },
          ],
        });
      const schema = z
        .object({
          response_format: z.object({
            json_schema: z.object({ schema: z.object({ required: z.array(z.string()) }) }),
          }),
        })
        .parse(JSON.parse(String(init?.body)));
      expect(schema.response_format.json_schema.schema.required).toEqual([
        'tagVocabulary',
        'summary',
        'projects',
      ]);
      discoveryCount++;
      return response({
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: 'Routine browser references.',
                projects: [
                  {
                    name: `Reference library ${discoveryCount}`,
                    purpose: 'Keep general reference pages.',
                    areaName: 'Personal',
                    categories: [{ name: 'Reference', description: 'General sources.' }],
                  },
                ],
              }),
            },
          },
        ],
      });
    });
    stubFetch('fetch', fetchMock);
    const draft = await generateCollectionDraft({
      ...app,
      records,
      settings: {
        ...app.settings,
        smallModel: 'fixture-small',
        aiBatchSize: 60,
        aiEvidenceCharacters: 0,
      },
    });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(34);
    expect(draft.assignments).toHaveLength(1000);
    expect(new Set(draft.assignments.map((assignment) => assignment.recordId)).size).toBe(1000);
    expect(draft.unresolvedRecordIds).toEqual([]);
    expect(draft.scopeRecordIds).toEqual(records.map((record) => record.id));
    expect(draft.projects.length).toBe(discoveryCount);
    expect(records[0]?.content?.text).toBe('Original cached content '.repeat(200));
  });
  it('stops collection analysis before any model request when the loaded context is unknown', async () => {
    const fetchMock = vi.fn();
    stubFetch('fetch', fetchMock);
    await expect(
      generateCollectionDraft({
        ...app,
        settings: { ...app.settings, smallModel: 'fixture-small', aiContextTokens: 0 },
      }),
    ).rejects.toThrow(/Set the loaded generative model's context tokens/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('grounds daily focus in existing unfinished work-item IDs', async () => {
    const workItem = {
      id: 'task-1',
      title: 'Reply to the landlord',
      notes: 'Confirm the repair date',
      areaId: null,
      projectId: null,
      recordId: null,
      url: null,
      status: 'open' as const,
      priority: 'high' as const,
      dueAt: Date.now(),
      source: 'owner' as const,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      response({
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: 'Start with the repair follow-up because it is due today.',
                priorities: [
                  { workItemId: workItem.id, reason: 'Owner-set due time and high priority.' },
                ],
                evidenceGaps: ['The email message state is not connected.'],
              }),
            },
          },
        ],
      }),
    );
    stubFetch('fetch', fetch);
    const meeting = {
      id: 'event-1',
      title: 'Planning meeting',
      start: '2026-10-10T10:00:00+05:30',
      end: '2026-10-10T10:30:00+05:30',
      allDay: false,
      htmlLink: 'https://calendar.google.com/event?eid=one',
    };
    const result = await generateDailyFocus(
      { ...app, workItems: [workItem] },
      { calendarEvents: [meeting] },
    );
    expect(result.priorities).toEqual([
      { workItemId: workItem.id, reason: 'Owner-set due time and high priority.' },
    ]);
    const requestBody = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)) as {
      messages: Array<{ content: string }>;
    };
    expect(requestBody.messages.at(-1)?.content).toContain('Planning meeting');
  });
  it('uses the official SDK tool runner to search saved work before answering', async () => {
    const workItem = {
      id: 'task-repair',
      title: 'Confirm the repair date',
      notes: 'Ask the landlord by email',
      areaId: null,
      projectId: null,
      recordId: null,
      url: null,
      status: 'open' as const,
      priority: 'high' as const,
      dueAt: null,
      source: 'owner' as const,
      createdAt: 1,
      updatedAt: 1,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call-search',
                    type: 'function',
                    function: {
                      name: 'search_work',
                      arguments: JSON.stringify({ query: 'repair' }),
                    },
                  },
                ],
              },
            },
          ],
        }),
      )
      .mockImplementationOnce(async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as {
          messages: Array<{ role: string; content?: string }>;
        };
        expect(JSON.stringify(request.messages)).toContain('Confirm the repair date');
        return response({
          choices: [
            {
              message: {
                role: 'assistant',
                content:
                  'Your repair follow-up is open and high priority. The email status is not connected.',
              },
            },
          ],
        });
      });
    stubFetch('fetch', fetchMock);
    const answer = await answerWorkQuestion(
      { ...app, workItems: [workItem] },
      'What needs my attention?',
    );
    expect(answer.answer).toContain('repair follow-up');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('prepares an explicitly requested task for owner review without saving it', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call-task',
                    type: 'function',
                    function: {
                      name: 'prepare_work_item',
                      arguments: JSON.stringify({
                        title: 'Book annual checkup',
                        notes: 'Call the clinic',
                        areaName: 'Personal',
                        projectName: null,
                        priority: 'normal',
                      }),
                    },
                  },
                ],
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        response({
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'I drafted the checkup follow-up. Review it before saving.',
              },
            },
          ],
        }),
      );
    stubFetch('fetch', fetchMock);
    const personal = {
      id: 'area-personal',
      name: 'Personal',
      description: '',
      createdAt: 1,
      updatedAt: 1,
    };
    const result = await answerWorkQuestion(
      { ...app, areas: [personal] },
      'Create a reminder to book my annual checkup.',
    );
    expect(result.proposal).toMatchObject({
      title: 'Book annual checkup',
      areaId: personal.id,
      projectId: null,
      priority: 'normal',
    });
    expect(app.workItems).toHaveLength(0);
  });
  it('returns search matches without browser actions', async () => {
    stubFetch(
      'fetch',
      vi.fn(async () =>
        response({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  summary: 'Here is your repository.',
                  matchIds: [record.id],
                  actions: [],
                }),
              },
            },
          ],
        }),
      ),
    );
    const plan = await generatePlan(app, [record], 'Find my Atlas Planner repository');
    expect(plan.actions).toEqual([]);
    expect(plan.matchIds).toEqual([record.id]);
  });
  it('permits an explicitly enabled cross-window capability', async () => {
    stubFetch(
      'fetch',
      vi.fn(async () =>
        response({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  summary: 'Move requested',
                  matchIds: [],
                  actions: [
                    {
                      type: 'move',
                      recordIds: [record.id],
                      windowId: 2,
                      name: '',
                      color: 'grey',
                      reason: 'Requested',
                      confidence: 0.9,
                    },
                  ],
                }),
              },
            },
          ],
        }),
      ),
    );
    const plan = await generatePlan(
      { ...app, windows: [...app.windows, { id: 2, focused: false, projectId: null }] },
      [record],
      'Move to window 2',
      { allowCrossWindowMove: true },
    );
    expect(plan.actions[0]?.type).toBe('move');
  });
  it('enforces read-only questions even if the model proposes a valid action', async () => {
    stubFetch(
      'fetch',
      vi.fn(async () =>
        response({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  summary: 'A group',
                  matchIds: [],
                  actions: [
                    {
                      type: 'group',
                      recordIds: [record.id],
                      windowId: 1,
                      name: 'Code',
                      color: 'blue',
                      reason: 'Repository',
                      confidence: 0.9,
                    },
                  ],
                }),
              },
            },
          ],
        }),
      ),
    );
    await expect(generatePlan(app, [record], 'Find code', { readOnly: true })).rejects.toThrow(
      /cannot change tabs/,
    );
  });
  it('requires the sleep/wake capability even when a request mentions sleep', async () => {
    stubFetch(
      'fetch',
      vi.fn(async () =>
        response({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  summary: 'Sleep',
                  matchIds: [],
                  actions: [
                    {
                      type: 'suspend',
                      recordIds: [record.id],
                      windowId: -1,
                      name: '',
                      color: 'grey',
                      reason: 'Request',
                      confidence: 0.9,
                    },
                  ],
                }),
              },
            },
          ],
        }),
      ),
    );
    await expect(generatePlan(app, [record], 'Sleep this tab')).rejects.toThrow(/capability/);
    expect(
      (await generatePlan(app, [record], 'Sleep this tab', { allowSleepWake: true })).actions[0]
        ?.type,
    ).toBe('suspend');
  });
});
