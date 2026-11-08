import type { AppState } from './types';
import { MAX_TAB_TREE_LEVELS } from './tab-tree';

/** A drag-session index; full live effect validation still runs when the drop commits. */
export function tabDragIndex(
  app: Pick<AppState, 'records' | 'projects' | 'categories'>,
  sourceId: string,
) {
  const records = new Map(
    app.records.map((record) => [
      record.id,
      { parent: record.parentRecordId, live: record.live, locked: record.locked },
    ]),
  );
  const children = new Map<string, string[]>();
  for (const record of app.records)
    if (record.live && record.parentRecordId) {
      const list = children.get(record.parentRecordId) || [];
      list.push(record.id);
      children.set(record.parentRecordId, list);
    }
  const moved = new Set<string>();
  let height = 1,
    protectedBranch = false;
  const pending = [{ id: sourceId, level: 1 }];
  while (pending.length) {
    const item = pending.pop()!;
    if (moved.has(item.id)) continue;
    moved.add(item.id);
    height = Math.max(height, item.level);
    protectedBranch ||= Boolean(records.get(item.id)?.locked);
    for (const child of children.get(item.id) || [])
      pending.push({ id: child, level: item.level + 1 });
  }
  function validParent(parentId: string | null) {
    if (!records.get(sourceId)?.live || protectedBranch) return false;
    if (!parentId) return height <= MAX_TAB_TREE_LEVELS;
    let id: string | null | undefined = parentId,
      depth = 0;
    const seen = new Set<string>();
    while (id && records.has(id)) {
      if (moved.has(id) || seen.has(id)) return false;
      if (!depth && (!records.get(id)?.live || records.get(id)?.locked)) return false;
      seen.add(id);
      depth++;
      id = records.get(id)?.parent;
    }
    return depth + height <= MAX_TAB_TREE_LEVELS;
  }
  const projects = new Set(app.projects.map((project) => project.id));
  const categories = new Map(app.categories.map((category) => [category.id, category.projectId]));
  return {
    records,
    moved,
    validTarget: (targetId: string, position: 'before' | 'after' | 'inside' | 'root') => {
      const target = records.get(targetId);
      return Boolean(
        target?.live &&
        !target.locked &&
        !moved.has(targetId) &&
        validParent(
          position === 'inside' ? targetId : position === 'root' ? null : target.parent || null,
        ),
      );
    },
    validSection: (projectId: string, categoryId: string | null) =>
      validParent(null) &&
      projects.has(projectId) &&
      (!categoryId || categories.get(categoryId) === projectId),
  };
}
