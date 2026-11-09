<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted } from 'vue';
import { PhDownloadSimple as Download, PhArrowsClockwise as RefreshCw } from '@phosphor-icons/vue';
import UiButton from '../../ui/UiButton.vue';
import SavedSessionPanel from '../history/SavedSessionPanel.vue';
import UProgress from '@nuxt/ui/components/Progress.vue';
import { useWorkspace } from '../../stores/workspace';
import { useDialog } from '../../stores/dialog';
import { useAssistantConversations } from '../../stores/assistant';
import { rpc } from '../../shared/rpc';
import { sessionReloadSchema, summarizeUpdate, updateCompletionSchema } from '../../shared/model';
import type { UpdateSummary } from '../../shared/types';

const store = useWorkspace(),
  dialog = useDialog();
const busy = ref(false);
const conversations = useAssistantConversations();
const localProgress = ref<UpdateSummary | null>();
const completion = ref<ReturnType<typeof updateCompletionSchema.parse> | null>(null);
const update = computed(() => localProgress.value || (completion.value ? null : store.app?.update));
let reloadRevision = 0;
let completionRevision = 0;
function storageChanged(changes: Record<string, chrome.storage.StorageChange>, area: string) {
  if (area !== 'local') return;
  if (changes.sessionReload) {
    reloadRevision++;
    const ticket = sessionReloadSchema.safeParse(changes.sessionReload.newValue);
    localProgress.value = ticket.success ? summarizeUpdate(ticket.data) : null;
  }
  if (changes.updateCompletion) {
    completionRevision++;
    const result = updateCompletionSchema.safeParse(changes.updateCompletion.newValue);
    completion.value = result.success ? result.data : null;
  }
}
onMounted(async () => {
  chrome.storage.onChanged?.addListener(storageChanged);
  const initialReloadRevision = reloadRevision;
  const saved = await chrome.storage.local.get('sessionReload');
  const ticket = sessionReloadSchema.safeParse(saved.sessionReload);
  if (initialReloadRevision === reloadRevision)
    localProgress.value = ticket.success ? summarizeUpdate(ticket.data) : null;
  const initialCompletionRevision = completionRevision;
  const result = updateCompletionSchema.safeParse(
    (await chrome.storage.local.get('updateCompletion')).updateCompletion,
  );
  if (initialCompletionRevision === completionRevision)
    completion.value = result.success ? result.data : null;
});
onUnmounted(() => chrome.storage.onChanged?.removeListener(storageChanged));
const blocked = computed(() => {
  if (store.app?.session?.missingTabs && !update.value)
    return 'Resume missing tabs or keep the current session before reloading.';
  if (store.app?.jobs.some((job) => ['queued', 'running'].includes(job.status)))
    return 'Finish or cancel active inspections before updating.';
  if (store.app?.operations.some((operation) => operation.status === 'running') && !update.value)
    return 'Wait for the active browser operation to finish.';
  if (conversations.threads.some((thread) => thread.status === 'running'))
    return 'Finish or stop the assistant before updating.';
  return '';
});
const progressLabel = computed(() => {
  if (update.value?.stage === 'interrupted') return 'An unfinished update needs your attention.';
  if (update.value?.stage === 'restoring') return 'Returning tabs to their saved addresses…';
  if (!busy.value && update.value?.stage === 'preparing')
    return 'Preparing TabFlow pages for reload…';
  if (!busy.value) return 'Checking update progress…';
  if (!update.value) return 'Saving your session…';
  if (update.value.stage === 'ready') return 'Reloading TabFlow…';
  return 'Preparing TabFlow pages for reload…';
});
async function runUpdate(finish = false) {
  if (busy.value || (!finish && blocked.value)) return;
  if (
    !finish &&
    !(await dialog.ask(
      'Reload TabFlow with the new build?',
      [],
      'Build or replace production files first and save any unsaved app edits. TabFlow will save recovery data, prepare its pages, reload, and return them to their saved addresses. Keep temporary browser pages open.',
      'Save & reload',
    ))
  )
    return;
  busy.value = true;
  try {
    await rpc(finish ? 'finishUpdate' : 'reloadSafely', undefined);
    if (finish) {
      await store.refresh();
      store.notify(
        store.app?.update
          ? 'Some update pages still need attention. Review the errors before retrying.'
          : 'Update finished',
      );
      busy.value = false;
    }
    // Reload navigates this view away; keep controls disabled until it does.
  } catch (error) {
    busy.value = false;
    await store.run(async () => {
      throw error;
    });
    await store.run(store.refresh);
  }
}
</script>
<template>
  <div class="flex min-w-0 max-w-3xl flex-col gap-4">
    <p class="text-[13px] leading-6 text-secondary">
      Reload after replacing the extension files. Save any unsaved work first.
    </p>
    <SavedSessionPanel v-if="!update" recovery-only compact />
    <div
      v-if="busy || update"
      class="flex flex-col gap-3 rounded-md bg-raised p-4"
      role="status"
      aria-live="polite"
    >
      <p class="text-[13px] font-medium">{{ progressLabel }}</p>
      <template v-if="update">
        <UProgress
          :model-value="update.processed ?? update.total - update.remaining"
          :max="Math.max(1, update.total)"
          color="neutral"
          aria-label="TabFlow update progress"
        />
        <p class="text-xs text-muted">
          {{ update.processed ?? update.total - update.remaining }} / {{ update.total }} pages
          {{ update.stage === 'preparing' || update.stage === 'ready' ? 'prepared' : 'returned' }}
          <span v-if="update.stage !== 'preparing' && update.stage !== 'ready'">
            · {{ update.remaining }} remaining</span
          >
        </p>
        <p v-for="error in update.errors" :key="error" class="text-[13px] text-secondary">
          {{ error }}
        </p>
        <p
          v-if="!busy && update.stage === 'interrupted'"
          class="text-[13px] leading-5 text-secondary"
        >
          Finish update returns only saved temporary pages. Tabs you navigated elsewhere remain
          untouched. Afterwards, review any genuinely missing tabs separately.
        </p>
      </template>
    </div>
    <div
      v-if="!update && completion"
      class="flex flex-col gap-2 rounded-md bg-raised p-4"
      role="status"
    >
      <p class="text-[13px] font-medium text-ink">TabFlow updated and ready</p>
      <p class="text-xs text-muted">
        Completed {{ new Date(completion.finishedAt).toLocaleString() }}.
      </p>
    </div>
    <p
      v-if="blocked && !update && !store.app?.session?.missingTabs"
      class="text-[13px] text-secondary"
      role="status"
    >
      {{ blocked }}
    </p>
    <div class="flex flex-wrap items-center gap-3">
      <UiButton
        size="small"
        variant="ghost"
        :disabled="busy || !!update || store.backupBusy"
        @click="store.run(store.exportBackup)"
        ><Download class="size-3.5" />Export backup</UiButton
      >
      <UiButton
        v-if="update && update.stage === 'interrupted'"
        size="small"
        variant="primary"
        :disabled="busy"
        @click="runUpdate(true)"
        ><RefreshCw class="size-3.5" />{{ busy ? 'Updating…' : 'Finish update' }}</UiButton
      >
      <UiButton
        v-else-if="!update"
        size="small"
        variant="primary"
        :disabled="busy || store.loading || !!blocked"
        @click="runUpdate()"
        ><RefreshCw class="size-3.5" />{{ busy ? 'Preparing update…' : 'Save & reload' }}</UiButton
      >
      <UiButton size="small" variant="ghost" :disabled="busy" @click="store.show('timeline')"
        >View recovery history</UiButton
      >
    </div>
  </div>
</template>
