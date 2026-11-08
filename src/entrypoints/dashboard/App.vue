<script setup lang="ts">
import { z } from 'zod';
import BrowserWorkProgress from '../../features/workspace/BrowserWorkProgress.vue';
import { ref, computed, onMounted, onUnmounted, watch, nextTick, defineAsyncComponent } from 'vue';
import { useIntervalFn, useMediaQuery } from '@vueuse/core';
import { FocusScope } from 'reka-ui';
import {
  PhSparkle as Sparkles,
  PhBookmarkSimple as Bookmark,
  PhDownloadSimple as Download,
  PhArrowsClockwise as RefreshCw,
  PhX as X,
  PhDotsThree as Ellipsis,
  PhPlus as Plus,
} from '@phosphor-icons/vue';
import UDropdownMenu from '@nuxt/ui/components/DropdownMenu.vue';
import { useTheme } from '../../ui/theme';
import UApp from '@nuxt/ui/components/App.vue';
import USlideover from '@nuxt/ui/components/Slideover.vue';
import USplitter from '@nuxt/ui/components/Splitter.vue';
import type { ComponentExposed } from 'vue-component-type-helpers';
import UiButton from '../../ui/UiButton.vue';
import UiSelect from '../../ui/UiSelect.vue';
import { projectColorStyle } from '../../shared/category-colors';
import UiLoading from '../../ui/UiLoading.vue';
import UiScrollArea from '../../ui/UiScrollArea.vue';
import AppDialog from '../../ui/AppDialog.vue';
import WorkspaceNotifications from '../../features/workspace/WorkspaceNotifications.vue';
import AppSidebar from '../../features/workspace/AppSidebar.vue';
import WorkspaceHeader from '../../features/workspace/WorkspaceHeader.vue';
import { navigation } from '../../features/workspace/navigation';
const TabsView = defineAsyncComponent({
  loader: () => import('../../features/tabs/TabsView.vue'),
  loadingComponent: UiLoading,
  delay: 120,
});
const SidePanelWorkspace = defineAsyncComponent({
  loader: () => import('../../features/tabs/SidePanelWorkspace.vue'),
  loadingComponent: UiLoading,
  delay: 120,
});
const ReviewView = defineAsyncComponent({
  loader: () => import('../../features/review/ReviewView.vue'),
  loadingComponent: UiLoading,
  delay: 120,
});
const ProjectsView = defineAsyncComponent({
  loader: () => import('../../features/projects/ProjectsView.vue'),
  loadingComponent: UiLoading,
  delay: 120,
});
const ProjectActions = defineAsyncComponent(
  () => import('../../features/projects/ProjectActions.vue'),
);
const AssistantPanel = defineAsyncComponent({
  loader: () => import('../../features/assistant/AssistantPanel.vue'),
  loadingComponent: UiLoading,
  delay: 120,
});
const SettingsPanel = defineAsyncComponent({
  loader: () => import('../../features/settings/SettingsPanel.vue'),
  loadingComponent: UiLoading,
  delay: 120,
});
const HistoryPanel = defineAsyncComponent({
  loader: () => import('../../features/history/HistoryPanel.vue'),
  loadingComponent: UiLoading,
  delay: 120,
});
const SavedSessionPanel = defineAsyncComponent({
  loader: () => import('../../features/history/SavedSessionPanel.vue'),
  loadingComponent: UiLoading,
  delay: 120,
});
const UpdateView = defineAsyncComponent({
  loader: () => import('../../features/updates/UpdateView.vue'),
  loadingComponent: UiLoading,
  delay: 120,
});
const TodayPanel = defineAsyncComponent({
  loader: () => import('../../features/today/TodayPanel.vue'),
  loadingComponent: UiLoading,
  delay: 120,
});
import { useWorkspace } from '../../stores/workspace';
import { useDialog } from '../../stores/dialog';
import { rpc } from '../../shared/rpc';
import { workspaceIntentSchema } from '../../shared/workspace-intent';
import { cn } from '../../shared/cn';
import { runModelInference } from '../../ai/inference-lane';
import { migrationProgressSchema, updateProgressSchema } from '../../shared/model';
const store = useWorkspace(),
  dialog = useDialog();
const props = defineProps<{ surface: 'dashboard' | 'sidepanel' }>();
const sidePanel = computed(() => props.surface === 'sidepanel');
const assistantOpen = ref(false),
  assistantMounted = ref(false),
  mobileNav = ref(false),
  sidebarCollapsed = ref(false);
