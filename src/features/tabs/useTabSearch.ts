import { computed, ref, shallowRef, watch, type Ref } from 'vue';
import { refDebounced } from '@vueuse/core';
import { searchTabIds } from '../../shared/tab-search';
import type { AppState, TabRecord } from '../../shared/types';
export function useTabSearch(
  query: Ref<string>,
  records: () => readonly TabRecord[],
  context: () => AppState | undefined,
) {
  const settled = refDebounced(query, 160),
    matches = shallowRef<ReadonlySet<string> | null>(null),
    pending = ref(false);
  let generation = 0,
    controller: AbortController | undefined;
  let completedQuery = '';
  const searchableState = computed(() => {
    if (!query.value.trim()) return '';
    const app = context();
    return JSON.stringify([
      records()
        .map((record) => [
          record.id,
          record.live,
          record.title,
          record.branchName,
          record.url,
          record.note,
          record.tags,
          record.projectId,
          record.groupId,
          record.content?.description,
          record.content?.headings,
          record.content?.text,
        ])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      app?.memberships.map((item) => [item.recordId, item.projectId, item.categoryId]),
      app?.projects.map((item) => [item.id, item.name]),
      app?.categories.map((item) => [item.id, item.name]),
      app?.groups.map((item) => [item.id, item.title]),
    ]);
  });
  watch(query, () => {
    generation++;
    controller?.abort();
    if (!query.value.trim()) {
      matches.value = null;
      pending.value = false;
    }
  });
  watch(
    [settled, searchableState],
    async (_value, _old, cleanup) => {
      controller?.abort();
      const active = new AbortController();
      controller = active;
      cleanup(() => active.abort());
      const run = ++generation;
      if (!query.value.trim() || !settled.value.trim()) {
        matches.value = null;
        pending.value = false;
        return;
      }
      if (query.value !== settled.value) {
        pending.value = true;
        return;
      }
      pending.value = matches.value === null || completedQuery !== settled.value;
      try {
        const found = await searchTabIds(records(), context() || {}, settled.value, {
          signal: active.signal,
        });
        if (run === generation) {
          // Reindexing changed data must not reset consumers when membership is unchanged.
          if (
            !matches.value ||
            matches.value.size !== found.size ||
            [...found].some((id) => !matches.value!.has(id))
          )
            matches.value = found;
          completedQuery = settled.value;
        }
      } catch (error) {
        if (!active.signal.aborted) throw error;
      } finally {
        if (run === generation) pending.value = false;
      }
    },
    { immediate: true },
  );
  return {
    matches,
    searching: computed(
      () => Boolean(query.value.trim()) && (pending.value || query.value !== settled.value),
    ),
  };
}
