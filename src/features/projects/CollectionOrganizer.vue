<script setup lang="ts">
import { skipFailedCollectionBatch } from '../../shared/collection-analysis';
import UiCheckbox from '../../ui/UiCheckbox.vue';
import UiDisclosure from '../../ui/UiDisclosure.vue';
import UiCollapsible from '../../ui/UiCollapsible.vue';
import { computed, ref, watch } from 'vue';
import { liveQuery } from 'dexie';
import { database } from '../../core/db';
import { useStorage } from '@vueuse/core';
import {
  PhDownloadSimple as Download,
  PhUploadSimple as Upload,
  PhSpinnerGap as LoaderCircle,
  PhSparkle as Sparkles,
  PhSlidersHorizontal as SlidersHorizontal,
  PhCaretDown as ChevronDown,
} from '@phosphor-icons/vue';
import UDropdownMenu from '@nuxt/ui/components/DropdownMenu.vue';
import UPopover from '@nuxt/ui/components/Popover.vue';
import UModal from '@nuxt/ui/components/Modal.vue';
import { useWorkspace } from '../../stores/workspace';
import { useAssistantConversations } from '../../stores/assistant';
import { rpc } from '../../shared/rpc';
import { PROPOSAL_PAGE_SIZE, proposalExport, proposalImport } from '../../shared/proposal-review';
import {
  nativeGroupActions,
  renameDraftProject,
  renameDraftCategory,
  mergeDraftProjects,
} from '../../shared/collection';
import UiButton from '../../ui/UiButton.vue';
import InferenceHistory from '../assistant/InferenceHistory.vue';
import AssistantRunTiming from '../assistant/AssistantRunTiming.vue';
import UiSelect from '../../ui/UiSelect.vue';
import UiTagPicker from '../../ui/UiTagPicker.vue';
import UiTagChecklist from '../../ui/UiTagChecklist.vue';
import TagSuggestionReview from './TagSuggestionReview.vue';
import { resolveTagReview, tagHash } from '../../shared/tag-analysis';
import { editableProposal, setDraftExclusions } from '../../shared/proposal-edits';
import { useDialog } from '../../stores/dialog';
import { matchesTags } from '../../shared/tab-filters';
import ExternalClassificationDialog from './ExternalClassificationDialog.vue';
import ProposalHistory from './ProposalHistory.vue';
import type { CollectionAnalysis, CollectionDraft, CollectionProposal } from '../../shared/types';

const store = useWorkspace();
const dialog = useDialog();
const chat = useAssistantConversations();
const launching = ref(false);
const running = computed(
  () =>
    launching.value ||
    chat.threads.some(
      (thread) =>
        thread.status === 'running' &&
        thread.messages.some(
          (message) =>
            message.collectionAnalysisId === analysisKey.value &&
            message.deliveryStatus === 'generating',
        ),
    ),
);
const resumableAnalysis = ref(false);
const analysisProgress = ref<CollectionAnalysis>();
const analysisKey = useStorage('tabflow.collection.analysisId', 'projects:whole-collection');
let analysisId = analysisKey.value;
watch(
  analysisKey,
  (id, _old, onCleanup) => {
    analysisId = id;
    const subscription = liveQuery(() => database.collectionAnalyses.get(id)).subscribe((saved) => {
      analysisProgress.value = saved;
      resumableAnalysis.value = Boolean(saved);
    });
    onCleanup(() => subscription.unsubscribe());
  },
  { immediate: true },
);
const analysisChat = computed(() =>
  chat.threads.find((thread) =>
    thread.messages.some((message) => message.collectionAnalysisId === analysisKey.value),
  ),
);
const latestAnalysisMessage = computed(() =>
  [...(analysisChat.value?.messages || [])]
    .reverse()
    .find((message) => message.collectionAnalysisId === analysisKey.value),
);
const status = computed(
  () => latestAnalysisMessage.value?.activity.at(-1) || latestAnalysisMessage.value?.content || '',
);
async function skipFailedBatch() {
  if (!analysisProgress.value || running.value) return;
  analysisProgress.value = await rpc(
    'saveCollectionAnalysis',
    skipFailedCollectionBatch(analysisProgress.value),
  );
  await connectAnalysis(
    analysisProgress.value,
    analysisProgress.value.instruction ||
      'Continue the saved analysis, preserving completed decisions and explicit skips. Do not apply changes.',
    true,
  );
}
const importInput = ref<HTMLInputElement>();
const importPreview = ref<ReturnType<typeof proposalImport>>();
const importing = ref(false);
async function readImport(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  await store.run(async () => {
    if (file.size > 5 * 1024 * 1024) throw new Error('Proposal files must be smaller than 5 MB.');
    await store.refresh();
    importPreview.value = proposalImport(
      JSON.parse(await file.text()),
      store.records,
      store.app?.memberships || [],
    );
  });
}
async function saveImport() {
  if (!importPreview.value || importing.value) return;
  importing.value = true;
  try {
    await store.run(async () => {
      const proposal = await rpc('proposeCollection', importPreview.value!.draft);
      await store.refresh();
      selectedPendingId.value = proposal.id;
      importPreview.value = undefined;
      store.notify('Imported as a new review draft. No organization was applied.');
    });
  } finally {
    importing.value = false;
  }
}

const selectedPendingId = ref('');
const pendingProposals = computed(() =>
  (store.app?.collectionProposals || [])
    .filter((proposal) => proposal.status === 'pending' && !proposal.copyState)
    .sort((a, b) => b.createdAt - a.createdAt),
);
const pending = computed(
  () =>
    pendingProposals.value.find((proposal) => proposal.id === selectedPendingId.value) ||
    pendingProposals.value[0],
);
watch(
  () => latestAnalysisMessage.value?.collectionProposalId,
  (id) => {
    if (id) selectedPendingId.value = id;
  },
);
const pendingOptions = computed(() =>
  pendingProposals.value.map((proposal) => ({
    label: `${
      proposal.name ||
      proposal.projects
        .slice(0, 2)
        .map((project) => project.name)
        .join(', ') ||
      'Untitled proposal'
    } · ${proposal.scopeRecordIds?.length ?? proposal.assignments.length + proposal.unresolvedRecordIds.length} tabs`,
    value: proposal.id,
  })),
);
const applied = computed(
  () =>
    store.app?.collectionProposals
      .filter(
        (proposal) =>
          proposal.status === 'applied' || (proposal.copyState && proposal.status !== 'undone'),
      )
      .sort((a, b) => b.createdAt - a.createdAt)[0],
);
const records = computed(() => store.records);
const recordById = computed(() => new Map(records.value.map((record) => [record.id, record])));
const eligibleCount = computed(
  () =>
    store.app?.records.filter(
      (record) =>
        record.live &&
        !record.locked &&
        !store.app?.memberships.some(
          (membership) => membership.recordId === record.id && membership.source === 'owner',
        ),
    ).length ?? 0,
);
const scopedCount = computed(
  () =>
    pending.value?.scopeRecordIds?.length ??
    new Set([
      ...(pending.value?.assignments.map((item) => item.recordId) ?? []),
      ...(pending.value?.unresolvedRecordIds ?? []),
    ]).size,
);
const reviewDraft = ref<CollectionDraft | null>(null);
const selectedDraftTabs = ref(new Set<string>());
const excludedOpen = ref(false);
function toggleDraftSelection(id: string) {
  const ids = new Set(selectedDraftTabs.value);
  if (ids.has(id)) ids.delete(id);
  else ids.add(id);
  selectedDraftTabs.value = ids;
}
function excludeDraftTabs(ids: string[], excluded = true) {
  if (!reviewDraft.value) return;
  setDraftExclusions(reviewDraft.value, ids, excluded);
  selectedDraftTabs.value = new Set();
  markDirty();
}

