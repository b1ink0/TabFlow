<script setup lang="ts">
import { PhCaretRight as CaretRight } from '@phosphor-icons/vue';
import { useWorkspace } from '../stores/workspace';
import UiButton from './UiButton.vue';
defineProps<{ recordId: string; count: number; src: string; fallback: string }>();
const store = useWorkspace();
</script>
<template>
  <UiButton
    square
    size="small"
    variant="ghost"
    class="relative z-1 size-4 min-h-4 p-0 after:absolute after:-inset-2 max-sm:size-4 max-sm:min-h-4"
    data-tab-tree-icon
    data-branch-toggle
    :aria-label="
      store.collapsedBranches.includes(recordId) ? 'Expand tab branch' : 'Collapse tab branch'
    "
    :aria-expanded="!store.collapsedBranches.includes(recordId)"
    @click.stop="store.toggleBranch(recordId)"
  >
    <img
      :src="src"
      alt=""
      :draggable="false"
      class="size-4 rounded-sm"
      :class="
        store.collapsedBranches.includes(recordId)
          ? 'opacity-0'
          : 'group-hover:opacity-0 group-hover/tab:opacity-0 group-focus-within:opacity-0 group-focus-within/tab:opacity-0'
      "
      @error="($event.target as HTMLImageElement).src = fallback"
    />
    <CaretRight
      class="absolute inset-0 size-4 transition-transform group-hover:opacity-100 group-hover/tab:opacity-100 group-focus-within:opacity-100 group-focus-within/tab:opacity-100"
      :class="store.collapsedBranches.includes(recordId) ? 'opacity-100' : 'opacity-0 rotate-90'"
    />
  </UiButton>
</template>
