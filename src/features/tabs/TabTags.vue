<script setup lang="ts">
import { useWorkspace } from '../../stores/workspace';
import UPopover from '@nuxt/ui/components/Popover.vue';
defineProps<{ tags: readonly string[] }>();
const store = useWorkspace();
</script>
<template>
  <div v-if="tags.length" class="flex max-w-36 shrink-0 items-center gap-1" aria-label="Tab tags">
    <button
      v-for="tag in tags.slice(0, 1)"
      :key="tag"
      type="button"
      class="max-w-20 truncate rounded bg-raised px-2 py-1 text-xs text-secondary hover:bg-hover"
      :title="tag"
      :aria-label="`Filter tabs tagged ${tag}`"
      @click.stop="store.filterTag(tag)"
    >
      {{ tag }}
    </button>
    <UPopover v-if="tags.length > 1" :ui="{ content: 'max-w-64 bg-surface p-3' }"
      ><button
        type="button"
        class="rounded px-1 py-1 text-xs text-muted hover:bg-hover"
        aria-label="Show all tab tags"
      >
        +{{ tags.length - 1 }}</button
      ><template #content
        ><div class="flex flex-wrap gap-2">
          <button
            v-for="tag in tags"
            :key="tag"
            type="button"
            class="rounded bg-raised px-2 py-1 text-xs text-secondary"
            :aria-label="`Filter tabs tagged ${tag}`"
            @click.stop="store.filterTag(tag)"
          >
            {{ tag }}
          </button>
        </div></template
      ></UPopover
    >
  </div>
</template>
