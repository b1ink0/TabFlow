<script setup lang="ts">
import { skipFailedCollectionBatch } from '../../shared/collection-analysis';
import BrowserWorkProgress from '../workspace/BrowserWorkProgress.vue';
import AssistantImages from './AssistantImages.vue';
import {
  supportsImageInput,
  assistantImagesSchema,
  type AssistantImage,
} from '../../shared/assistant-images';
import AssistantAttachments from './AssistantAttachments.vue';
import AssistantApprovalControls from './AssistantApprovalControls.vue';
import AssistantPermissionReviews from './AssistantPermissionReviews.vue';
import AssistantChangeHistory from './AssistantChangeHistory.vue';
import {
  capabilityLabels,
  assistantArtifactSchema,
  type AssistantArtifact,
  type ApprovalMode,
} from '../../shared/assistant-actions';
import { resolveAttachments, type AssistantAttachment } from '../../shared/assistant-context';
import { workspaceEditLabel } from '../../shared/workspace-edits';
import AssistantRunTiming from './AssistantRunTiming.vue';
import UiCollapsible from '../../ui/UiCollapsible.vue';
import { ref, computed, onMounted, watch, nextTick } from 'vue';
import {
  useMediaQuery,
  useIntervalFn,
  useStorage,
  useEventListener,
  useResizeObserver,
  useElementSize,
} from '@vueuse/core';
import UChatPrompt from '@nuxt/ui/components/ChatPrompt.vue';
import UChatPromptSubmit from '@nuxt/ui/components/ChatPromptSubmit.vue';
import UChatMessage from '@nuxt/ui/components/ChatMessage.vue';
import UChatShimmer from '@nuxt/ui/components/ChatShimmer.vue';
import UChatReasoning from '@nuxt/ui/components/ChatReasoning.vue';
import AssistantToolActivity from './AssistantToolActivity.vue';
import UPopover from '@nuxt/ui/components/Popover.vue';
import USlideover from '@nuxt/ui/components/Slideover.vue';
import UDropdownMenu from '@nuxt/ui/components/DropdownMenu.vue';
import UiScrollArea from '../../ui/UiScrollArea.vue';
import {
  PhArrowUpRight as ArrowUpRight,
  PhArrowDown as ArrowDown,
  PhCaretLeft as ChevronLeft,
  PhCaretRight as ChevronRight,
  PhSlidersHorizontal as SlidersHorizontal,
  PhCheck as Check,
  PhX as X,
  PhChatCircle as MessageSquare,
  PhArrowLineRight as PanelRightClose,
  PhSpinnerGap as LoaderCircle,
  PhLockKey as LockKeyhole,
  PhPlus as Plus,
  PhList as Menu,
  PhSidebarSimple as PanelLeftClose,
  PhSidebar as PanelLeftOpen,
  PhArrowSquareOut as ExternalLink,
  PhArrowsClockwise as RefreshCw,
  PhDotsThree as Ellipsis,
} from '@phosphor-icons/vue';
import UiButton from '../../ui/UiButton.vue';
import InferenceHistory from '../assistant/InferenceHistory.vue';
import UiThemeToggle from '../../ui/UiThemeToggle.vue';
import { useTheme } from '../../ui/theme';
import UiCheckbox from '../../ui/UiCheckbox.vue';
import UiSelect from '../../ui/UiSelect.vue';
import ConversationList from './ConversationList.vue';
import ChatModelSettings from './ChatModelSettings.vue';
import UiToggle from '../../ui/UiToggle.vue';
import RunHistory from './RunHistory.vue';
import ExternalClassificationDialog from '../projects/ExternalClassificationDialog.vue';
import { useWorkspace } from '../../stores/workspace';
import { useAssistantConversations } from '../../stores/assistant';
import { cn } from '../../shared/cn';
import {
  type AssistantCommand,
  type AssistantProjectDraft,
  type AssistantMessage,
  type AssistantRequest,
} from '../../shared/assistant';
import { useDialog } from '../../stores/dialog';
import { conversationBranch, answerBranches } from '../../shared/assistant-branches';
import { canRetry, retryTurn, incompleteToolTurn } from '../../shared/assistant-retry';
import { rpc } from '../../shared/rpc';
import { tagHash } from '../../shared/tag-analysis';
import type { PermissionPolicy } from '../../shared/permission-review';
import { errorMessage } from '../../shared/types';
import { requestModelAccess } from '../../ai/access';
import { runModelInference } from '../../ai/inference-lane';
import MarkdownRender, { type NodeRendererProps } from 'markstream-vue';
import 'markstream-vue/index.css';
import type { WorkItemDraft } from '../../ai/client';
import type { ActionAnalysis } from '../../shared/types';
const store = useWorkspace();
const attachmentTrigger = ref<HTMLElement>();
const imageAttachments = ref<{ pick: () => void }>();
const panelRoot = ref<HTMLElement>();
const { width: panelWidth } = useElementSize(panelRoot);
const compactHeader = computed(() => panelWidth.value < 500);
const { preference: appearance, toggle: toggleAppearance } = useTheme();
const chat = useAssistantConversations();
const permissionMode = ref<PermissionPolicy['mode']>('ask');
const permissionPolicyRevision = ref(0);
const reviewingPermission = ref(false);
const applyingAutomatically = ref(false);
const permissionModes = [
  { label: 'Ask me', value: 'ask' },
  { label: 'Approve for me', value: 'review' },
  { label: 'Approve all', value: 'all' },
] as const;
const permissionLabel = computed(
  () => permissionModes.find((item) => item.value === permissionMode.value)?.label,
);
async function changePermissionMode(value: string) {
  if (value !== 'ask' && value !== 'review' && value !== 'all') return;
  await store.run(async () => {
    if (!chat.current) await chat.create(store.projectFilter);
    const threadId = chat.activeId;
    const policy = await rpc('setPermissionPolicy', { threadId, mode: value });
    if (chat.activeId === threadId && policy.revision >= permissionPolicyRevision.value) {
      permissionPolicyRevision.value = policy.revision;
      permissionMode.value = policy.mode;
    }
  });
}
watch(
  () => chat.activeId,
  async (id) => {
    permissionMode.value = 'ask';
    permissionPolicyRevision.value = 0;
    if (!id) return;
    await store.run(async () => {
      const policy = await rpc('permissionPolicy', { threadId: id });
      if (chat.activeId === id && policy.revision >= permissionPolicyRevision.value) {
        permissionPolicyRevision.value = policy.revision;
        permissionMode.value = policy.mode;
      }
    });
  },
);
const props = defineProps<{
  expanded?: boolean;
  sidebarCollapsed?: boolean;
  sidePanel?: boolean;
  visible?: boolean;
}>();
const emit = defineEmits<{ close: []; navigation: []; toggleSidebar: []; openFullPage: [] }>();
const transcript = ref<HTMLElement>();
const { height: transcriptHeight } = useElementSize(transcript);
const transcriptContent = ref<HTMLElement>();
const followLatest = ref(true);
let lastScrollTop = 0;
const toolsOpen = ref(false);
const attachments = ref<AssistantAttachment[]>([]);
const images = ref<AssistantImage[]>([]);
const classificationMode = ref('configured');
const providerReasoning = ref('');
const reasoningMessageId = ref('');
const reasoningStreaming = ref(false);
function scrollLatest() {
  followLatest.value = true;
  void nextTick(() => {
    const viewport = transcript.value;
    if (viewport) {
      viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'auto' });
      lastScrollTop = viewport.scrollTop;
    }
  });
}
useEventListener(
  transcript,
  'scroll',
  () => {
    const viewport = transcript.value;
    if (viewport) {
      const remaining = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      if (remaining < 1) followLatest.value = true;
      else if (viewport.scrollTop < lastScrollTop - 1) followLatest.value = false;
      else if (remaining < 8) followLatest.value = true;
      lastScrollTop = viewport.scrollTop;
    }
  },
  { passive: true },
);
useEventListener(
  transcript,
  'wheel',
  (event) => {
    if (event.deltaY < 0) followLatest.value = false;
  },
  { passive: true },
);
useResizeObserver(transcriptContent, () => {
  if (followLatest.value && props.visible !== false) scrollLatest();
});
const prompt = ref(''),
  historyOpen = ref(false),
  scope = ref('visible'),
  busy = ref(false),
  progress = ref(''),
  checked = ref(new Set<number>());
const largeHistory = useMediaQuery('(min-width: 1280px)');
const dockedHistory = computed(() =>
  Boolean(props.expanded && !props.sidePanel && largeHistory.value),
);
const historyDrawer = computed({
  get: () => props.visible !== false && historyOpen.value && !dockedHistory.value,
  set: (value: boolean) => {
    historyOpen.value = value;
  },
});
function restoreHistoryFocus(event: Event) {
  event.preventDefault();
  document.querySelector<HTMLElement>('[data-chat-history-trigger]')?.focus();
}
watch(
  () => props.expanded,
  (expanded, previous) => {
    if (expanded && !previous && dockedHistory.value) historyOpen.value = true;
  },
);
watch(
  () => props.visible,
  (visible) => {
    if (visible === false) {
      historyOpen.value = false;
      toolsOpen.value = false;
    }
  },
);
const task = ref('work'),
  allowMoves = ref(false),
  allowSleepWake = ref(false);
