import type {
  AppState,
  CollectionProposal,
  CollectionAnalysis,
  ActionAnalysis,
  CollectionDraft,
  Backup,
  Area,
  InspectionJob,
  OrganizationDraft,
  OrganizationJob,
  OrganizationProposal,
  Operation,
  Plan,
  Project,
  Provenance,
  RestoreResult,
  Settings,
  TabRecord,
  WorkItem,
  Snapshot,
  TabPreview,
  MigrationReport,
  MigrationProgress,
  SuspenderMigration,
  SessionSummary,
} from './types';
export interface RpcMap {
  deleteLocalData: {
    payload: {
      kind: 'cache' | 'analysis' | 'history' | 'organization' | 'all';
      confirmation: string;
    };
    response: void;
  };
  backupExportStart: { payload: undefined; response: { id: string; length: number } };
  backupExportRead: {
    payload: { id: string; offset: number };
    response: { text: string; nextOffset: number | null };
  };
  backupTransferRelease: { payload: { id: string }; response: void };
  backupImportStart: { payload: { length: number }; response: { id: string } };
  backupImportWrite: {
    payload: { id: string; offset: number; text: string };
    response: { nextOffset: number };
  };
  backupImportCommit: {
    payload: { id: string };
    response: { imported: number; assistantImported?: boolean };
  };
  listProposalRevisions: {
    payload: { proposalId: string; offset: number };
    response: import('./types').ProposalRevisionSummary[];
  };
  restoreProposalRevision: {
    payload: { id: string; direction: 'undo' | 'redo'; expectedFingerprint: string };
    response: CollectionProposal;
  };
  permissionPolicy: {
    payload: { threadId: string };
    response: import('./assistant/permission-review').PermissionPolicy;
  };
  setPermissionPolicy: {
    payload: { threadId: string; mode: 'ask' | 'review' | 'all' };
    response: import('./assistant/permission-review').PermissionPolicy;
  };
  preparePermissionReview: {
    payload: {
      threadId: string;
      messageId: string;
      artifact: import('./assistant/assistant-actions').AssistantArtifact;
      oneOff: boolean;
    };
    response: import('./assistant/permission-review').PermissionReviewSummary;
  };
  resolvePermissionReview: {
    payload: { id: string };
    response: import('./assistant/permission-review').PermissionReviewSummary;
  };
  listPermissionReviews: {
    payload: { messageId: string };
    response: import('./assistant/permission-review').PermissionReviewSummary[];
  };
  permissionReviewDetails: {
    payload: { id: string };
    response: import('./assistant/permission-review').PermissionReview | undefined;
  };

  tabCommand: {
    payload: {
      id: string;
      command: 'duplicate' | 'new' | 'close' | 'reload';
      expected: { url: string; navigationVersion: number };
    };
    response: Operation;
  };
  redo: { payload: { id: string }; response: Operation };
  redoAssistantChange: {
    payload: { id: string };
    response: import('./assistant/assistant-actions').AssistantChange;
  };

