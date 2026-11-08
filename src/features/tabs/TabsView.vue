<script setup lang="ts">
import { computed, ref } from 'vue';
import UDropdownMenu from '@nuxt/ui/components/DropdownMenu.vue';
import { PhX as X, PhDotsThree as Ellipsis } from '@phosphor-icons/vue';
import UiButton from '../../ui/UiButton.vue';
import UiCheckbox from '../../ui/UiCheckbox.vue';
import UiSelect from '../../ui/UiSelect.vue';
import ExternalClassificationDialog from '../projects/ExternalClassificationDialog.vue';
import UiSearchInput from '../../ui/UiSearchInput.vue';
import EmptyState from '../../ui/EmptyState.vue';
import WindowCard from './WindowCard.vue';
import TabFilterControls from './TabFilterControls.vue';
import { useWorkspace } from '../../stores/workspace';
import { useDialog } from '../../stores/dialog';
import { rpc } from '../../shared/rpc';
import { COLORS } from '../../shared/model';
const store = useWorkspace(),
  dialog = useDialog();
const externalDialog = ref<InstanceType<typeof ExternalClassificationDialog>>();
const batchActions = computed(() => [
  { label: 'Classify selected tabs externally', onSelect: () => externalDialog.value?.show() },
  {
    label: 'Inspect selected tabs',
    onSelect: () => store.run(() => store.inspect(store.selection())),
  },
  ...(['suspend', 'wake'] as const).map((type) => ({
    label: type === 'wake' ? 'Wake selected tabs' : 'Suspend selected tabs',
    onSelect: () =>
      store.run(() =>
        store.apply([{ type, recordIds: store.selection() }], `${type} selected tabs`),
      ),
  })),
  {
    label: 'Browser and protection',
    children: [
      { label: 'Put in native group?', onSelect: () => store.run(group) },
      { label: 'Move to browser window?', onSelect: () => store.run(move) },
      { label: 'Protect selected tabs', onSelect: () => store.run(protectSelection) },
      {
        label: 'Remove native group',
        onSelect: () =>
          store.run(() =>
            store.apply(
              [{ type: 'ungroup', recordIds: store.selection() }],
              'Ungroup selected tabs',
            ),
          ),
      },
    ],
  },
]);
const emit = defineEmits<{ ai: [ids: string[]] }>();
const windows = computed(
  () =>
    store.app?.windows.filter(
      (window) =>
        store.visible.some((record) => record.windowId === window.id) ||
        (!store.search && !store.hasFilters),
    ) || [],
);
const allSelected = computed(
  () => store.visible.length > 0 && store.visible.every((record) => store.selected.has(record.id)),
);
const allCollapsed = computed(
  () =>
    windows.value.length > 0 &&
    windows.value.every((window) => store.collapsedWindows.has(window.id)),
);
const sortOptions = [
  { label: 'Browser order', value: 'position' },
  { label: 'Recently used', value: 'recent' },
  { label: 'Most activated', value: 'frequent' },
  { label: 'Focused time', value: 'focus' },
  { label: 'Least recent', value: 'old' },
];
function selectVisible() {
  store.selected = new Set(
    allSelected.value
      ? [...store.selected].filter((id) => !store.visible.some((record) => record.id === id))
      : [...store.selected, ...store.visible.map((record) => record.id)],
  );
}
async function protectSelection() {
  for (const id of store.selection()) await rpc('record', { id, patch: { locked: true } });
  await store.refresh();
}
async function group() {
  const ids = store.selection();
  const first = store.records.find((r) => r.id === ids[0])!;
  const values = await dialog.ask('Group selected tabs', [
    { name: 'name', label: 'Group name' },
    {
      name: 'color',
      label: 'Group color',
      value: 'grey',
      options: COLORS.map((c) => ({ label: c, value: c })),
    },
    {
      name: 'window',
      label: 'Target window',
      value: String(first.windowId),
      options: (store.app?.windows || []).map((w) => ({
        label: store.app?.projects.find((p) => p.id === w.projectId)?.name || `Window ${w.id}`,
        value: String(w.id),
      })),
    },
  ]);
  if (values)
    await store.apply(
      [
        {
          type: 'group',
          recordIds: ids,
          name: values.name,
          color: values.color as chrome.tabGroups.TabGroup['color'],
          windowId: Number(values.window),
        },
      ],
      `Group tabs: ${values.name}`,
    );
}
async function move() {
  const ids = store.selection();
  const values = await dialog.ask('Move selected tabs', [
    {
      name: 'window',
      label: 'Target window',
      options: [
        { label: 'New window', value: 'new' },
        ...(store.app?.windows || []).map((w) => ({
          label: store.app?.projects.find((p) => p.id === w.projectId)?.name || `Window ${w.id}`,
          value: String(w.id),
        })),
      ],
    },
  ]);
  if (!values) return;
  const windowId =
    values.window === 'new' ? (await rpc('createWindow', {})).id! : Number(values.window);
  await store.apply([{ type: 'move', recordIds: ids, windowId }], 'Move selected tabs');
}
</script>
<template>
  <div class="flex min-w-0 flex-col gap-5">
    <div data-scroll-fade-header class="sticky top-0 z-10 flex flex-col gap-3 bg-canvas pb-3">
      <div class="flex min-w-0 items-center gap-2">
        <UiSearchInput
          v-model="store.search"
          label="Search tabs"
          placeholder="Search your tabs…"
          class="min-w-0 flex-1"
        />
        <UiSelect v-model="store.sort" :options="sortOptions" icon-only aria-label="Sort tabs" />
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
            {
              label: allCollapsed ? 'Expand all windows' : 'Collapse all windows',
              disabled: !windows.length,
              onSelect: () => store.toggleAllWindows(windows.map((window) => window.id)),
            },
          ]"
        >
          <UiButton
            square
            size="small"
            variant="ghost"
            aria-label="Tab list options"
            title="Tab list options"
            ><Ellipsis class="size-4"
          /></UiButton>
        </UDropdownMenu>
      </div>
      <div class="flex min-h-8 flex-wrap items-center gap-3 text-xs text-muted">
        <label class="flex items-center gap-2"
          ><UiCheckbox
            :model-value="allSelected"
            label="Select visible tabs"
            @update:model-value="selectVisible"
          /><span>{{
            store.selected.size ? store.selected.size + ' selected' : 'Select all visible'
          }}</span></label
        >
        <UiButton
          v-if="store.projectFilter"
          size="small"
          variant="ghost"
          @click="store.projectFilter = null"
          >All projects<X class="size-3.5"
        /></UiButton>
        <span v-if="!store.selected.size" class="min-w-0 flex-1 text-right"
          >{{ store.visible.length }} tabs · {{ windows.length }} windows</span
        >
      </div>
    </div>
    <span v-if="store.searching" role="status" class="text-xs text-muted">Searching tabs?</span>
    <div class="flex flex-col gap-2">
      <WindowCard
        v-for="window in windows"
        :key="window.id"
        :window="window"
        @ai="emit('ai', $event)"
      />
      <EmptyState
        v-if="!windows.length"
        :title="store.loading ? 'Loading your browser…' : 'No matching tabs'"
        description="Search by title, address, notes or indexed page content. Try a different search to see more of your collection."
      />
    </div>
    <ExternalClassificationDialog
      ref="externalDialog"
      hide-trigger
      initial-scope="selection"
      :record-ids="[...store.selected]"
    />
    <div
      v-if="store.selected.size"
      class="sticky bottom-0 z-20 flex flex-wrap items-center gap-2 self-center rounded-lg border border-line-strong bg-overlay p-2 shadow-lg"
      aria-label="Selected tab actions"
    >
      <span class="text-xs text-muted">{{ store.selected.size }} selected</span>
      <UiButton size="small" @click="store.askAssistant(store.selection())">Ask assistant</UiButton>
      <UDropdownMenu :items="batchActions" :content="{ onCloseAutoFocus: dialog.protectFocus }"
        ><UiButton size="small">Actions</UiButton></UDropdownMenu
      >
      <UiButton size="small" variant="ghost" @click="store.selected = new Set()">Done</UiButton>
    </div>
  </div>
</template>
