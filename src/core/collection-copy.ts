import * as db from './db';
import { forgetSessionRecord } from './saved-session';
import { makeSuspendedURL, newRecord, now, uuid, suspendedInfo } from '../shared/model';
import { nativeGroupActions } from '../shared/collection';
import { errorMessage } from '../shared/types';
import type {
  AppState,
  CollectionProposal,
  Operation,
  Plan,
  Settings,
  Snapshot,
  RestoreResult,
} from '../shared/types';

interface Services {
  state: () => Promise<AppState>;
  snapshot: (label: string) => Promise<Snapshot>;
  applyCollectionProposal: (
    id: string,
    copies: ReadonlyMap<string, string>,
  ) => Promise<CollectionProposal>;
  applyPlan: (plan: Plan) => Promise<Operation>;
  bindProject: (windowId: number, projectId: string | null) => Promise<void>;
  settings: () => Promise<Settings>;
  saveSettings: (settings: Settings) => Promise<Settings>;
}

const fingerprint = (record: AppState['records'][number]) =>
  JSON.stringify([
    record.url,
    record.navigationVersion,
    record.title,
    record.windowId,
    record.groupId,
  ]);

/** Called only from the serialized background coordinator. Never modifies a source occurrence. */
export async function copyCollectionToProjectWindows(id: string, services: Services) {
  let proposal = await db.get('collectionProposals', id);
  if (!proposal || !['pending', 'applied'].includes(proposal.status))
    throw new Error('Reviewable organization not found.');
  let app = await services.state();
  const origin = chrome.runtime.getURL('').replace(/\/$/, '');
  const inspection = new Set(
    app.jobs
      .filter((job) => job.status === 'running')
      .flatMap((job) =>
        job.items.filter((item) => item.status === 'loading').map((item) => item.id),
      ),
  );
  if (!proposal.copyState) {
    if (proposal.status !== 'pending')
      throw new Error('This proposal was already applied without a copy arrangement.');
    for (const assignment of proposal.assignments) {
      if (proposal.excludedRecordIds?.includes(assignment.recordId)) continue;
      const source = app.records.find((record) => record.id === assignment.recordId);
      if (
        !source?.live ||
        source.locked ||
        app.memberships.some(
          (membership) => membership.recordId === source.id && membership.source === 'owner',
        ) ||
        inspection.has(source.id) ||
        source.url !== assignment.url ||
        source.navigationVersion !== assignment.navigationVersion
      )
        throw new Error(
          'An original occurrence changed or is protected. Analyze again before copying.',
        );
    }
    const before = await services.snapshot('Before creating AI project windows');
    const operation: Operation = {
      id: uuid(),
      kind: 'collection-copy',
      snapshotId: before.id,
      collectionProposalId: id,
      summary: 'Create project windows with category groups · originals retained',
      createdAt: now(),
      status: 'running',
      actions: [],
      results: [],
      provenance: { author: 'ai', model: proposal.model, proposalId: id },
    };
    await db.put('operations', operation);
    proposal.copyState = {
      operationId: operation.id,
      originalWindowIds: app.windows.map((window) => window.id),
      windows: [],
      entries: proposal.assignments
        .filter((item) => !proposal!.excludedRecordIds?.includes(item.recordId))
        .map((assignment) => ({
          sourceRecordId: assignment.recordId,
          recordId: uuid(),
          created: false,
        })),
    };
    proposal.operationId = operation.id;
    await db.put('collectionProposals', proposal);
  }
  const copyState = proposal.copyState;
  if (copyState.undoStarted)
    throw new Error(
      'Undo has started for this arrangement. Retry Undo rather than creating copies again.',
    );
  const operation = await db.get('operations', copyState.operationId);
  if (!operation) throw new Error('Copy operation journal is missing.');
  if (operation.status === 'complete') return { proposal, operation };
  operation.status = 'running';
  await db.put('operations', operation);
  const save = async () => {
    await db.put('collectionProposals', proposal!);
  };
  for (const entry of copyState.entries) {
    try {
      const assignment = proposal.assignments.find(
        (item) => item.recordId === entry.sourceRecordId,
      )!;
      let copied = app.records.find((record) => record.id === entry.recordId && record.live);
      if (copied) {
        const receipt = copyState.windows.find(
          (window) => window.projectName === assignment.projectName,
        );
        if (
          copyState.originalWindowIds.includes(copied.windowId!) ||
          (receipt && receipt.windowId !== copied.windowId) ||
          copied.url !== assignment.url ||
          copied.navigationVersion !== 0 ||
          copied.locked ||
          inspection.has(copied.id)
        )
          throw new Error(
            'A copy was moved, navigated or protected by you; it is retained without replay.',
          );
        entry.created = true;
        entry.error = undefined;
        if (!copyState.windows.some((window) => window.projectName === assignment.projectName))
          copyState.windows.push({
            projectName: assignment.projectName,
            windowId: copied.windowId!,
          });
        await save();
        continue;
      }
      if (entry.created)
        throw new Error('A completed copy was closed. Retry will not recreate it.');
      const source = app.records.find(
        (record) => record.id === entry.sourceRecordId && record.live,
      );
      if (
        !source ||
        source.locked ||
        app.memberships.some(
          (membership) => membership.recordId === source.id && membership.source === 'owner',
        ) ||
        inspection.has(source.id) ||
        source.url !== assignment.url ||
        source.navigationVersion !== assignment.navigationVersion
      )
        throw new Error('Original occurrence changed or is protected; no copy was created.');
      const actual = await chrome.tabs.get(source.tabId!);
      if ((suspendedInfo(actual.url, origin)?.url || actual.url) !== assignment.url)
        throw new Error('Original page navigated during creation; no copy was created.');
      const staged = {
        ...newRecord(source.url, entry.recordId),
        sourceRecordId: source.id,
        parentRecordId:
          copyState.entries.find((item) => item.sourceRecordId === source.parentRecordId)
            ?.recordId || null,
        openerRecordId:
          copyState.entries.find((item) => item.sourceRecordId === source.openerRecordId)
            ?.recordId || null,
        branchName: source.branchName || '',
        title: source.title,
        note: source.note,
        tags: [...source.tags],
        favicon: source.favicon,
        content: source.content,
        scroll: source.scroll,
        live: false,
        wasOpen: false,
      };
      await db.put('records', staged);
      const receipt = copyState.windows.find(
        (window) => window.projectName === assignment.projectName,
      );
      let createdTab: chrome.tabs.Tab | undefined;
      if (receipt) {
        if (
          !app.records.some(
            (record) =>
              record.live &&
              record.windowId === receipt.windowId &&
              copyState.entries.some((item) => item.recordId === record.id),
          )
        )
          throw new Error(
            'Project window no longer contains a completed copy. It will not be reused blindly.',
          );
        createdTab = await chrome.tabs.create({
          windowId: receipt.windowId,
          url: makeSuspendedURL(origin, staged),
          active: false,
        });
      } else {
        const created = await chrome.windows.create({
          url: makeSuspendedURL(origin, staged),
          focused: false,
        });
        if (created?.id === undefined)
          throw new Error('Project window creation returned no identity.');
        copyState.windows.push({ projectName: assignment.projectName, windowId: created.id });
        await save();
        createdTab = created.tabs?.find(
          (tab) => suspendedInfo(tab.url, origin)?.recordId === staged.id,
        );
        // Chromium can return the window before its first tab URL commits.
        // Observe the planned UUID; never substitute an unrelated blank tab.
        for (let attempt = 0; !createdTab && attempt < 20; attempt++) {
          if (attempt) await new Promise<void>((resolve) => setTimeout(resolve, 50));
          createdTab = (await chrome.tabs.query({ windowId: created.id })).find(
            (tab) => suspendedInfo(tab.url, origin)?.recordId === staged.id,
          );
        }
      }
      if (createdTab?.id === undefined)
        throw new Error('Copy was not observed; retry will reconcile its planned UUID first.');
      for (
        let attempt = 0;
        suspendedInfo(createdTab.url, origin)?.recordId !== staged.id;
        attempt++
      ) {
        if (attempt >= 20)
          throw new Error(
            'Copy navigation has not committed. Retry will reconcile its UUID first.',
          );
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        createdTab = await chrome.tabs.get(createdTab.id!);
      }
      copied = {
        ...staged,
        live: true,
        wasOpen: true,
        suspended: true,
        tabId: createdTab.id,
        windowId: createdTab.windowId,
        groupId: createdTab.groupId,
        index: createdTab.index,
      };
      await db.put('records', copied);
      app.records.push(copied);
      entry.created = true;
      entry.error = undefined;
      entry.finalWindowId = copied.windowId;
      entry.finalGroupId = copied.groupId;
      entry.finalIndex = copied.index;
      await save();
    } catch (error) {
      entry.error = errorMessage(error);
      await save();
    }
  }
  if (copyState.entries.some((entry) => entry.error || !entry.created)) {
    operation.status = 'partial';
    operation.completedAt = now();
    await db.put('operations', operation);
    return { proposal, operation };
  }
  try {
    if (proposal.status === 'pending')
      proposal = await services.applyCollectionProposal(
        id,
        new Map(copyState.entries.map((entry) => [entry.sourceRecordId, entry.recordId])),
      );
    app = await services.state();
    for (const window of copyState.windows) {
      const project = app.projects.find(
        (item) => item.name.toLowerCase() === window.projectName.toLowerCase(),
      );
      if (!project) throw new Error('Accepted project could not be resolved.');
      await services.bindProject(window.windowId, project.id);
    }
    app = await services.state();
    const projected: CollectionProposal = {
      ...proposal,
      assignments: proposal.assignments
        .filter((item) => !proposal!.excludedRecordIds?.includes(item.recordId))
        .map((assignment) => ({
          ...assignment,
          recordId: copyState.entries.find((entry) => entry.sourceRecordId === assignment.recordId)!
            .recordId,
          navigationVersion: 0,
        })),
    };
    const actions = nativeGroupActions(projected, app);
    if (actions.length) {
      const grouped = await services.applyPlan({
        summary: 'Create reviewed category groups in copied project windows',
        actions,
        collectionProposalId: id,
        provenance: { author: 'ai', model: proposal.model, proposalId: id },
        expected: Object.fromEntries(
          projected.assignments.map((assignment) => {
            const record = app.records.find((item) => item.id === assignment.recordId)!;
            return [
              record.id,
              {
                url: record.url,
                navigationVersion: record.navigationVersion,
                windowId: record.windowId,
                groupId: record.groupId,
              },
            ];
          }),
        ),
      });
      app = await services.state();
      for (const entry of copyState.entries) {
        const record = app.records.find((item) => item.id === entry.recordId)!;
        entry.finalWindowId = record.windowId;
        entry.finalGroupId = record.groupId;
        entry.finalIndex = record.index;
      }
      if (grouped.status !== 'complete')
        throw new Error(
          'Some category groups failed. Completed copies remain; explicit retry will only finish remaining groups.',
        );
    }
    app = await services.state();
    for (const entry of copyState.entries) {
      const record = app.records.find((item) => item.id === entry.recordId)!;
      entry.finalWindowId = record.windowId;
      entry.finalGroupId = record.groupId;
      entry.finalIndex = record.index;
      entry.tree = {
        parentRecordId: record.parentRecordId || null,
        branchName: record.branchName || '',
      };
      const stored = await db.get('records', record.id);
      if (stored) {
        stored.organizationBaseline = fingerprint(record);
        await db.put('records', stored);
      }
    }
    // applyPlan may have updated the proposal journal link. Keep the original copy operation authoritative.
    proposal.copyState = copyState;
    proposal.operationId = operation.id;
    await save();
    const config = await services.settings();
    await services.saveSettings({
      ...config,
      maintainCollectionReview: true,
      reviewProjectWindowsOnly: true,
    });
    operation.status = 'complete';
  } catch (error) {
    operation.status = 'partial';
    copyState.entries[0]!.error = errorMessage(error);
    proposal.copyState = copyState;
    await save();
  }
  operation.completedAt = now();
  await db.put('operations', operation);
  return { proposal, operation };
}

