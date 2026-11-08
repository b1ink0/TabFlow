<script setup lang="ts">
import { computed, ref, toRaw } from 'vue';
import UPopover from '@nuxt/ui/components/Popover.vue';
import {
  PhSlidersHorizontal as SlidersHorizontal,
  PhCaretRight as ChevronRight,
} from '@phosphor-icons/vue';
import UiButton from '../../ui/UiButton.vue';
import UiSelect from '../../ui/UiSelect.vue';
import UiTagChecklist from '../../ui/UiTagChecklist.vue';

import { useWorkspace } from '../../stores/workspace';
import { useDialog } from '../../stores/dialog';
const store = useWorkspace(),
  dialog = useDialog();
const open = ref(false);
function clearFilters() {
  store.clearFilters();
  open.value = false;
}
const saved = ref(''),
  active = ref('');
const count = computed(
  () =>
    store.filters.tags.length +
    Number(store.filters.untagged) +
    Number(Boolean(store.filters.projectId)) +
    Number(Boolean(store.filters.categoryId)) +
    Number(Boolean(store.filters.groupId)) +
    Number(Boolean(store.filters.windowId)),
);
function choices(items: Array<{ label: string; value: string }>, value: string) {
  return [
    { label: 'All', value: '' },
    ...items,
    ...(value && !items.some((item) => item.value === value)
      ? [{ label: 'Unavailable · clear to broaden', value }]
      : []),
  ];
}
const projects = computed(() =>
  choices(
    (store.app?.projects || []).map((p) => ({ label: p.name, value: p.id })),
    store.filters.projectId,
  ),
);
const categories = computed(() =>
  choices(
    (store.app?.categories || [])
      .filter((c) => !store.filters.projectId || c.projectId === store.filters.projectId)
      .map((c) => ({
        label: `${store.app?.projects.find((p) => p.id === c.projectId)?.name} / ${c.name}`,
        value: c.id,
      })),
    store.filters.categoryId,
  ),
);
const groups = computed(() =>
  choices(
    [
      { label: 'Ungrouped', value: '-1' },
      ...(store.app?.groups || []).map((g) => ({
        label: g.title || 'Untitled group',
        value: String(g.id),
      })),
    ],
    store.filters.groupId,
  ),
);
const windows = computed(() =>
  choices(
    (store.app?.windows || []).map((w, i) => ({ label: `Window ${i + 1}`, value: String(w.id) })),
    store.filters.windowId,
  ),
);
async function save() {
  const value = await dialog.ask('Save tab view', [{ name: 'name', label: 'View name' }]);
  const name = value?.name?.trim();
  if (!name) return;
  const id = crypto.randomUUID();
  store.savedViews = [
    ...store.savedViews,
    {
      id,
      name: name.slice(0, 80),
      filters: structuredClone(toRaw(store.filters)),
      search: store.search,
    },
  ];
  saved.value = id;
  store.notify('View saved');
}
function load(id: string) {
  saved.value = id;
  const view = store.savedViews.find((v) => v.id === id);
  if (!view) return;
  store.filters = structuredClone(toRaw(view.filters));
  store.search = view.search;
}
</script>
<template>
  <UPopover
    v-model:open="open"
    :content="{ align: 'end' }"
    :ui="{ content: 'w-72 max-h-[calc(100dvh-24px)] overflow-y-auto bg-surface p-2' }"
  >
    <UiButton
      size="small"
      :variant="count ? 'default' : 'ghost'"
      aria-label="Filters"
      title="Filters"
      ><SlidersHorizontal class="size-4" /><span v-if="count" class="text-xs tabular-nums">{{
        count
      }}</span></UiButton
    >
    <template #content
      ><div class="flex flex-col gap-1">
        <div class="flex items-center justify-between gap-2 px-2 py-1">
          <span class="text-[13px] font-medium">Filter tabs</span
          ><UiButton v-if="count" size="small" variant="ghost" @click="clearFilters()"
            >Clear</UiButton
          >
        </div>
        <template
          v-for="item in [
            {
              key: 'project',
              label: 'Project',
              value: projects.find((p) => p.value === store.filters.projectId)?.label,
            },
            {
              key: 'category',
              label: 'Category',
              value: categories.find((c) => c.value === store.filters.categoryId)?.label,
            },
            {
              key: 'tags',
              label: 'Tags',
              value: store.filters.untagged ? 'Untagged' : store.filters.tags.join(', ') || 'All',
            },
            {
              key: 'window',
              label: 'Window',
              value: windows.find((w) => w.value === store.filters.windowId)?.label,
            },
            {
              key: 'group',
              label: 'Native group',
              value: groups.find((g) => g.value === store.filters.groupId)?.label,
            },
            {
              key: 'views',
              label: 'Saved views',
              value: store.savedViews.find((v) => v.id === saved)?.name || '',
            },
          ]"
          :key="item.key"
        >
          <button
            type="button"
            class="flex min-h-9 min-w-0 items-center gap-3 rounded px-2 text-left text-[13px] hover:bg-hover"
            :aria-expanded="active === item.key"
            @click="active = active === item.key ? '' : item.key"
          >
            <span class="shrink-0">{{ item.label }}</span
            ><span class="min-w-0 flex-1 truncate text-right text-xs text-muted">{{
              item.value
            }}</span
            ><ChevronRight
              class="size-3.5 shrink-0 text-muted"
              :class="active === item.key && 'rotate-90'"
            />
          </button>
          <div v-if="active === item.key" class="flex flex-col gap-2 px-2 pb-2">
            <UiSelect
              v-if="active === 'project'"
              v-model="store.filters.projectId"
              :options="projects"
              aria-label="Filter by project"
              @update:model-value="store.filters.categoryId = ''"
            />
            <UiSelect
              v-else-if="active === 'category'"
              v-model="store.filters.categoryId"
              :options="categories"
              aria-label="Filter by category"
            />
            <UiTagChecklist
              v-else-if="active === 'tags'"
              v-model="store.filters.tags"
              v-model:mode="store.filters.mode"
              v-model:untagged="store.filters.untagged"
              :options="store.tagVocabulary"
            />
            <UiSelect
              v-else-if="active === 'window'"
              v-model="store.filters.windowId"
              :options="windows"
              aria-label="Filter by window"
            />
            <UiSelect
              v-else-if="active === 'group'"
              v-model="store.filters.groupId"
              :options="groups"
              aria-label="Filter by native group"
            />
            <template v-else
              ><UiSelect
                :model-value="saved"
                :options="[
                  { label: 'Choose a saved view', value: '' },
                  ...store.savedViews.map((v) => ({ label: v.name, value: v.id })),
                ]"
                aria-label="Saved tab views"
                @update:model-value="load"
              /><UiButton
                v-if="saved"
                size="small"
                variant="ghost"
                @click="
                  store.savedViews = store.savedViews.filter((v) => v.id !== saved);
                  saved = '';
                  open = false;
                "
                >Delete view</UiButton
              ></template
            >
          </div>
        </template>
        <div class="flex gap-2 border-t border-line pt-2">
          <UiButton size="small" variant="ghost" @click="store.run(save)">Save view</UiButton
          ><UiButton
            size="small"
            variant="ghost"
            @click="
              store.clearFilters();
              store.search = '';
              saved = '';
              open = false;
            "
            >Clear filters</UiButton
          >
          <UiButton size="small" variant="ghost" @click="open = false">Done</UiButton>
        </div>
      </div></template
    >
  </UPopover>
</template>
