import type { AssistantThread, AssistantToolEvent } from './assistant';
export interface AssistantAuditEntry {
  id: string;
  messageId: string;
  sequence: number;
  createdAt: number;
  text?: string;
  event?: AssistantToolEvent;
}
export interface PageContent {
  title: string;
  description: string;
  headings: string[];
  text: string;
  capturedAt: number;
  url: string;
  scroll: number;
  dirty: boolean;
  playing: boolean;
}
export interface TabPreview {
  id: string;
  url: string;
  navigationVersion: number;
  capturedAt: number;
  dataUrl: string;
}
export interface MigrationItem {
  recordId: string;
  tabId: number;
  windowId: number;
  groupId: number;
  url: string;
  wrapper: string;
  title: string;
  status: 'pending' | 'navigating' | 'imported' | 'failed' | 'skipped';
  navigationStartedAt?: number;
  error?: string;
}
export interface SuspenderMigration {
  id: string;
  operationId: string;
  createdAt: number;
  status: 'running' | 'complete' | 'partial' | 'cancelled' | 'interrupted';
  items: MigrationItem[];
}
export interface MigrationProgress {
  id: string;
  operationId: string;
  status: SuspenderMigration['status'];
  total: number;
  processed: number;
  imported: number;
  failed: number;
  skipped: number;
  currentTitle?: string;
}
export interface MigrationReport {
  recognized: number;
  protected: number;
  unsupported: Array<{ tabId: number; title: string; wrapper: string }>;
}
export interface TabRecord {
  nativeNewTab?: true;
  parentRecordId?: string | null;
  openerRecordId?: string | null;
  branchName?: string;
  suspendedFavicon?: string;
  splitViewId?: number;
  sourceRecordId?: string;
  organizationBaseline?: string;
  id: string;
  url: string;
  title: string;
  createdAt: number;
  navigationVersion: number;
  tabId?: number;
  windowId?: number;
  index: number;
  groupId: number;
  pinned: boolean;
  suspended: boolean;
  foreignSuspended: boolean;
  active: boolean;
  audible: boolean;
  muted?: boolean;
  lastAccessed: number;
  lastSeen: number;
  live: boolean;
  wasOpen: boolean;
  projectId: string | null;
  locked: boolean;
  note: string;
  tags: string[];
  scroll: number;
  activations: number;
  focusedMs: number;
  favicon?: string;
  content?: PageContent | null;
}
export interface Provenance {
  author: 'owner' | 'ai';
  model?: string;
  proposalId?: string;
}
export interface Project {
  displayColor?: string | null;
  provenance?: Provenance;
  id: string;
  name: string;
  purpose: string;
  areaId?: string | null;
  updatedAt: number;
  revision: number;
  maintainReviewQueue: boolean;
}
export interface Area {
  provenance?: Provenance;
  id: string;
  name: string;
  description: string;
  createdAt: number;
  updatedAt: number;
}
export interface WorkItem {
  provenance?: Provenance;
  id: string;
  title: string;
  notes: string;
  areaId: string | null;
  projectId: string | null;
  recordId: string | null;
  url: string | null;
  status: 'open' | 'doing' | 'waiting' | 'done';
  priority: 'low' | 'normal' | 'high' | 'urgent';
  dueAt: number | null;
  source: 'owner' | 'tab';
  createdAt: number;
  updatedAt: number;
}
export interface Category {
  displayColor?: string | null;
  provenance?: Provenance;
  id: string;
  projectId: string;
  name: string;
  description: string;
  color?: chrome.tabGroups.TabGroup['color'];
  order: number;
  updatedAt: number;
  revision: number;
}
export interface Membership {
  provenance?: Provenance;
  reason?: string;
  recordId: string;
  projectId: string | null;
  categoryId: string | null;
  source: 'owner' | 'legacy' | 'accepted-ai' | 'unassigned' | 'inherited';
  updatedAt: number;
}
export interface OrganizationProposal {
  tagReview?: import('./tag-analysis').TagReview;
  unresolvedTagSuggestions?: CollectionProposal['unresolvedTagSuggestions'];
  id: string;
  projectId: string;
  projectRevision: number;
  createdAt: number;
  status: 'pending' | 'applied' | 'dismissed' | 'stale';
  summary: string;
  projectSuggestion?: { name: string; purpose: string };
  categories: Array<{ name: string; description: string }>;
  assignments: Array<{
    recordId: string;
    url: string;
    navigationVersion: number;
    categoryName: string;
    reason: string;
    confidence: number;
    suggestedTags?: string[];
  }>;
  unresolvedRecordIds: string[];
  sourceJobId?: string;
}
export interface CollectionProposal {
  excludedRecordIds?: string[];
  name?: string;
  tagReview?: import('./tag-analysis').TagReview;
  decisionContract?: string;
  legacyCategoriesRetained?: boolean;
  unresolvedTagSuggestions?: Array<{
    recordId: string;
    url: string;
    navigationVersion: number;
    suggestedTags: string[];
  }>;
  tagChanges?: Array<{ recordId: string; before: string[]; after: string[] }>;
  copyState?: {
    operationId: string;
    undoStarted?: boolean;
    undoOperationId?: string;
    originalWindowIds: number[];
    windows: Array<{ projectName: string; windowId: number }>;
    entries: Array<{
      sourceRecordId: string;
      recordId: string;
      created: boolean;
      removed?: boolean;
      error?: string;
      finalWindowId?: number;
      finalGroupId?: number;
      finalIndex?: number;
      tree?: { parentRecordId: string | null; branchName: string };
    }>;
  };
  scopeRecordIds?: string[];
  sourceJobIds?: string[];
  updatedAt?: number;
  model?: string;
  beforeMemberships?: Membership[];
  appliedMemberships?: Membership[];
  operationId?: string;
  id: string;
  createdAt: number;
  status: 'pending' | 'applied' | 'dismissed' | 'stale' | 'undone';
  summary: string;
  projects: Array<{
    name: string;
    purpose: string;
    areaName: string | null;
    categories: Array<{ name: string; description: string }>;
  }>;
  assignments: Array<{
    recordId: string;
    url: string;
    navigationVersion: number;
    projectName: string;
    categoryName: string;
    reason: string;
    confidence: number;
    suggestedTags?: string[];
  }>;
  unresolvedRecordIds: string[];
  ownerAssignedRecordIds?: string[];
}
export type CollectionDraft = Pick<
  CollectionProposal,
  'summary' | 'projects' | 'assignments' | 'unresolvedRecordIds' | 'tagReview'
