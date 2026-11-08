import type { AppState, TabRecord } from './types';
import { tabAncestors, validateTabTree } from './tab-tree';
import type { WorkspaceEdit } from './workspace-edits';

export type TreeDropPosition = 'before' | 'inside' | 'after' | 'root';
export function tabTreeSectionDrop(
  app: Pick<AppState, 'records' | 'memberships' | 'projects' | 'categories'>,
  sourceId: string,
  projectId: string,
  categoryId: string | null,
) {
  if (
    !app.projects.some((project) => project.id === projectId) ||
    (categoryId &&
      !app.categories.some(
        (category) => category.id === categoryId && category.projectId === projectId,
      ))
  )
    throw new Error('Choose an existing project and category.');
  const moved = app.records.filter(
    (record) =>
      record.live &&
      (record.id === sourceId || tabAncestors(record.id, app.records).includes(sourceId)),
  );
  if (!moved.some((record) => record.id === sourceId) || moved.some((record) => record.locked))
    throw new Error('Choose an unprotected open branch.');
  const edits: WorkspaceEdit[] = [];
  if (moved.find((record) => record.id === sourceId)?.parentRecordId)
    edits.push({ kind: 'tab_parent', recordId: sourceId, parentRecordId: null });
  for (const record of moved) {
    const membership = app.memberships.find((item) => item.recordId === record.id);
    if (
      (membership ? membership.projectId : record.projectId) !== projectId ||
      (membership?.categoryId || null) !== categoryId
    )
      edits.push({ kind: 'membership', recordId: record.id, projectId, categoryId });
  }
  return {
    movedIds: moved.map((record) => record.id),
    edits,
    parentRecordId: null,
    projectId,
    categoryId,
  };
}
export function tabTreeDrop(
  app: Pick<AppState, 'records' | 'memberships'>,
  sourceId: string,
  targetId: string,
  position: TreeDropPosition,
) {
  const source = app.records.find((record) => record.id === sourceId && record.live);
  const target = app.records.find((record) => record.id === targetId && record.live);
  if (!source || !target || source === target) throw new Error('Choose a different open tab.');
  const moved = app.records.filter(
    (record) =>
      record.live &&
      (record.id === sourceId || tabAncestors(record.id, app.records).includes(sourceId)),
  );
  if (moved.some((record) => record.id === targetId))
    throw new Error('A branch cannot be moved into itself.');
  if (target.locked || moved.some((record) => record.locked))
    throw new Error('Remove protection before moving this branch.');
  const parentRecordId =
    position === 'inside' ? targetId : position === 'root' ? null : target.parentRecordId || null;
  validateTabTree(
    app.records.map((record) => (record.id === sourceId ? { ...record, parentRecordId } : record)),
  );
  const membership = app.memberships.find((item) => item.recordId === targetId);
  const projectId = membership ? membership.projectId : target.projectId;
  const categoryId = membership?.categoryId || null;
  const edits: WorkspaceEdit[] = [];
  if ((source.parentRecordId || null) !== parentRecordId)
    edits.push({ kind: 'tab_parent', recordId: sourceId, parentRecordId });
  for (const record of moved) {
    const current = app.memberships.find((item) => item.recordId === record.id);
    if (
      (current ? current.projectId : record.projectId) !== projectId ||
      (current?.categoryId || null) !== categoryId
    )
      edits.push({ kind: 'membership', recordId: record.id, projectId, categoryId });
  }
  return {
    movedIds: moved.map((record) => record.id),
    edits,
    parentRecordId,
    projectId,
    categoryId,
  };
}

export function orderTabTreeDrop(
  records: readonly TabRecord[],
  movedIds: readonly string[],
  targetId: string,
  position: TreeDropPosition,
) {
  const moved = new Set(movedIds);
  const remaining = records.filter((record) => !moved.has(record.id));
  let index = remaining.findIndex((record) => record.id === targetId);
  if (index < 0) throw new Error('Drop target is no longer in this list.');
  if (position !== 'before') {
    index++;
    while (
      index < remaining.length &&
      tabAncestors(remaining[index]!.id, records).includes(targetId)
    )
      index++;
  }
  const ids = remaining.map((record) => record.id);
  ids.splice(index, 0, ...movedIds);
  return ids;
}