const assistant = ref<{ selectScope: () => void }>();
const { preference: appearance, toggle: toggleAppearance } = useTheme();
const pendingScopeSelection = ref(false);
watch(assistant, (panel) => {
  if (panel && pendingScopeSelection.value) {
    panel.selectScope();
    pendingScopeSelection.value = false;
  }
});
const assistantContainer = ref<HTMLElement>();
let returnFocus: HTMLElement | null = null;
const splitter = ref<ComponentExposed<typeof USplitter>>();
const desktop = useMediaQuery('(min-width: 1280px)');
const wide = computed(() => desktop.value && !sidePanel.value);
const docked = computed(() => store.view !== 'assistant' && assistantOpen.value && wide.value);
watch(
  () => store.view,
  () => {
    assistantOpen.value = false;
    mobileNav.value = false;
  },
);
function restoreNavigationFocus(event: Event) {
  event.preventDefault();
  [...document.querySelectorAll<HTMLElement>('[data-navigation-trigger]')]
    .find((element) => element.getClientRects().length)
    ?.focus();
}
watch(
  [assistantOpen, () => store.view],
  ([open, view]) => {
    if (open || view === 'assistant') assistantMounted.value = true;
  },
  { immediate: true, flush: 'sync' },
);
async function closePanel(windowId?: number) {
  if (chrome.sidePanel?.close) {
    const targetWindowId = windowId ?? (await chrome.windows.getCurrent()).id;
    if (targetWindowId === undefined) throw new Error('The browser window is unavailable.');
    await chrome.sidePanel.close({ windowId: targetWindowId });
  } else
    throw new Error(
      'This browser does not expose panel closing. Use the browser’s side-panel close control.',
    );
}
function closeAssistant() {
  if (sidePanel.value) void store.run(closePanel);
  else if (store.view === 'assistant') store.show('tabs');
  else assistantOpen.value = false;
}
function openFullPage() {
  void store.run(async () => {
    // Capture the panel's window before opening/focusing a dashboard in another window.
    const windowId = sidePanel.value ? (await chrome.windows.getCurrent()).id : undefined;
    if (sidePanel.value && windowId === undefined)
      throw new Error('The browser window is unavailable.');
    await rpc('openDashboard', { view: store.view });
    if (sidePanel.value) await closePanel(windowId);
  });
}
watch(assistantOpen, async (open) => {
  if (open) {
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!wide.value) {
      await nextTick();
      assistantContainer.value?.querySelector<HTMLTextAreaElement>('textarea')?.focus();
    }
  } else {
    returnFocus?.focus();
    returnFocus = null;
  }
});
const organizationRunnerId = 'dashboard-' + crypto.randomUUID();
let organizationRunnerBusy = false;
const title = computed(() =>
  sidePanel.value && store.view === 'tabs'
    ? 'Workspace'
    : navigation.find((item) => item.id === store.view)?.label || 'Workspace',
);
const descriptions: Record<string, string> = {
  today: 'Your next actions and recent tabs.',
  projects: 'Shared context across your windows and tabs.',
  review: 'Inspect, refresh and understand your collection.',
  timeline: 'Recoverable changes and saved arrangements.',
  settings: 'Models, suspension and your privacy preferences.',
  update: 'Install new code while keeping your browser workspace in place.',
};
const description = computed(() =>
  store.view === 'projects' && store.activeProject
    ? undefined
    : store.view === 'tabs'
      ? store.records.length +
        ' tabs · ' +
        store.records.filter((record) => record.suspended).length +
        ' suspended · ' +
        (store.app?.windows.length || 0) +
        ' windows'
      : descriptions[store.view],
);
const foreign = computed(() => store.records.filter((record) => record.foreignSuspended).length);
const panes = computed(() => [
  {
    id: 'workspace',
    slot: 'workspace',
    defaultSize: 74,
    minSize: 45,
    collapsible: true,
    collapsedSize: 0,
    class: store.view === 'assistant' ? 'hidden' : !docked.value ? '!flex-1' : undefined,
  },
  {
    id: 'assistant',
    slot: 'assistant',
    defaultSize: 26,
    minSize: 22,
    maxSize: store.view === 'assistant' ? 100 : 40,
    collapsible: true,
    collapsedSize: 0,
    class:
      store.view === 'assistant'
        ? '!flex-1'
        : docked.value
          ? undefined
          : assistantOpen.value
            ? '!flex-[0_0_0px]'
            : 'hidden',
  },
]);
watch([assistantOpen, () => store.view, wide, splitter], async () => {
  await nextTick();
  const main = splitter.value?.panelsRef[panes.value.findIndex((item) => item.id === 'workspace')];
  const dock = splitter.value?.panelsRef[panes.value.findIndex((item) => item.id === 'assistant')];
  if (!main || !dock) return;
  if (store.view === 'assistant') {
    main.collapse();
    dock.expand();
    dock.resize(100);
  } else {
    main.expand();
    if (assistantOpen.value && wide.value) {
      dock.expand();
      dock.resize(28);
    } else {
      dock.collapse();
      main.resize(100);
    }
  }
});
function aiFor(ids: string[]) {
  store.selected = new Set(ids);
  store.show('assistant');
  if (assistant.value) assistant.value.selectScope();
  else pendingScopeSelection.value = true;
}
watch(
  () => store.assistantContext,
  (context) => {
    if (context) {
      aiFor(context.recordIds);
      store.assistantContext = undefined;
    }
  },
);
async function addProject() {
  const values = await dialog.ask('Create a project', [
    { name: 'name', label: 'Project name' },
    { name: 'purpose', label: 'What is this project about?' },
    {
      name: 'area',
      label: 'Context / area',
      options: [
        { label: 'No area', value: '' },
        ...(store.app?.areas || []).map((area) => ({ label: area.name, value: area.id })),
      ],
    },
    {
      name: 'window',
      label: 'Window',
      options: [
        { label: 'Assign later', value: 'later' },
        { label: 'Create a new window', value: 'new' },
        ...(store.app?.windows || []).map((w) => ({
          label: `Existing window ${w.id}`,
          value: String(w.id),
        })),
      ],
    },
  ]);
  if (!values?.name?.trim()) return;
  const project = await rpc('project', {
    name: values.name!,
    purpose: values.purpose || '',
    areaId: values.area || null,
  });
  if (values.window === 'new') await rpc('createWindow', { projectId: project.id });
  else if (values.window !== 'later')
    await rpc('bindProject', { windowId: Number(values.window), projectId: project.id });
  store.projectFilter = project.id;
  store.show('projects');
  store.projectSection = 'tabs';
  await store.refresh();
}
async function checkpoint() {
  const values = await dialog.ask('Save a snapshot', [
    { name: 'label', label: 'Snapshot name', value: 'Manual checkpoint' },
  ]);
  if (values) {
    await rpc('snapshot', { label: values.label || 'Manual checkpoint' });
    store.notify('Snapshot saved');
    await store.refresh();
  }
}
async function migrate() {
  const report = await rpc('migrationReport', undefined);
  if (
    !(await dialog.ask(
      'Import Suspender placeholders',
      [],
      `${report.recognized} recognizable placeholders, ${report.protected} protected, ${report.unsupported.length} unsupported. Import replaces unlocked placeholders in place without loading websites. A snapshot is saved first. Keep the old extension until no foreign placeholders remain and your backup and wake checks pass.`,
      'Import',
    ))
  )
    return;
  const result = await rpc('migrate', undefined);
  if (store.app) store.app.migration = result;
  store.show('review');
  store.notify('Suspender import started. Progress and recovery are shown below.');
  await store.refresh();
}
async function runOrganizationQueue() {
  if (organizationRunnerBusy || !store.app || document.hidden) return;
  organizationRunnerBusy = true;
  try {
    if (store.app.settings.maintainCollectionReview) {
      const config = store.app.settings;
      if (!(config.useDedicatedDecisionModel ? config.decisionModel : config.smallModel)) return;
      const endpoint = config.useDedicatedDecisionModel
        ? config.decisionBase
        : config.smallModelBase;
      if (!(await chrome.permissions.contains({ origins: [`${new URL(endpoint).origin}/*`] })))
        return;
      const jobs = await rpc('claimCollectionJobs', { runnerId: organizationRunnerId });
      if (!jobs.length) return;
      const controller = new AbortController();
      const lease = setInterval(() => {
        void rpc('renewCollectionJobs', {
          ids: jobs.map((job) => job.id),
          runnerId: organizationRunnerId,
        }).catch(() => controller.abort());
      }, 30000);
      try {
        await store.refresh();
        if (!store.app) throw new Error('Workspace is unavailable.');
        const { generateCollectionDraft } = await import('../../ai/client');
        const analysisId = `maintenance:${jobs[0]!.id}`;
        const draft = await runModelInference(
          () =>
            generateCollectionDraft(store.app!, {
              recordIds: jobs.map((job) => job.recordId),
              reuseAcceptedTaxonomyOnly: true,
              signal: controller.signal,
              checkpoint: {
                tags: {
                  analysisId: analysisId,
                  load: () => rpc('listTagAnalyses', { analysisId: analysisId }),
                  save: (row) => rpc('saveTagAnalysis', row),
                },
                id: analysisId,
                receipt: (receipt) =>
                  rpc('saveInferenceReceipt', { ...receipt, analysisId: analysisId }),
                load: () => rpc('getCollectionAnalysis', { id: analysisId }),
                rebase: () => rpc('rebaseCollectionAnalysis', { id: analysisId }),
                refreshApp: () => rpc('state', undefined),
                save: (analysis) => rpc('saveCollectionAnalysis', analysis),
              },
            }),
          { signal: controller.signal, parallelism: store.app!.settings.maxConcurrentInference },
        );
        if (controller.signal.aborted) throw new Error('Collection analysis lease was lost.');
        await rpc('proposeCollection', { ...draft, sourceJobIds: jobs.map((job) => job.id) });
        await rpc('clearCollectionAnalysis', { id: analysisId });
        for (const job of jobs)
          await rpc('finishOrganizationJob', {
            id: job.id,
            status: 'complete',
            runnerId: organizationRunnerId,
          });
        store.notify(
          'New-tab suggestions ready in Projects. Review and Apply to change organization.',
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        for (const job of jobs)
          await rpc('finishOrganizationJob', {
            id: job.id,
            status: 'error',
            error: message,
            runnerId: organizationRunnerId,
          }).catch(() => undefined);
        store.notify(`Collection maintenance failed: ${message}`);
      } finally {
        clearInterval(lease);
        await store.refresh();
      }
      return;
    }
    const projectConfig = store.app.settings;
    if (
      !projectConfig.aiModel ||
      !(projectConfig.useDedicatedDecisionModel
        ? projectConfig.decisionModel
        : projectConfig.smallModel)
    )
      return;
    const projectOrigins = [
      ...new Set(
        [
          projectConfig.aiBase,
          projectConfig.useDedicatedDecisionModel
            ? projectConfig.decisionBase
            : projectConfig.smallModelBase,
        ].map((base) => `${new URL(base).origin}/*`),
      ),
    ];
    // Maintenance cannot ask for new permission outside an owner gesture; keep jobs queued.
    if (!(await chrome.permissions.contains({ origins: projectOrigins }))) return;
    const claimed = await rpc('claimOrganizationJob', { runnerId: organizationRunnerId });
    if (!claimed) return;
    try {
      const { generateOrganizationDraft } = await import('../../ai/client');
      const draft = await runModelInference(
        () =>
          generateOrganizationDraft(store.app!, claimed.project, [claimed.record], {
            onProgress: (message) => store.notify(message),
          }),
        { parallelism: store.app!.settings.maxConcurrentInference },
      );
      const proposal = await rpc('proposeOrganization', {
        ...draft,
        sourceJobId: claimed.job.id,
      });
      await rpc('finishOrganizationJob', { id: claimed.job.id, status: 'complete' });
      store.notify(
        proposal.status === 'dismissed'
          ? `A matching suggestion was dismissed earlier for ${claimed.project.name}; no duplicate was opened.`
          : `New tab suggestion ready for ${claimed.project.name}; review it in Projects.`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await rpc('finishOrganizationJob', {
        id: claimed.job.id,
        status: 'error',
        error: message,
      }).catch(() => undefined);
      store.notify(`Project analysis failed: ${message}`);
    }
    await store.refresh();
  } finally {
    organizationRunnerBusy = false;
  }
}
function receiveMigration(message: unknown, sender: chrome.runtime.MessageSender) {
  if (
    sender.id !== chrome.runtime.id ||
    !message ||
    typeof message !== 'object' ||
    !('type' in message) ||
    !('payload' in message)
  )
    return;
  if (message.type === 'workspaceIntent') {
    void store.run(() => consumeWorkspaceIntent(message.payload));
  } else if (message.type === 'localDataChanged') {
    const parsed = z
      .object({ kind: z.enum(['cache', 'analysis', 'history', 'organization', 'all']) })
      .safeParse(message.payload);
    if (parsed.success) {
      if (parsed.data.kind === 'cache') void store.run(store.refresh);
      else location.reload();
    }
  } else if (message.type === 'updateProgress') {
    const parsed = updateProgressSchema.nullable().safeParse(message.payload);
    if (parsed.success && store.app) store.app.update = parsed.data;
  } else if (message.type === 'migrationProgress') {
    const parsed = migrationProgressSchema.safeParse(message.payload);
    if (parsed.success && store.app) store.app.migration = parsed.data;
  }
}
let consumingIntent = false;
let consumedIntent = '';
async function consumeWorkspaceIntent(raw?: unknown) {
  if (consumingIntent) return;
  consumingIntent = true;
  try {
    const parsed = workspaceIntentSchema.safeParse(
      raw || (await chrome.storage.session.get('workspaceIntent')).workspaceIntent,
    );
    if (
      !parsed.success ||
      parsed.data.id === consumedIntent ||
      Date.now() - parsed.data.at > 5 * 60_000
    )
      return;
    const current = await chrome.tabs.getCurrent();
    if (current?.id !== parsed.data.targetTabId) return;
    consumedIntent = parsed.data.id;
    await store.refresh();
    const intent = parsed.data;
    if (intent.notice) store.notify(intent.notice, true);
    if (intent.kind === 'ask' && intent.recordId) store.askAssistant([intent.recordId]);
    else if (intent.kind === 'find-link') {
      store.clearFilters();
      store.search = intent.query || '';
      store.show('tabs');
    } else if (intent.recordId) store.revealTab(intent.recordId);
    const pending = (await chrome.storage.session.get('workspaceIntent')).workspaceIntent;
    if (workspaceIntentSchema.safeParse(pending).data?.id === intent.id)
      await chrome.storage.session.remove('workspaceIntent');
  } finally {
    consumingIntent = false;
  }
}
function syncRoute() {
  const view = location.hash.slice(1);
  if (navigation.some((item) => item.id === view)) store.view = view;
}
function refreshVisibleSurface() {
  if (!document.hidden)
    void store.run(async () => {
      await store.refresh();
      await consumeWorkspaceIntent();
    });
}
onUnmounted(() => {
  chrome.runtime.onMessage.removeListener(receiveMigration);
  window.removeEventListener('hashchange', syncRoute);
  document.removeEventListener('visibilitychange', refreshVisibleSurface);
  window.removeEventListener('focus', refreshVisibleSurface);
});
onMounted(() => {
  chrome.runtime.onMessage.addListener(receiveMigration);
  const requested = location.hash.slice(1);
  if (navigation.some((n) => n.id === requested)) store.view = requested;
  else if (sidePanel.value) store.view = 'tabs';
  void store.run(async () => {
    await store.refresh();
    await consumeWorkspaceIntent();
    void runOrganizationQueue();
  });
  window.addEventListener('hashchange', syncRoute);
  document.addEventListener('visibilitychange', refreshVisibleSurface);
  window.addEventListener('focus', refreshVisibleSurface);
});
useIntervalFn(() => {
  if (document.hidden || dialog.current) return;
  void store.run(async () => {
    if (store.app?.jobs.some((j) => ['queued', 'running'].includes(j.status)))
      await rpc('tick', undefined);
    await store.refresh();
    void runOrganizationQueue();
  });
}, 5000);
</script>
<template>
  <UApp :toaster="{ position: sidePanel ? 'bottom-center' : 'bottom-right', max: 4 }">
    <WorkspaceNotifications />
    <div class="isolate flex h-dvh min-h-0 overflow-hidden bg-canvas">
      <AppSidebar
        :inert="assistantOpen && !wide && store.view !== 'assistant'"
        :class="sidePanel ? 'hidden' : 'hidden lg:flex'"
        :collapsed="sidebarCollapsed"
        @toggle="sidebarCollapsed = !sidebarCollapsed"
        @create-project="store.run(addProject)"
      />
      <USlideover
        v-model:open="mobileNav"
        side="left"
        title="Navigation"
        :content="{ onCloseAutoFocus: restoreNavigationFocus }"
        :ui="{ content: 'w-64 bg-sidebar', body: 'p-0', header: 'sr-only' }"
      >
        <template #body
          ><AppSidebar
            @navigate="mobileNav = false"
            @toggle="mobileNav = false"
            @create-project="
              mobileNav = false;
              store.run(addProject);
            "
        /></template>
      </USlideover>
      <USplitter
        ref="splitter"
        :items="panes"
        :ui="{
          root: 'h-full min-h-0 min-w-0 flex-1',
          panel: 'flex min-h-0 min-w-0 flex-col overflow-visible',
          handle: docked ? 'w-px bg-line hover:bg-line-strong' : 'hidden',
        }"
      >
        <template #workspace>
          <div
            v-show="store.view !== 'assistant'"
            :inert="assistantOpen && !wide && store.view !== 'assistant'"
            class="flex h-full min-h-0 min-w-0 flex-col"
          >
            <WorkspaceHeader
              :title="title"
              :description="description"
              :compact="sidePanel"
              @navigation="mobileNav = true"
            >
              <template v-if="store.view === 'projects' && store.activeProject" #title>
                <UiSelect
                  :model-value="store.activeProject.id"
                  :options="
                    store.orderedProjects.map((project) => ({
                      label: project.name,
                      value: project.id,
                      color: projectColorStyle(project),
                    }))
                  "
                  variant="ghost"
                  class="max-w-sm px-2 text-base font-semibold sm:text-xl"
                  aria-label="Choose project"
                  @update:model-value="store.projectFilter = $event"
                />
              </template>
              <UiButton
                v-if="!sidePanel"
                square
                size="small"
                variant="ghost"
                :disabled="store.loading"
                title="Refresh workspace"
                aria-label="Refresh workspace"
                @click="store.run(store.refresh)"
                ><RefreshCw class="size-4"
              /></UiButton>
              <UiButton
                v-if="!sidePanel && (store.view === 'tabs' || store.view === 'timeline')"
                size="small"
                variant="ghost"
                @click="store.run(checkpoint)"
                ><Bookmark class="size-3.5" /><span class="hidden sm:inline"
                  >Snapshot</span
                ></UiButton
              >
              <UiButton
                v-if="store.view === 'timeline'"
                size="small"
                :disabled="store.backupBusy"
                @click="store.run(store.exportBackup)"
                ><Download class="size-3.5" />Export</UiButton
              >
              <ProjectActions
                v-if="store.view === 'projects' && store.activeProject"
                :project="store.activeProject"
                label="Project options"
              />
              <UiButton
                v-if="store.view === 'projects'"
                size="small"
                aria-label="New project"
                title="New project"
                @click="store.run(addProject)"
                ><Plus class="size-4 sm:hidden" /><span class="hidden sm:inline"
                  >New project</span
                ></UiButton
              >
              <UiButton
                v-if="!assistantOpen"
                size="small"
                variant="ghost"
                title="Open contextual assistant"
                :aria-label="sidePanel ? 'Open contextual assistant' : 'Assistant'"
                @click="sidePanel ? store.show('assistant') : (assistantOpen = true)"
                ><Sparkles class="size-3.5" /><span v-if="!sidePanel" class="hidden sm:inline"
                  >Assistant</span
                ></UiButton
              >
              <UDropdownMenu
                v-if="sidePanel"
                :items="[
                  { label: 'Refresh workspace', onSelect: () => store.run(store.refresh) },
                  { label: 'Open full page', onSelect: openFullPage },
                  {
                    label: appearance === 'light' ? 'Switch to dark mode' : 'Switch to light mode',
                    onSelect: toggleAppearance,
                  },
                  { label: 'Settings', onSelect: () => store.show('settings') },
                  { label: 'Update TabFlow', onSelect: () => store.show('update') },
                ]"
                :ui="{ content: 'bg-overlay' }"
                ><UiButton
                  size="small"
                  variant="ghost"
                  title="Workspace menu"
                  aria-label="Workspace menu"
                  ><Ellipsis class="size-4" /></UiButton
              ></UDropdownMenu>
              <UiButton
                v-if="sidePanel"
                size="small"
                variant="ghost"
                title="Close side panel"
                aria-label="Close side panel"
                @click="store.run(closePanel)"
                ><X class="size-4"
              /></UiButton>
            </WorkspaceHeader>
            <BrowserWorkProgress />
            <component
              :is="store.view === 'settings' ? 'main' : UiScrollArea"
              as="main"
              label="Workspace content"
              :content-class="
                cn('flex min-w-0 flex-col gap-3 pb-6', sidePanel ? 'px-3' : 'px-6 sm:px-8')
              "
              :class="
                cn(
                  'min-h-0 min-w-0 flex-1',
                  store.view === 'settings' && 'flex flex-col overflow-hidden px-6 sm:px-8',
                )
              "
            >
              <div
                v-if="foreign && (store.view === 'tabs' || store.view === 'review')"
                class="flex flex-wrap items-center gap-3 rounded-md bg-surface px-4 py-3"
              >
                <p class="min-w-0 flex-1 text-[13px] text-secondary">
                  {{ foreign }} tabs use another Suspender. Import before removing that extension.
                </p>
                <UiButton size="small" variant="ghost" @click="store.show('review')"
                  >Review import</UiButton
                >
              </div>
              <SavedSessionPanel
                v-if="
                  store.view !== 'timeline' &&
                  store.view !== 'update' &&
                  (!sidePanel || store.view !== 'tabs')
                "
                :recovery-only="!sidePanel || store.view !== 'tabs'"
                :compact="sidePanel"
              />
              <SidePanelWorkspace
                v-if="store.view === 'tabs' && sidePanel"
                @create-project="store.run(addProject)"
                @ai="aiFor"
              />
              <KeepAlive
                ><TabsView v-if="store.view === 'tabs' && !sidePanel" @ai="aiFor"
              /></KeepAlive>
              <TodayPanel v-if="store.view === 'today'" />
              <KeepAlive
                ><ProjectsView v-if="store.view === 'projects'" @create="store.run(addProject)"
              /></KeepAlive>
              <ReviewView v-if="store.view === 'review'" @migrate="store.run(migrate)" />
              <KeepAlive><HistoryPanel v-if="store.view === 'timeline'" /></KeepAlive>
              <SettingsPanel v-if="store.view === 'settings' && store.app" />
              <KeepAlive><UpdateView v-if="store.view === 'update'" /></KeepAlive>
            </component>
            <SavedSessionPanel
              v-if="sidePanel && store.view === 'tabs'"
              compact
              footer
              @create-project="store.run(addProject)"
            />
          </div>
        </template>
        <template #assistant>
          <button
            v-if="assistantOpen && !wide && store.view !== 'assistant'"
            class="fixed inset-0 z-20 bg-black/55"
            aria-label="Close contextual assistant"
            tabindex="-1"
            @click="assistantOpen = false"
          />
          <div
            v-show="assistantOpen || store.view === 'assistant'"
            ref="assistantContainer"
            :role="assistantOpen && !wide && store.view !== 'assistant' ? 'dialog' : undefined"
            :aria-modal="assistantOpen && !wide && store.view !== 'assistant' ? true : undefined"
            aria-label="Workspace assistant"
            :class="
              cn(
                'flex h-full min-h-0 min-w-0 flex-1',
                store.view !== 'assistant' &&
                  'max-xl:fixed max-xl:inset-y-0 max-xl:right-0 max-xl:z-30 max-xl:w-[min(420px,100vw)] max-xl:bg-canvas',
              )
            "
            @keydown.esc="if (store.view !== 'assistant') assistantOpen = false;"
          >
            <FocusScope
              as-child
              :loop="assistantOpen && !wide && store.view !== 'assistant'"
              :trapped="assistantOpen && !wide && store.view !== 'assistant'"
              @mount-auto-focus.prevent
              @unmount-auto-focus.prevent
            >
              <AssistantPanel
                v-if="assistantMounted"
                ref="assistant"
                :expanded="store.view === 'assistant'"
                :side-panel="sidePanel"
                :visible="assistantOpen || store.view === 'assistant'"
                :sidebar-collapsed="sidebarCollapsed"
                @navigation="mobileNav = true"
                @toggle-sidebar="sidebarCollapsed = !sidebarCollapsed"
                @close="closeAssistant"
                @open-full-page="openFullPage"
              />
            </FocusScope>
          </div>
        </template>
      </USplitter>
      <AppDialog />
    </div>
  </UApp>
</template>
