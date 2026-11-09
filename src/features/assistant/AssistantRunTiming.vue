<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useNow, useIntervalFn } from '@vueuse/core';
import { liveQuery } from 'dexie';
import { database } from '../../core/db';
import type { AssistantMessage } from '../../shared/assistant/assistant';
import type { InferenceReceipt } from '../../shared/inference/inference-receipt';
import type { CollectionAnalysis } from '../../shared/types';
const props = defineProps<{ message: AssistantMessage }>();
const now = useNow({ scheduler: (callback) => useIntervalFn(callback, 1000) });
const receipts = ref<InferenceReceipt[]>([]);
const analysis = ref<CollectionAnalysis>();
const tagged = ref(0);
watch(
  () =>
    props.message.deliveryStatus === 'generating' || props.message.analysisFailure
      ? props.message.collectionAnalysisId
      : undefined,
  (id, _, cleanup) => {
    analysis.value = undefined;
    tagged.value = 0;
    if (!id) return;
    const subscription = liveQuery(async () => {
      const saved = await database.collectionAnalyses.get(id);
      const completed = new Set<string>();
      if (saved?.taggingRequested)
        await database.tagAnalyses
          .where('analysisId')
          .equals(id)
          .each((row) => {
            if (row.status === 'complete') completed.add(row.recordId);
          });
      return { analysis: saved, tagged: completed.size };
    }).subscribe((value) => {
      analysis.value = value.analysis;
      tagged.value = value.tagged;
    });
    cleanup(() => subscription.unsubscribe());
  },
  { immediate: true },
);
const progress = computed(() => {
  const value = analysis.value;
  if (!value) return '';
  const total = value.scope.length;
  const skipped = value.skippedRecordIds?.length || 0;
  const stage =
    !value.reuseAcceptedTaxonomyOnly && value.discoveredIds.length < total
      ? `Discovery ${value.discoveredIds.length - skipped}/${total - skipped}`
      : value.classifiedIds.length < total
        ? `Categories ${Math.max(0, value.classifiedIds.length - skipped)}/${total - skipped}`
        : value.taggingRequested
          ? `Tags ${tagged.value}/${total - skipped - (value.skippedTagRecordIds?.length || 0)}`
          : `Categories ${total - skipped}/${total - skipped} saved`;
  return `${stage}${skipped ? ` · ${skipped} skipped` : ''}${value.skippedTagRecordIds?.length ? ` · ${value.skippedTagRecordIds.length} tag skips` : ''}${value.failedBatch ? ` · ${value.failedBatch.recordIds.length} failed in ${value.failedBatch.stage} after ${value.failedBatch.attempts} attempts` : ''}`;
});
watch(
  () =>
    props.message.deliveryStatus === 'generating'
      ? props.message.collectionAnalysisId || props.message.actionAnalysisId
      : undefined,
  (id, _, cleanup) => {
    receipts.value = [];
    if (!id) return;
    const subscription = liveQuery(() =>
      database.inferenceReceipts
        .where('[analysisId+startedAt]')
        .between([id, 0], [id, Number.MAX_SAFE_INTEGER])
        .reverse()
        .limit(100)
        .toArray(),
    ).subscribe((value) => (receipts.value = value));
    cleanup(() => subscription.unsubscribe());
  },
  { immediate: true },
);
function duration(ms: number) {
  const sec = Math.max(0, Math.round(ms / 1000));
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`;
}
const elapsed = computed(() =>
  duration(
    (props.message.completedAt ??
      (props.message.deliveryStatus === 'generating' ? +now.value : props.message.createdAt)) -
      props.message.createdAt,
  ),
);
const estimate = computed(() => {
  if (props.message.deliveryStatus !== 'generating') return '';
  const ordered = [...receipts.value].sort((a, b) => a.finishedAt - b.finishedAt);
  const latest = ordered.at(-1);
  if (!latest) return '';
  const samples = ordered.filter(
    (r) => r.stage === latest.stage && r.outcome === 'responded' && r.occurrenceIds?.length,
  );
  const range = [...props.message.activity]
    .reverse()
    .map((text) => text.match(/\b(\d+)[–-](\d+) of (\d+)/))
    .find(Boolean);
  const total = Number(range?.[3] || 0);
  const completed = Math.max(0, Number(range?.[1] || 1) - 1);
  if (samples.length < 2 || !completed || total <= completed) return '';
  const window = samples.slice(-8);
  const covered = new Set(window.flatMap((r) => r.occurrenceIds || [])).size;
  const rate =
    Math.max(
      0,
      Math.max(...window.map((r) => r.finishedAt)) - Math.min(...window.map((r) => r.startedAt)),
    ) / covered;
  return `About ${duration((total - completed) * rate)} remaining in ${latest.stage}`;
});
</script>
<template>
  <div
    v-if="
      message.role === 'assistant' &&
      (message.deliveryStatus === 'generating' || message.completedAt || progress)
    "
    class="flex flex-wrap gap-3 text-xs text-muted"
    role="status"
  >
    <span v-if="message.deliveryStatus === 'generating' || message.completedAt"
      >{{ elapsed }} {{ message.deliveryStatus === 'generating' ? 'elapsed' : 'total' }}</span
    ><span v-if="estimate">{{ estimate }}</span>
    <span v-if="progress">{{ progress }}</span>
  </div>
</template>
