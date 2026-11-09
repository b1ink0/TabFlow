import type { TabRecord } from '../types';

export const MAX_TAB_TREE_LEVELS = 5;
type TreeRecord = Pick<TabRecord, 'id' | 'parentRecordId'>;

export function tabAncestors(id: string, records: readonly TreeRecord[]): string[] {
  const byId = new Map(records.map((record) => [record.id, record]));
  const visited = new Set([id]);
  const ancestors: string[] = [];
  let parent = byId.get(id)?.parentRecordId;
  while (parent && byId.has(parent)) {
    if (visited.has(parent)) throw new Error('Tab branches cannot contain a cycle.');
    visited.add(parent);
    ancestors.push(parent);
    if (ancestors.length >= MAX_TAB_TREE_LEVELS)
      throw new Error('Tab branches support up to five levels.');
    parent = byId.get(parent)?.parentRecordId;
  }
  return ancestors;
}
export function validateTabTree(records: readonly TreeRecord[]) {
  for (const record of records) tabAncestors(record.id, records);
}
export function automaticTabParent(openerId: string, records: readonly TreeRecord[]) {
  const lineage = [openerId, ...tabAncestors(openerId, records)];
  return lineage[Math.max(0, lineage.length - (MAX_TAB_TREE_LEVELS - 1))] || null;
}
export interface TabTreeRow {
  record: TabRecord;
  depth: number;
  childCount: number;
}
/** Out-of-scope parents never hide matching children. Native ordering is left untouched. */
export function tabTreeRows(
  records: readonly TabRecord[],
  collapsed: readonly string[],
  expanded = false,
): TabTreeRow[] {
  const ids = new Set(records.map((record) => record.id));
  const children = new Map<string, TabRecord[]>();
  for (const record of records) {
    if (!record.parentRecordId || !ids.has(record.parentRecordId)) continue;
    const siblings = children.get(record.parentRecordId) || [];
    siblings.push(record);
    children.set(record.parentRecordId, siblings);
  }
  const visited = new Set<string>(),
    hidden = new Set(collapsed),
    rows: TabTreeRow[] = [];
  function walk(record: TabRecord, depth: number, visible: boolean) {
    if (visited.has(record.id)) return;
    visited.add(record.id);
    const descendants = children.get(record.id) || [];
    if (visible) rows.push({ record, depth, childCount: descendants.length });
    for (const child of descendants)
      walk(
        child,
        Math.min(depth + 1, MAX_TAB_TREE_LEVELS - 1),
        visible && (expanded || !hidden.has(record.id)),
      );
  }
  for (const record of records)
    if (!record.parentRecordId || !ids.has(record.parentRecordId)) walk(record, 0, true);
  for (const record of records) if (!visited.has(record.id)) walk(record, 0, true);
  return rows;
}
