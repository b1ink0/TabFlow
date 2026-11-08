<script setup lang="ts">
import { watch } from 'vue';
import { useToast } from '@nuxt/ui/composables/useToast';
import { useWorkspace } from '../../stores/workspace';

const store = useWorkspace();
const toast = useToast();
watch(
  () => store.notification,
  (notice) => {
    if (!notice?.message) return;
    // Progress replaces progress; errors stay independently dismissible.
    toast.add({
      id: notice.error ? `workspace-error-${notice.sequence}` : 'workspace-notice',
      description: notice.message,
      color: notice.error ? 'error' : 'neutral',
      duration: notice.error ? 0 : 6000,
      close: { 'aria-label': 'Dismiss notification' },
    });
  },
);
</script>

<template><span class="hidden" aria-hidden="true" /></template>
