<script setup lang="ts">
import { ref } from 'vue';
import { useIntersectionObserver } from '@vueuse/core';
defineProps<{ remaining: number }>();
const emit = defineEmits<{ load: [] }>();
const target = ref<HTMLElement>();
useIntersectionObserver(
  target,
  ([entry]) => {
    if (entry?.isIntersecting) emit('load');
  },
  { rootMargin: '160px' },
);
</script>
<template>
  <div
    ref="target"
    class="flex min-h-8 items-center justify-center text-xs text-muted"
    role="status"
  >
    Loading more tabs…
  </div>
</template>
