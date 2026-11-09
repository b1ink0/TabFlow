<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { VueDraggable, type DraggableEvent } from 'vue-draggable-plus';
import { useDebounceFn, useStorage } from '@vueuse/core';
import { PhDotsThree as Ellipsis, PhSparkle as Sparkles } from '@phosphor-icons/vue';
import UTabs from '@nuxt/ui/components/Tabs.vue';
import UDropdownMenu from '@nuxt/ui/components/DropdownMenu.vue';
import UiLoadMore from '../../ui/UiLoadMore.vue';
import UiScrollArea from '../../ui/UiScrollArea.vue';
import UiReorderList from '../../ui/UiReorderList.vue';
import UiBranchGuides from '../../ui/UiBranchGuides.vue';
import UiButton from '../../ui/UiButton.vue';
import CategoryActions from '../projects/CategoryActions.vue';
import ProjectActions from '../projects/ProjectActions.vue';
import ExternalClassificationDialog from '../projects/ExternalClassificationDialog.vue';
import UiSearchInput from '../../ui/UiSearchInput.vue';
import UiToggle from '../../ui/UiToggle.vue';
import UiDisclosure from '../../ui/UiDisclosure.vue';
import WorkspaceTabRow from './WorkspaceTabRow.vue';
import { useTabTreeDrag } from './useTabTreeDrag';
import { useTabListMotion } from './useTabListMotion';
import { useReorderGesture, droppedOrder, type ReorderEvent } from '../workspace/useReorderGesture';
import { orderTabTreeDrop } from '../../shared/tabs/tab-tree-drop';
import { tabAncestors } from '../../shared/tabs/tab-tree';
import TabFilterControls from './TabFilterControls.vue';
import { useWorkspace } from '../../stores/workspace';
import { useDialog } from '../../stores/dialog';
import { workspaceEditBaseline } from '../../shared/workspace/workspace-edits';
import { rpc } from '../../shared/rpc';
import { COLORS } from '../../shared/model';
import {
  categoryColor,
  categoryColorStyle,
  projectColorStyle,
} from '../../shared/tabs/category-colors';
import { workspaceRows, type WorkspaceScope } from '../../shared/workspace/workspace-navigation';
import type { Category, Project, TabRecord, PlanAction } from '../../shared/types';

