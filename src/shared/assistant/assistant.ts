import { z } from 'zod';
import { assistantImagesSchema } from './assistant-images';
import { planSchema } from '../model';
import { attachmentSchema } from './assistant-context';
import { workspaceEditDraftSchema, workDraftFields } from '../workspace/workspace-edits';

export const assistantSourceSchema = z.object({
  recordId: z.string(),
  title: z.string(),
  url: z.string(),
  windowId: z.number().optional(),
  group: z.string().optional(),
  project: z.string().optional(),
  capturedAt: z.number().nullable(),
});
export const assistantProjectSchema = z.object({
  name: z.string().trim().min(1).max(80),
  purpose: z.string().max(1000),
  areaId: z.string().nullable(),
});
export const assistantTaskSchema = z.object({
  ...workDraftFields,
  title: z.string().trim().min(1).max(240),
  notes: z.string().max(1000),
  areaId: z.string().nullable(),
  projectId: z.string().nullable(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']),
});
const occurrenceScope = z.object({
  recordIds: z.array(z.string()).min(1).max(1000),
  expected: z.record(z.string(), z.object({ url: z.string(), navigationVersion: z.number() })),
});
export const assistantCommandSchema = z.discriminatedUnion('kind', [
  workspaceEditDraftSchema,
  occurrenceScope.extend({ kind: z.literal('inspect') }),
  occurrenceScope.extend({
    kind: z.literal('assign'),
    projectId: z.string(),
    categoryId: z.string().nullable(),
  }),
  z.object({ kind: z.literal('snapshot'), label: z.string().min(1).max(200) }),
  z.object({ kind: z.literal('undo'), operationId: z.string() }),
  z.object({ kind: z.literal('redo'), operationId: z.string() }),
  z.object({ kind: z.literal('redo_assistant'), changeId: z.string() }),
  z.object({ kind: z.literal('undo_assistant'), changeId: z.string() }),
  z.object({ kind: z.literal('restore'), snapshotId: z.string() }),
]);
export type AssistantCommand = z.infer<typeof assistantCommandSchema>;
export const assistantToolEventSchema = z.object({
  id: z.string(),
  tool: z.string().max(160),
  phase: z.enum(['requested', 'returned']),
  summary: z.string().max(1000),
  details: z.string().max(100000).optional(),
  truncated: z.boolean().optional(),
  createdAt: z.number(),
});
export type AssistantToolEvent = z.infer<typeof assistantToolEventSchema>;
export const assistantRequestSchema = z.object({
  images: assistantImagesSchema.optional(),
  attachments: z.array(attachmentSchema).max(100).optional(),
  restrictToScope: z.boolean().optional(),
  classificationMode: z.enum(['configured', 'chat']).optional(),
  task: z.enum(['work', 'ask', 'organize', 'classify']),
  recordIds: z.array(z.string()).max(10000),
  projectId: z.string().nullable(),
  selectedRecordIds: z.array(z.string()).max(10000),
  allowCrossWindowMove: z.boolean(),
  allowSleepWake: z.boolean(),
});
export type AssistantRequest = z.infer<typeof assistantRequestSchema>;
export const assistantMessageSchema = z.object({
  parentMessageId: z.string().nullable().optional(),
  permissionReviewIds: z.array(z.string()).max(100).optional(),
  permissionReviewUpdatedAt: z.number().optional(),
  assistantChangeIds: z.array(z.string()).max(20).optional(),
  id: z.string(),
  role: z.enum(['user', 'assistant']),
  completedAt: z.number().optional(),
  content: z.string().max(100000),
  createdAt: z.number(),
  request: assistantRequestSchema.optional(),
  requestMessageId: z.string().optional(),
  retryOfMessageId: z.string().optional(),
  deliveryStatus: z.enum(['generating', 'complete', 'interrupted', 'error']).optional(),
  toolEvents: z.array(assistantToolEventSchema).max(100).default([]),
  sources: z.array(assistantSourceSchema).max(1000).default([]),
  activity: z.array(z.string().max(1000)).max(100).default([]),
  taskDraft: assistantTaskSchema.optional(),
  projectDraft: assistantProjectSchema.optional(),
  plan: planSchema.optional(),
  collectionProposalId: z.string().optional(),
  collectionApplyRequested: z.boolean().optional(),
  collectionAnalysisId: z.string().optional(),
  actionAnalysisId: z.string().optional(),
  analysisFailure: z
    .object({
      stage: z.enum(['discovery', 'classification', 'tagging']),
      completed: z.number().int().min(0),
      total: z.number().int().min(1),
      batchCount: z.number().int().min(1),
      attempts: z.number().int().min(1),
    })
    .optional(),
  commandDraft: assistantCommandSchema.optional(),
  outcome: z.string().max(2000).optional(),
  completedArtifacts: z
    .array(z.enum(['task', 'project', 'plan', 'command', 'collection']))
    .max(5)
    .default([]),
  createdProjectId: z.string().optional(),
});
export const assistantThreadSchema = z.object({
  selectedLeafId: z.string().optional(),
  id: z.string(),
  title: z.string().max(160),
  createdAt: z.number(),
  updatedAt: z.number(),
  projectId: z.string().nullable(),
  status: z.enum(['ready', 'running', 'interrupted', 'error']),
  messages: z.array(assistantMessageSchema),
});
export type AssistantSource = z.infer<typeof assistantSourceSchema>;
export type AssistantProjectDraft = z.infer<typeof assistantProjectSchema>;
export type AssistantMessage = z.infer<typeof assistantMessageSchema>;
export type AssistantThread = z.infer<typeof assistantThreadSchema>;