const taskOptions = computed(() => [
  { label: 'Native tab action proposal', value: 'organize' },
  { label: 'Ask / find (no changes)', value: 'ask' },
  { label: 'Workspace conversation', value: 'work' },
  ...(store.app?.settings.smallModel || store.app?.settings.useDedicatedDecisionModel
    ? [{ label: 'Classify into existing groups', value: 'classify' }]
    : []),
]);
const scopeOptions = computed(() => [
  { label: 'Current filtered tabs', value: 'visible' },
  { label: `Selected tabs (${store.selected.size})`, value: 'selected' },
  { label: 'All windows and projects', value: 'all' },
]);
watch(task, () => {
  store.pendingPlan = null;
});
watch(
  () => Boolean(store.app?.settings.smallModel || store.app?.settings.useDedicatedDecisionModel),
  (enabled) => {
    if (!enabled && task.value === 'classify') task.value = 'organize';
  },
);
const conversation = computed(() => conversationBranch(chat.current));
const safeMarkdown: NonNullable<NodeRendererProps['customMarkdownIt']> = (markdown) => {
  markdown.disable('image');
  return markdown;
};
const remoteRunning = computed(() => chat.current?.status === 'running' && !busy.value);
const collectionAnalysisKey = useStorage(
  'tabflow.collection.analysisId',
  'projects:whole-collection',
);
useIntervalFn(async () => {
  if (remoteRunning.value && chat.activeId) {
    try {
      await chat.refreshRunningThread(chat.activeId);
    } catch (error) {
      progress.value = `Could not refresh the running chat: ${errorMessage(error)}`;
    }
  }
}, 1500);
const workProposal = ref<WorkItemDraft | null>(null);
const projectProposal = ref<AssistantProjectDraft | null>(null);
const commandProposal = ref<AssistantCommand | null>(null);
const collectionProposalId = ref('');
const artifactMessageId = ref('');
const savedActionPlans = ref<ActionAnalysis[]>([]);
async function refreshActionPlans() {
  savedActionPlans.value = (await rpc('listActionAnalyses', undefined)) || [];
}
const contextProject = computed(() =>
  store.app?.projects.find((project) => project.id === chat.current?.projectId),
);
const commandContextLabel = computed(() => {
  const command = commandProposal.value;
  if (command?.kind !== 'assign') return '';
  return `${store.app?.projects.find((project) => project.id === command.projectId)?.name || 'Project'} · ${store.app?.categories.find((category) => category.id === command.categoryId)?.name || 'Uncategorized'}`;
});
let selectingThread = false;
async function selectThread(id: string) {
  if (busy.value) return;
  selectingThread = true;
  try {
    await chat.save();
    await chat.select(id);
    attachments.value = [];
    images.value = [];
    await refreshActionPlans();
    workProposal.value = null;
    projectProposal.value = null;
    commandProposal.value = null;
    store.pendingPlan = null;
    collectionProposalId.value = '';
    const last = [...conversation.value]
      .reverse()
      .find(
        (message) =>
          (message.taskDraft && !message.completedArtifacts.includes('task')) ||
          (message.projectDraft && !message.completedArtifacts.includes('project')) ||
          (message.plan && !message.completedArtifacts.includes('plan')) ||
          message.collectionProposalId ||
          (message.commandDraft && !message.completedArtifacts.includes('command')),
      );
    if (last) {
      artifactMessageId.value = last.id;
      workProposal.value = last.completedArtifacts.includes('task') ? null : last.taskDraft || null;
      projectProposal.value = last.completedArtifacts.includes('project')
        ? null
        : last.projectDraft || null;
      commandProposal.value = last.completedArtifacts.includes('command')
        ? null
        : last.commandDraft || null;
      store.pendingPlan = last.completedArtifacts.includes('plan') ? null : last.plan || null;
      collectionProposalId.value = last.collectionProposalId || '';
      checked.value = new Set(last.plan?.actions.map((_, index) => index) || []);
    }
    if (!dockedHistory.value) historyOpen.value = false;
  } finally {
    selectingThread = false;
  }
}
watch(
  () => chat.activeId,
  (id, previous) => {
    if (id && previous && id !== previous && !selectingThread) void selectThread(id);
  },
);
function reviewArtifacts(message: AssistantMessage) {
  if (busy.value) return;
  artifactMessageId.value = message.id;
  workProposal.value = message.completedArtifacts.includes('task')
    ? null
    : message.taskDraft || null;
  projectProposal.value = message.completedArtifacts.includes('project')
    ? null
    : message.projectDraft || null;
  commandProposal.value = message.completedArtifacts.includes('command')
    ? null
    : message.commandDraft || null;
  store.pendingPlan = message.completedArtifacts.includes('plan') ? null : message.plan || null;
  collectionProposalId.value = message.collectionProposalId || '';
  checked.value = new Set(store.pendingPlan?.actions.map((_, index) => index) || []);
}
async function newThread(projectId: string | null = store.projectFilter) {
  if (busy.value) return;
  await chat.save();
  await chat.create(projectId);
  await selectThread(chat.activeId);
  prompt.value = '';
}
async function moveThread(id: string, projectId: string | null) {
  if (busy.value) return;
  await store.run(async () => {
    await chat.save();
    await chat.moveToProject(id, projectId);
    store.notify('Chat moved. Future messages use its new project context.');
  });
}
async function renameThread(id: string) {
  const thread = chat.threads.find((item) => item.id === id);
  const value = await useDialog().ask('Rename chat', [
    { name: 'title', label: 'Name', value: thread?.title || '' },
  ]);
  if (value) await store.run(() => chat.manageThread(id, value.title));
}
async function deleteThread(id: string) {
  if (
    !(await useDialog().ask(
      'Delete chat?',
      [],
      'Messages, tool activity and approval reviews are removed. Saved proposals, analysis checkpoints and change history remain available separately. This cannot be undone.',
      'Delete chat',
    ))
  )
    return;
  await store.run(async () => {
    await chat.manageThread(id);
    await selectThread(chat.activeId);
  });
}
async function recordOutcome(
  outcome: string,
  artifact: 'task' | 'project' | 'plan' | 'command' | 'collection',
) {
  const message = conversation.value.find((entry) => entry.id === artifactMessageId.value);
  if (message) {
    for (const entry of conversation.value) {
      if (
        entry.id !== message.id &&
        (!message.requestMessageId || entry.requestMessageId !== message.requestMessageId)
      )
        continue;
      entry.outcome = entry.outcome ? `${entry.outcome}\n${outcome}` : outcome;
      if (!entry.completedArtifacts.includes(artifact)) entry.completedArtifacts.push(artifact);
    }
  }
  await chat.save();
}
function ensureArtifactPending(artifact: 'task' | 'project' | 'plan' | 'command' | 'collection') {
  const message = conversation.value.find((entry) => entry.id === artifactMessageId.value);
  if (
    !message ||
    message.completedArtifacts.includes(artifact) ||
    conversation.value.some(
      (entry) =>
        entry.id !== message.id &&
        entry.requestMessageId &&
        entry.requestMessageId === message.requestMessageId &&
        entry.completedArtifacts.includes(artifact),
    )
  )
    throw new Error(
      'This draft was already completed or changed in another TabFlow view. Reload its saved results.',
    );
}
const dismissArtifact = (artifact: 'task' | 'project' | 'plan' | 'command' | 'collection') =>
  store.run(() =>
    chat.exclusive(async () => {
      ensureArtifactPending(artifact);
      const denied =
        pendingArtifact(artifact) ||
        (artifact === 'plan' && store.pendingPlan
          ? { kind: 'plan' as const, plan: store.pendingPlan }
          : undefined);
      if (denied) {
        const trace = await rpc('denyAssistantAction', {
          threadId: chat.activeId,
          messageId: artifactMessageId.value,
          mode: 'once',
          artifact: denied,
        });
        const message = conversation.value.find((item) => item.id === artifactMessageId.value);
        if (message) message.assistantChangeIds = [...(message.assistantChangeIds || []), trace.id];
      }
      await recordOutcome(
        artifact === 'collection'
          ? 'Organization not applied. Saved draft kept in Projects.'
          : `${artifact} draft dismissed.`,
        artifact,
      );
      if (artifact === 'task') workProposal.value = null;
      else if (artifact === 'project') projectProposal.value = null;
      else if (artifact === 'command') commandProposal.value = null;
      else if (artifact === 'collection') {
        collectionProposalId.value = '';
      } else store.pendingPlan = null;
      await store.refresh();
    }),
  );
watch(
  () => chat.activeId,
  () => {
    providerReasoning.value = '';
    scrollLatest();
  },
);
watch(
  () => conversation.value.length,
  () => {
    if (followLatest.value) scrollLatest();
  },
);
let controller: AbortController | undefined;
const readyForAnalysisLaunch = ref(false);
watch([readyForAnalysisLaunch, () => chat.analysisLaunch, () => props.visible, busy], async () => {
  const launch = chat.analysisLaunch;
  if (
    !readyForAnalysisLaunch.value ||
    !launch ||
    props.visible === false ||
    busy.value ||
    remoteRunning.value
  )
    return;
  try {
    await selectThread(launch.threadId);
    if (chat.analysisLaunch?.messageId !== launch.messageId) return;
    chat.analysisLaunch = undefined;
    submit(launch.messageId);
  } catch (error) {
    chat.analysisLaunch = undefined;
    store.notify(errorMessage(error));
  }
});
watch(
  () => chat.cancelAnalysisId,
  (id) => {
    if (
      id &&
      chat.current?.messages.some(
        (message) => message.id === artifactMessageId.value && message.collectionAnalysisId === id,
      )
    ) {
      controller?.abort();
      chat.cancelAnalysisId = '';
    }
  },
);
const model = computed(() =>
  task.value === 'classify'
    ? store.app?.settings.useDedicatedDecisionModel
      ? `Dedicated decision · ${store.app.settings.decisionModel || 'not selected'}`
      : `Small chat · ${store.app?.settings.smallModel || 'not selected'}`
    : `Generative · ${store.app?.settings.aiModel || 'discover a model in Settings'}`,
);
function submit(messageId?: string, resumeAction?: ActionAnalysis, regenerate = false) {
  if (busy.value || remoteRunning.value || !store.app) return;
  providerReasoning.value = '';
  reasoningStreaming.value = false;
  scrollLatest();
  toolsOpen.value = false;
  autoApprovalMessageId = '';
  busy.value = true;
  void store.run(async () => {
    try {
      if (!chat.current) await chat.create(store.projectFilter);
      await chat.exclusive(() => performAsk(messageId, resumeAction, regenerate));
    } finally {
      busy.value = false;
    }
    await reviewPreparedActions();
  });
}
const ask = () => submit();
const dialog = useDialog();
const retry = (messageId: string) => submit(messageId);
async function skipFailedTags(message: AssistantMessage) {
  if (busy.value || remoteRunning.value || !message.collectionAnalysisId) return;
  const analysis = await rpc('getCollectionAnalysis', { id: message.collectionAnalysisId });
  if (!analysis) throw new Error('Saved analysis is unavailable.');
  await rpc('saveCollectionAnalysis', skipFailedCollectionBatch(analysis));
  retry(message.id);
}

async function regenerateAnswer(message: AssistantMessage) {
  if (
    busy.value ||
    remoteRunning.value ||
    !(await dialog.ask(
      'Retry this answer?',
      [],
      'Create a new answer from this request using current model settings. Earlier answers, their drafts and applied action history remain on their branches. New drafts require approval.',
      'Retry answer',
    ))
  )
    return;
  submit(message.id, undefined, true);
}
function chooseAdjacentAnswer(message: AssistantMessage, direction: -1 | 1) {
  const branches = answerBranches(chat.current, message);
  const target = branches[branches.findIndex((branch) => branch.id === message.id) + direction];
  if (target) void chooseAnswer(target.id);
}
async function chooseAnswer(id: string) {
  if (busy.value || remoteRunning.value) return;
  await chat.exclusive(() => chat.selectBranch(id));
  await selectThread(chat.activeId);
}

