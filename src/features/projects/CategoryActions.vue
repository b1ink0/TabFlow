<script setup lang="ts">
import { computed } from 'vue';
import UDropdownMenu from '@nuxt/ui/components/DropdownMenu.vue';
import { PhDotsThree } from '@phosphor-icons/vue';
import UiButton from '../../ui/UiButton.vue';
import { useWorkspace } from '../../stores/workspace';
import { useDialog } from '../../stores/dialog';
import { rpc } from '../../shared/rpc';
import { workspaceEditBaseline, type WorkspaceEdit } from '../../shared/workspace-edits';
import type { Category } from '../../shared/types';
import { categoryColor } from '../../shared/category-colors';
const props = defineProps<{ category: Category }>();
const emit = defineEmits<{ edit: []; changed: [id: string] }>();
const store = useWorkspace(),
  dialog = useDialog();
const categories = computed(() =>
  (store.app?.categories || [])
    .filter((item) => item.projectId === props.category.projectId)
    .sort((a, b) => a.order - b.order),
);
async function save(edit: WorkspaceEdit, summary: string) {
  await store.run(async () => {
    if (!store.app) return;
    const change = await rpc('executeWorkspaceEdit', {
      kind: 'workspace_edits',
      summary,
      edits: [{ edit, before: workspaceEditBaseline(store.app, edit) }],
    });
    emit('changed', change.id);
    await store.refresh();
  });
}
async function remove() {
  const count =
    store.app?.memberships.filter((item) => item.categoryId === props.category.id).length || 0;
  if (
    !(await dialog.ask(
      `Delete ${props.category.name}?`,
      [],
      `${count} tabs stay in their project and become uncategorized. Browser tabs and native groups stay unchanged.`,
      'Delete category',
    ))
  )
    return;
  await save(
    { kind: 'delete_category', categoryId: props.category.id },
    `Delete category ${props.category.name}`,
  );
}
async function rename() {
  const values = await dialog.ask('Rename category', [
    { name: 'name', label: 'Category name', value: props.category.name },
  ]);
  if (!values?.name?.trim() || values.name.trim() === props.category.name) return;
  await save(
    {
      kind: 'category',
      categoryId: props.category.id,
      projectId: props.category.projectId,
      name: values.name.trim(),
      description: props.category.description,
      color: categoryColor(props.category),
    },
    `Rename category ${props.category.name} to ${values.name.trim()}`,
  );
}
async function moveToProject() {
  const choices = (store.app?.projects || []).filter(
    (project) => project.id !== props.category.projectId,
  );
  const count =
    store.app?.memberships.filter((item) => item.categoryId === props.category.id).length || 0;
  const values = await dialog.ask(
    `Move ${props.category.name}`,
    [
      {
        name: 'projectId',
        label: 'Destination project',
        options: choices.map((project) => ({ label: project.name, value: project.id })),
      },
    ],
    `${count} tabs move with this category in TabFlow. Native browser placement stays unchanged.`,
    'Move category',
  );
  if (!values?.projectId) return;
  await save(
    { kind: 'move_category', categoryId: props.category.id, projectId: values.projectId },
    `Move category ${props.category.name}`,
  );
}
function move(direction: -1 | 1) {
  const ids = categories.value.map((item) => item.id),
    from = ids.indexOf(props.category.id),
    to = from + direction;
  if (from < 0 || to < 0 || to >= ids.length) return;
  ids.splice(from, 1);
  ids.splice(to, 0, props.category.id);
  void save(
    { kind: 'category_order', projectId: props.category.projectId, categoryIds: ids },
    `Reorder categories in ${store.app?.projects.find((item) => item.id === props.category.projectId)?.name || 'project'}`,
  );
}
const items = computed(() => [
  { label: 'Edit category', onSelect: () => emit('edit') },
  { label: 'Rename category', onSelect: rename },
  {
    label: 'Move to another project…',
    disabled: (store.app?.projects.length || 0) < 2,
    onSelect: moveToProject,
  },
  {
    label: 'Move category up',
    disabled: categories.value[0]?.id === props.category.id,
    onSelect: () => move(-1),
  },
  {
    label: 'Move category down',
    disabled: categories.value.at(-1)?.id === props.category.id,
    onSelect: () => move(1),
  },
  { label: 'Delete category', onSelect: remove },
]);
</script>
<template>
  <UDropdownMenu :items="items" :content="{ onCloseAutoFocus: dialog.protectFocus }"
    ><UiButton
      square
      size="small"
      variant="ghost"
      :aria-label="`Category actions for ${category.name}`"
      title="Category actions"
      ><PhDotsThree class="size-4" /></UiButton
  ></UDropdownMenu>
</template>
