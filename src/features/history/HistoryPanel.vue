<script setup lang="ts">
import { vScrollFade } from '../../ui/scroll-fade';
import UiCollapsible from '../../ui/UiCollapsible.vue';
import {
  PhArrowUUpLeft as Undo2,
  PhCopy as Copy,
  PhArrowCounterClockwise as RotateCcw,
  PhUploadSimple as Upload,
  PhClock as Clock3,
} from '@phosphor-icons/vue';
import UiButton from '../../ui/UiButton.vue';
import SavedSessionPanel from './SavedSessionPanel.vue';
import EmptyState from '../../ui/EmptyState.vue';
import UTabs from '@nuxt/ui/components/Tabs.vue';
import { ref, computed, watch } from 'vue';
const activeTab = ref('changes');
const importInput = ref<HTMLInputElement>();
import { useDialog } from '../../stores/dialog';
import { useWorkspace } from '../../stores/workspace';
import AssistantChangeHistory from '../assistant/AssistantChangeHistory.vue';
import { rpc } from '../../shared/rpc';
import type { Operation } from '../../shared/types';
const store = useWorkspace();
const dialog = useDialog();
const pageSize = 25;
const changePage = ref(0),
  snapshotPage = ref(0);
const expandedResults = ref(new Set<string>());
const operationDetails = ref(new Map<string, Operation>());
const changes = computed(() =>
  (store.app?.operations || []).slice(
    changePage.value * pageSize,
    (changePage.value + 1) * pageSize,
  ),
);
const snapshots = computed(() =>
  (store.app?.snapshots || []).slice(
    snapshotPage.value * pageSize,
    (snapshotPage.value + 1) * pageSize,
  ),
);
const currentPage = computed(() =>
  activeTab.value === 'changes' ? changePage.value : snapshotPage.value,
);
const recordCount = computed(() =>
  activeTab.value === 'changes'
    ? store.app?.operations.length || 0
    : store.app?.snapshots.length || 0,
);
const pageCount = computed(() => Math.max(1, Math.ceil(recordCount.value / pageSize)));
watch(
  () => store.app?.operations.length,
  (length) => {
    changePage.value = Math.min(
      changePage.value,
      Math.max(0, Math.ceil((length || 0) / pageSize) - 1),
    );
  },
);
watch(
  () => store.app?.snapshots.length,
  (length) => {
    snapshotPage.value = Math.min(
      snapshotPage.value,
      Math.max(0, Math.ceil((length || 0) / pageSize) - 1),
    );
  },
);
function changeHistoryPage(offset: number) {
  if (activeTab.value === 'changes') changePage.value += offset;
  else snapshotPage.value += offset;
}
async function toggleResults(id: string, expanded: boolean) {
  const open = new Set(expandedResults.value);
  if (expanded) open.add(id);
  else open.delete(id);
  expandedResults.value = open;
  if (expanded) {
    await store.run(async () => {
      const operation = await rpc('operationDetails', { id });
      if (!operation) throw new Error('This operation is no longer available.');
      operationDetails.value.set(id, operation);
    });
  }
}
async function restore(id: string, copy = false) {
  if (
    !(await dialog.ask(
      copy ? 'Open a suspended copy?' : 'Restore this arrangement?',
      [],
      copy
        ? 'Tabs reopen in new windows as lightweight placeholders.'
        : 'Existing matching tabs are rearranged. Later tabs are preserved.',
      'Restore',
    ))
  )
    return;
  await store.run(async () => {
    const result = await rpc('restore', { id, newWindows: copy });
    const failed = result.filter((r) => !r.ok);
    store.notify(
      failed.length ? `${failed.length} items failed: ${failed[0]?.error}` : 'Snapshot restored',
    );
    await store.refresh();
  });
}
async function undo(id: string) {
  const copying =
    store.app?.operations.find((operation) => operation.id === id)?.kind === 'collection-copy';
  if (
    !(await dialog.ask(
      'Undo this operation?',
      [],
      copying
        ? 'Remove only untouched sleeping copies created by this organization. Original tabs, later tabs and changed/protected copies stay.'
        : 'Restore the prior arrangement. Later tabs are preserved.',
      'Undo',
    ))
  )
    return;
  await store.run(async () => {
    const result = await rpc('undo', { id });
    store.notify(
      result.every((r) => r.ok) ? 'Arrangement restored' : 'Some items failed to restore',
    );
    await store.refresh();
  });
}
async function redo(id: string) {
  if (
    !(await dialog.ask(
      'Redo this operation?',
      [],
      'Apply the operation again only if its targets still match the state left by Undo.',
      'Redo',
    ))
  )
    return;
  await store.run(async () => {
    const operation = await rpc('redo', { id });
    store.notify(operation.pauseReason || operation.summary);
    await store.refresh();
  });
}
async function importFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  await store.run(async () => {
    const result = await store.importBackupFile(file);
    store.notify(
      `${result.imported} snapshots imported.${result.assistantImported ? ' Chats and drafts imported with actions disabled. Restore tabs explicitly before continuing analysis.' : ' Choose Restore or As copy.'}`,
    );
    await store.refresh();
  });
  input.value = '';
}
</script>
<template>
  <div class="flex max-w-4xl flex-col gap-5">
    <SavedSessionPanel />
    <p class="text-xs text-muted">
      Manual backups include chats, drafts and analysis progress. Credentials and approval
      permissions are excluded. Imported action history is read-only; tabs are restored separately.
    </p>
    <UTabs
      v-model="activeTab"
      v-scroll-fade
      data-horizontal-tabs
      :items="[
        { label: 'Changes', value: 'changes' },
        { label: 'Snapshots', value: 'snapshots' },
      ]"
      :content="false"
      variant="link"
      color="neutral"
      class="w-fit"
    />
    <div class="flex flex-wrap items-center justify-between gap-3">
      <p class="text-xs leading-6 text-muted">
        Restore arrangements and missing tabs. New copies start suspended.
      </p>
      <UiButton size="small" :disabled="store.backupBusy" @click="importInput?.click()"
        ><Upload class="size-3.5" />Import JSON</UiButton
      >
      <input
        ref="importInput"
        class="hidden"
        type="file"
        accept=".json,application/json"
        @change="importFile"
      />
    </div>
    <p v-if="store.backupProgress" class="text-xs text-muted" role="status">
      {{ store.backupProgress }}
    </p>
    <section v-if="activeTab === 'changes'" class="flex flex-col gap-3">
      <h2 class="text-sm font-semibold">Changes</h2>
      <AssistantChangeHistory />
      <EmptyState
        v-if="!store.app?.operations.length && !store.app?.assistantChanges?.length"
        title="No changes yet"
        description="Applied tab arrangements and their recovery actions appear here."
      />
      <article
        v-for="op in changes"
        :key="op.id"
        class="flex flex-wrap items-start gap-4 border-b border-line py-3"
      >
        <UiButton v-if="op.canRedo" size="small" @click="redo(op.id)">Redo</UiButton>
        <div class="flex min-w-0 flex-1 flex-col gap-2">
          <h3 class="text-xs font-medium whitespace-pre-wrap">{{ op.summary }}</h3>
          <span v-if="op.provenance?.author === 'ai'" class="text-xs text-muted"
            >AI proposal applied by you{{
              op.provenance.model ? ` · ${op.provenance.model}` : ''
            }}</span
          >
          <p class="text-xs text-muted">
            {{ new Date(op.createdAt).toLocaleString() }} · {{ op.status }} ·
            {{
              op.kind === 'collection-copy'
                ? 'copied project windows'
                : op.kind === 'extension-update'
                  ? 'extension update'
                  : op.actionCount + ' actions'
            }}
          </p>
          <UiCollapsible
            class="text-xs leading-6 text-muted"
            :open="expandedResults.has(op.id)"
            @update:open="toggleResults(op.id, $event)"
            ><template #label>Results</template>
            <div v-if="expandedResults.has(op.id)" class="flex flex-col gap-1 py-2">
              <template v-if="op.kind === 'collection-copy'">
                <p>Original windows and groups retained.</p>
                <p
                  v-for="entry in store.app?.collectionProposals.find(
                    (proposal) => proposal.id === op.collectionProposalId,
                  )?.copyState?.entries"
                  :key="entry.recordId"
                >
                  {{ store.records.find((record) => record.id === entry.sourceRecordId)?.title }}:
                  {{ entry.error || (entry.created ? 'Copy created' : 'Pending') }}
                </p>
              </template>
              <p v-if="op.kind !== 'collection-copy' && !operationDetails.has(op.id)" role="status">
                Loading results…
              </p>
              <p v-for="(result, index) in operationDetails.get(op.id)?.results" :key="index">
                {{ op.kind === 'extension-update' ? 'Update' : result.action.type }}:
                {{ result.ok ? 'OK' : result.error
                }}<span v-for="(outcome, j) in result.outcomes?.filter((o) => o.skipped)" :key="j">
                  · {{ outcome.skipped }}</span
                >
              </p>
            </div>
          </UiCollapsible>
        </div>
        <span v-if="op.recoveryAvailable === false" class="text-xs text-muted"
          >Recovery snapshot expired</span
        >
        <UiButton
          v-if="
            op.status !== 'undone' &&
            op.recoveryAvailable !== false &&
            !(op.queued && op.status === 'running') &&
            op.kind !== 'session-resume' &&
            op.kind !== 'extension-update' &&
            op.tabCommand?.command !== 'reload' &&
            op.status !== 'running'
          "
          size="small"
          @click="undo(op.id)"
          ><Undo2 class="size-3.5" />Undo</UiButton
        >
      </article>
    </section>
    <section v-else class="flex flex-col gap-3">
      <h2 class="text-sm font-semibold">Snapshots</h2>
      <EmptyState
        v-if="!store.app?.snapshots.length"
        title="No snapshots yet"
        description="Save a snapshot from the toolbar to record your current windows and tabs."
      />
      <article
        v-for="s in snapshots"
        :key="s.id"
        class="flex flex-wrap items-center gap-4 border-b border-line py-3"
      >
        <Clock3 class="size-4 shrink-0 text-muted" />
        <div class="flex min-w-0 flex-1 flex-col gap-1.5">
          <h3 class="truncate text-xs font-medium">{{ s.label }}</h3>
          <p class="text-xs text-muted">
            {{ new Date(s.createdAt).toLocaleString() }} · {{ s.windowCount }} windows ·
            {{ s.tabCount }} tabs
          </p>
        </div>
        <div class="flex gap-2">
          <UiButton size="small" @click="restore(s.id)"
            ><RotateCcw class="size-3" />Restore</UiButton
          ><UiButton size="small" @click="restore(s.id, true)"
            ><Copy class="size-3" />As copy</UiButton
          >
        </div>
      </article>
    </section>
    <div v-if="pageCount > 1" class="flex items-center justify-between gap-3 text-xs text-muted">
      <span>{{ recordCount }} records · Page {{ currentPage + 1 }} of {{ pageCount }}</span>
      <div class="flex gap-2">
        <UiButton
          size="small"
          variant="ghost"
          :disabled="currentPage === 0"
          @click="changeHistoryPage(-1)"
          >Previous</UiButton
        >
        <UiButton
          size="small"
          variant="ghost"
          :disabled="currentPage + 1 >= pageCount"
          @click="changeHistoryPage(1)"
          >Next</UiButton
        >
      </div>
    </div>
  </div>
</template>
