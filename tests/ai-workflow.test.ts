import { answerWorkQuestion } from '../src/ai/runtime/agent';
import { stubFetch } from './taxonomy-fixture';
import { CLASSIFICATION_CONTRACT } from '../src/ai/workflows/classification';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { reactive } from 'vue';
import { generateCollectionDraft, generatePlan } from '../src/ai/workflows/generation';
import { requestModelAccess } from '../src/ai/providers/access';
import { DEFAULTS, newRecord } from '../src/shared/model';
import type {
  AppState,
  CollectionAnalysis,
  CollectionDraft,
  CollectionProposal,
} from '../src/shared/types';
import { assistantMessageSchema } from '../src/shared/assistant/assistant';
import {
  collectionAnalysisSchema,
  skipFailedCollectionBatch,
} from '../src/shared/organization/collection-analysis';
import { validateCollectionDraft } from '../src/shared/model';
import {
  resolveAttachments,
  searchAttachments,
  snapshotAttachments,
} from '../src/shared/assistant/assistant-context';
import { mergeProposalDrafts } from '../src/shared/organization/proposal-edits';
import { tagHash } from '../src/shared/organization/tag-analysis';

const record = {
  ...newRecord('https://example.com/reference'),
  id: 'occurrence-a',
  title: 'Reference',
  windowId: 1,
  live: true,
  suspended: true,
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
  version: '0.1.0',
  settings: {
    ...DEFAULTS,
    aiModel: 'large',
    smallModel: 'small',
    aiStreamResponses: false,
    aiContextTokens: 32768,
    smallContextTokens: 32768,
    decisionContextTokens: 32768,
  },
};
const project = {
  name: 'Research',
  purpose: 'Reference material',
  areaName: 'Personal',
  categories: [{ name: 'Sources', description: 'Original references' }],
};
const reply = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const text = (content: string) => reply({ choices: [{ message: { role: 'assistant', content } }] });
const call = (name: string, args: unknown) =>
  reply({
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: crypto.randomUUID(),
              type: 'function',
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
      },
    ],
  });
const requestSchema = z.object({
  model: z.string(),
  response_format: z.unknown().optional(),
  messages: z.array(z.object({ role: z.string(), content: z.string().nullable().optional() })),
});
afterEach(() => vi.unstubAllGlobals());

