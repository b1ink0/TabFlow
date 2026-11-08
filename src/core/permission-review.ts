import { z } from 'zod';
import * as db from './db';
import * as engine from './engine';
import { assistantThreadSchema } from '../shared/assistant';
import { conversationBranch } from '../shared/assistant-branches';
import {
  assistantArtifactSchema,
  actionCapabilities,
  type AssistantArtifact,
} from '../shared/assistant-actions';
import {
  permissionPolicySchema,
  permissionReviewSchema,
  type PermissionReview,
  type PermissionPolicy,
} from '../shared/permission-review';
import { workspaceEditBaseline, workspaceEditRecordIds } from '../shared/workspace-edits';
import { validatePlan } from '../shared/model';
import { tagHash } from '../shared/tag-analysis';
import { reviewPermission, PermissionReviewUnavailable } from '../ai/permission-review';
import { runModelInference } from '../ai/inference-lane';
const policiesKey = 'assistantPermissionPolicies';
const active = new Map<string, { threadId: string; controller: AbortController }>();
export const reviewSummary = ({
  artifact: _artifact,
  packet: _packet,
  ...summary
}: PermissionReview) => summary;
export async function permissionPolicy(threadId: string): Promise<PermissionPolicy> {
  const saved = await chrome.storage.local.get(policiesKey);
  const policies = z.record(z.string(), permissionPolicySchema).catch({}).parse(saved[policiesKey]);
  return policies[threadId] || { mode: 'ask', revision: 0 };
}
export async function setPermissionPolicy(raw: unknown) {
  const input = z
    .object({ threadId: z.string().min(1), mode: z.enum(['ask', 'review', 'all']) })
    .parse(raw);
  if (!(await db.get('assistantThreads', input.threadId)))
    throw new Error('Open a saved conversation first.');
  const saved = await chrome.storage.local.get(policiesKey);
  const policies = z.record(z.string(), permissionPolicySchema).catch({}).parse(saved[policiesKey]);
  const policy: PermissionPolicy = {
    mode: input.mode,
    revision: (policies[input.threadId]?.revision || 0) + 1,
  };
  policies[input.threadId] = policy;
  await chrome.storage.local.set({ [policiesKey]: policies });
  for (const item of active.values()) if (item.threadId === input.threadId) item.controller.abort();
  await db.database.permissionReviews
    .where('threadId')
    .equals(input.threadId)
    .filter((item) => item.status === 'pending')
    .modify({
      status: 'interrupted',
      decision: 'ask',
      reason: 'Approval mode changed. Nothing was executed.',
    });
  return policy;
}
function matchingArtifact(stored: AssistantArtifact, selected: AssistantArtifact) {
  if (stored.kind === 'collection' && selected.kind === 'collection')
    return stored.proposalId === selected.proposalId;
  if (stored.kind !== 'plan' || selected.kind !== 'plan')
    return JSON.stringify(stored) === JSON.stringify(selected);
  const remaining = stored.plan.actions.map((action) => JSON.stringify(action));
  return (
    selected.plan.actions.length > 0 &&
    selected.plan.actions.every((action) => {
      const index = remaining.indexOf(JSON.stringify(action));
      if (index < 0) return false;
      remaining.splice(index, 1);
      return true;
    }) &&
    JSON.stringify({ ...stored.plan, actions: [] }) ===
      JSON.stringify({ ...selected.plan, actions: [] })
  );
}
export async function permissionContext(
  threadId: string,
  messageId: string,
  artifact: AssistantArtifact,
  requireApplicationIntent = false,
) {
  const thread = assistantThreadSchema.parse(await db.get('assistantThreads', threadId));
  const branch = conversationBranch(thread);
  const message = branch.find((item) => item.id === messageId && item.role === 'assistant');
  if (
    !message ||
    message.deliveryStatus !== 'complete' ||
    message.completedArtifacts.includes(artifact.kind)
  )
    throw new Error('This action is not an unfinished draft on the selected answer branch.');
  if (
    artifact.kind === 'collection' &&
    requireApplicationIntent &&
    !message.collectionApplyRequested
  )
    throw new Error(
      'This turn only saved a draft. Organization application was not requested; use Apply organization explicitly.',
    );
  const user = branch.find((item) => item.id === message.requestMessageId && item.role === 'user');
  if (!user) throw new Error('The original user request is unavailable. Ask the user.');
  const stored =
    artifact.kind === 'command' && message.commandDraft
      ? { kind: 'command' as const, command: message.commandDraft }
      : artifact.kind === 'plan' && message.plan
        ? { kind: 'plan' as const, plan: message.plan }
        : artifact.kind === 'project' && message.projectDraft
          ? { kind: 'project' as const, project: message.projectDraft }
          : artifact.kind === 'task' && message.taskDraft
            ? { kind: 'task' as const, task: message.taskDraft }
            : artifact.kind === 'collection' && message.collectionProposalId
              ? { kind: 'collection' as const, proposalId: message.collectionProposalId }
              : undefined;
  if (!stored || !matchingArtifact(assistantArtifactSchema.parse(stored), artifact))
    throw new Error('The action differs from its saved draft. Review the current action.');
  const app = await engine.state();
  let ids: string[] = [];
  let effect: unknown = artifact;
  if (artifact.kind === 'collection') {
    const proposal = await db.get('collectionProposals', artifact.proposalId);
    if (!proposal || proposal.status !== 'pending' || proposal.copyState)
      throw new Error('This organization is not a pending semantic assignment draft.');
    if (artifact.proposalFingerprint && artifact.proposalFingerprint !== (await tagHash(proposal)))
      throw new Error(
        'The organization draft changed after review. Review the updated proposal before applying it.',
      );
    ids = [
      ...new Set([
        ...proposal.assignments.map((item) => item.recordId),
        ...(proposal.unresolvedTagSuggestions || []).map((item) => item.recordId),
      ]),
    ].filter((id) => !proposal.excludedRecordIds?.includes(id));
    for (const item of [...proposal.assignments, ...(proposal.unresolvedTagSuggestions || [])]) {
      if (proposal.excludedRecordIds?.includes(item.recordId)) continue;
      const record = app.records.find((record) => record.id === item.recordId);
      if (!record || record.url !== item.url || record.navigationVersion !== item.navigationVersion)
        throw new Error(
          'The organization references changed pages. Sync changed tabs and review the updated draft.',
        );
    }
    effect = { artifact, proposal };
  } else if (artifact.kind === 'task') {
    ids = artifact.task.recordId ? [artifact.task.recordId] : [];
  } else if (artifact.kind === 'plan') {
    validatePlan(artifact.plan, app.records, app.windows);
    ids = artifact.plan.actions.flatMap((item) => item.recordIds);
    for (const id of ids) {
      const expected = artifact.plan.expected?.[id];
      const record = app.records.find((item) => item.id === id);
      if (
        expected &&
        (!record ||
          record.url !== expected.url ||
          record.navigationVersion !== expected.navigationVersion ||
          (expected.windowId !== undefined && record.windowId !== expected.windowId) ||
          (expected.groupId !== undefined && record.groupId !== expected.groupId))
      )
        throw new Error('A planned tab changed. Prepare a refreshed plan before approval.');
    }
  } else if (artifact.kind === 'command') {
    if (artifact.command.kind === 'workspace_edits') {
      for (const item of artifact.command.edits)
        if (workspaceEditBaseline(app, item.edit) !== item.before)
          throw new Error(
            'The saved edits no longer match current values. Prepare refreshed edits before approval.',
          );
      ids = artifact.command.edits.flatMap(({ edit }) => workspaceEditRecordIds(edit, app));
    } else if ('recordIds' in artifact.command) ids = artifact.command.recordIds;
    else if ('operationId' in artifact.command) {
      const operation = await db.get('operations', artifact.command.operationId);
      effect = { artifact, operation };
      ids = operation?.actions.flatMap((item) => item.recordIds) || [];
      if (operation?.tabCommand) ids.push(operation.tabCommand.recordId);
    } else if ('changeId' in artifact.command) {
      const change = await db.get('assistantChanges', artifact.command.changeId);
      effect = { artifact, change };
      ids =
        change?.deltas
          .filter((item) => item.table === 'records' || item.table === 'memberships')
          .map((item) => item.id) || [];
      if (change?.operationId) {
        const operation = await db.get('operations', change.operationId);
        ids.push(...(operation?.actions.flatMap((item) => item.recordIds) || []));
      }
    } else if ('snapshotId' in artifact.command) {
      const snapshot = await db.get('snapshots', artifact.command.snapshotId);
      effect = { artifact, snapshot };
      ids = snapshot?.windows.flatMap((item) => item.tabs.map((tab) => tab.recordId)) || [];
    }
  }
  ids = [...new Set(ids)];
  if (user.request?.restrictToScope && ids.some((id) => !user.request!.recordIds.includes(id)))
    throw new Error('The action exceeds the user-attached or selected tab scope.');
  const targets = ids.map((id) => {
    const record = app.records.find((item) => item.id === id);
    if (!record?.live || record.locked)
      throw new Error('A target is closed or protected. Refresh the draft before approval.');
    if (
      app.jobs.some(
        (job) =>
          ['queued', 'running'].includes(job.status) && job.items.some((item) => item.id === id),
      )
    )
      throw new Error('An inspection target is protected. Wait for its inspection.');
    return {
      id,
      title: record.title,
      url: record.url,
      navigationVersion: record.navigationVersion,
      windowId: record.windowId,
      groupId: record.groupId,
      pinned: record.pinned,
      muted: record.muted,
      suspended: record.suspended,
      tags: record.tags,
      note: record.note,
      membership: app.memberships.find((item) => item.recordId === id),
    };
  });
  if (artifact.kind === 'plan') {
    if (
      !user.request?.allowCrossWindowMove &&
      artifact.plan.actions.some(
        (action) =>
          action.type === 'move' ||
          action.type === 'moveGroup' ||
          action.recordIds.some(
            (id) =>
              action.windowId !== undefined &&
              action.windowId !== app.records.find((item) => item.id === id)?.windowId,
          ),
      )
    )
      throw new Error('Cross-window move proposals are disabled for this request.');
    if (
      !user.request?.allowSleepWake &&
      artifact.plan.actions.some((action) => action.type === 'wake' || action.type === 'suspend')
    )
      throw new Error('Sleep/wake proposals are disabled for this request.');
  }
  if (artifact.kind === 'command' && artifact.command.kind === 'inspect') {
    const origins = [...new Set(targets.map((item) => `${new URL(item.url).origin}/*`))];
    if (!(await chrome.permissions.contains({ origins })))
      throw new Error('Page access needs your browser permission. Use Inspect tabs to grant it.');
  }
  const packet = {
    originalRequest: user.content,
    latestUserRequest: branch.filter((item) => item.role === 'user').at(-1)?.content,
    selectedBranchTip: branch.at(-1)?.id,
    savedScope: user.request,
    userConversation: branch
      .filter((item) => item.role === 'user')
      .map((item) => ({ id: item.id, request: item.content })),
    effects: effect,
    capabilities: actionCapabilities(artifact),
    targets,
    projects: app.projects,
    categories: app.categories,
    areas: app.areas,
    workItems:
      artifact.kind === 'command' && artifact.command.kind === 'workspace_edits'
        ? app.workItems.filter(
            (item) =>
              artifact.command.kind === 'workspace_edits' &&
              artifact.command.edits.some(
                ({ edit }) => edit.kind === 'work_item' && edit.workItemId === item.id,
              ),
          )
        : [],
    destinations:
      artifact.kind === 'plan'
        ? {
            windows: app.windows
              .filter((window) =>
                artifact.plan.actions.some((action) => action.windowId === window.id),
              )
              .map((window) => ({
                id: window.id,
                projectId: window.projectId,
                projectName: app.projects.find((project) => project.id === window.projectId)?.name,
              })),
            groups: app.groups
              .filter((group) =>
                artifact.plan.actions.some((action) => action.nativeGroupId === group.id),
              )
              .map((group) => ({
                id: group.id,
                windowId: group.windowId,
                title: group.title,
                color: group.color,
              })),
          }
        : undefined,
    activeInspections: app.jobs
      .filter((item) => ['queued', 'running'].includes(item.status))
      .map((item) => ({ id: item.id, targets: item.items.map((target) => target.id) })),
  };
  const config = {
    model: app.settings.aiModel,
    base: app.settings.aiBase,
    contextTokens: app.settings.aiContextTokens,
    completionTokens: app.settings.aiCompletionTokens,
    reasoning: app.settings.aiReasoningEffort,
  };
  return {
    packet: JSON.stringify(packet),
    fingerprint: await tagHash({ packet, config }),
    settings: app.settings,
    expected: Object.fromEntries(
      targets.map(({ id, url, navigationVersion, windowId, groupId }) => [
        id,
        { url, navigationVersion, windowId, groupId },
      ]),
    ),
  };
}
export async function preparePermissionReview(raw: unknown) {
  const input = z
    .object({
      threadId: z.string().min(1),
      messageId: z.string().min(1),
      artifact: assistantArtifactSchema,
      oneOff: z.boolean(),
    })
    .parse(raw);
  const policy = await permissionPolicy(input.threadId);
  if (!input.oneOff && policy.mode !== 'review')
    throw new Error('Approve for me is off for this chat.');
  const record: PermissionReview = {
    ...input,
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    expiresAt: Date.now() + 300000,
    model: '',
    policyRevision: policy.revision,
    status: 'pending',
    decision: 'ask',
    reason: 'The orchestrator is reviewing this action. Nothing has executed.',
    fingerprint: '',
    artifactKey: await tagHash(input.artifact),
    packet: '',
  };
  try {
    const context = await permissionContext(
      input.threadId,
      input.messageId,
      input.artifact,
      !input.oneOff,
    );
    record.packet = context.packet;
    record.fingerprint = context.fingerprint;
    record.model = context.settings.aiModel;
  } catch (error) {
    record.status = 'complete';
    record.reason = error instanceof Error ? error.message : 'The action needs your review.';
  }
  await db.put('permissionReviews', record);
  return reviewSummary(record);
}
export async function resolvePermissionReview(id: string) {
  const review = await engine.serialized(async () =>
    permissionReviewSchema.parse(await db.get('permissionReviews', id)),
  );
  if (review.status !== 'pending') return reviewSummary(review);
  if (active.has(id)) throw new Error('This action is already being reviewed.');
  const controller = new AbortController();
  active.set(id, { threadId: review.threadId, controller });
  try {
    const settings = await engine.settings();
    const verdict = await runModelInference(
      () => reviewPermission(settings, review.packet, controller.signal),
      { signal: controller.signal, parallelism: settings.maxConcurrentInference },
    );
    return await engine.serialized(async () => {
      const current = permissionReviewSchema.parse(await db.get('permissionReviews', id));
      if (current.status !== 'pending') return reviewSummary(current);
      const policy = await permissionPolicy(review.threadId);
      const context = await permissionContext(
        review.threadId,
        review.messageId,
        assistantArtifactSchema.parse(review.artifact),
        !review.oneOff,
      );
      if (
        policy.revision !== review.policyRevision ||
        (!review.oneOff && policy.mode !== 'review') ||
        context.fingerprint !== review.fingerprint ||
        Date.now() > review.expiresAt
      )
        throw new Error(
          'The request, action, model settings or targets changed during review. Ask for a new review.',
        );
      current.status = 'complete';
      current.decision = verdict.decision;
      current.reason = verdict.reason;
      await db.put('permissionReviews', current);
      return reviewSummary(current);
    });
  } catch (error) {
    return engine.serialized(async () => {
      const current = permissionReviewSchema.parse(await db.get('permissionReviews', id));
      if (current.status === 'pending') {
        current.status = 'complete';
        current.decision = 'ask';
        current.reason = controller.signal.aborted
          ? 'Review stopped. Nothing was approved.'
          : error instanceof PermissionReviewUnavailable ||
              (error instanceof Error && error.message.startsWith('The request,'))
            ? error.message
            : 'The reviewer could not complete a validated decision. Please review this action yourself or try again.';
        await db.put('permissionReviews', current);
      }
      return reviewSummary(current);
    });
  } finally {
    active.delete(id);
  }
}
export async function consumePermissionReview(input: {
  threadId: string;
  messageId: string;
  artifact: AssistantArtifact;
  permissionReviewId?: string;
}) {
  const review = permissionReviewSchema.parse(
    await db.get('permissionReviews', input.permissionReviewId),
  );
  const policy = await permissionPolicy(input.threadId);
  if (review.usedAt) throw new Error('This permission review was already used.');
  if (
    review.threadId !== input.threadId ||
    review.messageId !== input.messageId ||
    review.artifactKey !== (await tagHash(input.artifact)) ||
    review.status !== 'complete' ||
    review.decision !== 'allow'
  )
    throw new Error('This exact action needs a current permission review.');
  async function invalidate(reason: string): Promise<never> {
    review.decision = 'ask';
    review.reason = reason;
    await db.put('permissionReviews', review);
    throw new Error(reason);
  }
  if (
    Date.now() > review.expiresAt ||
    policy.revision !== review.policyRevision ||
    (!review.oneOff && policy.mode !== 'review')
  )
    return invalidate('This exact action needs a current permission review.');
  const context = await permissionContext(
    input.threadId,
    input.messageId,
    input.artifact,
    !review.oneOff,
  ).catch((error) =>
    invalidate(error instanceof Error ? error.message : 'The draft needs a fresh review.'),
  );
  if (context.fingerprint !== review.fingerprint)
    return invalidate('The action or targets changed after approval. Request a new review.');
  review.usedAt = Date.now();
  await db.put('permissionReviews', review);
  const targets = z
    .object({
      targets: z.array(
        z.object({
          id: z.string(),
          url: z.string(),
          navigationVersion: z.number(),
          windowId: z.number().optional(),
          groupId: z.number().optional(),
        }),
      ),
    })
    .parse(JSON.parse(review.packet)).targets;
  return {
    id: review.id,
    model: review.model,
    reason: review.reason,
    expected: Object.fromEntries(targets.map(({ id, ...target }) => [id, target])),
  };
}
export async function interruptPermissionReviews() {
  await db.database.permissionReviews.where('status').equals('pending').modify({
    status: 'interrupted',
    decision: 'ask',
    reason: 'Review interrupted by extension restart. Nothing was automatically replayed.',
  });
}
