import { describe, expect, it } from 'vitest';
import {
  nativeGroupActions,
  renameDraftProject,
  renameDraftCategory,
  mergeDraftProjects,
} from '../src/shared/organization/collection';
import { newRecord, validateCollectionDraft } from '../src/shared/model';
import type { AppState, CollectionDraft, CollectionProposal, TabRecord } from '../src/shared/types';

const records: TabRecord[] = [
  { ...newRecord('https://example.com/same'), id: 'r2', live: true, windowId: 1, index: 4 },
  { ...newRecord('https://example.com/same'), id: 'r1', live: true, windowId: 1, index: 2 },
  { ...newRecord('https://example.com/third'), id: 'r3', live: true, windowId: 2, index: 0 },
  {
    ...newRecord('https://example.com/pinned'),
    id: 'r5',
    live: true,
    pinned: true,
    windowId: 1,
    index: 5,
  },
  {
    ...newRecord('https://example.com/locked'),
    id: 'r4',
    live: true,
    locked: true,
    windowId: 1,
    index: 6,
  },
];
const proposal: CollectionProposal = {
  id: 'proposal',
  createdAt: 1,
  status: 'applied',
  summary: '',
  projects: [
    {
      name: 'Work',
      purpose: '',
      areaName: 'Life',
      categories: [{ name: 'Research', description: '' }],
    },
  ],
  assignments: [
    ...['r1', 'r2', 'r3', 'r4', 'r5'].map((recordId) => ({
      recordId,
      url: records.find((record) => record.id === recordId)!.url,
      navigationVersion: 0,
      projectName: 'Work',
      categoryName: 'Research',
      reason: '',
      confidence: 0.8,
    })),
  ],
  unresolvedRecordIds: [],
};
const app: Pick<AppState, 'records' | 'projects' | 'categories' | 'memberships' | 'groups'> = {
  records,
  projects: [
    {
      id: 'p1',
      name: 'Work',
      purpose: '',
      areaId: null,
      updatedAt: 1,
      revision: 1,
      maintainReviewQueue: false,
    },
  ],
  categories: [
    {
      id: 'c1',
      projectId: 'p1',
      name: 'Research',
      description: '',
      order: 0,
      updatedAt: 1,
      revision: 1,
    },
  ],
  memberships: ['r1', 'r2', 'r3', 'r4', 'r5'].map((recordId) => ({
    recordId,
    projectId: 'p1',
    categoryId: 'c1',
    source: 'accepted-ai' as const,
    updatedAt: 1,
  })),
  groups: [],
};