> & {
  name?: string;
  excludedRecordIds?: string[];
  unresolvedTagSuggestions?: CollectionProposal['unresolvedTagSuggestions'];
  decisionContract?: string;
  legacyCategoriesRetained?: boolean;
  ownerAssignedRecordIds?: string[];
  model?: string;
  scopeRecordIds?: string[];
  sourceJobIds?: string[];
};
export interface OrganizationJob {
  fingerprint?: string;
  id: string;
  recordId: string;
  projectId?: string;
  kind?: 'collection';
  url: string;
  navigationVersion: number;
  createdAt: number;
  status: 'queued' | 'running' | 'complete' | 'stale' | 'error';
  attempts: number;
  leaseOwner?: string;
  leaseUntil?: number;
  error?: string;
}
export type OrganizationDraft = Pick<
  OrganizationProposal,
  | 'tagReview'
  | 'projectId'
  | 'projectRevision'
  | 'summary'
  | 'projectSuggestion'
  | 'categories'
  | 'assignments'
  | 'unresolvedRecordIds'
  | 'unresolvedTagSuggestions'
>;
export interface WindowInfo {
  id: number;
  focused: boolean;
  projectId: string | null;
}
export interface SnapshotTab {
  nativeNewTab?: true;
  parentRecordId?: string | null;
  openerRecordId?: string | null;
  branchName?: string;
  suspendedFavicon?: string;
  recordId: string;
  url: string;
  title: string;
  scroll: number;
  index: number;
  groupId: number;
  pinned: boolean;
  muted?: boolean;
  suspended: boolean;
  locked: boolean;
  projectId: string | null;
  note: string;
  tags: string[];
}
export interface SnapshotWindow extends WindowInfo {
  projectName: string;
  groups: Array<{
    id: number;
    title: string;
    color: chrome.tabGroups.TabGroup['color'];
    collapsed: boolean;
  }>;
  tabs: SnapshotTab[];
}
export interface Snapshot {
  id: string;
  createdAt: number;
  label: string;
  automatic: boolean;
  windows: SnapshotWindow[];
}
export interface SnapshotSummary {
  id: string;
  createdAt: number;
  label: string;
  automatic: boolean;
  windowCount: number;
  tabCount: number;
}
export interface SavedSession {
  id: 'current' | 'recovery';
  snapshot: Snapshot;
}
export interface SessionSummary {
  savedAt: number;
  tabCount: number;
  windowCount: number;
  missingTabs: number;
}
export interface UpdateSummary {
  total: number;
  remaining: number;
  interrupted: boolean;
  stage?: 'preparing' | 'ready' | 'restoring' | 'interrupted';
  processed?: number;
  errors?: string[];
}
export type ActionType =
  'group' | 'ungroup' | 'move' | 'moveGroup' | 'reorder' | 'suspend' | 'wake' | 'pin' | 'mute';
