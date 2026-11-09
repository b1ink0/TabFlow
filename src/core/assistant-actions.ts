import { z } from 'zod';
import { workspaceEditDraftSchema } from '../shared/workspace/workspace-edits';
import { validateTabTree } from '../shared/tabs/tab-tree';
import { consumePermissionReview, permissionContext, permissionPolicy } from './permission-review';
import * as db from './db';
import * as engine from './engine';
import { now, importSnapshot } from '../shared/model';
import { tagHash } from '../shared/organization/tag-analysis';
import type { Plan } from '../shared/types';
import { actionPresentation } from '../shared/workspace/action-presentation';
import {
  actionCapabilities,
  approvalRuleSchema,
  assistantChangeSchema,
  assistantExecutionSchema,
  type AssistantChange,
  type MetadataDelta,
} from '../shared/assistant/assistant-actions';

const rulesKey = 'assistantApprovalRules';
export async function approvalRules() {
  const saved = await chrome.storage.local.get(rulesKey);
  return z.array(approvalRuleSchema).catch([]).parse(saved[rulesKey]);
}
export async function revokeApprovals(threadId?: string) {
  const rules = await approvalRules();
  await chrome.storage.local.set({
    [rulesKey]: threadId ? rules.filter((item) => item.threadId !== threadId) : [],
  });
}
const metadataTables = [
  'records',
  'memberships',
  'projects',
  'categories',
  'workItems',
  'areas',
] as const;
async function captureMetadata() {
  const cells = new Map<string, MetadataDelta>();
  for (const table of metadataTables) {
    for (const row of await db.all(table)) {
      if (table === 'records') {
        if (!('tags' in row)) continue;
        const record = row;
        for (const field of ['tags', 'note', 'parentRecordId', 'branchName'] as const)
          cells.set(`${table}:${record.id}:${field}`, {
            table,
            field,
            id: record.id,
            url: record.url,
            navigationVersion: record.navigationVersion,
            before: JSON.stringify(record[field] ?? (field === 'parentRecordId' ? null : '')),
            after: null,
          });
      } else {
        const id = 'id' in row ? row.id : row.recordId;
        const record = table === 'memberships' ? await db.get('records', id) : undefined;
        cells.set(`${table}:${id}`, {
          table,
          field: 'entity',
          id,
          url: record?.url,
          navigationVersion: record?.navigationVersion,
          before: JSON.stringify(row),
          after: null,
        });
      }
    }
  }
  return cells;
}
function changed(before: Map<string, MetadataDelta>, after: Map<string, MetadataDelta>) {
  return [...new Set([...before.keys(), ...after.keys()])].flatMap((key) => {
    const previous = before.get(key),
      next = after.get(key);
    if (previous?.before === next?.before) return [];
    const source = next || previous;
    return source
      ? [{ ...source, before: previous?.before || null, after: next?.before || null }]
      : [];
  });
}
function comparable(value: string | null, field: MetadataDelta['field']) {
  if (!value || field !== 'entity') return value;
  const data = z.record(z.string(), z.unknown()).parse(JSON.parse(value));
  delete data.updatedAt;
  delete data.revision;
  return JSON.stringify(
    Object.fromEntries(Object.entries(data).sort(([left], [right]) => left.localeCompare(right))),
  );
}
export async function executeAssistantAction(raw: unknown): Promise<AssistantChange> {
  const input = assistantExecutionSchema.parse(raw);
  const id = await tagHash({
    threadId: input.threadId,
    messageId: input.messageId,
    artifact: input.artifact,
    ...(input.mode === 'reviewed' ? { permissionReviewId: input.permissionReviewId } : {}),
  });
  const previous = await db.get('assistantChanges', id);
  if (previous) {
    if (['running', 'failed', 'interrupted', 'denied'].includes(previous.status))
      throw new Error(
        'This action was denied or has an unfinished/failed trace. Review it before starting a new explicit attempt; it was not replayed.',
      );
    return previous;
  }
  const capabilities = actionCapabilities(input.artifact);
  if (
    input.artifact.kind === 'command' &&
    input.artifact.command.kind === 'workspace_edits' &&
    input.artifact.command.edits.some(
      ({ edit }) => edit.kind === 'delete_category' || edit.kind === 'move_category',
    ) &&
    !['automatic', 'reviewed'].includes(input.mode)
  )
    await permissionContext(input.threadId, input.messageId, input.artifact);
  const collection =
    input.artifact.kind === 'collection'
      ? await db.get('collectionProposals', input.artifact.proposalId)
      : undefined;
  if (
    input.artifact.kind === 'collection' &&
    input.artifact.proposalFingerprint &&
    (!collection || (await tagHash(collection)) !== input.artifact.proposalFingerprint)
  )
    throw new Error(
      'The organization draft changed after review. Review the updated proposal before applying it.',
    );
  const rules = await approvalRules();
  let automaticExpected: Plan['expected'];
  if (input.mode === 'automatic') {
    const policy = await permissionPolicy(input.threadId);
    if (policy.mode !== 'all' || policy.revision !== input.permissionPolicyRevision)
      throw new Error('Approval is required: Approve all is not enabled for this chat.');
    const context = await permissionContext(input.threadId, input.messageId, input.artifact, true);
    automaticExpected = context.expected;
  }
  const reviewAuthorization =
    input.mode === 'reviewed' ? await consumePermissionReview(input) : undefined;
  const permissionReview = reviewAuthorization
    ? {
        id: reviewAuthorization.id,
        model: reviewAuthorization.model,
        reason: reviewAuthorization.reason,
      }
    : undefined;
  if (input.mode === 'chat' || input.mode === 'always') {
    if (capabilities.some((item) => item === 'inspection' || item === 'recovery'))
      throw new Error('Inspection access and recovery require approval each time.');
    const threadId = input.mode === 'chat' ? input.threadId : null;
    await chrome.storage.local.set({
      [rulesKey]: [
        ...rules.filter(
          (item) => !capabilities.includes(item.capability) || item.threadId !== threadId,
        ),
        ...capabilities.map((capability) => ({ capability, threadId })),
      ],
    });
  }
  const artifact = input.artifact;
  const trace: AssistantChange = {
    id,
    threadId: input.threadId,
    messageId: input.messageId,
    createdAt: now(),
    permissionReview,
    mode: input.mode,
    capabilities,
    status: 'running',
    summary:
      artifact.kind === 'command' && artifact.command.kind === 'workspace_edits'
        ? artifact.command.summary
        : artifact.kind === 'plan'
          ? artifact.plan.summary
          : artifact.kind === 'collection'
            ? `Apply organization · ${collection?.name || artifact.proposalId.slice(0, 8)}`
            : actionPresentation(artifact).label,
    outcome: '',
    deltas: [],
  };
  await db.put('assistantChanges', trace);
  const metadata =
    artifact.kind === 'project' ||
    artifact.kind === 'task' ||
    artifact.kind === 'collection' ||
    (artifact.kind === 'command' && ['workspace_edits', 'assign'].includes(artifact.command.kind));
  const validatedApp = metadata ? await engine.state() : undefined;
  const perform = async () => {
    const before = metadata ? await captureMetadata() : new Map<string, MetadataDelta>();
    if (artifact.kind === 'project') {
      const project = await engine.project(
        { ...artifact.project, provenance: { author: 'ai', proposalId: id } },
        false,
      );
      trace.projectId = project.id;
      trace.outcome = `Created project ${project.name}`;
    } else if (artifact.kind === 'task') {
      const task = await engine.saveWorkItem({
        ...artifact.task,
        status: 'open',
        source: 'owner',
        dueAt: artifact.task.dueAt ?? null,
        provenance: { author: 'ai', proposalId: id },
      });
      trace.outcome = `Saved work item ${task.title}`;
    } else if (artifact.kind === 'collection') {
      const proposal = await engine.applyCollectionProposal(
        artifact.proposalId,
        undefined,
        validatedApp,
      );
      trace.proposalId = proposal.id;
      trace.outcome = `Applied organization for ${proposal.assignments.filter((item) => !proposal.excludedRecordIds?.includes(item.recordId)).length} tabs`;
    } else if (artifact.kind === 'plan') {
      const operation = await engine.applyPlan(
        {
          ...artifact.plan,
          ...(reviewAuthorization || automaticExpected
            ? { expected: reviewAuthorization?.expected || automaticExpected }
            : {}),
          provenance: { ...artifact.plan.provenance, author: 'ai', proposalId: id },
        },
        async (operation) => {
          trace.operationId = operation.id;
          await db.put('assistantChanges', trace);
        },
      );
      trace.operationId = operation.id;
      trace.outcome = operation.queued
        ? 'Browser work queued; follow progress to pause or resume.'
        : `Browser actions ${operation.status}`;
      if (operation.status === 'partial') trace.status = 'partial';
    } else if (artifact.kind === 'command') {
      const command = artifact.command;
      if (command.kind === 'workspace_edits') {
        await engine.applyWorkspaceEdits(command, false);
        trace.outcome = `Applied ${command.edits.length} workspace edits`;
      } else if (command.kind === 'assign') {
        await engine.assignMembership(command, false);
        trace.outcome = `Assigned ${command.recordIds.length} tabs`;
      } else if (command.kind === 'inspect') {
        const job = await engine.startInspection(command.recordIds, command.expected);
        trace.jobId = job.id;
        trace.outcome = `Inspection queued for ${job.items.length} tabs`;
      } else if (command.kind === 'snapshot') {
        const snapshot = await engine.snapshot(command.label);
        trace.snapshotId = snapshot.id;
        trace.outcome = `Saved snapshot ${snapshot.label}`;
      } else {
        if (command.kind === 'undo_assistant' || command.kind === 'redo_assistant') {
          const result = await (command.kind === 'redo_assistant'
            ? redoAssistantChange(command.changeId)
            : undoAssistantChange(command.changeId));
          trace.outcome = result.outcome;
          if (result.status === 'partial') trace.status = 'partial';
        } else if (command.kind === 'redo') {
          const result = await engine.redoOperation(command.operationId);
          trace.operationId = result.id;
          trace.outcome = `Redo: ${result.summary}`;
          trace.status = result.status;
        } else {
          const results =
            command.kind === 'undo'
              ? await engine.undoOperation(command.operationId)
              : await engine.restoreSnapshot(command.snapshotId);
          trace.outcome = `Recovery recorded ${results.length} outcomes`;
          if (results.some((item) => !item.ok)) trace.status = 'partial';
        }
      }
    }
    if (metadata) trace.deltas = changed(before, await captureMetadata());
    if (trace.status === 'running') trace.status = 'complete';
    await db.put('assistantChanges', trace);
  };
  try {
    // Metadata effects and their before/after journal commit together, including generated IDs.
    if (metadata) await db.database.transaction('rw', db.database.tables, perform);
    else await perform();
    return trace;
  } catch (error) {
    trace.status = 'failed';
    trace.outcome = error instanceof Error ? error.message : String(error);
    trace.deltas = [];
    await db.put('assistantChanges', trace);
    throw error;
  }
}
/** Manual UI edits use the same atomic metadata journal, without impersonating a chat approval. */
export async function executeWorkspaceEdit(raw: unknown): Promise<AssistantChange> {
  const draft = workspaceEditDraftSchema.parse(raw);
  await engine.validateWorkspaceEditTargets(draft);
  return db.database.transaction('rw', db.database.tables, async () => {
    const before = await captureMetadata();
    await engine.applyWorkspaceEdits(draft, false);
    const id = crypto.randomUUID();
    const trace: AssistantChange = {
      id,
      threadId: 'workspace',
      messageId: id,
      source: 'owner',
      createdAt: now(),
      summary: draft.summary,
      mode: 'once',
      capabilities: actionCapabilities({ kind: 'command', command: draft }),
      status: 'complete',
      outcome: draft.summary,
      deltas: changed(before, await captureMetadata()),
    };
    await db.put('assistantChanges', trace);
    return trace;
  });
}
export async function denyAssistantAction(raw: unknown): Promise<AssistantChange> {
  const input = assistantExecutionSchema.parse(raw);
  const id = await tagHash({
    threadId: input.threadId,
    messageId: input.messageId,
    artifact: input.artifact,
  });
  if (await db.get('assistantChanges', id))
    throw new Error('This action already has an execution trace.');
  const trace: AssistantChange = {
    id,
    threadId: input.threadId,
    messageId: input.messageId,
    createdAt: now(),
    summary: `Denied: ${actionPresentation(input.artifact).label}`,
    mode: 'once',
    capabilities: actionCapabilities(input.artifact),
    status: 'denied',
    outcome: 'Denied by you. No action was executed.',
    deltas: [],
  };
  await db.put('assistantChanges', trace);
  return trace;
}

