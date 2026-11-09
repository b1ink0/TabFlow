import { describe, expect, it } from 'vitest';
import { newRecord } from '../src/shared/model';
import {
  proposalExport,
  proposalImport,
  safeProposalUrl,
} from '../src/shared/organization/proposal-review';
import type { CollectionDraft } from '../src/shared/types';

describe('proposal export', () => {
  it('imports 330 stable duplicate occurrences without applying or trusting model-supplied live addresses', () => {
    const records = Array.from({ length: 330 }, (_, index) => ({
      ...newRecord('https://example.test/same?private=1', `occ-${index}`),
      live: true,
      navigationVersion: 2,
    }));
    const draft: CollectionDraft = {
      summary: 'Imported',
      projects: [
        {
          name: 'Work',
          purpose: 'References',
          areaName: 'Work',
          categories: [{ name: 'Docs', description: '' }],
        },
      ],
      assignments: records.map((record) => ({
        recordId: record.id,
        url: record.url,
        navigationVersion: 2,
        projectName: 'Work',
        categoryName: 'Docs',
        reason: 'Documentation',
        confidence: 0.8,
        suggestedTags: ['reference'],
      })),
      unresolvedRecordIds: [],
    };
    const exported = proposalExport({ id: 'source', createdAt: 1 }, draft, records);
    const preview = proposalImport(exported, records, []);
    expect(preview.draft.assignments).toHaveLength(330);
    expect(new Set(preview.draft.scopeRecordIds).size).toBe(330);
    expect(preview.draft.assignments[0]?.url).toBe(records[0]!.url);
    expect(preview.draft.assignments[0]?.suggestedTags).toEqual(['reference']);
    expect(records[0]!.tags).toEqual([]);
    const uncertain = {
      ...draft,
      assignments: draft.assignments.slice(1),
      unresolvedRecordIds: [records[0]!.id],
      unresolvedTagSuggestions: [
        {
          recordId: records[0]!.id,
          url: records[0]!.url,
          navigationVersion: 2,
          suggestedTags: ['Vue', 'reference'],
        },
      ],
    };
    const independent = proposalImport(
      proposalExport({ id: 'independent', createdAt: 1 }, uncertain, records),
      records,
      [],
    );
    expect(independent.draft.unresolvedTagSuggestions?.[0]?.suggestedTags).toEqual([
      'Vue',
      'reference',
    ]);
    expect(exported.scope.occurrenceCount).toBe(330);
    expect(() =>
      proposalImport({ ...exported, assignments: exported.assignments.slice(1) }, records, []),
    ).toThrow('scope exactly');
    expect(() =>
      proposalImport(
        {
          ...exported,
          scope: {
            ...exported.scope,
            occurrenceIds: [...exported.scope.occurrenceIds.slice(1), 'different'],
          },
        },
        records,
        [],
      ),
    ).toThrow('scope exactly');
    const { scope, ...legacyResponse } = exported;
    expect(scope.kind).toBe('selection');
    expect(proposalImport(legacyResponse, records, []).draft.assignments).toHaveLength(330);
    records[0]!.locked = true;
    records[1]!.navigationVersion = 3;
    records[2]!.live = false;
    const reduced = proposalImport(exported, records, [
      {
        recordId: records[3]!.id,
        projectId: null,
        categoryId: null,
        source: 'owner',
        updatedAt: 1,
      },
    ]);
    expect(reduced.skipped).toHaveLength(4);
    expect(reduced.draft.assignments).toHaveLength(326);
    exported.assignments.push(exported.assignments[0]!);
    expect(() => proposalImport(exported, records, [])).toThrow('repeats');
  });
  it('rejects invalid taxonomy and identity guesses while accepting older exports with a warning', () => {
    const record = { ...newRecord('https://example.test/docs', 'known'), live: true };
    const raw = {
      format: 'tabflow-collection-proposal',
      version: 1,
      summary: 'Review',
      projects: [
        {
          name: 'Work',
          purpose: '',
          areaName: 'Work',
          categories: [{ name: 'Docs', description: '' }],
        },
      ],
      assignments: [
        {
          occurrenceId: 'known',
          title: 'Docs',
          url: record.url,
          projectName: 'Work',
          categoryName: 'Docs',
          reason: '',
          confidence: 0.8,
        },
      ],
      unresolved: [],
    };
    expect(proposalImport(raw, [record], []).legacyAddressChecks).toBe(true);
    expect(() =>
      proposalImport(
        { ...raw, assignments: [{ ...raw.assignments[0], occurrenceId: 'different' }] },
        [record],
        [],
      ),
    ).toThrow('No eligible');
    expect(() =>
      proposalImport(
        { ...raw, assignments: [{ ...raw.assignments[0], categoryName: 'Invented' }] },
        [record],
        [],
      ),
    ).toThrow('Available categories: "Docs"');
    expect(() =>
      proposalImport(
        { ...raw, assignments: [{ ...raw.assignments[0], suggestedTags: ['x'.repeat(81)] }] },
        [record],
        [],
      ),
    ).toThrow();
  });
  it('preserves every occurrence and existing tag while excluding cached content and URL secrets', () => {
    const records = Array.from({ length: 330 }, (_, index) => ({
      ...newRecord(
        `https://user:secret@example.test/item/${index}?token=private#fragment`,
        `tab-${index}`,
      ),
      title: `Reference ${index}`,
      tags: index % 2 ? ['research'] : [],
      content: {
        title: 'Private page',
        description: '',
        headings: [],
        text: 'PRIVATE CACHED CONTENT',
        capturedAt: 1,
        url: `https://example.test/item/${index}`,
        scroll: 0,
        dirty: false,
        playing: false,
      },
    }));
    const draft: CollectionDraft = {
      summary: 'Review first',
      projects: [
        {
          name: 'Research',
          purpose: 'Keep references',
          areaName: 'Personal',
          categories: [{ name: 'Reading', description: 'Articles' }],
        },
      ],
      assignments: records.slice(0, 247).map((record) => ({
        recordId: record.id,
        url: record.url,
        navigationVersion: 0,
        projectName: 'Research',
        categoryName: 'Reading',
        reason: 'Reference',
        confidence: 0.8,
      })),
      unresolvedRecordIds: records.slice(247).map((record) => record.id),
    };
    const result = proposalExport({ id: 'saved', createdAt: 1 }, draft, records);
    expect(result.assignments).toHaveLength(247);
    expect(result.unresolved).toHaveLength(83);
    expect(
      new Set([...result.assignments, ...result.unresolved].map((item) => item.occurrenceId)).size,
    ).toBe(330);
    expect(result.assignments[1]?.tags).toEqual(['research']);
    expect(result.assignments[0]?.tags).toEqual([]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('PRIVATE CACHED CONTENT');
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('private');
    expect(serialized).not.toContain('#fragment');
    expect(draft.assignments).toHaveLength(247);
  });

  it('does not export internal extension URLs', () => {
    expect(safeProposalUrl('chrome-extension://identifier/suspended.html?id=secret')).toBe('null');
  });
});
