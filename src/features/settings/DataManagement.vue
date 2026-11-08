<script setup lang="ts">
import { ref } from 'vue';
import UiButton from '../../ui/UiButton.vue';
import { useDialog } from '../../stores/dialog';
import { useWorkspace } from '../../stores/workspace';
import { rpc, type RpcMap } from '../../shared/rpc';
const store = useWorkspace(),
  dialog = useDialog(),
  busy = ref(false);
type Kind = RpcMap['deleteLocalData']['payload']['kind'];
const choices: { kind: Kind; label: string; detail: string }[] = [
  {
    kind: 'cache',
    label: 'Clear page cache and previews',
    detail:
      'Remove captured page text and tab screenshots. Keep tabs, labels, notes, chats and saved arrangements.',
  },
  {
    kind: 'analysis',
    label: 'Delete chats and analysis progress',
    detail:
      'Remove saved conversations, inference requests and unfinished analysis. Keep saved organization drafts and recovery journals.',
  },
  {
    kind: 'history',
    label: 'Delete snapshot and change history',
    detail:
      'Remove snapshots, operation journals and their Undo/Redo. Keep the current saved session and open tabs.',
  },
  {
    kind: 'organization',
    label: 'Clear organization',
    detail:
      'Remove projects, categories, tags, notes and organization drafts. Keep browser tabs and native groups. Saved history may still contain earlier organization.',
  },
  {
    kind: 'all',
    label: 'Reset TabFlow',
    detail:
      'Delete all local TabFlow history, organization, chats, model credentials and preferences. Open browser tabs remain available, including sleeping tabs. Downloaded backups and browser permission grants are separate.',
  },
];
async function remove(choice: (typeof choices)[number]) {
  const values = await dialog.ask(
    choice.label,
    [{ name: 'confirmation', label: 'Type DELETE to confirm' }],
    `${choice.detail} This cannot be undone. Stop active work first.`,
    choice.label,
  );
  if (!values) return;
  if (values.confirmation !== 'DELETE') {
    store.notify('Type DELETE exactly to confirm deletion.', true);
    return;
  }
  busy.value = true;
  await store.run(async () => {
    await rpc('deleteLocalData', { kind: choice.kind, confirmation: 'DELETE' });
    if (choice.kind === 'all')
      for (const key of Object.keys(localStorage))
        if (/^(tabflow|tabloom)\./.test(key)) localStorage.removeItem(key);
    location.reload();
  });
  busy.value = false;
}
</script>
<template>
  <section class="flex min-w-0 flex-col gap-4">
    <h2 class="text-sm font-semibold">Data management</h2>
    <p class="text-xs text-muted">
      Export a backup before deleting data you may need. These actions leave your native browser
      tabs open.
    </p>
    <UiButton
      class="self-start"
      size="small"
      :disabled="busy || store.backupBusy"
      @click="store.run(store.exportBackup)"
      >Export backup</UiButton
    >
    <p v-if="store.backupProgress" class="text-xs text-muted" role="status">
      {{ store.backupProgress }}
    </p>
    <div
      v-for="choice in choices"
      :key="choice.kind"
      class="flex min-w-0 flex-col gap-2 border-b border-line py-3"
    >
      <p class="text-xs text-muted">{{ choice.detail }}</p>
      <UiButton
        class="self-start"
        size="small"
        variant="ghost"
        :disabled="busy || store.backupBusy"
        @click="remove(choice)"
        >{{ choice.label }}</UiButton
      >
    </div>
  </section>
</template>
