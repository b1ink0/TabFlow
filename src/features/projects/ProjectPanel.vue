<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import UiReorderList from '../../ui/UiReorderList.vue';
import type { ReorderEvent } from '../../shared/reorder';
import { useReorderGesture, droppedOrder } from '../workspace/useReorderGesture';
import { useStorage } from '@vueuse/core';
import {
  PhCheck as Check,
  PhPlus as Plus,
  PhSparkle as Sparkles,
  PhSpinnerGap as LoaderCircle,
} from '@phosphor-icons/vue';
import type { Category, CollectionAnalysis, Project } from '../../shared/types';
import { workspaceEditBaseline } from '../../shared/workspace-edits';
import { rpc } from '../../shared/rpc';
import { useWorkspace } from '../../stores/workspace';
import { useDialog } from '../../stores/dialog';
import UiButton from '../../ui/UiButton.vue';
import InferenceHistory from '../assistant/InferenceHistory.vue';
import UiSelect from '../../ui/UiSelect.vue';
import UiCheckbox from '../../ui/UiCheckbox.vue';
import ProvenanceLabel from '../../ui/ProvenanceLabel.vue';
import TagSuggestionReview from './TagSuggestionReview.vue';
import { requestModelAccess } from '../../ai/access';
import { runModelInference } from '../../ai/inference-lane';
import { useTabSearch } from '../tabs/useTabSearch';
import CategoryActions from './CategoryActions.vue';
import TabRow from '../tabs/TabRow.vue';
import UiLoadMore from '../../ui/UiLoadMore.vue';
import UiBranchGuides from '../../ui/UiBranchGuides.vue';
import UiSearchInput from '../../ui/UiSearchInput.vue';
import { workspaceRows } from '../../shared/workspace-navigation';

