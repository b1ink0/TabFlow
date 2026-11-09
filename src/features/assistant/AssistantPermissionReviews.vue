<script setup lang="ts">
import { ref, watch } from 'vue';
import UiButton from '../../ui/UiButton.vue';
import UiCollapsible from '../../ui/UiCollapsible.vue';
import UiDataBlock from '../../ui/UiDataBlock.vue';
import { rpc } from '../../shared/rpc';
import { useWorkspace } from '../../stores/workspace';
import type { PermissionReviewSummary } from '../../shared/assistant/permission-review';
const props = defineProps<{
  messageId: string;
  ids: string[];
  revision?: number;
  canReview?: boolean;
}>();
defineEmits<{ review: [] }>();
const store = useWorkspace();
const reviews = ref<PermissionReviewSummary[]>([]);
const details = ref(new Map<string, string>());
watch(
  () => [props.messageId, props.ids.join(','), props.revision],
  () => {
    if (props.ids.length)
      void store.run(async () => {
        reviews.value = await rpc('listPermissionReviews', { messageId: props.messageId });
      });
  },
  { immediate: true },
);
async function load(id: string, open: boolean) {
  if (!open) return;
  await store.run(async () => {
    const value = await rpc('permissionReviewDetails', { id });
    if (value) details.value.set(id, value.packet);
  });
}
</script>
<template>
  <div v-if="reviews.length" class="flex flex-col gap-2" aria-label="Permission reviews">
    <article
      v-for="review in reviews"
      :key="review.id"
      class="flex flex-col gap-2 rounded-md border border-line-strong bg-raised px-3 py-2 text-xs"
      role="status"
    >
      <div class="flex flex-wrap items-center justify-between gap-2">
        <strong>{{
          review.status === 'pending'
            ? 'Reviewing permission'
            : review.decision === 'allow'
              ? 'Orchestrator approved'
              : review.decision === 'deny'
                ? 'Orchestrator declined'
                : 'Your approval is needed'
        }}</strong
        ><span class="text-muted">{{ review.usedAt ? 'Used once' : 'Not executed' }}</span>
      </div>
      <p>{{ review.reason }}</p>
      <span v-if="review.model" class="text-muted">{{ review.model }}</span>
      <UiCollapsible @update:open="load(review.id, $event)"
        ><template #label>Reviewed request and effects</template
        ><UiDataBlock v-if="details.has(review.id)" :value="details.get(review.id)!"
      /></UiCollapsible>
      <UiButton
        v-if="canReview && review.decision === 'ask' && review.status !== 'pending'"
        size="small"
        variant="ghost"
        class="self-start"
        @click="$emit('review')"
        >Review again</UiButton
      >
    </article>
  </div>
</template>
