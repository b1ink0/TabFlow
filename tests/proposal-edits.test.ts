import { describe, it, expect } from 'vitest';
import {
  editableProposal,
  setDraftExclusions,
  activeProposalScopeIds,
  mergeProposalDrafts,
  mergeDraftCategories,
  removeDraftStructure,
} from '../src/shared/organization/proposal-edits';
import { validateCollectionDraft, newRecord } from '../src/shared/model';
import type { CollectionProposal } from '../src/shared/types';
import { reactive } from 'vue';
import { resolveTagReview } from '../src/shared/organization/tag-analysis';
import { proposalExport, proposalImport } from '../src/shared/organization/proposal-review';

const records = Array.from({ length: 335 }, (_, i) => ({
  ...newRecord('https://example.test/duplicate', `occ-${i}`),
  live: true,
}));
function proposal(): CollectionProposal {
  return {
    id: 'target',
    name: 'Main collection',
    createdAt: 1,
    status: 'pending',
    summary: 'Preserve this summary',
    decisionContract: 'isolated-evidence-v2',
    scopeRecordIds: records.map((r) => r.id),
    projects: [
      {
        name: 'Library',
        purpose: 'Reading',
        areaName: 'Learning',
        categories: [
          { name: 'Sources', description: 'Reading material' },
          { name: 'Notes', description: 'My notes' },
        ],
      },
    ],
    assignments: records.slice(0, 254).map((r) => ({
      recordId: r.id,
      url: r.url,
      navigationVersion: r.navigationVersion,
      projectName: 'Library',
      categoryName: 'Sources',
      reason: 'Existing reason',
      confidence: 0.9,
      suggestedTags: ['reading'],
    })),
    unresolvedRecordIds: records.slice(254).map((r) => r.id),
    unresolvedTagSuggestions: records.slice(254).map((r) => ({
      recordId: r.id,
      url: r.url,
      navigationVersion: r.navigationVersion,
      suggestedTags: ['reference'],
    })),
    tagReview: [
      { recordId: records[300]!.id, tags: [{ name: 'reference', outcome: 'uncertain' }] },
    ],
    ownerAssignedRecordIds: [records[0]!.id],
  };
}
describe('lossless proposal edits', () => {
  it('removes assigned and uncertain tabs reversibly, retaining choices through export/import', () => {
    const source = proposal();
    const draft = editableProposal(source);
    const assigned = records[0]!.id;
    const uncertain = records[300]!.id;
    setDraftExclusions(draft, [assigned, uncertain], true);
    expect(activeProposalScopeIds(draft)).toHaveLength(333);
    expect(draft.assignments[0]).toEqual(source.assignments[0]);
    expect(draft.unresolvedTagSuggestions).toEqual(source.unresolvedTagSuggestions);
    validateCollectionDraft(draft, new Set(records.map((row) => row.id)));
    const imported = proposalImport(proposalExport(source, draft, records), records, []).draft;
    expect(imported.excludedRecordIds).toEqual([assigned, uncertain]);
    setDraftExclusions(draft, [assigned, uncertain], false);
    expect(activeProposalScopeIds(draft)).toHaveLength(335);
    expect(draft.assignments).toEqual(source.assignments);
    expect(source.excludedRecordIds).toBeUndefined();
    expect(() => setDraftExclusions(draft, ['unknown'], true)).toThrow('scope');
  });
  it.each([false, true])(
    'retains more than six merged tags and eight review labels, independent=%s',
    (independent) => {
      const target = proposal();
      const source = proposal();
      source.id = 'extra-tags';
      const record = records[independent ? 300 : 0]!;
      const left = Array.from({ length: 12 }, (_, i) => `reading-${i}`);
      const right = Array.from({ length: 12 }, (_, i) => `reference-${i}`);
      if (independent) {
        target.unresolvedTagSuggestions!.find(
          (item) => item.recordId === record.id,
        )!.suggestedTags = left;
        source.assignments = [];
        source.unresolvedRecordIds = [record.id];
        source.unresolvedTagSuggestions = [
          {
            recordId: record.id,
            url: record.url,
            navigationVersion: record.navigationVersion,
            suggestedTags: [...right, left[0]!.toUpperCase()],
          },
        ];
      } else {
        target.assignments[0]!.suggestedTags = left;
        source.assignments = [
          { ...target.assignments[0]!, suggestedTags: [...right, left[0]!.toUpperCase()] },
        ];
        source.unresolvedRecordIds = [];
        source.unresolvedTagSuggestions = [];
      }
      source.scopeRecordIds = [record.id];
      source.ownerAssignedRecordIds = [];
      target.tagReview = [
        { recordId: record.id, tags: left.map((name) => ({ name, outcome: 'uncertain' })) },
      ];
      source.tagReview = [
        { recordId: record.id, tags: right.map((name) => ({ name, outcome: 'new' })) },
      ];
      const before = structuredClone({ target, source });
      const merged = mergeProposalDrafts(target, source, [], 'keep_target');
      const draft = validateCollectionDraft(merged.draft, new Set(records.map((r) => r.id)));
      const tags = (independent ? draft.unresolvedTagSuggestions : draft.assignments)?.find(
        (item) => item.recordId === record.id,
      )?.suggestedTags;
      expect(tags).toHaveLength(24);
      expect(new Set(tags?.map((tag) => tag.toLowerCase()))).toEqual(new Set([...left, ...right]));
      expect(draft.tagReview?.[0]?.tags).toHaveLength(24);
      const imported = proposalImport(proposalExport(target, draft, records), records, []).draft;
      expect(imported.tagReview).toEqual(draft.tagReview);
      expect(independent ? imported.unresolvedTagSuggestions : imported.assignments).toEqual(
        independent ? draft.unresolvedTagSuggestions : draft.assignments,
      );
      resolveTagReview(draft, record, right[0]!, true);
      expect(draft.tagReview?.[0]?.tags).toHaveLength(23);
      resolveTagReview(draft, record, right[0]!.toUpperCase(), false);
      const remaining = (independent ? draft.unresolvedTagSuggestions : draft.assignments)?.find(
        (item) => item.recordId === record.id,
      )?.suggestedTags;
      expect(remaining).toHaveLength(23);
      expect(remaining?.map((tag) => tag.toLowerCase())).not.toContain(right[0]);
      validateCollectionDraft(draft, new Set(records.map((r) => r.id)));
      expect({ target, source }).toEqual(before);
    },
  );
  it('copies reactive store drafts without modifying proxies or losing nested metadata', () => {
    const live = reactive(proposal());
    const draft = editableProposal(live);
    draft.projects[0]!.purpose = 'Changed only in draft';
    draft.assignments[0]!.suggestedTags!.push('draft-only');
    expect(live.projects[0]?.purpose).toBe('Reading');
    expect(live.assignments[0]?.suggestedTags).toEqual(['reading']);
    expect(draft.tagReview).toEqual(live.tagReview);
  });
  it('merges three uncertain duplicate occurrences into a 335-tab target without replacing its 254 assignments or source', () => {
    const target = proposal();
    const source: CollectionProposal = {
      ...proposal(),
      id: 'source',
      status: 'undone',
      name: 'Video notes',
      projects: [
        {
          name: 'Video study',
          purpose: 'Watch course material',
          areaName: 'Learning',
          categories: [{ name: 'Lessons', description: 'Course videos' }],
        },
      ],
      assignments: records.slice(254, 257).map((r) => ({
        recordId: r.id,
        url: r.url,
        navigationVersion: r.navigationVersion,
        projectName: 'Video study',
        categoryName: 'Lessons',
        reason: 'Video evidence',
        confidence: 0.85,
        suggestedTags: ['video'],
      })),
      scopeRecordIds: records.slice(254, 257).map((r) => r.id),
      unresolvedRecordIds: [],
      unresolvedTagSuggestions: [],
      tagReview: [],
      ownerAssignedRecordIds: [],
    };
    const before = structuredClone({ target, source });
    const result = mergeProposalDrafts(target, source, ['Video study'], 'keep_target');
    const validated = validateCollectionDraft(result.draft, new Set(records.map((r) => r.id)));
    expect(validated.assignments).toHaveLength(257);
    expect(validated.unresolvedRecordIds).toHaveLength(78);
    expect(validated.assignments.slice(0, 254)).toEqual(target.assignments);
    expect(validated.assignments[254]?.suggestedTags).toEqual(['reference', 'video']);
    expect(validated.name).toBe(target.name);
    expect(validated.tagReview).toEqual(target.tagReview);
    expect(
      new Set([...validated.assignments.map((a) => a.recordId), ...validated.unresolvedRecordIds])
        .size,
    ).toBe(335);
    expect({ target, source }).toEqual(before);
    expect(
      mergeProposalDrafts({ ...target, ...result.draft }, source, ['Video study'], 'keep_target')
        .draft,
    ).toEqual(result.draft);
  });
  it('makes conflicting assignments explicit and rejects incompatible page versions without changing inputs', () => {
    const target = proposal();
    const source = proposal();
    source.id = 'source';
    source.projects[0]!.name = 'Archive';
    source.assignments = [
      { ...source.assignments[0]!, projectName: 'Archive', suggestedTags: ['history'] },
    ];
    source.unresolvedRecordIds = [];
    source.scopeRecordIds = [records[0]!.id];
    source.unresolvedTagSuggestions = [];
    source.tagReview = [];
    const kept = mergeProposalDrafts(target, source, [], 'keep_target');
    expect(kept.conflicts).toBe(1);
    expect(kept.draft.assignments[0]?.projectName).toBe('Library');
    expect(kept.draft.assignments[0]?.reason).toBe('Existing reason');
    expect(
      mergeProposalDrafts(target, source, [], 'use_source').draft.assignments[0]?.projectName,
    ).toBe('Archive');
    source.assignments[0]!.navigationVersion++;
    expect(() => mergeProposalDrafts(target, source, [], 'keep_target')).toThrow(
      'different page versions',
    );
    expect(target.assignments[0]?.suggestedTags).toEqual(['reading']);
  });
  it('combines/removes structure while retaining every occurrence, tag and unrelated review marker', () => {
    const target = proposal();
    const draft = editableProposal(target);
    mergeDraftCategories(draft, 'Library', 'Sources', 'Notes');
    expect(draft.assignments.every((a) => a.categoryName === 'Notes')).toBe(true);
    expect(removeDraftStructure(draft, 'Library', 'Notes')).toBe(254);
    expect(draft.assignments).toEqual([]);
    expect(new Set(draft.unresolvedRecordIds).size).toBe(335);
    expect(
      draft.unresolvedTagSuggestions?.find((a) => a.recordId === records[0]!.id)?.suggestedTags,
    ).toEqual(['reading']);
    expect(draft.tagReview).toEqual(target.tagReview);
    validateCollectionDraft(draft, new Set(records.map((r) => r.id)));
    expect(target.assignments).toHaveLength(254);
  });
});