export interface PlanAction {
  type: ActionType;
  recordIds: string[];
  windowId?: number;
  nativeGroupId?: number;
  index?: number;
  name?: string;
  color?: chrome.tabGroups.TabGroup['color'];
  reason?: string;
  confidence?: number;
  enabled?: boolean;
}
export interface Plan {
  provenance?: Provenance;
  collectionProposalId?: string;
  summary: string;
  actions: PlanAction[];
  matchIds?: string[];
  expected?: Record<
    string,
    { url: string; navigationVersion: number; windowId?: number; groupId?: number }
  >;
}
export interface Outcome {
  done?: boolean;
  skipped?: string;
}
export interface ActionResult {
  action: PlanAction;
  outcomes?: Outcome[];
  ok: boolean;
  error?: string;
}
export interface Operation {
  tabCommand?: {
    command: 'duplicate' | 'new' | 'close' | 'reload';
    recordId: string;
    created?: {
      metadata?: string;
      tabId: number;
      url: string;
      windowId: number;
      index: number;
      groupId: number;
      pinned: boolean;
      muted: boolean;
      recordId?: string;
    };
  };
  undoState?: Operation['postState'];
  redoOperationId?: string;

  postState?: Record<
    string,
    {
      url: string;
      windowId: number;
      groupId: number;
      index: number;
      pinned: boolean;
      muted: boolean;
      suspended: boolean;
    }
  >;
  queued?: boolean;
  expected?: Plan['expected'];
  activeWake?: { recordId: string; tabId: number; startedAt: number };
  pauseReason?: string;
  kind?: 'collection-copy' | 'session-resume' | 'extension-update';
  provenance?: Provenance;
  collectionProposalId?: string;
  id: string;
  createdAt: number;
  completedAt?: number;
  snapshotId: string;
  summary: string;
  status: 'running' | 'complete' | 'partial' | 'interrupted' | 'undone';
  actions: PlanAction[];
  results: ActionResult[];
}
export interface OperationSummary extends Omit<Operation, 'actions' | 'results'> {
  recoveryAvailable?: boolean;
  canRedo?: boolean;
  actionCount: number;
  affectedOccurrences: number;
  successfulActions: number;
  failedActions: number;
  errors: string[];
}
export interface InspectionItem {
  url?: string;
  navigationVersion?: number;
  id: string;
  status: 'pending' | 'loading' | 'done' | 'error' | 'skipped';
  resuspend?: boolean;
  initialActivations?: number;
  startedAt?: number;
  error?: string;
}
export interface InspectionJob {
  id: string;
  type: 'inspection';
  createdAt: number;
  status: 'queued' | 'running' | 'cancelled' | 'complete';
  items: InspectionItem[];
  cursor: number;
}
export interface Settings {
  imageModel: string;
  imageBase: string;
  tagModelRole: 'small' | 'generative';
  tagVerification: 'none' | 'chat' | 'decision';
  aiStreamResponses: boolean;
  maxConcurrentInference: number;
  aiReasoningEffort: 'server' | 'none' | 'low' | 'medium' | 'high';
  smallReasoningEffort: 'server' | 'none' | 'low' | 'medium' | 'high';
  aiCompletionTokens: number;
  smallCompletionTokens: number;
  aiContextTokens: number;
  smallContextTokens: number;
  decisionContextTokens: number;
  aiTokenField: 'max_tokens' | 'max_completion_tokens';
  smallTokenField: 'max_tokens' | 'max_completion_tokens';
  classificationMinConfidence: number;
  autoSuspend: boolean;
  suspendMinutes: number;
  protectPinned: boolean;
  protectAudio: boolean;
  protectForms: boolean;
  protectGrouped: boolean;
  neverSuspendSites: string;
  pauseSuspensionOffline: boolean;
  wakeOnFocus: boolean;
  restoreScroll: boolean;
  capturePreviews: boolean;
  previewExcludedSites: string;
  discardPlaceholders: boolean;
  autoIndex: boolean;
  textLimit: number;
  snapshotRetention: number;
  backupEnabled: boolean;
  backupHours: number;
  aiProvider: 'lmstudio' | 'bud';
  aiBase: string;
  aiModel: string;
  aiKey: string;
  smallModelBase: string;
  smallModel: string;
  smallModelKey: string;
  useDedicatedDecisionModel: boolean;
  decisionProvider: 'jev' | 'bud';
  decisionBase: string;
  decisionModel: string;
  decisionKey: string;
  googleCalendarClientId: string;
  aiBatchSize: number;
  aiMaxAttempts: number;
  aiEvidenceCharacters: number;
  maintainCollectionReview: boolean;
  reviewProjectWindowsOnly: boolean;
}
export interface CalendarEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  htmlLink: string | null;
}
export interface AppState {
  assistantChanges?: import('./assistant-actions').AssistantChange[];
  assistantApprovalRules?: import('./assistant-actions').ApprovalRule[];
  tagVocabulary?: string[];
  update?: UpdateSummary | null;
  session?: SessionSummary | null;
  migration?: MigrationProgress | null;
  records: TabRecord[];
  projects: Project[];
  areas: Area[];
  workItems: WorkItem[];
  categories: Category[];
  memberships: Membership[];
  proposals: OrganizationProposal[];
  collectionProposals: CollectionProposal[];
  organizationJobs: OrganizationJob[];
  windows: WindowInfo[];
  groups: chrome.tabGroups.TabGroup[];
  snapshots: SnapshotSummary[];
  operations: OperationSummary[];
  jobs: InspectionJob[];
  settings: Settings;
  version: string;
}
export interface CollectionAnalysis {
  tagCommit?: {
    proposalId: string;
    processed: number;
    tagged: number;
    needsReview: number;
    skipped: number;
  };
  tagTarget?: {
    kind?: 'workspace';
    proposalId: string;
    proposalFingerprint: string;
    skippedCount?: number;
  };
  taggingRequested?: boolean;
  skippedTagRecordIds?: string[];
  skippedRecordIds?: string[];
  decisionContract?: string;
  projectChecks?: Array<{
    recordId: string;
    url: string;
    navigationVersion: number;
    projectName: string | null;
    confidence: number;
  }>;
  sourceAnalysisId?: string;
  legacyCategoriesRetained?: boolean;
  taxonomyProgress?: {
    cursor: number;
    sources: CollectionDraft['projects'];
    projects: CollectionDraft['projects'];
  };
  unresolvedTagSuggestions?: CollectionProposal['unresolvedTagSuggestions'];
  id: string;
  createdAt: number;
  updatedAt: number;
  revision: number;
  purpose: 'proposal' | 'scoped' | 'reclassify' | 'project';
  instruction: string;
  reuseAcceptedTaxonomyOnly: boolean;
  scope: Array<{ id: string; url: string; navigationVersion: number }>;
  discoveredIds: string[];
  classifiedIds: string[];
  projects: CollectionDraft['projects'];
  tagVocabulary?: string[];
  tagChecks?: Array<{ recordId: string; tag: string; selected: boolean; confidence: number }>;
  projectSuggestion?: OrganizationDraft['projectSuggestion'];
  summaries: string[];
  assignments: CollectionDraft['assignments'];
  unresolvedRecordIds: string[];
  failedBatch?: {
    stage: 'discovery' | 'classification' | 'tagging';
    recordIds: string[];
    attempts: number;
    error: string;
    failedAt: number;
  };
}
export interface ActionAnalysis {
  decisionContract?: string;
  sourceAnalysisId?: string;
  id: string;
  createdAt: number;
  updatedAt: number;
  revision: number;
  status: 'pending' | 'complete';
  instruction: string;
  mode: 'generative' | 'decision';
  readOnly: boolean;
  allowCrossWindowMove: boolean;
  allowSleepWake: boolean;
  scope: Array<{
    id: string;
    url: string;
    navigationVersion: number;
    windowId: number;
    groupId: number;
  }>;
  completedIds: string[];
  actions: PlanAction[];
  matchIds: string[];
  summaries: Array<{ recordIds: string[]; text: string; model: string }>;
  failedBatch?: { recordIds: string[]; attempts: number; error: string; failedAt: number };
}
export interface Bindings {
  pendingTabs?: Record<
    number,
    {
      recordId: string;
      projectId: string | null;
      categoryId: string | null;
      parentRecordId?: string | null;
    }
  >;
  tabs: Record<number, string>;
  windows: Record<number, string>;
}
export interface RestoreResult {
  recordId?: string;
  sourceRecordId?: string;
  title?: string;
  ok: boolean;
  error?: string;
}
export interface Backup {
  assistant?: unknown;
  format: 'tabloom';
  schema: 1 | 2 | 3 | 4 | 5 | 6;
  exportedAt: number;
  projects: Project[];
  areas?: Area[];
  workItems?: WorkItem[];
  categories?: Category[];
  memberships?: Membership[];
  snapshots: Snapshot[];
  records?: Omit<TabRecord, 'content'>[];
  operations?: Operation[];
}
export interface DatabaseEntities {
  assistantThreadSummaries: Omit<AssistantThread, 'messages'>;
  proposalRevisions: ProposalRevision;
  permissionReviews: import('./permission-review').PermissionReview;
  assistantChanges: import('./assistant-actions').AssistantChange;
  tagAnalyses: import('./tag-analysis').TagAnalysis;
  inferenceReceipts: import('./inference-receipt').InferenceReceipt;
  assistantAudit: AssistantAuditEntry;
  actionAnalyses: ActionAnalysis;
  collectionAnalyses: CollectionAnalysis;
  sessions: SavedSession;
  previews: TabPreview;
  migrations: SuspenderMigration;
  assistantThreads: AssistantThread;
  records: TabRecord;
  projects: Project;
  areas: Area;
  workItems: WorkItem;
  categories: Category;
  memberships: Membership;
  proposals: OrganizationProposal;
  collectionProposals: CollectionProposal;
  organizationJobs: OrganizationJob;
  snapshots: Snapshot;
  operations: Operation;
  jobs: InspectionJob;
}
export type StoreName = keyof DatabaseEntities;
export interface ProposalRevision {
  id: string;
  proposalId: string;
  createdAt: number;
  label: string;
  before: CollectionProposal;
  after: CollectionProposal;
  status: 'saved' | 'undone';
}
export type ProposalRevisionSummary = Omit<ProposalRevision, 'before' | 'after'> & {
  canUndo: boolean;
  canRedo: boolean;
};
export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

declare global {
  var __tabloomReader: ((limit: number) => PageContent) | undefined;
}
