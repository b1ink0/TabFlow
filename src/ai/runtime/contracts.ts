import { type AssistantImage } from '../../shared/assistant/assistant-images';

import type { TagStorage } from '../../shared/organization/tag-analysis';

import type { ReceiptWriter } from '../../shared/inference/inference-receipt';

import type { AssistantAttachment } from '../../shared/assistant/assistant-context';

import type {
  AssistantCommand,
  AssistantToolEvent,
  AssistantMessage,
} from '../../shared/assistant/assistant';
import { type AssistantProjectDraft, type AssistantSource } from '../../shared/assistant/assistant';

import type {
  AppState,
  CollectionDraft,
  CollectionAnalysis,
  CollectionProposal,
  Plan,
} from '../../shared/types';
import type { GenerationOptions, WorkItemDraft } from '../workflows/contracts';
export type ConversationHistory = Array<{
  role: 'user' | 'assistant';
  content: string;
  images?: AssistantImage[];
}>;
export type ConversationOptions = {
  images?: AssistantImage[];
  onCollectionDraft?: (
    draft: CollectionDraft,
    existingProposalId?: string,
    expectedFingerprint?: string,
  ) => Promise<CollectionProposal | void>;
  onReadCollectionProposal?: (id: string) => Promise<CollectionProposal | undefined>;
  onTagAnalysisAccess?: () => Promise<void>;
  onCollectionTags?: (
    input: import('../../shared/rpc').RpcMap['updateCollectionTags']['payload'],
  ) => Promise<CollectionProposal>;
  onCollectionMerge?: (
    input: import('../../shared/rpc').RpcMap['mergeCollectionProposals']['payload'],
  ) => Promise<import('../../shared/rpc').RpcMap['mergeCollectionProposals']['response']>;
  onProgress?: (message: string) => void;
  onText?: (text: string) => void;
  onReasoning?: (text: string, streaming: boolean) => void;
  onToolEvent?: (event: AssistantToolEvent) => Promise<void>;
  onCheckpoint?: (state: {
    sources: AssistantSource[];
    activity: string[];
    taskDraft?: WorkItemDraft;
    projectDraft?: AssistantProjectDraft;
    commandDraft?: AssistantCommand;
    plan?: Plan;
  }) => Promise<void>;
  context?: {
    projectId: string | null;
    selectedRecordIds: string[];
    attachments?: AssistantAttachment[];
    scopeRecordIds?: string[];
    classificationMode?: 'configured' | 'chat';
  };
  attachmentHistory?: Array<{
    messageId: string;
    attachments: AssistantAttachment[];
    recordIds: string[];
  }>;
  allowCrossWindowMove?: boolean;
  allowSleepWake?: boolean;
  activeCollectionProposalId?: string;
  onProposalHistory?: (
    proposalId: string,
    offset: number,
  ) => Promise<import('../../shared/types').ProposalRevisionSummary[]>;
  onReadAssistantHistory?: (
    offset: number,
  ) => Promise<import('../../shared/assistant/assistant-actions').AssistantChange[]>;
  onRestoreProposalRevision?: (
    input: import('../../shared/rpc').RpcMap['restoreProposalRevision']['payload'],
  ) => Promise<CollectionProposal>;
  collectionCheckpoint?: {
    tags?: TagStorage;
    id: string;
    receipt?: ReceiptWriter;
    load: () => Promise<CollectionAnalysis | undefined>;
    save: (analysis: CollectionAnalysis) => Promise<CollectionAnalysis>;
    rebase?: () => Promise<CollectionAnalysis>;
    refreshApp?: () => Promise<AppState>;
    clear: () => Promise<void>;
  };
  actionCheckpoint?: GenerationOptions['actionCheckpoint'];
  resume?: AssistantMessage;
};
export type ConversationResult = {
  answer: string;
  proposal?: WorkItemDraft;
  projectProposal?: AssistantProjectDraft;
  plan?: Plan;
  command?: AssistantCommand;
  sources: AssistantSource[];
  activity: string[];
  collectionPrepared: boolean;
  collectionApplyRequested?: boolean;
  collectionApplicationId?: string;
};
export interface AgentRuntime {
  readonly id: string;
  answer(
    app: AppState,
    question: string,
    conversation?: ConversationHistory,
    signal?: AbortSignal,
    options?: ConversationOptions,
  ): Promise<ConversationResult>;
}