/** Explicit Undo removes only untouched sleeping copies; originals and later/changed tabs stay. */
export async function undoCollectionCopies(
  proposal: CollectionProposal,
  services: Pick<Services, 'state' | 'snapshot'>,
) {
  const app = await services.state();
  const state = proposal.copyState!;
  const before = await services.snapshot('Before removing untouched AI copies');
  const cleanup: Operation = {
    id: uuid(),
    kind: 'collection-copy',
    collectionProposalId: proposal.id,
    snapshotId: before.id,
    summary: 'Undo copied project windows · retain originals and changed copies',
    createdAt: now(),
    status: 'running',
    actions: [],
    results: [],
  };
  await db.put('operations', cleanup);
  state.undoStarted = true;
  state.undoOperationId = cleanup.id;
  await db.put('collectionProposals', proposal);
  const origin = chrome.runtime.getURL('').replace(/\/$/, '');
  const inspection = new Set(
    app.jobs
      .filter((job) => job.status === 'running')
      .flatMap((job) =>
        job.items.filter((item) => item.status === 'loading').map((item) => item.id),
      ),
  );
  const outcomes: RestoreResult[] = [];
  let restored = 0,
    skipped = 0;
  for (const entry of state.entries) {
    const record = app.records.find((item) => item.id === entry.recordId && item.live);
    if (!record) continue;
    const applied = proposal.appliedMemberships?.find(
      (membership) => membership.recordId === record.id,
    );
    const current = app.memberships.find((membership) => membership.recordId === record.id);
    try {
      const actual = await chrome.tabs.get(record.tabId!);
      const info = suspendedInfo(actual.url, origin);
      if (
        record.locked ||
        (record.parentRecordId || null) !== (entry.tree?.parentRecordId || null) ||
        (record.branchName || '') !== (entry.tree?.branchName || '') ||
        app.records.some(
          (child) =>
            child.live &&
            child.parentRecordId === record.id &&
            !state.entries.some((entry) => entry.recordId === child.id),
        ) ||
        inspection.has(record.id) ||
        !info?.owned ||
        info.recordId !== record.id ||
        info.url !== record.url ||
        actual.windowId !== record.windowId ||
        actual.groupId !== record.groupId ||
        record.navigationVersion !== 0 ||
        (entry.finalWindowId !== undefined &&
          (record.windowId !== entry.finalWindowId ||
            record.groupId !== entry.finalGroupId ||
            record.index !== entry.finalIndex)) ||
        (applied &&
          (!current ||
            current.updatedAt !== applied.updatedAt ||
            current.source !== applied.source ||
            current.projectId !== applied.projectId ||
            current.categoryId !== applied.categoryId))
      ) {
        skipped++;
        outcomes.push({
          title: record.title,
          ok: true,
          error: 'Changed, active or protected copy retained.',
        });
        continue;
      }
      await chrome.tabs.remove(record.tabId!);
      await forgetSessionRecord(record.id);
      await db.remove('memberships', record.id);
      entry.removed = true;
      entry.error = undefined;
      await db.put('collectionProposals', proposal);
      restored++;
      outcomes.push({ title: record.title, ok: true });
    } catch (error) {
      entry.error = errorMessage(error);
      await db.put('collectionProposals', proposal);
      outcomes.push({ title: record.title, ok: false, error: errorMessage(error) });
    }
  }
  if (outcomes.every((outcome) => outcome.ok)) {
    proposal.status = 'undone';
    await db.put('collectionProposals', proposal);
    for (const operation of await db.all('operations'))
      if (operation.collectionProposalId === proposal.id) {
        operation.status = 'undone';
        await db.put('operations', operation);
      }
  } else {
    cleanup.status = 'partial';
    cleanup.completedAt = now();
    await db.put('operations', cleanup);
    const creation = await db.get('operations', state.operationId);
    if (creation) {
      creation.status = 'partial';
      await db.put('operations', creation);
    }
  }
  await services.state();
  return { restored, skipped, outcomes };
}
