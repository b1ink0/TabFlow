<script setup lang="ts">
import UiCollapsible from '../../ui/UiCollapsible.vue';
import { ref } from 'vue';
import UiButton from '../../ui/UiButton.vue';
import { PhX } from '@phosphor-icons/vue';
import type { TagReview } from '../../shared/organization/tag-analysis';
defineProps<{ items: TagReview[number]['tags']; selected?: string[] }>();
defineEmits<{ include: [name: string]; dismiss: [name: string]; remove: [name: string] }>();
const open = ref(false);
</script>
<template>
  <UiCollapsible v-if="items.length" class="text-xs" @update:open="open = $event"
    ><template #label>Tags needing review · {{ items.length }}</template>
    <div v-if="open" class="flex flex-col gap-2 py-2">
      <div v-if="selected?.length" class="flex flex-wrap items-center gap-1">
        <span class="text-muted">Draft tags</span>
        <UiButton
          v-for="name in selected"
          :key="name"
          size="small"
          variant="ghost"
          :aria-label="`Remove suggested tag ${name}`"
          @click="$emit('remove', name)"
          >{{ name }} <PhX class="size-3"
        /></UiButton>
      </div>
      <div v-for="tag in items" :key="tag.name" class="flex flex-wrap items-center gap-2">
        <span class="min-w-0 break-words">{{ tag.name }}</span>
        <span class="text-muted">{{ tag.outcome === 'new' ? 'New label' : 'Uncertain' }}</span>
        <UiButton size="small" @click="$emit('include', tag.name)">Add to draft</UiButton>
        <UiButton size="small" variant="ghost" @click="$emit('dismiss', tag.name)"
          >Dismiss</UiButton
        >
      </div>
    </div>
  </UiCollapsible>
</template>
