import { afterEach, describe, expect, it, vi } from 'vitest';
import { tagSavedProposal, type ProposalTagCheckpoint } from '../src/ai/proposal-tagging';
import { DEFAULTS, newRecord, validateCollectionDraft } from '../src/shared/model';
import type { AppState, CollectionAnalysis, CollectionProposal } from '../src/shared/types';
import type { TagAnalysis } from '../src/shared/tag-analysis';

function fixture(count = 335, assigned = 283) {
  const records = Array.from({ length: count }, (_, index) => ({
    ...newRecord('https://example.test/reading', `tab-${index}`),
    id: `tab-${index}`,
    title: 'Reading guide',
    live: true,
    suspended: true,
    tags: ['owner-label'],
  }));
  const proposal: CollectionProposal = {
    id: 'reading-draft',
    status: 'pending',
    createdAt: 1,
    summary: 'Preserve organization',
    name: 'Reading collection',
    projects: [
      {
        name: 'Library',
        purpose: 'Reading',
        areaName: 'Learning',
        categories: [{ name: 'Sources', description: 'Reading guides' }],
      },
    ],
    scopeRecordIds: records.map((record) => record.id),
    ownerAssignedRecordIds: [records[0]!.id],
    assignments: records.slice(0, assigned).map((record) => ({
      recordId: record.id,
      url: record.url,
      navigationVersion: record.navigationVersion,
      projectName: 'Library',
      categoryName: 'Sources',
      reason: 'Saved evidence',
      confidence: 0.9,
      suggestedTags: ['saved-label'],
    })),
    unresolvedRecordIds: records.slice(assigned).map((record) => record.id),
  };
  const app: AppState = {
    records,
    collectionProposals: [proposal],
    windows: [],
    groups: [],
    projects: [],
    categories: [],
    areas: [],
    memberships: [],
    workItems: [],
    proposals: [],
    organizationJobs: [],
    snapshots: [],
    operations: [],
    jobs: [],
    version: 'test',
    settings: {
      ...DEFAULTS,
      smallModel: 'synthetic-tags',
      smallContextTokens: 32768,
      smallCompletionTokens: 2048,
      tagVerification: 'none',
    },
  };
  let analysis: CollectionAnalysis | undefined;
  const rows = new Map<string, TagAnalysis>();
  const checkpoint: ProposalTagCheckpoint = {
    id: 'tag-run',
    load: async () => structuredClone(analysis),
    save: async (value) => {
      analysis = structuredClone(value);
      return structuredClone(value);
    },
    tags: {
      analysisId: 'tag-run',
      load: async () => structuredClone([...rows.values()]),
      save: async (row) => {
        rows.set(row.id, structuredClone(row));
      },
    },
  };
  return { app, proposal, rows, checkpoint };
}
const reply = () =>
  new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({
              tags: [],
              newTags: [{ name: 'Reading', source: 'title', quote: 'Reading' }],
              uncertain: false,
            }),
          },
          finish_reason: 'stop',
        },
      ],
    }),
    { headers: { 'content-type': 'application/json' } },
  );
afterEach(() => vi.unstubAllGlobals());
describe('saved proposal bulk tagging', () => {
  it('clears resolved review markers and counts the final saved review state', async () => {
    const { app, proposal, checkpoint } = fixture(1, 1);
    proposal.tagReview = [
      {
        recordId: 'tab-0',
        tags: [
          { name: 'Reading', outcome: 'uncertain' },
          { name: 'unrelated', outcome: 'uncertain' },
        ],
      },
    ];
    vi.stubGlobal('fetch', reply);
    const result = await tagSavedProposal(app, proposal, { checkpoint });
    expect(result.patches[0]?.review).toEqual([{ name: 'unrelated', outcome: 'uncertain' }]);
    expect(result.needsReview).toBe(1);
    expect(result.patches[0]?.suggestedTags).toEqual(['saved-label', 'Reading']);
  });
  it('processes all 335 assigned and uncertain tabs without category inference, Apply, or source mutations', async () => {
    const { app, proposal, checkpoint, rows } = fixture();
    const before = structuredClone({ proposal, records: app.records });
    const provider = vi.fn(async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      expect(request.model).toBe('synthetic-tags');
      expect(request.response_format.json_schema.name).toBe('tabflow_tag_proposal');
      return reply();
    });
    vi.stubGlobal('fetch', provider);
    const result = await tagSavedProposal(app, proposal, { checkpoint });
    expect(result).toMatchObject({ processed: 335, tagged: 335, skipped: 0 });
    expect(result.draft.projects).toEqual(proposal.projects);
    expect(result.draft.assignments).toHaveLength(283);
    expect(result.draft.unresolvedRecordIds).toEqual(proposal.unresolvedRecordIds);
    expect(result.draft.unresolvedTagSuggestions).toHaveLength(52);
    expect(
      result.draft.assignments.every(
        (item) => item.suggestedTags?.join(',') === 'saved-label,Reading',
      ),
    ).toBe(true);
    expect(
      result.draft.unresolvedTagSuggestions?.every(
        (item) => item.suggestedTags.join(',') === 'Reading',
      ),
    ).toBe(true);
    expect(result.draft.ownerAssignedRecordIds).toEqual(proposal.ownerAssignedRecordIds);
    validateCollectionDraft(result.draft, new Set(app.records.map((record) => record.id)));
    expect(provider).toHaveBeenCalledTimes(335);
    expect(rows.size).toBe(335);
    await tagSavedProposal(app, proposal, { checkpoint });
    expect(provider).toHaveBeenCalledTimes(335);
    expect({ proposal, records: app.records }).toEqual(before);
  });
  it('resumes after Stop from completed per-tab results and rejects a changed target revision', async () => {
    const { app, proposal, checkpoint, rows } = fixture(3, 1);
    const stop = new AbortController();
    const save = checkpoint.tags!.save;
    checkpoint.tags!.save = async (row) => {
      await save(row);
      if (row.status === 'complete') stop.abort();
    };
    const provider = vi.fn(async () => reply());
    vi.stubGlobal('fetch', provider);
    await expect(
      tagSavedProposal(app, proposal, { checkpoint, signal: stop.signal }),
    ).rejects.toThrow();
    expect([...rows.values()].filter((row) => row.status === 'complete')).toHaveLength(1);
    checkpoint.tags!.save = save;
    const result = await tagSavedProposal(app, proposal, { checkpoint });
    expect(result.processed).toBe(3);
    expect(provider).toHaveBeenCalledTimes(3);
    await expect(
      tagSavedProposal(app, { ...proposal, summary: 'Edited elsewhere' }, { checkpoint }),
    ).rejects.toThrow('different draft revision');
    expect(provider).toHaveBeenCalledTimes(3);
  });
});
