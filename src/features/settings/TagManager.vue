<script setup lang="ts">
import { computed, ref } from 'vue';
import { refDebounced } from '@vueuse/core';
import UiButton from '../../ui/UiButton.vue';
import UiSearchInput from '../../ui/UiSearchInput.vue';
import { useWorkspace } from '../../stores/workspace';
import { useDialog } from '../../stores/dialog';
import { rpc } from '../../shared/rpc';
import { workspaceEditBaseline, type WorkspaceEdit } from '../../shared/workspace/workspace-edits';
const store = useWorkspace(),
  dialog = useDialog();
const query = ref(''),
  settled = refDebounced(query, 160),
  limit = ref(50);
const lastChange = ref(''),
  undone = ref(false);
const labels = computed(() =>
  store.tagVocabulary.filter((label) =>
    label.toLocaleLowerCase().includes(settled.value.toLocaleLowerCase()),
  ),
);
function count(label: string) {
  return store.records.filter(
    (record) => record.live && !record.locked && record.tags.includes(label),
  ).length;
}
async function change(label: string, remove: boolean) {
  const values = await dialog.ask(
    remove ? `Delete tag ${label}?` : `Rename tag ${label}`,
    remove ? [] : [{ name: 'name', label: 'New tag name', value: label }],
    `Updates ${count(label)} open, unprotected tabs. Other tags and project/category assignments are retained.`,
    remove ? 'Delete tag' : 'Rename tag',
  );
  if (!values) return;
  const next = remove ? null : values.name?.trim();
  if (!remove && (!next || next.length > 80))
    throw new Error('Use a tag name between 1 and 80 characters.');
  if (next === label) return;
  await store.run(async () => {
    if (!store.app) return;
    const records = store.records.filter(
      (record) => record.live && !record.locked && record.tags.includes(label),
    );
    const edits: WorkspaceEdit[] = records.map((record) => ({
      kind: 'tags',
      recordId: record.id,
      mode: 'replace',
      tags: [...record.tags.filter((tag) => tag !== label), ...(next ? [next] : [])],
    }));
    if (!edits.length) return;
    const change = await rpc('executeWorkspaceEdit', {
      kind: 'workspace_edits',
      summary: `${remove ? 'Delete' : 'Rename'} tag ${label}${next ? ` to ${next}` : ''}`,
      edits: edits.map((edit) => ({ edit, before: workspaceEditBaseline(store.app!, edit) })),
    });
    lastChange.value = change.id;
    undone.value = false;
    await store.refresh();
  });
}
async function restore() {
  await store.run(async () => {
    const result = await rpc(undone.value ? 'redoAssistantChange' : 'undoAssistantChange', {
      id: lastChange.value,
    });
    undone.value = result.status === 'undone';
    store.notify(result.outcome);
    await store.refresh();
  });
}
</script>
<template>
  <section class="flex min-w-0 flex-col gap-3">
    <h2 class="text-sm font-semibold">Tags</h2>
    <p class="text-xs text-muted">
      Manage labels on open, unprotected tabs. Draft suggestions are edited in their proposal.
    </p>
    <UiSearchInput v-model="query" label="Find tag to manage" placeholder="Find a tag…" /><UiButton
      v-if="lastChange"
      size="small"
      variant="ghost"
      class="self-start"
      @click="restore"
      >{{ undone ? 'Redo tag change' : 'Undo tag change' }}</UiButton
    >
    <div
      v-for="label in labels.slice(0, limit)"
      :key="label"
      class="flex min-w-0 flex-wrap items-center gap-2 border-b border-line py-2"
    >
      <span class="min-w-0 flex-1 break-words text-sm">{{ label }}</span
      ><span class="text-xs text-muted">{{ count(label) }} tabs</span
      ><UiButton
        size="small"
        variant="ghost"
        :disabled="!count(label)"
        @click="store.run(() => change(label, false))"
        >Rename</UiButton
      ><UiButton
        size="small"
        variant="ghost"
        :disabled="!count(label)"
        @click="store.run(() => change(label, true))"
        >Delete</UiButton
      >
    </div>
    <UiButton v-if="labels.length > limit" size="small" @click="limit += 50">More tags</UiButton>
  </section>
</template>