describe('native grouping projection', () => {
  it('merges proposed project windows without losing category distinctions or duplicate tab occurrences', () => {
    const draft: CollectionDraft = {
      summary: '',
      projects: [
        {
          name: 'App',
          purpose: 'Build',
          areaName: 'Work',
          categories: [{ name: 'References', description: 'App docs' }],
        },
        {
          name: 'Design',
          purpose: 'Design',
          areaName: 'Work',
          categories: [{ name: 'References', description: 'Design docs' }],
        },
      ],
      assignments: [
        {
          recordId: 'r1',
          url: records[1]!.url,
          navigationVersion: 0,
          projectName: 'App',
          categoryName: 'References',
          reason: '',
          confidence: 1,
        },
        {
          recordId: 'r2',
          url: records[0]!.url,
          navigationVersion: 0,
          projectName: 'Design',
          categoryName: 'References',
          reason: '',
          confidence: 1,
        },
      ],
      unresolvedRecordIds: [],
    };
    mergeDraftProjects(draft, 'Design', 'App');
    expect(draft.projects).toHaveLength(1);
    expect(draft.assignments.map((item) => item.recordId)).toEqual(['r1', 'r2']);
    expect(draft.assignments[1]?.projectName).toBe('App');
    expect(draft.assignments[1]?.categoryName).toBe('Design · References');
    expect(draft.ownerAssignedRecordIds).toEqual(['r2']);
    expect(validateCollectionDraft(draft, new Set(['r1', 'r2'])).assignments).toHaveLength(2);
  });
  it('requires complete coverage of the analyzed scope without including unrelated occurrences', () => {
    const scoped = {
      ...proposal,
      scopeRecordIds: ['r1'],
      assignments: proposal.assignments.filter((item) => item.recordId === 'r1'),
    };
    expect(
      validateCollectionDraft(scoped, new Set(records.map((record) => record.id))).scopeRecordIds,
    ).toEqual(['r1']);
    expect(() =>
      validateCollectionDraft({ ...scoped, assignments: [] }, new Set(['r1', 'r2'])),
    ).toThrow(/omitted/);
    expect(() =>
      validateCollectionDraft({ ...scoped, unresolvedRecordIds: ['r2'] }, new Set(['r1', 'r2'])),
    ).toThrow(/invalid unresolved/);
    expect(() =>
      validateCollectionDraft({ ...scoped, scopeRecordIds: ['unknown'] }, new Set(['r1'])),
    ).toThrow(/invalid occurrence scope/);
  });
  it('keeps occurrence references connected when the reviewed taxonomy is renamed', () => {
    const draft = structuredClone(proposal);
    renameDraftProject(draft, 'Work', 'Personal research');
    renameDraftCategory(draft, 'Personal research', 'Research', 'References');
    expect(
      draft.assignments.every(
        (assignment) =>
          assignment.projectName === 'Personal research' &&
          assignment.categoryName === 'References',
      ),
    ).toBe(true);
    expect(draft.projects[0]?.categories[0]?.name).toBe('References');
    expect(() => renameDraftCategory(draft, 'Personal research', 'References', '')).toThrow(
      'unique',
    );
  });
  it('groups reviewed occurrences by project within each window, including singletons', () => {
    const actions = nativeGroupActions(proposal, app);
    expect(actions).toHaveLength(2);
    expect(actions[0]).toMatchObject({
      type: 'group',
      windowId: 1,
      name: 'Work · Research',
      recordIds: ['r1', 'r2'],
    });
    expect(actions[1]).toMatchObject({
      type: 'group',
      windowId: 2,
      name: 'Work · Research',
      recordIds: ['r3'],
    });
  });
  it('retains the existing project group color and uses neutral grey for new groups', () => {
    const existingGroup = {
      id: 80,
      windowId: 1,
      title: 'Work · Research',
      color: 'orange' as const,
      collapsed: false,
      shared: false,
    };
    const actions = nativeGroupActions(proposal, { ...app, groups: [existingGroup] });
    expect(actions.find((action) => action.windowId === 1)?.color).toBe('orange');
    expect(actions.find((action) => action.windowId === 2)?.color).toBe('grey');
    expect(existingGroup.color).toBe('orange');
  });
  it('uses an owner category color for a new native projection without recoloring existing groups', () => {
    const categories = app.categories.map((category) => ({
      ...category,
      color: 'purple' as const,
    }));
    const existingGroup = {
      id: 9,
      windowId: 1,
      title: 'Work · Research',
      color: 'orange' as const,
      collapsed: false,
      shared: false,
    };
    const actions = nativeGroupActions(proposal, { ...app, categories, groups: [existingGroup] });
    expect(actions.find((action) => action.windowId === 1)?.color).toBe('orange');
    expect(actions.find((action) => action.windowId === 2)?.color).toBe('purple');
    expect(existingGroup.color).toBe('orange');
  });

  it('leaves locked, pinned, stale, and already-grouped occurrences out', () => {
    const actions = nativeGroupActions(proposal, {
      ...app,
      records: records.map((record) =>
        record.id === 'r1' || record.id === 'r2'
          ? { ...record, groupId: 8 }
          : record.id === 'r3'
            ? { ...record, navigationVersion: 1 }
            : record,
      ),
      groups: [
        {
          id: 8,
          windowId: 1,
          title: 'Work · Research',
          color: 'blue',
          collapsed: false,
          shared: false,
        },
      ],
    });
    expect(actions).toEqual([]);
  });
});
