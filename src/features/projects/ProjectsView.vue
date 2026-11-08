<script setup lang="ts">
import { vScrollFade } from '../../ui/scroll-fade';
import { ref, watch } from 'vue';
import UTabs from '@nuxt/ui/components/Tabs.vue';
import CollectionOrganizer from './CollectionOrganizer.vue';
import ProjectPanel from './ProjectPanel.vue';
import UiButton from '../../ui/UiButton.vue';
import EmptyState from '../../ui/EmptyState.vue';
import { useWorkspace } from '../../stores/workspace';
const store = useWorkspace();
const emit = defineEmits<{ create: [] }>();
const draftVisited = ref(store.projectSection === 'drafts');
watch(
  () => store.projectSection,
  (section) => {
    if (section === 'drafts') draftVisited.value = true;
  },
);
</script>
<template>
  <div class="flex min-w-0 max-w-5xl flex-col gap-4">
    <div v-if="store.activeProject" class="flex min-w-0 flex-col gap-4">
      <UTabs
        v-model="store.projectSection"
        v-scroll-fade
        data-horizontal-tabs
        :content="false"
        :items="[
          { label: 'Tabs', value: 'tabs' },
          { label: 'Details', value: 'details' },
          { label: 'Categories', value: 'categories' },
          { label: 'Organize', value: 'organize' },
          { label: 'All drafts', value: 'drafts' },
        ]"
        :ui="{ list: 'w-full overflow-x-auto justify-start', trigger: 'shrink-0' }"
        aria-label="Project sections"
      />
      <ProjectPanel
        v-show="store.projectSection !== 'drafts'"
        :key="store.activeProject.id"
        :project="store.activeProject"
        :section="store.projectSection"
      />
    </div>
    <EmptyState
      v-else
      title="Give your collection a structure"
      description="Create a project or ask the assistant to organize your tabs."
      ><UiButton @click="emit('create')">Create project</UiButton></EmptyState
    >
    <UiButton
      v-if="!store.activeProject"
      variant="ghost"
      class="w-fit"
      @click="store.projectSection = 'drafts'"
      >Organization drafts</UiButton
    >
    <CollectionOrganizer v-if="draftVisited" v-show="store.projectSection === 'drafts'" />
  </div>
</template>
