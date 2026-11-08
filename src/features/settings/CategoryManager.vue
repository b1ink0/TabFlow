<script setup lang="ts">
import { computed, ref } from 'vue';
import { refDebounced } from '@vueuse/core';
import CategoryActions from '../projects/CategoryActions.vue';
import UiSearchInput from '../../ui/UiSearchInput.vue';
import UiSelect from '../../ui/UiSelect.vue';
import UiButton from '../../ui/UiButton.vue';
import { useWorkspace } from '../../stores/workspace';
import { rpc } from '../../shared/rpc';
const store = useWorkspace();
const query = ref(''),
  settled = refDebounced(query, 160),
  projectId = ref(''),
  limit = ref(50);
const changeId = ref(''),
  undone = ref(false);
const rows = computed(() =>
  (store.app?.categories || [])
    .filter(
      (category) =>
        (!projectId.value || category.projectId === projectId.value) &&
        category.name.toLocaleLowerCase().includes(settled.value.toLocaleLowerCase()),
    )
    .sort((a, b) => a.projectId.localeCompare(b.projectId) || a.order - b.order),
);
function edit(project: string) {
  store.projectFilter = project;
  store.projectSection = 'categories';
  store.show('projects');
}
async function restore() {
  await store.run(async () => {
    const result = await rpc(undone.value ? 'redoAssistantChange' : 'undoAssistantChange', {
      id: changeId.value,
    });
    undone.value = result.status === 'undone';
    store.notify(result.outcome);
    await store.refresh();
  });
}
</script>
<template>
  <section class="flex min-w-0 flex-col gap-3">
    <h2 class="text-sm font-semibold">Categories</h2>
    <p class="text-xs text-muted">
      Rename, reorder, move or delete categories. Their tabs stay available.
    </p>
    <UiSelect
      v-model="projectId"
      :options="[
        { label: 'All projects', value: '' },
        ...store.orderedProjects.map((project) => ({ label: project.name, value: project.id })),
      ]"
      aria-label="Manage categories in project"
    />
    <UiSearchInput v-model="query" label="Find category to manage" placeholder="Find a category…" />
    <UiButton v-if="changeId" size="small" variant="ghost" class="self-start" @click="restore">{{
      undone ? 'Redo category change' : 'Undo category change'
    }}</UiButton>
    <div
      v-for="category in rows.slice(0, limit)"
      :key="category.id"
      class="flex min-w-0 items-center gap-2 border-b border-line py-2"
    >
      <div class="flex min-w-0 flex-1 flex-col gap-1">
        <span class="break-words text-sm">{{ category.name }}</span
        ><span class="text-xs text-muted"
          >{{ store.app?.projects.find((project) => project.id === category.projectId)?.name }} ·
          {{ store.app?.memberships.filter((item) => item.categoryId === category.id).length }}
          tabs</span
        >
      </div>
      <CategoryActions
        :category="category"
        @edit="edit(category.projectId)"
        @changed="
          changeId = $event;
          undone = false;
        "
      />
    </div>
    <p v-if="!rows.length" class="text-xs text-muted">No matching categories.</p>
    <UiButton v-if="rows.length > limit" size="small" @click="limit += 50"
      >More categories</UiButton
    >
  </section>
</template>