const draftCache = new Map<string, CollectionDraft>();
const draftBases = new Map<string, Promise<string>>();
const dirtyIds = ref(new Set<string>());
const selectedProjectName = ref('');
const selectedCategoryName = ref('');
const searchText = ref('');
const reviewTags = ref<string[]>([]);
const reviewTagMode = ref<'any' | 'all'>('any');
const reviewUntagged = ref(false);
const shownCount = ref(PROPOSAL_PAGE_SIZE);
const editingRecordId = ref('');
const tagInput = ref<string[]>([]);
const tagProgress = ref({ completed: 0, review: 0 });
watch(
  analysisKey,
  (id, _old, cleanup) => {
    const sub = liveQuery(() =>
      database.tagAnalyses.where('analysisId').equals(id).toArray(),
    ).subscribe((rows) => {
      const latest = new Map<string, (typeof rows)[number]>();
      for (const row of rows) {
        const prior = latest.get(row.recordId);
        if (!prior || row.updatedAt > prior.updatedAt) latest.set(row.recordId, row);
      }
      tagProgress.value = {
        completed: [...latest.values()].filter((row) => row.status === 'complete').length,
        review: [...latest.values()].filter(
          (row) =>
            row.newTags.length ||
            row.uncertain ||
            row.decisions.some((item) => item.outcome === 'uncertain'),
        ).length,
      };
    });
    cleanup(() => sub.unsubscribe());
  },
  { immediate: true },
);
function reviewTag(recordId: string, name: string, include: boolean) {
  const record = recordById.value.get(recordId);
  if (!reviewDraft.value || !record) return;
  try {
    resolveTagReview(reviewDraft.value, record, name, include);
    markDirty();
  } catch (error) {
    store.notify(error instanceof Error ? error.message : String(error));
  }
}
const knownTags = computed(() => store.tagVocabulary);
const confirmDismiss = ref(false);
const reviewBusy = ref(false);
const expandedSummary = ref(false);
const unresolvedChoices = ref<Record<string, string>>({});
watch(
  () =>
    pending.value
      ? `${pending.value.id}:${pending.value.updatedAt || pending.value.createdAt}`
      : '',
  () => {
    const proposal = pending.value;
    if (proposal && !dirtyIds.value.has(proposal.id))
      draftBases.set(proposal.id, tagHash(proposal));
    reviewDraft.value =
      proposal && dirtyIds.value.has(proposal.id) && draftCache.has(proposal.id)
        ? draftCache.get(proposal.id)!
        : proposal
          ? {
              summary: proposal.summary,
              name: proposal.name,
              decisionContract: proposal.decisionContract,
              tagReview: proposal.tagReview?.map((item) => ({
                ...item,
                tags: item.tags.map((tag) => ({ ...tag })),
              })),
              legacyCategoriesRetained: proposal.legacyCategoriesRetained,
              projects: proposal.projects.map((project) => ({
                ...project,
                categories: project.categories.map((category) => ({ ...category })),
              })),
              assignments: proposal.assignments.map((assignment) => ({ ...assignment })),
              unresolvedRecordIds: [...proposal.unresolvedRecordIds],
              unresolvedTagSuggestions: proposal.unresolvedTagSuggestions?.map((item) => ({
                ...item,
                suggestedTags: [...item.suggestedTags],
              })),
              scopeRecordIds: proposal.scopeRecordIds,
              excludedRecordIds: proposal.excludedRecordIds,
              sourceJobIds: proposal.sourceJobIds,
              ownerAssignedRecordIds: [...(proposal.ownerAssignedRecordIds || [])],
              model: proposal.model,
            }
          : null;
    if (proposal && reviewDraft.value) draftCache.set(proposal.id, reviewDraft.value);
    if (!proposal?.projects.some((project) => project.name === selectedProjectName.value)) {
      selectedProjectName.value = proposal?.projects[0]?.name || '';
      selectedCategoryName.value = '';
    }
    shownCount.value = PROPOSAL_PAGE_SIZE;
    editingRecordId.value = '';
    confirmDismiss.value = false;
    unresolvedChoices.value = {};
  },
  { immediate: true },
);
const projectOptions = computed(() =>
  (reviewDraft.value?.projects || []).map((project) => ({
    label: project.name,
    value: project.name,
  })),
);
const projectedWindowCount = computed(
  () => new Set(reviewDraft.value?.assignments.map((item) => item.projectName) || []).size,
);
const proposalIndex = computed(() => {
  const byProject = new Map<string, CollectionDraft['assignments']>();
  const byCategory = new Map<string, CollectionDraft['assignments']>();
  for (const assignment of reviewDraft.value?.assignments || []) {
    if (reviewDraft.value?.excludedRecordIds?.includes(assignment.recordId)) continue;
    const project = byProject.get(assignment.projectName) || [];
    project.push(assignment);
    byProject.set(assignment.projectName, project);
    const key = JSON.stringify([assignment.projectName, assignment.categoryName]);
    const category = byCategory.get(key) || [];
    category.push(assignment);
    byCategory.set(key, category);
  }
  return { byProject, byCategory };
});
const proposedTagsByRecord = computed(
  () =>
    new Map(
      [
        ...(reviewDraft.value?.assignments || []),
        ...(reviewDraft.value?.unresolvedTagSuggestions || []),
      ].map((item) => [item.recordId, item.suggestedTags || []]),
    ),
);
const activeProject = computed(() =>
  reviewDraft.value?.projects.find((project) => project.name === selectedProjectName.value),
);
const activeAssignments = computed(() =>
  selectedProjectName.value === '__unresolved__'
    ? []
    : selectedProjectName.value === '__all__'
      ? reviewDraft.value?.assignments || []
      : selectedCategoryName.value
        ? proposalIndex.value.byCategory.get(
            JSON.stringify([selectedProjectName.value, selectedCategoryName.value]),
          ) || []
        : proposalIndex.value.byProject.get(selectedProjectName.value) || [],
);
const tagOptions = computed(() => {
  const tags = new Set<string>();
  const ids = reviewDraft.value?.scopeRecordIds || [
    ...(reviewDraft.value?.assignments.map((item) => item.recordId) || []),
    ...(reviewDraft.value?.unresolvedRecordIds || []),
  ];
  for (const id of ids) for (const tag of recordById.value.get(id)?.tags || []) tags.add(tag);
  for (const assignment of reviewDraft.value?.assignments || [])
    for (const tag of assignment.suggestedTags || []) tags.add(tag);
  for (const item of reviewDraft.value?.unresolvedTagSuggestions || [])
    for (const tag of item.suggestedTags) tags.add(tag);
  return [...tags].sort();
});
const sourceChats = computed(() =>
  chat.threads.filter((thread) =>
    thread.messages.some((message) => message.collectionProposalId === pending.value?.id),
  ),
);
const activeProjectChats = computed(() => {
  const projectId = store.app?.projects.find(
    (project) => project.name === activeProject.value?.name,
  )?.id;
  return projectId ? chat.threads.filter((thread) => thread.projectId === projectId) : [];
});
const chatLookupDone = ref(false);
async function findSourceChats() {
  if (!chat.threads.length) await chat.load();
  chatLookupDone.value = true;
}
function matchesFilters(recordId: string) {
  const record = recordById.value.get(recordId);
  const query = searchText.value.trim().toLocaleLowerCase();
  if (query && !`${record?.title || ''} ${record?.url || ''}`.toLocaleLowerCase().includes(query))
    return false;
  const suggested = proposedTagsByRecord.value.get(recordId) || [];
  return matchesTags([...new Set([...(record?.tags || []), ...suggested])], {
    tags: reviewTags.value,
    mode: reviewTagMode.value,
    untagged: reviewUntagged.value,
  });
}
const filteredAssignments = computed(() =>
  activeAssignments.value.filter(
    (assignment) =>
      !reviewDraft.value?.excludedRecordIds?.includes(assignment.recordId) &&
      matchesFilters(assignment.recordId),
  ),
);
const filteredUnresolved = computed(() =>
  (reviewDraft.value?.unresolvedRecordIds || []).filter(
    (id) => !reviewDraft.value?.excludedRecordIds?.includes(id) && matchesFilters(id),
  ),
);
const visibleAssignments = computed(() => filteredAssignments.value.slice(0, shownCount.value));
const visibleUnresolved = computed(() => filteredUnresolved.value.slice(0, shownCount.value));
const remainingCount = computed(() =>
  Math.max(
    0,
    (selectedProjectName.value === '__unresolved__'
      ? filteredUnresolved.value.length
      : filteredAssignments.value.length) - shownCount.value,
  ),
);
function selectSection(projectName: string, categoryName = '') {
  selectedProjectName.value = projectName;
  selectedCategoryName.value = categoryName;
  shownCount.value = PROPOSAL_PAGE_SIZE;
  editingRecordId.value = '';
}
function editRecord(recordId: string) {
  editingRecordId.value = editingRecordId.value === recordId ? '' : recordId;
  tagInput.value = [...(recordById.value.get(recordId)?.tags || [])];
}
async function saveTags(recordId: string) {
  const tags = [...new Set(tagInput.value.map((tag) => tag.trim()).filter(Boolean))];
  if (tags.some((tag) => tag.length > 80)) {
    store.notify('Use tags under 80 characters.');
    return;
  }
  await store.run(async () => {
    await rpc('record', { id: recordId, patch: { tags } });
    await store.refresh();
    store.notify('Tags saved on the original tab. New copies will carry them.');
  });
}
function markDirty() {
  if (!pending.value) return;
  dirtyIds.value = new Set([...dirtyIds.value, pending.value.id]);
}
function editSuggestedTags(assignment: CollectionDraft['assignments'][number], value: string[]) {
  assignment.suggestedTags = value;
  markDirty();
}
function exportDraft() {
  if (!pending.value || !reviewDraft.value) return;
  const data = proposalExport(pending.value, reviewDraft.value, records.value);
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = `tabflow-proposal-${pending.value.id.slice(0, 8)}.json`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function openSourceChat(id: string) {
  if (chat.current?.status === 'running' && chat.activeId !== id) {
    store.notify('Wait for the active assistant run to finish before switching chats.');
    return;
  }
  await chat.select(id);
  store.show('assistant');
}
const flattenedChoices = computed(() =>
  (reviewDraft.value?.projects || []).flatMap((project) =>
    project.categories.map((category) => ({
      label: `${project.name} / ${category.name}`,
      value: JSON.stringify([project.name, category.name]),
    })),
  ),
);
function categoryOptions(projectName: string) {
  return (
    reviewDraft.value?.projects
      .find((project) => project.name === projectName)
      ?.categories.map((category) => ({ label: category.name, value: category.name })) || []
  );
}
function renameProject(project: CollectionDraft['projects'][number], value: string) {
  if (!reviewDraft.value) return;
  try {
    const previous = project.name;
    renameDraftProject(reviewDraft.value, previous, value);
    if (selectedProjectName.value === previous) selectedProjectName.value = value.trim();
    markDirty();
  } catch (error) {
    store.notify(error instanceof Error ? error.message : String(error));
  }
}
function mergeProject(sourceName: string, targetName: string) {
  if (!reviewDraft.value || !targetName) return;
  try {
    mergeDraftProjects(reviewDraft.value, sourceName, targetName);
    if (selectedProjectName.value === sourceName) selectSection(targetName);
    markDirty();
  } catch (error) {
    store.notify(error instanceof Error ? error.message : String(error));
  }
}
function renameCategory(
  project: CollectionDraft['projects'][number],
  category: CollectionDraft['projects'][number]['categories'][number],
  value: string,
) {
  if (!reviewDraft.value) return;
  try {
    const previous = category.name;
    renameDraftCategory(reviewDraft.value, project.name, previous, value);
    if (selectedCategoryName.value === previous) selectedCategoryName.value = value.trim();
    markDirty();
  } catch (error) {
    store.notify(error instanceof Error ? error.message : String(error));
  }
}
function setProject(assignment: CollectionProposal['assignments'][number], projectName: string) {
  markDirty();
  assignment.projectName = projectName;
  if (reviewDraft.value && !reviewDraft.value.ownerAssignedRecordIds?.includes(assignment.recordId))
    reviewDraft.value.ownerAssignedRecordIds = [
      ...(reviewDraft.value.ownerAssignedRecordIds || []),
      assignment.recordId,
    ];
  const categories = categoryOptions(projectName);
  if (!categories.some((category) => category.value === assignment.categoryName))
    assignment.categoryName = categories[0]?.value || '';
}
function createDraftOption(
  assignment: CollectionDraft['assignments'][number],
  name: string,
  project: boolean,
) {
  const text = name.trim();
  if (!reviewDraft.value || !text || text.length > 80) {
    store.notify('Use a name between 1 and 80 characters.');
    return;
  }
  if (project) {
    let target = reviewDraft.value.projects.find(
      (entry) => entry.name.toLocaleLowerCase() === text.toLocaleLowerCase(),
    );
    if (!target) {
      target = {
        name: text,
        areaName:
          reviewDraft.value.projects.find((entry) => entry.name === assignment.projectName)
            ?.areaName || null,
        purpose: '',
        categories: [{ name: 'General', description: '' }],
      };
      reviewDraft.value.projects.push(target);
    }
    setProject(assignment, target.name);
  } else {
    const target = reviewDraft.value.projects.find(
      (entry) => entry.name === assignment.projectName,
    );
    if (!target) return;
    let category = target.categories.find(
      (entry) => entry.name.toLocaleLowerCase() === text.toLocaleLowerCase(),
    );
    if (!category) {
      category = { name: text, description: '' };
      target.categories.push(category);
    }
    setCategory(assignment, category.name);
  }
  markDirty();
}
function setCategory(assignment: CollectionProposal['assignments'][number], categoryName: string) {
  markDirty();
  assignment.categoryName = categoryName;
  if (reviewDraft.value && !reviewDraft.value.ownerAssignedRecordIds?.includes(assignment.recordId))
    reviewDraft.value.ownerAssignedRecordIds = [
      ...(reviewDraft.value.ownerAssignedRecordIds || []),
      assignment.recordId,
    ];
}
function leaveUnassigned(recordId: string) {
  if (!reviewDraft.value) return;
  markDirty();
  const previous = reviewDraft.value.assignments.find((item) => item.recordId === recordId);
  if (previous?.suggestedTags?.length)
    reviewDraft.value.unresolvedTagSuggestions = [
      ...(reviewDraft.value.unresolvedTagSuggestions || []).filter(
        (item) => item.recordId !== recordId,
      ),
      {
        recordId,
        url: previous.url,
        navigationVersion: previous.navigationVersion,
        suggestedTags: [...previous.suggestedTags],
      },
    ];
  reviewDraft.value.assignments = reviewDraft.value.assignments.filter(
    (assignment) => assignment.recordId !== recordId,
  );
  if (!reviewDraft.value.unresolvedRecordIds.includes(recordId))
    reviewDraft.value.unresolvedRecordIds.push(recordId);
  reviewDraft.value.ownerAssignedRecordIds = (
    reviewDraft.value.ownerAssignedRecordIds || []
  ).filter((id) => id !== recordId);
}
function assignUnresolved(recordId: string) {
  if (!reviewDraft.value) return;
  markDirty();
  const record = records.value.find((candidate) => candidate.id === recordId);
  if (!record) return;
  let value: unknown;
  try {
    value = JSON.parse(unresolvedChoices.value[recordId] || 'null');
  } catch {
    return;
  }
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    typeof value[0] !== 'string' ||
    typeof value[1] !== 'string'
  )
    return;
  reviewDraft.value.assignments.push({
    recordId,
    url: record.url,
    navigationVersion: record.navigationVersion,
    projectName: value[0],
    categoryName: value[1],
    reason: 'Assigned by the owner during proposal review.',
    confidence: 1,
    suggestedTags: reviewDraft.value.unresolvedTagSuggestions?.find(
      (item) => item.recordId === recordId,
    )?.suggestedTags,
  });
  reviewDraft.value.unresolvedTagSuggestions = reviewDraft.value.unresolvedTagSuggestions?.filter(
    (item) => item.recordId !== recordId,
  );
  reviewDraft.value.ownerAssignedRecordIds = [
    ...(reviewDraft.value.ownerAssignedRecordIds || []),
    recordId,
  ];
  reviewDraft.value.unresolvedRecordIds = reviewDraft.value.unresolvedRecordIds.filter(
    (id) => id !== recordId,
  );
}
const groupActions = computed(() =>
  applied.value && !applied.value.copyState && store.app
    ? nativeGroupActions(applied.value, store.app)
    : [],
);
const copyOperation = computed(() =>
  store.app?.operations.find((operation) => operation.id === applied.value?.copyState?.operationId),
);
async function connectAnalysis(analysis: CollectionAnalysis, label: string, start = false) {
  const link = await chat.connectCollectionAnalysis(analysis, label);
  store.show('assistant');
  if (start) chat.analysisLaunch = link;
}
async function analyze() {
  if (!store.app || running.value) return;
  launching.value = true;
  try {
    await store.refresh();
    let saved = await rpc('getCollectionAnalysis', { id: analysisId });
    if (!saved) {
      const corrected = new Set(
        store.app.memberships
          .filter((item) => item.source === 'owner')
          .map((item) => item.recordId),
      );
      const eligible = store.app.records.filter(
        (record) => record.live && !record.locked && !corrected.has(record.id),
      );
      if (!eligible.length) throw new Error('No eligible open tabs to analyze.');
      saved = await rpc('saveCollectionAnalysis', {
        id: analysisId,
        decisionContract: 'isolated-evidence-v2',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        revision: 1,
        purpose: 'proposal',
        instruction: '',
        reuseAcceptedTaxonomyOnly: false,
        scope: eligible.map(({ id, url, navigationVersion }) => ({ id, url, navigationVersion })),
        projects: [],
        discoveredIds: [],
        classifiedIds: [],
        summaries: [],
        assignments: [],
        unresolvedRecordIds: [],
      });
    }
    await connectAnalysis(
      saved,
      saved.instruction ||
        'Prepare a reviewable organization of these tabs into useful projects, categories. Tags can be analyzed separately later. Preserve original tabs, windows and groups. Do not apply changes.',
      true,
    );
  } catch (error) {
    store.notify(error instanceof Error ? error.message : String(error));
  } finally {
    launching.value = false;
  }
}
async function restartAnalysis() {
  if (running.value) return;
  analysisId = crypto.randomUUID();
  analysisKey.value = analysisId;
  resumableAnalysis.value = false;
  analysisProgress.value = undefined;
  await analyze();
}
async function repairAnalysis(stage: 'discovery' | 'classification' | 'tagging' | 'skipped') {
  if (running.value || !analysisProgress.value) return;
  const branch = await rpc('repairCollectionAnalysis', { id: analysisId, stage });
  analysisId = branch.id;
  analysisKey.value = branch.id;
  analysisProgress.value = branch;
  resumableAnalysis.value = true;
  await connectAnalysis(
    branch,
    stage === 'discovery'
      ? 'Re-evaluate the project structure and categories from the saved tab scope. Tags can be analyzed separately later. Preserve the original analysis and drafts. Prepare a separate proposal; do not apply.'
      : stage === 'skipped'
        ? 'Retry only the explicitly skipped occurrences against the saved project/category structure. Retain compatible completed decisions and preserve the source draft. Do not apply.'
        : stage === 'tagging'
          ? 'Re-evaluate independent tags only. Keep the saved project/category choices for review and preserve the original analysis.'
          : 'Recheck the saved project meanings and category assignments. Tags can be analyzed separately later. Reuse saved discovery, keep the original analysis, and prepare a separate proposal.',
  );
  store.notify('Repair prepared in the linked chat. Resume analysis to start.');
}
async function repairDraft(stage: 'classification' | 'tagging' = 'classification') {
  if (!pending.value || running.value) return;
  if (dirtyIds.value.has(pending.value.id)) await saveDraft();
  if (dirtyIds.value.has(pending.value.id)) return;
  const branch = await rpc('repairCollectionProposal', { id: pending.value.id, stage });
  analysisId = branch.id;
  analysisKey.value = branch.id;
  analysisProgress.value = branch;
  resumableAnalysis.value = true;
  await connectAnalysis(
    branch,
    stage === 'tagging'
      ? 'Repair independent tags only in a separate draft. Preserve saved project/category choices and the original draft; do not apply.'
      : 'Re-evaluate this saved proposal into a separate review draft. Recheck project structure and categories using saved discovery. Tags can be analyzed separately later. Preserve the original draft and edits; do not apply changes.',
  );
  store.notify('Repair prepared in the source chat. Resume analysis to start.');
}
async function apply(mode: 'semantic' | 'copy') {
  if (!pending.value || !reviewDraft.value || reviewBusy.value) return;
  const id = pending.value.id;
  const draft = reviewDraft.value;
  reviewBusy.value = true;
  try {
    await store.run(async () => {
      await rpc('updateCollectionDraft', {
        id,
        draft,
        expectedFingerprint: await draftBases.get(id),
      });
      const result =
        mode === 'semantic'
          ? { proposal: await rpc('applyCollection', { id }), operation: undefined }
          : await rpc('organizeCollection', { id });
      await store.refresh();
      store.notify(
        result.operation?.status === 'partial'
          ? 'Creation is partial. Completed copies remain; review the errors and explicitly retry or undo.'
          : result.proposal.copyState
            ? 'New project windows and category groups created. Originals retained; copies start sleeping. Continuous project-window review is enabled.'
            : 'Projects and categories saved on existing tabs. Browser windows, groups and tabs were not changed.',
      );
    });
  } finally {
    reviewBusy.value = false;
  }
}
async function saveDraft() {
  if (!pending.value || !reviewDraft.value || reviewBusy.value) return;
  const id = pending.value.id;
  const draft = reviewDraft.value;
  reviewBusy.value = true;
  try {
    await store.run(async () => {
      await rpc('updateCollectionDraft', {
        id,
        draft,
        expectedFingerprint: await draftBases.get(id),
      });
      dirtyIds.value = new Set([...dirtyIds.value].filter((entry) => entry !== id));
      draftCache.delete(id);
      await store.refresh();
      store.notify('Draft edits saved. No organization was applied.');
    });
  } finally {
    reviewBusy.value = false;
  }
}
async function syncChangedTabs() {
  if (!pending.value || !reviewDraft.value || reviewBusy.value) return;
  const id = pending.value.id;
  const before = reviewDraft.value.assignments.length;
  reviewBusy.value = true;
  try {
    await store.run(async () => {
      const rebased = await rpc('rebaseCollectionDraft', {
        id,
        draft: dirtyIds.value.has(id) ? reviewDraft.value! : undefined,
        expectedFingerprint: await draftBases.get(id),
      });
      dirtyIds.value = new Set([...dirtyIds.value].filter((entry) => entry !== id));
      draftCache.delete(id);
      await store.refresh();
      store.notify(
        before === rebased.assignments.length
          ? 'Draft is current. Your review edits are saved.'
          : `${before - rebased.assignments.length} changed tabs moved to Uncertain for review. Completed assignments and your edits were kept.`,
      );
    });
  } finally {
    reviewBusy.value = false;
  }
}
async function reloadSavedDraft() {
  if (!pending.value || reviewBusy.value) return;
  const id = pending.value.id;
  if (
    dirtyIds.value.has(id) &&
    !(await dialog.ask(
      'Reload saved draft?',
      [],
      'Discard your unsaved local edits and load the latest saved version.',
      'Reload draft',
    ))
  )
    return;
  reviewBusy.value = true;
  try {
    await store.run(async () => {
      await store.refresh();
      const current = store.app?.collectionProposals.find(
        (item) => item.id === id && item.status === 'pending',
      );
      if (!current) throw new Error('This draft is no longer pending.');
      dirtyIds.value = new Set([...dirtyIds.value].filter((item) => item !== id));
      reviewDraft.value = editableProposal(current);
      draftCache.set(id, reviewDraft.value);
      draftBases.set(id, tagHash(current));
    });
  } finally {
    reviewBusy.value = false;
  }
}
async function dismiss() {
  if (!pending.value || reviewBusy.value) return;
  if (!confirmDismiss.value) {
    confirmDismiss.value = true;
    return;
  }
  const id = pending.value.id;
  reviewBusy.value = true;
  try {
    await store.run(async () => {
      await rpc('dismissCollection', { id });
      draftCache.delete(id);
      confirmDismiss.value = false;
      await store.refresh();
    });
  } finally {
    reviewBusy.value = false;
  }
}
async function createNativeGroups() {
  if (!applied.value || (!groupActions.value.length && !applied.value.copyState)) return;
  await store.run(async () => {
    const result = await rpc('organizeCollection', { id: applied.value!.id });
    await store.refresh();
    store.notify(
      result.operation?.status === 'partial'
        ? 'Some native groups still failed. See History.'
        : 'Project arrangement completed.',
    );
  });
}
async function undoOrganization() {
  if (!applied.value) return;
  await store.run(async () => {
    const result = await rpc('undoCollection', { id: applied.value!.id });
    await store.refresh();
    store.notify(
      result.outcomes.some((outcome) => !outcome.ok)
        ? 'Browser recovery was partial. Assignments were kept for retry.'
        : applied.value?.copyState
          ? `Removed ${result.restored} untouched sleeping copies; retained ${result.skipped} changed/protected copies. Original tabs are untouched.`
          : `Organization undone · ${result.restored} assignments restored · ${result.skipped} newer corrections retained.`,
    );
  });
}
</script>

