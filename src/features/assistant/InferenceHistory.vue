<script setup lang="ts">
import UiDataBlock from '../../ui/UiDataBlock.vue';
import UiCollapsible from '../../ui/UiCollapsible.vue';
import { ref, watch } from 'vue';
import { liveQuery } from 'dexie';
import { database } from '../../core/db';
import type { InferenceReceipt } from '../../shared/inference-receipt';
import UiButton from '../../ui/UiButton.vue';
const props = defineProps<{ analysisId: string }>();
const open = ref(false),
  page = ref(0),
  total = ref(0),
  entries = ref<InferenceReceipt[]>([]),
  error = ref('');
watch([open, page, () => props.analysisId], (_value, _old, onCleanup) => {
  if (!open.value) return;
  const subscription = liveQuery(async () => ({
    total: await database.inferenceReceipts.where('analysisId').equals(props.analysisId).count(),
    entries: await database.inferenceReceipts
      .where('[analysisId+startedAt]')
      .between([props.analysisId, 0], [props.analysisId, Number.MAX_SAFE_INTEGER])
      .offset(page.value * 25)
      .limit(25)
      .toArray(),
  })).subscribe({
    next: (result) => {
      total.value = result.total;
      entries.value = result.entries;
    },
    error: (value) => {
      error.value = String(value);
    },
  });
  onCleanup(() => subscription.unsubscribe());
});
watch(
  () => props.analysisId,
  () => {
    page.value = 0;
    entries.value = [];
    total.value = 0;
  },
);
</script>
<template>
  <UiCollapsible class="text-xs text-muted" @update:open="open = $event"
    ><template #label>Inference requests</template>
    <div v-if="open" class="flex flex-col gap-2 pt-2">
      <p v-if="error" role="status">{{ error }}</p>
      <p v-else-if="!total">No saved requests for this analysis.</p>
      <UiCollapsible v-for="entry in entries" :key="entry.id"
        ><template #label>
          {{ new Date(entry.startedAt).toLocaleTimeString() }} · {{ entry.stage }} ·
          {{ entry.model }} · {{ ((entry.finishedAt - entry.startedAt) / 1000).toFixed(1) }}s ·
          {{ entry.outcome === 'responded' ? 'Response received' : 'Failed' }}
        </template>
        <div class="flex flex-col gap-2 py-2">
          <span
            >{{ entry.contract
            }}<template v-if="entry.occurrenceIds?.length">
              · {{ entry.occurrenceIds.join(', ') }}</template
            ></span
          >
          <span>Request</span>
          <UiDataBlock :value="entry.request" />
          <span>{{ entry.error ? 'Error' : 'Response' }}</span>
          <UiDataBlock :value="entry.error || entry.response" />
        </div>
      </UiCollapsible>
      <div v-if="total" class="flex items-center gap-2">
        <UiButton size="small" variant="ghost" :disabled="page === 0" @click="page--"
          >Previous</UiButton
        >
        <span>{{ page * 25 + 1 }}–{{ Math.min(total, (page + 1) * 25) }} of {{ total }}</span>
        <UiButton size="small" variant="ghost" :disabled="(page + 1) * 25 >= total" @click="page++"
          >Next</UiButton
        >
        <UiButton
          size="small"
          variant="ghost"
          @click="page = Math.max(0, Math.ceil(total / 25) - 1)"
          >Latest</UiButton
        >
      </div>
    </div>
  </UiCollapsible>
</template>
