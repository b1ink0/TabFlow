import { z } from 'zod';
import { validateTabTree } from '../shared/tabs/tab-tree';
import { isNativeNewTabURL } from '../shared/tabs/urls';
import Dexie from 'dexie';
import * as db from './db';
import { assistantThreadSchema } from '../shared/assistant/assistant';
import { assistantChangeSchema } from '../shared/assistant/assistant-actions';
import { collectionAnalysisSchema } from '../shared/organization/collection-analysis';
import { actionAnalysisSchema } from '../shared/workspace/action-analysis';
import {
  collectionDraftSchema,
  newRecord,
  pageURL,
  validateCollectionDraft,
} from '../shared/model';
import { tagAnalysisSchema, tagResultId, tagHash } from '../shared/organization/tag-analysis';
import { inferenceReceiptSchema } from '../shared/inference/inference-receipt';
import type { CollectionProposal } from '../shared/types';

const savedProposal = collectionDraftSchema.extend({
  id: z.string().min(1),
  createdAt: z.number(),
  updatedAt: z.number().optional(),
  status: z.enum(['pending', 'applied', 'undone', 'dismissed']),
});
const record = z
  .object({
    nativeNewTab: z.literal(true).optional(),
    parentRecordId: z.string().nullable().optional(),
    openerRecordId: z.string().nullable().optional(),
    branchName: z.string().max(80).optional(),
    id: z.string(),
    url: z.string(),
    title: z.string().max(10000),
    note: z.string().max(10000),
    tags: z.array(z.string().max(80)),
    navigationVersion: z.number().int().min(0),
    locked: z.boolean(),
  })
  .refine(
    (record) =>
      record.nativeNewTab ? isNativeNewTabURL(record.url) : Boolean(pageURL(record.url)),
    'Only web pages or explicitly marked native new tabs can be imported.',
  );
const revision = z.object({
  id: z.string(),
  proposalId: z.string(),
  createdAt: z.number(),
  label: z.string().max(1000),
  before: savedProposal,
  after: savedProposal,
  status: z.enum(['saved', 'undone']),
});
const audit = z.object({
  id: z.string(),
  messageId: z.string(),
  sequence: z.number().int(),
  createdAt: z.number(),
  text: z.string().optional(),
  event: z
    .object({
      id: z.string(),
      tool: z.string(),
      phase: z.enum(['requested', 'returned']),
      summary: z.string(),
      details: z.string().optional(),
      truncated: z.boolean().optional(),
      createdAt: z.number(),
    })
    .optional(),
});
export const assistantPortableSchema = z.object({
  version: z.literal(1),
  records: z.array(record).max(100000),
  proposals: z.array(savedProposal).max(10000),
  threads: z.array(assistantThreadSchema).max(10000),
  analyses: z.array(collectionAnalysisSchema).max(10000),
  actionAnalyses: z.array(actionAnalysisSchema).max(10000),
  tags: z.array(tagAnalysisSchema).max(100000),
  changes: z.array(assistantChangeSchema).max(100000),
  receipts: z.array(inferenceReceiptSchema).max(100000),
  revisions: z.array(revision).max(100000),
  audit: z.array(audit).max(1000000),
});

export async function exportAssistantState() {
  return assistantPortableSchema.parse({
    version: 1,
    records: await db.all('records'),
    proposals: await db.all('collectionProposals'),
    threads: await db.all('assistantThreads'),
    analyses: await db.all('collectionAnalyses'),
    actionAnalyses: await db.all('actionAnalyses'),
    tags: await db.all('tagAnalyses'),
    changes: await db.all('assistantChanges'),
    receipts: await db.all('inferenceReceipts'),
    revisions: await db.all('proposalRevisions'),
    audit: await db.all('assistantAudit'),
  });
}

