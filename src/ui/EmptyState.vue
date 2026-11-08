<script setup lang="ts">
defineProps<{ title: string; description?: string }>();
</script>
<template>
  <div class="flex flex-col items-start gap-2 py-10">
    <h3 class="text-sm font-medium text-secondary">{{ title }}</h3>
    <p v-if="description" class="max-w-md text-[13px] leading-5 text-muted">{{ description }}</p>
    <div v-if="$slots.default" class="flex gap-2 pt-2"><slot /></div>
  </div>
</template>