const props = withDefaults(defineProps<{ project: Project; section?: string }>(), {
  section: 'tabs',
});
const store = useWorkspace();
const reorderGesture = useReorderGesture();
const dialog = useDialog();
const purpose = ref(props.project.purpose);
const name = ref(props.project.name);
const areaId = ref(props.project.areaId || '');
const maintainReviewQueue = ref(props.project.maintainReviewQueue);
const drafting = ref(false);
const progress = ref('');
const tabSearch = ref('');
const { matches: tabMatches, searching: tabSearching } = useTabSearch(
  tabSearch,
  () => store.records,
  () => store.app,
);
const categoryFilter = ref('__all__');
const shownTabs = ref(35);
const visibleTabs = computed(() =>
  workspaceRows(
    store.records,
    memberships.value,
    { kind: 'project', projectId: props.project.id },
    '',
    {
      ...store.filters,
      projectId: props.project.id,
      categoryId: categoryFilter.value.startsWith('__') ? '' : categoryFilter.value,
    },
    store.app,
  ).filter(
    (record) =>
      (!tabMatches.value || tabMatches.value.has(record.id)) &&
      (categoryFilter.value !== '__none__' ||
        !memberships.value.find((item) => item.recordId === record.id)?.categoryId),
  ),
);
const treeTabs = computed(() =>
  store.treeRows(
    visibleTabs.value,
    Boolean(tabSearch.value.trim()) || categoryFilter.value !== '__all__',
  ),
);
watch([tabMatches, categoryFilter], () => {
  shownTabs.value = 35;
});
const analysis = ref<CollectionAnalysis>();
const acceptProjectName = ref(false);
const acceptProjectPurpose = ref(false);
let draftController: AbortController | undefined;
const analysisKeys = useStorage<Record<string, string>>('tabflow.project.analysisIds', {});
const analysisId = computed(
  () => analysisKeys.value[props.project.id] || `project-analysis:${props.project.id}`,
);
watch(
  analysisId,
  async (id) => {
    analysis.value = await rpc('getCollectionAnalysis', { id });
  },
  { immediate: true },
);
const categories = computed(() =>
  (store.app?.categories || [])
    .filter((category) => category.projectId === props.project.id)
    .sort((a, b) => a.order - b.order),
);
const memberships = computed(() => store.app?.memberships || []);
const proposals = computed(() =>
  (store.app?.proposals || []).filter((proposal) => proposal.projectId === props.project.id),
);
const organizationJobs = computed(() =>
  (store.app?.organizationJobs || []).filter((job) => job.projectId === props.project.id),
);
const pendingProposal = computed(() =>
  proposals.value.find((proposal) => proposal.status === 'pending'),
);
watch(
  () => pendingProposal.value?.id,
  () => {
    acceptProjectName.value = false;
    acceptProjectPurpose.value = false;
  },
);
const records = computed(() =>
  workspaceRows(store.records, memberships.value, { kind: 'project', projectId: props.project.id }),
);
const unassigned = computed(() =>
  records.value.filter(
    (record) =>
      !memberships.value.find((membership) => membership.recordId === record.id)?.categoryId,
  ),
);
const selectedLiveCount = computed(
  () => [...store.selected].filter((id) => store.records.some((record) => record.id === id)).length,
);
function count(category: Category) {
  const liveIds = new Set(store.records.map((record) => record.id));
  return memberships.value.filter(
    (membership) =>
      liveIds.has(membership.recordId) &&
      membership.projectId === props.project.id &&
      membership.categoryId === category.id,
  ).length;
}
async function savePurpose() {
  await store.run(async () => {
    await rpc('project', {
      id: props.project.id,
      name: name.value,
      purpose: purpose.value,
      maintainReviewQueue: maintainReviewQueue.value,
      areaId: areaId.value || null,
    });
    store.notify('Project details saved');
    await store.refresh();
  });
}
async function setMaintenance(value: boolean) {
  const previous = maintainReviewQueue.value;
  maintainReviewQueue.value = value;
  await savePurpose();
  if (
    store.app?.projects.find((project) => project.id === props.project.id)?.maintainReviewQueue !==
    value
  )
    maintainReviewQueue.value = previous;
}
async function addCategory() {
  const values = await dialog.ask('Add a project category', [
    { name: 'name', label: 'Category name' },
    { name: 'description', label: 'When does a tab belong here?' },
    { name: 'displayColor', label: 'Display color', value: '', color: true },
  ]);
  if (!values?.name?.trim()) return;
  await store.run(async () => {
    await rpc('category', {
      projectId: props.project.id,
      name: values.name!,
      description: values.description || '',
      displayColor: values.displayColor || null,
    });
    await store.refresh();
  });
}
async function assign(categoryId: string | null) {
  const ids = [...store.selected].filter((id) => store.records.some((record) => record.id === id));
  if (!ids.length) {
    store.notify('Select project tabs in Windows & tabs first.');
    return;
  }
  await store.run(async () => {
    await rpc('assignMembership', { recordIds: ids, projectId: props.project.id, categoryId });
    store.selected = new Set();
    store.notify(`Saved category correction for ${ids.length} tab${ids.length === 1 ? '' : 's'}`);
    await store.refresh();
  });
}
const lastCategoryChange = ref('');
const categoryChangeUndone = ref(false);
async function restoreCategoryChange() {
  await store.run(async () => {
    const result = await rpc(
      categoryChangeUndone.value ? 'redoAssistantChange' : 'undoAssistantChange',
      {
        id: lastCategoryChange.value,
      },
    );
    categoryChangeUndone.value = result.status === 'undone';
    store.notify(result.outcome);
    await store.refresh();
  });
}
async function reorderCategories(ids: string[]) {
  await store.run(async () => {
    if (!store.app) return;
    const edit = { kind: 'category_order' as const, projectId: props.project.id, categoryIds: ids };
    const change = await rpc('executeWorkspaceEdit', {
      kind: 'workspace_edits',
      summary: `Reorder categories in ${props.project.name}`,
      edits: [{ edit, before: workspaceEditBaseline(store.app, edit) }],
    });
    lastCategoryChange.value = change.id;
    categoryChangeUndone.value = false;
    await store.refresh();
  });
}
function categoryDropped(event: ReorderEvent) {
  reorderGesture.finish();
  const current = categories.value.map((category) => category.id);
  const ids = droppedOrder(event, current, '[data-category-id]', 'categoryId');
  if (ids.every((id, index) => id === current[index])) return;
  void reorderCategories(ids);
}
async function editCategory(category: Category) {
  const values = await dialog.ask('Edit category', [
    { name: 'name', label: 'Name', value: category.name },
    { name: 'description', label: 'When does a tab belong here?', value: category.description },
    {
      name: 'displayColor',
      label: 'Display color',
      value: category.displayColor || '',
      color: true,
    },
  ]);
  if (!values?.name?.trim()) return;
  await store.run(async () => {
    await rpc('category', {
      id: category.id,
      projectId: props.project.id,
      name: values.name!,
      description: values.description || '',
      displayColor: values.displayColor || null,
    });
    await store.refresh();
  });
}
async function draftOrganization() {
  if (!store.app || drafting.value) return;
  const ids = selectedLiveCount.value
    ? [...store.selected]
    : records.value.map((record) => record.id);
  const scope = store.records.filter((record) => ids.includes(record.id));
  drafting.value = true;
  draftController = new AbortController();
  progress.value = 'Preparing project context';
  try {
    analysis.value = await rpc('getCollectionAnalysis', { id: analysisId.value });
    await requestModelAccess(
      store.app.settings,
      analysis.value && analysis.value.classifiedIds.length === analysis.value.scope.length
        ? analysis.value.taggingRequested
          ? ['tags']
          : []
        : analysis.value && analysis.value.discoveredIds.length === analysis.value.scope.length
          ? ['decision']
          : ['generative', 'decision'],
    );
    const { generateOrganizationDraft } = await import('../../ai/client');
    const draft = await runModelInference(
      () =>
        generateOrganizationDraft(store.app!, props.project, scope, {
          signal: draftController!.signal,
          onProgress: (message) => (progress.value = message),
          checkpoint: {
            tags: {
              analysisId: analysisId.value,
              load: () => rpc('listTagAnalyses', { analysisId: analysisId.value }),
              save: (row) => rpc('saveTagAnalysis', row),
            },
            id: analysisId.value,
            receipt: (receipt) =>
              rpc('saveInferenceReceipt', { ...receipt, analysisId: analysisId.value }),
            load: () => rpc('getCollectionAnalysis', { id: analysisId.value }),
            rebase: () => rpc('rebaseCollectionAnalysis', { id: analysisId.value }),
            refreshApp: () => rpc('state', undefined),
            save: async (checkpoint) => {
              const saved = await rpc('saveCollectionAnalysis', checkpoint);
              analysis.value = saved;
              return saved;
            },
          },
        }),
      {
        signal: draftController.signal,
        parallelism: store.app!.settings.maxConcurrentInference,
        onWaiting: () => (progress.value = 'Waiting for model'),
      },
    );
    const proposal = await rpc('proposeOrganization', draft);
    await rpc('clearCollectionAnalysis', { id: analysisId.value });
    analysis.value = undefined;
    store.notify(
      proposal.status === 'dismissed'
        ? 'This same project suggestion was dismissed previously; no duplicate review was opened.'
        : 'Organization draft is ready for review',
    );
    await store.refresh();
  } catch (error) {
    analysis.value = await rpc('getCollectionAnalysis', { id: analysisId.value });
    store.notify(
      draftController.signal.aborted
        ? 'Project draft cancelled; completed analysis batches were retained.'
        : error instanceof Error
          ? error.message
          : String(error),
    );
  } finally {
    draftController = undefined;
    drafting.value = false;
    progress.value = '';
  }
}
async function startNewAnalysis() {
  if (drafting.value) return;
  analysisKeys.value = { ...analysisKeys.value, [props.project.id]: crypto.randomUUID() };
  analysis.value = undefined;
  store.notify('New project analysis selected. Previous progress is retained.');
}
async function repairAnalysis(stage: 'classification' | 'tagging') {
  const repaired = await rpc('repairCollectionAnalysis', { id: analysisId.value, stage });
  analysisKeys.value = { ...analysisKeys.value, [props.project.id]: repaired.id };
  analysis.value = repaired;
  store.notify(
    stage === 'tagging'
      ? 'Tag repair prepared. Retained category choices require review.'
      : 'Category and tag repair prepared. Original progress is retained.',
  );
}
function cancelDraft() {
  draftController?.abort();
}
async function reviewTag(recordId: string, name: string, include: boolean) {
  if (!pendingProposal.value) return;
  await store.run(async () => {
    await rpc('reviewOrganizationTag', { id: pendingProposal.value!.id, recordId, name, include });
    await store.refresh();
  });
}
async function applyProposal(id: string) {
  await store.run(async () => {
    await rpc('applyOrganization', {
      id,
      projectName: acceptProjectName.value,
      projectPurpose: acceptProjectPurpose.value,
    });
    store.notify('Reviewed organization saved to the project');
    await store.refresh();
  });
}
async function dismissProposal(id: string) {
  await store.run(async () => {
    await rpc('dismissOrganization', { id });
    await store.refresh();
  });
}
async function retryJob(id: string) {
  await store.run(async () => {
    await rpc('retryOrganizationJob', { id });
    await store.refresh();
  });
}
</script>

