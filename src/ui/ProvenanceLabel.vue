<script setup lang="ts">
import { computed } from 'vue';
import { PhSparkle as Sparkles, PhUserCircle as UserRound } from '@phosphor-icons/vue';
import type { Provenance } from '../shared/types';
const props = defineProps<{
  provenance?: Provenance;
  source?: 'owner' | 'legacy' | 'accepted-ai' | 'unassigned' | 'inherited';
  assignment?: boolean;
  reason?: string;
  compact?: boolean;
}>();
const ai = computed(() => props.provenance?.author === 'ai' || props.source === 'accepted-ai');
const ownerCorrection = computed(() => props.source === 'owner');
const title = computed(() =>
  [
    ai.value ? 'AI draft accepted by you' : 'Your saved correction; AI will preserve it',
    props.provenance?.model,
    props.reason,
  ]
    .filter(Boolean)
    .join(' · '),
);
</script>
<template>
  <span
    v-if="ai || ownerCorrection"
    :title="title"
    class="inline-flex shrink-0 items-center gap-1 text-xs text-muted"
  >
    <Sparkles v-if="ai" class="size-3" /><UserRound v-else class="size-3" />
    <span :class="compact ? 'sr-only' : undefined">{{
      ai ? (assignment ? 'AI assigned' : 'AI created') : 'Your correction'
    }}</span>
  </span>
</template>
