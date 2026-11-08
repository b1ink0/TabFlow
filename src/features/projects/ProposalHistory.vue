<script setup lang="ts">
import { ref, watch } from 'vue';
import UiDisclosure from '../../ui/UiDisclosure.vue';
import UiButton from '../../ui/UiButton.vue';
import { rpc } from '../../shared/rpc';
import { tagHash } from '../../shared/tag-analysis';
import type { CollectionProposal, ProposalRevisionSummary } from '../../shared/types';
const props = defineProps<{ proposal: CollectionProposal; disabled?: boolean }>();
const emit = defineEmits<{ restored: [] }>();
const open = ref(false),
  busy = ref(false),
  offset = ref(0),
  error = ref('');
const rows = ref<ProposalRevisionSummary[]>([]);
async function load() {
  if (!open.value) return;
  try {
    rows.value = await rpc('listProposalRevisions', {
      proposalId: props.proposal.id,
      offset: offset.value,
    });
    error.value = '';
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}
watch([open, offset, () => props.proposal.updatedAt, () => props.proposal.id], load);
watch(
  () => props.proposal.id,
  () => {
    offset.value = 0;
  },
);
async function restore(row: ProposalRevisionSummary, direction: 'undo' | 'redo') {
  busy.value = true;
  try {
    await rpc('restoreProposalRevision', {
      id: row.id,
      direction,
      expectedFingerprint: await tagHash(props.proposal),
    });
    emit('restored');
    await load();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <UiDisclosure v-model:open="open" label="Draft history">
    <p class="text-xs text-muted">
      Undo or redo saved draft edits. Save or reload local edits first. Applied organization has
      separate Undo.
    </p>
    <p v-if="error" role="alert" class="text-xs text-muted">{{ error }}</p>
    <div
      v-for="row in rows"
      :key="row.id"
      class="flex flex-wrap items-center gap-2 px-3 py-2 text-xs"
    >
      <span class="min-w-0 flex-1"
        >{{ row.label }} · {{ new Date(row.createdAt).toLocaleString() }}</span
      >
      <UiButton
        size="small"
        variant="ghost"
        :disabled="disabled || busy || !row.canUndo"
        @click="restore(row, 'undo')"
        >Undo draft edit</UiButton
      >
      <UiButton
        size="small"
        variant="ghost"
        :disabled="disabled || busy || !row.canRedo"
        @click="restore(row, 'redo')"
        >Redo draft edit</UiButton
      >
    </div>
    <p v-if="!rows.length" class="text-xs text-muted">No saved draft edits.</p>
    <div class="flex items-center gap-2">
      <UiButton size="small" variant="ghost" :disabled="!offset || busy" @click="offset -= 20"
        >Previous</UiButton
      >
      <UiButton
        size="small"
        variant="ghost"
        :disabled="rows.length < 20 || busy"
        @click="offset += 20"
        >Next</UiButton
      >
    </div>
  </UiDisclosure>
</template>