<template>
  <div class="flex min-w-0 flex-col gap-6">
    <section v-show="section === 'details'" class="flex flex-col gap-3">
      <div class="flex items-center justify-between gap-3">
        <h2 class="text-sm font-semibold">Project context</h2>
        <ProvenanceLabel compact :provenance="project.provenance" />
        <UiButton
          size="small"
          :disabled="
            purpose === project.purpose &&
            name.trim() === project.name &&
            (areaId || null) === (project.areaId || null)
          "
          @click="savePurpose"
          >Save details</UiButton
        >
      </div>
      <label class="field-label"
        >Area / context
        <UiSelect
          v-model="areaId"
          :options="[
            { label: 'No area', value: '' },
            ...(store.app?.areas || []).map((area) => ({ label: area.name, value: area.id })),
          ]"
          aria-label="Project context"
        />
      </label>
      <label class="field-label"
        >Project name
        <input v-model="name" class="field" maxlength="80" />
      </label>
      <label class="field-label"
        >Purpose and working context
        <textarea
          v-model="purpose"
          class="field min-h-24 resize-y"
          maxlength="1000"
          placeholder="What are you trying to accomplish in this project? What makes a tab relevant?"
        />
      </label>
      <p class="text-xs leading-5 text-muted">
        Stored locally. Project context and tabs are sent to the configured model only for drafts or
        when this review queue is enabled. Applying a draft updates project meaning; it does not
        rearrange browser windows or groups.
      </p>
      <label class="flex items-start gap-2 text-xs leading-5 text-muted">
        <UiCheckbox
          :model-value="maintainReviewQueue"
          label="Queue new and navigated tabs for project review"
          @update:model-value="setMaintenance"
        />
        <span
          >Queue new or navigated tabs from windows bound to this project. Analysis resumes while
          the dashboard is open; every result still needs your review.</span
        >
      </label>
    </section>

    <section v-show="section === 'organize'" class="flex flex-col gap-3 py-2">
      <div class="flex flex-wrap items-center gap-3">
        <div class="flex min-w-0 flex-1 flex-col gap-1">
          <h2 class="text-sm font-semibold">Organization</h2>
          <p class="text-xs text-muted">
            Draft project context and categories from project tabs or your workspace selection, then
            review every assignment.
          </p>
          <p v-if="selectedLiveCount" class="text-xs text-muted" role="status">
            Draft scope: {{ selectedLiveCount }} selected workspace tabs, including tabs from
            unassigned windows.
          </p>
        </div>
        <UiButton
          size="small"
          :disabled="drafting || Boolean(pendingProposal)"
          @click="draftOrganization"
        >
          <LoaderCircle v-if="drafting" class="size-3.5 animate-spin" />
          <Sparkles v-else class="size-3.5" />
          {{ drafting ? 'Analyzing' : analysis ? 'Resume analysis' : 'Draft organization' }}
        </UiButton>
        <UiButton v-if="drafting" size="small" variant="ghost" @click="cancelDraft"
          >Cancel</UiButton
        >
        <UiButton v-else-if="analysis" size="small" variant="ghost" @click="startNewAnalysis"
          >Start new</UiButton
        >
      </div>
      <div v-if="analysis && !drafting" class="flex flex-wrap gap-2">
        <UiButton
          size="small"
          variant="ghost"
          @click="store.run(() => repairAnalysis('classification'))"
          >Repair categories and tags</UiButton
        >
        <UiButton size="small" variant="ghost" @click="store.run(() => repairAnalysis('tagging'))"
          >Repair tags only</UiButton
        >
      </div>
      <InferenceHistory :analysis-id="analysisId" />
      <p v-if="drafting" class="text-xs text-muted" role="status">
        {{ progress }} · Keep this dashboard open while the model runs.
      </p>
      <p v-else-if="analysis" class="text-xs text-muted" role="status">
        Saved analysis: {{ analysis.classifiedIds.length }} of {{ analysis.scope.length }} tabs
        classified. Resume keeps completed batches.
      </p>
      <p class="text-xs leading-5 text-muted">
        Uses the configured OpenAI-compatible model. Sends titles, URLs, notes, and any already
        cached page text in the selected scope. It does not wake pages.
      </p>
      <p
        v-if="
          maintainReviewQueue &&
          !(store.app?.settings.useDedicatedDecisionModel
            ? store.app.settings.decisionModel
            : store.app?.settings.smallModel)
        "
        class="text-xs text-muted"
        role="status"
      >
        New tabs stay queued until you select a small chat model or System One model in Settings and
        grant access to its server.
      </p>
      <p
        v-if="maintainReviewQueue && !store.app?.settings.aiModel"
        class="text-xs text-muted"
        role="status"
      >
        New tabs are queued, but project drafts require the OpenAI-compatible provider. Switch
        providers to resume the queue.
      </p>
      <div
        v-if="organizationJobs.some((job) => ['queued', 'running', 'error'].includes(job.status))"
        class="flex flex-col gap-2 border-t border-line pt-3"
      >
        <h3 class="text-xs font-medium">New tab review queue</h3>
        <div
          v-for="job in organizationJobs.filter((entry) =>
            ['queued', 'running', 'error'].includes(entry.status),
          )"
          :key="job.id"
          class="flex items-center gap-3 text-xs"
        >
          <span class="min-w-0 flex-1 truncate">{{
            store.records.find((record) => record.id === job.recordId)?.title || job.url
          }}</span>
          <span class="text-muted">{{
            job.status === 'running'
              ? 'Analyzing'
              : job.status === 'queued'
                ? pendingProposal
                  ? 'Waiting for suggestion review'
                  : !store.app?.settings.aiModel
                    ? 'Choose a generative model in Settings'
                    : 'Waiting for dashboard runner'
                : job.error
          }}</span>
          <UiButton
            v-if="job.status === 'error'"
            size="small"
            variant="ghost"
            @click="retryJob(job.id)"
            >Retry</UiButton
          >
        </div>
      </div>
      <article
        v-if="pendingProposal"
        class="flex flex-col gap-3 rounded-md bg-raised p-3"
        aria-label="Pending organization proposal"
      >
        <div class="flex flex-wrap items-start gap-3">
          <div class="flex min-w-0 flex-1 flex-col gap-1">
            <h3 class="text-xs font-semibold">Review proposed structure</h3>
            <p class="text-xs leading-5 text-muted">
              {{
                pendingProposal.summary || 'The model prepared category and membership suggestions.'
              }}
            </p>
          </div>
          <span class="text-xs text-muted">{{
            new Date(pendingProposal.createdAt).toLocaleString()
          }}</span>
        </div>
        <div
          v-if="
            pendingProposal.projectSuggestion &&
            (pendingProposal.projectSuggestion.name !== project.name ||
              pendingProposal.projectSuggestion.purpose !== project.purpose)
          "
          class="flex flex-col gap-2 border-t border-line pt-3"
        >
          <span class="text-xs font-medium">Project details suggested from this selection</span>
          <label
            v-if="pendingProposal.projectSuggestion.name !== project.name"
            class="flex items-start gap-2 text-xs text-muted"
          >
            <UiCheckbox
              v-model="acceptProjectName"
              :label="`Use suggested project name: ${pendingProposal.projectSuggestion.name}`"
            />
            <span>Rename project to {{ pendingProposal.projectSuggestion.name }}</span>
          </label>
          <label
            v-if="pendingProposal.projectSuggestion.purpose !== project.purpose"
            class="flex items-start gap-2 text-xs text-muted"
          >
            <UiCheckbox
              v-model="acceptProjectPurpose"
              :label="`Use suggested project purpose: ${pendingProposal.projectSuggestion.purpose}`"
            />
            <span>Set purpose: {{ pendingProposal.projectSuggestion.purpose }}</span>
          </label>
        </div>
        <div v-if="pendingProposal.categories.length" class="flex flex-col gap-1">
          <span class="text-xs font-medium">New categories</span>
          <span
            v-for="category in pendingProposal.categories"
            :key="category.name"
            class="text-xs text-muted"
            >{{ category.name
            }}<span v-if="category.description"> · {{ category.description }}</span></span
          >
        </div>
        <div class="flex flex-col gap-1">
          <span class="text-xs font-medium"
            >Assignments · {{ pendingProposal.assignments.length }}</span
          >
          <div
            v-for="assignment in pendingProposal.assignments"
            :key="assignment.recordId"
            class="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 text-xs"
          >
            <span class="max-w-[28rem] truncate">{{
              store.records.find((record) => record.id === assignment.recordId)?.title ||
              'Tab no longer open'
            }}</span>
            <span class="text-muted"
              >→ {{ assignment.categoryName }} · {{ assignment.reason }}</span
            >
            <TagSuggestionReview
              :items="
                pendingProposal.tagReview?.find((item) => item.recordId === assignment.recordId)
                  ?.tags || []
              "
              :selected="assignment.suggestedTags || []"
              @remove="reviewTag(assignment.recordId, $event, false)"
              @include="reviewTag(assignment.recordId, $event, true)"
              @dismiss="reviewTag(assignment.recordId, $event, false)"
            />
            <span v-if="assignment.suggestedTags?.length" class="text-muted"
              >Tags to add: {{ assignment.suggestedTags.join(' · ') }}</span
            >
          </div>
          <span v-if="pendingProposal.unresolvedRecordIds.length" class="text-xs text-muted"
            >{{ pendingProposal.unresolvedRecordIds.length }} tabs left unassigned due to
            uncertainty</span
          >
          <p
            v-for="item in pendingProposal.unresolvedTagSuggestions?.filter(
              (entry) => entry.suggestedTags.length,
            ) || []"
            :key="item.recordId"
            class="text-xs text-muted"
          >
            {{ store.records.find((record) => record.id === item.recordId)?.title }} · Unassigned ·
            tags to add: {{ item.suggestedTags.join(' · ') }}
          </p>
        </div>
        <div
          v-for="item in pendingProposal.tagReview?.filter((entry) =>
            pendingProposal?.unresolvedRecordIds.includes(entry.recordId),
          ) || []"
          :key="item.recordId"
          class="flex flex-col gap-1 text-xs"
        >
          <span>{{ store.records.find((record) => record.id === item.recordId)?.title }}</span>
          <TagSuggestionReview
            :items="item.tags"
            :selected="
              pendingProposal.unresolvedTagSuggestions?.find(
                (entry) => entry.recordId === item.recordId,
              )?.suggestedTags || []
            "
            @remove="reviewTag(item.recordId, $event, false)"
            @include="reviewTag(item.recordId, $event, true)"
            @dismiss="reviewTag(item.recordId, $event, false)"
          />
        </div>
        <div class="flex flex-wrap justify-end gap-2 border-t border-line pt-3">
          <UiButton size="small" variant="ghost" @click="dismissProposal(pendingProposal.id)"
            >Dismiss</UiButton
          >
          <UiButton size="small" variant="primary" @click="applyProposal(pendingProposal.id)"
            >Apply reviewed structure</UiButton
          >
        </div>
      </article>
      <div
        v-else-if="proposals.some((proposal) => proposal.status === 'stale')"
        class="text-xs text-muted"
        role="status"
      >
        A previous draft became stale after project or tab changes. Create a fresh draft before
        applying.
      </div>
    </section>

    <section v-show="section === 'categories'" class="flex flex-col gap-3">
      <div class="flex items-center justify-between gap-3">
        <div class="flex flex-col gap-1">
          <h2 class="text-sm font-semibold">Categories</h2>
          <UiButton
            v-if="lastCategoryChange"
            size="small"
            variant="ghost"
            @click="restoreCategoryChange"
            >{{ categoryChangeUndone ? 'Redo category change' : 'Undo category change' }}</UiButton
          >
        </div>
        <UiButton size="small" @click="addCategory"><Plus class="size-3.5" />Add category</UiButton>
      </div>
      <UiReorderList
        v-if="categories.length"
        draggable="[data-category-id]"
        handle="[data-category-id]"
        class="flex flex-col divide-y divide-line border-y border-line"
        @end="categoryDropped"
        @start="reorderGesture.start"
        @cancel="reorderGesture.finish"
        @click.capture="reorderGesture.click"
      >
        <div
          v-for="category in categories"
          :key="category.id"
          :data-category-id="category.id"
          class="flex min-w-0 cursor-grab select-none flex-wrap items-center gap-2 px-3 py-2.5 active:cursor-grabbing"
        >
          <div class="flex min-w-0 flex-1 flex-col gap-1">
            <span data-reorder-label class="break-words text-sm font-medium">{{
              category.name
            }}</span
            ><span
              v-if="category.description"
              class="line-clamp-2 break-words text-xs text-muted"
              >{{ category.description }}</span
            >
          </div>
          <ProvenanceLabel compact :provenance="category.provenance" />
          <CategoryActions
            :category="category"
            @edit="editCategory(category)"
            @changed="
              lastCategoryChange = $event;
              categoryChangeUndone = false;
            "
          />
          <span class="text-xs tabular-nums text-muted">{{ count(category) }}</span>
          <UiButton
            v-if="store.selected.size"
            size="small"
            variant="ghost"
            @click="assign(category.id)"
            ><Check class="size-3.5" />Assign selected</UiButton
          >
        </div>
      </UiReorderList>
      <p v-else class="py-3 text-xs text-muted">
        No categories yet. Add the durable structure you want TabFlow to maintain.
      </p>
      <div class="flex items-center gap-3 border-t border-line pt-3">
        <span class="min-w-0 flex-1 text-xs text-muted"
          >{{ unassigned.length }} tabs need a category</span
        >
        <UiButton v-if="store.selected.size" size="small" variant="ghost" @click="assign(null)"
          >Mark selected uncategorized</UiButton
        >
      </div>
    </section>

    <section
      v-show="section === 'tabs'"
      class="flex min-w-0 flex-col gap-3"
      aria-label="Project tabs"
    >
      <div class="flex items-center justify-between gap-3">
        <h2 class="text-sm font-semibold">Project tabs</h2>
        <span class="text-xs text-muted">{{ records.length }} occurrences</span>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <UiSearchInput
          v-model="tabSearch"
          label="Search project tabs"
          placeholder="Find a tab…"
          class="min-w-40 flex-1"
        />
        <UiSelect
          v-model="categoryFilter"
          class="min-w-0 w-48 max-w-full"
          aria-label="Filter project category"
          :options="[
            { label: 'All categories', value: '__all__' },
            { label: 'Uncategorized', value: '__none__' },
            ...categories.map((category) => ({
              label: category.name + ' · ' + count(category),
              value: category.id,
            })),
          ]"
        />
      </div>
      <span v-if="tabSearching" role="status" class="text-xs text-muted">Searching tabs?</span>
      <p v-if="!records.length" class="py-4 text-xs text-muted">
        No tabs are assigned to this project. Select workspace tabs and assign them here.
      </p>
      <div v-else class="relative flex min-w-0 flex-col">
        <UiBranchGuides v-if="store.tabTreeMode" :class="{ invisible: store.draggingTabs }" />
        <TabRow
          v-for="entry in treeTabs.slice(0, shownTabs)"
          :key="entry.record.id"
          :record="entry.record"
          :tree-depth="entry.depth"
          :child-count="entry.childCount"
          :draggable="false"
          separator
        />
        <UiLoadMore
          v-if="shownTabs < treeTabs.length"
          :remaining="treeTabs.length - shownTabs"
          @load="shownTabs += 35"
        />
        <p v-if="!visibleTabs.length" class="px-3 py-4 text-xs text-muted">
          No tabs match these filters.
        </p>
      </div>
      <div
        v-if="selectedLiveCount"
        class="sticky bottom-0 z-20 flex flex-wrap items-center gap-2 rounded-lg border border-line-strong bg-overlay p-2 shadow-lg"
      >
        <span class="min-w-0 flex-1 text-xs text-muted"
          >{{ selectedLiveCount }} selected from the workspace</span
        >
        <UiButton size="small" @click="store.askAssistant(store.selection())"
          >Ask assistant</UiButton
        >
        <UiButton size="small" variant="ghost" @click="store.selected = new Set()">Done</UiButton>
        <UiButton size="small" @click="assign(null)">Add to project as uncategorized</UiButton>
        <UiSelect
          v-if="categories.length"
          model-value=""
          :options="[
            { label: 'Assign to category…', value: '' },
            ...categories.map((category) => ({ label: category.name, value: category.id })),
          ]"
          class="max-w-44"
          aria-label="Assign selected tabs to category"
          @update:model-value="assign"
        />
      </div>
    </section>
  </div>
</template>
