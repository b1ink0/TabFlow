<script setup lang="ts">
import { computed } from 'vue';
import UiScrollArea from './UiScrollArea.vue';
const props = defineProps<{ value?: string }>();
const formatted = computed(() => {
  const value = props.value || '';
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
});
</script>
<template>
  <UiScrollArea class="rounded-md bg-surface" viewport-class="max-h-72" content-class="p-3">
    <pre class="whitespace-pre-wrap break-words font-mono text-xs leading-5">{{ formatted }}</pre>
  </UiScrollArea>
</template>
