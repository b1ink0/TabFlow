<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted } from 'vue';
import { PhDownloadSimple as Download, PhArrowsClockwise as RefreshCw } from '@phosphor-icons/vue';
import UiButton from '../../ui/UiButton.vue';
import PageSection from '../../ui/PageSection.vue';
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
    return 'Review missing session tabs before updating.';
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
  <div class="flex min-w-0 max-w-3xl flex-col">
    <PageSection
      title="Activate a new build"
      description="Production runs on its own. No development server is needed."
    >
      <ol class="flex flex-col gap-5 text-[13px] leading-6 text-secondary">
        <li class="flex items-start gap-3">
          <span class="text-muted">1.</span>
          <div class="flex flex-col gap-1">
            <span class="font-medium text-ink">Build or replace the production files</span
            ><span
              >Run
              <code class="rounded bg-raised px-1.5 py-0.5 text-xs text-ink">bun run build</code>
              for a local checkout, or replace the release files in the folder your browser already
              loads. This does not activate them yet.</span
            >
          </div>
        </li>
        <li class="flex items-start gap-3">
          <span class="text-muted">2.</span>
          <div class="flex flex-col gap-1">
            <span class="font-medium text-ink">Save your work and keep a backup</span
            ><span
              >Save settings and other unsaved app edits. Finish inspections and AI runs. Export
              your collection before updating.</span
            ><UiButton
              class="self-start"
              size="small"
              variant="ghost"
              :disabled="busy || !!update || store.backupBusy"
              @click="store.run(store.exportBackup)"
              ><Download class="size-3.5" />Export backup</UiButton
            >
          </div>
        </li>
        <li class="flex items-start gap-3">
          <span class="text-muted">3.</span>
          <div class="flex flex-col gap-1">
            <span class="font-medium text-ink">Let TabFlow prepare and reload</span
            ><span
              >Its own pages briefly show a browser-owned page, then return in the same tab slots.
              Websites stay open and sleeping websites stay asleep. Leave temporary pages open until
              the update finishes.</span
            >
          </div>
        </li>
      </ol>
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
        <p class="text-[13px] text-secondary">
          {{ completion.restored }} pages returned to their saved addresses<span
            v-if="completion.retained"
          >
            · {{ completion.retained }} independently changed pages kept</span
          >. Your native tabs and groups remain in place.
        </p>
        <p class="text-xs text-muted">
          Completed {{ new Date(completion.finishedAt).toLocaleString() }}.
        </p>
        <div class="flex flex-col gap-1 pt-2 text-[13px] text-secondary">
          <span class="font-medium text-ink">What changed in this build</span>
          <span>Faster update preparation and return for large collections.</span>
          <span>Visible restoration progress after TabFlow reloads.</span>
          <span>Retry and resume for interrupted assistant requests.</span>
        </div>
      </div>
      <p v-if="blocked && !update" class="text-[13px] text-secondary" role="status">
        {{ blocked }}
      </p>
      <div class="flex flex-wrap items-center gap-3">
        <UiButton
          v-if="update && update.stage === 'interrupted'"
          variant="primary"
          :disabled="busy"
          @click="runUpdate(true)"
          ><RefreshCw class="size-4" />{{ busy ? 'Updating…' : 'Finish update' }}</UiButton
        >
        <UiButton
          v-else-if="!update"
          variant="primary"
          :disabled="busy || store.loading || !!blocked"
          @click="runUpdate()"
          ><RefreshCw class="size-4" />{{ busy ? 'Preparing update…' : 'Save & reload' }}</UiButton
        >
        <UiButton
          v-if="store.app?.session?.missingTabs && !update"
          variant="ghost"
          @click="store.show('tabs')"
          >Review missing tabs</UiButton
        >
        <UiButton variant="ghost" :disabled="busy" @click="store.show('timeline')"
          >View recovery history</UiButton
        >
      </div>
    </PageSection>
    <p class="py-4 text-xs leading-5 text-muted">
      Use this control instead of the browser’s extension Reload button. Browser side panels may
      need reopening; unsaved app drafts are not preserved by a reload.
    </p>
  </div>
</template>
