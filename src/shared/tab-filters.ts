export interface TabFilters {
  tags: string[];
  mode: 'any' | 'all';
  untagged: boolean;
  projectId: string;
  categoryId: string;
  groupId: string;
  windowId: string;
}
export const emptyTabFilters = (): TabFilters => ({
  tags: [],
  mode: 'any',
  untagged: false,
  projectId: '',
  categoryId: '',
  groupId: '',
  windowId: '',
});
export function matchesTags(
  tags: readonly string[],
  filter: Pick<TabFilters, 'tags' | 'mode' | 'untagged'>,
) {
  if (filter.untagged) return tags.length === 0;
  if (!filter.tags.length) return true;
  return filter.mode === 'all'
    ? filter.tags.every((tag) => tags.includes(tag))
    : filter.tags.some((tag) => tags.includes(tag));
}
export function readTabFilters(params: URLSearchParams): TabFilters {
  return {
    tags: [
      ...new Set(params.getAll('tag').filter((tag) => tag.length > 0 && tag.length <= 80)),
    ].slice(0, 20),
    mode: params.get('tagMatch') === 'all' ? 'all' : 'any',
    untagged: params.get('untagged') === '1',
    projectId: params.get('project') || '',
    categoryId: params.get('category') || '',
    groupId: params.get('group') || '',
    windowId: params.get('window') || '',
  };
}
export function writeTabFilters(params: URLSearchParams, filter: TabFilters): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const key of ['tag', 'tagMatch', 'untagged', 'project', 'category', 'group', 'window'])
    next.delete(key);
  for (const tag of filter.tags) next.append('tag', tag);
  if (filter.mode === 'all') next.set('tagMatch', 'all');
  if (filter.untagged) next.set('untagged', '1');
  for (const [key, value] of [
    ['project', filter.projectId],
    ['category', filter.categoryId],
    ['group', filter.groupId],
    ['window', filter.windowId],
  ])
    if (value) next.set(key!, value!);
  return next;
}
