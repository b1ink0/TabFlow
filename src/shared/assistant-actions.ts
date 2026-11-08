import { z } from 'zod';
import { assistantCommandSchema, assistantProjectSchema, assistantTaskSchema } from './assistant';
import { planSchema } from './model';
import type { Operation } from './types';

export const assistantArtifactSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('command'), command: assistantCommandSchema }),
  z.object({ kind: z.literal('plan'), plan: planSchema }),
  z.object({ kind: z.literal('project'), project: assistantProjectSchema }),
  z.object({ kind: z.literal('task'), task: assistantTaskSchema }),
  z.object({
    kind: z.literal('collection'),
    proposalId: z.string(),
    proposalFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  }),
]);
export type AssistantArtifact = z.infer<typeof assistantArtifactSchema>;
export const capabilitySchema = z.enum([
  'tab-tree',
  'tags',
  'notes',
  'assignments',
  'projects',
  'categories',
  'work',
  'grouping',
  'moving',
  'loading',
  'tab-state',
  'inspection',
  'snapshots',
  'recovery',
  'organization',
]);
export type AssistantCapability = z.infer<typeof capabilitySchema>;
export const capabilityLabels: Record<AssistantCapability, string> = {
  'tab-tree': 'Tab branches',
  tags: 'Tags',
  notes: 'Notes',
  assignments: 'Project assignments',
  projects: 'Projects',
  categories: 'Categories',
  work: 'Work items',
  grouping: 'Tab groups and ordering',
  moving: 'Moving tabs',
  loading: 'Sleep/wake tabs',
  'tab-state': 'Pinning and muting',
  inspection: 'Page inspection',
  snapshots: 'Snapshots',
  recovery: 'Recovery',
  organization: 'Organization proposals',
};
export const approvalRuleSchema = z.object({
  capability: capabilitySchema,
  threadId: z.string().nullable(),
});
export type ApprovalRule = z.infer<typeof approvalRuleSchema>;
export const approvalModeSchema = z.enum(['once', 'chat', 'always', 'automatic', 'reviewed']);
export type ApprovalMode = z.infer<typeof approvalModeSchema>;
export const assistantExecutionSchema = z.object({
  messageId: z.string().min(1),
  threadId: z.string().min(1),
  mode: approvalModeSchema,
  artifact: assistantArtifactSchema,
  permissionReviewId: z.string().optional(),
  permissionPolicyRevision: z.number().int().nonnegative().optional(),
});
export type AssistantExecution = z.infer<typeof assistantExecutionSchema>;
export const metadataDeltaSchema = z.object({
  table: z.enum(['records', 'memberships', 'projects', 'categories', 'workItems', 'areas']),
  field: z.enum(['entity', 'tags', 'note', 'parentRecordId', 'branchName']),
  id: z.string(),
  url: z.string().optional(),
  navigationVersion: z.number().optional(),
  before: z.string().nullable(),
  after: z.string().nullable(),
});
export type MetadataDelta = z.infer<typeof metadataDeltaSchema>;
export const assistantChangeSchema = z.object({
  recoveryAvailable: z.boolean().optional(),
  source: z.enum(['owner', 'assistant']).optional(),
  archived: z.boolean().optional(),
  id: z.string(),
  threadId: z.string(),
  messageId: z.string(),
  createdAt: z.number(),
  summary: z.string(),
  mode: approvalModeSchema,
  capabilities: z.array(capabilitySchema),
  status: z.enum(['running', 'complete', 'partial', 'failed', 'interrupted', 'undone', 'denied']),
  outcome: z.string(),
  permissionReview: z.object({ id: z.string(), model: z.string(), reason: z.string() }).optional(),
  deltas: z.array(metadataDeltaSchema),
  deltaCount: z.number().optional(),
  operationId: z.string().optional(),
  projectId: z.string().optional(),
  jobId: z.string().optional(),
  proposalId: z.string().optional(),
  snapshotId: z.string().optional(),
  undoResults: z
    .array(z.object({ id: z.string(), restored: z.boolean(), reason: z.string().optional() }))
    .optional(),
});
export type AssistantChange = z.infer<typeof assistantChangeSchema>;
export function currentAssistantTrace(
  trace: AssistantChange,
  operation?: Pick<Operation, 'status' | 'pauseReason'> & { recoveryAvailable?: boolean },
): AssistantChange {
  return operation
    ? {
        ...trace,
        recoveryAvailable: operation.recoveryAvailable,
        status: operation.status,
        outcome: `Browser work ${operation.status}${operation.pauseReason ? `: ${operation.pauseReason}` : ''}`,
      }
    : trace;
}
export function actionCapabilities(action: AssistantArtifact): AssistantCapability[] {
  if (action.kind === 'project') return ['projects'];
  if (action.kind === 'task') return ['work'];
  if (action.kind === 'collection') return ['organization'];
  if (action.kind === 'plan')
    return [
      ...new Set(
        action.plan.actions.map((item): AssistantCapability =>
          item.type === 'wake' || item.type === 'suspend'
            ? 'loading'
            : item.type === 'move' || item.type === 'moveGroup'
              ? 'moving'
              : item.type === 'pin' || item.type === 'mute'
                ? 'tab-state'
                : 'grouping',
        ),
      ),
    ];
  const command = action.command;
  if (command.kind === 'workspace_edits')
    return [
      ...new Set(
        command.edits.flatMap(({ edit }): AssistantCapability | AssistantCapability[] =>
          edit.kind === 'tab_parent' || edit.kind === 'branch_name'
            ? 'tab-tree'
            : edit.kind === 'delete_category' || edit.kind === 'move_category'
              ? ['categories', 'assignments']
              : edit.kind === 'structure'
                ? [
                    'projects',
                    ...(edit.categories.length ? ['categories' as const] : []),
                    ...(edit.recordIds.length ? ['assignments' as const] : []),
                  ]
                : edit.kind === 'tags'
                  ? 'tags'
                  : edit.kind === 'note'
                    ? 'notes'
                    : edit.kind === 'membership'
                      ? 'assignments'
                      : edit.kind === 'project'
                        ? 'projects'
                        : edit.kind === 'category' || edit.kind === 'category_order'
                          ? 'categories'
                          : 'work',
        ),
      ),
    ];
  return [
    command.kind === 'assign'
      ? 'assignments'
      : command.kind === 'inspect'
        ? 'inspection'
        : command.kind === 'snapshot'
          ? 'snapshots'
          : 'recovery',
  ];
}
export function actionAllowed(rules: ApprovalRule[], threadId: string, action: AssistantArtifact) {
  const capabilities = actionCapabilities(action);
  // Recovery and page inspection need the actual review/access interaction every time.
  return (
    capabilities.length > 0 &&
    !capabilities.some((item) => item === 'recovery' || item === 'inspection') &&
    capabilities.every((capability) =>
      rules.some(
        (rule) =>
          rule.capability === capability && (rule.threadId === null || rule.threadId === threadId),
      ),
    )
  );
}