const emit = defineEmits<{ createProject: []; ai: [ids: string[]] }>();
const store = useWorkspace();
const listMotion = useTabListMotion();
const reorderGesture = useReorderGesture();
const dialog = useDialog();
const externalDialog = ref<InstanceType<typeof ExternalClassificationDialog>>();
const selectedExternalDialog = ref<InstanceType<typeof ExternalClassificationDialog>>();
const currentWindowId = ref<number>();
const scope = ref<WorkspaceScope>({ kind: 'all' });
const projectMode = ref(true);
const projectLayout = useStorage<'tree' | 'tabs'>('tabflow.workspace.projectLayout', 'tree');
const activeProjectId = useStorage('tabflow.workspace.activeProject', '');
const search = computed({
  get: () => store.search,
  set: (value: string) => {
    store.search = value;
  },
});
const tag = computed(
  () =>
    store.filters.tags.length ||
    store.filters.untagged ||
    store.filters.projectId ||
    store.filters.categoryId ||
    store.filters.windowId,
);
const groupFilter = computed(() => store.filters.groupId);
const filterContext = computed(() => ({
  ...store.app,
  groupId: groupFilter.value ? Number(groupFilter.value) : undefined,
}));
const shown = ref(35);
const openProjects = useStorage<string[]>('tabflow.workspace.openProjects', []);
const closedCategories = useStorage<string[]>('tabflow.workspace.closedCategories', []);
const followActiveTab = useStorage('tabflow.workspace.followActiveTab', true);
const limits = ref<Record<string, number>>({});
const navigator = ref<HTMLElement>();
const scopeContent = ref<HTMLElement>();
watch([scope, projectMode, activeProjectId, projectLayout], async () => {
  if (store.draggingTabs || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  await nextTick();
  const content = scopeContent.value;
  if (!content) return;
  for (const animation of content.getAnimations()) animation.cancel();
  content.animate([{ opacity: 0.45 }, { opacity: 1 }], { duration: 140, easing: 'ease-out' });
});
const selecting = ref(false);
const dragging = computed({
  get: () => store.draggingTabs,
  set: (value: boolean) => {
    store.draggingTabs = value;
  },
});
const selected = ref(new Set<string>());
const savedOrder = computed({
  get: () => store.semanticTabOrder,
  set: (value) => {
    store.semanticTabOrder = value;
  },
});
const treeDrag = useTabTreeDrag((_sourceId, targetId, position, movedIds, sectionId) => {
  const section = projectViews.value
    .flatMap((view) => view.sections)
    .find((item) => item.id === sectionId || item.records.some((record) => record.id === targetId));
  const key = projectMode.value && section ? section.id : 'workspace:all';
  const ordered = !targetId
    ? movedIds
    : orderTabTreeDrop(
        projectMode.value && section
          ? section.treeRows.map((entry) => entry.record)
          : store.treeRows(rows.value).map((entry) => entry.record),
        movedIds,
        targetId,
        position,
      );
  const moved = new Set(movedIds);
  savedOrder.value = Object.fromEntries(
    Object.entries(savedOrder.value).map(([id, ids]) => [
      id,
      ids.filter((item) => !moved.has(item)),
    ]),
  );
  savedOrder.value = { ...savedOrder.value, [key]: ordered };
});
const selection = computed(() => store.records.filter((record) => selected.value.has(record.id)));
watch(
  () => store.records,
  (records) => {
    const live = new Set(records.map((record) => record.id));
    selected.value = new Set([...selected.value].filter((id) => live.has(id)));
  },
);
function toggleSelection(id: string) {
  selecting.value = true;
  const next = new Set(selected.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selected.value = next;
}
function semanticOrder(id: string, records: TabRecord[]) {
  const order = new Map((savedOrder.value[id] || []).map((recordId, index) => [recordId, index]));
  return [...records].sort(
    (a, b) =>
      (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.id) ?? Number.MAX_SAFE_INTEGER),
  );
}
function targets(record: TabRecord) {
  return selected.value.has(record.id) ? selection.value : [record];
}
function reorderSemantic(record: TabRecord, direction: -1 | 1) {
  if (record.locked || search.value || tag.value || groupFilter.value) {
    store.notify('Clear filters and remove protection before changing TabFlow order.');
    return;
  }
  const section = projectViews.value
    .flatMap((view) => view.sections)
    .find((item) => item.records.some((row) => row.id === record.id));
  if (!section) return;
  const ids = section.records.map((item) => item.id);
  const from = ids.indexOf(record.id);
  const to = from + direction;
  if (to < 0 || to >= ids.length) return;
  ids.splice(from, 1);
  ids.splice(to, 0, record.id);
  savedOrder.value = { ...savedOrder.value, [section.id]: ids };
}
async function saveAssignment(
  records: TabRecord[],
  projectId: string | null,
  categoryId: string | null,
) {
  if (!records.length) throw new Error('No open tabs selected.');
  if (records.some((record) => record.locked))
    throw new Error('Remove protection before reassigning a protected tab.');
  await rpc('assignMembership', {
    recordIds: records.map((record) => record.id),
    projectId,
    categoryId,
    expected: Object.fromEntries(
      records.map((record) => [
        record.id,
        { url: record.url, navigationVersion: record.navigationVersion },
      ]),
    ),
  });
  await store.refresh();
}
async function dropped(event: DraggableEvent) {
  if (await treeDrag.end(event)) return;
  dragging.value = false;
  const id = event.item.dataset.workspaceRecordId;
  const record = store.records.find((item) => item.id === id);
  const projectId = event.to.dataset.projectId;
  if (!record || !projectId) return;
  await store.run(async () => {
    if (event.from !== event.to) {
      const moved = targets(record);
      await saveAssignment(moved, projectId, event.to.dataset.categoryId || null);
      const sectionId = event.to.dataset.sectionId;
      const destination = projectViews.value
        .flatMap((view) => view.sections)
        .find((section) => section.id === sectionId);
      if (sectionId && destination) {
        const movedIds = moved.map((item) => item.id);
        const order = destination.records
          .map((item) => item.id)
          .filter((id) => !movedIds.includes(id));
        const index = Math.max(0, Math.min(event.newDraggableIndex ?? 0, order.length));
        order.splice(index, 0, ...movedIds);
        savedOrder.value = { ...savedOrder.value, [sectionId]: order };
        limits.value[sectionId] = Math.max(limits.value[sectionId] || 8, index + 1);
      }
      store.notify('Assigned in TabFlow. Native windows and groups are unchanged.');
    } else {
      if (search.value || tag.value)
        throw new Error('Clear filters before changing project order.');
      const sectionId = event.to.dataset.sectionId;
      if (!sectionId) return;
      const full =
        projectViews.value
          .flatMap((view) => view.sections)
          .find((section) => section.id === sectionId)?.records || [];
      const visible = full.map((item) => item.id);
      const from = visible.indexOf(record.id);
      const to = event.newDraggableIndex;
      if (from < 0 || to === undefined || to < 0 || to >= visible.length) return;
      visible.splice(from, 1);
      visible.splice(to, 0, record.id);
      savedOrder.value = {
        ...savedOrder.value,
        [sectionId]: [
          ...visible,
          ...full.map((item) => item.id).filter((item) => !visible.includes(item)),
        ],
      };
      store.notify('TabFlow order saved. Native tab order is unchanged.');
    }
  });
  // Recreate the controlled lists after Sortable's temporary DOM move, including failed assignments.
  dragRevision.value += 1;
}
async function workspaceDropped(event: DraggableEvent) {
  if (await treeDrag.end(event)) return;
  const id = event.item.dataset.workspaceRecordId;
  const ids = rows.value.map((record) => record.id);
  const from = id ? ids.indexOf(id) : -1;
  const to = event.newDraggableIndex;
  if (from < 0 || to === undefined || to < 0 || to >= ids.length) return;
  ids.splice(from, 1);
  ids.splice(to, 0, id!);
  savedOrder.value = { ...savedOrder.value, 'workspace:all': ids };
}
const dragRevision = ref(0);
const categoryChange = ref(''),
  categoryUndone = ref(false);
async function restoreCategoryChange() {
  await store.run(async () => {
    const result = await rpc(categoryUndone.value ? 'redoAssistantChange' : 'undoAssistantChange', {
      id: categoryChange.value,
    });
    categoryUndone.value = result.status === 'undone';
    store.notify(result.outcome);
    await store.refresh();
  });
}
async function revealCurrent(automatic = false, recordId?: string) {
  if (automatic && (store.search || store.hasFilters || selecting.value || dialog.current)) return;
  const record = store.records.find((item) =>
    recordId ? item.id === recordId : item.active && item.windowId === currentWindowId.value,
  );
  if (!record) {
    store.notify('No active tab is available in this window.');
    return;
  }
  const ancestors = new Set(tabAncestors(record.id, store.records));
  store.collapsedBranches = store.collapsedBranches.filter((id) => !ancestors.has(id));
  search.value = '';
  store.clearFilters();
  const member = memberMap.value.get(record.id);
  if (member?.projectId) {
    projectMode.value = true;
    openProjects.value = [...new Set([...openProjects.value, member.projectId])];
    activeProjectId.value = member.projectId;
    await nextTick();
    const section = projectViews.value
      .find((view) => view.project.id === member.projectId)
      ?.sections.find((item) => item.records.some((row) => row.id === record.id));
    if (section) {
      closedCategories.value = closedCategories.value.filter((id) => id !== section.id);
      limits.value[section.id] = Math.max(
        limits.value[section.id] || 8,
        section.records.findIndex((item) => item.id === record.id) + 1,
      );
    }
  } else {
    if (record.windowId === undefined) {
      store.notify('This tab no longer has a browser window. Refresh the workspace.');
      return;
    }
    chooseScope({ kind: 'window', windowId: record.windowId });
    await nextTick();
    shown.value = Math.max(35, rows.value.findIndex((item) => item.id === record.id) + 1);
  }
  await nextTick();
  const element = [
    ...(navigator.value?.querySelectorAll<HTMLElement>('[data-workspace-record-id]') || []),
  ].find((item) => item.dataset.workspaceRecordId === record.id);
  const scroller =
    navigator.value?.closest('[data-reka-scroll-area-viewport]') ||
    navigator.value?.closest('main');
  if (element && scroller) {
    const toolbarHeight =
      navigator.value?.querySelector<HTMLElement>('[data-workspace-tools]')?.offsetHeight || 0;
    scroller.scrollTop +=
      element.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top -
      (scroller.clientHeight + toolbarHeight - element.offsetHeight) / 2;
  }
  if (!automatic)
    element
      ?.querySelector<HTMLButtonElement>('button[aria-current="page"]')
      ?.focus({ preventScroll: true });
}
watch(
  () => store.revealRequest,
  (request) => {
    if (request) void store.run(() => revealCurrent(false, request.id));
  },
);
async function nativeCommand(
  record: TabRecord,
  command: 'move' | 'group' | 'reorder' | 'pin' | 'mute' | 'ungroup',
) {
  const records = targets(record);
  const action: PlanAction = { type: command, recordIds: records.map((item) => item.id) };
  if (command === 'pin' || command === 'mute')
    action.enabled = !(command === 'pin' ? record.pinned : record.muted);
  if (command === 'move' || command === 'group') {
    const values = await dialog.ask(
      command === 'move' ? 'Move to browser window' : 'Put in native group',
      [
        {
          name: 'window',
          label: 'Browser window',
          value: String(record.windowId),
          options: (store.app?.windows || []).map((window, index) => ({
            label: `Window ${index + 1}${window.id === currentWindowId.value ? ' · this window' : ''}`,
            value: String(window.id),
          })),
        },
        ...(command === 'group'
          ? [
              { name: 'name', label: 'Native group name' },
              {
                name: 'color',
                label: 'Native group color',
                value: 'grey',
                options: COLORS.map((color) => ({ label: color, value: color })),
              },
            ]
          : []),
      ],
      'This changes actual browser placement. TabFlow project membership stays unchanged.',
    );
    if (!values) return;
    action.windowId = Number(values.window);
    if (command === 'group') {
      action.name = values.name;
      action.color =
        store.app?.groups.find(
          (group) => group.windowId === action.windowId && group.title === values.name,
        )?.color || COLORS.find((color) => color === values.color);
    }
  }
  if (command === 'reorder') {
    if (records.length !== 1) {
      store.notify('Select one tab to change its native position.');
      return;
    }
    const values = await dialog.ask('Change native tab position', [
      {
        name: 'position',
        label: 'Position in browser window (starts at 1)',
        value: String(record.index + 1),
      },
    ]);
    if (!values) return;
    action.index = Number(values.position) - 1;
  }
  await store.run(() => store.apply([action], `Browser ${command} · ${records.length} tabs`));
}
const batchActions = computed(() => [
  {
    label: 'Classify selected tabs externally',
    onSelect: () => selectedExternalDialog.value?.show(),
  },
  {
    label: 'Assign project or category',
    onSelect: () => selection.value[0] && assign(selection.value[0]),
  },
  { label: 'Move to Inbox', onSelect: () => selection.value[0] && moveToInbox(selection.value[0]) },
  ...(['move', 'group', 'ungroup', 'reorder', 'pin', 'mute'] as const).map((command) => ({
    label:
      command === 'move'
        ? 'Move to browser window…'
        : command === 'group'
          ? 'Put in native group…'
          : command === 'reorder'
            ? 'Change native position…'
            : command === 'ungroup'
              ? 'Remove native group'
              : command === 'pin'
                ? selection.value[0]?.pinned
                  ? 'Unpin selected tabs'
                  : 'Pin selected tabs'
                : selection.value[0]?.muted
                  ? 'Unmute selected tabs'
                  : 'Mute selected tabs',
    onSelect: () => selection.value[0] && nativeCommand(selection.value[0], command),
  })),
  ...(['suspend', 'wake'] as const).map((type) => ({
    label: type === 'wake' ? 'Wake selected tabs' : 'Suspend selected tabs',
    onSelect: () =>
      store.run(() =>
        store.apply(
          [{ type, recordIds: selection.value.map((record) => record.id) }],
          `${type} selected tabs`,
        ),
      ),
  })),
]);
const memberships = computed(() => store.app?.memberships || []);
const memberMap = computed(() => new Map(memberships.value.map((item) => [item.recordId, item])));
const projects = computed(() => store.orderedProjects);
const refreshActivation = useDebounceFn((info: chrome.tabs.OnActivatedInfo) => {
  if (!document.hidden)
    void store.run(async () => {
      await store.refresh();
      if (followActiveTab.value && info.windowId === currentWindowId.value)
        await revealCurrent(true);
    });
}, 120);
onUnmounted(() => chrome.tabs?.onActivated?.removeListener(refreshActivation));
const rows = computed(() =>
  semanticOrder(
    'workspace:all',
    workspaceRows(
      store.records,
      memberships.value,
      scope.value,
      '',
      store.filters,
      filterContext.value,
    ).filter((record) => !store.searchMatches || store.searchMatches.has(record.id)),
  ),
);
const inboxCount = computed(
  () => workspaceRows(store.records, memberships.value, { kind: 'inbox' }).length,
);
const projectViews = computed(() =>
  projects.value
    .map((project) => {
      const records = workspaceRows(
        store.records,
        memberships.value,
        { kind: 'project', projectId: project.id },
        '',
        store.filters,
        filterContext.value,
      ).filter((record) => !store.searchMatches || store.searchMatches.has(record.id));
      const categories = (store.app?.categories || [])
        .filter((category) => category.projectId === project.id)
        .sort((a, b) => a.order - b.order);
      const known = new Set(categories.map((category) => category.id));
      const sections: {
        id: string;
        name: string;
        category?: Category;
        color: string;
        records: TabRecord[];
      }[] = categories.map((category) => ({
        id: category.id,
        name: category.name,
        category,
        color: categoryColorStyle(category),
        records: semanticOrder(
          category.id,
          records.filter((record) => memberMap.value.get(record.id)?.categoryId === category.id),
        ),
      }));
      const uncategorized = records.filter(
        (record) => !known.has(memberMap.value.get(record.id)?.categoryId || ''),
      );
      sections.push({
        id: `${project.id}:none`,
        name: 'No category',
        color: categoryColorStyle({ color: 'grey', order: 0 }),
        records: semanticOrder(`${project.id}:none`, uncategorized),
      });
      return {
        project,
        records,
        sections: sections
          .map((section) => ({ ...section, treeRows: store.treeRows(section.records) }))
          .filter(
            (section) =>
              section.records.length || (!search.value && !tag.value && !groupFilter.value),
          ),
      };
    })
    .filter((view) => view.records.length || (!search.value && !tag.value && !groupFilter.value)),
);
async function categoriesDropped(event: ReorderEvent, project: Project) {
  reorderGesture.finish();
  const current = (store.app?.categories || [])
    .filter((item) => item.projectId === project.id)
    .sort((a, b) => a.order - b.order)
    .map((item) => item.id);
  const ids = droppedOrder(
    event,
    current,
    '[data-category-order-id]',
    'categoryOrderId',
    '.category-reorder-trigger',
  );
  if (ids.every((id, index) => id === current[index])) return;
  await store.run(async () => {
    if (!store.app) return;
    const edit = { kind: 'category_order' as const, projectId: project.id, categoryIds: ids };
    const change = await rpc('executeWorkspaceEdit', {
      kind: 'workspace_edits',
      summary: `Reorder categories in ${project.name}`,
      edits: [{ edit, before: workspaceEditBaseline(store.app, edit) }],
    });
    categoryChange.value = change.id;
    categoryUndone.value = false;
    await store.refresh();
  });
}
function projectsDropped(event: ReorderEvent) {
  reorderGesture.finish();
  const ids = droppedOrder(
    event,
    renderedProjects.value.map((view) => view.project.id),
    '[data-project-order-id]',
    'projectOrderId',
    '.project-reorder-trigger',
  );
  store.reorderProjects(ids);
}
function projectTabsDropped(event: DraggableEvent) {
  reorderGesture.finish();
  const selectedProject = chosenProjectId.value;
  const current = projectViews.value.map((view) => view.project.id);
  const ids = droppedOrder(event, current, '[role=tab]', 'projectOrderId', undefined, true);
  store.reorderProjects(ids);
  activeProjectId.value = selectedProject;
}
function startProjectTabsDrag(event: DraggableEvent) {
  for (const [index, tab] of [...event.from.querySelectorAll<HTMLElement>('[role=tab]')].entries())
    tab.dataset.projectOrderId = projectViews.value[index]?.project.id;
  reorderGesture.start(event);
}
const chosenProjectId = computed({
  get: () =>
    projectViews.value.some((view) => view.project.id === activeProjectId.value)
      ? activeProjectId.value
      : projectViews.value[0]?.project.id || '',
  set: (value: string) => {
    activeProjectId.value = value;
  },
});
const renderedProjects = computed(() =>
  projectLayout.value === 'tabs'
    ? projectViews.value.filter((view) => view.project.id === chosenProjectId.value)
    : projectViews.value,
);
watch(
  [scope, search, () => store.filters],
  () => {
    shown.value = 35;
    limits.value = {};
  },
  { deep: true },
);
onMounted(async () => {
  chrome.tabs?.onActivated?.addListener(refreshActivation);
  try {
    const window = await chrome.windows.getCurrent();
    if (window.id === undefined) throw new Error('Current browser window is unavailable.');
    currentWindowId.value = window.id;
    if (store.hasFilters || store.search) {
      scope.value = { kind: 'all' };
      projectMode.value = false;
    } else scope.value = { kind: 'window', windowId: window.id };
    if (store.revealRequest) await revealCurrent(false, store.revealRequest.id);
  } catch (error) {
    store.notify(error instanceof Error ? error.message : String(error));
  }
});
function chooseScope(value: WorkspaceScope) {
  projectMode.value = false;
  scope.value = value;
  store.filters.windowId = value.kind === 'window' ? String(value.windowId) : '';
  store.filters.projectId = value.kind === 'project' ? value.projectId : '';
  store.filters.categoryId = value.kind === 'project' ? value.categoryId || '' : '';
}
function toggleProject(id: string, open: boolean) {
  openProjects.value = open
    ? [...new Set([...openProjects.value, id])]
    : openProjects.value.filter((value) => value !== id);
}
function revealDropProject(id: string) {
  if (dragging.value && !reorderGesture.active.value && !openProjects.value.includes(id))
    openProjects.value = [...openProjects.value, id];
}

function toggleCategory(id: string, open: boolean) {
  closedCategories.value = open
    ? closedCategories.value.filter((value) => value !== id)
    : [...new Set([...closedCategories.value, id])];
}
async function assign(record: TabRecord) {
  const current = memberMap.value.get(record.id);
  const choice = await dialog.ask(
    'Assign tab to project',
    [
      {
        name: 'projectId',
        label: 'Project',
        value: current?.projectId || projects.value[0]?.id || '',
        create: async (name) => {
          const project = await rpc('project', { name });
          await store.refresh();
          return { label: project.name, value: project.id };
        },
        options: [
          { label: 'Inbox (leave unassigned)', value: '' },
          ...projects.value.map((project) => ({ label: project.name, value: project.id })),
        ],
      },
    ],
    'Choose where this tab belongs in TabFlow.',
    'Continue',
  );
  if (!choice) return;
  if (!choice.projectId) {
    await moveToInbox(record);
    return;
  }
  const categories = (store.app?.categories || []).filter(
    (category) => category.projectId === choice.projectId,
  );
  const next = await dialog.ask(
    'Choose a category',
    [
      {
        name: 'categoryId',
        label: 'Category',
        create: async (name) => {
          const category = await rpc('category', { projectId: choice.projectId!, name });
          await store.refresh();
          return { label: category.name, value: category.id };
        },
        value: current?.projectId === choice.projectId ? current.categoryId || '' : '',
        options: [
          { label: 'No category yet', value: '' },
          ...categories.map((category) => ({ label: category.name, value: category.id })),
        ],
      },
    ],
    'Categories organize the tabs within a project.',
    'Assign tab',
  );
  if (!next) return;
  await store.run(async () => {
    await saveAssignment(targets(record), choice.projectId!, next.categoryId || null);
    openProjects.value = [choice.projectId!];
    store.notify('Tab assigned. Browser placement is unchanged.');
  });
}
async function moveToInbox(record: TabRecord) {
  await store.run(async () => {
    await saveAssignment(targets(record), null, null);
    store.notify('Tab moved to Inbox. AI will preserve your choice.');
  });
}
async function editCategory(project: Project, category?: Category) {
  const choice = await dialog.ask(category ? 'Edit category' : 'Add category', [
    { name: 'name', label: 'Name', value: category?.name || '' },
    {
      name: 'displayColor',
      label: 'Display color',
      value: category?.displayColor || '',
      color: true,
    },
    {
      name: 'description',
      label: 'When does a tab belong here?',
      value: category?.description || '',
    },
    {
      name: 'color',
      label: 'Color',
      value: categoryColor(
        category || {
          order: (store.app?.categories || []).filter((item) => item.projectId === project.id)
            .length,
        },
      ),
      options: COLORS.map((color) => ({
        label: color[0]!.toUpperCase() + color.slice(1),
        value: color,
        color: `var(--category-${color})`,
      })),
    },
  ]);
  if (!choice?.name?.trim()) return;
  const color = COLORS.find((value) => value === choice.color);
  if (!color) return;
  await store.run(async () => {
    await rpc('category', {
      id: category?.id,
      projectId: project.id,
      name: choice.name!,
      description: choice.description || '',
      color,
      displayColor: choice.displayColor || null,
    });
    await store.refresh();
  });
}
async function reviewNewTabs(value: boolean) {
  if (!store.app) return;
  await store.run(async () => {
    await rpc('settings', {
      ...store.app!.settings,
      maintainCollectionReview: value,
      reviewProjectWindowsOnly: false,
    });
    await store.refresh();
  });
}
</script>

<template>
  <div
    ref="navigator"
    class="flex min-w-0 flex-col gap-3 pb-6"
    @click.capture="reorderGesture.click"
  >
    <div
      data-workspace-tools
      data-scroll-fade-header
      class="sticky top-0 z-10 flex min-w-0 flex-col gap-3 bg-canvas pb-2"
    >
      <div class="flex min-w-0 gap-1 rounded-md bg-surface p-1" aria-label="Workspace scope">
        <UiButton
          size="small"
          class="min-w-0 flex-1 px-1 text-xs"
          :variant="projectMode ? 'default' : 'ghost'"
          @click="
            projectMode = true;
            store.filters.windowId = '';
            scope = { kind: 'all' };
          "
          >Projects</UiButton
        >
        <UiButton
          size="small"
          class="min-w-0 flex-1 px-1 text-xs"
          :variant="!projectMode && scope.kind === 'window' ? 'default' : 'ghost'"
          :disabled="currentWindowId === undefined"
          aria-label="This window"
          title="Current browser window"
          @click="chooseScope({ kind: 'window', windowId: currentWindowId! })"
          >Window</UiButton
        >
        <UiButton
          size="small"
          class="min-w-0 flex-1 px-1 text-xs"
          :variant="!projectMode && scope.kind === 'all' ? 'default' : 'ghost'"
          @click="chooseScope({ kind: 'all' })"
          >All tabs</UiButton
        >
        <UiButton
          size="small"
          class="min-w-0 flex-1 px-1 text-xs"
          :variant="!projectMode && scope.kind === 'inbox' ? 'default' : 'ghost'"
          @click="chooseScope({ kind: 'inbox' })"
          >Inbox · {{ inboxCount }}</UiButton
        >
      </div>
      <div class="flex min-w-0 items-center gap-2">
        <UiSearchInput
          v-model="search"
          label="Search tabs"
          placeholder="Find a tab…"
          class="min-w-0 flex-1"
        />
        <TabFilterControls />
        <UDropdownMenu
          :items="[
            {
              label: 'Nested tabs',
              type: 'checkbox',
              checked: store.tabTreeMode,
              onSelect: () => {
                store.tabTreeMode = !store.tabTreeMode;
              },
            },
            { label: 'Reveal current tab', onSelect: () => revealCurrent() },
            {
              label: 'Follow browser tab changes',
              type: 'checkbox',
              checked: followActiveTab,
              onSelect: () => {
                followActiveTab = !followActiveTab;
              },
            },
            {
              label: 'Project layout',
              children: [
                {
                  label: 'Vertical project tree',
                  type: 'checkbox',
                  checked: projectLayout === 'tree',
                  onSelect: () => {
                    projectLayout = 'tree';
                  },
                },
                {
                  label: 'Horizontal project tabs',
                  type: 'checkbox',
                  checked: projectLayout === 'tabs',
                  onSelect: () => {
                    projectLayout = 'tabs';
                  },
                },
              ],
            },
            {
              label: selecting ? 'Done selecting' : 'Select tabs',
              onSelect: () => {
                selecting = !selecting;
                selected = new Set();
              },
            },
            { label: 'Classify this workspace externally', onSelect: () => externalDialog?.show() },
          ]"
          :ui="{ content: 'bg-overlay' }"
          ><UiButton
            size="small"
            variant="ghost"
            title="Tab list actions"
            aria-label="Tab list actions"
            ><Ellipsis class="size-4" /></UiButton
        ></UDropdownMenu>
      </div>
      <span v-if="store.searching" role="status" class="text-xs text-muted">Searching tabs?</span>
    </div>
    <ExternalClassificationDialog
      ref="selectedExternalDialog"
      hide-trigger
      initial-scope="selection"
      :record-ids="[...selected]"
    />
    <ExternalClassificationDialog
      ref="externalDialog"
      hide-trigger
      :initial-scope="
        !projectMode && scope.kind === 'window'
          ? `window:${scope.windowId}`
          : !projectMode && scope.kind === 'project'
            ? `project:${scope.projectId}`
            : !projectMode && scope.kind === 'inbox'
              ? 'selection'
              : 'all'
      "
      :record-ids="rows.map((record) => record.id)"
      label="Classify this workspace externally"
    />
    <UiButton
      v-if="categoryChange"
      size="small"
      variant="ghost"
      class="self-start"
      @click="restoreCategoryChange"
      >{{ categoryUndone ? 'Redo category change' : 'Undo category change' }}</UiButton
    >
    <div ref="scopeContent" data-workspace-scope-content class="flex min-w-0 flex-col gap-3">
      <template v-if="projectMode">
        <div v-if="!projects.length" class="flex flex-col gap-3 py-4 text-[13px] text-muted">
          <p>Create a project or review an AI organization proposal to give your tabs a place.</p>
          <UiButton size="small" class="self-start" @click="chooseScope({ kind: 'inbox' })"
            >Browse Inbox · {{ inboxCount }}</UiButton
          >
        </div>
        <div
          v-if="projectLayout === 'tabs' && projectViews.length"
          class="flex min-w-0 items-center gap-1"
        >
          <UiScrollArea horizontal hide-scrollbar class="min-w-0 flex-1" label="Project tabs">
            <VueDraggable
              :model-value="projectViews"
              target="[role=tablist]"
              draggable="[role=tab]"
              direction="horizontal"
              :delay="200"
              :delay-on-touch-only="true"
              :force-fallback="true"
              :fallback-on-body="true"
              fallback-class="tab-drag-preview"
              ghost-class="tab-drag-placeholder"
              :disabled="Boolean(search || tag || groupFilter)"
              @start="startProjectTabsDrag"
              @end="projectTabsDropped"
            >
              <UTabs
                v-model="chosenProjectId"
                :items="
                  projectViews.map((view) => ({
                    label: `${view.project.name} (${view.records.length})`,
                    value: view.project.id,
                  }))
                "
                :content="false"
                :ui="{
                  root: 'w-max min-w-full',
                  list: 'w-max min-w-full justify-start',
                  trigger: 'shrink-0',
                }"
                aria-label="Workspace projects"
              />
            </VueDraggable>
          </UiScrollArea>
          <ProjectActions
            v-if="renderedProjects[0]"
            :project="renderedProjects[0].project"
            :on-add-category="() => editCategory(renderedProjects[0]!.project)"
          />
        </div>
        <UiReorderList
          draggable="[data-project-order-id]"
          handle=".project-reorder-trigger"
          :disabled="projectLayout !== 'tree' || Boolean(search || tag || groupFilter)"
          class="flex min-w-0 flex-col gap-1"
          aria-label="Projects"
          @start="reorderGesture.start"
          @end="projectsDropped"
          @cancel="reorderGesture.finish"
        >
          <UiDisclosure
            v-for="view in renderedProjects"
            :key="view.project.id"
            :data-project-order-id="view.project.id"
            drag-header
            :label="view.project.name"
            :flat="projectLayout === 'tabs'"
            :count="view.records.length"
            :open="Boolean(search || tag || groupFilter) || openProjects.includes(view.project.id)"
            @update:open="toggleProject(view.project.id, $event)"
            @dragenter="revealDropProject(view.project.id)"
            @pointerenter="revealDropProject(view.project.id)"
          >
            <template #marker
              ><span
                class="size-2.5 shrink-0 rounded-full"
                :style="{ backgroundColor: projectColorStyle(view.project) }"
            /></template>
            <template #actions
              ><ProjectActions
                :project="view.project"
                :on-add-category="() => editCategory(view.project)"
            /></template>
            <UiReorderList
              class="flex min-w-0 flex-col gap-1"
              :class="projectLayout === 'tree' && 'pl-3'"
              :data-workspace-project="view.project.id"
              draggable="[data-category-order-id]"
              handle=".category-reorder-trigger"
              :disabled="Boolean(search || tag || groupFilter)"
              @start="reorderGesture.start"
              @end="categoriesDropped($event, view.project)"
              @cancel="reorderGesture.finish"
            >
              <p v-if="!view.records.length" class="px-3 py-3 text-xs text-muted">
                No open tabs in this project. Assign a tab from Inbox.
              </p>
              <UiDisclosure
                v-for="section in view.sections"
                :key="section.id"
                :data-category-order-id="section.category?.id"
                :drag-header="section.category ? 'category' : false"
                :label="section.name"
                :count="section.records.length"
                :level="3"
                :open="
                  Boolean(search || tag || groupFilter) || !closedCategories.includes(section.id)
                "
                @update:open="toggleCategory(section.id, $event)"
              >
                <template #marker
                  ><span
                    class="size-2 shrink-0 rounded-full"
                    :style="{ backgroundColor: section.color }"
                /></template>
                <template v-if="section.category" #actions
                  ><CategoryActions
                    :category="section.category"
                    @edit="editCategory(view.project, section.category)"
                    @changed="
                      categoryChange = $event;
                      categoryUndone = false;
                    "
                /></template>
                <VueDraggable
                  :key="dragRevision"
                  :model-value="
                    section.treeRows.slice(0, limits[section.id] || 8).map((entry) => entry.record)
                  "
                  :disabled="Boolean(search || tag || groupFilter)"
                  :group="{ name: 'tabflow-semantic', pull: true, put: true }"
                  :delay="200"
                  :delay-on-touch-only="true"
                  :touch-start-threshold="6"
                  filter="[data-protected=true],[role=checkbox],button[aria-haspopup=menu],[data-branch-toggle]"
                  :prevent-on-filter="false"
                  draggable="[data-workspace-record-id]"
                  :animation="150"
                  :force-fallback="true"
                  :fallback-on-body="true"
                  :fallback-tolerance="4"
                  ghost-class="tab-drag-placeholder"
                  fallback-class="tab-drag-preview"
                  :data-project-id="view.project.id"
                  :data-category-id="section.category?.id || ''"
                  :data-section-id="section.id"
                  class="relative flex min-h-10 min-w-0 flex-col"
                  :class="
                    section.records.length
                      ? section.category
                        ? 'border-l-2 pl-3'
                        : 'pl-1'
                      : undefined
                  "
                  :style="{ borderColor: section.color }"
                  :on-move="treeDrag.move"
                  @start="treeDrag.start"
                  @end="dropped"
                >
                  <UiBranchGuides
                    v-if="store.tabTreeMode"
                    :class="{ invisible: store.draggingTabs }"
                  />
                  <TransitionGroup :css="false" @enter="listMotion.enter" @leave="listMotion.leave">
                    <WorkspaceTabRow
                      v-for="entry in section.treeRows.slice(0, limits[section.id] || 8)"
                      :key="entry.record.id"
                      :record="entry.record"
                      :tree-depth="entry.depth"
                      :child-count="entry.childCount"
                      :current-window-id="currentWindowId"
                      :selecting="selecting"
                      :selected="selected.has(entry.record.id)"
                      draggable
                      @toggle="toggleSelection"
                      @native="nativeCommand"
                      @order="reorderSemantic"
                      @assign="assign"
                      @inbox="moveToInbox"
                    />
                  </TransitionGroup>
                  <UiLoadMore
                    v-if="section.treeRows.length > (limits[section.id] || 8)"
                    :key="limits[section.id] || 8"
                    :remaining="section.treeRows.length - (limits[section.id] || 8)"
                    @load="limits[section.id] = (limits[section.id] || 8) + 20"
                  />
                  <p
                    v-if="!section.records.length"
                    data-category-empty
                    class="pl-15 pr-3 py-2 text-xs text-muted"
                  >
                    No open tabs.
                  </p>
                </VueDraggable>
              </UiDisclosure>
            </UiReorderList>
          </UiDisclosure>
        </UiReorderList>
      </template>
      <template v-else>
        <div v-if="scope.kind === 'inbox'" class="flex flex-col gap-2 border-b border-line pb-3">
          <p class="text-xs text-muted">
            Tabs awaiting a place. Assign them manually or ask the assistant for a proposal.
          </p>
          <UiToggle
            :model-value="store.app?.settings.maintainCollectionReview || false"
            label="Suggest organization for new tabs"
            @update:model-value="reviewNewTabs"
          />
          <UiButton
            v-if="rows.length"
            size="small"
            variant="ghost"
            class="self-start"
            @click="
              emit(
                'ai',
                rows.map((record) => record.id),
              )
            "
            ><Sparkles class="size-3.5" />Ask about Inbox</UiButton
          >
        </div>
        <div class="flex items-center justify-between gap-2 text-xs text-muted">
          <span>{{ rows.length }} {{ rows.length === 1 ? 'tab' : 'tabs' }}</span
          ><span>{{
            scope.kind === 'window' ? 'Current browser window' : 'Across all windows'
          }}</span>
        </div>
        <VueDraggable
          :model-value="
            store
              .treeRows(rows)
              .slice(0, shown)
              .map((entry) => entry.record)
          "
          :disabled="Boolean(search || tag || groupFilter)"
          :group="{ name: 'tabflow-semantic', pull: true, put: true }"
          :delay="200"
          :delay-on-touch-only="true"
          :touch-start-threshold="6"
          filter="[data-protected=true],[role=checkbox],button[aria-haspopup=menu],[data-branch-toggle]"
          :prevent-on-filter="false"
          draggable="[data-workspace-record-id]"
          :force-fallback="true"
          :fallback-on-body="true"
          :fallback-tolerance="4"
          ghost-class="tab-drag-placeholder"
          fallback-class="tab-drag-preview"
          :on-move="treeDrag.move"
          class="relative flex min-w-0 flex-col divide-y divide-line"
          @start="treeDrag.start"
          @end="workspaceDropped"
        >
          <UiBranchGuides v-if="store.tabTreeMode" :class="{ invisible: store.draggingTabs }" />
          <TransitionGroup :css="false" @enter="listMotion.enter" @leave="listMotion.leave">
            <WorkspaceTabRow
              v-for="entry in store.treeRows(rows).slice(0, shown)"
              :key="entry.record.id"
              :record="entry.record"
              :tree-depth="entry.depth"
              :child-count="entry.childCount"
              :current-window-id="currentWindowId"
              :selecting="selecting"
              :selected="selected.has(entry.record.id)"
              @toggle="toggleSelection"
              @native="nativeCommand"
              @assign="assign"
              @inbox="moveToInbox"
            />
          </TransitionGroup>
        </VueDraggable>
        <p v-if="!rows.length" class="py-6 text-[13px] text-muted">
          {{ scope.kind === 'inbox' ? 'No tabs waiting in Inbox.' : 'No tabs match this view.' }}
        </p>
        <UiLoadMore
          v-if="shown < store.treeRows(rows).length"
          :key="shown"
          :remaining="rows.length - shown"
          @load="shown += 35"
        />
      </template>
    </div>
    <div
      v-if="selecting"
      data-tabflow-sticky-footer
      class="sticky bottom-0 z-20 flex flex-wrap items-center gap-2 rounded-lg border border-line-strong bg-overlay p-2 shadow-lg"
    >
      <UiButton
        size="small"
        variant="secondary"
        @click="
          selecting = !selecting;
          selected = new Set();
        "
        >{{ selecting ? 'Done selecting' : 'Select tabs' }}</UiButton
      >
      <template v-if="selecting">
        <UiButton v-if="selected.size" size="small" @click="store.askAssistant([...selected])"
          >Ask assistant</UiButton
        >
        <UiButton
          size="small"
          variant="ghost"
          @click="
            selected = new Set(
              (projectMode ? projectViews.flatMap((view) => view.records) : rows).map(
                (record) => record.id,
              ),
            )
          "
          >Select matching tabs</UiButton
        >
        <UDropdownMenu
          v-if="selected.size"
          :items="batchActions"
          :content="{ onCloseAutoFocus: dialog.protectFocus }"
          ><UiButton size="small">{{ selected.size }} selected · Actions</UiButton></UDropdownMenu
        >
      </template>
    </div>
  </div>
</template>