<template>
  <section class="flex flex-col gap-3 border-b border-line pb-5">
    <div class="flex min-w-0 flex-col gap-3">
      <div class="flex min-w-0 flex-col gap-1">
        <h2 class="text-sm font-semibold">Understand the whole collection</h2>
        <p v-if="!pending" class="text-xs leading-5 text-muted">
          Analyze open tabs across all windows, including suspended tabs using their recovered
          original URLs. Propose life/work areas, projects, and categories. Cached page text may be
          sent to the configured model. Locked tabs and your saved corrections are skipped. Use the
          structure on existing tabs without changing browser placement, or explicitly create
          sleeping copies in new project windows.
        </p>
        <p v-else class="text-xs text-muted">
          Review the saved draft. Using its structure in TabFlow keeps browser tabs and groups in
          place; creating new project windows is a separate choice.
        </p>
      </div>
      <div
        class="flex min-w-0 flex-wrap items-center gap-2"
        role="group"
        aria-label="Collection analysis actions"
      >
        <input
          ref="importInput"
          type="file"
          accept="application/json,.json"
          class="hidden"
          aria-label="Proposal JSON file"
          @change="readImport"
        />
        <ExternalClassificationDialog />
        <UiButton size="small" variant="default" :disabled="running" @click="importInput?.click()"
          ><Upload class="size-3.5" />Import draft</UiButton
        >
        <UiButton
          size="small"
          :disabled="
            running ||
            Boolean(applied?.copyState && copyOperation?.status !== 'complete') ||
            !records.length
          "
          @click="analyze"
          ><LoaderCircle v-if="running" class="size-3.5 animate-spin" /><Sparkles
            v-else
            class="size-3.5"
          />{{
            running
              ? 'Analyzing'
              : analysisProgress?.failedBatch
                ? 'Retry failed batch'
                : resumableAnalysis
                  ? 'Resume analysis'
                  : 'Analyze collection'
          }}</UiButton
        >
        <UiButton
          v-if="running"
          size="small"
          variant="ghost"
          :disabled="chat.runningAnalysisId !== analysisId"
          :title="
            chat.runningAnalysisId !== analysisId
              ? 'Stop this analysis from the TabFlow view running it'
              : undefined
          "
          @click="chat.cancelAnalysisId = analysisId"
          >Cancel</UiButton
        >
        <UiButton
          v-if="analysisChat"
          size="small"
          variant="ghost"
          @click="openSourceChat(analysisChat.id)"
          >Open analysis chat</UiButton
        >
        <UDropdownMenu
          v-if="analysisProgress && !running"
          :items="[
            [
              {
                label: 'Retry skipped tabs only',
                description: 'Keep completed decisions in a separate repair draft.',
                disabled: !analysisProgress.skippedRecordIds?.length,
                onSelect: () => store.run(() => repairAnalysis('skipped')),
              },
              {
                label: 'Rebuild project structure',
                description: 'Rediscover projects and recheck categories.',
                onSelect: () => store.run(() => repairAnalysis('discovery')),
              },
              {
                label: 'Recheck projects and categories',
                description: 'Reuse saved discovery and re-evaluate assignments.',
                onSelect: () => store.run(() => repairAnalysis('classification')),
              },
              {
                label: 'Repair tags only',
                description: 'Keep project/category choices for review.',
                onSelect: () => store.run(() => repairAnalysis('tagging')),
              },
            ],
            [
              {
                label: 'Start new analysis',
                description: 'Start a separate analysis; keep this one.',
                onSelect: () => store.run(restartAnalysis),
              },
            ],
          ]"
          :ui="{ content: 'w-80 max-w-[calc(100vw-32px)] bg-overlay', item: 'min-h-9 text-[13px]' }"
        >
          <UiButton size="small" variant="default"
            >Repair analysis<ChevronDown class="size-3.5"
          /></UiButton>
        </UDropdownMenu>
      </div>
    </div>
    <UModal
      :open="Boolean(importPreview)"
      title="Import organization draft"
      description="Creates a separate review draft. Existing proposals and browser tabs stay untouched."
      :ui="{ content: 'max-w-lg bg-overlay', footer: 'justify-end gap-2' }"
      @update:open="
        (open) => {
          if (!open && !importing) importPreview = undefined;
        }
      "
    >
      <template #body
        ><div v-if="importPreview" class="flex flex-col gap-3 text-[13px]">
          <p v-if="importPreview.sourceScope" class="font-medium">
            {{ importPreview.sourceScope.label }} · {{ importPreview.sourceScope.count }} exported
            occurrences
          </p>
          <p>
            {{ importPreview.draft.assignments.length }} assigned ·
            {{ importPreview.draft.unresolvedRecordIds.length }} uncertain ·
            {{ importPreview.skipped.length }} skipped
          </p>
          <p class="text-muted">
            Only matching open occurrences are included. Newer tabs are left alone.
          </p>
          <p v-if="importPreview.legacyAddressChecks" class="text-muted">
            This older export has no navigation versions. Addresses were compared without query
            strings or fragments; check the assignments before applying.
          </p>
          <ul
            v-if="importPreview.skipped.length"
            class="flex max-h-48 flex-col gap-2 overflow-y-auto"
          >
            <li v-for="item in importPreview.skipped" :key="item.id" class="flex flex-col gap-1">
              <span class="truncate">{{ item.title }}</span
              ><span class="text-xs text-muted">{{ item.reason }}</span>
            </li>
          </ul>
        </div></template
      >
      <template #footer
        ><UiButton :disabled="importing" @click="importPreview = undefined">Cancel</UiButton
        ><UiButton variant="primary" :disabled="importing" @click="saveImport"
          ><LoaderCircle v-if="importing" class="size-3.5 animate-spin" />Save review
          draft</UiButton
        ></template
      >
    </UModal>
    <AssistantRunTiming v-if="latestAnalysisMessage" :message="latestAnalysisMessage" />
    <InferenceHistory :analysis-id="analysisKey" />
    <p v-if="analysisProgress" class="text-xs text-muted" role="status">
      {{ analysisProgress.classifiedIds.length }} / {{ analysisProgress.scope.length }} categories
      checked
      <span v-if="analysisProgress.taggingRequested">
        ? {{ tagProgress.completed }} / {{ analysisProgress.scope.length }} tabs processed for
        tags</span
      >
      <span v-else> ? Tags optional</span>
      <span v-if="tagProgress.review"> ? {{ tagProgress.review }} need tag review</span>
      <template v-if="analysisProgress.taxonomyProgress">
        ? {{ analysisProgress.taxonomyProgress.cursor }} /
        {{ analysisProgress.taxonomyProgress.sources.length }} project meanings reconciled</template
      >
    </p>
    <p v-if="analysisProgress?.legacyCategoriesRetained" class="text-xs text-muted" role="status">
      Category choices from the older analysis were retained. Verify them before applying.
    </p>
    <p v-if="running" class="text-xs text-muted" role="status">{{ status }}</p>
    <p v-else-if="analysisProgress?.failedBatch" class="text-xs text-muted" role="status">
      {{
        analysisProgress.failedBatch.stage === 'discovery'
          ? analysisProgress.discoveredIds.length
          : analysisProgress.classifiedIds.length
      }}
      of {{ analysisProgress.scope.length }} saved · failed
      {{ analysisProgress.failedBatch.stage }} batch:
      {{ analysisProgress.failedBatch.recordIds.length }} tabs after
      {{ analysisProgress.failedBatch.attempts }} attempts. Retry continues from this batch.
    </p>
    <UiButton
      v-if="!running && analysisProgress?.failedBatch"
      size="small"
      variant="ghost"
      class="self-start"
      @click="store.run(skipFailedBatch)"
      >Skip failed tabs and continue</UiButton
    >
    <p v-if="analysisProgress?.skippedRecordIds?.length" class="text-xs text-muted" role="status">
      {{ analysisProgress.skippedRecordIds.length }} tabs explicitly skipped and left unassigned.
      Repair analysis can retry them in a separate draft.
    </p>
    <div
      v-if="store.app?.settings.maintainCollectionReview"
      class="flex flex-col gap-2 text-xs text-muted"
    >
      <p>
        New-tab maintenance is on. Suggestions use accepted project categories and wait for your
        review, including tabs that already landed in a group. It pauses behind a pending proposal;
        keep the dashboard or browser side panel open.
        {{
          store.app.settings.reviewProjectWindowsOnly
            ? 'Only tabs assigned to projects are monitored.'
            : 'All windows are monitored.'
        }}
      </p>
      <p v-if="!store.app.categories.length">
        Accept project categories first with Analyze collection.
      </p>
      <div
        v-for="job in store.app.organizationJobs.filter(
          (item) =>
            item.kind === 'collection' && ['queued', 'running', 'error'].includes(item.status),
        )"
        :key="job.id"
        class="flex items-center gap-3"
      >
        <span class="min-w-0 flex-1 truncate"
          >{{ store.app.records.find((record) => record.id === job.recordId)?.title || 'Tab' }} ·
          {{ job.status }}<span v-if="job.error"> · {{ job.error }}</span></span
        >
        <UiButton
          v-if="job.status === 'error'"
          size="small"
          variant="ghost"
          @click="
            store.run(async () => {
              await rpc('retryOrganizationJob', { id: job.id });
              await store.refresh();
            })
          "
          >Retry</UiButton
        >
      </div>
    </div>
    <article
      v-if="pending"
      class="flex flex-col gap-3 bg-raised p-3"
      aria-label="Whole collection proposal"
      :aria-busy="reviewBusy"
      :inert="reviewBusy"
    >
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="flex flex-col gap-1">
          <h3 class="text-sm font-semibold">Review organization</h3>
          <p class="text-xs text-muted">
            A draft for projects and categories. Original tabs stay in place.
          </p>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <span v-if="reviewBusy" class="flex items-center gap-1 text-xs text-muted"
            ><LoaderCircle class="size-3.5 animate-spin" />Working on proposal</span
          >
          <span v-if="dirtyIds.has(pending.id)" class="text-xs text-muted">Unsaved edits</span>
          <UiButton
            v-if="dirtyIds.has(pending.id)"
            size="small"
            variant="ghost"
            :disabled="reviewBusy"
            @click="reloadSavedDraft"
            >Reload saved draft</UiButton
          >
          <UiButton size="small" variant="secondary" @click="exportDraft"
            ><Download class="size-3.5" />Export draft</UiButton
          >
          <UiButton size="small" variant="secondary" @click="syncChangedTabs"
            >Sync changed tabs</UiButton
          >
          <UiButton
            size="small"
            variant="secondary"
            :disabled="running"
            @click="store.run(() => repairDraft('tagging'))"
            >Analyze tags</UiButton
          >
          <UDropdownMenu
            :items="[
              {
                label: 'Re-evaluate in a new draft',
                onSelect: () => store.run(() => repairDraft('classification')),
              },
            ]"
          >
            <UiButton size="small" variant="secondary" :disabled="running"
              >Repair draft<ChevronDown class="size-3.5"
            /></UiButton>
          </UDropdownMenu>
          <UiButton size="small" @click="saveDraft">Save draft edits</UiButton>
        </div>
      </div>
      <label v-if="pendingProposals.length > 1" class="field-label max-w-lg">
        Review proposal
        <UiSelect
          :model-value="pending?.id || ''"
          :options="pendingOptions"
          @update:model-value="selectedPendingId = $event"
        />
      </label>
      <ProposalHistory
        :proposal="pending"
        :disabled="reviewBusy || dirtyIds.has(pending.id)"
        @restored="reloadSavedDraft"
      />
      <p class="text-xs text-muted">
        {{ scopedCount }} of {{ eligibleCount }} eligible tabs covered
      </p>
      <p
        v-if="!reviewDraft?.decisionContract || reviewDraft.legacyCategoriesRetained"
        class="text-xs text-muted"
        role="status"
      >
        {{
          reviewDraft?.legacyCategoriesRetained
            ? 'Retained category choices need manual verification.'
            : 'This older or imported draft has not been rechecked with the current classification format.'
        }}
        Re-evaluate in a new draft to keep this version for comparison.
      </p>
      <p v-if="scopedCount < eligibleCount" class="text-xs text-muted">
        This draft covers only its selected occurrences. Other tabs stay unchanged; you can apply
        this scope without analyzing the whole collection.
      </p>
      <p class="text-xs text-muted">
        {{ reviewDraft?.assignments.length }} assigned ·
        {{ reviewDraft?.unresolvedRecordIds.length }} uncertain · 0 new windows for TabFlow-only
        organization
      </p>
      <label v-if="reviewDraft" class="field-label"
        >Proposal name<input
          v-model="reviewDraft.name"
          class="field"
          maxlength="120"
          placeholder="Name this proposal"
          @input="markDirty"
      /></label>
      <div v-if="reviewDraft?.summary" class="flex flex-col gap-1 text-xs leading-5 text-muted">
        <p :class="expandedSummary ? 'whitespace-pre-wrap' : 'line-clamp-2'">
          {{ reviewDraft.summary }}
        </p>
        <UiButton
          size="small"
          variant="ghost"
          class="self-start"
          @click="expandedSummary = !expandedSummary"
          >{{ expandedSummary ? 'Show less' : 'Read analysis' }}</UiButton
        >
      </div>
      <div v-if="sourceChats.length" class="flex flex-wrap items-center gap-2 text-xs text-muted">
        <span>From chat</span>
        <UiButton
          v-for="thread in sourceChats"
          :key="thread.id"
          size="small"
          variant="ghost"
          @click="openSourceChat(thread.id)"
          >{{ thread.title }}</UiButton
        >
      </div>
      <UiButton
        v-else-if="!chatLookupDone"
        size="small"
        variant="ghost"
        class="self-start"
        @click="findSourceChats"
        >Find source chat</UiButton
      >
      <p v-else class="text-xs text-muted">No saved chat is linked to this proposal.</p>
      <p class="text-xs text-muted">
        Export includes titles and URLs without query strings or fragments. Review the file before
        sharing it.
      </p>
      <div class="flex flex-col gap-4 border-t border-line pt-3 md:flex-row">
        <nav
          aria-label="Proposed projects"
          class="flex min-w-0 shrink-0 flex-col gap-1 md:sticky md:top-2 md:max-h-[calc(100dvh-4rem)] md:w-56 md:self-start md:overflow-y-auto"
        >
          <span class="px-2 text-xs text-muted">Projects</span>
          <button
            type="button"
            class="flex min-h-9 items-center justify-between gap-2 rounded-md px-2 text-left text-[13px] hover:bg-hover"
            :class="selectedProjectName === '__all__' ? 'bg-raised text-ink' : 'text-muted'"
            @click="selectSection('__all__')"
          >
            <span>All assigned tabs</span
            ><span class="text-xs text-muted">{{ reviewDraft?.assignments.length }}</span>
          </button>
          <button
            v-for="project in reviewDraft?.projects || []"
            :key="project.name"
            type="button"
            class="flex min-h-9 items-center justify-between gap-2 rounded-md px-2 text-left text-[13px] hover:bg-hover"
            :class="selectedProjectName === project.name ? 'bg-raised text-ink' : 'text-muted'"
            :aria-current="selectedProjectName === project.name ? 'true' : undefined"
            @click="selectSection(project.name)"
          >
            <span class="min-w-0 truncate">{{ project.name }}</span>
            <span class="shrink-0 text-xs text-muted">{{
              proposalIndex.byProject.get(project.name)?.length || 0
            }}</span>
          </button>
          <button
            v-if="reviewDraft?.unresolvedRecordIds.length"
            type="button"
            class="flex min-h-9 items-center justify-between gap-2 rounded-md px-2 text-left text-[13px] hover:bg-hover"
            :class="selectedProjectName === '__unresolved__' ? 'bg-raised text-ink' : 'text-muted'"
            @click="selectSection('__unresolved__')"
          >
            <span>Uncertain tabs</span
            ><span class="text-xs text-muted">{{ reviewDraft.unresolvedRecordIds.length }}</span>
          </button>
        </nav>
        <div class="flex min-w-0 flex-1 flex-col gap-3">
          <template v-if="activeProject">
            <div class="flex flex-wrap items-baseline justify-between gap-2">
              <div class="flex min-w-0 flex-col gap-1">
                <h4 class="text-sm font-semibold">{{ activeProject.name }}</h4>
                <p class="text-xs text-muted">
                  {{ activeProject.areaName }} · {{ activeProject.purpose }}
                </p>
              </div>
              <span class="text-xs text-muted"
                >{{ proposalIndex.byProject.get(activeProject.name)?.length || 0 }} tabs ·
                {{ activeProject.categories.length }} categories</span
              >
            </div>
            <div
              v-if="activeProjectChats.length"
              class="flex flex-wrap items-center gap-2 text-xs text-muted"
            >
              <span>Existing project chats</span>
              <UiButton
                v-for="thread in activeProjectChats"
                :key="thread.id"
                size="small"
                variant="ghost"
                @click="openSourceChat(thread.id)"
                >{{ thread.title }}</UiButton
              >
            </div>
            <UiCollapsible class="text-xs text-muted"
              ><template #label>Edit project, categories and merge</template>
              <div class="flex flex-col gap-3 py-2">
                <label class="field-label"
                  >Project name<input
                    class="field"
                    :value="activeProject.name"
                    maxlength="80"
                    @change="
                      renameProject(activeProject, ($event.target as HTMLInputElement).value)
                    "
                /></label>
                <div class="flex flex-wrap gap-3">
                  <label class="field-label min-w-40 flex-1"
                    >Area / life context<input
                      :value="activeProject.areaName"
                      class="field"
                      maxlength="80"
                      placeholder="No area"
                      @input="
                        activeProject.areaName =
                          ($event.target as HTMLInputElement).value.trim() || null;
                        markDirty();
                      "
                  /></label>
                  <label class="field-label min-w-60 flex-[2]"
                    >Purpose<input
                      v-model="activeProject.purpose"
                      class="field"
                      maxlength="500"
                      @input="markDirty"
                  /></label>
                </div>
                <label v-if="reviewDraft && reviewDraft.projects.length > 1" class="field-label"
                  >Merge this project into
                  <UiSelect
                    :model-value="''"
                    :options="
                      projectOptions.filter((option) => option.value !== activeProject?.name)
                    "
                    placeholder="Choose target project"
                    :aria-label="`Merge ${activeProject.name} into another project`"
                    @update:model-value="mergeProject(activeProject!.name, $event)"
                  />
                </label>
                <div
                  v-for="category in activeProject.categories"
                  :key="category.name"
                  class="flex flex-wrap gap-2"
                >
                  <label class="field-label min-w-40 flex-1"
                    >Category name<input
                      class="field"
                      :value="category.name"
                      maxlength="80"
                      @change="
                        renameCategory(
                          activeProject!,
                          category,
                          ($event.target as HTMLInputElement).value,
                        )
                      "
                  /></label>
                  <label class="field-label min-w-60 flex-[2]"
                    >What belongs here?<input
                      v-model="category.description"
                      class="field"
                      maxlength="300"
                      @input="markDirty"
                  /></label>
                </div>
              </div>
            </UiCollapsible>
            <div
              class="flex flex-wrap gap-1 border-b border-line pb-2"
              aria-label="Proposed categories"
            >
              <button
                type="button"
                class="min-h-8 rounded-md px-2 text-xs hover:bg-hover"
                :class="!selectedCategoryName ? 'bg-raised text-ink' : 'text-muted'"
                @click="selectSection(activeProject.name)"
              >
                All · {{ proposalIndex.byProject.get(activeProject.name)?.length || 0 }}
              </button>
              <button
                v-for="category in activeProject.categories"
                :key="category.name"
                type="button"
                class="min-h-8 rounded-md px-2 text-xs hover:bg-hover"
                :class="
                  selectedCategoryName === category.name ? 'bg-raised text-ink' : 'text-muted'
                "
                @click="selectSection(activeProject.name, category.name)"
              >
                {{ category.name }} ·
                {{
                  proposalIndex.byCategory.get(JSON.stringify([activeProject.name, category.name]))
                    ?.length || 0
                }}
              </button>
            </div>
          </template>
          <h4 v-else class="text-sm font-semibold">
            {{ selectedProjectName === '__unresolved__' ? 'Uncertain tabs' : 'All assigned tabs' }}
          </h4>
          <div class="flex flex-wrap gap-2">
            <input
              v-model="searchText"
              class="field min-w-40 flex-1"
              type="search"
              placeholder="Find title or URL"
              aria-label="Search proposal tabs"
              @input="shownCount = PROPOSAL_PAGE_SIZE"
            />
            <UPopover :ui="{ content: 'w-72 bg-surface p-3' }"
              ><UiButton
                size="small"
                variant="ghost"
                aria-label="Filter proposal tags"
                title="Filter proposal tags"
                ><SlidersHorizontal class="size-4" /><span
                  v-if="reviewTags.length || reviewUntagged"
                  class="text-xs"
                  >{{ reviewTags.length || 1 }}</span
                ></UiButton
              ><template #content
                ><UiTagChecklist
                  v-model="reviewTags"
                  v-model:mode="reviewTagMode"
                  v-model:untagged="reviewUntagged"
                  :options="tagOptions"
                  @update:model-value="shownCount = PROPOSAL_PAGE_SIZE" /></template
            ></UPopover>
          </div>
          <p class="text-xs text-muted">
            {{
              selectedProjectName === '__unresolved__'
                ? filteredUnresolved.length
                : filteredAssignments.length
            }}
            matching tabs · existing tags shown below
          </p>
          <div v-if="selectedDraftTabs.size" class="flex flex-wrap items-center gap-2">
            <span class="text-xs">{{ selectedDraftTabs.size }} selected</span
            ><UiButton size="small" @click="excludeDraftTabs([...selectedDraftTabs])"
              >Remove selected from draft</UiButton
            ><UiButton size="small" variant="ghost" @click="selectedDraftTabs = new Set()"
              >Clear selection</UiButton
            >
          </div>
          <UiDisclosure
            v-if="reviewDraft?.excludedRecordIds?.length"
            v-model:open="excludedOpen"
            :label="`Removed from draft - ${reviewDraft.excludedRecordIds.length}`"
          >
            <div
              v-for="id in reviewDraft.excludedRecordIds"
              :key="id"
              class="flex min-w-0 items-center gap-2 py-1"
            >
              <span class="min-w-0 flex-1 truncate text-xs">{{
                recordById.get(id)?.title || id
              }}</span
              ><UiButton size="small" variant="ghost" @click="excludeDraftTabs([id], false)"
                >Restore to draft</UiButton
              >
            </div>
          </UiDisclosure>
          <p class="text-xs text-muted">
            Saving tags updates the original tab's metadata immediately; draft assignments still
            wait for Apply.
          </p>
          <div
            v-if="selectedProjectName === '__unresolved__'"
            class="flex flex-col divide-y divide-line"
          >
            <div
              v-for="recordId in visibleUnresolved"
              :key="recordId"
              class="flex min-w-0 flex-col gap-2 py-2 text-xs"
            >
              <div class="flex min-w-0 flex-wrap items-center gap-2">
                <span
                  class="min-w-0 flex-1 truncate font-medium"
                  :title="recordById.get(recordId)?.url"
                  >{{ recordById.get(recordId)?.title || 'Tab changed' }}</span
                >
                <span class="text-muted">{{
                  recordById.get(recordId)?.tags.join(', ') || 'Untagged'
                }}</span>
                <UiCheckbox
                  :model-value="selectedDraftTabs.has(recordId)"
                  :label="`Select draft tab ${recordById.get(recordId)?.title || recordId}`"
                  @update:model-value="toggleDraftSelection(recordId)"
                />
                <UiButton size="small" variant="ghost" @click="excludeDraftTabs([recordId])"
                  >Remove from draft</UiButton
                >
                <UiButton size="small" variant="ghost" @click="editRecord(recordId)">Tags</UiButton>
              </div>
              <TagSuggestionReview
                :items="
                  reviewDraft?.tagReview?.find((item) => item.recordId === recordId)?.tags || []
                "
                :selected="
                  reviewDraft?.unresolvedTagSuggestions?.find((item) => item.recordId === recordId)
                    ?.suggestedTags || []
                "
                @remove="reviewTag(recordId, $event, false)"
                @include="reviewTag(recordId, $event, true)"
                @dismiss="reviewTag(recordId, $event, false)"
              />
              <label
                v-if="
                  reviewDraft?.unresolvedTagSuggestions?.some((item) => item.recordId === recordId)
                "
                class="field-label"
                >Suggested tags · applied only after review<UiTagPicker
                  :model-value="
                    reviewDraft?.unresolvedTagSuggestions?.find(
                      (item) => item.recordId === recordId,
                    )?.suggestedTags || []
                  "
                  :options="knownTags"
                  @update:model-value="
                    (value) => {
                      const item = reviewDraft?.unresolvedTagSuggestions?.find(
                        (entry) => entry.recordId === recordId,
                      );
                      if (item) {
                        item.suggestedTags = value;
                        markDirty();
                      }
                    }
                  "
              /></label>
              <div
                v-if="editingRecordId === recordId"
                class="flex flex-wrap items-end gap-2 bg-canvas p-2"
              >
                <label class="field-label min-w-40 flex-1"
                  >Original tab tags
                  <UiTagPicker
                    v-model="tagInput"
                    :options="knownTags"
                    aria-label="Original tab tags"
                  />
                </label>
                <UiButton size="small" @click="saveTags(recordId)">Save tags</UiButton>
              </div>
              <div class="flex flex-wrap items-center gap-2">
                <UiSelect
                  :model-value="unresolvedChoices[recordId] || ''"
                  :options="flattenedChoices"
                  class="min-w-48 flex-1"
                  placeholder="Choose a project / group"
                  :aria-label="`Assign ${recordById.get(recordId)?.title || 'tab'}`"
                  @update:model-value="unresolvedChoices[recordId] = $event"
                />
                <UiButton
                  size="small"
                  variant="ghost"
                  :disabled="!unresolvedChoices[recordId]"
                  @click="assignUnresolved(recordId)"
                  >Assign</UiButton
                >
              </div>
            </div>
          </div>
          <div v-else class="flex flex-col divide-y divide-line">
            <div
              v-for="assignment in visibleAssignments"
              :key="assignment.recordId"
              class="flex min-w-0 flex-col gap-2 py-3 text-xs"
            >
              <div class="flex min-w-0 items-center gap-2">
                <UiCheckbox
                  :model-value="selectedDraftTabs.has(assignment.recordId)"
                  :label="`Select draft tab ${recordById.get(assignment.recordId)?.title || assignment.recordId}`"
                  @update:model-value="toggleDraftSelection(assignment.recordId)"
                />
                <UiButton
                  size="small"
                  variant="ghost"
                  @click="excludeDraftTabs([assignment.recordId])"
                  >Remove from draft</UiButton
                >
                <button
                  type="button"
                  class="min-w-0 flex-1 truncate text-left font-medium hover:underline"
                  :title="recordById.get(assignment.recordId)?.url"
                  @click="editRecord(assignment.recordId)"
                >
                  {{ recordById.get(assignment.recordId)?.title || 'Tab changed' }}
                </button>
                <span class="shrink-0 text-muted">{{
                  recordById.get(assignment.recordId)?.tags.join(', ') || 'Untagged'
                }}</span>
                <UiButton size="small" variant="ghost" @click="editRecord(assignment.recordId)">{{
                  editingRecordId === assignment.recordId ? 'Done' : 'Edit'
                }}</UiButton>
              </div>
              <p class="truncate text-muted" :title="recordById.get(assignment.recordId)?.url">
                {{ recordById.get(assignment.recordId)?.url }}
              </p>
              <TagSuggestionReview
                :items="
                  reviewDraft?.tagReview?.find((item) => item.recordId === assignment.recordId)
                    ?.tags || []
                "
                :selected="assignment.suggestedTags || []"
                @remove="reviewTag(assignment.recordId, $event, false)"
                @include="reviewTag(assignment.recordId, $event, true)"
                @dismiss="reviewTag(assignment.recordId, $event, false)"
              />
              <p v-if="assignment.suggestedTags?.length" class="text-muted">
                Suggested tags · {{ assignment.suggestedTags.join(' · ') }}
                <span class="text-secondary">· on Apply</span>
              </p>

              <div
                v-if="editingRecordId === assignment.recordId"
                class="flex flex-col gap-2 bg-canvas p-2"
              >
                <label class="field-label"
                  >Suggested tags · added only on Apply
                  <UiTagPicker
                    :model-value="assignment.suggestedTags || []"
                    :options="knownTags"
                    :aria-label="`Suggested tags for ${recordById.get(assignment.recordId)?.title || 'tab'}`"
                    @update:model-value="editSuggestedTags(assignment, $event)"
                  />
                </label>
                <div class="flex flex-wrap gap-2">
                  <UiSelect
                    :model-value="assignment.projectName"
                    :options="projectOptions"
                    class="min-w-40 flex-1"
                    aria-label="Assigned project"
                    creatable
                    @create="createDraftOption(assignment, $event, true)"
                    @update:model-value="setProject(assignment, $event)"
                  />
                  <UiSelect
                    :model-value="assignment.categoryName"
                    :options="categoryOptions(assignment.projectName)"
                    class="min-w-40 flex-1"
                    aria-label="Assigned category"
                    creatable
                    @create="createDraftOption(assignment, $event, false)"
                    @update:model-value="setCategory(assignment, $event)"
                  />
                </div>
                <p class="text-muted">
                  {{ assignment.reason }} · {{ Math.round(assignment.confidence * 100) }}% ·
                  {{
                    reviewDraft?.ownerAssignedRecordIds?.includes(assignment.recordId)
                      ? 'Your correction'
                      : 'AI suggested'
                  }}
                </p>
                <div class="flex flex-wrap items-end gap-2">
                  <label class="field-label min-w-40 flex-1"
                    >Original tab tags
                    <UiTagPicker
                      v-model="tagInput"
                      :options="knownTags"
                      aria-label="Original tab tags"
                    />
                  </label>
                  <UiButton size="small" @click="saveTags(assignment.recordId)">Save tags</UiButton>
                </div>
                <UiButton
                  size="small"
                  variant="ghost"
                  class="self-start"
                  @click="leaveUnassigned(assignment.recordId)"
                  >Move to uncertain</UiButton
                >
              </div>
            </div>
          </div>
          <UiButton
            v-if="remainingCount"
            size="small"
            variant="ghost"
            class="self-start"
            @click="shownCount += PROPOSAL_PAGE_SIZE"
            >Show next {{ Math.min(PROPOSAL_PAGE_SIZE, remainingCount) }} of
            {{ remainingCount }}</UiButton
          >
          <p
            v-if="
              !remainingCount &&
              !(selectedProjectName === '__unresolved__'
                ? filteredUnresolved.length
                : filteredAssignments.length)
            "
            class="py-4 text-xs text-muted"
          >
            No tabs match this view.
          </p>
        </div>
      </div>
      <div class="flex justify-end gap-2 border-t border-line pt-2">
        <span v-if="confirmDismiss" class="min-w-0 flex-1 self-center text-xs text-muted"
          >This hides the saved proposal without changing tabs. Export it first if you want a
          shareable copy.</span
        >
        <UiButton size="small" variant="ghost" @click="dismiss">{{
          confirmDismiss ? 'Confirm dismiss' : 'Dismiss draft'
        }}</UiButton
        ><UiButton
          v-if="confirmDismiss"
          size="small"
          variant="ghost"
          @click="confirmDismiss = false"
          >Keep draft</UiButton
        ><UiButton
          v-if="!pending?.sourceJobIds?.length"
          size="small"
          :title="`Create ${projectedWindowCount} new windows with sleeping copies. Original tabs stay in place.`"
          @click="apply('copy')"
          >Create {{ projectedWindowCount }} project windows</UiButton
        ><UiButton size="small" variant="primary" @click="apply('semantic')"
          >Use organization in TabFlow</UiButton
        >
      </div>
    </article>
    <div v-else-if="applied" class="flex flex-wrap items-center gap-3 pt-2">
      <div v-if="applied.copyState" class="flex min-w-0 flex-1 flex-col gap-2 text-xs text-muted">
        <p>
          {{ applied.copyState.entries.filter((entry) => entry.created).length }} /
          {{ applied.copyState.entries.length }} copies · {{ applied.copyState.windows.length }} new
          project windows · {{ copyOperation?.status }}. Originals retained. Copies start sleeping;
          native groups represent categories.
        </p>
        <p
          v-for="entry in applied.copyState.entries.filter((item) => item.error)"
          :key="entry.recordId"
          role="status"
        >
          {{ records.find((record) => record.id === entry.sourceRecordId)?.title }}:
          {{ entry.error }}
        </p>
        <p>
          Undo removes only untouched sleeping copies. Changed, moved, inspected or protected copies
          and later tabs are retained.
        </p>
      </div>
      <p v-else-if="groupActions.length" class="min-w-0 flex-1 text-xs leading-5 text-muted">
        Your project/category structure is saved in TabFlow. {{ groupActions.length }} optional
        native group actions are available in the current windows. Creating them changes browser
        groups and is snapshotted; pinned, locked, uncertain and stale tabs are skipped.
      </p>
      <p v-else class="min-w-0 flex-1 text-xs leading-5 text-muted">
        Your project/category structure is saved in TabFlow. Browser tabs remain in their current
        windows. Undo restores these assignments while retaining newer manual corrections.
      </p>
      <UiButton
        v-if="
          groupActions.length ||
          (applied.copyState &&
            !applied.copyState.undoStarted &&
            copyOperation?.status !== 'complete')
        "
        size="small"
        @click="createNativeGroups"
        >{{
          applied.copyState ? 'Retry remaining creation' : 'Create native category groups'
        }}</UiButton
      >
      <UiButton
        v-if="applied?.appliedMemberships || applied.copyState"
        size="small"
        variant="ghost"
        @click="undoOrganization"
        >Undo organization</UiButton
      >
    </div>
  </section>
</template>
