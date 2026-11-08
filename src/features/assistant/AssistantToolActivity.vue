<script setup lang="ts">
import UiDataBlock from '../../ui/UiDataBlock.vue';
import { computed } from 'vue';
import { useNow, useIntervalFn } from '@vueuse/core';
import UChatTool from '@nuxt/ui/components/ChatTool.vue';
import type { AssistantToolEvent } from '../../shared/assistant';

const props = defineProps<{ events: AssistantToolEvent[]; running?: boolean }>();
const now = useNow({ scheduler: (callback) => useIntervalFn(callback, 1000) });
const calls = computed(() => {
  const requests = props.events.filter((event) => event.phase === 'requested');
  return [
    ...requests.map((request) => ({
      request,
      result: props.events.find((event) => event.id === request.id && event.phase === 'returned'),
      legacy: false,
    })),
    ...props.events
      .filter(
        (event) =>
          event.phase === 'returned' && !requests.some((request) => request.id === event.id),
      )
      .map((request) => ({ request, result: undefined, legacy: true })),
  ].sort((a, b) => a.request.createdAt - b.request.createdAt);
});
const pending = computed(
  () => props.running && calls.value.some((call) => !call.result && !call.legacy),
);
function duration(start: number, end?: number) {
  if (!end && !props.running) return 'Stopped before result';
  end ??= +now.value;
  const elapsed = Math.max(0, end - start);
  return elapsed < 1000 ? `${elapsed} ms` : `${(elapsed / 1000).toFixed(1)} s`;
}
</script>

<template>
  <UChatTool
    text="Saved tool activity"
    :suffix="`${events.filter((event) => event.phase === 'returned').length} results`"
    :loading="pending"
    :unmount-on-hide="true"
    class="min-w-0 text-xs"
    :ui="{ trigger: 'cursor-pointer text-muted', body: 'flex min-w-0 flex-col gap-2 pt-2' }"
    data-tool-activity
  >
    <UChatTool
      v-for="call in calls"
      :key="call.request.id"
      :text="call.request.tool"
      :suffix="`${new Date(call.request.createdAt).toLocaleTimeString()}${call.legacy ? ' · Saved result' : ` · ${duration(call.request.createdAt, call.result?.createdAt)}`}`"
      :loading="running && !call.result && !call.legacy"
      :unmount-on-hide="true"
      variant="card"
      class="min-w-0"
      :ui="{
        root: 'rounded-xl border border-line bg-raised',
        trigger: 'cursor-pointer flex-wrap px-3 py-2 text-xs',
        body: 'flex min-w-0 flex-col gap-3 p-3',
      }"
      data-tool-call
    >
      <div class="flex min-w-0 flex-col gap-1">
        <span class="text-xs font-medium text-muted">{{
          call.legacy ? 'Saved result' : 'Request'
        }}</span>
        <UiDataBlock :value="call.request.details ?? call.request.summary" />
        <span v-if="call.request.truncated" class="text-xs text-muted"
          >Request exceeds the 100,000-character saved limit.</span
        >
      </div>
      <div v-if="call.result" class="flex min-w-0 flex-col gap-1">
        <span class="text-xs font-medium text-muted">Result</span>
        <UiDataBlock :value="call.result.details ?? call.result.summary" />
        <span v-if="call.result.truncated" class="text-xs text-muted"
          >Result exceeds the 100,000-character saved limit.</span
        >
      </div>
    </UChatTool>
  </UChatTool>
</template>
