<script setup lang="ts">
import { PhSpinnerGap as LoaderCircle } from '@phosphor-icons/vue';
</script>

<template>
  <div
    class="flex min-h-40 min-w-0 flex-1 items-center justify-center"
    role="status"
    aria-label="Loading"
  >
    <LoaderCircle class="size-5 animate-spin text-muted" aria-hidden="true" />
  </div>
</template>
