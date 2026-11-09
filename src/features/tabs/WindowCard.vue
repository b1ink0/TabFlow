<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue';
import UiLoadMore from '../../ui/UiLoadMore.vue';
import UiBranchGuides from '../../ui/UiBranchGuides.vue';
import { useTabTreeDrag } from './useTabTreeDrag';
import { useTabListMotion } from './useTabListMotion';
import { orderTabTreeDrop } from '../../shared/tabs/tab-tree-drop';
import { tabAncestors } from '../../shared/tabs/tab-tree';
import { PhSparkle as Sparkles, PhDotsThree as Ellipsis } from '@phosphor-icons/vue';
import UDropdownMenu from '@nuxt/ui/components/DropdownMenu.vue';
import UiDisclosure from '../../ui/UiDisclosure.vue';
import UiButton from '../../ui/UiButton.vue';
import UiCheckbox from '../../ui/UiCheckbox.vue';
import TabRow from './TabRow.vue';
import UiSelect from '../../ui/UiSelect.vue';
import ExternalClassificationDialog from '../projects/ExternalClassificationDialog.vue';
import { VueDraggable, type DraggableEvent } from 'vue-draggable-plus';
import { useDialog } from '../../stores/dialog';
import { useWorkspace } from '../../stores/workspace';
import { rpc } from '../../shared/rpc';
import type { PlanAction, WindowInfo } from '../../shared/types';
const props = defineProps<{ window: WindowInfo }>();
const emit = defineEmits<{ ai: [ids: string[]] }>();
const store = useWorkspace();
const listMotion = useTabListMotion();
const dialog = useDialog();
const dragGroup = { name: 'tabloom-tabs', pull: true, put: true };
const treeDrag = useTabTreeDrag((_sourceId, targetId, position, movedIds) => {
  const target = store.records.find((record) => record.id === targetId);
  if (!target) return;
  const group = store.records.filter(
    (record) =>
      record.live && record.windowId === target.windowId && record.groupId === target.groupId,
  );
  const key = `native:${target.windowId}:${target.groupId}`;
  const current = store.semanticTabOrder[key] || [];
  const ordered = [...group].sort(
    (a, b) =>
      (current.indexOf(a.id) < 0 ? Infinity : current.indexOf(a.id)) -
      (current.indexOf(b.id) < 0 ? Infinity : current.indexOf(b.id)),
  );
  store.semanticTabOrder = {
    ...store.semanticTabOrder,
    [key]: orderTabTreeDrop(
      store.treeRows(ordered).map((entry) => entry.record),
      movedIds,
      targetId,
      position,
    ),
  };
});
const rows = computed(() =>
  store.ordered(store.visible.filter((r) => r.windowId === props.window.id)),
);
const rowLimit = ref(16);
const revealedGroups = ref(new Set<number>());
const container = ref<HTMLElement>();
const project = computed(() => store.app?.projects.find((p) => p.id === props.window.projectId));
const label = computed(
  () =>
    project.value?.name ||
    `Window ${(store.app?.windows.findIndex((item) => item.id === props.window.id) ?? 0) + 1}`,
);
async function toggleSection(groupId: number, open: boolean) {
  if (!open) revealedGroups.value.delete(groupId);
  if (groupId === -1) {
    store.toggleUngrouped(props.window.id);
    return;
  }
  await store.run(async () => {
    await rpc('groupUpdate', { id: groupId, collapsed: !open });
    await store.refresh();
  });
}
const sections = computed(() => {
  const grouped = new Map<number, typeof rows.value>();
  for (const row of rows.value) {
    const group = grouped.get(row.groupId);
    if (group) group.push(row);
    else grouped.set(row.groupId, [row]);
  }
  let offset = 0;
  return [...grouped].map(([id, groupRows]) => {
    const order = store.semanticTabOrder[`native:${props.window.id}:${id}`] || [];
    if (store.tabTreeMode)
      groupRows.sort(
        (a, b) =>
          (order.indexOf(a.id) < 0 ? Infinity : order.indexOf(a.id)) -
          (order.indexOf(b.id) < 0 ? Infinity : order.indexOf(b.id)),
      );
    const startIndex = offset;
    offset += groupRows.length;
    return {
      id,
      startIndex,
      meta: store.app?.groups.find((g) => g.id === id),
      label:
        id === -1
          ? 'Ungrouped tabs'
          : store.app?.groups.find((g) => g.id === id)?.title || 'Untitled group',
      rows: groupRows,
      treeRows: store.treeRows(groupRows),
    };
  });
});
watch(
  () => store.revealRequest,
  async (request) => {
    if (!request) return;
    const record = rows.value.find((item) => item.id === request.id);
    if (!record) return;
    const ancestors = new Set(tabAncestors(record.id, store.records));
    store.collapsedBranches = store.collapsedBranches.filter((id) => !ancestors.has(id));
    store.collapsedWindows.delete(props.window.id);
    if (record.groupId === -1) store.collapsedUngrouped.delete(props.window.id);
    else revealedGroups.value.add(record.groupId);
    const section = sections.value.find((item) => item.rows.some((row) => row.id === record.id));
    if (section)
      rowLimit.value = Math.max(
        rowLimit.value,
        section.startIndex + section.rows.findIndex((item) => item.id === record.id) + 1,
      );
    await nextTick();
    [...(container.value?.querySelectorAll<HTMLElement>('[data-tabloom-id]') || [])]
      .find((item) => item.dataset.tabloomId === record.id)
      ?.scrollIntoView({ block: 'center' });
  },
  { immediate: true },
);
function toggleWindow(open: boolean) {
  store.toggleWindow(props.window.id);
  if (open) {
    rowLimit.value = 16;
  }
}
async function tabDropped(event: DraggableEvent, source: (typeof sections.value)[number]) {
  const item = event.item as HTMLElement;
  const id = item.dataset.tabloomId;
  const target = event.to as HTMLElement;
  const targetWindow = Number(target.dataset.windowId);
  const targetGroup = Number(target.dataset.groupId);
  const record = store.records.find((row) => row.id === id);
  if (!id || !record || !Number.isInteger(targetWindow) || !Number.isInteger(targetGroup)) {
    await store.refresh();
    return;
  }
  if (event.from === event.to && event.oldDraggableIndex === event.newDraggableIndex) return;
  const draggedIds = store.selected.has(id)
    ? [...store.selected].filter((selectedId) => store.records.some((row) => row.id === selectedId))
    : [id];
  const actions: PlanAction[] = [];
  let summary = 'Reorder tab';
  if (source.id === targetGroup && props.window.id === targetWindow) {
    const orderedIds = [...target.querySelectorAll<HTMLElement>('[data-tabloom-id]')].map(
      (row) => row.dataset.tabloomId,
    );
    const position = orderedIds.indexOf(id);
    const beforeIndex = record.index;
    const followingId = orderedIds[position + 1];
    const precedingId = orderedIds[position - 1];
    const following = store.records.find((row) => row.id === followingId);
    const preceding = store.records.find((row) => row.id === precedingId);
    let index = following?.index ?? (preceding ? preceding.index + 1 : beforeIndex);
    if (beforeIndex < index) index -= 1;
    if (index !== beforeIndex) actions.push({ type: 'reorder', recordIds: [id], index });
  } else if (targetGroup !== -1) {
    const group = store.app?.groups.find((candidate) => candidate.id === targetGroup);
    if (!group) {
      await store.refresh();
      return;
    }
    actions.push({
      type: 'group',
      nativeGroupId: group.id,
      recordIds: draggedIds,
      windowId: targetWindow,
      name: group.title || 'Untitled',
      color: group.color,
    });
    summary = `Move into ${group.title || 'Untitled group'}`;
  } else {
    const groupedIds = draggedIds.filter(
      (selectedId) => store.records.find((row) => row.id === selectedId)?.groupId !== -1,
    );
    if (groupedIds.length) actions.push({ type: 'ungroup', recordIds: groupedIds });
    const movedIds = draggedIds.filter(
      (selectedId) => store.records.find((row) => row.id === selectedId)?.windowId !== targetWindow,
    );
    if (movedIds.length)
      actions.push({ type: 'move', recordIds: movedIds, windowId: targetWindow });
    summary = 'Move to Ungrouped tabs';
  }
  if (actions.length) {
    await store.run(() => store.apply(actions, summary));
    await store.refresh();
  } else await store.refresh();
}
async function rename() {
  const value = await dialog.ask('Name this project window', [
    { name: 'name', label: 'Project name', value: project.value?.name || '' },
  ]);
  const name = value?.name;
  if (name)
    await store.run(async () => {
      await rpc('project', { name, windowId: props.window.id, id: project.value?.id });
      await store.refresh();
    });
}
async function assign(projectId: string) {
  await store.run(async () => {
    await rpc('bindProject', {
      windowId: props.window.id,
      projectId: projectId === '__no_project__' ? null : projectId,
    });
    await store.refresh();
  });
}
async function moveNativeGroup(groupId: number) {
  const members = store.records.filter((record) => record.live && record.groupId === groupId);
  const destinations = (store.app?.windows || []).filter((item) => item.id !== props.window.id);
  if (!destinations.length) {
    store.notify('Open another browser window before moving this group.');
    return;
  }
  const values = await dialog.ask(
    'Move whole native group',
    [
      {
        name: 'window',
        label: 'Destination browser window',
        value: String(destinations[0]!.id),
        options: destinations.map((item) => ({
          label: `Window ${item.id}`,
          value: String(item.id),
        })),
      },
    ],
    `Moves all ${members.length} tabs together, preserving the native group. Project membership stays unchanged.`,
  );
  if (values)
    await store.run(() =>
      store.apply(
        [
          {
            type: 'moveGroup',
            nativeGroupId: groupId,
            recordIds: members.map((record) => record.id),
            windowId: Number(values.window),
          },
        ],
        'Move whole native group',
      ),
    );
}
const windowActions = computed(() => [
  { label: 'Name window', onSelect: rename },
  {
    label: 'Select window tabs',
    onSelect: () => store.select(rows.value.map((record) => record.id)),
  },
  {
    label: 'Assign project',
    children: [
      { label: 'No project', onSelect: () => assign('__no_project__') },
      ...(store.app?.projects || []).map((item) => ({
        label: item.name,
        onSelect: () => assign(item.id),
      })),
    ],
  },
]);
</script>
<template>
  <article ref="container" class="flex min-w-0 flex-col">
    <UiDisclosure
      :open="!store.collapsedWindows.has(window.id)"
      :label="label"
      :count="rows.length"
      @update:open="toggleWindow"
    >
      <template #description
        ><span class="text-xs font-normal text-muted"
          >{{ window.focused ? 'Current window' : 'Browser window' }} ·
          {{ sections.filter((section) => section.id !== -1).length }} groups</span
        ></template
      >
      <template #actions>
        <UiSelect
          :model-value="window.projectId || '__no_project__'"
          class="hidden w-36 xl:inline-flex"
          :options="[
            { label: 'No project', value: '__no_project__' },
            ...(store.app?.projects || []).map((item) => ({ label: item.name, value: item.id })),
          ]"
          aria-label="Assign window project"
          @update:model-value="assign"
        />
        <UDropdownMenu :items="windowActions" :content="{ onCloseAutoFocus: dialog.protectFocus }">
          <UiButton
            square
            size="small"
            variant="ghost"
            :title="'Actions for ' + label"
            :aria-label="'Actions for ' + label"
            ><Ellipsis class="size-4"
          /></UiButton>
        </UDropdownMenu>
        <ExternalClassificationDialog
          :initial-scope="`window:${window.id}`"
          label="Classify this window externally"
          compact
        />
        <UiButton
          size="small"
          variant="ghost"
          @click="
            emit(
              'ai',
              rows.map((record) => record.id),
            )
          "
          ><Sparkles class="size-3.5" /><span class="hidden sm:inline">Organize</span></UiButton
        >
      </template>
      <div class="flex min-w-0 flex-col gap-1 pb-4 pl-3 sm:pl-5">
        <UiDisclosure
          v-for="section in sections"
          :key="section.id"
          :level="3"
          :label="section.label"
          :count="section.rows.length"
          :open="
            revealedGroups.has(section.id) ||
            (section.id === -1
              ? !store.collapsedUngrouped.has(window.id)
              : !section.meta?.collapsed)
          "
          @update:open="toggleSection(section.id, $event)"
        >
          <template #actions>
            <UDropdownMenu
              v-if="section.id !== -1"
              :content="{ onCloseAutoFocus: dialog.protectFocus }"
              :items="[
                {
                  label: 'Move whole group to window…',
                  onSelect: () => moveNativeGroup(section.id),
                },
              ]"
            >
              <UiButton
                size="small"
                variant="ghost"
                :aria-label="`Actions for group ${section.label}`"
                :title="`Actions for group ${section.label}`"
                ><Ellipsis class="size-3.5"
              /></UiButton>
            </UDropdownMenu>
            <UiCheckbox
              :label="'Select ' + section.label"
              :model-value="
                section.rows.length > 0 &&
                section.rows.every((record) => store.selected.has(record.id))
              "
              :indeterminate="
                section.rows.some((record) => store.selected.has(record.id)) &&
                !section.rows.every((record) => store.selected.has(record.id))
              "
              @update:model-value="store.select(section.rows.map((record) => record.id))"
          /></template>
          <VueDraggable
            v-model="section.rows"
            :group="dragGroup"
            :animation="160"
            :force-fallback="true"
            :fallback-on-body="true"
            :fallback-tolerance="4"
            ghost-class="tab-drag-placeholder"
            fallback-class="tab-drag-preview"
            :delay="200"
            :delay-on-touch-only="true"
            :touch-start-threshold="6"
            filter="[data-protected=true],[role=checkbox],button[aria-haspopup=menu],[data-branch-toggle]"
            :prevent-on-filter="false"
            item-key="id"
            draggable="[data-tabloom-id]"
            :disabled="
              store.sort !== 'position' ||
              Boolean(store.search) ||
              Boolean(store.projectFilter) ||
              section.rows.some((row) => row.pinned)
            "
            :data-window-id="window.id"
            :data-group-id="section.id"
            class="relative flex min-w-0 flex-col"
            :on-move="treeDrag.move"
            @start="treeDrag.start"
            @end="
              treeDrag.end($event).then((handled) => {
                if (!handled) tabDropped($event, section);
              })
            "
          >
            <UiBranchGuides v-if="store.tabTreeMode" :class="{ invisible: store.draggingTabs }" />
            <TransitionGroup :css="false" @enter="listMotion.enter" @leave="listMotion.leave">
              <TabRow
                v-for="entry in section.treeRows.slice(
                  0,
                  Math.max(0, rowLimit - section.startIndex),
                )"
                :key="entry.record.id"
                :record="entry.record"
                :tree-depth="entry.depth"
                :child-count="entry.childCount"
              />
            </TransitionGroup>
          </VueDraggable>
        </UiDisclosure>
        <UiLoadMore
          v-if="rowLimit < rows.length"
          :remaining="rows.length - rowLimit"
          @load="rowLimit += 30"
        />
        <p v-if="!rows.length" class="px-3 py-5 text-[13px] text-muted">
          No page tabs in this window.
        </p>
      </div>
    </UiDisclosure>
  </article>
</template>
