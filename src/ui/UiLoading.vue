<script setup lang="ts">
import { PhSpinnerGap as LoaderCircle } from '@phosphor-icons/vue';
defineProps<{ compact?: boolean }>();
</script>

<template>
  <div
    class="flex min-w-0 items-center justify-center"
    :class="compact ? 'flex-none' : 'min-h-40 flex-1'"
    role="status"
    aria-label="Loading"
  >
    <LoaderCircle class="size-5 animate-spin text-muted" aria-hidden="true" />
  </div>
</template>
