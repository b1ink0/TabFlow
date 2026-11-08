<script setup lang="ts">
import { ref, onUnmounted } from 'vue';
import { useNow, useIntervalFn } from '@vueuse/core';
import { liveQuery } from 'dexie';
import { database } from '../../core/db';
import type { Operation, InspectionJob } from '../../shared/types';
import UiButton from '../../ui/UiButton.vue';
import { rpc } from '../../shared/rpc';
import { useWorkspace } from '../../stores/workspace';
const store = useWorkspace();
const now = useNow({ scheduler: (callback) => useIntervalFn(callback, 1000) });
const operations = ref<Operation[]>([]),
  inspections = ref<InspectionJob[]>([]);
const subscription = liveQuery(async () => ({
  operations: await database.operations
    .where('status')
    .anyOf('running', 'interrupted')
    .filter((op) => Boolean(op.queued))
    .limit(3)
    .toArray(),
  inspections: await database.jobs.where('status').anyOf('queued', 'running').limit(3).toArray(),
})).subscribe((value) => {
  operations.value = value.operations;
  inspections.value = value.inspections;
});
onUnmounted(() => subscription.unsubscribe());
function elapsed(start: number) {
  return `${Math.floor(Math.max(0, +now.value - start) / 60000)}m ${Math.floor(Math.max(0, +now.value - start) / 1000) % 60}s`;
}
</script>
<template>
  <section
    v-if="operations.length || inspections.length"
    class="flex shrink-0 flex-col gap-2 border-b border-line bg-surface px-4 py-3"
    aria-label="Browser work progress"
  >
    <div v-for="op in operations" :key="op.id" class="flex flex-wrap items-center gap-2 text-xs">
      <div class="flex min-w-0 flex-1 flex-col gap-1">
        <span
          >{{ op.summary }} · {{ op.results.length }}/{{ op.actions.length }} finished ·
          {{ elapsed(op.createdAt) }} elapsed</span
        >
        <span v-if="op.activeWake" class="truncate text-muted"
          >Waiting for
          {{
            store.records.find((r) => r.id === op.activeWake?.recordId)?.title || 'the current page'
          }}
          to load</span
        >
        <span v-if="op.pauseReason" class="text-muted">{{ op.pauseReason }}</span>
      </div>
      <UiButton
        size="small"
        variant="secondary"
        @click="
          store.run(() =>
            rpc('controlWakeOperation', { id: op.id, resume: op.status !== 'running' }),
          )
        "
        >{{ op.status === 'running' ? 'Pause waking' : 'Resume waking' }}</UiButton
      >
    </div>
    <div v-for="job in inspections" :key="job.id" class="flex flex-wrap items-center gap-2 text-xs">
      <span class="min-w-0 flex-1"
        >Inspecting pages · {{ job.cursor }}/{{ job.items.length }} finished ·
        {{ elapsed(job.createdAt) }} elapsed</span
      >
      <UiButton
        size="small"
        variant="secondary"
        @click="store.run(() => rpc('cancel', { id: job.id }))"
        >Stop inspection</UiButton
      >
    </div>
  </section>
</template>
