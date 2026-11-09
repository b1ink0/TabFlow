import { searchable } from '../model';
import { matchesTags, type TabFilters } from '../tabs/tab-filters';
import type { Membership, TabRecord, Project, Category } from '../types';

export type WorkspaceScope =
  | { kind: 'all' }
  | { kind: 'inbox' }
  | { kind: 'window'; windowId: number }
  | { kind: 'project'; projectId: string; categoryId?: string };

export function workspaceRows(
  records: readonly TabRecord[],
  memberships: readonly Membership[],
  scope: WorkspaceScope,
  search = '',
  tag: string | TabFilters = '',
  context: {
    projects?: readonly Project[];
    categories?: readonly Category[];
    groups?: readonly chrome.tabGroups.TabGroup[];
    groupId?: number;
  } = {},
): TabRecord[] {
  const byRecord = new Map(memberships.map((membership) => [membership.recordId, membership]));
  const query = search.trim().toLocaleLowerCase();
  return records
    .filter((record) => {
      if (!record.live) return false;
      if (context.groupId !== undefined && record.groupId !== context.groupId) return false;
      const membership = byRecord.get(record.id);
      const projectId = membership ? membership.projectId : record.projectId;
      if (typeof tag !== 'string') {
        if (!matchesTags(record.tags, tag)) return false;
        if (tag.projectId && projectId !== tag.projectId) return false;
        if (tag.categoryId && membership?.categoryId !== tag.categoryId) return false;
        if (tag.windowId && record.windowId !== Number(tag.windowId)) return false;
        if (tag.groupId && record.groupId !== Number(tag.groupId)) return false;
      }
      if (scope.kind === 'window' && record.windowId !== scope.windowId) return false;
      if (scope.kind === 'inbox' && projectId) return false;
      if (
        scope.kind === 'project' &&
        (projectId !== scope.projectId ||
          (scope.categoryId && membership?.categoryId !== scope.categoryId))
      )
        return false;
      if (tag === '__untagged__' && record.tags.length) return false;
      if (typeof tag === 'string' && tag && tag !== '__untagged__' && !record.tags.includes(tag))
        return false;
      return (
        !query ||
        [
          searchable(record),
          context.projects?.find((project) => project.id === projectId)?.name,
          context.categories?.find((category) => category.id === membership?.categoryId)?.name,
          context.groups?.find((group) => group.id === record.groupId)?.title,
        ]
          .filter(Boolean)
          .join(' ')
          .toLocaleLowerCase()
          .includes(query)
      );
    })
    .sort(
      (left, right) => (left.windowId ?? 0) - (right.windowId ?? 0) || left.index - right.index,
    );
}
