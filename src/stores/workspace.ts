import { defineStore } from 'pinia';
import { ref, computed, watch } from 'vue';
import { useEventListener, useStorage } from '@vueuse/core';
import {
  emptyTabFilters,
  readTabFilters,
  writeTabFilters,
  type TabFilters,
} from '../shared/tabs/tab-filters';
import { rpc, type RpcMap } from '../shared/rpc';
import { backupTextChunk, MAX_BACKUP_CHARACTERS } from '../shared/backup/backup-transfer';
import { reuseWorkspaceState } from '../shared/utils/state-equality';
import { tabTreeRows } from '../shared/tabs/tab-tree';
import { useTabSearch } from '../features/tabs/useTabSearch';
import { workspaceRows } from '../shared/workspace/workspace-navigation';
import {
  errorMessage,
  type AppState,
  type PlanAction,
  type Plan,
  type TabRecord,
  type CalendarEvent,
  type Settings,
} from '../shared/types';

export const useWorkspace = defineStore('workspace', () => {
  const settingsDraft = ref<Settings>();
  const suppressTabClicksUntil = ref(0);
  const semanticTabOrder = useStorage<Record<string, string[]>>(
    'tabflow.workspace.semanticOrder',
    {},
  );
  const browserWindow = typeof window === 'undefined' ? undefined : window;
  const app = ref<AppState>(),
    loading = ref(false),
    loadError = ref(''),
    notice = ref(''),
    notification = ref<{ sequence: number; message: string; error: boolean }>(),
    search = ref(''),
    filters = ref(readTabFilters(new URLSearchParams(browserWindow?.location.search || '')));
  const projectFilter = computed({
    get: () => filters.value.projectId || null,
    set: (id: string | null) => {
      filters.value.projectId = id || '';
      filters.value.categoryId = '';
    },
  });
  const savedViews = useStorage<
    Array<{ id: string; name: string; filters: TabFilters; search: string }>
  >('tabflow.savedTabViews', []);
  const projectSection = useStorage('tabflow.projects.section', 'tabs');
  const projectSort = useStorage<'manual' | 'name' | 'recent' | 'count'>(
    'tabflow.projects.sort',
    'manual',
  );
  const projectOrder = useStorage<string[]>('tabflow.projects.order', []);
  const activeProject = computed(
    () =>
      app.value?.projects.find((project) => project.id === projectFilter.value) ||
      app.value?.projects[0],
  );
  const orderedProjects = computed(() => {
    const order = new Map(projectOrder.value.map((id, index) => [id, index]));
    const counts = new Map<string, number>();
    const memberships = new Map(
      (app.value?.memberships || []).map((item) => [item.recordId, item]),
    );
    for (const record of app.value?.records || []) {
      if (!record.live) continue;
      const membership = memberships.get(record.id);
      const id = membership ? membership.projectId : record.projectId;
      if (id) counts.set(id, (counts.get(id) || 0) + 1);
    }
    return [...(app.value?.projects || [])].sort((a, b) =>
      projectSort.value === 'name'
        ? a.name.localeCompare(b.name)
        : projectSort.value === 'recent'
          ? b.updatedAt - a.updatedAt
          : projectSort.value === 'count'
            ? (counts.get(b.id) || 0) - (counts.get(a.id) || 0)
            : (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
              (order.get(b.id) ?? Number.MAX_SAFE_INTEGER),
    );
  });
  function reorderProjects(ids: string[]) {
    const current = app.value?.projects || [];
    if (
      new Set(ids).size !== ids.length ||
      ids.length !== current.length ||
      current.some((item) => !ids.includes(item.id))
    )
      throw new Error('Reorder the complete project list. Clear search and filters first.');
    projectOrder.value = [...ids];
    projectSort.value = 'manual';
  }
  function moveProject(id: string, direction: -1 | 1) {
    const ids = orderedProjects.value.map((item) => item.id);
    const index = ids.indexOf(id),
      to = index + direction;
    if (index < 0 || to < 0 || to >= ids.length) return;
    ids.splice(index, 1);
    ids.splice(to, 0, id);
    projectOrder.value = ids;
    projectSort.value = 'manual';
  }

  const assistantContext = ref<{ recordIds: string[] }>();
  const revealRequest = ref<{ id: string }>();
  function revealTab(id: string) {
    search.value = '';
    clearFilters();
    revealRequest.value = { id };
    show('tabs');
  }
  function askAssistant(recordIds: string[]) {
    assistantContext.value = {
      recordIds: [...new Set(recordIds)].filter((id) =>
        records.value.some((item) => item.id === id && item.live),
      ),
    };
  }
  search.value = new URLSearchParams(browserWindow?.location.search || '').get('q') || '';
  watch(
    [filters, search],
    () => {
      if (!browserWindow) return;
      const url = new URL(browserWindow.location.href);
      url.search = writeTabFilters(url.searchParams, filters.value).toString();
      if (search.value) url.searchParams.set('q', search.value);
      else url.searchParams.delete('q');
      browserWindow.history.replaceState(null, '', url);
    },
    { deep: true },
  );
  useEventListener(browserWindow, 'popstate', () => {
    filters.value = readTabFilters(new URLSearchParams(browserWindow?.location.search || ''));
    search.value = new URLSearchParams(browserWindow?.location.search || '').get('q') || '';
  });
  function clearFilters() {
    filters.value = emptyTabFilters();
  }
  function filterTag(tag: string) {
    filters.value = { ...filters.value, tags: [tag], untagged: false };
  }
  const hasFilters = computed(() =>
    Boolean(
      filters.value.tags.length ||
      filters.value.untagged ||
      filters.value.projectId ||
      filters.value.categoryId ||
      filters.value.groupId ||
      filters.value.windowId,
    ),
  );
  const draggingTabs = ref(false);
  const tabTreeMode = useStorage('tabflow.tabs.treeMode', true);
  const collapsedBranches = useStorage<string[]>('tabflow.tabs.collapsedBranches', []);
  function toggleBranch(id: string) {
    collapsedBranches.value = collapsedBranches.value.includes(id)
      ? collapsedBranches.value.filter((item) => item !== id)
      : [...collapsedBranches.value, id];
  }
  function treeRows(rows: readonly TabRecord[], expanded = false) {
    return tabTreeMode.value
      ? tabTreeRows(
          rows,
          collapsedBranches.value,
          expanded || Boolean(search.value.trim()) || hasFilters.value,
        )
      : rows.map((record) => ({ record, depth: 0, childCount: 0 }));
  }
  useEventListener('pointerup', () => {
    draggingTabs.value = false;
  });
  useEventListener('pointercancel', () => {
    draggingTabs.value = false;
  });
  useEventListener('blur', () => {
    draggingTabs.value = false;
  });
  const selected = ref(new Set<string>()),
    collapsedUngrouped = ref(new Set<number>()),
    collapsedWindows = ref(new Set<number>()),
    sort = ref('position'),
    view = ref('assistant'),
    pendingPlan = ref<Plan | null>(null);
  const calendarEvents = ref<CalendarEvent[]>([]),
    calendarAccessToken = ref(''),
    calendarTokenExpiresAt = ref(0),
    calendarFetchedAt = ref<number | null>(null);
  const records = computed(() => app.value?.records || []);
  const tagVocabulary = computed(
    () =>
      app.value?.tagVocabulary ||
      [...new Set(records.value.flatMap((record) => record.tags))].sort(),
  );
  const { matches: searchMatches, searching } = useTabSearch(
    search,
    () => records.value,
    () => app.value,
  );
  const visible = computed(() =>
    workspaceRows(
      records.value,
      app.value?.memberships || [],
      projectFilter.value ? { kind: 'project', projectId: projectFilter.value } : { kind: 'all' },
      '',
      filters.value,
      app.value,
    ).filter((record) => !searchMatches.value || searchMatches.value.has(record.id)),
  );
  function notify(message: string, error = false) {
    notice.value = message;
    notification.value = { sequence: (notification.value?.sequence || 0) + 1, message, error };
  }
  async function run<T>(task: () => Promise<T>): Promise<T | undefined> {
    try {
      return await task();
    } catch (e) {
      notify(errorMessage(e), true);
      console.error(e);
      return undefined;
    }
  }
  let refreshing: Promise<void> | undefined;
  function refresh(): Promise<void> {
    if (refreshing) return refreshing;
    refreshing = loadState().finally(() => {
      refreshing = undefined;
    });
    return refreshing;
  }
  async function loadState() {
    // Background refresh keeps an already usable workspace interactive.
    loading.value = !app.value;
    loadError.value = '';
    try {
      const incoming = await rpc('state', undefined);
      app.value = reuseWorkspaceState(app.value, incoming);
      const liveIds = new Set(incoming.records.map((record) => record.id));
      const retainedSelection = [...selected.value].filter((id) => liveIds.has(id));
      if (retainedSelection.length !== selected.value.size)
        selected.value = new Set(retainedSelection);
    } catch (error) {
      loadError.value = errorMessage(error);
      throw error;
    } finally {
      loading.value = false;
    }
  }
  function ordered(rows: TabRecord[]) {
    return [...rows].sort((a, b) =>
      sort.value === 'recent'
        ? b.lastAccessed - a.lastAccessed
        : sort.value === 'old'
          ? a.lastAccessed - b.lastAccessed
          : sort.value === 'frequent'
            ? b.activations - a.activations
            : sort.value === 'focus'
              ? b.focusedMs - a.focusedMs
              : a.index - b.index,
    );
  }
  function toggle(id: string) {
    const copy = new Set(selected.value);
    if (copy.has(id)) copy.delete(id);
    else copy.add(id);
    selected.value = copy;
  }
  function select(ids: string[]) {
    const allSelected = ids.length > 0 && ids.every((id) => selected.value.has(id));
    selected.value = new Set(
      allSelected
        ? [...selected.value].filter((id) => !ids.includes(id))
        : [...selected.value, ...ids],
    );
  }
  function toggleWindow(windowId: number) {
    const next = new Set(collapsedWindows.value);
    if (next.has(windowId)) next.delete(windowId);
    else next.add(windowId);
    collapsedWindows.value = next;
  }
  function toggleUngrouped(windowId: number) {
    const next = new Set(collapsedUngrouped.value);
    if (next.has(windowId)) next.delete(windowId);
    else next.add(windowId);
    collapsedUngrouped.value = next;
  }
  function toggleAllWindows(windowIds: number[]) {
    const collapse = windowIds.some((id) => !collapsedWindows.value.has(id));
    collapsedWindows.value = new Set(
      collapse
        ? [...collapsedWindows.value, ...windowIds]
        : [...collapsedWindows.value].filter((id) => !windowIds.includes(id)),
    );
  }
  function selection() {
    if (!selected.value.size) throw new Error('Select some tabs first.');
    return [...selected.value];
  }
  async function apply(actions: PlanAction[], summary: string) {
    const expected = Object.fromEntries(
      actions
        .flatMap((a) => a.recordIds)
        .map((id) => {
          const r = records.value.find((r) => r.id === id);
          if (!r) throw new Error('Tab no longer open');
          return [
            id,
            {
              url: r.url,
              navigationVersion: r.navigationVersion,
              windowId: r.windowId,
              groupId: r.groupId,
            },
          ];
        }),
    );
    const result = await rpc('apply', { summary, actions, expected });
    const failed = result.results.find((r) => !r.ok);
    const skipped = result.results.flatMap((r) => r.outcomes || []).filter((r) => r.skipped);
    notify(
      (result.queued && result.status === 'running'
        ? `${summary} queued. Progress and pause controls are shown in the workspace.`
        : failed?.error) ||
        `${summary}${skipped.length ? ` · ${skipped.length} skipped (${skipped[0]?.skipped})` : ' · undo available'}`,
    );
    await refresh();
    return result;
  }
  async function requestInspectionAccess(ids: string[]) {
    if (!ids.length) throw new Error('No eligible tabs.');
    const origins = [
      ...new Set(
        ids.map((id) => {
          const record = records.value.find((entry) => entry.id === id);
          if (!record) throw new Error('Inspection target no longer exists.');
          return `${new URL(record.url).origin}/*`;
        }),
      ),
    ];
    if (
      !(await chrome.permissions.contains({ origins })) &&
      !(await chrome.permissions.request({ origins }))
    )
      throw new Error('Page inspection permission was declined.');
  }
  async function inspect(ids: string[], expected?: Plan['expected']) {
    await requestInspectionAccess(ids);
    const j = await rpc('inspect', { ids, expected });
    notify(`Inspection queued for ${j.items.length} tabs`);
    await rpc('tick', undefined);
    await refresh();
    return j;
  }
  const backupBusy = ref(false);
  const backupProgress = ref('');
  async function exportBackup() {
    if (backupBusy.value) return;
    backupBusy.value = true;
    let transferId = '';
    try {
      await rpc('snapshot', { label: 'Export checkpoint' });
      const transfer = await rpc('backupExportStart', undefined);
      transferId = transfer.id;
      const parts: string[] = [];
      let offset: number | null = 0;
      while (offset !== null) {
        backupProgress.value = `Preparing backup · ${Math.floor((offset / transfer.length) * 100)}%`;
        const chunk: RpcMap['backupExportRead']['response'] = await rpc('backupExportRead', {
          id: transfer.id,
          offset,
        });
        if (!chunk.text.length || (chunk.nextOffset !== null && chunk.nextOffset <= offset))
          throw new Error('Backup transfer did not advance. Retry export.');
        parts.push(chunk.text);
        offset = chunk.nextOffset;
      }
      const url = URL.createObjectURL(new Blob(parts, { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `tabflow-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      notify('Backup exported');
      await refresh();
    } finally {
      if (transferId) await rpc('backupTransferRelease', { id: transferId }).catch(() => undefined);
      backupBusy.value = false;
      backupProgress.value = '';
    }
  }
  async function importBackupFile(file: File) {
    if (backupBusy.value) throw new Error('Wait for the current backup transfer to finish.');
    backupBusy.value = true;
    let transferId = '';
    try {
      backupProgress.value = 'Reading backup…';
      const text = await file.text();
      if (!text.length || text.length > MAX_BACKUP_CHARACTERS)
        throw new Error('Backup is empty or exceeds the safe in-memory import size.');
      const transfer = await rpc('backupImportStart', { length: text.length });
      transferId = transfer.id;
      let offset = 0;
      while (offset < text.length) {
        const chunk = backupTextChunk(text, offset);
        const result = await rpc('backupImportWrite', {
          id: transfer.id,
          offset,
          text: chunk.text,
        });
        if (result.nextOffset !== offset + chunk.text.length)
          throw new Error('Backup upload did not advance correctly. Retry import.');
        offset = result.nextOffset;
        backupProgress.value = `Uploading backup · ${Math.floor((offset / text.length) * 100)}%`;
      }
      backupProgress.value = 'Validating and importing backup…';
      const result = await rpc('backupImportCommit', { id: transfer.id });
      await refresh();
      return result;
    } finally {
      if (transferId) await rpc('backupTransferRelease', { id: transferId }).catch(() => undefined);
      backupBusy.value = false;
      backupProgress.value = '';
    }
  }
  function show(name: string) {
    view.value = name;
    location.hash = name;
  }
  return {
    settingsDraft,
    suppressTabClicksUntil,
    semanticTabOrder,
    tabTreeMode,
    collapsedBranches,
    toggleBranch,
    treeRows,
    revealRequest,
    revealTab,
    backupBusy,
    backupProgress,
    importBackupFile,
    draggingTabs,
    app,
    loading,
    loadError,
    notice,
    notification,
    search,
    searchMatches,
    searching,
    projectFilter,
    activeProject,
    projectSection,
    projectSort,
    orderedProjects,
    moveProject,
    reorderProjects,
    assistantContext,
    askAssistant,
    filters,
    hasFilters,
    savedViews,
    clearFilters,
    filterTag,
    selected,
    collapsedWindows,
    collapsedUngrouped,
    sort,
    view,
    pendingPlan,
    calendarEvents,
    calendarAccessToken,
    calendarTokenExpiresAt,
    calendarFetchedAt,
    records,
    tagVocabulary,
    visible,
    notify,
    run,
    refresh,
    ordered,
    toggle,
    select,
    toggleWindow,
    toggleUngrouped,
    toggleAllWindows,
    selection,
    apply,
    inspect,
    requestInspectionAccess,
    exportBackup,
    show,
  };
});