/** Import data, never authority or browser-session handles. Restoring tabs remains explicit. */
export async function importAssistantState(
  state: z.infer<typeof assistantPortableSchema>,
  recordMap: Map<string, string>,
  projectMap: Map<string, string>,
  areaMap: Map<string, string>,
  categoryMap: Map<string, string>,
) {
  validateTabTree(state.records);
  const ids = new Map([...projectMap, ...areaMap, ...categoryMap, ...recordMap]);
  for (const row of state.records) {
    if (!ids.has(row.id)) {
      const id = crypto.randomUUID();
      ids.set(row.id, id);
      recordMap.set(row.id, id);
    }
  }
  for (const rows of [
    state.proposals,
    state.threads,
    state.analyses,
    state.actionAnalyses,
    state.changes,
    state.receipts,
    state.revisions,
    state.audit,
  ])
    for (const row of rows) ids.set(row.id, crypto.randomUUID());
  for (const thread of state.threads)
    for (const message of thread.messages) ids.set(message.id, crypto.randomUUID());
  const remap = (value: unknown): unknown => {
    if (typeof value === 'string')
      return (
        ids.get(value) ||
        (value.startsWith('proposal:') && ids.has(value.slice(9))
          ? `proposal:${ids.get(value.slice(9))}`
          : value)
      );
    if (Array.isArray(value)) return value.map(remap);
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, remap(item)]));
    return value;
  };
  for (const row of state.records) {
    const mapped = record.parse(remap(row));
    mapped.parentRecordId = row.parentRecordId ? recordMap.get(row.parentRecordId) || null : null;
    mapped.openerRecordId = row.openerRecordId ? recordMap.get(row.openerRecordId) || null : null;
    await db.put('records', {
      ...newRecord(mapped.url, mapped.id),
      ...mapped,
      live: false,
      tabId: undefined,
      windowId: -1,
      groupId: -1,
    });
  }
  const proposals = new Map<string, CollectionProposal>();
  for (const row of state.proposals) {
    const mapped = savedProposal.parse(remap(row));
    const draft = validateCollectionDraft(
      mapped,
      new Set(
        mapped.scopeRecordIds || [
          ...mapped.assignments.map((item) => item.recordId),
          ...mapped.unresolvedRecordIds,
        ],
      ),
    );
    const proposal: CollectionProposal = {
      ...draft,
      id: mapped.id,
      createdAt: mapped.createdAt,
      updatedAt: mapped.updatedAt,
      status: 'pending',
      sourceJobIds: undefined,
    };
    proposals.set(proposal.id, proposal);
    await db.put('collectionProposals', proposal);
  }
  for (const row of state.analyses) {
    const mapped = collectionAnalysisSchema.parse(remap(row));
    if (mapped.tagTarget && mapped.tagTarget.kind !== 'workspace') {
      const target = proposals.get(mapped.tagTarget.proposalId);
      if (target) mapped.tagTarget.proposalFingerprint = await Dexie.waitFor(tagHash(target));
    }
    await db.put('collectionAnalyses', mapped);
  }
  for (const row of state.actionAnalyses)
    await db.put('actionAnalyses', actionAnalysisSchema.parse(remap(row)));
  for (const row of state.tags) {
    const mapped = tagAnalysisSchema.parse(remap(row));
    mapped.id = tagResultId(mapped);
    await db.put('tagAnalyses', mapped);
  }
  for (const row of state.threads) {
    const mapped = assistantThreadSchema.parse(remap(row));
    mapped.status = 'interrupted';
    for (const message of mapped.messages) {
      message.completedArtifacts = ['task', 'project', 'command', 'plan', 'collection'];
      message.collectionApplyRequested = false;
      message.permissionReviewIds = [];
      message.assistantChangeIds = [];
      message.commandDraft = undefined;
      message.plan = undefined;
      message.projectDraft = undefined;
      message.taskDraft = undefined;
      if (message.deliveryStatus === 'generating') message.deliveryStatus = 'interrupted';
      if (message.request) {
        message.request.allowCrossWindowMove = false;
        message.request.allowSleepWake = false;
      }
    }
    await db.put('assistantThreads', mapped);
  }
  for (const row of state.changes) {
    const mapped = assistantChangeSchema.parse(remap(row));
    mapped.archived = true;
    mapped.permissionReview = undefined;
    mapped.operationId = undefined;
    mapped.jobId = undefined;
    mapped.snapshotId = undefined;
    for (const delta of mapped.deltas)
      for (const key of ['before', 'after'] as const)
        if (delta[key]) {
          try {
            delta[key] = JSON.stringify(remap(JSON.parse(delta[key])));
          } catch {
            /* Preserve historical non-JSON text. */
          }
        }
    await db.put('assistantChanges', mapped);
  }
  for (const row of state.receipts)
    await db.put('inferenceReceipts', inferenceReceiptSchema.parse(remap(row)));
  for (const row of state.audit) await db.put('assistantAudit', audit.parse(remap(row)));
  for (const row of state.revisions) {
    const mapped = revision.parse(remap(row));
    await db.put('proposalRevisions', {
      ...mapped,
      before: { ...mapped.before, status: 'pending', sourceJobIds: undefined },
      after: { ...mapped.after, status: 'pending', sourceJobIds: undefined },
    });
  }
}
