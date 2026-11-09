<script setup lang="ts">
import { computed, ref } from 'vue';
import { PhDotsThree } from '@phosphor-icons/vue';
import UDropdownMenu from '@nuxt/ui/components/DropdownMenu.vue';
import UiButton from '../../ui/UiButton.vue';
import ExternalClassificationDialog from './ExternalClassificationDialog.vue';
import { useWorkspace } from '../../stores/workspace';
import { useDialog } from '../../stores/dialog';
import { rpc } from '../../shared/rpc';
import { workspaceRows } from '../../shared/workspace/workspace-navigation';
import type { Project } from '../../shared/types';
const props = defineProps<{ project: Project; label?: string; onAddCategory?: () => void }>();
const store = useWorkspace(),
  dialog = useDialog();
const external = ref<InstanceType<typeof ExternalClassificationDialog>>();
const records = computed(() =>
  workspaceRows(store.records, store.app?.memberships || [], {
    kind: 'project',
    projectId: props.project.id,
  }),
);
function open(section: string) {
  store.projectFilter = props.project.id;
  store.projectSection = section;
  store.show('projects');
}
async function rename() {
  const values = await dialog.ask('Edit project', [
    { name: 'name', label: 'Project name', value: props.project.name },
    { name: 'purpose', label: 'Purpose', value: props.project.purpose },
    {
      name: 'displayColor',
      label: 'Project color',
      value: props.project.displayColor || '',
      color: true,
    },
  ]);
  if (!values) return;
  await store.run(async () => {
    await rpc('project', {
      id: props.project.id,
      name: values.name || '',
      purpose: values.purpose || '',
      displayColor: values.displayColor || null,
    });
    await store.refresh();
  });
}
const items = computed(() => [
  { label: 'Open project tabs', onSelect: () => open('tabs') },
  { label: 'Rename / edit project', onSelect: rename },
  {
    label: 'Add category',
    onSelect: () => (props.onAddCategory ? props.onAddCategory() : open('categories')),
  },
  {
    label: 'Ask about this project',
    disabled: !records.value.length,
    onSelect: () => store.askAssistant(records.value.map((item) => item.id)),
  },
  { label: 'Classify project externally', onSelect: () => external.value?.show() },
  {
    label: 'Project order',
    children: [
      {
        label: 'Move project up',
        disabled: store.orderedProjects[0]?.id === props.project.id,
        onSelect: () => store.moveProject(props.project.id, -1),
      },
      {
        label: 'Move project down',
        disabled: store.orderedProjects.at(-1)?.id === props.project.id,
        onSelect: () => store.moveProject(props.project.id, 1),
      },
      ...(
        [
          { label: 'Manual order', value: 'manual' },
          { label: 'Name', value: 'name' },
          { label: 'Recently edited', value: 'recent' },
          { label: 'Tab count', value: 'count' },
        ] as const
      ).map((item) => ({
        label: item.label,
        type: 'checkbox' as const,
        checked: store.projectSort === item.value,
        onSelect: () => {
          store.projectSort = item.value;
        },
      })),
    ],
  },
]);
</script>
<template>
  <UDropdownMenu :items="items" :content="{ onCloseAutoFocus: dialog.protectFocus }"
    ><UiButton
      square
      size="small"
      variant="ghost"
      :aria-label="label || `Project actions for ${project.name}`"
      :title="label || `Project actions for ${project.name}`"
      ><PhDotsThree class="size-4" /></UiButton
  ></UDropdownMenu>
  <ExternalClassificationDialog
    ref="external"
    hide-trigger
    :initial-scope="`project:${project.id}`"
    label="Classify project externally"
  />
</template>
