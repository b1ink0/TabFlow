import { describe, expect, it } from 'vitest';
import { newRecord } from '../src/shared/model';
import { workspaceRows } from '../src/shared/workspace/workspace-navigation';
import type { Membership } from '../src/shared/types';
import { emptyTabFilters, readTabFilters, writeTabFilters } from '../src/shared/tabs/tab-filters';

describe('semantic workspace navigation', () => {
  it('combines independent multi-label tags with semantic scope and retains missing targets in URLs', () => {
    const rows = [
      {
        ...newRecord('https://example.test/shared', 'a'),
        live: true,
        windowId: 1,
        groupId: 7,
        tags: ['Vue', 'accessibility'],
      },
      {
        ...newRecord('https://example.test/shared', 'b'),
        live: true,
        windowId: 2,
        groupId: 8,
        tags: ['Vue'],
      },
      {
        ...newRecord('https://example.test/empty', 'c'),
        live: true,
        windowId: 1,
        groupId: -1,
        tags: [],
      },
    ];
    const filter = { ...emptyTabFilters(), tags: ['Vue', 'accessibility'] };
    expect(workspaceRows(rows, [], { kind: 'all' }, '', filter).map((r) => r.id)).toEqual([
      'a',
      'b',
    ]);
    filter.mode = 'all';
    expect(workspaceRows(rows, [], { kind: 'all' }, '', filter).map((r) => r.id)).toEqual(['a']);
    filter.windowId = '2';
    expect(workspaceRows(rows, [], { kind: 'all' }, '', filter)).toHaveLength(0);
    const link = writeTabFilters(new URLSearchParams('unrelated=kept'), {
      ...filter,
      projectId: 'deleted-project',
      tags: ['C++', 'a&b'],
    });
    expect(link.get('unrelated')).toBe('kept');
    expect(readTabFilters(link)).toEqual({
      ...filter,
      projectId: 'deleted-project',
      tags: ['C++', 'a&b'],
    });
    expect(workspaceRows(rows, [], { kind: 'all' }, '', readTabFilters(link))).toHaveLength(0);
    expect(
      workspaceRows(rows, [], { kind: 'all' }, '', { ...emptyTabFilters(), untagged: true }).map(
        (r) => r.id,
      ),
    ).toEqual(['c']);
  });
  it('searches semantic names and native groups and combines exact group/tag filters', () => {
    const record = {
      ...newRecord('https://example.test', 'one'),
      live: true,
      groupId: 7,
      tags: ['reference'],
    };
    const context = {
      groups: [
        {
          id: 7,
          windowId: 1,
          title: 'Native reading',
          color: 'grey' as const,
          collapsed: false,
          shared: false,
        },
      ],
    };
    expect(
      workspaceRows([record], [], { kind: 'all' }, 'native reading', '', context),
    ).toHaveLength(1);
    expect(
      workspaceRows([record], [], { kind: 'all' }, '', 'reference', { ...context, groupId: 7 }),
    ).toHaveLength(1);
    expect(
      workspaceRows([record], [], { kind: 'all' }, '', 'reference', { ...context, groupId: -1 }),
    ).toHaveLength(0);
  });
  const first = {
    ...newRecord('https://example.com/shared', 'first'),
    live: true,
    windowId: 1,
    index: 0,
  };
  const duplicate = {
    ...newRecord('https://example.com/shared', 'duplicate'),
    live: true,
    windowId: 2,
    index: 0,
  };
  const daily = {
    ...newRecord('https://example.com/daily', 'daily'),
    live: true,
    windowId: 1,
    index: 1,
    tags: ['routine'],
  };
  const inbox = {
    ...newRecord('https://example.com/new', 'inbox'),
    live: true,
    windowId: 2,
    index: 1,
  };
  const memberships: Membership[] = [
    {
      recordId: first.id,
      projectId: 'research',
      categoryId: 'reading',
      source: 'accepted-ai',
      updatedAt: 1,
    },
    {
      recordId: duplicate.id,
      projectId: 'research',
      categoryId: 'reading',
      source: 'accepted-ai',
      updatedAt: 1,
    },
    {
      recordId: daily.id,
      projectId: 'daily-project',
      categoryId: 'routine',
      source: 'owner',
      updatedAt: 1,
    },
  ];
  const records = [first, duplicate, daily, inbox];

  it('shows a project across two windows while keeping duplicate occurrences separate', () => {
    expect(
      workspaceRows(records, memberships, { kind: 'project', projectId: 'research' }).map(
        (row) => row.id,
      ),
    ).toEqual(['first', 'duplicate']);
    expect(
      workspaceRows(records, memberships, { kind: 'window', windowId: 1 }).map((row) => row.id),
    ).toEqual(['first', 'daily']);
  });

  it('keeps unassigned tabs in Inbox and filters tags independently of project', () => {
    expect(workspaceRows(records, memberships, { kind: 'inbox' }).map((row) => row.id)).toEqual([
      'inbox',
    ]);
    expect(
      workspaceRows(records, memberships, { kind: 'all' }, '', 'routine').map((row) => row.id),
    ).toEqual(['daily']);
    expect(
      workspaceRows(records, memberships, {
        kind: 'project',
        projectId: 'research',
        categoryId: 'reading',
      }).map((row) => row.id),
    ).toEqual(['first', 'duplicate']);
  });
  it('an explicit Inbox membership overrides a browser-window project hint', () => {
    const row = { ...inbox, projectId: 'old-window-project' };
    const correction: Membership = {
      recordId: row.id,
      projectId: null,
      categoryId: null,
      source: 'owner',
      updatedAt: 1,
    };
    expect(workspaceRows([row], [correction], { kind: 'inbox' })).toEqual([row]);
    expect(
      workspaceRows([row], [correction], { kind: 'project', projectId: 'old-window-project' }),
    ).toEqual([]);
  });
});
