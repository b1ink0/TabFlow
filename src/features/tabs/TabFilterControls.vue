<script setup lang="ts">
import { computed, ref } from 'vue';
import UPopover from '@nuxt/ui/components/Popover.vue';
import {
  PhSlidersHorizontal as SlidersHorizontal,
  PhCaretRight as ChevronRight,
} from '@phosphor-icons/vue';
import UiButton from '../../ui/UiButton.vue';
import USelectMenu from '@nuxt/ui/components/SelectMenu.vue';
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
    store.filters.projectId.length +
    store.filters.categoryId.length +
    store.filters.groupId.length +
    store.filters.windowId.length,
);
function choices(items: Array<{ label: string; value: string }>, selected: string[]) {
  return [
    ...items,
    ...selected
      .filter((id) => !items.some((item) => item.value === id))
      .map((value) => ({ label: 'Unavailable', value })),
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
      .filter(
        (c) => !store.filters.projectId.length || store.filters.projectId.includes(c.projectId),
      )
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
      filters: JSON.parse(JSON.stringify(store.filters)),
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
  const filters = { ...view.filters };
  for (const key of ['projectId', 'categoryId', 'windowId', 'groupId'] as const) {
    const value = filters[key];
    if (!Array.isArray(value)) filters[key] = value ? [value] : [];
  }
  store.filters = filters;
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
              value:
                projects
                  .filter((item) => store.filters.projectId.includes(item.value))
                  .map((item) => item.label)
                  .join(', ') || 'All',
            },
            {
              key: 'category',
              label: 'Category',
              value:
                categories
                  .filter((item) => store.filters.categoryId.includes(item.value))
                  .map((item) => item.label)
                  .join(', ') || 'All',
            },
            {
              key: 'tags',
              label: 'Tags',
              value:
                [...(store.filters.untagged ? ['Untagged'] : []), ...store.filters.tags].join(
                  ', ',
                ) || 'All',
            },
            {
              key: 'window',
              label: 'Window',
              value:
                windows
                  .filter((item) => store.filters.windowId.includes(item.value))
                  .map((item) => item.label)
                  .join(', ') || 'All',
            },
            {
              key: 'group',
              label: 'Native group',
              value:
                groups
                  .filter((item) => store.filters.groupId.includes(item.value))
                  .map((item) => item.label)
                  .join(', ') || 'All',
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
            <USelectMenu
              v-if="active === 'project'"
              v-model="store.filters.projectId"
              multiple
              value-key="value"
              placeholder="All"
              :items="projects"
              aria-label="Filter by project"
              @update:model-value="
                store.filters.categoryId = store.filters.categoryId.filter(
                  (id) =>
                    categories.some((item) => item.value === id) &&
                    store.app?.categories.some(
                      (item) =>
                        item.id === id &&
                        (!store.filters.projectId.length ||
                          store.filters.projectId.includes(item.projectId)),
                    ),
                )
              "
            />
            <USelectMenu
              v-else-if="active === 'category'"
              v-model="store.filters.categoryId"
              multiple
              value-key="value"
              placeholder="All"
              :items="categories"
              aria-label="Filter by category"
            />
            <UiTagChecklist
              v-else-if="active === 'tags'"
              v-model="store.filters.tags"
              v-model:mode="store.filters.mode"
              v-model:untagged="store.filters.untagged"
              combine-untagged
              :options="store.tagVocabulary"
            />
            <USelectMenu
              v-else-if="active === 'window'"
              v-model="store.filters.windowId"
              multiple
              value-key="value"
              placeholder="All"
              :items="windows"
              aria-label="Filter by window"
            />
            <USelectMenu
              v-else-if="active === 'group'"
              v-model="store.filters.groupId"
              multiple
              value-key="value"
              placeholder="All"
              :items="groups"
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