  executeAssistantAction: {
    payload: import('./assistant/assistant-actions').AssistantExecution;
    response: import('./assistant/assistant-actions').AssistantChange;
  };
  denyAssistantAction: {
    payload: import('./assistant/assistant-actions').AssistantExecution;
    response: import('./assistant/assistant-actions').AssistantChange;
  };
  undoAssistantChange: {
    payload: { id: string };
    response: import('./assistant/assistant-actions').AssistantChange;
  };
  assistantChangeDetails: {
    payload: { id: string };
    response: import('./assistant/assistant-actions').AssistantChange | undefined;
  };
  listAssistantChanges: {
    payload: { messageId?: string; offset: number };
    response: import('./assistant/assistant-actions').AssistantChange[];
  };
  revokeAssistantApprovals: { payload: { threadId?: string }; response: void };
  executeWorkspaceEdit: {
    payload: import('./workspace/workspace-edits').WorkspaceEditDraft;
    response: import('./assistant/assistant-actions').AssistantChange;
  };
  applyWorkspaceEdits: {
    payload: import('./workspace/workspace-edits').WorkspaceEditDraft;
    response: void;
  };
  listTagAnalyses: {
    payload: { analysisId: string };
    response: import('./organization/tag-analysis').TagAnalysis[];
  };
  saveTagAnalysis: { payload: import('./organization/tag-analysis').TagAnalysis; response: void };
  saveInferenceReceipt: {
    payload: import('./inference/inference-receipt').InferenceReceipt;
    response: void;
  };
  getActionAnalysis: { payload: { id: string }; response: ActionAnalysis | undefined };
  listActionAnalyses: { payload: undefined; response: ActionAnalysis[] };
  saveActionAnalysis: { payload: ActionAnalysis; response: ActionAnalysis };
  repairActionAnalysis: { payload: { id: string }; response: ActionAnalysis };
  rebaseActionAnalysis: { payload: { id: string }; response: ActionAnalysis };
  getCollectionAnalysis: { payload: { id: string }; response: CollectionAnalysis | undefined };
  saveCollectionAnalysis: { payload: CollectionAnalysis; response: CollectionAnalysis };
  rebaseCollectionAnalysis: { payload: { id: string }; response: CollectionAnalysis };
  clearCollectionAnalysis: { payload: { id: string }; response: void };
  repairCollectionAnalysis: {
    payload: { id: string; stage: 'discovery' | 'classification' | 'tagging' | 'skipped' };
    response: CollectionAnalysis;
  };
  repairCollectionProposal: {
    payload: { id: string; stage?: 'classification' | 'tagging' };
    response: CollectionAnalysis;
  };
  openDashboard: { payload: { view: string }; response: void };
  openBrowserAppearance: { payload: undefined; response: void };
  state: { payload: undefined; response: AppState };
  saveSession: { payload: { replaceMissing?: boolean } | undefined; response: SessionSummary };
  resumeSession: { payload: undefined; response: RestoreResult[] };
  reloadSafely: { payload: undefined; response: void };
  finishUpdate: { payload: undefined; response: void };
  operationDetails: { payload: { id: string }; response: Operation | undefined };
  settings: { payload: Settings; response: Settings };
  snapshot: { payload: { label: string }; response: Snapshot };
  apply: { payload: Plan; response: Operation };
  controlWakeOperation: { payload: { id: string; resume: boolean }; response: Operation };
  restore: { payload: { id: string; newWindows?: boolean }; response: RestoreResult[] };
  undo: { payload: { id: string }; response: RestoreResult[] };
  project: {
    payload: {
      name: string;
      displayColor?: string | null;
      purpose?: string;
      maintainReviewQueue?: boolean;
      areaId?: string | null;
      id?: string;
      windowId?: number;
      provenance?: Provenance;
    };
    response: Project;
  };
  area: { payload: { id?: string; name: string; description?: string }; response: Area };
  workItem: {
    payload: Partial<WorkItem> & Pick<WorkItem, 'title'>;
    response: WorkItem;
  };
  category: {
    payload: {
      id?: string;
      projectId: string;
      name: string;
      displayColor?: string | null;
      description?: string;
      color?: chrome.tabGroups.TabGroup['color'];
    };
    response: import('./types').Category;
  };
  assignMembership: {
    payload: {
      recordIds: string[];
      projectId: string | null;
      categoryId: string | null;
      expected?: Plan['expected'];
    };
    response: void;
  };
  proposeOrganization: {
    payload: OrganizationDraft & { sourceJobId?: string };
    response: OrganizationProposal;
  };
  proposeCollection: { payload: CollectionDraft; response: CollectionProposal };
  getCollectionProposal: { payload: { id: string }; response: CollectionProposal | undefined };
  updateCollectionDraft: {
    payload: { id: string; draft: CollectionDraft; expectedFingerprint?: string };
    response: CollectionProposal;
  };
  rebaseCollectionDraft: {
    payload: { id: string; draft?: CollectionDraft; expectedFingerprint?: string };
    response: CollectionProposal;
  };
  extendCollectionDraft: {
    payload: { id: string; draft: CollectionDraft; expectedFingerprint?: string };
    response: CollectionProposal;
  };
  mergeCollectionProposals: {
    payload: {
      targetProposalId: string;
      sourceProposalId: string;
      targetFingerprint: string;
      sourceFingerprint: string;
      projectNames: string[];
      assignmentConflict: 'keep_target' | 'use_source';
    };
    response: { proposal: CollectionProposal; conflicts: number };
  };
  updateCollectionTags: {
    payload: {
      analysisId?: string;
      id: string;
      expectedFingerprint: string;
      patches: Array<{
        recordId: string;
        url: string;
        navigationVersion: number;
        suggestedTags: string[];
        review: Array<{ name: string; outcome: 'new' | 'uncertain' }>;
      }>;
    };
    response: CollectionProposal;
  };
  applyCollection: { payload: { id: string }; response: CollectionProposal };
  organizeCollection: {
    payload: { id: string };
    response: { proposal: CollectionProposal; operation?: Operation };
  };
  undoCollection: {
    payload: { id: string };
    response: { restored: number; skipped: number; outcomes: RestoreResult[] };
  };
  dismissCollection: { payload: { id: string }; response: void };
  reviewOrganizationTag: {
    payload: { id: string; recordId: string; name: string; include: boolean };
    response: OrganizationProposal;
  };
  applyOrganization: {
    payload: { id: string; projectName: boolean; projectPurpose: boolean };
    response: OrganizationProposal;
  };
  dismissOrganization: { payload: { id: string }; response: void };
  queueOrganizationTab: { payload: { tabId: number }; response: OrganizationJob | undefined };
  claimOrganizationJob: {
    payload: { runnerId: string };
    response: { job: OrganizationJob; project: Project; record: TabRecord } | undefined;
  };
  claimCollectionJobs: { payload: { runnerId: string }; response: OrganizationJob[] };
  renewCollectionJobs: { payload: { ids: string[]; runnerId: string }; response: void };
  finishOrganizationJob: {
    payload: { id: string; status: 'complete' | 'error'; error?: string; runnerId?: string };
    response: OrganizationJob;
  };
  retryOrganizationJob: { payload: { id: string }; response: OrganizationJob };
  bindProject: { payload: { windowId: number; projectId: string | null }; response: void };
  createWindow: { payload: { projectId?: string }; response: chrome.windows.Window };
  record: {
    payload: { id: string; patch: Partial<Pick<TabRecord, 'locked' | 'note' | 'tags'>> };
    response: TabRecord;
  };
  export: { payload: undefined; response: Backup };
  import: { payload: unknown; response: { imported: number; assistantImported?: boolean } };
  migrate: { payload: undefined; response: MigrationProgress };
  migrationReport: { payload: undefined; response: MigrationReport };
  migrationDetails: { payload: { id: string }; response: SuspenderMigration | undefined };
  cancelMigration: { payload: { id: string }; response: MigrationProgress };
  retryMigration: { payload: { id: string }; response: MigrationProgress };
  clearPreviews: { payload: undefined; response: void };
  inspect: { payload: { ids: string[]; expected?: Plan['expected'] }; response: InspectionJob };
  cancel: { payload: { id: string }; response: InspectionJob | undefined };
  tick: { payload: undefined; response: void };
  focus: { payload: { id: string }; response: void };
  groupUpdate: { payload: { id: number; collapsed: boolean }; response: chrome.tabGroups.TabGroup };
  placeholder: { payload: undefined; response: void };
  placeholderFavicon: { payload: { data?: string } | undefined; response: string | null };
  placeholderPreview: { payload: undefined; response: TabPreview | null };
  wakePlaceholder: { payload: undefined; response: unknown };
}
export type RpcRequest = {
  [K in keyof RpcMap]: { type: K; payload: RpcMap[K]['payload'] };
}[keyof RpcMap];
export type RpcResponse<T> = { ok: true; value: T } | { ok: false; error: string };
export async function rpc<K extends keyof RpcMap>(
  type: K,
  payload: RpcMap[K]['payload'],
): Promise<RpcMap[K]['response']> {
  const response = (await chrome.runtime.sendMessage({ type, payload })) as
    RpcResponse<RpcMap[K]['response']> | undefined;
  if (!response?.ok)
    throw new Error(response?.error || 'Extension worker did not respond. Reload the extension.');
  return response.value;
}