function parseEntity(delta: MetadataDelta) {
  const value: unknown = JSON.parse(delta.before || 'null');
  const backup = importSnapshot({
    format: 'tabloom',
    schema: 6,
    exportedAt: 0,
    projects: [],
    snapshots: [],
    [delta.table]: [value],
  });
  return backup;
}
export async function undoAssistantChange(id: string): Promise<AssistantChange> {
  return restoreAssistantChange(id, false);
}
export async function redoAssistantChange(id: string): Promise<AssistantChange> {
  return restoreAssistantChange(id, true);
}
async function restoreAssistantChange(id: string, redo: boolean): Promise<AssistantChange> {
  const trace = assistantChangeSchema.parse(await db.get('assistantChanges', id));
  if (trace.archived)
    throw new Error(
      'Imported change history is read-only. It cannot authorize Undo or Redo on this installation.',
    );
  if (redo && trace.status !== 'undone') throw new Error('Only an undone action can be redone.');
  if (!redo && trace.status === 'undone') return trace;
  if (redo && trace.operationId) {
    const result = await engine.redoOperation(trace.operationId);
    trace.operationId = result.id;
    trace.status = result.status;
    trace.outcome = `Redo: ${result.summary}`;
    trace.undoResults = undefined;
    await db.put('assistantChanges', trace);
    return trace;
  }
  if (trace.status === 'running') throw new Error('This action is still running.');
  if (trace.operationId) {
    const operation = await db.get('operations', trace.operationId);
    if (operation?.queued && operation.status === 'running')
      throw new Error('Pause the wake queue before Undo.');
    const result = await engine.undoOperation(trace.operationId);
    trace.undoResults = result.map((item, index) => ({
      id: item.recordId || String(index),
      restored: item.ok,
      reason: item.error,
    }));
  } else if (trace.deltas.length) {
    await engine.reconcile();
    const results: NonNullable<AssistantChange['undoResults']> = [];
    await db.database.transaction('rw', db.database.tables, async () => {
      const current = await captureMetadata();
      const jobs = await db.all('jobs');
      const entityOrder = [
        'areas',
        'projects',
        'categories',
        'workItems',
        'memberships',
        'records',
      ];
      const rank = (delta: MetadataDelta) =>
        delta.before === null
          ? 20 - entityOrder.indexOf(delta.table)
          : entityOrder.indexOf(delta.table);
      // Restore referenced entities before memberships; remove created entities after references.
      const ordered = (
        redo
          ? trace.deltas.map((delta) => ({ ...delta, before: delta.after, after: delta.before }))
          : [...trace.deltas]
      ).sort((a, b) => rank(a) - rank(b));
      for (const delta of ordered) {
        const key =
          delta.table === 'records'
            ? `${delta.table}:${delta.id}:${delta.field}`
            : `${delta.table}:${delta.id}`;
        const row = current.get(key);
        const fail = (reason: string) => results.push({ id: key, restored: false, reason });
        if (!redo && trace.undoResults?.some((item) => item.id === key && item.restored)) {
          results.push({ id: key, restored: true });
          continue;
        }
        if (comparable(row?.before || null, delta.field) !== comparable(delta.after, delta.field)) {
          fail('A later edit was retained');
          continue;
        }
        if (delta.table === 'records' || delta.table === 'memberships') {
          const record = await db.get('records', delta.id);
          if (
            !record ||
            (delta.table === 'records' && !record.live) ||
            record.locked ||
            jobs.some(
              (job) =>
                ['queued', 'running'].includes(job.status) &&
                job.items.some((item) => item.id === delta.id),
            )
          ) {
            fail('Closed, protected or inspected tab retained');
            continue;
          }
          if (record.url !== delta.url || record.navigationVersion !== delta.navigationVersion) {
            fail('Navigated page retained');
            continue;
          }
          if (delta.table === 'records') {
            if (delta.field === 'parentRecordId') {
              const parentRecordId = z
                .string()
                .min(1)
                .nullable()
                .parse(JSON.parse(delta.before || 'null'));
              const records = await db.all('records');
              if (parentRecordId && !records.some((item) => item.id === parentRecordId)) {
                fail('Missing parent tab retained');
                continue;
              }
              try {
                validateTabTree(
                  records.map((item) =>
                    item.id === record.id ? { ...item, parentRecordId } : item,
                  ),
                );
              } catch {
                fail('Later branch structure retained');
                continue;
              }
              record.parentRecordId = parentRecordId;
            } else if (delta.field === 'branchName')
              record.branchName = z
                .string()
                .max(80)
                .parse(JSON.parse(delta.before || '""'));
            else if (delta.field === 'tags')
              record.tags = z.array(z.string().max(80)).parse(JSON.parse(delta.before || '[]'));
            else if (delta.field === 'note')
              record.note = z
                .string()
                .max(4000)
                .parse(JSON.parse(delta.before || '""'));
            else {
              fail('Invalid record field');
              continue;
            }
            await db.put('records', record);
            results.push({ id: key, restored: true });
            continue;
          }
        }
        if (delta.before === null) {
          const memberships = await db.all('memberships');
          const work = await db.all('workItems');
          const dependent =
            delta.table === 'projects'
              ? memberships.some((item) => item.projectId === delta.id) ||
                work.some((item) => item.projectId === delta.id) ||
                (await db.all('categories')).some((item) => item.projectId === delta.id) ||
                (await db.all('records')).some((item) => item.projectId === delta.id)
              : delta.table === 'categories'
                ? memberships.some((item) => item.categoryId === delta.id)
                : delta.table === 'areas'
                  ? (await db.all('projects')).some((item) => item.areaId === delta.id) ||
                    work.some((item) => item.areaId === delta.id)
                  : false;
          if (dependent) {
            fail('Newer references retained; entity kept');
            continue;
          }
          await db.database.table(delta.table).delete(delta.id);
        } else {
          const value = parseEntity(delta);
          if (delta.table === 'projects' && value.projects[0]) {
            const previous = await db.get('projects', delta.id);
            if (
              (await db.all('projects')).some(
                (item) =>
                  item.id !== delta.id &&
                  item.name.toLowerCase() === value.projects[0]!.name.toLowerCase(),
              )
            ) {
              fail('A newer project uses the original name');
              continue;
            }
            await db.put('projects', {
              ...value.projects[0],
              revision: (previous?.revision || 0) + 1,
              updatedAt: now(),
            });
          } else if (delta.table === 'categories' && value.categories?.[0]) {
            const category = value.categories[0];
            if (
              !(await db.get('projects', category.projectId)) ||
              (await db.all('categories')).some(
                (item) =>
                  item.id !== delta.id &&
                  item.projectId === category.projectId &&
                  item.name.toLowerCase() === category.name.toLowerCase(),
              )
            ) {
              fail('Original category destination/name is unavailable');
              continue;
            }
            const previous = await db.get('categories', delta.id);
            if (previous && previous.projectId !== category.projectId) {
              let blocked = false;
              for (const membership of (await db.all('memberships')).filter(
                (item) => item.categoryId === category.id,
              )) {
                const planned = ordered.find(
                  (item) =>
                    item.table === 'memberships' &&
                    item.id === membership.recordId &&
                    item.before !== null,
                );
                const destination = planned ? parseEntity(planned).memberships?.[0] : undefined;
                const record = await db.get('records', membership.recordId);
                if (
                  !planned ||
                  destination?.projectId !== category.projectId ||
                  destination.categoryId !== category.id ||
                  comparable(JSON.stringify(membership), 'entity') !==
                    comparable(planned.after, 'entity') ||
                  !record ||
                  record.locked ||
                  record.url !== planned.url ||
                  record.navigationVersion !== planned.navigationVersion ||
                  jobs.some(
                    (job) =>
                      ['queued', 'running'].includes(job.status) &&
                      job.items.some((item) => item.id === membership.recordId),
                  )
                ) {
                  blocked = true;
                  break;
                }
              }
              if (blocked) {
                fail(
                  'Later or protected category references retained; category move was not reverted',
                );
                continue;
              }
            }
            await db.put('categories', {
              ...category,
              revision: (previous?.revision || 0) + 1,
              updatedAt: now(),
            });
          } else if (delta.table === 'memberships' && value.memberships?.[0]) {
            const membership = value.memberships[0];
            const category = membership.categoryId
              ? await db.get('categories', membership.categoryId)
              : undefined;
            if (
              (membership.projectId && !(await db.get('projects', membership.projectId))) ||
              (membership.categoryId && (!category || category.projectId !== membership.projectId))
            ) {
              fail('Original destination no longer exists');
              continue;
            }
            await db.put('memberships', { ...membership, updatedAt: now() });
          } else if (delta.table === 'workItems' && value.workItems?.[0])
            await db.put('workItems', { ...value.workItems[0], updatedAt: now() });
          else if (delta.table === 'areas' && value.areas?.[0])
            await db.put('areas', { ...value.areas[0], updatedAt: now() });
          else {
            fail('Unsupported restore value');
            continue;
          }
        }
        results.push({ id: key, restored: true });
      }
      trace.undoResults = redo ? undefined : results;
      trace.status = results.every((item) => item.restored)
        ? redo
          ? 'complete'
          : 'undone'
        : 'partial';
      trace.outcome = `${redo ? 'Redo' : 'Undo'}: ${results.filter((item) => item.restored).length} restored; ${results.filter((item) => !item.restored).length} later/changed values retained`;
      if (trace.proposalId) {
        const proposal = await db.get('collectionProposals', trace.proposalId);
        if (proposal) {
          proposal.status = redo ? 'applied' : 'undone';
          await db.put('collectionProposals', proposal);
        }
      }
      await db.put('assistantChanges', trace);
    });
    return trace;
  } else
    throw new Error(
      'This action has no reversible workspace change. Snapshots remain available; stopping inspection is separate.',
    );
  trace.status = trace.undoResults?.every((item) => item.restored) ? 'undone' : 'partial';
  trace.outcome = `Undo recorded ${trace.undoResults?.length || 0} outcomes`;
  await db.put('assistantChanges', trace);
  return trace;
}
export async function interruptAssistantActions() {
  await db.database.assistantChanges.where('status').equals('running').modify({
    status: 'interrupted',
    outcome: 'Extension restarted. Review History; the action was not replayed.',
  });
}
