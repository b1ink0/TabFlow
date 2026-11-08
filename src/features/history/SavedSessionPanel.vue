<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue';
import { useElementSize, useResizeObserver } from '@vueuse/core';
import {
  PhArrowCounterClockwise as RotateCcw,
  PhBookmarkSimple as Bookmark,
  PhArrowsClockwise as RefreshCw,
  PhFolderPlus as FolderPlus,
} from '@phosphor-icons/vue';
import UiButton from '../../ui/UiButton.vue';
import { useWorkspace } from '../../stores/workspace';
import { useDialog } from '../../stores/dialog';
import { rpc } from '../../shared/rpc';
const props = defineProps<{ recoveryOnly?: boolean; compact?: boolean; footer?: boolean }>();
const emit = defineEmits<{ createProject: [] }>();
const store = useWorkspace(),
  dialog = useDialog();
const saved = computed(() => store.app?.session);
const update = computed(() => store.app?.update);
const busy = ref(false);
const footerRow = ref<HTMLElement>(),
  footerActions = ref<HTMLElement>();
const { width: rowWidth } = useElementSize(footerRow);
const actionsWidth = ref(0);
function measureActions() {
  actionsWidth.value =
    [...(footerActions.value?.children || [])].reduce(
      (sum, element) => sum + element.getBoundingClientRect().width,
      0,
    ) +
    Math.max(0, (footerActions.value?.children.length || 0) - 1) * 4;
}
useResizeObserver(footerRow, measureActions);
useResizeObserver(footerActions, measureActions);
watch([() => saved.value?.missingTabs, () => Boolean(update.value), busy], () => {
  void nextTick(measureActions);
});
const showCounts = computed(
  () =>
    !props.footer || rowWidth.value - actionsWidth.value >= (saved.value?.missingTabs ? 320 : 190),
);
async function perform(task: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  try {
    await store.run(task);
  } finally {
    busy.value = false;
  }
}
async function resume() {
  if (
    !(await dialog.ask(
      'Resume missing tabs?',
      [],
      `${saved.value?.missingTabs || 0} saved occurrences reopen asleep. Existing tabs stay in place; surviving windows are reused where their identities match.`,
      'Resume',
    ))
  )
    return;
  await perform(async () => {
    const outcomes = await rpc('resumeSession', undefined);
    const failed = outcomes.filter((outcome) => !outcome.ok);
    store.notify(
      failed.length
        ? `${failed.length} recovery items failed. Check recovery history; Resume retries missing tabs.`
        : `${outcomes.length} missing tabs resumed`,
    );
    await store.refresh();
  });
}
async function save() {
  await perform(async () => {
    await rpc('saveSession', undefined);
    store.notify('Session saved');
    await store.refresh();
  });
}
async function keepCurrent() {
  if (
    !(await dialog.ask(
      'Keep the current session?',
      [],
      'Use the tabs that are open now as your session. The older recovery source is retained in Snapshots; its missing tabs will not be reopened.',
      'Keep current changes',
    ))
  )
    return;
  await perform(async () => {
    await rpc('saveSession', { replaceMissing: true });
    store.notify('Current session saved. The earlier recovery source remains in Snapshots.');
    await store.refresh();
  });
}
function reload() {
  store.show('update');
}
function finish() {
  store.show('update');
}
</script>
<template>
  <section
    v-if="!props.recoveryOnly || saved?.missingTabs || update"
    :data-tabflow-sticky-footer="footer ? '' : undefined"
    :class="
      footer
        ? 'shrink-0 border-t border-line px-3 py-2'
        : compact && !saved?.missingTabs && !update
          ? 'flex flex-col border-b border-line pb-2'
          : 'flex flex-col gap-3 border-b border-line pb-4'
    "
  >
    <div
      ref="footerRow"
      :class="
        footer
          ? 'flex min-h-10 min-w-0 items-center justify-end gap-2'
          : 'flex flex-wrap items-center justify-between gap-3'
      "
    >
      <div v-if="showCounts" class="flex min-w-0 flex-1 flex-col gap-1">
        <h2
          v-if="update || (!footer && (!compact || saved?.missingTabs))"
          class="text-sm font-semibold"
        >
          {{
            update
              ? update.interrupted
                ? 'Finish the interrupted update'
                : 'TabFlow update in progress'
              : saved?.missingTabs
                ? 'Saved tabs are missing'
                : 'Saved session'
          }}
        </h2>
        <p v-if="footer" class="truncate text-xs leading-5 text-muted">
          {{ store.records.filter((record) => record.live).length }} tabs ·
          {{ store.app?.windows.length || 0 }} windows ·
          {{ store.app?.projects.length || 0 }} projects<span v-if="saved?.missingTabs">
            · {{ saved.missingTabs }} missing from saved session</span
          >
        </p>
        <p v-else-if="saved" class="text-xs leading-5 text-muted">
          {{ saved.tabCount }} tabs · {{ saved.windowCount }} windows
          <span v-if="!compact">· {{ new Date(saved.savedAt).toLocaleString() }}</span>
          <span v-if="saved.missingTabs"> · {{ saved.missingTabs }} missing</span>
        </p>
        <p v-else class="text-xs text-muted">
          {{ compact ? 'Save this session' : 'Save your open collection for your next session.' }}
        </p>
      </div>
      <div
        ref="footerActions"
        class="flex shrink-0 items-center gap-1"
        :class="footer ? (!showCounts ? 'w-full justify-between' : '') : 'flex-wrap'"
      >
        <UiButton
          v-if="footer"
          square
          size="small"
          variant="ghost"
          aria-label="Create project"
          title="Create project"
          @click="emit('createProject')"
          ><FolderPlus class="size-4"
        /></UiButton>
        <UiButton
          v-if="update"
          :disabled="store.loading || busy"
          size="small"
          :title="footer ? `${update.remaining} update items remaining` : undefined"
          @click="finish"
          >{{
            footer ? 'Finish update' : `Finish update · ${update.remaining} remaining`
          }}</UiButton
        >
        <UiButton
          v-if="saved?.missingTabs && !update"
          :disabled="store.loading || busy"
          size="small"
          variant="ghost"
          :title="footer ? 'Keep current changes and dismiss missing tabs' : undefined"
          :aria-label="footer ? 'Keep current changes' : undefined"
          @click="keepCurrent"
          >{{ footer ? 'Keep' : 'Keep current changes' }}</UiButton
        >
        <UiButton
          v-if="saved?.missingTabs && !update"
          :disabled="store.loading || busy"
          size="small"
          :title="footer ? 'Resume missing saved tabs' : undefined"
          :aria-label="footer ? 'Resume missing tabs' : undefined"
          @click="resume"
          ><RotateCcw class="size-3.5" />{{
            busy ? 'Working…' : footer ? 'Resume' : 'Resume missing tabs'
          }}</UiButton
        >
        <template v-if="!props.recoveryOnly">
          <UiButton
            :disabled="store.loading || busy || !!update"
            size="small"
            :square="compact"
            :aria-label="
              compact
                ? saved?.missingTabs
                  ? 'Save current session'
                  : 'Save session now'
                : undefined
            "
            title="Save tabs, groups and organization before quitting. Page forms and navigation history are not captured."
            @click="saved?.missingTabs ? keepCurrent() : save()"
            ><Bookmark class="size-3.5" /><span v-if="!compact">Save session now</span></UiButton
          >
          <UiButton
            v-if="!compact"
            :disabled="store.loading || busy || !!saved?.missingTabs || !!update"
            size="small"
            variant="ghost"
            @click="reload"
            ><RefreshCw class="size-3.5" />Update TabFlow</UiButton
          >
        </template>
      </div>
    </div>
    <p v-if="!props.recoveryOnly && !compact" class="text-xs leading-5 text-muted">
      Your latest observed collection is saved locally. Resume opens missing tabs asleep, without
      replacing current windows. Export a backup before changing extension files.
    </p>
  </section>
</template>