describe('AI workflow coordination', () => {
  it.each([0, 1, 57])(
    'keeps a whole-collection tool call inside %i attached occurrences in a 148-tab workspace',
    async (count) => {
      const records = Array.from({ length: 148 }, (_, index) => ({
        ...record,
        id: `scope-occurrence-${index}`,
        url: `https://example.test/reference/${index}`,
      }));
      const selected = records.slice(0, count).map((item) => item.id);
      const allowed = new Set(selected);
      let step = 0;
      let checkpoint: CollectionAnalysis | undefined;
      const classified: string[] = [];
      stubFetch('fetch', async (_url, init) => {
        const body = requestSchema.parse(JSON.parse(String(init?.body)));
        if (body.model === 'small') {
          const data = JSON.parse(body.messages.at(-1)?.content || '{}');
          expect(data.tabs).toHaveLength(1);
          expect(allowed.has(data.tabs[0].id)).toBe(true);
          classified.push(data.tabs[0].id);
          return text(JSON.stringify({ choice: 'c0', reason: 'Reference', confidence: 0.95 }));
        }
        if (body.response_format)
          return text(JSON.stringify({ summary: 'Selected references', projects: [project] }));
        if (step++ === 0)
          return call('prepare_whole_collection_organization', {
            confirmation: 'prepare_reviewable_proposal',
          });
        return text('The selected tabs have a draft.');
      });
      const saved = vi.fn(async (draft) => ({
        ...draft,
        id: 'scoped-result',
        createdAt: 1,
        status: 'pending' as const,
      }));
      const run = answerWorkQuestion(
        { ...app, records },
        'Organize these Inbox tabs',
        [],
        undefined,
        {
          context: { projectId: null, selectedRecordIds: selected, scopeRecordIds: selected },
          onCollectionDraft: saved,
          collectionCheckpoint: {
            id: 'scoped-analysis',
            load: async () => checkpoint,
            save: async (value) => {
              expect(value.scope.map((item) => item.id)).toEqual(selected);
              expect(value.purpose).toBe('scoped');
              checkpoint = structuredClone(value);
              return checkpoint;
            },
            clear: async () => {
              checkpoint = undefined;
            },
          },
        },
      );
      if (!count) {
        await expect(run).rejects.toThrow('No eligible open tabs');
        expect(saved).not.toHaveBeenCalled();
        expect(classified).toEqual([]);
        return;
      }
      await run;
      expect(saved).toHaveBeenCalledOnce();
      expect(saved.mock.calls[0]![0].scopeRecordIds).toEqual(selected);
      expect(new Set(classified)).toEqual(allowed);
      expect(classified).toHaveLength(count);
    },
  );
  it('refuses to resume an oversized checkpoint against a smaller attached scope before inference or writes', async () => {
    const saved = collectionAnalysisSchema.parse({
      id: 'oversized',
      createdAt: 1,
      updatedAt: 1,
      revision: 1,
      purpose: 'proposal',
      instruction: 'Organize tabs',
      reuseAcceptedTaxonomyOnly: true,
      scope: [
        { id: record.id, url: record.url, navigationVersion: 0 },
        { id: 'outside-selection', url: 'https://example.test/outside', navigationVersion: 0 },
      ],
      discoveredIds: [],
      classifiedIds: [],
      projects: [],
      summaries: [],
      assignments: [],
      unresolvedRecordIds: [],
    });
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const save = vi.fn();
    const before = JSON.stringify(saved);
    await expect(
      answerWorkQuestion(app, 'Retry', [], undefined, {
        context: { projectId: null, selectedRecordIds: [record.id], scopeRecordIds: [record.id] },
        resume: assistantMessageSchema.parse({
          id: 'failed',
          role: 'assistant',
          content: 'Interrupted',
          createdAt: 1,
          collectionAnalysisId: saved.id,
        }),
        collectionCheckpoint: { id: saved.id, load: async () => saved, save, clear: vi.fn() },
      }),
    ).rejects.toThrow('outside the original attached selection');
    expect(fetch).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(JSON.stringify(saved)).toBe(before);
    await expect(
      generateCollectionDraft(app, {
        recordIds: [record.id],
        checkpoint: {
          id: saved.id,
          load: async () => ({ ...saved, decisionContract: CLASSIFICATION_CONTRACT }),
          save,
        },
      }),
    ).rejects.toThrow('exceeds the explicitly requested tab scope');
    expect(fetch).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });
  it('binds a single chat classification to its original occurrence without asking the model to copy its ID', async () => {
    const exactId = 'fictional-occurrence-3918e14';
    const seen = vi.fn();
    stubFetch('fetch', async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      seen();
      expect(request.response_format.json_schema.schema.properties).not.toHaveProperty(
        'assignments',
      );
      expect(request.response_format.json_schema.schema.properties).not.toHaveProperty('recordId');
      return text(
        JSON.stringify({ choice: 'c0', reason: 'Supported reference page', confidence: 0.95 }),
      );
    });
    const draft = await generateCollectionDraft(
      {
        ...app,
        records: [{ ...record, id: exactId }],
        projects: [{ id: 'p', ...project, revision: 1, updatedAt: 1, maintainReviewQueue: false }],
        categories: [
          {
            id: 'c',
            projectId: 'p',
            name: 'Sources',
            description: 'Reference pages',
            order: 0,
            revision: 1,
            updatedAt: 1,
          },
        ],
      },
      { reuseAcceptedTaxonomyOnly: true },
    );
    expect(draft.assignments.map((entry) => entry.recordId)).toEqual([exactId]);
    expect(seen).toHaveBeenCalledTimes(1);
  });
  it('snapshots reactive Inbox and selected-tab attachments without retaining proxies', () => {
    const input = reactive([
      {
        kind: 'selection',
        id: 'inbox-selection',
        label: '57 selected tabs',
        recordIds: Array.from({ length: 57 }, (_, i) => `occurrence-${i}`),
      },
    ]);
    const saved = snapshotAttachments(input);
    expect(structuredClone(saved)).toEqual(saved);
    input[0]!.recordIds.push('later-tab');
    input[0]!.label = 'Changed selection';
    expect(saved[0]!.recordIds).toHaveLength(57);
    expect(saved[0]!.label).toBe('57 selected tabs');
    expect(() =>
      snapshotAttachments([
        { kind: 'selection', id: 'invalid', label: 'Invalid', recordIds: [null] },
      ]),
    ).toThrow();
  });
  it('finds saved-only and closed-tab tags consistently with attachment search', async () => {
    const workspace = {
      ...app,
      tagVocabulary: ['Saved topic'],
      records: [{ ...record, live: false, tags: ['Streamer'] }],
    };
    const options = searchAttachments(workspace, 'streamer', 0, 50, 'tag');
    expect(options.items).toMatchObject([{ kind: 'tag', id: 'Streamer' }]);
    let step = 0;
    stubFetch('fetch', async (_url, init) => {
      if (++step === 1) return call('list_tags', { query: '', offset: 0 });
      const body = requestSchema.parse(JSON.parse(String(init?.body)));
      expect(JSON.parse(body.messages.at(-1)!.content!)).toMatchObject({
        tags: [
          { name: 'Saved topic', count: 0, savedCount: 0 },
          { name: 'Streamer', count: 0, savedCount: 1 },
        ],
      });
      return text('Both tags are saved, with no currently open tabs.');
    });
    await expect(answerWorkQuestion(workspace, 'Find my saved tags')).resolves.toHaveProperty(
      'answer',
    );
  });

  it('filters attachment kinds before pagination rather than filtering a mixed page', () => {
    const workspace = {
      ...app,
      projects: Array.from({ length: 75 }, (_, i) => ({
        id: `project-${i}`,
        name: 'Matching project',
        purpose: '',
        updatedAt: 0,
        revision: 0,
        maintainReviewQueue: false,
      })),
      records: [{ ...record, tags: ['Matching tag'] }],
      tagVocabulary: ['Matching saved tag'],
    };
    const tags = searchAttachments(workspace, 'matching', 0, 1, 'tag');
    expect(tags.items[0]?.kind).toBe('tag');
    expect(tags.hasMore).toBe(true);
    expect(searchAttachments(workspace, 'matching', 1, 1, 'tag').items[0]?.kind).toBe('tag');
    expect(searchAttachments(workspace, 'matching', 0, 50, 'category').items).toEqual([]);
    expect(searchAttachments(workspace, 'reference', 0, 50, 'tab').items).toMatchObject([
      { kind: 'tab', id: record.id },
    ]);
  });

  it('reads a paged tab branch across project boundaries without preparing a mutation', async () => {
    const child = {
      ...record,
      id: 'child-occurrence',
      parentRecordId: record.id,
      projectId: 'other-project',
      branchName: 'Related reference',
    };
    const unrelated = { ...record, id: 'unrelated-occurrence', parentRecordId: null };
    const state = { ...app, records: [record, child, unrelated] };
    let step = 0;
    stubFetch('fetch', async (_url, init) => {
      if (++step === 1) return call('read_tab_branch', { recordId: record.id, offset: 0 });
      const body = requestSchema.parse(JSON.parse(String(init?.body)));
      const data = JSON.parse(body.messages.at(-1)?.content || '{}');
      expect(data.total).toBe(2);
      expect(data.tabs.map((tab: { id: string }) => tab.id)).toEqual([record.id, child.id]);
      expect(data.tabs[1]).toMatchObject({
        parentRecordId: record.id,
        branchName: 'Related reference',
      });
      expect(data.nextOffset).toBeNull();
      return text('The branch contains two saved tab occurrences.');
    });
    const result = await answerWorkQuestion(state, 'Show the child tabs in this branch.');
    expect(result.command).toBeUndefined();
    expect(result.plan).toBeUndefined();
    expect(step).toBe(2);
  });
  it('composes sequential tag additions as operations rather than stale replacements', async () => {
    let step = 0;
    stubFetch('fetch', async () =>
      ++step < 3
        ? call('prepare_tab_organization', {
            recordIds: [record.id],
            membership: null,
            addTags: [step === 1 ? 'alpha' : 'beta'],
            removeTags: [],
            note: null,
          })
        : text('Both additions are ready for review.'),
    );
    const result = await answerWorkQuestion(app, 'Add alpha, then also beta to this tab.');
    expect(result.command?.kind).toBe('workspace_edits');
    if (result.command?.kind !== 'workspace_edits') throw new Error('Missing edits');
    expect(result.command.edits.map(({ edit }) => edit)).toEqual([
      { kind: 'tags', recordId: record.id, mode: 'add', tags: ['alpha'] },
      { kind: 'tags', recordId: record.id, mode: 'add', tags: ['beta'] },
    ]);
  });
  it('ignores a false tag-workflow prediction for a merge request without starting inference tagging', async () => {
    const saved: CollectionProposal = {
      id: 'merge-target',
      createdAt: 1,
      status: 'pending',
      summary: 'Merge target',
      projects: [],
      assignments: [],
      scopeRecordIds: [record.id],
      unresolvedRecordIds: [record.id],
    };
    let calls = 0;
    stubFetch(
      'fetch',
      vi.fn(async () =>
        ++calls === 1
          ? text(JSON.stringify({ workflow: 'proposal_tags' }))
          : text('The merge request remains in the proposal editing workflow.'),
      ),
    );
    const tagging = vi.fn(async () => saved);
    const result = await answerWorkQuestion(
      { ...app, collectionProposals: [saved] },
      'Frappe Component Library and rtCamp React UI Library are the same, merge them.',
      [],
      undefined,
      {
        activeCollectionProposalId: saved.id,
        onCollectionTags: tagging,
        collectionCheckpoint: {
          id: 'merge-run',
          load: async () => undefined,
          save: async (analysis) => analysis,
          clear: async () => undefined,
        },
      },
    );
    expect(result.answer).toContain('proposal editing workflow');
    expect(tagging).not.toHaveBeenCalled();
    expect(calls).toBe(2);
  });
  it('falls back to native tool chat only when optional structured routing is unsupported', async () => {
    const saved: CollectionProposal = {
      id: 'routing-draft',
      createdAt: 1,
      status: 'pending',
      summary: 'References',
      projects: [],
      assignments: [],
      unresolvedRecordIds: [record.id],
    };
    const requests: string[] = [];
    vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      requests.push(body.response_format?.json_schema?.name || 'tools');
      if (body.response_format)
        return new Response(
          JSON.stringify({ error: { message: 'response_format json_schema unsupported' } }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        );
      return text('One reference tab is in this draft.');
    });
    const result = await answerWorkQuestion(
      { ...app, collectionProposals: [saved] },
      'What is in this draft?',
      [],
      undefined,
      {
        activeCollectionProposalId: saved.id,
        onCollectionTags: async () => saved,
        collectionCheckpoint: {
          id: 'routing-run',
          load: async () => undefined,
          save: async (value) => value,
          clear: async () => undefined,
        },
      },
    );
    expect(result.answer).toContain('One reference');
    expect(requests).toEqual(['proposal_workflow', 'tools']);
  });
  it('reads long notes and all saved tags through explicit metadata pages', async () => {
    const source = {
      ...record,
      note: 'x'.repeat(2400) + 'END',
      tags: Array.from({ length: 25 }, (_, index) => `tag-${index}`),
    };
    let step = 0;
    const returned: unknown[] = [];
    stubFetch('fetch', async () =>
      ++step === 1
        ? call('read_tab_metadata', { recordId: record.id, field: 'note', offset: 2000 })
        : step === 2
          ? call('read_tab_metadata', { recordId: record.id, field: 'tags', offset: 20 })
          : text('Read the complete metadata.'),
    );
    await answerWorkQuestion(
      { ...app, records: [source] },
      'Read the rest of the metadata',
      [],
      undefined,
      {
        onToolEvent: async (event) => {
          if (event.phase === 'returned' && event.tool === 'read_tab_metadata')
            returned.push(JSON.parse(event.details || '{}'));
        },
      },
    );
    expect(returned).toEqual([
      expect.objectContaining({ value: 'x'.repeat(400) + 'END', nextOffset: null, total: 2403 }),
      expect.objectContaining({
        value: ['tag-20', 'tag-21', 'tag-22', 'tag-23', 'tag-24'],
        nextOffset: null,
        total: 25,
      }),
    ]);
  });
  it('prepares multiple dated and linked tasks without silently dropping their fields', async () => {
    const tasks = ['Read', 'Review'].map((title) => ({
      title,
      notes: 'Reference',
      areaId: null,
      projectId: null,
      priority: 'normal',
      dueAt: 1900000000000,
      recordId: record.id,
    }));
    let step = 0;
    stubFetch('fetch', async () =>
      step++ === 0
        ? call('prepare_work_items', { tasks })
        : text('Two tasks are ready for review.'),
    );
    const result = await answerWorkQuestion(app, 'Create these two dated follow-ups.');
    if (result.command?.kind !== 'workspace_edits') throw new Error('Missing task batch');
    expect(result.command.edits.map(({ edit }) => edit)).toEqual(
      tasks.map((task) => ({ kind: 'create_work_item', task })),
    );
  });
  it('uses saved commit receipts without rerunning inference or requiring cleanup', async () => {
    const analysis: CollectionAnalysis = {
      id: 'committed-run',
      createdAt: 1,
      updatedAt: 1,
      revision: 1,
      purpose: 'scoped',
      instruction: 'Tags',
      reuseAcceptedTaxonomyOnly: true,
      scope: [{ id: record.id, url: record.url, navigationVersion: 0 }],
      discoveredIds: [record.id],
      classifiedIds: [record.id],
      projects: [],
      assignments: [],
      unresolvedRecordIds: [record.id],
      summaries: [],
      tagTarget: { proposalId: 'saved-draft', proposalFingerprint: 'a'.repeat(64) },
      tagCommit: { proposalId: 'saved-draft', processed: 1, tagged: 1, needsReview: 0, skipped: 0 },
    };
    const provider = vi.fn();
    vi.stubGlobal('fetch', provider);
    const result = await answerWorkQuestion(app, 'Tag all tabs', [], undefined, {
      resume: assistantMessageSchema.parse({
        id: 'answer',
        role: 'assistant',
        createdAt: 1,
        content: '',
        collectionAnalysisId: analysis.id,
      }),
      collectionCheckpoint: {
        id: analysis.id,
        load: async () => analysis,
        save: async (value) => value,
        clear: async () => {
          throw new Error('cleanup unavailable');
        },
      },
      onCollectionTags: async () => {
        throw new Error('must not replay');
      },
    });
    expect(result.answer).toContain('1 tabs processed');
    expect(provider).not.toHaveBeenCalled();
  });
  it('never opens a model permission prompt from a later tool callback', async () => {
    const request = vi.fn(async () => true);
    vi.stubGlobal('chrome', { permissions: { contains: async () => false, request } });
    await expect(requestModelAccess(app.settings, ['tags'], false)).rejects.toThrow(
      'Grant access in Settings',
    );
    expect(request).not.toHaveBeenCalled();
  });
  it.each(['proposal_tags', 'conversation'] as const)(
    'tags 335 saved occurrences without paging or post-tag application (route=%s)',
    async (workflow) => {
      const pages = Array.from({ length: 335 }, (_, index) => ({
        ...record,
        id: `reading-${index}`,
        title: 'Reading guide',
      }));
      const saved: CollectionProposal = {
        id: 'bulk-tag-target',
        createdAt: 1,
        status: 'pending',
        summary: 'Keep organization',
        projects: [project],
        scopeRecordIds: pages.map((page) => page.id),
        assignments: pages.slice(0, 283).map((page) => ({
          recordId: page.id,
          url: page.url,
          navigationVersion: page.navigationVersion,
          projectName: project.name,
          categoryName: 'Sources',
          confidence: 0.9,
          reason: 'Saved evidence',
        })),
        unresolvedRecordIds: pages.slice(283).map((page) => page.id),
      };
      const before = structuredClone(saved);
      let checkpoint: CollectionAnalysis | undefined;
      const rows = new Map<string, import('../src/shared/organization/tag-analysis').TagAnalysis>();
      let routes = 0;
      let turns = 0,
        tagRequests = 0;
      stubFetch(
        'fetch',
        vi.fn(async (_url, init) => {
          const body = JSON.parse(String(init?.body));
          if (body.response_format?.json_schema?.name === 'proposal_workflow') {
            routes++;
            return text(JSON.stringify({ workflow }));
          }
          if (body.model === 'small') {
            tagRequests++;
            return text(
              JSON.stringify({
                tags: [],
                newTags: [{ name: 'Reading', source: 'title', quote: 'Reading' }],
                uncertain: false,
              }),
            );
          }
          turns++;
          if (turns === 1)
            return call('analyze_proposal_tags', { proposalId: saved.id, recordIds: [] });
          throw new Error(
            'Bulk tagging must finish without asking the model to prepare Apply or reinterpret saved results.',
          );
        }),
        { tags: false },
      );
      const persist = vi.fn(async (draft: CollectionDraft, id?: string, fingerprint?: string) => {
        expect(id).toBe(saved.id);
        expect(fingerprint).toBe(await tagHash(saved));
        expect(draft.assignments).toHaveLength(283);
        expect(draft.unresolvedTagSuggestions).toHaveLength(52);
        expect(draft.projects).toEqual(saved.projects);
        return { ...saved, ...draft };
      });
      const result = await answerWorkQuestion(
        {
          ...app,
          records: pages,
          collectionProposals: [saved],
          settings: { ...app.settings, tagVerification: 'none' },
        },
        'Assign independent tags to every tab in this saved proposal.',
        [],
        undefined,
        {
          activeCollectionProposalId: saved.id,
          onCollectionDraft: persist,
          onCollectionTags: async (input) => {
            const rows = new Map(input.patches.map((item) => [item.recordId, item]));
            return persist(
              {
                ...saved,
                assignments: saved.assignments.map((item) => ({
                  ...item,
                  suggestedTags: rows.get(item.recordId)?.suggestedTags,
                })),
                unresolvedTagSuggestions: input.patches.filter((item) =>
                  saved.unresolvedRecordIds.includes(item.recordId),
                ),
                tagReview: [],
              },
              input.id,
              input.expectedFingerprint,
            );
          },
          collectionCheckpoint: {
            id: 'bulk-tag-run',
            load: async () => checkpoint,
            save: async (value) => {
              checkpoint = structuredClone(value);
              return value;
            },
            clear: async () => {
              checkpoint = undefined;
            },
            tags: {
              analysisId: 'bulk-tag-run',
              load: async () => [...rows.values()],
              save: async (row) => {
                rows.set(row.id, row);
              },
            },
          },
        },
      );
      expect(routes).toBe(1);
      expect(turns).toBe(workflow === 'proposal_tags' ? 0 : 1);
      expect(tagRequests).toBe(335);
      expect(persist).toHaveBeenCalledTimes(1);
      expect(result.collectionPrepared).toBe(true);
      expect(result.collectionApplyRequested).toBe(false);
      expect(saved).toEqual(before);
    },
  );
  it('requests Apply explicitly for the specified draft without performing a draft edit', async () => {
    const saved: CollectionProposal = {
      id: 'apply-target',
      createdAt: 1,
      status: 'pending',
      summary: 'Review draft',
      projects: [],
      assignments: [],
      unresolvedRecordIds: [record.id],
    };
    let turns = 0;
    stubFetch(
      'fetch',
      vi.fn(async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        if (body.response_format?.json_schema?.name === 'proposal_workflow')
          return text(JSON.stringify({ workflow: 'conversation' }));
        return ++turns === 1
          ? call('prepare_organization_application', { proposalId: saved.id })
          : text('Organization is ready for application approval.');
      }),
    );
    const persist = vi.fn();
    const result = await answerWorkQuestion(
      { ...app, collectionProposals: [saved] },
      'Apply the saved draft.',
      [],
      undefined,
      {
        activeCollectionProposalId: saved.id,
        onCollectionDraft: persist,
        onCollectionTags: async () => {
          throw new Error('Apply requests must not run tagging.');
        },
        collectionCheckpoint: {
          id: 'unused-tag-run',
          load: async () => undefined,
          save: async (analysis) => analysis,
          clear: async () => undefined,
        },
      },
    );
    expect(result.collectionApplyRequested).toBe(true);
    expect(result.collectionApplicationId).toBe(saved.id);
    expect(persist).not.toHaveBeenCalled();
    expect(saved.status).toBe('pending');
  });
  it('discovers and validates a draft tool in a constrained context without losing the capability or changing its budget', async () => {
    const saved: CollectionProposal = {
      id: 'catalog-target',
      createdAt: 1,
      status: 'pending',
      summary: 'Retain summary',
      projects: [project],
      assignments: [],
      unresolvedRecordIds: [record.id],
      scopeRecordIds: [record.id],
    };
    let named: CollectionDraft | undefined;
    let turn = 0;
    stubFetch(
      'fetch',
      vi.fn(async (_url, init) => {
        const body = z
          .object({
            tools: z.array(z.object({ function: z.object({ name: z.string() }) })),
            messages: z.array(
              z.object({ role: z.string(), content: z.string().nullable().optional() }),
            ),
          })
          .parse(JSON.parse(String(init?.body)));
        expect(body.tools.some((tool) => tool.function.name === 'search_workspace_tools')).toBe(
          true,
        );
        expect(
          body.tools.some((tool) => tool.function.name === 'rename_organization_proposal'),
        ).toBe(false);
        if (turn++ === 0)
          return call('search_workspace_tools', {
            query: 'rename_organization_proposal',
            offset: 0,
          });
        const data = JSON.parse(body.messages.at(-1)?.content || '{}');
        if (turn === 2) {
          expect(data.tools[0].name).toBe('rename_organization_proposal');
          return call('run_workspace_tool', {
            name: 'rename_organization_proposal',
            argumentsJson: JSON.stringify({ proposalId: saved.id, name: null, summary: null }),
          });
        }
        if (turn === 3) {
          expect(data.ok).toBe(false);
          expect(named).toBeUndefined();
          return call('run_workspace_tool', {
            name: 'rename_organization_proposal',
            argumentsJson: JSON.stringify({
              proposalId: saved.id,
              name: 'Small context draft',
              summary: null,
            }),
          });
        }
        expect(data).toMatchObject({
          proposalId: saved.id,
          name: 'Small context draft',
          applied: false,
        });
        return text('The saved proposal was renamed only.');
      }),
    );
    await answerWorkQuestion(
      {
        ...app,
        collectionProposals: [saved],
        settings: { ...app.settings, aiContextTokens: 32768, aiCompletionTokens: 16384 },
      },
      'Rename the catalog-target proposal Small context draft; preserve everything else.',
      [],
      undefined,
      {
        onCollectionDraft: async (draft) => {
          named = draft;
          return { ...saved, ...draft };
        },
      },
    );
    expect(named?.name).toBe('Small context draft');
    expect(named?.projects).toEqual(saved.projects);
    expect(saved.name).toBeUndefined();
  });
  it('forks a named proposal subset, then compares drafts without consuming the source', async () => {
    const source: CollectionProposal = {
      id: 'source-draft',
      createdAt: 1,
      status: 'undone',
      summary: 'Original summary',
      sourceJobIds: ['original-queue-link'],
      scopeRecordIds: [record.id],
      projects: [project],
      assignments: [
        {
          recordId: record.id,
          url: record.url,
          navigationVersion: record.navigationVersion,
          projectName: project.name,
          categoryName: 'Sources',
          confidence: 0.9,
          reason: 'Reference evidence',
        },
      ],
      unresolvedRecordIds: [],
    };
    let latest: CollectionProposal | undefined;
    let turn = 0;
    stubFetch(
      'fetch',
      vi.fn(async (_url, init) => {
        const body = requestSchema.parse(JSON.parse(String(init?.body)));
        if (turn++ === 0)
          return call('copy_organization_proposal', {
            sourceProposalId: source.id,
            name: 'Alternative reading plan',
            projectNames: [project.name],
          });
        if (turn === 2) {
          expect(JSON.parse(body.messages.at(-1)?.content || '{}')).toMatchObject({
            proposalId: 'forked-draft',
            sourcePreserved: true,
            applied: false,
          });
          return call('compare_organization_proposals', {
            leftProposalId: source.id,
            rightProposalId: 'forked-draft',
            offset: 0,
          });
        }
        expect(JSON.parse(body.messages.at(-1)?.content || '{}').conflictCount).toBe(0);
        return text('The separate copy is ready. The original is retained.');
      }),
    );
    const result = await answerWorkQuestion(
      { ...app, collectionProposals: [source] },
      'Create a separate copy of source-draft containing Research named Alternative reading plan, then compare it with the original. Do not apply.',
      [],
      undefined,
      {
        onCollectionDraft: async (draft, id) => {
          expect(id).toBeUndefined();
          validateCollectionDraft(draft, new Set([record.id]));
          latest = { ...draft, id: 'forked-draft', createdAt: 2, status: 'pending' };
          return latest;
        },
      },
    );
    expect(result.collectionPrepared).toBe(true);
    expect(latest?.name).toBe('Alternative reading plan');
    expect(latest?.sourceJobIds).toBeUndefined();
    expect(latest?.assignments).toEqual(source.assignments);
    expect(source.sourceJobIds).toEqual(['original-queue-link']);
  });
  it('merges the named source INTO the exact older target and reads its updated occurrences in the same turn', async () => {
    const target: CollectionProposal = {
      id: 'target',
      name: 'Main draft',
      createdAt: 1,
      status: 'pending',
      summary: 'Main',
      projects: [],
      assignments: [],
      scopeRecordIds: [record.id],
      unresolvedRecordIds: [record.id],
    };
    const source: CollectionProposal = {
      ...target,
      id: 'source',
      status: 'undone',
      name: 'Extra references',
      projects: [project],
      assignments: [
        {
          recordId: record.id,
          url: record.url,
          navigationVersion: record.navigationVersion,
          projectName: project.name,
          categoryName: 'Sources',
          confidence: 0.9,
          reason: 'Reference evidence',
        },
      ],
      unresolvedRecordIds: [],
    };
    const merge = vi.fn(async (input) => {
      expect(input.targetProposalId).toBe(target.id);
      expect(input.sourceProposalId).toBe(source.id);
      expect(input.targetFingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(input.sourceFingerprint).toMatch(/^[a-f0-9]{64}$/);
      const result = mergeProposalDrafts(
        target,
        source,
        input.projectNames,
        input.assignmentConflict,
      );
      return { proposal: { ...target, ...result.draft }, conflicts: result.conflicts };
    });
    let turn = 0;
    stubFetch(
      'fetch',
      vi.fn(async (_url, init) => {
        const body = requestSchema.parse(JSON.parse(String(init?.body)));
        if (turn++ === 0)
          return call('merge_organization_proposals', {
            targetProposalId: target.id,
            sourceProposalId: source.id,
            projectNames: [project.name],
            assignmentConflict: 'keep_target',
          });
        const last = JSON.parse(body.messages.at(-1)?.content || '{}');
        if (turn === 2) {
          expect(last).toMatchObject({
            proposalId: target.id,
            sourcePreserved: true,
            assignedCount: 1,
            unresolvedCount: 0,
            applied: false,
          });
          return call('read_proposal_occurrences', {
            proposalId: target.id,
            status: 'assigned',
            query: '',
            projectName: null,
            offset: 0,
          });
        }
        expect(last.occurrences[0].recordId).toBe(record.id);
        return text('Merged source into target. The source remains unchanged.');
      }),
    );
    const result = await answerWorkQuestion(
      { ...app, collectionProposals: [target, source] },
      'Merge source into the older target proposal, preserving the source; do not apply.',
      [],
      undefined,
      { onCollectionMerge: merge },
    );
    expect(result.collectionPrepared).toBe(true);
    expect(merge).toHaveBeenCalledTimes(1);
    expect(source.status).toBe('undone');
    expect(target.assignments).toEqual([]);
  });

  it('prepares a tag rename outside proposals while retaining unrelated tags and skipping protected tabs', async () => {
    const records = [
      { ...record, tags: ['legacy', 'reading'] },
      { ...record, id: 'protected', locked: true, tags: ['legacy'] },
    ];
    let turn = 0;
    stubFetch(
      'fetch',
      vi.fn(async () =>
        turn++ === 0
          ? call('prepare_tag_maintenance', {
              action: 'rename_or_merge',
              sourceTag: 'legacy',
              targetTag: 'reference',
              recordIds: [],
            })
          : text('Ready to review the tag rename.'),
      ),
    );
    const result = await answerWorkQuestion(
      { ...app, records },
      'Rename legacy to reference on my existing tabs, retaining other tags.',
      [],
      undefined,
    );
    if (result.command?.kind !== 'workspace_edits') throw new Error('Missing tag edit');
    expect(result.command.edits.map((item) => item.edit)).toEqual([
      { kind: 'tags', recordId: record.id, mode: 'replace', tags: ['reading', 'reference'] },
    ]);
    expect(records[0]?.tags).toEqual(['legacy', 'reading']);
    expect(records[1]?.tags).toEqual(['legacy']);
  });
  it('consolidates accepted memberships using explicit category mappings without deleting projects or applying edits', async () => {
    const projects = ['source-project', 'target-project'].map((id) => ({
      id,
      name: id,
      purpose: '',
      updatedAt: 1,
      revision: 1,
      maintainReviewQueue: false,
    }));
    const categories = projects.map((item) => ({
      id: `${item.id}-reading`,
      projectId: item.id,
      name: 'Reading',
      description: '',
      order: 0,
      updatedAt: 1,
      revision: 1,
    }));
    const memberships = [
      {
        recordId: record.id,
        projectId: projects[0]!.id,
        categoryId: categories[0]!.id,
        source: 'owner' as const,
        updatedAt: 1,
      },
    ];
    let turn = 0;
    stubFetch(
      'fetch',
      vi.fn(async () =>
        turn++ === 0
          ? call('prepare_project_consolidation', {
              sourceProjectId: projects[0]!.id,
              targetProjectId: projects[1]!.id,
              categoryMappings: [
                { sourceCategoryId: categories[0]!.id, targetCategoryId: categories[1]!.id },
              ],
            })
          : text('Membership consolidation is ready for approval. Both projects remain.'),
      ),
    );
    const result = await answerWorkQuestion(
      { ...app, projects, categories, memberships },
      'Combine the source memberships into target Reading, keeping both projects.',
      [],
      undefined,
    );
    if (result.command?.kind !== 'workspace_edits') throw new Error('Missing membership draft');
    expect(result.command.edits.map((item) => item.edit)).toEqual([
      {
        kind: 'membership',
        recordId: record.id,
        projectId: projects[1]!.id,
        categoryId: categories[1]!.id,
      },
    ]);
    expect(memberships[0]?.projectId).toBe(projects[0]!.id);
    expect(projects).toHaveLength(2);
  });
  it('adds a project/category and renames an explicitly targeted proposal from another chat without erasing metadata', async () => {
    const saved: CollectionProposal = {
      id: 'older-target',
      createdAt: 1,
      status: 'pending',
      summary: 'Keep this analysis',
      decisionContract: 'isolated-evidence-v2',
      projects: [structuredClone(project)],
      assignments: [],
      scopeRecordIds: [record.id],
      unresolvedRecordIds: [record.id],
      unresolvedTagSuggestions: [
        {
          recordId: record.id,
          url: record.url,
          navigationVersion: record.navigationVersion,
          suggestedTags: ['reference'],
        },
      ],
    };
    let step = 0;
    let latest = saved;
    const persist = vi.fn(
      async (draft: CollectionDraft, id?: string, expectedFingerprint?: string) => {
        expect(id).toBe(saved.id);
        expect(expectedFingerprint).toMatch(/^[a-f0-9]{64}$/);
        validateCollectionDraft(draft, new Set([record.id]));
        latest = { ...latest, ...structuredClone(draft) };
        return latest;
      },
    );
    stubFetch(
      'fetch',
      vi.fn(async (_url, init) => {
        const body = requestSchema.parse(JSON.parse(String(init?.body)));
        const result = body.messages.at(-1)?.content || '{}';
        switch (step++) {
          case 0:
            return call('refine_organization_proposal', {
              proposalId: saved.id,
              projectEdits: [
                { previousName: project.name, name: project.name, purpose: '', areaName: null },
                {
                  previousName: '',
                  name: 'Video study',
                  purpose: 'Course material',
                  areaName: null,
                },
              ],
              categoryEdits: [
                {
                  projectName: 'Video study',
                  previousName: '',
                  name: 'Lessons',
                  description: 'Course lessons',
                },
              ],
              assignments: [
                { recordId: record.id, projectName: 'Video study', categoryName: 'Lessons' },
              ],
              tagEdits: [],
            });
          case 1:
            expect(JSON.parse(result).proposalId).toBe(saved.id);
            return call('rename_organization_proposal', {
              proposalId: saved.id,
              name: 'Weekend reading',
              summary: null,
            });
          case 2:
            return call('read_proposal_occurrences', {
              proposalId: saved.id,
              status: 'assigned',
              query: 'reference',
              projectName: null,
              offset: 0,
            });
          default:
            expect(JSON.parse(result).occurrences).toHaveLength(1);
            return text('Updated older-target as a draft only.');
        }
      }),
    );
    const result = await answerWorkQuestion(
      { ...app, collectionProposals: [saved] },
      'Edit proposal older-target from this chat: add a video study project and label this proposal Weekend reading. Do not apply.',
      [],
      undefined,
      { activeCollectionProposalId: 'another-chat-draft', onCollectionDraft: persist },
    );
    expect(result.collectionPrepared).toBe(true);
    expect(latest.name).toBe('Weekend reading');
    expect(latest.projects[0]).toEqual(project);
    expect(latest.projects[1]?.areaName).toBeNull();
    expect(latest.assignments[0]?.suggestedTags).toEqual(['reference']);
    expect(latest.assignments[0]?.categoryName).toBe('Lessons');
    expect(latest.summary).toBe(saved.summary);
    expect(latest.decisionContract).toBe(saved.decisionContract);
    expect(persist).toHaveBeenCalledTimes(2);
    expect(saved.projects).toEqual([project]);
    expect(saved.assignments).toEqual([]);
  });

  it('creates a category and assigns 111 matching proposal tabs in one host edit, then excludes them without occurrence paging', async () => {
    const records = [
      ...Array.from({ length: 111 }, (_, index) => ({
        ...record,
        id: `steam-${index}`,
        title: `Steam game ${index}`,
        url: `https://store.steampowered.com/app/${index}`,
      })),
      { ...record, id: 'unrelated', title: 'Other reference' },
    ];
    const source: CollectionProposal = {
      id: 'bulk-target',
      createdAt: 1,
      status: 'pending',
      summary: 'Preserve source',
      projects: [],
      assignments: [],
      scopeRecordIds: records.map((item) => item.id),
      unresolvedRecordIds: records.map((item) => item.id),
    };
    let latest = structuredClone(source);
    const saved = vi.fn(async (draft: CollectionDraft) => {
      validateCollectionDraft(draft, new Set(records.map((item) => item.id)));
      latest = { ...latest, ...structuredClone(draft) };
      return latest;
    });
    let step = 0;
    const provider = vi.fn(async (_url, init) => {
      const body = requestSchema.parse(JSON.parse(String(init?.body)));
      if (step++ === 0)
        return call('refine_organization_proposal', {
          proposalId: source.id,
          projectEdits: [
            { previousName: '', name: 'Gaming', purpose: 'Steam collection', areaName: null },
          ],
          categoryEdits: [
            { projectName: 'gaming', previousName: '', name: 'Steam library', description: '' },
          ],
          assignments: [],
          tagEdits: [],
          assignmentGroups: [
            {
              query: 'steampowered.com',
              fromProjectName: null,
              fromCategoryName: null,
              status: 'uncertain',
              projectName: 'gaming',
              categoryName: 'steam library',
            },
          ],
        });
      if (step === 2) {
        expect(JSON.parse(body.messages.at(-1)?.content || '{}').affectedRecordIds).toHaveLength(
          111,
        );
        return call('set_proposal_tabs_included', {
          proposalId: source.id,
          recordIds: [],
          query: 'steampowered.com',
          projectName: 'Gaming',
          status: 'assigned',
          included: false,
        });
      }
      expect(JSON.parse(body.messages.at(-1)?.content || '{}').affectedCount).toBe(111);
      return text(
        'Created Gaming / Steam library and removed matching tabs from this draft as requested. Nothing applied.',
      );
    });
    stubFetch('fetch', provider);
    const result = await answerWorkQuestion(
      { ...app, records, collectionProposals: [source] },
      'Create Gaming / Steam library in proposal bulk-target, move all Steam tabs there, then exclude those tabs from the draft. Do not apply.',
      [],
      undefined,
      { onCollectionDraft: saved },
    );
    expect(result.collectionPrepared).toBe(true);
    expect(provider).toHaveBeenCalledTimes(3);
    expect(saved).toHaveBeenCalledTimes(2);
    expect(latest.assignments).toHaveLength(111);
    expect(
      latest.assignments.every(
        (item) => item.projectName === 'Gaming' && item.categoryName === 'Steam library',
      ),
    ).toBe(true);
    expect(latest.excludedRecordIds).toHaveLength(111);
    expect(latest.unresolvedRecordIds).toEqual(['unrelated']);
    expect(source.assignments).toEqual([]);
    expect(source.projects).toEqual([]);
    expect(latest.status).toBe('pending');
  });
  it('prepares batch membership, tags and notes for existing tabs with no proposal', async () => {
    let turn = 0;
    const current = { ...app, records: [{ ...record, tags: ['reading', 'old'] }] };
    stubFetch(
      'fetch',
      vi.fn(async () =>
        turn++ === 0
          ? call('prepare_tab_organization', {
              recordIds: [record.id],
              membership: { projectId: null, categoryId: null },
              addTags: ['reference'],
              removeTags: ['old'],
              note: 'Read this next',
            })
          : text('The tab edits are ready for approval.'),
      ),
    );
    const result = await answerWorkQuestion(
      current,
      'Move this tab to Inbox, replace old with reference, keep reading and add my note.',
      [],
      undefined,
    );
    expect(result.command?.kind).toBe('workspace_edits');
    if (result.command?.kind !== 'workspace_edits') throw new Error('Missing edit draft');
    expect(result.command.edits.map((item) => item.edit)).toEqual([
      { kind: 'membership', recordId: record.id, projectId: null, categoryId: null },
      { kind: 'tags', recordId: record.id, mode: 'remove', tags: ['old'] },
      { kind: 'tags', recordId: record.id, mode: 'add', tags: ['reference'] },
      { kind: 'note', recordId: record.id, note: 'Read this next' },
    ]);
    expect(current.records[0]?.tags).toEqual(['reading', 'old']);
    expect(current.collectionProposals).toEqual([]);
  });
  it('retrieves an earlier fixed attachment scope without including later tabs in that window', async () => {
    let requests = 0;
    stubFetch(
      'fetch',
      vi.fn(async (_url, init) => {
        requests++;
        if (requests === 1)
          return call('read_attached_context', { messageId: 'earlier-user', offset: 0 });
        const body = requestSchema.parse(JSON.parse(String(init?.body)));
        const result = JSON.parse(
          body.messages.findLast((message) => message.role === 'tool')!.content!,
        );
        expect(result.total).toBe(2);
        expect(result.tabs.map((item: { id: string }) => item.id)).toEqual([
          record.id,
          'closed-occurrence',
        ]);
        expect(result.tabs[1].available).toBe(false);
        return text('The attached reference is still available; the other tab was closed.');
      }),
    );
    const result = await answerWorkQuestion(
      { ...app, records: [record, { ...record, id: 'new-tab-in-window' }] },
      'Which of those tabs are still open?',
      [],
      undefined,
      {
        attachmentHistory: [
          {
            messageId: 'earlier-user',
            attachments: [{ kind: 'window', id: '1', label: 'Window 1' }],
            recordIds: [record.id, 'closed-occurrence'],
          },
        ],
      },
    );
    expect(result.sources.map((source) => source.recordId)).toEqual([record.id]);
  });
  it('sends persisted images as native image parts and rejects unconfigured vision requests before network access', async () => {
    const image = {
      id: 'image',
      name: 'reference.png',
      dataUrl:
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=',
    };
    const provider = vi.fn(async (_url, init) => {
      const body = z
        .object({ messages: z.array(z.object({ role: z.string(), content: z.unknown() })) })
        .parse(JSON.parse(String(init?.body)));
      expect(body.messages.at(-1)?.content).toEqual([
        { type: 'text', text: 'Describe this image' },
        { type: 'image_url', image_url: { url: image.dataUrl } },
      ]);
      return text('Image request received.');
    });
    vi.stubGlobal('fetch', provider);
    await expect(
      answerWorkQuestion(app, 'Describe this image', [], undefined, { images: [image] }),
    ).rejects.toThrow('Enable image input');
    expect(provider).not.toHaveBeenCalled();
    const configured = {
      ...app,
      settings: {
        ...app.settings,
        imageModel: app.settings.aiModel,
        imageBase: app.settings.aiBase,
      },
    };
    expect(
      (
        await answerWorkQuestion(configured, 'Describe this image', [], undefined, {
          images: [image],
        })
      ).answer,
    ).toBe('Image request received.');
    expect(provider).toHaveBeenCalledTimes(1);
  });
  it('bounds searchable attachment pages while retaining independent duplicate occurrences', () => {
    const workspace = {
      ...app,
      records: Array.from({ length: 205 }, (_, index) => ({
        ...record,
        id: `reference-${index}`,
        title: `Library reference ${index}`,
        url: 'https://example.test/shared',
      })),
    };
    const first = searchAttachments(workspace, 'Library reference', 0);
    const second = searchAttachments(workspace, 'Library reference', 50);
    const last = searchAttachments(workspace, 'Library reference', 200);
    expect(first.items).toHaveLength(50);
    expect(first.hasMore).toBe(true);
    expect(second.items[0]?.id).toBe('reference-50');
    expect(last.items).toHaveLength(5);
    expect(last.hasMore).toBe(false);
    expect(searchAttachments(workspace, 'https://example.test/shared', 0).items).toHaveLength(50);
  });
  it('resolves overlapping attachments without collapsing duplicate occurrences and rejects stale references', () => {
    const workspace = {
      ...app,
      records: [record, { ...record, id: 'duplicate', tags: ['source'] }],
      tagVocabulary: ['unused'],
    };
    expect(
      resolveAttachments(workspace, [
        { kind: 'window', id: '1', label: 'Window' },
        { kind: 'tab', id: record.id, label: 'Tab' },
      ]),
    ).toEqual([record.id, 'duplicate']);
    const selection = {
      kind: 'selection' as const,
      id: 'selected-context',
      label: '2 selected tabs',
      recordIds: [record.id, 'duplicate'],
    };
    expect(
      resolveAttachments(
        { ...workspace, records: [...workspace.records, { ...record, id: 'later-tab' }] },
        [selection],
      ),
    ).toEqual([record.id, 'duplicate']);
    expect(() => resolveAttachments({ ...workspace, records: [record] }, [selection])).toThrow(
      'no longer open',
    );

    expect(
      resolveAttachments(workspace, [{ kind: 'tag', id: 'unused', label: 'Unused tag' }]),
    ).toEqual([]);
    expect(() =>
      resolveAttachments(workspace, [{ kind: 'tab', id: 'gone', label: 'Closed tab' }]),
    ).toThrow('no longer available');
  });
  it('combines direct tag/note edits without classifier calls and refuses targets outside attached scope', async () => {
    let requests = 0;
    stubFetch(
      'fetch',
      vi.fn(async () => {
        requests++;
        if (requests === 1)
          return call('prepare_workspace_edits', {
            summary: 'Outside scope',
            edits: [{ kind: 'note', recordId: 'other', note: 'Do not change' }],
          });
        if (requests === 2)
          return call('prepare_workspace_edits', {
            summary: 'Add source label',
            edits: [{ kind: 'tags', recordId: record.id, mode: 'add', tags: ['source'] }],
          });
        if (requests === 3)
          return call('prepare_workspace_edits', {
            summary: 'Add note',
            edits: [{ kind: 'note', recordId: record.id, note: 'Read the methods section' }],
          });
        return text('Two edits ready for review.');
      }),
    );
    const result = await answerWorkQuestion(
      { ...app, records: [record, { ...record, id: 'other' }] },
      'Tag this tab and add a note',
      [],
      undefined,
      { context: { projectId: null, selectedRecordIds: [record.id], scopeRecordIds: [record.id] } },
    );
    expect(result.command?.kind).toBe('workspace_edits');
    if (result.command?.kind !== 'workspace_edits') throw new Error('Missing edits');
    expect(result.command.edits).toHaveLength(2);
    expect(
      result.command.edits.every(({ edit }) => 'recordId' in edit && edit.recordId === record.id),
    ).toBe(true);
    expect(result.activity.join(' ')).not.toContain('Delegated');
    expect(requests).toBe(4);
  });
  it('lets the chat model submit its own complete proposal with an explicit routing choice', async () => {
    let requests = 0;
    const save = vi.fn(async (draft: CollectionDraft) => ({
      ...draft,
      id: 'chat-draft',
      createdAt: 1,
      status: 'pending' as const,
    }));
    stubFetch(
      'fetch',
      vi.fn(async () => {
        requests++;
        if (requests === 1)
          return call('prepare_project_from_tabs', {
            instruction: 'Organize',
            recordIds: [record.id],
          });
        if (requests === 2)
          return call('prepare_orchestrator_organization', {
            summary: 'Research references',
            recordIds: [record.id],
            projects: [project],
            assignments: [
              {
                recordId: record.id,
                projectName: project.name,
                categoryName: 'Sources',
                suggestedTags: ['reference'],
                reason: 'Reference page title',
                confidence: 0.8,
              },
            ],
            unresolvedRecordIds: [],
          });
        return text('Chat-model proposal ready.');
      }),
    );
    const result = await answerWorkQuestion(app, 'Organize this reference', [], undefined, {
      context: {
        projectId: null,
        selectedRecordIds: [record.id],
        scopeRecordIds: [record.id],
        classificationMode: 'chat',
      },
      onCollectionDraft: save,
    });
    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0]![0].assignments[0]?.url).toBe(record.url);
    expect(result.collectionPrepared).toBe(true);
    expect(result.sources[0]?.recordId).toBe(record.id);
    expect(requests).toBe(3);
  });
  it('completes empty categories in a compatible checkpoint without redoing completed classifications', async () => {
    const inbox = { ...record, id: 'inbox-occurrence', url: 'https://mail.example.com/inbox' };
    let saved: CollectionAnalysis = {
      decisionContract: CLASSIFICATION_CONTRACT,
      id: 'old-empty-taxonomy',
      createdAt: 1,
      updatedAt: 2,
      revision: 2,
      purpose: 'proposal',
      instruction: 'Organize my tabs',
      reuseAcceptedTaxonomyOnly: false,
      scope: [record, inbox].map(({ id, url, navigationVersion }) => ({
        id,
        url,
        navigationVersion,
      })),
      discoveredIds: [record.id, inbox.id],
      classifiedIds: [record.id],
      summaries: ['Proposed projects'],
      projects: [
        project,
        {
          name: 'Personal inbox',
          purpose: 'Daily communication',
          areaName: 'Personal',
          categories: [],
        },
      ],
      assignments: [
        {
          recordId: record.id,
          url: record.url,
          navigationVersion: record.navigationVersion,
          projectName: project.name,
          categoryName: 'Sources',
          reason: 'Saved decision',
          confidence: 0.9,
        },
      ],
      unresolvedRecordIds: [],
    };
    let repairRequests = 0;
    stubFetch(
      'fetch',
      vi.fn(async (_url, init) => {
        const body = requestSchema.parse(JSON.parse(String(init?.body)));
        if (body.model === 'large') {
          repairRequests++;
          const request = JSON.parse(
            body.messages.find((message) => message.role === 'user')?.content || '{}',
          ) as Record<string, unknown>;
          expect(request.tabs).toBeUndefined();
          return text(
            JSON.stringify({
              summary: 'Proposed inbox category',
              projects: [
                {
                  name: 'Personal inbox',
                  purpose: 'Daily communication',
                  areaName: 'Personal',
                  categories: [{ name: 'Inbox', description: 'Inbox pages' }],
                },
              ],
            }),
          );
        }
        const tabs = JSON.parse(
          body.messages.find((message) => message.role === 'user')?.content || '{}',
        ).tabs as Array<{ id: string }>;
        expect(tabs.map((tab) => tab.id)).toEqual([inbox.id]);
        return text(
          JSON.stringify({
            assignments: [
              { recordId: inbox.id, choice: 'c1', reason: 'Inbox page', confidence: 0.9 },
            ],
          }),
        );
      }),
    );
    const draft = await generateCollectionDraft(
      { ...app, records: [record, inbox] },
      {
        instruction: saved.instruction,
        checkpoint: {
          id: saved.id,
          load: async () => saved,
          save: async (analysis) => (saved = collectionAnalysisSchema.parse(analysis)),
        },
      },
    );
    expect(repairRequests).toBe(1);
    expect(draft.assignments.find((item) => item.recordId === record.id)?.reason).toBe(
      'Saved decision',
    );
    expect(draft.assignments.find((item) => item.recordId === inbox.id)?.categoryName).toBe(
      'Inbox',
    );
  });
  it('reports a local context limit clearly instead of an SDK connection error', async () => {
    const fetch = vi.fn();
    stubFetch('fetch', fetch);
    await expect(
      answerWorkQuestion(app, 'Current owner instructions '.repeat(10000)),
    ).rejects.toThrow(/exceed the estimated context budget/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects an empty-category discovery result before classification and retries with usable choices', async () => {
    let discoveryRequests = 0;
    stubFetch(
      'fetch',
      vi.fn(async (_url, init) => {
        const body = requestSchema.parse(JSON.parse(String(init?.body)));
        if (body.model === 'large') {
          discoveryRequests++;
          return text(
            JSON.stringify({
              summary: 'Proposed inbox project',
              projects: [
                {
                  name: 'Personal inbox',
                  purpose: 'Daily communication',
                  areaName: 'Personal',
                  categories:
                    discoveryRequests === 1 ? [] : [{ name: 'Inbox', description: 'Inbox pages' }],
                },
              ],
            }),
          );
        }
        expect(body.messages.find((message) => message.role === 'user')?.content).toContain(
          'Personal inbox / Inbox',
        );
        return text(
          JSON.stringify({
            assignments: [
              { recordId: record.id, choice: 'c0', reason: 'Inbox page', confidence: 0.9 },
            ],
          }),
        );
      }),
    );
    const draft = await generateCollectionDraft(app);
    expect(discoveryRequests).toBe(2);
    expect(draft.assignments[0]?.categoryName).toBe('Inbox');
  });
  it('reports partial current coverage when unrelated new tabs open during preparation', async () => {
    let step = 0;
    const currentApp = {
      ...app,
      records: [record, { ...record, id: 'new-occurrence', url: 'https://example.com/new' }],
    };
    stubFetch(
      'fetch',
      vi.fn(async (_url, init) => {
        const body = requestSchema.parse(JSON.parse(String(init?.body)));
        if (step++ === 0)
          return call('prepare_whole_collection_organization', {
            confirmation: 'prepare_reviewable_proposal',
          });
        if (body.model === 'large' && body.response_format)
          return text(JSON.stringify({ summary: 'Proposed research', projects: [project] }));
        if (body.model === 'small')
          return text(
            JSON.stringify({
              assignments: [
                { recordId: record.id, choice: 'c0', reason: 'Reference', confidence: 0.9 },
              ],
            }),
          );
        const result = JSON.parse(
          body.messages.findLast((message) => message.role === 'tool')?.content || '{}',
        ) as Record<string, unknown>;
        expect(result).toMatchObject({
          scopedOccurrences: 1,
          eligibleOccurrences: 2,
          coversCurrentCollection: false,
        });
        return text('One occurrence analyzed; the newly opened tab is outside this proposal.');
      }),
    );
    let saved: CollectionAnalysis | undefined;
    const result = await answerWorkQuestion(app, 'Organize all tabs', [], undefined, {
      collectionCheckpoint: {
        id: 'coverage-analysis',
        load: async () => saved,
        save: async (analysis) => (saved = structuredClone(analysis)),
        clear: async () => {
          saved = undefined;
        },
        refreshApp: async () => currentApp,
      },
      onCollectionDraft: async (draft) => ({
        ...draft,
        id: 'coverage-proposal',
        createdAt: 1,
        status: 'pending',
      }),
    });
    expect(result.answer).toContain('newly opened');
  });
  it('accepts harmless no-filter sentinels without weakening occurrence identity checks', async () => {
    let requests = 0;
    stubFetch(
      'fetch',
      vi.fn(async () =>
        ++requests === 1
          ? call('list_tabs', { query: '', projectId: 'None', windowId: 0, offset: 0 })
          : text('One reference found.'),
      ),
    );
    const result = await answerWorkQuestion(app, 'Find my reference');
    expect(result.sources.map((source) => source.recordId)).toContain(record.id);
    expect(requests).toBe(2);
  });
  it('stops repeated invalid tool arguments with a retryable failure after three attempts', async () => {
    let requests = 0;
    stubFetch(
      'fetch',
      vi.fn(async () => {
        requests++;
        return call('list_tabs', {
          query: '',
          projectId: 'nonexistent-project',
          windowId: null,
          offset: 0,
        });
      }),
    );
    await expect(answerWorkQuestion(app, 'Find a reference')).rejects.toThrow('three consecutive');
    expect(requests).toBe(3);
  });
  it('does not accept textual tool markup as a successful answer', async () => {
    stubFetch(
      'fetch',
      vi.fn(async () => text('<tool_call><function=list_tabs></function></tool_call>')),
    );
    await expect(answerWorkQuestion(app, 'Find my tabs')).rejects.toThrow('tool-call markup');
  });
  it('leaves tool-round exhaustion retryable instead of marking an incomplete run complete', async () => {
    let toolRounds = 0;
    let summaryRequests = 0;
    stubFetch(
      'fetch',
      vi.fn(async (_url, init) => {
        const request: unknown = JSON.parse(String(init?.body));
        const body = z
          .object({
            tools: z.array(z.unknown()).optional(),
            messages: z.array(z.object({ role: z.string(), content: z.unknown().optional() })),
          })
          .parse(request);
        if (body.tools?.length) {
          toolRounds++;
          return call('list_tabs', {
            query: `different-search-${toolRounds}`,
            projectId: null,
            windowId: null,
            offset: 0,
          });
        }
        summaryRequests++;
        expect(body.messages[0]?.role).toBe('system');
        expect(String(body.messages[0]?.content)).toContain('tool round limit');
        expect(body.messages.filter((message) => message.role === 'tool')).toHaveLength(10);
        return text('One sleeping reference is available. No organization proposal was prepared.');
      }),
    );
    await expect(answerWorkQuestion(app, 'Describe my workspace')).rejects.toThrow(
      'Tool round limit reached',
    );
    expect(toolRounds).toBe(10);
    expect(summaryRequests).toBe(0);
  });
  it('persists taxonomy accumulated across batches beyond a single response category limit', async () => {
    const records = Array.from({ length: 13 }, (_, index) => ({
      ...record,
      id: `category-${index}`,
      url: `https://example.com/${index}`,
    }));
    let saved: CollectionAnalysis | undefined;
    let discovered = 0;
    stubFetch(
      'fetch',
      vi.fn(async (_url, init) => {
        const body = requestSchema.parse(JSON.parse(String(init?.body)));
        if (body.model === 'large')
          return text(
            JSON.stringify({
              summary: 'Research',
              projects: [
                {
                  ...project,
                  categories: [
                    { name: `Part ${++discovered}`, description: 'Specific project part' },
                  ],
                },
              ],
            }),
          );
        const tabs = JSON.parse(
          body.messages.find((message) => message.role === 'user')?.content || '{}',
        ).tabs as Array<{ id: string }>;
        return text(
          JSON.stringify({
            assignments: tabs.map((tab) => ({
              recordId: tab.id,
              choice: 'c0',
              reason: 'Reference',
              confidence: 0.9,
            })),
          }),
        );
      }),
    );
    const draft = await generateCollectionDraft(
      { ...app, records, settings: { ...app.settings, aiBatchSize: 1 } },
      {
        seedProjects: [project],
        checkpoint: {
          id: 'growing-taxonomy',
          load: async () => saved,
          save: async (analysis) => {
            saved = collectionAnalysisSchema.parse(analysis);
            return saved;
          },
        },
      },
    );
    expect(draft.projects[0]?.categories).toHaveLength(14);
    expect(
      validateCollectionDraft(draft, new Set(records.map((item) => item.id))).assignments,
    ).toHaveLength(13);
  });
  it('honors a reduced batch size when retrying a saved provider failure', async () => {
    const records = Array.from({ length: 4 }, (_, index) => ({
      ...record,
      id: `retry-${index}`,
      url: `https://example.com/${index}`,
    }));
    let saved: CollectionAnalysis | undefined;
    let failing = true;
    const seen: string[][] = [];
    stubFetch(
      'fetch',
      vi.fn(async (_url, init) => {
        const body = requestSchema.parse(JSON.parse(String(init?.body)));
        const tabs = JSON.parse(
          body.messages.find((message) => message.role === 'user')?.content || '{}',
        ).tabs as Array<{ id: string }>;
        seen.push(tabs.map((tab) => tab.id));
        if (failing && tabs.some((tab) => tab.id === 'retry-2'))
          return new Response(JSON.stringify({ error: { message: 'Temporary failure' } }), {
            status: 503,
            headers: { 'content-type': 'application/json' },
          });
        return text(
          JSON.stringify({
            assignments: tabs.map((tab) => ({
              recordId: tab.id,
              choice: 'c0',
              reason: 'Reference',
              confidence: 0.9,
            })),
          }),
        );
      }),
    );
    const checkpoint = {
      id: 'resize-retry',
      load: async () => saved,
      save: async (analysis: CollectionAnalysis) => (saved = structuredClone(analysis)),
    };
    await expect(
      generateCollectionDraft(
        { ...app, records, settings: { ...app.settings, aiBatchSize: 2 } },
        {
          seedProjects: [project],
          reuseAcceptedTaxonomyOnly: true,
          checkpoint,
        },
      ),
    ).rejects.toThrow(/6 attempts/);
    expect(saved?.failedBatch?.recordIds).toEqual(['retry-2']);
    failing = false;
    const priorCalls = seen.length;
    await generateCollectionDraft(
      { ...app, records, settings: { ...app.settings, aiBatchSize: 1 } },
      {
        seedProjects: [project],
        reuseAcceptedTaxonomyOnly: true,
        checkpoint,
      },
    );
    expect(seen.slice(priorCalls)).toEqual([['retry-2'], ['retry-3']]);
  });
  it('resumes classification after a late output-limit failure without repeating completed batches', async () => {
    const records = Array.from({ length: 10 }, (_, index) => ({
      ...newRecord(`https://example.com/${index}`),
      id: `occurrence-${index}`,
      title: `Reference ${index}`,
      windowId: 1,
      live: true,
    }));
    let saved: CollectionAnalysis | undefined;
    let failure = true;
    const seen: string[][] = [];
    const checkpoint = {
      id: 'analysis-test',
      load: async () => (saved ? structuredClone(saved) : undefined),
      save: async (analysis: CollectionAnalysis) => {
        saved = structuredClone(analysis);
        return structuredClone(saved);
      },
    };
    stubFetch(
      'fetch',
      vi.fn(async (_url, init) => {
        const body = requestSchema.parse(JSON.parse(String(init?.body)));
        const tabs = JSON.parse(
          body.messages.find((message) => message.role === 'user')?.content || '{}',
        ).tabs as Array<{ id: string }>;
        seen.push(tabs.map((tab) => tab.id));
        if (failure && tabs.some((tab) => Number(tab.id.split('-')[1]) >= 6))
          return reply({
            choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '' } }],
          });
        return text(
          JSON.stringify({
            assignments: tabs.map((tab) => ({
              recordId: tab.id,
              choice: 'c0',
              confidence: 0.9,
              reason: 'Reference title',
            })),
          }),
        );
      }),
    );
    const testApp = { ...app, records, settings: { ...app.settings, aiBatchSize: 2 } };
    const options = { reuseAcceptedTaxonomyOnly: true, seedProjects: [project], checkpoint };
    await expect(generateCollectionDraft(testApp, options)).rejects.toThrow(/output budget/);
    expect(saved?.classifiedIds).toHaveLength(6);
    expect(saved?.failedBatch).toMatchObject({
      stage: 'classification',
      recordIds: ['occurrence-6'],
      attempts: 6,
    });
    expect(seen.filter((ids) => ids.length === 1 && ids[0] === 'occurrence-6')).toHaveLength(6);
    const previousCalls = seen.length;
    failure = false;
    const resumedProgress: string[] = [];
    const draft = await generateCollectionDraft(testApp, {
      ...options,
      onProgress: (message) => resumedProgress.push(message),
    });
    expect(seen.slice(previousCalls).flat()).not.toContain('occurrence-0');
    expect(seen[previousCalls]?.[0]).toBe('occurrence-6');
    expect(
      resumedProgress.find((message) => message.startsWith('Classifying with small chat')),
    ).toContain('7');
    expect(draft.assignments).toHaveLength(10);
    expect(saved?.classifiedIds).toHaveLength(10);
    expect(saved?.failedBatch).toBeUndefined();
  });
  it('explicitly skips a failed category decision, retains completed work, and continues later occurrences', async () => {
    const records = Array.from({ length: 3 }, (_, index) => ({
      ...record,
      id: `skip-${index}`,
      url: `https://example.com/${index}`,
    }));
    let saved: CollectionAnalysis | undefined;
    const seen: string[] = [];
    const checkpoint = {
      id: 'skip-analysis',
      load: async () => saved && structuredClone(saved),
      save: async (value: CollectionAnalysis) => {
        saved = structuredClone(value);
        return structuredClone(value);
      },
    };
    stubFetch(
      'fetch',
      vi.fn(async (_url, init) => {
        const body = requestSchema.parse(JSON.parse(String(init?.body)));
        const tabs = JSON.parse(
          body.messages.find((message) => message.role === 'user')?.content || '{}',
        ).tabs as Array<{ id: string }>;
        seen.push(...tabs.map((tab) => tab.id));
        if (tabs.some((tab) => tab.id === 'skip-1'))
          return reply({
            choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '' } }],
          });
        return text(
          JSON.stringify({
            assignments: tabs.map((tab) => ({
              recordId: tab.id,
              choice: 'c0',
              confidence: 0.9,
              reason: 'Reference evidence',
            })),
          }),
        );
      }),
    );
    const options = { reuseAcceptedTaxonomyOnly: true, seedProjects: [project], checkpoint };
    const input = { ...app, records, settings: { ...app.settings, aiMaxAttempts: 2 } };
    await expect(generateCollectionDraft(input, options)).rejects.toThrow();
    expect(saved?.classifiedIds).toEqual(['skip-0']);
    saved = skipFailedCollectionBatch(saved!);
    const priorCalls = seen.length;
    const draft = await generateCollectionDraft(input, options);
    expect(seen.slice(priorCalls)).toEqual(['skip-2']);
    expect(draft.assignments.map((item) => item.recordId)).toEqual(['skip-0', 'skip-2']);
    expect(draft.unresolvedRecordIds).toEqual(['skip-1']);
    expect(saved?.skippedRecordIds).toEqual(['skip-1']);
    expect(saved?.classifiedIds).toHaveLength(3);
  });
  it('retries a transient classifier batch twice before advancing and checkpoints completion', async () => {
    const records = Array.from({ length: 4 }, (_, index) => ({
      ...newRecord(`https://example.com/${index}`),
      id: `occurrence-${index}`,
      title: `Reference ${index}`,
      windowId: 1,
      live: true,
    }));
    let saved: CollectionAnalysis | undefined;
    let firstBatchAttempts = 0;
    const seen: string[][] = [];
    stubFetch(
      'fetch',
      vi.fn(async (_url, init) => {
        const body = requestSchema.parse(JSON.parse(String(init?.body)));
        const tabs = JSON.parse(
          body.messages.find((message) => message.role === 'user')?.content || '{}',
        ).tabs as Array<{ id: string }>;
        seen.push(tabs.map((tab) => tab.id));
        if (tabs[0]?.id === 'occurrence-0' && ++firstBatchAttempts < 3)
          return reply({
            choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '' } }],
          });
        return text(
          JSON.stringify({
            assignments: tabs.map((tab) => ({
              recordId: tab.id,
              choice: 'c0',
              confidence: 0.9,
              reason: 'Reference title',
            })),
          }),
        );
      }),
    );
    const draft = await generateCollectionDraft(
      { ...app, records, settings: { ...app.settings, aiBatchSize: 2 } },
      {
        reuseAcceptedTaxonomyOnly: true,
        seedProjects: [project],
        checkpoint: {
          id: 'transient-analysis',
          load: async () => saved,
          save: async (analysis) => {
            saved = structuredClone(analysis);
            return structuredClone(analysis);
          },
        },
      },
    );
    expect(firstBatchAttempts).toBe(3);
    expect(seen.slice(0, 3)).toEqual(Array(3).fill(['occurrence-0']));
    expect(draft.assignments).toHaveLength(4);
    expect(saved?.classifiedIds).toHaveLength(4);
    expect(saved?.failedBatch).toBeUndefined();
  });
  it('continues after a tab changes, reclassifying only that occurrence and unfinished batches', async () => {
    const records = Array.from({ length: 4 }, (_, index) => ({
      ...newRecord(`https://example.com/${index}`),
      id: `occurrence-${index}`,
      title: `Reference ${index}`,
      windowId: 1,
      live: true,
    }));
    let currentApp = { ...app, records, settings: { ...app.settings, aiBatchSize: 1 } };
    let saved: CollectionAnalysis | undefined;
    let changed = false;
    const seen: string[] = [];
    stubFetch(
      'fetch',
      vi.fn(async (_url, init) => {
        const body = requestSchema.parse(JSON.parse(String(init?.body)));
        const tabs = JSON.parse(
          body.messages.find((message) => message.role === 'user')?.content || '{}',
        ).tabs as Array<{ id: string }>;
        seen.push(...tabs.map((tab) => tab.id));
        return text(
          JSON.stringify({
            assignments: tabs.map((tab) => ({
              recordId: tab.id,
              choice: 'c0',
              confidence: 0.9,
              reason: 'Reference title',
            })),
          }),
        );
      }),
    );
    const draft = await generateCollectionDraft(currentApp, {
      reuseAcceptedTaxonomyOnly: true,
      seedProjects: [project],
      checkpoint: {
        id: 'navigation-analysis',
        load: async () => (saved ? structuredClone(saved) : undefined),
        save: async (analysis) => {
          if (!changed && analysis.classifiedIds.length === 3) {
            changed = true;
            currentApp = {
              ...currentApp,
              records: currentApp.records.map((record) =>
                record.id === 'occurrence-0'
                  ? { ...record, navigationVersion: record.navigationVersion + 1 }
                  : record,
              ),
            };
            throw new Error(
              'A tab changed during analysis. Saved progress was retained for review.',
            );
          }
          saved = structuredClone(analysis);
          return structuredClone(analysis);
        },
        rebase: async () => {
          const prior = saved!;
          saved = {
            ...prior,
            revision: prior.revision + 1,
            scope: currentApp.records.map(({ id, url, navigationVersion }) => ({
              id,
              url,
              navigationVersion,
            })),
            classifiedIds: prior.classifiedIds.filter((id) => id !== 'occurrence-0'),
            assignments: prior.assignments.filter((item) => item.recordId !== 'occurrence-0'),
          };
          return structuredClone(saved);
        },
        refreshApp: async () => currentApp,
      },
    });
    expect(changed).toBe(true);
    expect(seen).toEqual([
      'occurrence-0',
      'occurrence-1',
      'occurrence-2',
      'occurrence-0',
      'occurrence-2',
      'occurrence-3',
    ]);
    expect(draft.assignments).toHaveLength(4);
    expect(saved?.classifiedIds).toHaveLength(4);
  });
  it.each([false, true])(
    'Resume analysis bypasses the orchestrator and saves a completed checkpoint once (repair=%s)',
    async (repair) => {
      const analysis: CollectionAnalysis = {
        decisionContract: CLASSIFICATION_CONTRACT,
        id: 'request-one',
        sourceAnalysisId: repair ? 'legacy-analysis' : undefined,
        createdAt: 1,
        updatedAt: 2,
        revision: 3,
        purpose: 'proposal',
        instruction: 'Organize my collection',
        reuseAcceptedTaxonomyOnly: false,
        scope: [{ id: record.id, url: record.url, navigationVersion: record.navigationVersion }],
        discoveredIds: [record.id],
        classifiedIds: [record.id],
        projects: [project],
        summaries: ['Reference collection'],
        assignments: [
          {
            recordId: record.id,
            url: record.url,
            navigationVersion: record.navigationVersion,
            projectName: project.name,
            categoryName: 'Sources',
            confidence: 0.9,
            reason: 'Title',
          },
        ],
        unresolvedRecordIds: [],
      };
      const fetch = vi.fn();
      stubFetch('fetch', fetch);
      const persist = vi.fn(async (draft: CollectionDraft) => ({
        ...draft,
        id: 'review-one',
        createdAt: 3,
        status: 'pending' as const,
      }));
      const clear = vi.fn(async () => undefined);
      const original: CollectionProposal = {
        id: 'old-draft',
        createdAt: 1,
        status: 'pending',
        projects: analysis.projects,
        summary: 'Original draft',
        assignments: analysis.assignments,
        unresolvedRecordIds: [],
        scopeRecordIds: [record.id],
      };
      const result = await answerWorkQuestion(
        { ...app, collectionProposals: repair ? [original] : [] },
        'Organize my collection',
        [],
        undefined,
        {
          resume: assistantMessageSchema.parse({
            id: 'failed',
            role: 'assistant',
            content: '',
            createdAt: 1,
            deliveryStatus: 'error',
            collectionAnalysisId: analysis.id,
            collectionProposalId: repair ? original.id : undefined,
          }),
          collectionCheckpoint: {
            id: analysis.id,
            load: async () => analysis,
            save: async (item) => item,
            clear,
          },
          activeCollectionProposalId: repair ? original.id : undefined,
          onCollectionDraft: persist,
        },
      );
      expect(fetch).not.toHaveBeenCalled();
      expect(persist).toHaveBeenCalledOnce();
      expect(persist.mock.calls[0]?.[0].assignments).toHaveLength(1);
      expect(original.assignments).toEqual(analysis.assignments);
      expect(clear).toHaveBeenCalledOnce();
      expect(result.answer).toContain('review-one');
    },
  );
  it('resumes a failed unresolved second pass into its original proposal', async () => {
    const proposal: CollectionProposal = {
      id: 'pending-second-pass',
      createdAt: 1,
      status: 'pending',
      summary: 'References',
      projects: [project],
      assignments: [],
      unresolvedRecordIds: [record.id],
      scopeRecordIds: [record.id],
    };
    const analysis: CollectionAnalysis = {
      decisionContract: CLASSIFICATION_CONTRACT,
      id: 'second-pass-request',
      createdAt: 1,
      updatedAt: 2,
      revision: 2,
      purpose: 'reclassify',
      instruction: 'Try the unresolved tab again',
      reuseAcceptedTaxonomyOnly: true,
      scope: [{ id: record.id, url: record.url, navigationVersion: record.navigationVersion }],
      discoveredIds: [],
      classifiedIds: [record.id],
      projects: [project],
      summaries: [],
      assignments: [
        {
          recordId: record.id,
          url: record.url,
          navigationVersion: record.navigationVersion,
          projectName: project.name,
          categoryName: 'Sources',
          confidence: 0.9,
          reason: 'Title',
        },
      ],
      unresolvedRecordIds: [],
    };
    const fetch = vi.fn();
    stubFetch('fetch', fetch);
    const persist = vi.fn(async (draft: CollectionDraft, id?: string) => ({
      ...proposal,
      ...draft,
      id: id || proposal.id,
    }));
    const result = await answerWorkQuestion(
      { ...app, collectionProposals: [proposal] },
      analysis.instruction,
      [],
      undefined,
      {
        resume: assistantMessageSchema.parse({
          id: 'failed',
          role: 'assistant',
          content: '',
          createdAt: 1,
          deliveryStatus: 'error',
          collectionAnalysisId: analysis.id,
          collectionProposalId: proposal.id,
        }),
        collectionCheckpoint: {
          id: analysis.id,
          load: async () => analysis,
          save: async (item) => item,
          clear: async () => undefined,
        },
        onCollectionDraft: persist,
      },
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(persist.mock.calls[0]?.[1]).toBe(proposal.id);
    expect(persist.mock.calls[0]?.[0].assignments).toHaveLength(1);
    expect(result.answer).toContain('second pass');
  });
  it('rejects a first-page fallback and expands a pending partial proposal to every eligible tab', async () => {
    const second = {
      ...newRecord('https://example.com/second'),
      id: 'occurrence-b',
      title: 'Second',
      windowId: 1,
      live: true,
    };
    const third = {
      ...newRecord('https://example.com/third'),
      id: 'occurrence-c',
      title: 'Third',
      windowId: 1,
      live: true,
    };
    const saved: CollectionProposal = {
      id: 'partial',
      createdAt: 1,
      status: 'pending',
      summary: 'First tab',
      projects: [project],
      assignments: [
        {
          recordId: record.id,
          url: record.url,
          navigationVersion: record.navigationVersion,
          projectName: 'Research',
          categoryName: 'Sources',
          reason: 'Reviewed',
          confidence: 0.9,
        },
      ],
      unresolvedRecordIds: [],
      scopeRecordIds: [record.id],
    };
    let step = 0;
    const persisted = vi.fn(async (draft: CollectionDraft, id?: string) => ({
      ...draft,
      id: id || 'partial',
      createdAt: 1,
      status: 'pending' as const,
    }));
    stubFetch(
      'fetch',
      vi.fn(async (_url, init) => {
        const body = requestSchema.parse(JSON.parse(String(init?.body)));
        if (body.model === 'small') {
          const tabs = JSON.parse(body.messages.at(-1)?.content || '{}').tabs as Array<{
            id: string;
          }>;
          return text(
            JSON.stringify({
              assignments: tabs.map((tab) => ({
                recordId: tab.id,
                choice: 'c0',
                reason: 'Reference',
                confidence: 0.9,
              })),
            }),
          );
        }
        if (body.response_format)
          return text(JSON.stringify({ summary: 'Remaining tabs', projects: [project] }));
        if (step++ === 0)
          return call('prepare_project_from_tabs', {
            instruction: 'Organize all tabs',
            recordIds: [record.id],
          });
        if (step === 2) {
          expect(JSON.parse(body.messages.at(-1)?.content || '{}').error).toMatch(/only 1 of 3/);
          return call('prepare_whole_collection_organization', {
            confirmation: 'prepare_reviewable_proposal',
          });
        }
        expect(JSON.parse(body.messages.at(-1)?.content || '{}')).toMatchObject({
          scopedOccurrences: 3,
          eligibleOccurrences: 3,
          coversCurrentCollection: true,
        });
        return text('Three eligible tabs covered. Review the proposal.');
      }),
    );
    const result = await answerWorkQuestion(
      reactive({ ...app, records: [record, second, third], collectionProposals: [saved] }),
      'Organize all my tabs',
      [],
      undefined,
      { onCollectionDraft: persisted, activeCollectionProposalId: saved.id },
    );
    expect(result.collectionPrepared).toBe(true);
    expect(persisted).toHaveBeenCalledOnce();
    expect(persisted.mock.calls[0]?.[1]).toBe('partial');
    expect(persisted.mock.calls[0]?.[0].scopeRecordIds).toEqual([record.id, second.id, third.id]);
    expect(persisted.mock.calls[0]?.[0].assignments).toHaveLength(3);
  });
  it('ends a failed whole-collection turn instead of paging 30 tabs and claiming success', async () => {
    const stale: CollectionProposal = {
      id: 'stale-partial',
      createdAt: 1,
      status: 'pending',
      summary: 'Old scope',
      projects: [project],
      assignments: [],
      unresolvedRecordIds: ['closed-occurrence'],
      scopeRecordIds: ['closed-occurrence'],
    };
    const fetch = vi.fn(async () =>
      call('prepare_whole_collection_organization', {
        confirmation: 'prepare_reviewable_proposal',
      }),
    );
    stubFetch('fetch', fetch);
    await expect(
      answerWorkQuestion(
        { ...app, collectionProposals: [stale] },
        'Organize my whole collection',
        [],
        undefined,
        { onCollectionDraft: vi.fn(), activeCollectionProposalId: stale.id },
      ),
    ).rejects.toThrow(/no longer eligible/);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it.each([false, true])(
    'reclassifies only unresolved sleeping tabs without replacing assignments (filtered=%s)',
    async (filtered) => {
      const unresolvedMatch = {
        ...newRecord('https://example.com/source'),
        id: 'sleeping-match',
        title: 'Source reference',
        live: true,
        suspended: true,
        foreignSuspended: true,
        windowId: 1,
      };
      const unresolvedKeep = {
        ...newRecord('https://example.com/unknown'),
        id: 'sleeping-unknown',
        title: 'Unknown page',
        live: true,
        suspended: true,
        windowId: 1,
      };
      const existingAssignment: CollectionDraft['assignments'][number] = {
        recordId: record.id,
        url: record.url,
        navigationVersion: record.navigationVersion,
        projectName: 'Research',
        categoryName: 'Sources',
        reason: 'Earlier reviewed assignment',
        confidence: 0.95,
      };
      const saved: CollectionProposal = {
        id: 'pending-review',
        createdAt: 1,
        status: 'pending',
        summary: 'Research references',
        projects: [project],
        assignments: [existingAssignment],
        unresolvedRecordIds: [unresolvedMatch.id, unresolvedKeep.id],
        scopeRecordIds: [record.id, unresolvedMatch.id, unresolvedKeep.id],
        name: 'Saved references',
        unresolvedTagSuggestions: [
          {
            recordId: unresolvedKeep.id,
            url: unresolvedKeep.url,
            navigationVersion: unresolvedKeep.navigationVersion,
            suggestedTags: ['pending'],
          },
        ],
      };
      const currentApp = {
        ...app,
        records: [record, unresolvedMatch, unresolvedKeep],
        collectionProposals: [saved],
      };
      let turn = 0;
      let persisted: CollectionDraft | undefined;
      const fetch = vi.fn(async (_url, init) => {
        const body = requestSchema.parse(JSON.parse(String(init?.body)));
        if (body.model === 'small') {
          const payload = JSON.parse(body.messages.at(-1)?.content || '{}');
          expect(payload.tabs).toHaveLength(1);
          const tab = payload.tabs[0];
          expect([unresolvedMatch.id, unresolvedKeep.id]).toContain(tab.id);
          expect(tab.title).toBe(
            tab.id === unresolvedMatch.id ? unresolvedMatch.title : unresolvedKeep.title,
          );
          return text(
            JSON.stringify({
              assignments: [
                {
                  recordId: tab.id,
                  choice: tab.id === unresolvedMatch.id ? 'c0' : 'keep',
                  confidence: tab.id === unresolvedMatch.id ? 0.9 : 0.2,
                  reason: 'Evidence from this occurrence',
                },
              ],
            }),
          );
        }
        const latest = body.messages.at(-1)?.content || '';
        switch (turn++) {
          case 0:
            return call('read_organization_proposal', { proposalId: saved.id, offset: 0 });
          case 1:
            expect(JSON.parse(latest).unresolvedRecordIds).toEqual(saved.unresolvedRecordIds);
            expect(JSON.parse(latest).unresolvedEvidence).toEqual([
              expect.objectContaining({
                recordId: unresolvedMatch.id,
                title: unresolvedMatch.title,
                suspended: true,
              }),
              expect.objectContaining({
                recordId: unresolvedKeep.id,
                title: unresolvedKeep.title,
                suspended: true,
              }),
            ]);
            return call('reclassify_unresolved_proposal', {
              proposalId: saved.id,
              ...(filtered ? { query: 'source', recordIds: [] } : {}),
            });
          default:
            expect(JSON.parse(latest)).toMatchObject({
              proposalId: saved.id,
              assigned: 1,
              unresolved: 1,
              wokeTabs: 0,
              applied: false,
            });
            return text(
              'One more sleeping tab is now assigned in the saved proposal; one remains uncertain. Review before Apply.',
            );
        }
      });
      stubFetch('fetch', fetch);
      const result = await answerWorkQuestion(
        currentApp,
        'Do a second classification pass on the unresolved tabs',
        [],
        undefined,
        {
          onCollectionDraft: async (draft, id) => {
            expect(id).toBe(saved.id);
            persisted = structuredClone(draft);
            return { ...saved, ...draft };
          },
        },
      );
      expect(result.collectionPrepared).toBe(true);
      expect(persisted?.assignments).toEqual([
        existingAssignment,
        expect.objectContaining({ recordId: unresolvedMatch.id }),
      ]);
      expect(persisted?.unresolvedRecordIds).toEqual([unresolvedKeep.id]);
      expect(currentApp.collectionProposals[0]?.assignments).toEqual([existingAssignment]);
      expect(fetch).toHaveBeenCalledTimes(filtered ? 4 : 5);
      expect(persisted?.name).toBe(saved.name);
      expect(
        persisted?.unresolvedTagSuggestions?.find((item) => item.recordId === unresolvedKeep.id)
          ?.suggestedTags,
      ).toEqual(['pending']);
    },
  );
  it('resumes a saved collection proposal without running classification or saving a second proposal', async () => {
    const saved: CollectionProposal = {
      id: 'saved-review',
      createdAt: 1,
      status: 'pending',
      summary: 'Review first',
      projects: [project],
      assignments: [],
      unresolvedRecordIds: [record.id],
    };
    const failed = assistantMessageSchema.parse({
      id: 'failed',
      role: 'assistant',
      content: '',
      createdAt: 1,
      deliveryStatus: 'error',
      collectionProposalId: saved.id,
    });
    let turn = 0;
    const fetch = vi.fn(async (_url, init) => {
      const body = requestSchema.parse(JSON.parse(String(init?.body)));
      expect(body.model).toBe('large');
      if (turn++ === 0)
        return call('prepare_whole_collection_organization', {
          confirmation: 'prepare_reviewable_proposal',
        });
      expect(JSON.parse(body.messages.at(-1)?.content || '{}')).toMatchObject({
        reused: true,
        proposalId: saved.id,
        awaitingOwnerReview: true,
      });
      return text('The saved proposal is ready for review.');
    });
    stubFetch('fetch', fetch);
    const onCollectionDraft = vi.fn();
    const result = await answerWorkQuestion(
      { ...app, collectionProposals: [saved] },
      'Organize my collection',
      [],
      undefined,
      { resume: failed, onCollectionDraft },
    );
    expect(result.collectionPrepared).toBe(true);
    expect(result.answer).toContain('saved proposal');
    expect(onCollectionDraft).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('keeps a saved task draft on retry and blocks a previously completed task', async () => {
    const draft = {
      title: 'Review references',
      notes: '',
      areaId: null,
      projectId: null,
      priority: 'normal' as const,
    };
    const failed = assistantMessageSchema.parse({
      id: 'failed',
      role: 'assistant',
      content: '',
      createdAt: 1,
      deliveryStatus: 'error',
      taskDraft: draft,
    });
    let turn = 0;
    stubFetch(
      'fetch',
      vi.fn(async (_url, init) => {
        const body = requestSchema.parse(JSON.parse(String(init?.body)));
        if (turn++ % 2 === 0)
          return call('prepare_work_item', {
            title: 'Another task',
            notes: '',
            areaName: null,
            projectName: null,
            priority: 'normal',
          });
        const outcome = JSON.parse(body.messages.at(-1)?.content || '{}');
        expect(outcome).toMatchObject(
          turn === 2
            ? { draft, reused: true, awaitingOwnerReview: true }
            : { completedPreviously: true },
        );
        return text('Previous task state explained.');
      }),
    );
    const pending = await answerWorkQuestion(app, 'Capture work', [], undefined, {
      resume: failed,
    });
    expect(pending.proposal).toEqual(draft);
    const completed = await answerWorkQuestion(app, 'Capture work', [], undefined, {
      resume: { ...failed, completedArtifacts: ['task'] },
    });
    expect(completed.proposal).toBeUndefined();
    expect(app.workItems).toEqual([]);
  });
  it('resumes after an empty final answer with a checkpointed draft and fresh tab evidence', async () => {
    const draft = {
      title: 'Review reference',
      notes: '',
      areaId: null,
      projectId: null,
      priority: 'normal' as const,
    };
    const failed = assistantMessageSchema.parse({
      id: 'interrupted-at-final',
      role: 'assistant',
      content: '',
      createdAt: 1,
      deliveryStatus: 'error',
    });
    let phase: 'initial' | 'retry' = 'initial';
    let step = 0;
    const requests = vi.fn(async (_url, init) => {
      const body = requestSchema.parse(JSON.parse(String(init?.body)));
      const last = body.messages.at(-1)?.content || '';
      if (phase === 'initial') {
        if (step++ === 0)
          return call('list_tabs', { query: '', projectId: null, windowId: null, offset: 0 });
        if (step === 2)
          return call('prepare_work_item', {
            title: draft.title,
            notes: '',
            areaName: null,
            projectName: null,
            priority: 'normal',
          });
        return text('');
      }
      if (step++ === 0) return call('read_tab_evidence', { recordId: record.id, offset: null });
      if (step === 2) {
        expect(JSON.parse(last).evidence).toBe('Fresh cached reference after failure');
        return call('prepare_work_item', {
          title: 'Duplicate attempt',
          notes: '',
          areaName: null,
          projectName: null,
          priority: 'normal',
        });
      }
      expect(JSON.parse(last)).toMatchObject({ draft, reused: true, awaitingOwnerReview: true });
      return text('The saved draft remains ready for review, using refreshed evidence.');
    });
    stubFetch('fetch', requests);
    await expect(
      answerWorkQuestion(app, 'Read reference and capture work', [], undefined, {
        onCheckpoint: async (state) => {
          Object.assign(failed, state);
        },
      }),
    ).rejects.toThrow(/without a visible answer/);
    expect(failed.taskDraft).toEqual(draft);
    expect(failed.sources.some((source) => source.recordId === record.id)).toBe(true);
    phase = 'retry';
    step = 0;
    const updated = {
      ...record,
      content: {
        title: record.title,
        url: record.url,
        description: '',
        headings: [],
        text: 'Fresh cached reference after failure',
        capturedAt: 2,
        scroll: 0,
        dirty: false,
        playing: false,
      },
    };
    const result = await answerWorkQuestion(
      { ...app, records: [updated] },
      'Read reference and capture work',
      [],
      undefined,
      { resume: failed },
    );
    expect(result.proposal).toEqual(draft);
    expect(result.answer).toContain('refreshed evidence');
    expect(requests).toHaveBeenCalledTimes(6);
    expect(app.workItems).toEqual([]);
  });
  it('reports an empty provider reply without fabricating an answer or retrying inference', async () => {
    const fetch = vi.fn(async () => text(''));
    stubFetch('fetch', fetch);
    await expect(answerWorkQuestion(app, 'Read my workspace')).rejects.toThrow(
      /provider.*without a visible answer/,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(app.records).toEqual([record]);
  });
  it('distinguishes a project ID from a protected tab and supports grounded argument correction', async () => {
    let turn = 0;
    stubFetch(
      'fetch',
      vi.fn(async (_url, init) => {
        const body = requestSchema.parse(JSON.parse(String(init?.body)));
        if (body.model === 'small')
          return text(
            JSON.stringify({ choice: 'g0', confidence: 0.95, reason: 'Reference evidence' }),
          );
        if (turn++ === 0)
          return call('prepare_tab_actions', {
            instruction: 'Group reference',
            recordIds: ['project-not-tab'],
          });
        if (turn === 2) {
          const error = JSON.parse(body.messages.at(-1)?.content || '{}');
          expect(error.error).toContain('Unknown or closed tab occurrence');
          expect(error.error).not.toContain('protected');
          return call('list_tabs', { query: '', projectId: null, windowId: null, offset: 0 });
        }
        if (turn === 3)
          return call('prepare_group_classification', {
            instruction: 'Group reference',
            recordIds: [record.id],
          });
        return text('Prepared a grouping draft; review it before Apply.');
      }),
    );
    const result = await answerWorkQuestion(
      {
        ...app,
        groups: [
          {
            id: 1,
            windowId: 1,
            title: 'References',
            color: 'grey',
            collapsed: false,
            shared: false,
          },
        ],
      },
      'Group my reference',
    );
    expect(result.plan?.actions[0]).toMatchObject({
      recordIds: [record.id],
      type: 'group',
      name: 'References',
    });
    expect(record.groupId).toBe(-1);
  });
  it('pages cached evidence without repeating the excerpt or losing the saved original', async () => {
    const cached = {
      ...record,
      content: {
        title: 'Reference',
        url: record.url,
        description: '',
        headings: [],
        text: 'x'.repeat(4000) + 'last page',
        capturedAt: 1,
        scroll: 0,
        dirty: false,
        playing: false,
      },
    };
    let turn = 0;
    stubFetch(
      'fetch',
      vi.fn(async (_url, init) => {
        const body = requestSchema.parse(JSON.parse(String(init?.body)));
        if (turn++ === 0) return call('read_tab_evidence', { recordId: record.id, offset: null });
        const evidence = JSON.parse(body.messages.at(-1)?.content || '{}');
        if (turn === 2) {
          expect(evidence).toMatchObject({
            evidence: 'x'.repeat(4000),
            nextOffset: 4000,
            characterCount: 4009,
            tab: { content: null },
          });
          expect(evidence.tab).toMatchObject({ cacheAvailable: true, cacheCharacterCount: 4009 });
          return call('read_tab_evidence', { recordId: record.id, offset: 4000 });
        }
        expect(evidence).toMatchObject({ evidence: 'last page', nextOffset: null });
        return text('Read both pages.');
      }),
    );
    await answerWorkQuestion({ ...app, records: [cached] }, 'Read all cached evidence');
    expect(cached.content.text.length).toBe(4009);
  });
  it('reads and refines a newly persisted proposal in the same SDK turn without applying it', async () => {
    let turn = 0;
    const drafts: CollectionDraft[] = [];
    const savedIds: Array<string | undefined> = [];
    stubFetch(
      'fetch',
      vi.fn(async (_url, init) => {
        const body = requestSchema.parse(JSON.parse(String(init?.body)));
        if (body.model === 'small')
          return text(
            JSON.stringify({
              assignments: [
                { recordId: record.id, choice: 'c0', confidence: 0.9, reason: 'Reference address' },
              ],
            }),
          );
        if (body.response_format)
          return text(
            JSON.stringify({
              summary: 'Reference collection',
              projects: [project],
              assignments: [
                {
                  recordId: record.id,
                  projectName: project.name,
                  categoryName: 'Sources',
                  confidence: 0.9,
                  reason: 'Reference',
                },
              ],
              unresolvedRecordIds: [],
            }),
          );
        const latest = body.messages.at(-1)?.content || '';
        switch (turn++) {
          case 0:
            return call('prepare_whole_collection_organization', {
              confirmation: 'prepare_reviewable_proposal',
            });
          case 1:
            expect(JSON.parse(latest)).toMatchObject({ proposalId: 'saved', applied: false });
            return call('read_organization_proposal', { proposalId: 'saved', offset: 0 });
          case 2:
            expect(JSON.parse(latest).projects[0].name).toBe('Research');
            return call('refine_organization_proposal', {
              proposalId: 'saved',
              projectEdits: [
                {
                  previousName: 'Research',
                  name: 'Personal references',
                  purpose: 'Owner requested collection',
                  areaName: 'Personal',
                },
              ],
              categoryEdits: [],
              assignments: [],
            });
          case 3:
            return call('read_organization_proposal', { proposalId: 'saved', offset: 0 });
          default:
            expect(JSON.parse(latest).projects[0].name).toBe('Personal references');
            return text('The saved proposal is ready for your review. No changes were applied.');
        }
      }),
    );
    const result = await answerWorkQuestion(
      app,
      'Organize my collection as personal references',
      [],
      undefined,
      {
        onCollectionDraft: async (draft, id) => {
          drafts.push(structuredClone(draft));
          savedIds.push(id);
          return {
            ...draft,
            id: 'saved',
            createdAt: 1,
            status: 'pending',
          } satisfies CollectionProposal;
        },
      },
    );
    expect(result.collectionPrepared).toBe(true);
    expect(drafts).toHaveLength(2);
    expect(savedIds).toEqual([undefined, 'saved']);
    expect(drafts[1]?.assignments[0]?.projectName).toBe('Personal references');
    expect(app.collectionProposals).toEqual([]);
    expect(app.memberships).toEqual([]);
  });

  it('creates a separate proposal from a new chat despite another pending draft', async () => {
    const older: CollectionProposal = {
      id: 'older-chat',
      createdAt: 1,
      status: 'pending',
      summary: 'Older draft',
      projects: [project],
      assignments: [],
      unresolvedRecordIds: [record.id],
      scopeRecordIds: [record.id],
    };
    const persist = vi.fn(async (draft: CollectionDraft, id?: string) => ({
      ...draft,
      id: id || 'new-chat',
      createdAt: 2,
      status: 'pending' as const,
    }));
    let step = 0;
    stubFetch(
      'fetch',
      vi.fn(async (_url, init) => {
        const body = requestSchema.parse(JSON.parse(String(init?.body)));
        if (body.model === 'small')
          return text(
            JSON.stringify({
              assignments: [
                { recordId: record.id, choice: 'c0', confidence: 0.9, reason: 'Title' },
              ],
            }),
          );
        if (body.response_format)
          return text(JSON.stringify({ summary: 'New draft', projects: [project] }));
        if (step++ === 0)
          return call('prepare_whole_collection_organization', {
            confirmation: 'prepare_reviewable_proposal',
          });
        if (step === 2) {
          expect(JSON.parse(body.messages.at(-1)?.content || '{}')).toMatchObject({
            proposalId: 'new-chat',
            prepared: true,
          });
          return call('prepare_whole_collection_organization', {
            confirmation: 'prepare_reviewable_proposal',
          });
        }
        expect(JSON.parse(body.messages.at(-1)?.content || '{}')).toMatchObject({
          proposalId: 'new-chat',
          reused: true,
        });
        return text('The new proposal awaits review.');
      }),
    );
    await answerWorkQuestion(
      { ...app, collectionProposals: [older] },
      'Organize my collection',
      [],
      undefined,
      {
        onCollectionDraft: persist,
      },
    );
    expect(persist).toHaveBeenCalledOnce();
    expect(persist.mock.calls[0]?.[1]).toBeUndefined();
  });

  it('pages a large saved proposal without returning the entire taxonomy', async () => {
    const many: CollectionProposal = {
      id: 'large',
      createdAt: 1,
      status: 'pending',
      summary: 'Many projects',
      projects: Array.from({ length: 50 }, (_, index) => ({
        ...project,
        name: `Project ${index}`,
        categories: [{ name: 'Sources', description: 'A'.repeat(300) }],
      })),
      assignments: [],
      unresolvedRecordIds: [record.id],
      scopeRecordIds: [record.id],
    };
    let step = 0;
    stubFetch(
      'fetch',
      vi.fn(async (_url, init) => {
        const body = requestSchema.parse(JSON.parse(String(init?.body)));
        const latest = body.messages.at(-1)?.content || '';
        if (step++ === 0)
          return call('read_organization_proposal', { proposalId: 'large', offset: 0 });
        const page = JSON.parse(latest);
        expect(page.projectCount).toBe(50);
        expect(page.projects).toHaveLength(12);
        expect(page.nextProjectOffset).toBe(12);
        expect(latest).not.toContain('A'.repeat(300));
        return text('Read a bounded proposal page.');
      }),
    );
    await answerWorkQuestion(
      { ...app, collectionProposals: [many] },
      'Read my proposal',
      [],
      undefined,
      {
        activeCollectionProposalId: many.id,
      },
    );
  });

  it('returns an invalid target as tool data so the orchestrator can explain and continue', async () => {
    let turn = 0;
    stubFetch(
      'fetch',
      vi.fn(async (_url, init) => {
        const body = requestSchema.parse(JSON.parse(String(init?.body)));
        if (turn++ === 0)
          return call('read_tab_evidence', { recordId: 'not-an-occurrence', offset: null });
        expect(JSON.parse(body.messages.at(-1)?.content || '{}')).toMatchObject({
          ok: false,
          tool: 'read_tab_evidence',
          applied: false,
          automaticRetry: false,
        });
        expect(JSON.parse(body.messages.at(-1)?.content || '{}').error).toContain(
          'suspended tabs can have readable cache',
        );
        return text('I cannot find that project. Which existing project do you mean?');
      }),
    );
    expect((await answerWorkQuestion(app, 'Read that project')).answer).toContain('cannot find');
  });

  it('lets the large orchestrator explicitly delegate existing-group decisions to the small LLM', async () => {
    let turn = 0;
    const group = {
      id: 10,
      windowId: 1,
      title: 'References',
      color: 'grey' as const,
      collapsed: false,
      shared: false,
    };
    stubFetch(
      'fetch',
      vi.fn(async (_url, init) => {
        const body = requestSchema.parse(JSON.parse(String(init?.body)));
        if (body.model === 'small')
          return text(
            JSON.stringify({
              choice: 'g0',
              confidence: 0.9,
              reason: 'Matches existing references',
            }),
          );
        if (turn++ === 0)
          return call('prepare_group_classification', {
            instruction: 'Reuse my existing references group',
            recordIds: [record.id],
          });
        expect(JSON.parse(body.messages.at(-1)?.content || '{}')).toMatchObject({
          model: 'small',
          applied: false,
        });
        return text('Review the suggested existing group before applying.');
      }),
    );
    const result = await answerWorkQuestion(
      { ...app, groups: [group] },
      'Reuse my existing references group',
    );
    expect(result.plan?.provenance?.model).toBe('small');
    expect(result.plan?.actions[0]?.name).toBe('References');
  });

  it('binds every System One question to its exact duplicate occurrence and rejects unknown choices', async () => {
    const second = { ...record, id: 'occurrence-b', title: 'Uncertain duplicate occurrence' };
    let invalid = false;
    stubFetch(
      'fetch',
      vi.fn(async (_url, init) => {
        const body = z
          .object({
            state: z.string(),
            questions: z.record(z.string(), z.object({ instructions: z.string() }).passthrough()),
          })
          .parse(JSON.parse(String(init?.body)));
        expect(Object.keys(body.questions)).toEqual(['tab_0']);
        const question = body.questions.tab_0!.instructions;
        expect(question).toContain('Personal references');
        expect(question).toContain(record.url);
        const uncertain = question.includes(second.title);
        expect(question).not.toContain(
          uncertain ? `Title: ${record.title}\n` : `Title: ${second.title}\n`,
        );
        return reply({
          model: 'system-one',
          answers: {
            tab_0: {
              type: 'choice',
              choice: invalid ? 'invented' : uncertain ? 'keep' : 'c0',
              confidence: 0.92,
              probabilities: { c0: 0.92, keep: 0.08 },
            },
          },
          usage: { input_tokens: 50, output_tokens: 0 },
        });
      }),
    );
    const decisionApp = {
      ...app,
      records: [record, second],
      projects: [{ id: 'p', ...project, updatedAt: 1, revision: 1, maintainReviewQueue: false }],
      categories: [
        {
          id: 'c',
          projectId: 'p',
          name: 'Sources',
          description: '',
          order: 0,
          updatedAt: 1,
          revision: 1,
        },
      ],
      settings: { ...app.settings, useDedicatedDecisionModel: true, decisionModel: 'system-one' },
    };
    const draft = await generateCollectionDraft(decisionApp, {
      reuseAcceptedTaxonomyOnly: true,
      instruction: 'Personal references only',
    });
    expect(draft.assignments.map((entry) => entry.recordId)).toEqual([record.id]);
    expect(draft.unresolvedRecordIds).toEqual([second.id]);
    invalid = true;
    await expect(
      generateCollectionDraft(decisionApp, {
        reuseAcceptedTaxonomyOnly: true,
        instruction: 'Personal references only',
      }),
    ).rejects.toThrow(/invalid choice/);
  });

  it('keeps low-confidence existing-group suggestions unchanged and includes groups beyond the old eighteen-group limit', async () => {
    const groups = Array.from({ length: 25 }, (_, index) => ({
      id: index + 10,
      windowId: 1,
      title: `Group ${index}`,
      color: 'grey' as const,
      collapsed: false,
      shared: false,
    }));
    let confidence = 0.2;
    stubFetch(
      'fetch',
      vi.fn(async (_url, init) => {
        expect(String(init?.body)).toContain('Group 24');
        return text(JSON.stringify({ choice: 'g24', confidence, reason: 'Matching group' }));
      }),
    );
    expect(
      (await generatePlan({ ...app, groups }, [record], 'Reuse groups', { useDecisionModel: true }))
        .actions,
    ).toEqual([]);
    confidence = 0.9;
    expect(
      (await generatePlan({ ...app, groups }, [record], 'Reuse groups', { useDecisionModel: true }))
        .actions[0]?.name,
    ).toBe('Group 24');
  });
});

describe('model role permission preflight', () => {
  it('preserves ambiguously named native groups instead of selecting the first matching group', async () => {
    const fetch = vi.fn();
    stubFetch('fetch', fetch);
    const group = {
      id: 10,
      windowId: 1,
      title: 'References',
      color: 'grey' as const,
      collapsed: false,
      shared: false,
    };
    const plan = await generatePlan(
      { ...app, groups: [group, { ...group, id: 11 }] },
      [record],
      'Reuse existing groups',
      { useDecisionModel: true },
    );
    expect(plan.actions).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('permits chat with only a generative model and requests each distinct origin once', async () => {
    const request = vi.fn(async () => true);
    vi.stubGlobal('chrome', { permissions: { contains: async () => false, request } });
    await requestModelAccess({ ...app.settings, smallModel: '' }, ['generative']);
    expect(request.mock.calls).toHaveLength(1);
    request.mockClear();
    await requestModelAccess(app.settings, ['generative', 'decision']);
    expect(request).toHaveBeenCalledWith({ origins: ['http://127.0.0.1:1234/*'] });
  });
  it('fails before model work when a role is unconfigured or access is denied', async () => {
    const request = vi.fn(async () => false);
    vi.stubGlobal('chrome', { permissions: { contains: async () => false, request } });
    await expect(
      requestModelAccess({ ...app.settings, smallModel: '' }, ['generative', 'decision']),
    ).rejects.toThrow(/small chat/);
    expect(request).not.toHaveBeenCalled();
    await expect(requestModelAccess(app.settings, ['generative'])).rejects.toThrow(/declined/);
  });
});
