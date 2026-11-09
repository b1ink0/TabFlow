import { searchable } from '../model';
import type { AppState, TabRecord } from '../types';
type SearchContext = Partial<Pick<AppState, 'memberships' | 'projects' | 'categories' | 'groups'>>;
const documents = new WeakMap<TabRecord, string>();
/** Search the current local snapshot in bounded chunks; IndexedDB has no full-text index. */
export async function searchTabIds(
  records: readonly TabRecord[],
  context: SearchContext,
  query: string,
  options: { signal?: AbortSignal; yieldTask?: () => Promise<void> } = {},
) {
  const needle = query.trim().toLocaleLowerCase(),
    matches = new Set<string>();
  const memberships = new Map(context.memberships?.map((item) => [item.recordId, item]));
  const projects = new Map(context.projects?.map((item) => [item.id, item.name]));
  const categories = new Map(context.categories?.map((item) => [item.id, item.name]));
  const groups = new Map(context.groups?.map((item) => [item.id, item.title]));
  const yieldTask =
    options.yieldTask || (() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  for (let start = 0; start < records.length; start += 32) {
    options.signal?.throwIfAborted();
    for (const record of records.slice(start, start + 32)) {
      if (!record.live) continue;
      const membership = memberships.get(record.id);
      const projectId = membership ? membership.projectId : record.projectId;
      let document = documents.get(record);
      if (document === undefined) {
        document = searchable(record);
        documents.set(record, document);
      }
      const labels = [
        projectId ? projects.get(projectId) : '',
        membership?.categoryId ? categories.get(membership.categoryId) : '',
        groups.get(record.groupId),
      ]
        .filter(Boolean)
        .join(' ')
        .toLocaleLowerCase();
      if (!needle || document.includes(needle) || labels.includes(needle)) matches.add(record.id);
    }
    if (start + 32 < records.length) await yieldTask();
  }
  options.signal?.throwIfAborted();
  return matches;
}