async function repairSavedAnalysis(
  message: AssistantMessage,
  stage: 'discovery' | 'classification' | 'tagging',
) {
  if (busy.value || remoteRunning.value || !message.collectionAnalysisId) return;
  await chat.exclusive(async () => {
    const branch = await rpc('repairCollectionAnalysis', {
      id: message.collectionAnalysisId!,
      stage,
    });
    if (collectionAnalysisKey.value === message.collectionAnalysisId)
      collectionAnalysisKey.value = branch.id;
    await chat.append(
      'assistant',
      stage === 'discovery'
        ? 'Project structure will be discovered again from the saved tab scope. Projects, categories and tags will be re-evaluated in a separate draft; the original analysis is retained.'
        : stage === 'tagging'
          ? 'Tag repair prepared. Existing category choices are retained without re-verification; review them before Apply.'
          : 'Classification repair prepared. Discovery is retained; categories and tags will be re-evaluated.',
      {
        request: message.request,
        requestMessageId: message.requestMessageId,
        retryOfMessageId: message.id,
        collectionAnalysisId: branch.id,
        collectionProposalId:
          branch.purpose === 'reclassify' ? message.collectionProposalId : undefined,
        deliveryStatus: 'interrupted',
        completedArtifacts: message.completedArtifacts,
        taskDraft: message.taskDraft,
        projectDraft: message.projectDraft,
        commandDraft: message.commandDraft,
        createdProjectId: message.createdProjectId,
      },
    );
  });
}
const resumeActionPlan = (analysis: ActionAnalysis) => submit(undefined, analysis);
async function repairSavedAction(message: AssistantMessage) {
  if (busy.value || remoteRunning.value || !message.actionAnalysisId) return;
  const branch = await rpc('repairActionAnalysis', { id: message.actionAnalysisId });
  await resumeActionPlan(branch);
}
async function performAsk(
  retryMessageId?: string,
  resumeAction?: ActionAnalysis,
  regenerate = false,
) {
  if (!store.app) return;
  const retryState =
    retryMessageId && chat.current
      ? retryTurn(chat.current, retryMessageId, regenerate)
      : undefined;
  const retrySource = retryState?.failed;
  if (retryState && regenerate)
    retryState.failed = {
      ...retryState.failed,
      taskDraft: undefined,
      projectDraft: undefined,
      commandDraft: undefined,
      plan: undefined,
      collectionProposalId: undefined,
      collectionAnalysisId: undefined,
      actionAnalysisId: undefined,
      completedArtifacts: [],
      createdProjectId: undefined,
    };
  const recoveredAction =
    resumeAction ||
    (retryState?.failed.actionAnalysisId
      ? await rpc('rebaseActionAnalysis', { id: retryState.failed.actionAnalysisId })
      : undefined);
  const activeAction = resumeAction
    ? await rpc('rebaseActionAnalysis', { id: resumeAction.id })
    : recoveredAction;
  const selectedCollectionProposalId = collectionProposalId.value;
  store.pendingPlan = null;
  workProposal.value = null;
  projectProposal.value = null;
  commandProposal.value = null;
  collectionProposalId.value = '';
  controller = new AbortController();
  const request: AssistantRequest =
    activeAction && (resumeAction || retryState?.request.task !== 'work')
      ? {
          task:
            activeAction.mode === 'decision'
              ? 'classify'
              : activeAction.readOnly
                ? 'ask'
                : 'organize',
          recordIds: activeAction.scope.map((item) => item.id),
          projectId: null,
          selectedRecordIds: [],
          allowCrossWindowMove: activeAction.allowCrossWindowMove,
          allowSleepWake: activeAction.allowSleepWake,
        }
      : retryState
        ? {
            ...retryState.request,
            allowCrossWindowMove: allowMoves.value,
            allowSleepWake: allowSleepWake.value,
          }
        : {
            images: assistantImagesSchema.parse(images.value),
            attachments: structuredClone(attachments.value.map((item) => ({ ...item }))),
            restrictToScope: attachments.value.length > 0 || scope.value === 'selected',
            classificationMode: classificationMode.value === 'chat' ? 'chat' : 'configured',
            task: task.value as AssistantRequest['task'],
            recordIds:
              attachments.value.length && store.app
                ? resolveAttachments(store.app, attachments.value)
                : (scope.value === 'all'
                    ? store.records
                    : scope.value === 'selected'
                      ? store.records.filter((record) => store.selected.has(record.id))
                      : store.visible
                  )
                    .filter((record) => record.live)
                    .map((record) => record.id),
            projectId: chat.current?.projectId || null,
            selectedRecordIds:
              attachments.value.length && store.app
                ? resolveAttachments(store.app, attachments.value)
                : [...store.selected],
            allowCrossWindowMove: allowMoves.value,
            allowSleepWake: allowSleepWake.value,
          };
  if (
    request.images?.length &&
    (request.task !== 'work' || !supportsImageInput(store.app.settings))
  )
    throw new Error(
      'Images require workspace conversation and image input enabled for the selected model.',
    );
  const instruction =
    activeAction?.instruction ||
    retryState?.user.content ||
    prompt.value.trim() ||
    (request.images?.length ? 'Describe the attached images and help with my request.' : '') ||
    (request.task === 'work'
      ? 'What should I focus on today? Use my saved work and project context, and tell me what information is missing.'
      : request.task === 'ask'
        ? 'Find the tabs most relevant to my current projects. Answer without changing tabs.'
        : 'Group these tabs by topic within their current browser windows. Preserve existing useful groups. Keep every tab visible.');
  let liveMessage: AssistantMessage | undefined;
  let lastStreamSave = 0;
  let persistenceFailure: unknown;
  let auditWrites: Promise<void> = Promise.resolve();
  const saveProgress = (text: string) => {
    if (!liveMessage) return;
    const messageId = liveMessage.id;
    auditWrites = auditWrites
      .then(() => chat.appendAudit(messageId, { text }))
      .catch((error: unknown) => {
        persistenceFailure = error;
        controller?.abort();
      });
  };
  try {
    if (!chat.current) throw new Error('Open a conversation before sending a request.');
    const priorMessages = retryState
      ? conversation.value.slice(
          0,
          conversation.value.findIndex((message) => message.id === retryState.user.id),
        )
      : conversation.value;
    const previous = priorMessages.map((message) => ({
      role: message.role,
      images: message.role === 'user' ? message.request?.images : undefined,
      content: `${message.content}${message.role === 'assistant' ? '\nLinked local results (data): ' + JSON.stringify({ collectionProposalId: message.collectionProposalId, collectionStatus: store.app?.collectionProposals.find((proposal) => proposal.id === message.collectionProposalId)?.status, createdProjectId: message.createdProjectId, command: message.commandDraft, outcome: message.outcome, sources: message.sources.slice(0, 30).map((source) => ({ id: source.recordId, title: source.title })) }) : ''}`,
    }));
    const resumeAnalysis = retryState?.failed.collectionAnalysisId
      ? await rpc('getCollectionAnalysis', { id: retryState.failed.collectionAnalysisId })
      : undefined;
    const activeCollectionProposalId =
      resumeAnalysis?.sourceAnalysisId && resumeAnalysis.purpose !== 'reclassify'
        ? undefined
        : retryState?.failed.collectionProposalId ||
          (request.attachments?.filter((item) => item.kind === 'proposal').length === 1
            ? request.attachments.find((item) => item.kind === 'proposal')?.id
            : selectedCollectionProposalId || undefined);
    const userId = retryState?.user.id || (await chat.append('user', instruction, { request }));
    const collectionAnalysisId =
      retryState?.failed.collectionAnalysisId || (regenerate ? crypto.randomUUID() : userId);
    if (retryState?.failed.collectionAnalysisId) chat.runningAnalysisId = collectionAnalysisId;
    const actionAnalysisId = activeAction?.id || (regenerate ? crypto.randomUUID() : userId);
    artifactMessageId.value = await chat.append('assistant', '', {
      request,
      requestMessageId: userId,
      retryOfMessageId: retrySource?.id,
      parentMessageId: userId,
      deliveryStatus: 'generating',
      taskDraft: retryState?.failed.taskDraft,
      projectDraft: retryState?.failed.projectDraft,
      commandDraft: retryState?.failed.commandDraft,
      plan: retryState?.failed.plan,
      collectionProposalId: activeCollectionProposalId,
      collectionAnalysisId: retryState?.failed.collectionAnalysisId,
      actionAnalysisId: activeAction?.id,
      completedArtifacts: [...(retryState?.failed.completedArtifacts || [])],
      createdProjectId: retryState?.failed.createdProjectId,
    });
    liveMessage = chat.current.messages.find((message) => message.id === artifactMessageId.value)!;
    collectionProposalId.value = liveMessage.collectionProposalId || '';
    chat.current.status = 'running';
    await chat.save();
    if (!retryState) {
      prompt.value = '';
      attachments.value = [];
      images.value = [];
    }
    const config = store.app.settings;
    const modelRoles: Array<'generative' | 'decision' | 'tags'> =
      resumeAnalysis && resumeAnalysis.classifiedIds.length === resumeAnalysis.scope.length
        ? resumeAnalysis.taggingRequested
          ? ['tags']
          : []
        : resumeAnalysis &&
            (resumeAnalysis.reuseAcceptedTaxonomyOnly ||
              (resumeAnalysis.discoveredIds.length === resumeAnalysis.scope.length &&
                (resumeAnalysis.classifiedIds.length > 0 ||
                  (resumeAnalysis.taxonomyProgress &&
                    resumeAnalysis.taxonomyProgress.cursor ===
                      resumeAnalysis.taxonomyProgress.sources.length)) &&
                resumeAnalysis.projects.every((project) => project.categories.length > 0)))
          ? ['decision']
          : activeAction
            ? [activeAction.mode === 'decision' ? 'decision' : 'generative']
            : request.task === 'classify'
              ? ['decision']
              : request.task === 'work' &&
                  request.classificationMode !== 'chat' &&
                  (config.useDedicatedDecisionModel ? config.decisionModel : config.smallModel)
                ? ['generative', 'decision']
                : ['generative'];
    if (
      request.task === 'work' &&
      (config.tagModelRole === 'generative' ? config.aiModel : config.smallModel)
    )
      modelRoles.push('tags');
    await requestModelAccess(config, modelRoles);
    await store.refresh();
    const currentApp = store.app;
    if (!currentApp) throw new Error('Workspace unavailable. Retry when it is ready.');
    if (!retryState && request.attachments?.length)
      resolveAttachments(currentApp, request.attachments);
    const actionCheckpoint = {
      id: actionAnalysisId,
      receipt: (
        receipt: Omit<import('../../shared/inference-receipt').InferenceReceipt, 'analysisId'>,
      ) => rpc('saveInferenceReceipt', { ...receipt, analysisId: actionAnalysisId }),
      load: () => rpc('getActionAnalysis', { id: actionAnalysisId }),
      rebase: () => rpc('rebaseActionAnalysis', { id: actionAnalysisId }),
      save: async (analysis: ActionAnalysis) => {
        const saved = await rpc('saveActionAnalysis', analysis);
        if (liveMessage && !liveMessage.actionAnalysisId) {
          liveMessage.actionAnalysisId = actionAnalysisId;
          await chat.save();
        }
        await refreshActionPlans();
        return saved;
      },
    };
    if (
      request.selectedRecordIds.some(
        (id) => !currentApp.records.some((record) => record.id === id && record.live),
      )
    )
      throw new Error(
        'A tab from the original selection is no longer open. Review the changed selection before sending a new request.',
      );
    if (
      request.projectId &&
      !currentApp.projects.some((project) => project.id === request.projectId)
    )
      throw new Error(
        'The original project context is no longer available. Review it before sending a new request.',
      );
    if (request.task === 'work') {
      const { answerWorkQuestion } = await import('../../ai/client');
      const result = await runModelInference(
        () =>
          answerWorkQuestion(store.app!, instruction, previous, controller!.signal, {
            images: request.images,
            attachmentHistory: conversation.value
              .filter((message) => message.role === 'user' && message.request?.restrictToScope)
              .map((message) => ({
                messageId: message.id,
                attachments: message.request?.attachments || [],
                recordIds: message.request?.recordIds || [],
              })),
            context: {
              projectId: request.projectId,
              selectedRecordIds: request.selectedRecordIds,
              attachments: request.attachments,
              classificationMode: request.classificationMode,
              scopeRecordIds: request.restrictToScope ? request.recordIds : undefined,
            },
            allowCrossWindowMove: request.allowCrossWindowMove,
            allowSleepWake: request.allowSleepWake,
            actionCheckpoint,
            resume: retryState?.failed,
            activeCollectionProposalId,
            onReadAssistantHistory: (offset) => rpc('listAssistantChanges', { offset }),
            onProposalHistory: (proposalId, offset) =>
              rpc('listProposalRevisions', { proposalId, offset }),
            onRestoreProposalRevision: async (input) => {
              const saved = await rpc('restoreProposalRevision', input);
              collectionProposalId.value = saved.id;
              if (liveMessage) {
                liveMessage.collectionProposalId = saved.id;
                liveMessage.collectionApplyRequested = false;
                await chat.save();
              }
              await store.refresh();
              return saved;
            },
            onTagAnalysisAccess: () => requestModelAccess(store.app!.settings, ['tags'], false),
            onCollectionTags: async (input) => {
              const proposal = await rpc('updateCollectionTags', input);
              collectionProposalId.value = proposal.id;
              liveMessage!.collectionProposalId = proposal.id;
              liveMessage!.collectionApplyRequested = false;
              await chat.save();
              await store.refresh();
              return proposal;
            },
            collectionCheckpoint: {
              tags: {
                analysisId: collectionAnalysisId,
                load: () => rpc('listTagAnalyses', { analysisId: collectionAnalysisId }),
                save: (row) => rpc('saveTagAnalysis', row),
              },
              id: collectionAnalysisId,
              receipt: (receipt) =>
                rpc('saveInferenceReceipt', { ...receipt, analysisId: collectionAnalysisId }),
              load: () => rpc('getCollectionAnalysis', { id: collectionAnalysisId }),
              rebase: () => rpc('rebaseCollectionAnalysis', { id: collectionAnalysisId }),
              refreshApp: () => rpc('state', undefined),
              save: async (analysis) => {
                chat.runningAnalysisId = collectionAnalysisId;
                const saved = await rpc('saveCollectionAnalysis', analysis);
                if (liveMessage && !liveMessage.collectionAnalysisId) {
                  liveMessage.collectionAnalysisId = collectionAnalysisId;
                  await chat.save();
                }
                return saved;
              },
              clear: () => rpc('clearCollectionAnalysis', { id: collectionAnalysisId }),
            },
            onProgress: (message) => {
              progress.value = message;
              saveProgress(message);
              if (liveMessage)
                liveMessage.activity = [...liveMessage.activity, message.slice(0, 1000)].slice(
                  -100,
                );
            },
            onReasoning: (text, streaming) => {
              if (!liveMessage) return;
              reasoningMessageId.value = liveMessage.id;
              providerReasoning.value = text;
              reasoningStreaming.value = streaming;
            },
            onText: (text) => {
              if (!liveMessage) return;
              liveMessage.content = text.slice(0, 100000);
              if (Date.now() - lastStreamSave < 500) return;
              lastStreamSave = Date.now();
              void chat.save().catch((error: unknown) => {
                persistenceFailure = error;
                controller?.abort();
              });
            },
            onToolEvent: async (event) => {
              if (!liveMessage) return;
              await chat.appendAudit(liveMessage.id, { event });
              liveMessage.toolEvents = [...liveMessage.toolEvents, event].slice(-100);
              await chat.save();
            },
            onCheckpoint: async (state) => {
              if (persistenceFailure) throw persistenceFailure;
              const recent = liveMessage!.activity;
              Object.assign(liveMessage!, state);
              liveMessage!.activity = recent;
              await chat.save();
            },
            onCollectionDraft: async (draft, id, expectedFingerprint) => {
              const previousScope = store.app?.collectionProposals.find(
                (item) => item.id === id,
              )?.scopeRecordIds;
              const expanding =
                id && JSON.stringify(draft.scopeRecordIds) !== JSON.stringify(previousScope);
              const proposal = id
                ? await rpc(expanding ? 'extendCollectionDraft' : 'updateCollectionDraft', {
                    id,
                    draft,
                    expectedFingerprint,
                  })
                : await rpc('proposeCollection', draft);
              collectionProposalId.value = proposal.id;
              if (liveMessage) {
                liveMessage.collectionProposalId = proposal.id;
                liveMessage.collectionApplyRequested = false;
              }
              await chat.save();
              await store.refresh();
              return proposal;
            },
            onReadCollectionProposal: (id) => rpc('getCollectionProposal', { id }),
            onCollectionMerge: async (input) => {
              const result = await rpc('mergeCollectionProposals', input);
              collectionProposalId.value = result.proposal.id;
              if (liveMessage) {
                liveMessage.collectionProposalId = result.proposal.id;
                liveMessage.collectionApplyRequested = false;
              }
              await chat.save();
              await store.refresh();
              return result;
            },
          }),
        {
          signal: controller.signal,
          parallelism: store.app!.settings.maxConcurrentInference,
          onWaiting: () => (progress.value = 'Waiting for model'),
        },
      );
      await auditWrites;
      if (persistenceFailure) throw persistenceFailure;
      progress.value = result.answer;
      workProposal.value = liveMessage.completedArtifacts.includes('task')
        ? null
        : result.proposal || null;
      projectProposal.value = liveMessage.completedArtifacts.includes('project')
        ? null
        : result.projectProposal || null;
      commandProposal.value = liveMessage.completedArtifacts.includes('command')
        ? null
        : result.command || null;
      store.pendingPlan = liveMessage.completedArtifacts.includes('plan')
        ? null
        : result.plan || null;
      checked.value = new Set(result.plan?.actions.map((_, index) => index) || []);
      if (result.collectionApplicationId)
        collectionProposalId.value = result.collectionApplicationId;
      Object.assign(liveMessage, {
        content: result.answer,
        deliveryStatus: 'complete',
        sources: result.sources,
        activity: liveMessage.activity,
        taskDraft: result.proposal,
        projectDraft: result.projectProposal,
        commandDraft: result.command,
        plan: result.plan,
        collectionProposalId: collectionProposalId.value || undefined,
        collectionApplyRequested: result.collectionApplyRequested || false,
      });
      await chat.save();
      return;
    }
    const records = request.recordIds
      .map((id) => store.records.find((record) => record.id === id && record.live))
      .filter((record): record is NonNullable<typeof record> => Boolean(record));
    if (records.length !== request.recordIds.length)
      throw new Error(
        'Some tabs in the original scope are no longer open. Review the changed scope before sending a new request.',
      );
    const { generatePlan } = await import('../../ai/client');
    const plan =
      retryState?.failed.plan ||
      (await runModelInference(
        () =>
          generatePlan(store.app!, records, instruction, {
            signal: controller!.signal,
            onProgress: (message) => {
              progress.value = message;
              saveProgress(message);
              liveMessage!.activity = [...liveMessage!.activity, message.slice(0, 1000)].slice(
                -100,
              );
            },
            conversation: previous,
            readOnly: request.task === 'ask',
            allowCrossWindowMove: request.allowCrossWindowMove,
            allowSleepWake: request.allowSleepWake,
            useDecisionModel: request.task === 'classify',
            actionCheckpoint,
          }),
        {
          signal: controller.signal,
          parallelism: store.app!.settings.maxConcurrentInference,
          onWaiting: () => (progress.value = 'Waiting for model'),
        },
      ));
    await auditWrites;
    if (persistenceFailure) throw persistenceFailure;
    store.pendingPlan = liveMessage.completedArtifacts.includes('plan') ? null : plan;
    checked.value = new Set(plan.actions.map((_, i) => i));
    progress.value = plan.actions.length
      ? `${plan.actions.length} proposed actions · review before applying`
      : 'Answer ready · no tab changes';
    liveMessage.content = plan.summary;
    liveMessage.plan = plan;
    liveMessage.deliveryStatus = 'complete';
    await chat.save();
  } catch (e) {
    progress.value = persistenceFailure
      ? `Could not save assistant progress: ${errorMessage(persistenceFailure)}`
      : controller.signal.aborted
        ? 'Cancelled. Your tabs are unchanged.'
        : errorMessage(e);
    if (chat.current) {
      chat.current.status = controller.signal.aborted ? 'interrupted' : 'error';
      if (liveMessage) {
        if (liveMessage.collectionAnalysisId) {
          const analysis = await rpc('getCollectionAnalysis', {
            id: liveMessage.collectionAnalysisId,
          });
          if (analysis?.failedBatch)
            liveMessage.analysisFailure = {
              stage: analysis.failedBatch.stage,
              completed:
                analysis.failedBatch.stage === 'discovery'
                  ? analysis.discoveredIds.length
                  : analysis.classifiedIds.length,
              total: analysis.scope.length,
              batchCount: analysis.failedBatch.recordIds.length,
              attempts: analysis.failedBatch.attempts,
            };
        }
        liveMessage.deliveryStatus =
          controller.signal.aborted && !persistenceFailure ? 'interrupted' : 'error';
        liveMessage.outcome = progress.value;
        if (/<\/?(?:tool_call|function=|parameter=)/i.test(liveMessage.content))
          liveMessage.content = '';
        liveMessage.content ||= progress.value;
        liveMessage.collectionProposalId = collectionProposalId.value || undefined;
        await chat.save();
      }
    }
  } finally {
    if (liveMessage) {
      liveMessage.completedAt = Date.now();
      if (liveMessage.deliveryStatus === 'complete') autoApprovalMessageId = liveMessage.id;
    }
    await auditWrites;
    chat.runningAnalysisId = '';
    await refreshActionPlans().catch(() => undefined);
    if (chat.current?.status === 'running') chat.current.status = 'ready';
    await chat.save();
  }
}
function pendingArtifact(kind: AssistantArtifact['kind']): AssistantArtifact | undefined {
  if (kind === 'task' && workProposal.value) return { kind, task: workProposal.value };
  if (kind === 'project' && projectProposal.value) return { kind, project: projectProposal.value };
  if (kind === 'command' && commandProposal.value) return { kind, command: commandProposal.value };
  if (
    kind === 'collection' &&
    collectionProposalId.value &&
    !conversation.value
      .find((item) => item.id === artifactMessageId.value)
      ?.completedArtifacts.includes('collection') &&
    store.app?.collectionProposals.some(
      (item) =>
        item.id === collectionProposalId.value && item.status === 'pending' && !item.copyState,
    )
  )
    return { kind, proposalId: collectionProposalId.value };
  if (kind === 'plan' && store.pendingPlan) {
    const actions = store.pendingPlan.actions.filter((_, index) => checked.value.has(index));
    if (actions.length) return { kind, plan: { ...store.pendingPlan, actions } };
  }
}
function toggle(index: number) {
  const next = new Set(checked.value);
  if (next.has(index)) next.delete(index);
  else next.add(index);
  checked.value = next;
}
const selectedPlanArtifact = computed(() => pendingArtifact('plan'));
const collectionArtifact = computed(() => pendingArtifact('collection'));
type ActionSelection = { artifact: AssistantArtifact; threadId: string; messageId: string };
async function approveArtifact(kind: AssistantArtifact['kind'], mode: ApprovalMode) {
  const ownBusy = mode !== 'automatic';
  if (ownBusy && (busy.value || remoteRunning.value)) return;
  if (ownBusy) busy.value = true;
  try {
    await store.run(async () => {
      const pending = pendingArtifact(kind);
      if (!pending) throw new Error('No pending action is selected.');
      const selection: ActionSelection = {
        artifact: assistantArtifactSchema.parse(pending),
        threadId: chat.activeId,
        messageId: artifactMessageId.value,
      };
      if (selection.artifact.kind === 'collection') {
        const id = selection.artifact.proposalId;
        const proposal = store.app?.collectionProposals.find((item) => item.id === id);
        if (!proposal) throw new Error('The saved proposal is unavailable.');
        selection.artifact.proposalFingerprint = await tagHash(proposal);
      }
      await chat.exclusive(() => performApproval(kind, mode, undefined, selection));
    });
  } finally {
    if (ownBusy) busy.value = false;
  }
}
async function performApproval(
  kind: AssistantArtifact['kind'],
  mode: ApprovalMode,
  permissionReviewId?: string,
  selection?: ActionSelection,
) {
  const artifact = selection?.artifact || pendingArtifact(kind);
  if (!artifact) throw new Error('No pending action is selected.');
  const assertSelection = () => {
    if (!selection) return;
    const current = pendingArtifact(kind);
    const same =
      artifact.kind === 'collection' && current?.kind === 'collection'
        ? artifact.proposalId === current.proposalId
        : JSON.stringify(artifact) === JSON.stringify(current);
    if (
      !same ||
      chat.activeId !== selection.threadId ||
      artifactMessageId.value !== selection.messageId
    )
      throw new Error('The selected action changed. Review it again before approving.');
  };
  assertSelection();
  ensureArtifactPending(kind);
  if (
    mode !== 'reviewed' &&
    mode !== 'automatic' &&
    artifact.kind === 'command' &&
    artifact.command.kind === 'inspect'
  )
    await store.requestInspectionAccess(artifact.command.recordIds);
  assertSelection();
  const trace = await rpc('executeAssistantAction', {
    threadId: chat.activeId,
    messageId: artifactMessageId.value,
    mode,
    artifact,
    permissionReviewId,
    permissionPolicyRevision: mode === 'automatic' ? permissionPolicyRevision.value : undefined,
  });
  if (trace.status === 'failed' || trace.status === 'interrupted') throw new Error(trace.outcome);
  const message = conversation.value.find((item) => item.id === artifactMessageId.value);
  if (message)
    message.assistantChangeIds = [...new Set([...(message.assistantChangeIds || []), trace.id])];
  if (message && trace.projectId) message.createdProjectId = trace.projectId;
  await recordOutcome(trace.outcome, kind);
  if (kind === 'task') workProposal.value = null;
  else if (kind === 'project') projectProposal.value = null;
  else if (kind === 'command') commandProposal.value = null;
  else if (kind === 'plan') store.pendingPlan = null;
  store.notify(trace.outcome);
  await store.refresh();
  if (mode !== 'automatic') scrollLatest();
}
let autoApprovalMessageId = '';
async function reviewArtifact(kind: AssistantArtifact['kind'], oneOff = true) {
  if (busy.value || remoteRunning.value) return;
  busy.value = true;
  reviewingPermission.value = true;
  try {
    await store.run(() =>
      chat.exclusive(async () => {
        const artifact = pendingArtifact(kind);
        if (!artifact) return;
        ensureArtifactPending(kind);
        const message = conversation.value.find((item) => item.id === artifactMessageId.value);
        if (!message) return;
        let review = await rpc('preparePermissionReview', {
          threadId: chat.activeId,
          messageId: message.id,
          artifact,
          oneOff,
        });
        message.permissionReviewIds = [...(message.permissionReviewIds || []), review.id].slice(
          -100,
        );
        message.permissionReviewUpdatedAt = Math.max(
          Date.now(),
          (message.permissionReviewUpdatedAt || 0) + 1,
        );
        await chat.save();
        if (review.status === 'pending')
          review = await rpc('resolvePermissionReview', { id: review.id });
        message.permissionReviewUpdatedAt = Math.max(
          Date.now(),
          (message.permissionReviewUpdatedAt || 0) + 1,
        );
        await chat.save();
        try {
          if (review.decision === 'allow' && review.status === 'complete')
            await performApproval(kind, 'reviewed', review.id);
        } finally {
          message.permissionReviewUpdatedAt = Math.max(
            Date.now(),
            (message.permissionReviewUpdatedAt || 0) + 1,
          );
          await chat.save();
        }
      }),
    );
  } finally {
    reviewingPermission.value = false;
    busy.value = false;
  }
}
async function reviewPendingActions(oneOff = false) {
  for (const kind of ['task', 'project', 'command', 'collection', 'plan'] as const) {
    if (
      kind === 'collection' &&
      !oneOff &&
      !conversation.value.find((item) => item.id === artifactMessageId.value)
        ?.collectionApplyRequested
    )
      continue;
    if (!oneOff && permissionMode.value === 'ask') break;
    if (!pendingArtifact(kind)) continue;
    if (!oneOff && permissionMode.value === 'all') {
      busy.value = true;
      applyingAutomatically.value = true;
      try {
        await approveArtifact(kind, 'automatic');
      } finally {
        applyingAutomatically.value = false;
        busy.value = false;
      }
    } else await reviewArtifact(kind, oneOff);
  }
}
async function reviewPreparedActions() {
  const id = autoApprovalMessageId;
  autoApprovalMessageId = '';
  if (!id || id !== artifactMessageId.value || permissionMode.value === 'ask') return;
  await reviewPendingActions();
}
function stopWork() {
  if (reviewingPermission.value || applyingAutomatically.value) void changePermissionMode('ask');
  else controller?.abort();
}
async function revokePermissions(all = false) {
  await store.run(async () => {
    await rpc('revokeAssistantApprovals', all ? {} : { threadId: chat.activeId });
    await store.refresh();
    store.notify('Saved approvals revoked');
  });
}
const approvalItems = computed(() => [
  permissionModes.map((item) => ({
    label: item.label,
    type: 'checkbox' as const,
    checked: permissionMode.value === item.value,
    onSelect: () => changePermissionMode(item.value),
  })),
  ...(permissionMode.value !== 'ask' || reviewingPermission.value || applyingAutomatically.value
    ? [
        [
          ...(permissionMode.value !== 'ask'
            ? [
                {
                  label:
                    permissionMode.value === 'all'
                      ? 'Apply pending actions'
                      : 'Review pending actions',
                  disabled: busy.value || remoteRunning.value,
                  onSelect: () => reviewPendingActions(),
                },
              ]
            : []),
          ...(reviewingPermission.value || applyingAutomatically.value
            ? [
                {
                  label: 'Stop automatic approval',
                  onSelect: () => changePermissionMode('ask'),
                },
              ]
            : []),
        ],
      ]
    : []),
  ...(store.app?.assistantApprovalRules?.length
    ? [
        [
          {
            label: 'Previous saved permissions',
            children: [
              ...store.app.assistantApprovalRules.map((rule) => ({
                label: capabilityLabels[rule.capability],
                disabled: true,
              })),
              { label: 'Clear for this chat', onSelect: () => revokePermissions() },
              { label: 'Clear all previous grants', onSelect: () => revokePermissions(true) },
            ],
          },
        ],
      ]
    : []),
]);
onMounted(async () => {
  await store.run(async () => {
    await chat.load();
    if (chat.activeId) await selectThread(chat.activeId);
    else await refreshActionPlans();
    if (props.visible !== false && dockedHistory.value) historyOpen.value = true;
    readyForAnalysisLaunch.value = true;
  });
});
defineExpose({
  selectScope: () => {
    scope.value = 'selected';
    task.value = 'work';
    const ids = store.selection();
    attachments.value = ids.length
      ? [
          {
            kind: 'selection',
            id: crypto.randomUUID(),
            label: `${ids.length} selected ${ids.length === 1 ? 'tab' : 'tabs'}`,
            recordIds: ids,
          },
        ]
      : [];
  },
});
</script>
<template>
  <aside
    ref="panelRoot"
    :class="
      cn(
        'relative flex h-full min-h-0 w-full bg-canvas',
        expanded ? 'flex-1' : 'border-l border-line',
      )
    "
  >
    <Transition
      enter-active-class="overflow-hidden transition-[width,opacity,transform] duration-180"
      enter-from-class="w-0! opacity-0 -translate-x-2"
      leave-active-class="overflow-hidden transition-[width,opacity,transform] duration-180"
      leave-to-class="w-0! opacity-0 -translate-x-2"
      ><ConversationList
        v-if="historyOpen && dockedHistory"
        docked
        :threads="chat.threads"
        :active-id="chat.activeId"
        :projects="store.app?.projects || []"
        :busy="busy"
        :has-more="chat.hasMoreChats"
        @rename="renameThread"
        @remove="deleteThread"
        @search="(query) => store.run(() => chat.loadMoreChats(query, true))"
        @more="store.run(() => chat.loadMoreChats())"
        @select="selectThread"
        @create="newThread"
        @move="moveThread"
        @close="historyOpen = false"
    /></Transition>
    <USlideover
      v-model:open="historyDrawer"
      side="left"
      title="Saved chats"
      :content="{ onCloseAutoFocus: restoreHistoryFocus }"
      :ui="{
        content: 'w-[min(320px,calc(100vw-32px))] bg-chat-sidebar',
        body: 'p-0 min-h-0',
        header: 'sr-only',
        overlay: 'bg-black/55',
      }"
      ><template #body
        ><ConversationList
          :threads="chat.threads"
          :active-id="chat.activeId"
          :projects="store.app?.projects || []"
          :busy="busy"
          :has-more="chat.hasMoreChats"
          @rename="renameThread"
          @remove="deleteThread"
          @search="(query) => store.run(() => chat.loadMoreChats(query, true))"
          @more="store.run(() => chat.loadMoreChats())"
          @select="selectThread"
          @create="newThread"
          @move="moveThread"
          @close="historyOpen = false" /></template
    ></USlideover>
    <div class="flex min-h-0 min-w-0 flex-1 flex-col">
      <header class="flex shrink-0 flex-col gap-3 border-b border-line px-4 py-3">
        <div class="flex min-w-0 items-center gap-2">
          <UiButton
            v-if="expanded"
            square
            size="small"
            variant="ghost"
            :class="sidePanel ? undefined : 'lg:hidden'"
            title="Open navigation"
            aria-label="Open navigation"
            data-navigation-trigger
            @click="emit('navigation')"
            ><Menu class="size-4"
          /></UiButton>
          <UiButton
            v-if="expanded && !sidePanel"
            square
            size="small"
            variant="ghost"
            class="hidden lg:inline-flex"
            :title="sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'"
            :aria-label="sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'"
            @click="emit('toggleSidebar')"
            ><PanelLeftOpen v-if="sidebarCollapsed" class="size-4" /><PanelLeftClose
              v-else
              class="size-4"
          /></UiButton>
          <UiButton
            square
            size="small"
            variant="ghost"
            :title="historyOpen ? 'Hide saved chats' : 'Show saved chats'"
            data-chat-history-trigger
            :aria-label="historyOpen ? 'Hide saved chats' : 'Show saved chats'"
            @click="historyOpen = !historyOpen"
            ><MessageSquare class="size-4"
          /></UiButton>
          <component
            :is="expanded ? 'h1' : 'h2'"
            :class="
              cn(
                'min-w-0 flex-1 truncate font-semibold',
                expanded ? 'text-lg tracking-tight' : 'text-sm',
              )
            "
            >{{ expanded ? 'Assistant' : 'Workspace assistant' }}</component
          >
          <UiButton
            v-if="remoteRunning"
            square
            size="small"
            variant="ghost"
            title="Refresh saved conversation"
            aria-label="Refresh saved conversation"
            @click="selectThread(chat.activeId)"
            ><RefreshCw class="size-4"
          /></UiButton>
          <UiThemeToggle v-if="!sidePanel && !compactHeader" />
          <UiButton
            v-if="!compactHeader"
            square
            size="small"
            variant="ghost"
            :disabled="busy"
            title="New conversation"
            aria-label="New conversation"
            @click="newThread()"
            ><Plus class="size-4"
          /></UiButton>
          <UDropdownMenu
            v-if="sidePanel || compactHeader"
            :items="[
              ...(compactHeader
                ? [{ label: 'New conversation', disabled: busy, onSelect: () => newThread() }]
                : []),
              { label: 'Open full page', onSelect: () => emit('openFullPage') },
              {
                label: appearance === 'light' ? 'Switch to dark mode' : 'Switch to light mode',
                onSelect: toggleAppearance,
              },
              { label: 'Settings', onSelect: () => store.show('settings') },
            ]"
            :ui="{ content: 'bg-overlay' }"
            ><UiButton
              size="small"
              variant="ghost"
              title="Assistant menu"
              aria-label="Assistant menu"
              ><Ellipsis class="size-4" /></UiButton
          ></UDropdownMenu>
          <UiButton
            size="small"
            variant="ghost"
            :title="
              sidePanel ? 'Close side panel' : expanded ? 'Open Windows & tabs' : 'Close assistant'
            "
            :aria-label="
              sidePanel ? 'Close side panel' : expanded ? 'Open Windows & tabs' : 'Close assistant'
            "
            @click="emit('close')"
            ><X v-if="sidePanel" class="size-4" /><PanelRightClose v-else class="size-4"
          /></UiButton>
        </div>
        <div class="flex min-w-0 flex-wrap items-start gap-x-4 gap-y-1 text-xs text-muted">
          <span class="min-w-0 flex-1 truncate" :title="chat.current?.title">{{
            chat.current?.title || 'New conversation'
          }}</span>
        </div>
        <p v-if="remoteRunning" class="text-xs text-muted" role="status">
          This conversation is active in another TabFlow view. Refresh to see its saved progress, or
          start a new conversation.
        </p>
        <div v-if="savedActionPlans.length" class="flex flex-col gap-1 text-xs text-muted">
          <div
            v-for="analysis in savedActionPlans.slice(0, 5)"
            :key="analysis.id"
            class="flex min-w-0 items-center gap-2"
          >
            <span class="min-w-0 flex-1 truncate" :title="analysis.instruction">
              Saved action plan · {{ analysis.completedIds.length }}/{{ analysis.scope.length }}
              tabs
              <span v-if="analysis.failedBatch">
                · failed batch {{ analysis.failedBatch.recordIds.length }}</span
              >
            </span>
            <UiButton
              size="small"
              variant="ghost"
              :disabled="busy || remoteRunning"
              :title="analysis.instruction"
              @click="resumeActionPlan(analysis)"
            >
              <RefreshCw class="size-3" />Resume
            </UiButton>
          </div>
        </div>
      </header>
      <BrowserWorkProgress />
      <UiScrollArea
        class="flex-1"
        content-class="flex flex-col items-center px-4 py-5"
        label="Conversation messages"
        @viewport="transcript = $event"
      >
        <div
          ref="transcriptContent"
          :class="
            cn(
              'flex w-full flex-col gap-6',
              expanded && 'max-w-3xl',
              !conversation.length && 'justify-center',
            )
          "
          :style="
            !conversation.length
              ? { minHeight: `${Math.max(0, transcriptHeight - 40)}px` }
              : undefined
          "
        >
          <section
            v-if="!conversation.length"
            class="flex flex-col items-center gap-4 py-5 text-center"
          >
            <h3 class="text-lg font-semibold">Start with your tabs and what matters to you.</h3>
            <p class="max-w-xl text-sm leading-6 text-muted">
              Ask about a project, find a reference, or build a reviewed organization plan across
              your windows.
            </p>
            <div class="flex flex-wrap justify-center gap-2">
              <UiButton
                size="small"
                @click="
                  prompt =
                    'Organize all my open tabs into useful projects. Preserve my windows and useful existing group distinctions.'
                "
                >Organize my collection</UiButton
              >
              <UiButton
                size="small"
                @click="
                  prompt =
                    'What deserves my attention today? Read my saved work and relevant tab context, and distinguish tasks from tabs that may need review.'
                "
                >What should I focus on?</UiButton
              >
              <UiButton
                size="small"
                @click="
                  prompt =
                    'What projects and personal contexts are represented in my open tabs? Show evidence and what is uncertain.'
                "
                >Understand my workspace</UiButton
              >
            </div>
          </section>
          <p
            v-if="chat.current?.status === 'interrupted'"
            class="text-xs leading-5 text-muted"
            role="status"
          >
            The previous run was interrupted. Saved messages and proposals remain available; no
            operation was replayed.
          </p>
          <UChatMessage
            v-for="message in conversation"
            :id="message.id"
            :key="message.id"
            :role="message.role"
            :parts="[]"
            :side="message.role === 'user' ? 'right' : 'left'"
            :variant="message.role === 'user' ? 'soft' : 'naked'"
            color="neutral"
            class="w-full min-w-0"
            :ui="{
              container: cn('flex w-full min-w-0', message.role === 'user' && 'justify-end'),
              body: cn(
                'flex min-w-0 flex-col gap-2',
                message.role === 'user' ? 'max-w-[90%] rounded-2xl bg-raised px-4 py-3' : 'w-full',
              ),
            }"
          >
            <template #body>
              <span class="text-xs font-medium text-muted">{{
                message.role === 'user' ? 'You' : 'TabFlow'
              }}</span>
              <p
                v-if="message.role === 'user'"
                class="text-sm leading-6 whitespace-pre-wrap break-words"
              >
                {{ message.content }}
              </p>
              <div
                v-if="message.role === 'user' && message.request?.attachments?.length"
                class="flex flex-wrap gap-1 text-xs text-muted"
                aria-label="Attached workspace context"
              >
                <span
                  v-for="(item, index) in message.request.attachments"
                  :key="index"
                  class="max-w-full truncate rounded-md bg-selected px-2 py-1"
                  :title="`${item.kind}: ${item.id}`"
                  >{{ item.kind }} · {{ item.label }}</span
                >
                <span class="px-2 py-1"
                  >{{ message.request.recordIds.length }} tabs at send time</span
                >
              </div>
              <div
                v-if="message.role === 'user' && message.request?.images?.length"
                class="flex flex-wrap gap-2"
                aria-label="Attached images"
              >
                <img
                  v-for="image in message.request.images"
                  :key="image.id"
                  :src="image.dataUrl"
                  :alt="image.name"
                  class="h-24 max-w-40 rounded-lg object-contain"
                />
              </div>
              <UChatReasoning
                v-if="message.id === reasoningMessageId && providerReasoning"
                :text="providerReasoning"
                :streaming="busy && reasoningStreaming"
                :unmount-on-hide="true"
                class="min-w-0"
              >
                <MarkdownRender
                  :content="providerReasoning"
                  :is-dark="appearance !== 'light'"
                  :final="!busy || !reasoningStreaming"
                  :custom-markdown-it="safeMarkdown"
                  html-policy="escape"
                  mode="chat"
                  :render-code-blocks-as-pre="true"
                  :fade="false"
                  class="text-xs leading-5 text-muted"
                />
              </UChatReasoning>
              <AssistantRunTiming :message="message" />
              <AssistantToolActivity
                v-if="message.toolEvents.length"
                :events="message.toolEvents"
                :running="message.deliveryStatus === 'generating'"
              />
              <UiCollapsible v-if="message.activity.length" class="text-xs text-muted"
                ><template #label> {{ message.activity.length }} recent progress entries </template>
                <ul class="flex list-none flex-col gap-1 p-0 pt-2">
                  <li v-for="(step, index) in message.activity" :key="index">{{ step }}</li>
                </ul>
              </UiCollapsible>
              <RunHistory v-if="message.role === 'assistant'" :message-id="message.id" />
              <InferenceHistory
                v-if="message.collectionAnalysisId || message.actionAnalysisId"
                :analysis-id="message.collectionAnalysisId || message.actionAnalysisId!"
              />
              <UiCollapsible v-if="message.sources.length" class="text-xs text-muted"
                ><template #label>
                  Tab evidence · {{ message.sources.length }} references
                </template>
                <div class="flex flex-col gap-1 pt-2">
                  <UiButton
                    v-for="source in message.sources"
                    :key="source.recordId"
                    variant="ghost"
                    class="w-full justify-start text-left"
                    :title="`${source.url}\n${source.capturedAt ? 'Cached ' + new Date(source.capturedAt).toLocaleString() : 'Title/URL only; page not inspected'}`"
                    :disabled="
                      !store.records.some(
                        (record) => record.id === source.recordId && record.url === source.url,
                      )
                    "
                    @click="store.run(() => rpc('focus', { id: source.recordId }))"
                  >
                    <ExternalLink class="size-3 shrink-0" /><span class="min-w-0 flex-1 truncate">{{
                      source.title
                    }}</span
                    ><span class="max-w-24 truncate text-xs text-muted">{{
                      source.project || source.group || `Window ${source.windowId}`
                    }}</span>
                  </UiButton>
                </div>
              </UiCollapsible>
              <MarkdownRender
                v-if="
                  message.role === 'assistant' &&
                  message.content &&
                  !/^\s*(?:```(?:xml|html)?\s*)?<tool_call>/i.test(message.content)
                "
                class="assistant-markdown min-w-0 break-words text-sm leading-6"
                :content="message.content"
                :is-dark="appearance !== 'light'"
                :final="message.deliveryStatus !== 'generating'"
                :custom-markdown-it="safeMarkdown"
                html-policy="escape"
                mode="chat"
                :render-code-blocks-as-pre="true"
                :fade="false"
              />
              <p
                v-if="incompleteToolTurn(message) && message.deliveryStatus === 'complete'"
                class="text-xs text-muted"
                role="status"
              >
                This saved turn stopped before completing the request. Retry is available below;
                saved results remain intact.
              </p>
              <UChatShimmer
                v-if="message.deliveryStatus === 'generating'"
                text="Generating..."
                class="text-xs text-muted"
                role="status"
              />
              <p v-if="message.outcome" class="text-xs leading-5 text-muted">
                <X
                  v-if="['error', 'interrupted'].includes(message.deliveryStatus || '')"
                  class="inline size-3"
                /><Check v-else class="inline size-3" /> {{ message.outcome }}
              </p>
              <AssistantPermissionReviews
                v-if="message.permissionReviewIds?.length"
                :message-id="message.id"
                :ids="message.permissionReviewIds"
                :revision="message.permissionReviewUpdatedAt"
                :can-review="message.id === artifactMessageId"
                @review="reviewPendingActions(true)"
              />
              <AssistantChangeHistory
                v-if="message.role === 'assistant'"
                :message-id="message.id"
                :trace-ids="message.assistantChangeIds"
              />
              <p v-if="message.analysisFailure" class="text-xs text-muted">
                {{ message.analysisFailure.completed }} of {{ message.analysisFailure.total }}
                {{ message.analysisFailure.stage === 'discovery' ? 'discovered' : 'classified' }} ·
                failed {{ message.analysisFailure.stage }} batch:
                {{ message.analysisFailure.batchCount }} tabs ·
                {{ message.analysisFailure.attempts }} attempts
              </p>
              <div
                v-if="message.collectionAnalysisId && canRetry(chat.current, message)"
                class="flex flex-wrap gap-2"
              >
                <UDropdownMenu
                  :items="[
                    {
                      label: 'Rebuild project structure',
                      description: 'Rediscover projects, categories and tags.',
                      onSelect: () => store.run(() => repairSavedAnalysis(message, 'discovery')),
                    },
                    {
                      label: 'Recheck projects, categories and tags',
                      description: 'Reuse saved discovery.',
                      onSelect: () =>
                        store.run(() => repairSavedAnalysis(message, 'classification')),
                    },
                    {
                      label: 'Repair tags only',
                      description: 'Keep project/category choices for review.',
                      onSelect: () => store.run(() => repairSavedAnalysis(message, 'tagging')),
                    },
                  ]"
                  :ui="{
                    content: 'w-80 max-w-[calc(100vw-32px)] bg-overlay',
                    item: 'min-h-9 text-[13px]',
                  }"
                >
                  <UiButton size="small" variant="ghost" :disabled="busy || remoteRunning"
                    >Repair analysis</UiButton
                  >
                </UDropdownMenu>
              </div>
              <UiButton
                v-if="
                  message.actionAnalysisId &&
                  message.request?.task === 'classify' &&
                  canRetry(chat.current, message)
                "
                size="small"
                variant="ghost"
                :disabled="busy || remoteRunning"
                @click="store.run(() => repairSavedAction(message))"
                >Re-evaluate group classification</UiButton
              >
              <div
                v-if="message.role === 'assistant' && message.deliveryStatus !== 'generating'"
                class="flex flex-wrap items-center gap-2"
              >
                <UiButton
                  size="small"
                  variant="ghost"
                  :disabled="busy || remoteRunning"
                  @click="regenerateAnswer(message)"
                  >Retry answer</UiButton
                >
                <template v-if="answerBranches(chat.current, message).length > 1">
                  <UiButton
                    square
                    size="small"
                    variant="ghost"
                    aria-label="Previous answer"
                    title="Previous answer"
                    :disabled="
                      busy ||
                      remoteRunning ||
                      answerBranches(chat.current, message)[0]?.id === message.id
                    "
                    @click="chooseAdjacentAnswer(message, -1)"
                    ><ChevronLeft class="size-3.5"
                  /></UiButton>
                  <span class="text-xs text-muted" aria-label="Answer branch"
                    >{{
                      answerBranches(chat.current, message).findIndex(
                        (branch) => branch.id === message.id,
                      ) + 1
                    }}
                    / {{ answerBranches(chat.current, message).length }}</span
                  >
                  <UiButton
                    square
                    size="small"
                    variant="ghost"
                    aria-label="Next answer"
                    title="Next answer"
                    :disabled="
                      busy ||
                      remoteRunning ||
                      answerBranches(chat.current, message).at(-1)?.id === message.id
                    "
                    @click="chooseAdjacentAnswer(message, 1)"
                    ><ChevronRight class="size-3.5"
                  /></UiButton>
                </template>
              </div>
              <div v-if="canRetry(chat.current, message)" class="flex flex-wrap items-center gap-2">
                <UiButton
                  v-if="
                    message.analysisFailure &&
                    message.collectionAnalysisId &&
                    canRetry(chat.current, message)
                  "
                  size="small"
                  variant="ghost"
                  :disabled="busy || remoteRunning"
                  @click="store.run(() => skipFailedTags(message))"
                  >Skip failed tabs and continue</UiButton
                >
                <UiButton
                  v-if="canRetry(chat.current, message)"
                  size="small"
                  variant="default"
                  class="w-fit"
                  :disabled="busy || remoteRunning"
                  :title="
                    message.actionAnalysisId
                      ? 'Resume the saved action plan from its first unfinished batch, using the current model settings.'
                      : message.collectionAnalysisId
                        ? message.analysisFailure
                          ? 'Retry the saved failed batch first, then continue with unfinished tabs.'
                          : 'Resume the saved collection analysis from its first unfinished batch.'
                        : 'Retry the original request with its saved scope and current model settings.'
                  "
                  @click="retry(message.id)"
                  ><RefreshCw class="size-3" />{{
                    message.actionAnalysisId
                      ? 'Resume action plan'
                      : message.collectionAnalysisId
                        ? message.analysisFailure
                          ? 'Retry failed batch'
                          : 'Resume analysis'
                        : message.deliveryStatus === 'interrupted'
                          ? 'Resume request'
                          : 'Retry request'
                  }}</UiButton
                >
              </div>
              <UiButton
                v-if="
                  (message.taskDraft && !message.completedArtifacts.includes('task')) ||
                  (message.projectDraft && !message.completedArtifacts.includes('project')) ||
                  (message.plan && !message.completedArtifacts.includes('plan')) ||
                  (message.commandDraft && !message.completedArtifacts.includes('command'))
                "
                size="small"
                variant="ghost"
                class="w-fit"
                :disabled="busy"
                @click="reviewArtifacts(message)"
                >Review saved draft<ArrowUpRight class="size-3"
              /></UiButton>
              <UiButton
                v-if="message.createdProjectId"
                size="small"
                variant="ghost"
                class="w-fit"
                @click="
                  store.projectFilter = message.createdProjectId;
                  store.projectSection = 'tabs';
                  store.show('projects');
                "
                >Open project<ArrowUpRight class="size-3"
              /></UiButton>
              <UiButton
                v-if="message.collectionProposalId"
                size="small"
                variant="ghost"
                class="w-fit"
                @click="
                  store.projectSection = 'drafts';
                  store.show('projects');
                "
                >Organization ·
                {{
                  store.app?.collectionProposals.find(
                    (proposal) => proposal.id === message.collectionProposalId,
                  )?.status || 'saved'
                }}<ArrowUpRight class="size-3"
              /></UiButton>
            </template>
          </UChatMessage>
          <div
            v-if="busy"
            class="flex items-center gap-2 text-xs leading-5 text-muted"
            role="status"
          >
            <LoaderCircle class="block size-4 shrink-0 animate-spin" /><UChatShimmer
              class="min-w-0 leading-5"
              :text="progress || 'Working with your configured model...'"
            />
          </div>
          <section
            v-if="workProposal"
            class="flex flex-col gap-3 border-t border-line pt-4"
            aria-label="AI task draft"
          >
            <h3 class="text-sm font-medium">Review AI task draft</h3>
            <label class="field-label"
              >Task<input v-model="workProposal.title" class="field" maxlength="240"
            /></label>
            <label class="field-label"
              >Notes<textarea
                v-model="workProposal.notes"
                class="field"
                rows="2"
                maxlength="1000"
              />
            </label>
            <label class="field-label"
              >Priority<UiSelect
                v-model="workProposal.priority"
                :options="
                  ['low', 'normal', 'high', 'urgent'].map((value) => ({ label: value, value }))
                "
                aria-label="Task priority"
            /></label>
            <p class="text-xs text-muted">
              {{
                workProposal.dueAt
                  ? `Due ${new Date(workProposal.dueAt).toLocaleString()}`
                  : 'No due date'
              }}{{ workProposal.recordId ? ' · Linked to a tab' : '' }}. Saved after your review.
            </p>
            <AssistantApprovalControls
              :artifact="{ kind: 'task', task: workProposal }"
              :disabled="busy"
              @approve="approveArtifact('task', $event)"
              @review="reviewArtifact('task')"
              @deny="dismissArtifact('task')"
            />
          </section>
          <section
            v-if="projectProposal"
            class="flex flex-col gap-3 border-t border-line pt-4"
            aria-label="AI project draft"
          >
            <h3 class="text-sm font-medium">Review AI project draft</h3>
            <label class="field-label"
              >Name<input v-model="projectProposal.name" class="field" maxlength="80"
            /></label>
            <label class="field-label"
              >Purpose<textarea
                v-model="projectProposal.purpose"
                class="field"
                rows="2"
                maxlength="1000"
              />
            </label>
            <label class="field-label"
              >Area<UiSelect
                :model-value="projectProposal.areaId || ''"
                :options="[
                  { label: 'No area', value: '' },
                  ...(store.app?.areas || []).map((area) => ({ label: area.name, value: area.id })),
                ]"
                aria-label="Project area"
                @update:model-value="projectProposal.areaId = $event || null"
            /></label>
            <AssistantApprovalControls
              :artifact="{ kind: 'project', project: projectProposal }"
              :disabled="busy"
              @approve="approveArtifact('project', $event)"
              @review="reviewArtifact('project')"
              @deny="dismissArtifact('project')"
            />
          </section>
          <section
            v-if="commandProposal"
            class="flex flex-col gap-3 border-t border-line pt-4"
            aria-label="Review assistant workspace action"
          >
            <h3 class="text-sm font-medium">
              Review
              {{
                commandProposal.kind === 'workspace_edits'
                  ? 'workspace edits'
                  : commandProposal.kind === 'assign'
                    ? 'your project correction'
                    : commandProposal.kind === 'inspect'
                      ? 'page inspection'
                      : commandProposal.kind === 'redo' || commandProposal.kind === 'redo_assistant'
                        ? 'redo'
                        : commandProposal.kind === 'undo_assistant'
                          ? 'assistant action undo'
                          : commandProposal.kind === 'undo'
                            ? 'operation undo'
                            : commandProposal.kind === 'restore'
                              ? 'snapshot restore'
                              : 'snapshot creation'
              }}
            </h3>
            <div v-if="commandProposal.kind === 'workspace_edits'" class="flex flex-col gap-2">
              <p class="text-sm">{{ commandProposal.summary }}</p>
              <UiScrollArea viewport-class="max-h-64" content-class="flex flex-col gap-2">
                <div
                  v-for="({ edit }, index) in commandProposal.edits"
                  :key="index"
                  class="flex flex-col gap-1 rounded-md bg-raised px-3 py-2 text-xs"
                >
                  <strong>{{
                    'recordId' in edit
                      ? store.records.find((item) => item.id === edit.recordId)?.title ||
                        edit.recordId
                      : edit.kind === 'delete_category'
                        ? store.app?.categories.find((item) => item.id === edit.categoryId)?.name
                        : edit.kind === 'structure'
                          ? edit.project?.name || edit.area?.name
                          : edit.kind === 'work_item'
                            ? store.app?.workItems.find((item) => item.id === edit.workItemId)
                                ?.title
                            : edit.kind === 'create_work_item'
                              ? edit.task.title
                              : store.app?.projects.find((item) => item.id === edit.projectId)?.name
                  }}</strong>
                  <span class="whitespace-pre-wrap break-words">{{
                    workspaceEditLabel(edit)
                  }}</span>
                  <span v-if="edit.kind === 'membership'"
                    >{{
                      store.app?.projects.find((item) => item.id === edit.projectId)?.name ||
                      'Inbox'
                    }}
                    /
                    {{
                      store.app?.categories.find((item) => item.id === edit.categoryId)?.name ||
                      'Uncategorized'
                    }}</span
                  >
                </div>
              </UiScrollArea>
            </div>
            <p
              v-if="commandProposal.kind === 'inspect' || commandProposal.kind === 'assign'"
              class="text-xs text-muted"
            >
              {{ commandProposal.recordIds.length }} specific occurrences ·
              {{
                commandProposal.kind === 'inspect'
                  ? 'Inspection may temporarily wake one suspended page at a time, with page access approval.'
                  : 'The correction is remembered; no browser movement.'
              }}
            </p>
            <p v-if="commandProposal.kind === 'snapshot'" class="text-xs text-muted">
              {{ commandProposal.label }}
            </p>
            <p v-if="commandProposal.kind === 'assign'" class="text-xs text-muted">
              {{ commandContextLabel }}
            </p>
            <p
              v-if="commandProposal.kind === 'undo' || commandProposal.kind === 'restore'"
              class="text-xs leading-5 text-muted"
            >
              Recovery restores saved arrangement. Unrelated/later tabs remain; protected and
              active-inspection targets are retained. Snapshot Restore can affect later arrangement
              edits; operation Undo targets its original occurrences.
            </p>
            <UiCollapsible
              v-if="commandProposal.kind === 'inspect' || commandProposal.kind === 'assign'"
              class="text-xs text-muted"
              ><template #label>Affected tabs</template>
              <div class="flex flex-col gap-1 pt-2">
                <span v-for="id in commandProposal.recordIds" :key="id" class="truncate">{{
                  store.records.find((record) => record.id === id)?.title || 'Tab no longer open'
                }}</span>
              </div>
            </UiCollapsible>
            <AssistantApprovalControls
              :artifact="{ kind: 'command', command: commandProposal }"
              :disabled="busy"
              @approve="approveArtifact('command', $event)"
              @review="reviewArtifact('command')"
              @deny="dismissArtifact('command')"
            />
          </section>
          <section
            v-if="collectionProposalId"
            class="flex flex-col gap-2 border-t border-line pt-4"
          >
            <h3 class="text-sm font-medium">
              AI organization ·
              {{
                store.app?.collectionProposals.find(
                  (proposal) => proposal.id === collectionProposalId,
                )?.status || 'saved'
              }}
            </h3>
            <UiButton
              class="w-fit"
              size="small"
              @click="
                store.projectSection = 'drafts';
                store.show('projects');
              "
              >Review organization in Projects<ArrowUpRight class="size-3"
            /></UiButton>
            <AssistantApprovalControls
              v-if="collectionArtifact"
              :artifact="collectionArtifact"
              :disabled="busy"
              @approve="approveArtifact('collection', $event)"
              @review="reviewArtifact('collection')"
              @deny="dismissArtifact('collection')"
            />
          </section>
          <section v-if="store.pendingPlan" class="flex flex-col gap-3 border-t border-line pt-4">
            <h3 class="text-sm font-medium">Review AI tab actions</h3>
            <p class="text-xs leading-5 text-muted">
              {{ store.pendingPlan.actions.length }} actions proposed. Apply rechecks each
              occurrence; browser changes are snapshotted and journaled.
            </p>
            <div
              v-for="(action, index) in store.pendingPlan.actions"
              :key="index"
              class="flex flex-col gap-2 border-b border-line py-2"
            >
              <div class="flex items-center gap-2">
                <UiCheckbox
                  :model-value="checked.has(index)"
                  :label="`Select ${action.name || action.type}`"
                  @update:model-value="toggle(index)"
                /><span class="min-w-0 flex-1 text-xs font-medium"
                  >{{ action.type }}{{ action.name ? ` · ${action.name}` : '' }}</span
                ><span class="text-xs text-muted">{{ action.recordIds.length }} tabs</span>
              </div>
              <p class="text-xs leading-5 text-muted">{{ action.reason }}</p>
              <UiCollapsible class="text-xs text-muted"
                ><template #label>Affected tabs</template>
                <div class="flex flex-col gap-1 pt-2">
                  <UiButton
                    v-for="id in action.recordIds"
                    :key="id"
                    variant="ghost"
                    class="justify-start truncate"
                    @click="store.run(() => rpc('focus', { id }))"
                    >{{
                      store.records.find((record) => record.id === id)?.title ||
                      'Tab no longer open'
                    }}</UiButton
                  >
                </div>
              </UiCollapsible>
            </div>
            <AssistantApprovalControls
              :artifact="selectedPlanArtifact || { kind: 'plan', plan: store.pendingPlan }"
              :disabled="busy"
              :approve-disabled="!selectedPlanArtifact"
              @approve="approveArtifact('plan', $event)"
              @review="reviewArtifact('plan')"
              @deny="dismissArtifact('plan')"
            />
            <div v-if="store.pendingPlan.matchIds?.length" class="flex flex-col gap-1">
              <UiButton
                v-for="id in store.pendingPlan.matchIds"
                :key="id"
                variant="ghost"
                class="justify-start truncate"
                @click="store.run(() => rpc('focus', { id }))"
                >{{ store.records.find((record) => record.id === id)?.title }}</UiButton
              >
            </div>
          </section>
        </div>
      </UiScrollArea>
      <footer class="relative flex shrink-0 flex-col items-center gap-2 px-3 pb-3 pt-2 sm:px-4">
        <UiButton
          v-if="!followLatest && conversation.length"
          size="small"
          variant="secondary"
          class="absolute bottom-full left-1/2 -translate-x-1/2 rounded-full bg-overlay"
          aria-label="Jump to latest messages"
          @click="scrollLatest"
          ><ArrowDown class="size-3.5" />Latest messages</UiButton
        >
        <div :class="cn('flex w-full min-w-0 flex-col gap-2', expanded && 'max-w-3xl')">
          <UChatPrompt
            v-model="prompt"
            :rows="2"
            :maxrows="8"
            :autofocus="false"
            :disabled="busy || remoteRunning"
            placeholder="Ask about your tabs or describe what you want organized..."
            aria-label="Message to workspace assistant"
            color="neutral"
            variant="naked"
            class="assistant-composer w-full rounded-2xl bg-raised ring-1 ring-line"
            :ui="{
              base: 'text-sm leading-6 px-3 pt-3 pb-2',
              footer: 'flex min-w-0 items-center gap-1 px-2 pb-2',
            }"
            @submit="ask"
            @keydown.ctrl.enter.prevent="ask"
          >
            <template v-if="store.app" #header>
              <div class="flex min-w-0 flex-wrap items-start gap-2">
                <AssistantImages
                  ref="imageAttachments"
                  v-model="images"
                  hide-button
                  :enabled="supportsImageInput(store.app.settings)"
                  :disabled="busy || remoteRunning"
                  @attached="task = 'work'"
                />
                <AssistantAttachments
                  v-model="attachments"
                  class="min-w-0 flex-1"
                  :app="store.app"
                  :disabled="busy || remoteRunning"
                  :trigger-target="attachmentTrigger"
                  :images-enabled="supportsImageInput(store.app.settings)"
                  @images="imageAttachments?.pick()"
                />
              </div>
            </template>
            <template #footer>
              <span ref="attachmentTrigger" class="contents" />
              <UPopover
                v-model:open="toolsOpen"
                :content="{ side: 'top', align: 'start' }"
                :ui="{ content: 'z-50 bg-overlay ring-line-strong' }"
              >
                <UiButton
                  size="small"
                  variant="ghost"
                  class="px-2"
                  aria-label="Tools and scope"
                  :title="`Tools and scope: ${contextProject?.name || 'whole workspace'}`"
                  ><SlidersHorizontal class="size-4" /><span class="hidden sm:inline"
                    >Tools</span
                  ></UiButton
                >
                <template #content>
                  <UiScrollArea
                    class="w-[min(21rem,calc(100vw-2rem))]"
                    viewport-class="max-h-[min(29rem,65dvh)]"
                    content-class="flex flex-col gap-3 p-4"
                  >
                    <h3 class="text-sm font-semibold">Tools and scope</h3>
                    <span class="text-xs text-muted">{{
                      contextProject?.name || 'Whole workspace'
                    }}</span>
                    <p class="text-xs text-muted">
                      Read and organize tabs, tags, projects, drafts and tasks. Attach context to
                      limit the working scope.
                    </p>
                    <UiCollapsible
                      ><template #label>Advanced task modes</template>
                      <label class="field-label"
                        >Mode<UiSelect
                          v-model="task"
                          :options="taskOptions"
                          :disabled="busy"
                          aria-label="Assistant mode"
                      /></label>
                      <ExternalClassificationDialog
                        :initial-scope="
                          scope === 'selected'
                            ? 'selection'
                            : contextProject
                              ? `project:${contextProject.id}`
                              : scope === 'all'
                                ? 'all'
                                : 'selection'
                        "
                        :record-ids="
                          scope === 'selected'
                            ? [...store.selected]
                            : scope === 'visible'
                              ? store.visible.map((record) => record.id)
                              : undefined
                        "
                      />
                    </UiCollapsible>
                    <label v-if="task === 'work'" class="field-label"
                      >Classification
                      <UiSelect
                        v-model="classificationMode"
                        :disabled="busy || remoteRunning"
                        aria-label="Classification model"
                        :options="[
                          { label: 'Configured classifier', value: 'configured' },
                          { label: 'Chat model itself', value: 'chat' },
                        ]"
                      />
                    </label>
                    <label v-if="task !== 'work'" class="field-label"
                      >Working with<UiSelect
                        v-model="scope"
                        :options="scopeOptions"
                        :disabled="busy"
                        aria-label="Working with"
                    /></label>
                    <span v-if="store.selected.size"
                      >{{ store.selected.size }} selected tabs available</span
                    >
                    <UiButton
                      v-if="chat.current && chat.current.projectId !== store.projectFilter"
                      size="small"
                      variant="ghost"
                      class="w-fit"
                      :disabled="busy"
                      @click="moveThread(chat.activeId, store.projectFilter)"
                      >{{
                        store.projectFilter
                          ? 'Use current project context'
                          : 'Move chat to Unassigned'
                      }}</UiButton
                    >
                    <p v-if="task === 'classify'" class="text-xs leading-5">
                      The small or System One model chooses among existing named groups. Workspace
                      conversation uses the large orchestrator for project discovery.
                    </p>
                    <div
                      v-if="task === 'organize' || task === 'work'"
                      class="flex flex-col gap-2 border-t border-line pt-3"
                    >
                      <UiToggle
                        v-model="allowMoves"
                        :disabled="busy || remoteRunning"
                        label="Cross-window move proposals"
                      />
                      <UiToggle
                        v-model="allowSleepWake"
                        :disabled="busy || remoteRunning"
                        label="Sleep/wake proposals"
                      />
                    </div>
                  </UiScrollArea>
                </template>
              </UPopover>
              <UDropdownMenu
                :items="approvalItems"
                :content="{ side: 'top', align: 'start' }"
                :ui="{ content: 'min-w-44', item: 'rounded-md before:rounded-md' }"
              >
                <UiButton
                  size="small"
                  variant="ghost"
                  aria-label="Approvals"
                  title="Action approvals"
                >
                  <LockKeyhole class="size-4" /><span class="hidden sm:inline">{{
                    permissionLabel
                  }}</span>
                </UiButton>
              </UDropdownMenu>
              <ChatModelSettings
                v-if="visible !== false"
                :label="model.replace(/^[^·]+· /, '')"
                :disabled="busy || remoteRunning"
              />
              <div class="flex-1" />
              <UChatPromptSubmit
                :status="busy ? 'streaming' : 'ready'"
                :disabled="remoteRunning || (!busy && !prompt.trim())"
                color="neutral"
                streaming-color="neutral"
                streaming-variant="solid"
                size="sm"
                class="rounded-full"
                :aria-label="busy ? 'Stop generation' : 'Send'"
                :title="busy ? 'Stop generation' : 'Send message'"
                @stop="stopWork"
              />
            </template>
          </UChatPrompt>
          <p class="flex items-center justify-between gap-2 px-1 text-[11px] text-muted">
            <span class="flex items-center gap-1"
              ><LockKeyhole class="size-3 shrink-0" />
              {{
                reviewingPermission
                  ? 'Reviewing action permission'
                  : permissionMode === 'review'
                    ? 'Orchestrator reviews permissions'
                    : permissionMode === 'all'
                      ? 'Approve all'
                      : 'Approval required'
              }}</span
            ><span class="hidden sm:inline">Shift + Enter for a new line</span>
          </p>
        </div>
      </footer>
    </div>
  </aside>
</template>
