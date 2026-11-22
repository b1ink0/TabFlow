<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';
import { useIntersectionObserver } from '@vueuse/core';
import UiLoading from './UiLoading.vue';

defineProps<{ remaining: number }>();
const emit = defineEmits<{ load: [] }>();
const target = ref<HTMLElement>();
const loading = ref(false);
let frame = 0;
useIntersectionObserver(
  target,
  ([entry]) => {
    if (!entry?.isIntersecting || loading.value) return;
    loading.value = true;
    // Give the spinner a paint before mounting the next batch.
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        emit('load');
        loading.value = false;
      });
    });
  },
  { rootMargin: '240px' },
);
onBeforeUnmount(() => cancelAnimationFrame(frame));
</script>
<template>
  <div ref="target" class="flex min-h-8 items-center justify-center">
    <UiLoading v-if="loading" compact />
  </div>
</template>
