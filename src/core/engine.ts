import { z } from 'zod';
import { version } from '../../package.json';
import { isNativeNewTabURL } from '../shared/tabs/urls';
import { automaticTabParent, validateTabTree } from '../shared/tabs/tab-tree';
import { saveProposalRevision } from './proposal-history';
import {
  assistantPortableSchema,
  exportAssistantState,
  importAssistantState,
} from './assistant-portable';
import { mergeProposalDrafts } from '../shared/organization/proposal-edits';
import {
  resolveTagReview,
  tagAnalysisSchema,
  tagEvidence,
  tagEvidenceKey,
  tagResultId,
  canonicalTags,
  tagHash,
  type TagAnalysis,
} from '../shared/organization/tag-analysis';
import type {
  AppState,
  Area,
  Backup,
  Bindings,
  Category,
  CollectionProposal,
  CollectionAnalysis,
  ActionAnalysis,
  CollectionDraft,
  InspectionJob,
  Operation,
  Plan,
  PlanAction,
  Membership,
  OrganizationDraft,
  OrganizationProposal,
  OrganizationJob,
  Project,
  Provenance,
  RestoreResult,
  Settings,
  TabRecord,
  WorkItem,
  Snapshot,
  SessionSummary,
} from '../shared/types';
import { errorMessage } from '../shared/types';
import * as db from './db';
import { approvalRuleSchema, currentAssistantTrace } from '../shared/assistant/assistant-actions';
import {
  workspaceEditDraftSchema,
  workspaceEditBaseline,
  workspaceEditRecordIds,
} from '../shared/workspace/workspace-edits';
import { captureSuspendedFavicon } from './tab-favicons';
import { validFavicon } from '../shared/tabs/favicon';
import {
  DEFAULTS,
  COLORS,
  SCHEMA_VERSION,
  uuid,
  now,
  clip,
  pageURL,
  suspendedInfo,
  makeSuspendedURL,
  validateSettings,
  validatePlan,
  validateOrganizationDraft,
  validateArea,
  validateWorkItem,
  validateCollectionDraft,
  organizationDraftSignature,
  importSnapshot,
  newRecord,
  provenanceSchema,
} from '../shared/model';
import { nativeGroupActions } from '../shared/organization/collection';
import { collectionAnalysisSchema } from '../shared/organization/collection-analysis';
import { actionAnalysisSchema } from '../shared/workspace/action-analysis';
import {
  inferenceReceiptSchema,
  type InferenceReceipt,
} from '../shared/inference/inference-receipt';
import { copyCollectionToProjectWindows, undoCollectionCopies } from './collection-copy';
import { matchesSiteList, suspensionBlock } from '../shared/tabs/suspension-policy';
import { captureTabPreview, currentTabPreview, invalidatePreviewCapture } from './tab-previews';
import { createMigrationCoordinator, migrationProgress } from './suspender-migration';
import {
  parkUpdate,
  parkingKey,
  updateTicket,
  updateSummary,
  finishUpdate,
} from './update-parking';
import {
  observeSession,
  retainSessionForResume,
  missingSessionIds,
  sessionForResume,
  savedSessionSummary,
} from './saved-session';

const origin = typeof chrome === 'undefined' ? '' : chrome.runtime.getURL('').replace(/\/$/, '');
let chain: Promise<unknown> = Promise.resolve();
export const serialized = <T>(task: () => Promise<T>): Promise<T> => {
  const result = chain.then(task);
  chain = result.catch(() => {});
  return result;
};
export async function settings(): Promise<Settings> {
  return validateSettings((await chrome.storage.local.get('settings')).settings || DEFAULTS);
}
async function bindings(): Promise<Bindings> {
  const saved = (await chrome.storage.session.get('bindings')).bindings;
  return saved ? (saved as Bindings) : { tabs: {}, windows: {} };
}
async function saveBindings(value: Bindings) {
  await chrome.storage.session.set({ bindings: value });
}
const managed = (t: chrome.tabs.Tab) =>
  !t.incognito && (pageURL(t.url) || suspendedInfo(t.url, origin));
function createImportedRecordId(recordMap: Map<string, string>, sourceId: string): string {
  const id = uuid();
  recordMap.set(sourceId, id);
  return id;
}
function mappedId(map: Map<string, string>, sourceId: string, kind: string): string {
  const id = map.get(sourceId);
  if (!id) throw new Error(`Backup ${kind} reference could not be mapped.`);
  return id;
}
export async function reconcile() {
  const wins = (await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] })).filter(
    (w) => !w.incognito,
  );
  const records = await db.all('records');
  const byId = new Map(records.map((r) => [r.id, r]));
  const bind = await bindings();
  const parked = new Map(
    (await updateTicket())?.parked.map((item) => [parkingKey(item.marker), item.url]) || [],
  );
  const used = new Set();
  const changedRecords: TabRecord[] = [];
  const discoveredRecords: string[] = [];
  const pendingMemberships = new Map<
    string,
    { projectId: string | null; categoryId: string | null }
  >();
  const currentIds = new Set(wins.flatMap((w) => (w.tabs || []).map((t) => String(t.id))));
  // Browser ids are used only within storage.session; match HTTP tabs conservatively after restart.
  for (const w of wins)
    for (const t of w.tabs || []) {
      const parkedURL = parked.get(parkingKey(t.url || ''));
      const pending = suspendedInfo(t.pendingUrl, origin);
      const suspended = pending?.owned ? pending : suspendedInfo(parkedURL || t.url, origin);
      const boundId = bind.tabs[t.id!];
      const bound = boundId ? byId.get(boundId) : undefined;
      const pendingContext = bind.pendingTabs?.[t.id!];
      const nativeNewTab =
        !t.incognito &&
        isNativeNewTabURL(t.pendingUrl || t.url) &&
        Boolean(bound?.nativeNewTab || pendingContext);
      const firstPage = !t.incognito && bound && isNativeNewTabURL(t.url) && pageURL(t.pendingUrl);
      if (!managed(t) && !suspended?.owned && !nativeNewTab && !firstPage) continue;
      const url = suspended?.url || firstPage || (nativeNewTab ? t.pendingUrl || t.url! : t.url!);
      let r: TabRecord | undefined = bound && !used.has(bound.id) ? bound : undefined;
      if (!r && pendingContext) {
        r = newRecord(url, pendingContext.recordId);
        r.parentRecordId = pendingContext.parentRecordId || null;
        pendingMemberships.set(r.id, pendingContext);
      }
      if (!r && suspended?.owned && suspended.recordId && !used.has(suspended.recordId))
        r = byId.get(suspended.recordId) || newRecord(url, suspended.recordId);
      if (!r)
        r = records
          .filter(
            (x) =>
              !used.has(x.id) &&
              x.url === url &&
              x.wasOpen &&
              !Object.entries(bind.tabs).some(
                ([tabId, id]) => id === x.id && currentIds.has(tabId),
              ),
          )
          .sort(
            (a, b) =>
              Number(b.suspended === Boolean(suspended)) -
                Number(a.suspended === Boolean(suspended)) ||
              Number(b.pinned === t.pinned) - Number(a.pinned === t.pinned),
          )[0];
      if (!r) r = newRecord(url);
      if (!byId.has(r.id)) discoveredRecords.push(r.id);
      const before = JSON.stringify(r);
      used.add(r.id);
      if (r.url !== url) {
        r.content = null;
        r.suspendedFavicon = undefined;
        r.navigationVersion = (r.navigationVersion || 0) + 1;
      }
      Object.assign(r, {
        url,
        nativeNewTab: nativeNewTab ? true : undefined,
        title: suspended?.title || t.title || url,
        favicon: suspended ? r.favicon : t.favIconUrl || r.favicon,
        suspendedFavicon: r.suspendedFavicon || suspended?.favicon,
        scroll: suspended?.scroll ?? r.scroll ?? 0,
        suspended: Boolean(suspended),
        foreignSuspended: Boolean(suspended && !suspended.owned),
        tabId: t.id!,
        windowId: w.id!,
        index: t.index,
        groupId: t.groupId,
        splitViewId: t.splitViewId,
        pinned: t.pinned,
        audible: t.audible,
        muted: t.mutedInfo?.muted || false,
        active: t.active,
        lastAccessed: Math.max(t.lastAccessed || 0, r.lastAccessed || 0) || now(),
        lastSeen: now() - (r.lastSeen || 0) > 60000 ? now() : r.lastSeen,
        live: true,
        wasOpen: true,
        projectId: bind.windows[w.id!] || null,
      });
      // Carry project identity across a full restart when the tab identity can be matched.
      if (!bind.windows[w.id!] && r.projectId === null) {
        const original = JSON.parse(before);
        if (original.projectId && original.wasOpen) {
          bind.windows[w.id!] = original.projectId;
          r.projectId = original.projectId;
        }
      }
      bind.tabs[t.id!] = r.id;
      byId.set(r.id, r);
      if (before !== JSON.stringify(r)) changedRecords.push(r);
    }
  const openers = new Map(
    wins.flatMap((window) =>
      (window.tabs || []).flatMap((tab) => {
        const id = bind.tabs[tab.id!];
        return id
          ? [
              [
                id,
                tab.openerTabId === undefined ? null : bind.tabs[tab.openerTabId] || null,
              ] as const,
            ]
          : [];
      }),
    ),
  );
  const resolving = new Set<string>();
  function inferParent(record: TabRecord) {
    if (record.parentRecordId !== undefined) return;
    resolving.add(record.id);
    const opener = byId.get(openers.get(record.id) || '');
    if (opener && !resolving.has(opener.id)) inferParent(opener);
    record.openerRecordId = opener?.id || null;
    record.parentRecordId =
      opener && !resolving.has(opener.id)
        ? automaticTabParent(opener.id, [...byId.values()])
        : null;
    resolving.delete(record.id);
    if (!changedRecords.includes(record)) changedRecords.push(record);
  }
  for (const id of openers.keys()) {
    const record = byId.get(id);
    if (record) inferParent(record);
  }
  for (const r of byId.values())
    if (!used.has(r.id) && r.live) {
      r.live = false;
      changedRecords.push(r);
    }
  if (changedRecords.length)
    await db.database.transaction(
      'rw',
      ['records', 'memberships', 'projects', 'categories'],
      async () => {
        await db.database.records.bulkPut(changedRecords);
        for (const recordId of discoveredRecords)
          if (!(await db.get('memberships', recordId))) {
            const pending = pendingMemberships.get(recordId);
            const openerId = byId.get(recordId)?.openerRecordId;
            const inherited = openerId ? await db.get('memberships', openerId) : undefined;
            const context = pending || inherited;
            const project = context?.projectId
              ? await db.get('projects', context.projectId)
              : undefined;
            const category = context?.categoryId
              ? await db.get('categories', context.categoryId)
              : undefined;
            await db.put('memberships', {
              recordId,
              projectId: project?.id || null,
              categoryId: project && category?.projectId === project.id ? category.id : null,
              source: pending ? 'owner' : inherited ? 'inherited' : 'unassigned',
              updatedAt: now(),
            } satisfies Membership);
          }
      },
    );
  for (const id of Object.keys(bind.pendingTabs || {}))
    if (!currentIds.has(id) || used.has(bind.pendingTabs![Number(id)]!.recordId))
      delete bind.pendingTabs![Number(id)];
  for (const id of Object.keys(bind.tabs)) if (!currentIds.has(id)) delete bind.tabs[Number(id)];
  const windowIds = new Set(wins.map((w) => String(w.id)));
  for (const id of Object.keys(bind.windows))
    if (!windowIds.has(id)) delete bind.windows[Number(id)];
  await saveBindings(bind);
  const [allGroups, projects] = await Promise.all([chrome.tabGroups.query({}), db.all('projects')]);
  await observeSession({
    id: uuid(),
    createdAt: now(),
    label: 'Latest observed session',
    automatic: true,
    windows: wins
      .map((window) => ({
        id: window.id!,
        focused: false,
        projectId: bind.windows[window.id!] || null,
        projectName:
          projects.find((project) => project.id === bind.windows[window.id!])?.name || '',
        groups: allGroups
          .filter((group) => group.windowId === window.id)
          .map((group) => ({
            id: group.id,
            title: group.title || '',
            color: group.color,
            collapsed: group.collapsed,
          })),
        tabs: [...byId.values()]
          .filter((record) => record.live && record.windowId === window.id)
          .sort((a, b) => a.index - b.index)
          .map((record) => ({
            recordId: record.id,
            parentRecordId: record.parentRecordId || null,
            openerRecordId: record.openerRecordId || null,
            branchName: record.branchName || '',
            nativeNewTab: record.nativeNewTab,
            url: record.url,
            title: record.title,
            scroll: record.scroll,
            index: record.index,
            groupId: record.groupId,
            pinned: record.pinned,
            muted: record.muted,
            suspendedFavicon: record.suspendedFavicon,
            suspended: record.suspended,
            locked: record.locked,
            projectId: record.projectId,
            note: record.note,
            tags: record.tags,
          })),
      }))
      .filter((window) => window.tabs.length),
  });
  return wins;
}
export const preserveSession = retainSessionForResume;
export async function saveSession(replaceMissing = false): Promise<SessionSummary> {
  if (await updateTicket())
    throw new Error('Finish the interrupted update before replacing the saved session.');
  await reconcile();
  const current = await db.get('sessions', 'current');
  const records = await db.all('records');
  if (!replaceMissing && (await savedSessionSummary(records))?.missingTabs)
    throw new Error('Resume missing session tabs before replacing the saved session.');
  if (
    !current ||
    missingSessionIds(current.snapshot, records).length ||
    !records.some((record) => record.live)
  )
    throw new Error('No complete open collection to save. Resume the saved session first.');
  const uncached = records.filter(
    (record) => record.live && !validFavicon(record.suspendedFavicon),
  );
  for (let offset = 0; offset < uncached.length; offset += 4)
    await Promise.all(
      uncached.slice(offset, offset + 4).map(async (record) => {
        const icon = await captureSuspendedFavicon(record.url);
        if (icon) {
          record.suspendedFavicon = icon;
          await db.put('records', record);
        }
      }),
    );
  const iconById = new Map(records.map((record) => [record.id, record.suspendedFavicon]));
  const saved = {
    ...current.snapshot,
    windows: current.snapshot.windows.map((window) => ({
      ...window,
      tabs: window.tabs.map((tab) => ({
        ...tab,
        suspendedFavicon: iconById.get(tab.recordId) || tab.suspendedFavicon,
      })),
    })),
    id: uuid(),
    createdAt: now(),
    label: 'Saved session',
    automatic: false,
  };
  const previous = await db.get('sessions', 'recovery');
  if (previous) await db.put('snapshots', previous.snapshot);
  await db.put('snapshots', saved);
  await db.put('sessions', { id: 'current', snapshot: saved });
  await db.put('sessions', { id: 'recovery', snapshot: saved });
  return (await savedSessionSummary(records))!;
}
async function resumeSavedSnapshot(saved: Snapshot, ids?: string[], sameBrowserUpdate = false) {
  await reconcile();
  const missing = missingSessionIds(saved, await db.all('records')).filter(
    (id) => !ids || ids.includes(id),
  );
  if (!missing.length) return [];
  await db.put('snapshots', saved);
  const before = await snapshot('Before resuming saved session', true);
  const operation: Operation = {
    id: uuid(),
    createdAt: now(),
    snapshotId: before.id,
    kind: 'session-resume',
    summary: `Resume ${missing.length} missing session tabs`,
    status: 'running',
    actions: missing.map((id) => ({ type: 'suspend', recordIds: [id] })),
    results: [],
  };
  await db.put('operations', operation);
  try {
    const outcomes = await restoreSnapshot(saved.id, {
      onlyMissing: true,
      onlyRecordIds: missing,
      reuseWindowIds: sameBrowserUpdate ? saved.windows.map((window) => window.id) : [],
      onOutcome: async (outcome) => {
        operation.results.push({
          action: {
            type: 'suspend',
            recordIds: outcome.sourceRecordId ? [outcome.sourceRecordId] : [],
          },
          ok: outcome.ok,
          error: outcome.error,
        });
        await db.put('operations', operation);
      },
    });
    operation.status = outcomes.every((outcome) => outcome.ok) ? 'complete' : 'partial';
    operation.completedAt = now();
    await db.put('operations', operation);
    return outcomes;
  } catch (error) {
    operation.status = 'partial';
    operation.completedAt = now();
    await db.put('operations', operation);
    throw error;
  }
}
export async function resumeSession() {
  if (await updateTicket())
    throw new Error('Finish the interrupted update before resuming missing tabs.');
  const saved = await sessionForResume();
  if (!saved)
    throw new Error('No saved session. Import your backup or restore through Tabox first.');
  return resumeSavedSnapshot(saved.snapshot);
}
export async function prepareSessionReload() {
  if (
    (await db.all('operations')).some((operation) => operation.status === 'running') ||
    (await db.all('jobs')).some((job) => ['queued', 'running'].includes(job.status))
  )
    throw new Error('Wait for active browser operations and inspections before reloading.');
  await saveSession();
  const saved = (await db.get('sessions', 'current'))!;
  const recordIds = (await db.all('records'))
    .filter((record) => record.live)
    .map((record) => record.id);
  await parkUpdate(saved.snapshot.id, recordIds);
}
export async function finishSessionReload(sameBrowserUpdate = false) {
  const ticket = await updateTicket();
  // The already-installed pre-parking build can only authorize recreation on its first upgrade.
  if (ticket && !ticket.operationId && !ticket.parked.length) {
    if (
      !sameBrowserUpdate ||
      ticket.claimed ||
      !ticket.ready ||
      now() - ticket.requestedAt > 120_000 ||
      ticket.requestedAt > now()
    )
      return false;
    await chrome.storage.local.remove('sessionReload');
    const saved = await db.get('snapshots', ticket.snapshotId);
    if (!saved) return false;
    await resumeSavedSnapshot(saved, ticket.recordIds, true);
    return true;
  }
  return finishUpdate(sameBrowserUpdate);
}
export function organizationFingerprint(record: TabRecord): string {
  return JSON.stringify([
    record.url,
    record.navigationVersion,
    record.title,
    record.windowId,
    record.groupId,
  ]);
}
export async function recoverOrganizationEvents(previous: ReadonlyMap<number, string>) {
  await reconcile();
  const records = await db.all('records');
  return records
    .filter(
      (record) =>
        record.live &&
        record.tabId !== undefined &&
        previous.get(record.tabId) !== organizationFingerprint(record),
    )
    .flatMap((record) => (record.tabId === undefined ? [] : [record.tabId]));
}
export async function state(): Promise<AppState> {
  const windows = await reconcile();
  const recordsNow = await db.all('records');
  const legacyMemberships = await db.all('memberships');
  const knownMemberships = new Map(
    legacyMemberships.map((membership) => [membership.recordId, membership]),
  );
  for (const record of recordsNow) {
    const membership = knownMemberships.get(record.id);
    if (record.live && record.projectId && !membership)
      await db.put('memberships', {
        recordId: record.id,
        projectId: record.projectId,
        categoryId: null,
        source: 'legacy',
        updatedAt: now(),
      });
  }
  const [
    records,
    projects,
    areas,
    workItems,
    categories,
    memberships,
    proposals,
    collectionProposals,
    organizationJobs,
    snapshots,
    operations,
    jobs,
    config,
    groups,
  ] = await Promise.all([
    db.all('records'),
    db.all('projects'),
    db.all('areas'),
    db.all('workItems'),
    db.all('categories'),
    db.all('memberships'),
    db.all('proposals'),
    db.all('collectionProposals'),
    db.all('organizationJobs'),
    db.all('snapshots'),
    db.all('operations'),
    db.all('jobs'),
    settings(),
    chrome.tabGroups.query({}),
  ]);
  const bind = await bindings();
  const membershipMap = new Map(memberships.map((membership) => [membership.recordId, membership]));
  const latestMigration = await db.database.migrations.orderBy('createdAt').reverse().first();
  return {
    session: await savedSessionSummary(records),
    tagVocabulary: [...new Set(records.flatMap((record) => record.tags))].sort(),
    assistantChanges: (
      await db.database.assistantChanges.orderBy('createdAt').reverse().limit(100).toArray()
    ).map(({ deltas, ...trace }) =>
      currentAssistantTrace(
        { ...trace, deltas: [], deltaCount: deltas.length },
        operations.find((item) => item.id === trace.operationId),
      ),
    ),
    assistantApprovalRules: approvalRuleSchema
      .array()
      .catch([])
      .parse((await chrome.storage.local.get('assistantApprovalRules')).assistantApprovalRules),
    update: await updateSummary(),
    migration: latestMigration ? migrationProgress(latestMigration) : null,
    records: records
      .filter((r) => r.live)
      .map((record) => ({
        ...record,
        projectId: membershipMap.has(record.id)
          ? membershipMap.get(record.id)!.projectId
          : record.projectId,
      })),
    projects,
    areas: areas.sort((a, b) => a.name.localeCompare(b.name)),
    workItems: workItems.sort((a, b) => b.updatedAt - a.updatedAt),
    categories,
    memberships,
    proposals: proposals.sort((a, b) => b.createdAt - a.createdAt),
    collectionProposals: collectionProposals.sort((a, b) => b.createdAt - a.createdAt),
    organizationJobs: organizationJobs
      .filter((job) => ['queued', 'running', 'error'].includes(job.status))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 100),
    windows: windows.map((w) => ({
      id: w.id!,
      focused: w.focused,
      projectId: bind.windows[w.id!] || null,
    })),
    groups: groups.filter((g) => windows.some((w) => w.id === g.windowId)),
    snapshots: snapshots
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((snapshot) => ({
        id: snapshot.id,
        createdAt: snapshot.createdAt,
        label: snapshot.label,
        automatic: snapshot.automatic,
        windowCount: snapshot.windows.length,
        tabCount: snapshot.windows.reduce((count, window) => count + window.tabs.length, 0),
      })),
    operations: operations
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(({ actions, results, ...operation }) => ({
        ...operation,
        recoveryAvailable:
          Boolean(operation.tabCommand) ||
          operation.kind === 'collection-copy' ||
          snapshots.some((snapshot) => snapshot.id === operation.snapshotId),
        postState: undefined,
        canRedo:
          operation.status === 'undone' &&
          Boolean(operation.undoState) &&
          !operation.redoOperationId,
        undoState: undefined,
        actionCount: actions.length || (operation.tabCommand ? 1 : 0),
        affectedOccurrences: operation.tabCommand
          ? 1
          : new Set(actions.flatMap((action) => action.recordIds)).size,
        successfulActions: results.filter((result) => result.ok).length,
        failedActions: results.filter((result) => !result.ok).length,
        errors: results
          .filter((result) => !result.ok && result.error !== undefined)
          .slice(0, 5)
          .map((result) => result.error!),
      })),
    jobs: jobs.sort((a, b) => b.createdAt - a.createdAt),
    settings: config,
    version,
  };
}
export async function snapshot(label = 'Automatic checkpoint', automatic = false) {
  const app = await state();
  const value = {
    id: uuid(),
    createdAt: now(),
    label: clip(label, 200),
    automatic,
    windows: app.windows
      .map((w) => ({
        ...w,
        projectName: app.projects.find((p) => p.id === w.projectId)?.name || '',
        groups: app.groups
          .filter((g) => g.windowId === w.id)
          .map((g) => ({ id: g.id, title: g.title || '', color: g.color, collapsed: g.collapsed })),
        tabs: app.records
          .filter((r) => r.windowId === w.id)
          .sort((a, b) => a.index - b.index)
          .map((r) => ({
            recordId: r.id,
            parentRecordId: r.parentRecordId || null,
            openerRecordId: r.openerRecordId || null,
            branchName: r.branchName || '',
            nativeNewTab: r.nativeNewTab,
            url: r.url,
            title: r.title,
            scroll: r.scroll,
            index: r.index,
            groupId: r.groupId,
            pinned: r.pinned,
            muted: r.muted,
            suspendedFavicon: r.suspendedFavicon,
            suspended: r.suspended,
            locked: r.locked || false,
            projectId: w.projectId,
            note: r.note || '',
            tags: r.tags || [],
          })),
      }))
      .filter((w) => w.tabs.length),
  };
  await db.put('snapshots', value);
  await pruneSnapshots(app.settings);
  return value;
}
export async function pruneSnapshots(config: Settings) {
  const snapshots = await db.database.snapshots.orderBy('createdAt').reverse().toArray();
  const protectedIds = new Set(
    (await db.all('operations'))
      .filter((operation) => operation.status === 'running')
      .map((operation) => operation.snapshotId),
  );
  const ticket = await updateTicket();
  if (ticket) protectedIds.add(ticket.snapshotId);
  const expired = snapshots
    .slice(config.snapshotRetention)
    .filter((snapshot) => !protectedIds.has(snapshot.id));
  await db.database.snapshots.bulkDelete(expired.map((snapshot) => snapshot.id));
}
async function currentRecord(id: string) {
  const r = await db.get('records', id);
  if (!r?.live) throw new Error('This tab is no longer open.');
  const tab = await chrome.tabs.get(r.tabId!);
  const destination = tab.pendingUrl || tab.url;
  const original = suspendedInfo(destination, origin)?.url || destination;
  if (original !== r.url) throw new Error('Tab navigated; refresh before continuing.');
  return { r, tab };
}
async function readPage(tab: chrome.tabs.Tab, config: Settings) {
  if (!pageURL(tab.url)) throw new Error('Page is suspended or cannot be inspected.');
  const pattern = `${new URL(tab.url!).origin}/*`;
  if (!(await chrome.permissions.contains({ origins: [pattern] })))
    throw new Error('Grant page access in Settings before inspecting this site.');
  await chrome.scripting.executeScript({ target: { tabId: tab.id! }, files: ['reader.js'] });
  const result = await chrome.scripting.executeScript({
    target: { tabId: tab.id! },
    func: (limit) => globalThis.__tabloomReader?.(limit),
    args: [config.textLimit],
  });
  if (!result[0]?.result) throw new Error('No readable page content.');
  return result[0].result;
}
export async function indexLoaded(id: string) {
  const { r, tab } = await currentRecord(id);
  const config = await settings();
  const content = await readPage(tab, config);
  if (content.url !== r.url) throw new Error('Page changed while inspecting.');
  r.content = content;
  r.scroll = content.scroll;
  r.title = content.title || r.title;
  await db.put('records', r);
  return r;
}
async function suspendOne(
  id: string,
  {
    automatic = false,
    capture = true,
    expected,
  }: {
    automatic?: boolean;
    capture?: boolean;
    expected?: { wrapper: string; windowId: number; groupId: number };
  } = {},
) {
  const { r, tab } = await currentRecord(id);
  const config = await settings();
  if (suspendedInfo(tab.url, origin)?.owned) return { skipped: 'Already suspended' };
  if (r.locked) throw new Error(`Protected: ${r.title}`);
  const blocked = suspensionBlock(r, tab, config, automatic);
  if (blocked) return { skipped: blocked };
  if (!r.foreignSuspended && capture) {
    try {
      const content = await readPage(tab, config);
      if (content.url !== r.url) throw new Error('Page navigated while suspending.');
      r.content = content;
      r.scroll = content.scroll;
      r.title = content.title || r.title;
      if ((config.protectForms && content.dirty) || (config.protectAudio && content.playing)) {
        await db.put('records', r);
        return { skipped: 'Unsaved input or playing media' };
      }
    } catch (e) {
      if (automatic) return { skipped: 'Page protection could not be checked' };
      // Explicit manual suspension works without page permission; browser state cannot be captured.
      if (!/Grant page access/.test(errorMessage(e))) throw e;
    }
  }
  if (!r.foreignSuspended && capture) await captureTabPreview(r, config);
  r.suspendedFavicon = (await captureSuspendedFavicon(r.url)) || r.suspendedFavicon;
  await db.put('records', r);
  // Recheck immediately before navigation; inspection awaits can race user navigation.
  const fresh = await chrome.tabs.get(tab.id!);
  if (
    expected &&
    (fresh.url !== expected.wrapper ||
      fresh.windowId !== expected.windowId ||
      fresh.groupId !== expected.groupId)
  )
    throw new Error('Placeholder navigated or moved before import; retained without importing.');
  if ((suspendedInfo(fresh.url, origin)?.url || fresh.url) !== r.url)
    throw new Error('Page navigated before suspension.');
  const freshBlocked = suspensionBlock(r, fresh, config, automatic);
  if (freshBlocked) return { skipped: freshBlocked };
  await chrome.tabs.update(tab.id!, { url: makeSuspendedURL(origin, r) });
  r.suspended = true;
  r.foreignSuspended = false;
  await db.put('records', r);
  return { done: true };
}
async function wakeOne(id: string) {
  const { r, tab } = await currentRecord(id);
  if (!suspendedInfo(tab.url, origin)) return { skipped: 'Already awake' };
  if ((await settings()).restoreScroll)
    await chrome.storage.session.set({ [`scroll:${r.tabId}`]: { url: r.url, pos: r.scroll || 0 } });
  await chrome.tabs.update(tab.id!, { url: r.url });
  r.suspended = false;
  r.foreignSuspended = false;
  await db.put('records', r);
  return { done: true };
}
async function executeAction(action: PlanAction) {
  const entries = [];
  for (const id of action.recordIds) entries.push(await currentRecord(id));
  if (entries.some(({ r }) => r.locked))
    throw new Error('A tab was protected after this plan was generated.');
  const tabIds = entries.map((x) => x.tab.id!) as [number, ...number[]];
  // Read native state again after the snapshot: a split can be created while we await storage.
  if (['group', 'ungroup', 'move', 'moveGroup', 'reorder', 'pin'].includes(action.type)) {
    for (const { tab } of entries)
      if (tab.splitViewId !== undefined && tab.splitViewId >= 0)
        throw new Error(
          'This tab is in a native split. Unsplit it in the browser before changing its placement.',
        );
  }
  if (action.type === 'group') {
    await chrome.windows.get(action.windowId!);
    const groups = await chrome.tabGroups.query({ windowId: action.windowId! });
    const matching = groups.filter((g) => (g.title || '') === action.name);
    const existing =
      action.nativeGroupId !== undefined
        ? groups.find((group) => group.id === action.nativeGroupId)
        : matching.length === 1
          ? matching[0]
          : undefined;
    if (action.nativeGroupId !== undefined && (!existing || (existing.title || '') !== action.name))
      throw new Error('The target native group changed. Refresh before grouping.');
    if (action.nativeGroupId === undefined && matching.length > 1)
      throw new Error('Multiple native groups have this name. Drop onto the exact group instead.');
    const elsewhere = entries
      .filter((x) => x.tab.windowId !== action.windowId)
      .map((x) => x.tab.id!);
    if (elsewhere.length)
      await chrome.tabs.move(elsewhere, { windowId: action.windowId!, index: -1 });
    const id = await chrome.tabs.group(
      existing
        ? { groupId: existing.id, tabIds }
        : { createProperties: { windowId: action.windowId! }, tabIds },
    );
    if (!existing)
      await chrome.tabGroups.update(id, {
        title: action.name || '',
        color: action.color || 'grey',
      });
  } else if (action.type === 'moveGroup') {
    const members = await chrome.tabs.query({ groupId: action.nativeGroupId! });
    if (members.length !== tabIds.length || members.some((tab) => !tabIds.includes(tab.id!)))
      throw new Error('Native group membership changed after the snapshot; nothing was moved.');
    await chrome.tabGroups.move(action.nativeGroupId!, { windowId: action.windowId!, index: -1 });
  } else if (action.type === 'move') {
    await chrome.windows.get(action.windowId!);
    await chrome.tabs.move(tabIds, { windowId: action.windowId!, index: -1 });
  } else if (action.type === 'reorder') {
    if (entries.length !== 1 || action.index === undefined)
      throw new Error('Reordering requires one tab and a destination index.');
    await chrome.tabs.move(tabIds[0], { windowId: entries[0]!.tab.windowId!, index: action.index });
  } else if (action.type === 'ungroup') await chrome.tabs.ungroup(tabIds);
  else if (action.type === 'pin' || action.type === 'mute') {
    for (const tabId of tabIds)
      await chrome.tabs.update(
        tabId,
        action.type === 'pin' ? { pinned: action.enabled! } : { muted: action.enabled! },
      );
  } else {
    const outcomes = [];
    for (const id of action.recordIds)
      outcomes.push(await (action.type === 'suspend' ? suspendOne(id) : wakeOne(id)));
    return outcomes;
  }
  return [{ done: true }];
}
export async function applyPlan(raw: Plan, onPrepared?: (operation: Operation) => Promise<void>) {
  const app = await state();
  const plan = validatePlan(raw, app.records, app.windows);
  plan.actions = plan.actions.flatMap((action) =>
    action.type === 'pin' || action.type === 'mute' || action.type === 'wake'
      ? action.recordIds.map((id) => ({ ...action, recordIds: [id] }))
      : [action],
  );
  if (!plan.actions.length) throw new Error('There are no actions to apply.');
  const inspectionTargets = new Set(
    app.jobs
      .filter((job) => job.status === 'running')
      .flatMap((job) =>
        job.items.filter((item) => item.status === 'loading').map((item) => item.id),
      ),
  );
  for (const a of plan.actions)
    for (const id of a.recordIds) {
      const r = app.records.find((r) => r.id === id);
      const expected = raw.expected?.[id];
      if (inspectionTargets.has(id))
        throw new Error(
          'An active inspection target is protected from browser changes. Wait for inspection to finish.',
        );
      if (
        expected &&
        (expected.url !== r!.url ||
          expected.navigationVersion !== r!.navigationVersion ||
          (expected.windowId !== undefined && expected.windowId !== r!.windowId) ||
          (expected.groupId !== undefined && expected.groupId !== r!.groupId))
      )
        throw new Error(
          'Plan is stale: a page navigated or its browser location changed. Generate another plan.',
        );
    }
  const before = await snapshot(plan.summary || 'Before tab changes');
  const operation: Operation = {
    provenance: plan.provenance,
    collectionProposalId: plan.collectionProposalId,
    id: uuid(),
    createdAt: now(),
    snapshotId: before.id,
    summary: plan.summary || 'Tab changes',
    postState: {},
    status: 'running',
    actions: plan.actions,
    results: [],
    ...(plan.actions.filter((action) => action.type === 'wake').length > 1
      ? { queued: true, expected: raw.expected }
      : {}),
  };
  await db.put('operations', operation);
  if (plan.collectionProposalId) {
    const proposal = await db.get('collectionProposals', plan.collectionProposalId);
    if (!proposal || proposal.status !== 'applied')
      throw new Error('Collection organization is no longer applied.');
    proposal.operationId ||= operation.id;
    await db.put('collectionProposals', proposal);
  }
  await onPrepared?.(operation);
  if (operation.queued) return operation;
  for (const action of plan.actions) {
    try {
      for (const id of action.recordIds) {
        const expected = raw.expected?.[id];
        const current = await currentRecord(id);
        if (
          expected &&
          (expected.url !== current.r.url ||
            expected.navigationVersion !== current.r.navigationVersion ||
            (expected.windowId !== undefined && expected.windowId !== current.tab.windowId) ||
            (expected.groupId !== undefined && expected.groupId !== current.tab.groupId))
        )
          throw new Error('Tab changed after the snapshot; this action was skipped.');
      }
      operation.results.push({ action, outcomes: await executeAction(action), ok: true });
      await captureOperationPostState(operation, action.recordIds);
    } catch (e) {
      operation.results.push({ action, ok: false, error: errorMessage(e) });
    }
    await db.put('operations', operation);
  }
  operation.status = operation.results.every((r) => r.ok) ? 'complete' : 'partial';
  operation.completedAt = now();
  await captureOperationPostState(operation, [
    ...new Set(
      operation.results.filter((item) => item.ok).flatMap((item) => item.action.recordIds),
    ),
  ]);
  await db.put('operations', operation);
  await reconcile();
  return operation;
}
// Each call is a short serialized step. Page loading never holds the coordinator queue.
function operationTabState(record: TabRecord, tab: chrome.tabs.Tab) {
  const destination = tab.pendingUrl || tab.url;
  if ((suspendedInfo(destination, origin)?.url || destination) !== record.url)
    throw new Error('The tab has another navigation pending; retained.');
  return {
    url: record.url,
    windowId: tab.windowId,
    groupId: tab.groupId,
    index: tab.index,
    pinned: tab.pinned,
    muted: Boolean(tab.mutedInfo?.muted),
    suspended: Boolean(suspendedInfo(destination, origin) || tab.discarded),
  };
}
async function captureOperationPostState(operation: Operation, ids: string[]) {
  operation.postState ||= {};
  for (const id of ids) {
    try {
      const { r, tab } = await currentRecord(id);
      operation.postState[id] = operationTabState(r, tab);
    } catch {
      delete operation.postState[id];
      /* No proof of the resulting identity; Undo must retain this target. */
    }
  }
}
export async function wakeOperationStep() {
  const operation = (
    await db.database.operations
      .where('status')
      .equals('running')
      .filter((entry) => Boolean(entry.queued))
      .sortBy('createdAt')
  )[0];
  if (!operation) return;
  const action = operation.actions[operation.results.length];
  try {
    if (!action) {
      operation.status = operation.results.every((result) => result.ok) ? 'complete' : 'partial';
      operation.completedAt = now();
      await captureOperationPostState(operation, [
        ...new Set(
          operation.results.filter((item) => item.ok).flatMap((item) => item.action.recordIds),
        ),
      ]);
    } else if (operation.activeWake) {
      const { tab } = await currentRecord(operation.activeWake.recordId);
      operation.activeWake.tabId = tab.id!;
      if (suspendedInfo(tab.url, origin) && tab.status !== 'loading') {
        operation.status = 'interrupted';
        operation.pauseReason = 'The page is still sleeping. Resume to retry this occurrence.';
        operation.activeWake = undefined;
        await db.put('operations', operation);
        return;
      }
      if (tab.status === 'complete') {
        operation.results.push({ action, ok: true, outcomes: [{ done: true }] });
        operation.activeWake = undefined;
      } else if (now() - operation.activeWake.startedAt >= 30000) {
        operation.status = 'interrupted';
        operation.pauseReason =
          'A page is still loading after 30 seconds. No further tabs were woken. Resume to keep waiting, or pause and inspect that page.';
      }
    } else {
      for (const id of action.recordIds) {
        const { r, tab } = await currentRecord(id);
        const expected = operation.expected?.[id];
        if (
          r.locked ||
          (expected &&
            (expected.url !== r.url || expected.navigationVersion !== r.navigationVersion))
        )
          throw new Error('A target changed or is protected; remaining tabs were not touched.');
        if (
          (await db.all('jobs')).some(
            (job) =>
              job.status === 'running' &&
              job.items.some((item) => item.id === id && item.status === 'loading'),
          )
        )
          throw new Error('An inspection is using this tab. Pause inspection before continuing.');
        if (action.type === 'wake' && suspendedInfo(tab.url, origin)) {
          operation.activeWake = { recordId: id, tabId: tab.id!, startedAt: now() };
          await db.put('operations', operation);
        }
      }
      const outcomes = await executeAction(action);
      await captureOperationPostState(operation, action.recordIds);
      if (!operation.activeWake) operation.results.push({ action, outcomes, ok: true });
    }
  } catch (error) {
    operation.status = 'interrupted';
    operation.pauseReason = errorMessage(error);
  }
  await db.put('operations', operation);
}
export async function controlWakeOperation(id: string, resume: boolean) {
  const operation = await db.get('operations', id);
  if (!operation?.queued || !['running', 'interrupted'].includes(operation.status))
    throw new Error('This wake operation cannot be resumed or paused.');
  operation.status = resume ? 'running' : 'interrupted';
  operation.pauseReason = resume ? undefined : 'Paused by you. Remaining tabs are unchanged.';
  if (resume && operation.activeWake) operation.activeWake.startedAt = now();
  await db.put('operations', operation);
  return operation;
}
export async function restoreSnapshot(
  id: string,
  {
    newWindows = false,
    onlyRecordIds,
    restoreLoadingRecordIds = [],
    onlyMissing = false,
    onOutcome,
    reuseWindowIds = [],
  }: {
    newWindows?: boolean;
    onlyRecordIds?: string[];
    restoreLoadingRecordIds?: string[];
    onlyMissing?: boolean;
    onOutcome?: (outcome: RestoreResult) => Promise<void>;
    reuseWindowIds?: number[];
  } = {},
) {
  const saved = await db.get('snapshots', id);
  if (!saved) throw new Error('Snapshot not found.');
  validateTabTree(
    saved.windows.flatMap((window) =>
      window.tabs.map((tab) => ({ id: tab.recordId, parentRecordId: tab.parentRecordId })),
    ),
  );
  await snapshot(`Before restoring ${saved.label}`);
  await reconcile();
  const bind = await bindings();
  const records = await db.all('records');
  const byId = new Map(records.map((r) => [r.id, r]));
  const existing = (
    await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] })
  ).filter((window) => !window.incognito);
  const claimedWindows = new Set<number>();
  const outcomes: RestoreResult[] = [];
  const scope = onlyRecordIds ? new Set(onlyRecordIds) : undefined;
  const inspectionTargets = new Set(
    (await db.all('jobs'))
      .filter((job) => job.status === 'running')
      .flatMap((job) =>
        job.items.filter((item) => item.status === 'loading').map((item) => item.id),
      ),
  );
  for (const w of saved.windows) {
    if (scope && !w.tabs.some((tab) => scope.has(tab.recordId))) continue;
    if (
      onlyMissing &&
      !w.tabs.some((tab) => (!scope || scope.has(tab.recordId)) && !byId.get(tab.recordId)?.live)
    )
      continue;
    let target: chrome.windows.Window | undefined = newWindows
      ? undefined
      : existing.find((x) => x.id === w.id && !claimedWindows.has(x.id!));
    // Reuse only a window actually containing one of the original tab identities, never an unrelated recycled id.
    const originalTargetId = target?.id;
    if (
      target &&
      !reuseWindowIds.includes(w.id) &&
      !w.tabs.some(
        (t) => byId.get(t.recordId)?.live && byId.get(t.recordId)?.windowId === originalTargetId,
      )
    )
      target = undefined;
    if (!target && !newWindows) {
      const projectWindow = existing.find(
        (x) => w.projectId && bind.windows[x.id!] === w.projectId && !claimedWindows.has(x.id!),
      );
      target = projectWindow;
    }
    let blankId;
    if (!target) {
      target = await chrome.windows.create({ focused: false });
      if (!target) throw new Error('Window could not be created');
      blankId = target.tabs?.[0]?.id;
      existing.push(target);
    }
    claimedWindows.add(target.id!);
    if (w.projectId) bind.windows[target.id!] = w.projectId;
    const groupTabs = new Map<number, number[]>();
    let targetTabCount = target.tabs?.length || 0;
    let position = 0;
    for (const t of w.tabs || []) {
      if (scope && !scope.has(t.recordId)) continue;
      if (onlyMissing && byId.get(t.recordId)?.live) continue;
      try {
        let r = byId.get(t.recordId);
        if (r?.live && (r.locked || inspectionTargets.has(r.id))) {
          outcomes.push({
            title: t.title,
            ok: false,
            error: r.locked
              ? 'Protected tab retained; unprotect it to retry recovery.'
              : 'Active inspection target retained; wait for inspection before retrying recovery.',
          });
          continue;
        }
        let tab: chrome.tabs.Tab | undefined;
        if (r?.live && !newWindows) {
          try {
            tab = await chrome.tabs.get(r.tabId!);
          } catch {}
        }
        if (tab) {
          if (tab.splitViewId !== undefined && tab.splitViewId >= 0)
            throw new Error(
              'Native split retained. Unsplit it in the browser before retrying placement recovery.',
            );
          const current: string | undefined = suspendedInfo(tab.url, origin)?.url || tab.url;
          // Never navigate a tab that the user has since repurposed; recreate the snapshot entry instead.
          if (current !== t.url) tab = undefined;
        }
        if (!tab) {
          const newId = r?.live || newWindows ? uuid() : t.recordId;
          r = {
            ...newRecord(t.url, newId),
            ...(onlyMissing && r?.url === t.url ? r : {}),
            ...t,
            id: newId,
            ...(newId !== t.recordId ? { parentRecordId: null, openerRecordId: null } : {}),
            live: true,
            wasOpen: true,
          };
          await db.put('records', r);
          tab = await chrome.tabs.create({
            windowId: target.id!,
            ...(onlyMissing ? { index: Math.max(0, Math.min(t.index, targetTabCount)) } : {}),
            active: false,
            pinned: t.pinned,
            url: t.nativeNewTab && isNativeNewTabURL(t.url) ? t.url : makeSuspendedURL(origin, r),
          });
          targetTabCount++;
          r.tabId = tab.id!;
          r.windowId = target.id!;
          r.suspended = !t.nativeNewTab;
          await db.put('records', r);
          bind.tabs[tab.id!] = r.id;
          if (t.muted !== undefined) await chrome.tabs.update(tab.id!, { muted: t.muted });
        } else {
          if (tab.groupId !== -1) await chrome.tabs.ungroup(tab.id!);
          await chrome.tabs.update(tab.id!, { pinned: Boolean(t.pinned) });
          if (t.muted !== undefined) await chrome.tabs.update(tab.id!, { muted: t.muted });
          await chrome.tabs.move(tab.id!, {
            windowId: target.id!,
            index: scope ? t.index : position,
          });
          if (
            restoreLoadingRecordIds.includes(t.recordId) &&
            t.suspended &&
            !suspendedInfo(tab.url, origin)
          )
            await suspendOne(r!.id, { capture: false });
          else if (
            restoreLoadingRecordIds.includes(t.recordId) &&
            !t.suspended &&
            suspendedInfo(tab.url, origin)
          )
            await wakeOne(r!.id);
        }
        position++;
        if (t.groupId !== -1 && !t.pinned) {
          const ids = groupTabs.get(t.groupId) || [];
          ids.push(tab.id!);
          groupTabs.set(t.groupId, ids);
        }
        const outcome = { title: t.title, ok: true, recordId: r!.id, sourceRecordId: t.recordId };
        outcomes.push(outcome);
        if (onOutcome) await onOutcome(outcome);
      } catch (e) {
        const outcome = {
          title: t.title,
          ok: false,
          error: errorMessage(e),
          sourceRecordId: t.recordId,
        };
        outcomes.push(outcome);
        if (onOutcome) await onOutcome(outcome);
      }
    }
    for (const [oldId, tabIds] of groupTabs) {
      try {
        const g = w.groups.find((x) => x.id === oldId);
        const existingGroup = (await chrome.tabGroups.query({ windowId: target.id! })).find(
          (group) =>
            group.id === oldId &&
            (onlyMissing || (group.title === g?.title && group.color === g?.color)),
        );
        const groupId = await chrome.tabs.group(
          existingGroup
            ? { groupId: existingGroup.id, tabIds: tabIds as [number, ...number[]] }
            : {
                createProperties: { windowId: target.id! },
                tabIds: tabIds as [number, ...number[]],
              },
        );
        if (onlyMissing && existingGroup) continue;
        await chrome.tabGroups.update(groupId, {
          title: g?.title || '',
          color: g?.color || 'grey',
          collapsed: g?.collapsed || false,
        });
      } catch (e) {
        const outcome = {
          ok: false,
          error: errorMessage(e),
          sourceRecordId: w.tabs.find((tab) => tab.groupId === oldId)?.recordId,
        };
        outcomes.push(outcome);
        if (onOutcome) await onOutcome(outcome);
      }
    }
    // Activating a tab inside a collapsed group expands it. Keep the neutral active tab
    // when a recovered window consists entirely of collapsed groups.
    const allCollapsed =
      onlyMissing &&
      w.tabs.every(
        (tab) =>
          !tab.pinned && w.groups.some((group) => group.id === tab.groupId && group.collapsed),
      );
    if (blankId && !allCollapsed) await chrome.tabs.remove(blankId);
  }
  const restoredIds = new Map(
    outcomes.flatMap((outcome) =>
      outcome.ok && outcome.sourceRecordId && outcome.recordId
        ? [[outcome.sourceRecordId, outcome.recordId]]
        : [],
    ),
  );
  for (const tab of saved.windows.flatMap((window) => window.tabs)) {
    const restoredId = restoredIds.get(tab.recordId);
    if (!restoredId || restoredId === tab.recordId) continue;
    const restored = await db.get('records', restoredId);
    if (!restored) continue;
    restored.parentRecordId = tab.parentRecordId
      ? restoredIds.get(tab.parentRecordId) || null
      : null;
    restored.openerRecordId = tab.openerRecordId
      ? restoredIds.get(tab.openerRecordId) || null
      : null;
    await db.put('records', restored);
  }
  await saveBindings(bind);
  await reconcile();
  return outcomes;
}
async function tabCommandMetadata(id: string) {
  const record = await db.get('records', id);
  return JSON.stringify({
    tags: record?.tags,
    note: record?.note,
    navigationVersion: record?.navigationVersion,
    parentRecordId: record?.parentRecordId || null,
    branchName: record?.branchName || '',
    membership: await db.get('memberships', id),
  });
}
export async function tabCommand(
  raw: unknown,
  onPrepared?: (operation: Operation) => Promise<void>,
): Promise<Operation> {
  const input = z
    .object({
      id: z.string(),
      command: z.enum(['duplicate', 'new', 'close', 'reload']),
      expected: z.object({ url: z.string(), navigationVersion: z.number() }),
    })
    .parse(raw);
  await reconcile();
  const { r, tab } = await currentRecord(input.id);
  if (
    r.locked ||
    r.url !== input.expected.url ||
    r.navigationVersion !== input.expected.navigationVersion
  )
    throw new Error('This tab changed or is protected. Refresh before trying again.');
  const jobs = await db.all('jobs');
  if (
    jobs.some(
      (job) =>
        ['queued', 'running'].includes(job.status) && job.items.some((item) => item.id === r.id),
    )
  )
    throw new Error('An inspection target is protected until inspection finishes.');
  const before = await snapshot(`Before ${input.command} tab`);
  const operation: Operation = {
    id: uuid(),
    createdAt: now(),
    snapshotId: before.id,
    summary: `${input.command === 'new' ? 'New tab below' : input.command + ' tab'}`,
    status: 'running',
    actions: [],
    results: [],
    tabCommand: { command: input.command, recordId: r.id },
    postState: {},
  };
  await db.put('operations', operation);
  await onPrepared?.(operation);
  try {
    // Revalidate after the snapshot, before using the session handle.
    const current = await currentRecord(r.id);
    if (
      current.r.locked ||
      JSON.stringify(operationTabState(current.r, current.tab)) !==
        JSON.stringify(operationTabState(r, tab))
    )
      throw new Error('The tab changed while preparing this action.');
    if (input.command === 'close') {
      await chrome.tabs.remove(tab.id!);
      await db.put('records', { ...current.r, live: false, wasOpen: false });
    } else if (input.command === 'reload') {
      if (r.suspended) throw new Error('Wake this tab before reloading it.');
      await chrome.tabs.reload(tab.id!);
    } else {
      const copyId = uuid();
      const url =
        input.command === 'new'
          ? 'chrome://newtab/'
          : r.suspended
            ? makeSuspendedURL(origin, { ...r, id: copyId })
            : r.url;
      const created =
        input.command === 'duplicate' && !r.suspended
          ? await chrome.tabs.duplicate(tab.id!)
          : await chrome.tabs.create({
              windowId: tab.windowId,
              index: tab.index + 1,
              active: input.command === 'new',
              pinned: input.command === 'duplicate' && tab.pinned,
              url,
            });
      if (created?.id === undefined) throw new Error('Browser did not return a tab handle.');
      operation.tabCommand!.created = {
        tabId: created.id,
        url: created.pendingUrl || created.url || url,
        windowId: created.windowId,
        index: created.index,
        groupId: created.groupId,
        pinned: created.pinned,
        muted: Boolean(created.mutedInfo?.muted),
        ...(input.command === 'duplicate' ? { recordId: copyId } : {}),
      };
      await db.put('operations', operation);
      if (input.command === 'duplicate') {
        await db.put('records', {
          ...newRecord(r.url, copyId),
          nativeNewTab: r.nativeNewTab,
          title: r.title,
          parentRecordId: r.parentRecordId || null,
          openerRecordId: r.openerRecordId || null,
          tags: [...r.tags],
          note: r.note,
          projectId: r.projectId,
          suspended: r.suspended,
        });
        const membership = await db.get('memberships', r.id);
        await db.put('memberships', {
          recordId: copyId,
          projectId: membership ? membership.projectId : r.projectId,
          categoryId: membership?.categoryId || null,
          source: 'owner',
          updatedAt: now(),
        });
        const bind = await bindings();
        bind.tabs[created.id] = copyId;
        await saveBindings(bind);
      } else {
        const membership = await db.get('memberships', r.id);
        const bind = await bindings();
        const context = {
          recordId: copyId,
          parentRecordId: r.parentRecordId || null,
          projectId: membership ? membership.projectId : r.projectId,
          categoryId: membership?.categoryId || null,
        };
        const destination = created.pendingUrl || created.url;
        if (isNativeNewTabURL(destination)) {
          await db.database.transaction('rw', ['records', 'memberships'], async () => {
            await db.put('records', {
              ...newRecord(destination, copyId),
              nativeNewTab: true,
              title: created.title || 'New tab',
              parentRecordId: context.parentRecordId,
              openerRecordId: null,
            });
            await db.put('memberships', {
              recordId: copyId,
              projectId: context.projectId,
              categoryId: context.categoryId,
              source: 'owner',
              updatedAt: now(),
            });
          });
          bind.tabs[created.id] = copyId;
          operation.tabCommand!.created!.recordId = copyId;
        } else bind.pendingTabs = { ...bind.pendingTabs, [created.id]: context };
        await saveBindings(bind);
      }
    }
    operation.status = 'complete';
  } catch (error) {
    operation.status = 'partial';
    operation.pauseReason = errorMessage(error);
  }
  operation.completedAt = now();
  await reconcile();
  await captureOperationPostState(operation, [r.id]);
  const created = operation.tabCommand?.created;
  if (created?.recordId) {
    created.metadata = await tabCommandMetadata(created.recordId);
  }
  await db.put('operations', operation);
  return operation;
}
async function undoTabCommand(operation: Operation): Promise<RestoreResult[]> {
  const command = operation.tabCommand!;
  if (command.command === 'reload')
    throw new Error('Reloading cannot undo page or network effects.');
  await reconcile();
  if (command.command === 'close') {
    const record = await db.get('records', command.recordId);
    if (record?.live || record?.locked)
      throw new Error('The closed tab was restored or protected later; retained.');
    const results = await restoreSnapshot(operation.snapshotId, {
      onlyRecordIds: [command.recordId],
      onlyMissing: true,
    });
    if (!results.every((item) => item.ok)) return results;
  } else {
    const created = command.created;
    if (!created) throw new Error('No created tab was recorded.');
    const tab = await chrome.tabs.get(created.tabId);
    const record = created.recordId ? await db.get('records', created.recordId) : undefined;
    const currentUrl = tab.pendingUrl || tab.url;
    const metadata = created.recordId ? await tabCommandMetadata(created.recordId) : undefined;
    const jobs = await db.all('jobs');
    if (
      created.recordId &&
      jobs.some(
        (job) =>
          ['queued', 'running'].includes(job.status) &&
          job.items.some((item) => item.id === created.recordId),
      )
    )
      throw new Error('The created tab is an active inspection target; retained.');
    if (
      currentUrl !== created.url ||
      tab.windowId !== created.windowId ||
      tab.index !== created.index ||
      tab.groupId !== created.groupId ||
      tab.pinned !== created.pinned ||
      Boolean(tab.mutedInfo?.muted) !== created.muted ||
      record?.locked ||
      (created.recordId &&
        (!record?.live || record.tabId !== tab.id || created.metadata !== metadata))
    )
      throw new Error('The created tab changed; retained.');
    const before = JSON.stringify({
      url: tab.pendingUrl || tab.url,
      windowId: tab.windowId,
      groupId: tab.groupId,
      index: tab.index,
      pinned: tab.pinned,
      muted: Boolean(tab.mutedInfo?.muted),
    });
    await snapshot('Before undoing created tab');
    const latest = await chrome.tabs.get(tab.id!);
    const after = JSON.stringify({
      url: latest.pendingUrl || latest.url,
      windowId: latest.windowId,
      groupId: latest.groupId,
      index: latest.index,
      pinned: latest.pinned,
      muted: Boolean(latest.mutedInfo?.muted),
    });
    const latestRecord = created.recordId ? await db.get('records', created.recordId) : undefined;
    if (
      before !== after ||
      latestRecord?.locked ||
      (latestRecord && created.metadata !== (await tabCommandMetadata(latestRecord.id)))
    )
      throw new Error('The created tab changed while preparing Undo; retained.');
    await chrome.tabs.remove(tab.id!);
    if (latestRecord) await db.put('records', { ...latestRecord, live: false, wasOpen: false });
  }
  await reconcile();
  operation.status = 'undone';
  const guard: Operation = { ...operation, postState: {} };
  await captureOperationPostState(guard, [command.recordId]);
  operation.undoState = guard.postState;
  await db.put('operations', operation);
  return [{ recordId: command.recordId, ok: true }];
}
export async function redoOperation(id: string): Promise<Operation> {
  const operation = await db.get('operations', id);
  if (!operation || operation.status !== 'undone' || operation.redoOperationId)
    throw new Error('This operation is not available for Redo.');
  if (!operation.undoState) throw new Error('This older operation has no safe Redo checkpoint.');
  await reconcile();
  const ids = operation.tabCommand
    ? [operation.tabCommand.recordId]
    : [...new Set(operation.actions.flatMap((action) => action.recordIds))];
  for (const recordId of ids) {
    const { r, tab } = await currentRecord(recordId);
    if (
      !operation.undoState[recordId] ||
      JSON.stringify(operationTabState(r, tab)) !== JSON.stringify(operation.undoState[recordId])
    )
      throw new Error('A later browser change was retained. Redo a fresh action instead.');
  }
  const record = operation.tabCommand
    ? await db.get('records', operation.tabCommand.recordId)
    : undefined;
  const linkRedo = async (next: Operation) => {
    operation.redoOperationId = next.id;
    await db.put('operations', operation);
  };
  const result =
    operation.tabCommand && record
      ? await tabCommand(
          {
            id: record.id,
            command: operation.tabCommand.command,
            expected: { url: record.url, navigationVersion: record.navigationVersion },
          },
          linkRedo,
        )
      : await applyPlan(
          { summary: `Redo: ${operation.summary}`, actions: operation.actions },
          linkRedo,
        );
  operation.redoOperationId = result.id;
  await db.put('operations', operation);
  return result;
}
export async function undoOperation(id: string) {
  const operation = await db.get('operations', id);
  if (!operation) throw new Error('Operation not found.');
  if (operation.status === 'undone') return [];
  if (operation.tabCommand) return undoTabCommand(operation);
  if (operation.queued && operation.status === 'running')
    throw new Error('Pause the wake queue before reviewing Undo.');
  if (operation.kind === 'session-resume' || operation.kind === 'extension-update')
    throw new Error(
      'Session recovery preserves existing tabs. Use the saved before-snapshot for reviewed recovery.',
    );
  if (operation.collectionProposalId) {
    const result = await undoCollection(operation.collectionProposalId);
    return result.outcomes;
  }
  const retained: RestoreResult[] = [];
  const allowed: string[] = [];
  for (const recordId of new Set(operation.actions.flatMap((action) => action.recordIds))) {
    if (!operation.postState) {
      allowed.push(recordId);
      continue;
    }
    try {
      const after = operation.postState[recordId];
      if (!after) throw new Error('No completed action state was recorded; tab retained.');
      const { r, tab } = await currentRecord(recordId);
      const current = operationTabState(r, tab);
      if (r.locked) throw new Error('Protected tab retained.');
      if (JSON.stringify(current) !== JSON.stringify(after))
        throw new Error('A later browser change was retained.');
      allowed.push(recordId);
    } catch (error) {
      retained.push({ recordId, ok: false, error: errorMessage(error) });
    }
  }
  if (!allowed.length) return retained;
  const outcomes = await restoreSnapshot(operation.snapshotId, {
    onlyRecordIds: allowed,
    restoreLoadingRecordIds: [
      ...new Set(
        operation.actions
          .filter((action) => action.type === 'suspend' || action.type === 'wake')
          .flatMap((action) => action.recordIds),
      ),
    ],
  });
  outcomes.push(...retained);
  if (outcomes.every((o) => o.ok)) {
    operation.status = 'undone';
    const guard: Operation = { ...operation, postState: {} };
    await captureOperationPostState(guard, allowed);
    operation.undoState = guard.postState;
    await db.put('operations', operation);
  }
  return outcomes;
}
export async function project(
  {
    name,
    purpose,
    maintainReviewQueue,
    areaId,
    windowId,
    id,
    provenance,
    displayColor,
  }: {
    name: string;
    purpose?: string;
    maintainReviewQueue?: boolean;
    areaId?: string | null;
    windowId?: number;
    id?: string;
    provenance?: Provenance;
    displayColor?: string | null;
  },
  reconcileAfter = true,
) {
  const existing = id ? await db.get('projects', id) : undefined;
  if (id && !existing) throw new Error('Project no longer exists.');
  if (
    (await db.all('projects')).some(
      (entry) =>
        entry.id !== id && entry.name.toLowerCase() === clip(name, 80).trim().toLowerCase(),
    )
  )
    throw new Error('A project with that name already exists.');
  if (
    displayColor !== undefined &&
    displayColor !== null &&
    !/^#[0-9a-fA-F]{6}$/.test(displayColor)
  )
    throw new Error('Use a six-digit hex display color.');
  const p = {
    displayColor: displayColor === undefined ? existing?.displayColor : displayColor,
    provenance: provenanceSchema.parse(provenance || { author: 'owner' }),
    id: id || uuid(),
    name: clip(name, 80).trim(),
    purpose: clip(purpose === undefined ? existing?.purpose || '' : purpose, 1000).trim(),
    updatedAt: now(),
    revision: (existing?.revision || 0) + 1,
    maintainReviewQueue: maintainReviewQueue ?? existing?.maintainReviewQueue ?? false,
    areaId: areaId === undefined ? (existing?.areaId ?? null) : areaId,
  };
  if (!p.name) throw new Error('Enter a project name.');
  if (p.areaId && !(await db.get('areas', p.areaId)))
    throw new Error('Choose a valid context for this project.');
  await db.put('projects', p);
  if (windowId) await bindProject(windowId, p.id);
  else if (reconcileAfter) await reconcile();
  return p;
}
export async function saveArea(input: unknown): Promise<Area> {
  const parsed = validateArea(input);
  const existing = parsed.id ? await db.get('areas', parsed.id) : undefined;
  const area = validateArea(input, existing);
  const duplicate = (await db.all('areas')).find(
    (item) => item.id !== area.id && item.name.toLowerCase() === area.name.toLowerCase(),
  );
  if (duplicate) throw new Error('A context with that name already exists.');
  await db.put('areas', area);
  return area;
}
export async function saveWorkItem(input: unknown): Promise<WorkItem> {
  const parsed = validateWorkItem(input);
  const existing = parsed.id ? await db.get('workItems', parsed.id) : undefined;
  const item = validateWorkItem(input, existing);
  if (item.areaId && !(await db.get('areas', item.areaId))) throw new Error('Context not found.');
  if (item.projectId && !(await db.get('projects', item.projectId)))
    throw new Error('Project not found.');
  if (item.recordId) {
    const record = await db.get('records', item.recordId);
    if (!record?.live) throw new Error('The linked tab is no longer open.');
    item.url = record.url;
    item.source = 'tab';
    if (!item.projectId) {
      const membership = await db.get('memberships', record.id);
      item.projectId = membership ? membership.projectId : record.projectId;
    }
  } else if (item.source === 'tab') {
    throw new Error('A tab-linked follow-up needs a live tab occurrence.');
  }
  item.url = item.url ? pageURL(item.url) || null : null;
  await db.put('workItems', item);
  return item;
}
export async function queueOrganizationTab(tabId: number): Promise<OrganizationJob | undefined> {
  const record = await db.database.records.where('tabId').equals(tabId).first();
  if (!record?.live) return;
  const membership = await db.get('memberships', record.id);
  if (record.locked || membership?.source === 'owner') return;
  if (record.sourceRecordId) {
    const copying = (await db.all('collectionProposals')).find((proposal) =>
      proposal.copyState?.entries.some((entry) => entry.recordId === record.id),
    );
    if (
      copying?.copyState &&
      (await db.get('operations', copying.copyState.operationId))?.status !== 'complete'
    )
      return;
  }
  const config = await settings();
  const collectionMode = config.maintainCollectionReview;
  const projectId = membership ? membership.projectId : record.projectId;
  if (collectionMode && config.reviewProjectWindowsOnly && !projectId && !record.projectId) return;
  const projectValue = await db.get('projects', projectId);
  if (!collectionMode && !projectValue?.maintainReviewQueue) return;
  const fingerprint = organizationFingerprint(record);
  const existing = (
    await db.database.organizationJobs
      .where('[recordId+url+navigationVersion]')
      .equals([record.id, record.url, record.navigationVersion])
      .toArray()
  ).find((job) => job.fingerprint === fingerprint);
  if (existing) return existing;
  if (record.organizationBaseline === fingerprint) return;
  const job: OrganizationJob = {
    id: uuid(),
    recordId: record.id,
    projectId: collectionMode ? undefined : projectValue?.id,
    kind: collectionMode ? 'collection' : undefined,
    url: record.url,
    navigationVersion: record.navigationVersion,
    fingerprint,
    createdAt: now(),
    status: 'queued',
    attempts: 0,
  };
  await db.put('organizationJobs', job);
  record.organizationBaseline = fingerprint;
  await db.put('records', record);
  return job;
}
async function pruneOrganizationJobs(at: number) {
  const expiredBefore = at - 30 * 24 * 60 * 60 * 1000;
  const terminal = await db.database.organizationJobs
    .where('status')
    .anyOf('complete', 'stale')
    .toArray();
  const expired = terminal.filter((job) => job.createdAt < expiredBefore);
  if (!expired.length) return;
  await db.database.transaction('rw', 'organizationJobs', async () => {
    for (const job of expired) await db.remove('organizationJobs', job.id);
  });
}
export async function claimOrganizationJob(
  runnerId: string,
): Promise<{ job: OrganizationJob; project: Project; record: TabRecord } | undefined> {
  await pruneOrganizationJobs(now());
  const jobs = await db.database.organizationJobs
    .where('status')
    .anyOf('queued', 'running')
    .sortBy('createdAt');
  const pendingProposals = await db.all('proposals');
  for (const job of jobs) {
    if (job.kind === 'collection') continue;
    if (!['queued', 'running'].includes(job.status)) continue;
    if (job.status === 'running' && (job.leaseUntil || 0) > now()) continue;
    const completedProposal = pendingProposals.find((proposal) => proposal.sourceJobId === job.id);
    if (completedProposal) {
      job.status = 'complete';
      job.leaseOwner = undefined;
      job.leaseUntil = undefined;
      await db.put('organizationJobs', job);
      continue;
    }
    const projectValue = await db.get('projects', job.projectId);
    if (!projectValue) {
      job.status = 'stale';
      job.error = 'Project no longer exists.';
      job.leaseOwner = undefined;
      await db.put('organizationJobs', job);
      continue;
    }
    if (!projectValue.maintainReviewQueue) continue;
    if (
      pendingProposals.some(
        (proposal) => proposal.projectId === job.projectId && proposal.status === 'pending',
      )
    )
      continue;
    const record = await db.get('records', job.recordId);
    const membership = await db.get('memberships', job.recordId);
    if (
      !record?.live ||
      record.locked ||
      record.url !== job.url ||
      record.navigationVersion !== job.navigationVersion ||
      membership?.source === 'owner' ||
      (job.fingerprint !== undefined && job.fingerprint !== organizationFingerprint(record)) ||
      (membership ? membership.projectId : record.projectId) !== job.projectId
    ) {
      job.status = 'stale';
      job.error = 'Tab or project changed before analysis began.';
      job.leaseOwner = undefined;
      job.leaseUntil = undefined;
      await db.put('organizationJobs', job);
      continue;
    }
    job.status = 'running';
    job.attempts += 1;
    job.leaseOwner = clip(runnerId, 120);
    job.leaseUntil = now() + 3 * 60 * 1000;
    job.error = undefined;
    await db.put('organizationJobs', job);
    return { job, project: projectValue, record };
  }
}
// Called through the serialized background RPC. Inference runs only in the visible dashboard.
export async function claimCollectionJobs(runnerId: string): Promise<OrganizationJob[]> {
  const config = await settings();
  if (!config.maintainCollectionReview) return [];
  if (!(await db.all('categories')).length) return [];
  await pruneOrganizationJobs(now());
  const proposals = await db.all('collectionProposals');
  if (proposals.some((proposal) => proposal.status === 'pending')) return [];
  const jobs = await db.database.organizationJobs
    .where('status')
    .anyOf('queued', 'running')
    .sortBy('createdAt');
  if (jobs.some((job) => job.status === 'running' && (job.leaseUntil || 0) > now())) return [];
  const claimed: OrganizationJob[] = [];
  for (const job of jobs) {
    if (proposals.some((proposal) => proposal.sourceJobIds?.includes(job.id))) {
      job.status = 'complete';
      job.leaseOwner = undefined;
      job.leaseUntil = undefined;
      await db.put('organizationJobs', job);
      continue;
    }
    const record = await db.get('records', job.recordId);
    const membership = await db.get('memberships', job.recordId);
    if (
      !record?.live ||
      record.locked ||
      membership?.source === 'owner' ||
      (job.fingerprint !== undefined && job.fingerprint !== organizationFingerprint(record)) ||
      record.url !== job.url ||
      record.navigationVersion !== job.navigationVersion
    ) {
      job.status = 'stale';
      job.error = 'Tab changed or received an owner correction before analysis.';
      job.leaseOwner = undefined;
      job.leaseUntil = undefined;
      await db.put('organizationJobs', job);
      continue;
    }
    job.kind = 'collection';
    job.projectId = undefined;
    job.status = 'running';
    job.attempts += 1;
    job.leaseOwner = clip(runnerId, 120);
    job.leaseUntil = now() + 3 * 60 * 1000;
    job.error = undefined;
    await db.put('organizationJobs', job);
    claimed.push(job);
    if (claimed.length >= Math.min(10, config.aiBatchSize)) break;
  }
  return claimed;
}
export async function renewCollectionJobs(ids: string[], runnerId: string): Promise<void> {
  for (const id of ids.slice(0, 10)) {
    const job = await db.get('organizationJobs', id);
    if (
      !job ||
      job.kind !== 'collection' ||
      job.status !== 'running' ||
      job.leaseOwner !== runnerId ||
      (job.leaseUntil || 0) <= now()
    )
      throw new Error('Collection analysis lease expired or belongs to another dashboard.');
    job.leaseUntil = now() + 3 * 60 * 1000;
    await db.put('organizationJobs', job);
  }
}
export async function finishOrganizationJob(input: {
  id: string;
  status: 'complete' | 'error';
  error?: string;
  runnerId?: string;
}): Promise<OrganizationJob> {
  const job = await db.get('organizationJobs', input.id);
  if (!job || job.status !== 'running') throw new Error('Organization job is no longer running.');
  if (job.kind === 'collection' && job.leaseOwner !== input.runnerId)
    throw new Error('Collection analysis belongs to another dashboard.');
  if (
    input.status === 'complete' &&
    !(job.kind === 'collection'
      ? (await db.all('collectionProposals')).some((proposal) =>
          proposal.sourceJobIds?.includes(job.id),
        )
      : (await db.all('proposals')).some((proposal) => proposal.sourceJobId === job.id))
  )
    throw new Error('Organization job has no saved review proposal.');
  job.status = input.status;
  job.error =
    input.status === 'error' ? clip(input.error, 500) || 'Model request failed.' : undefined;
  job.leaseOwner = undefined;
  job.leaseUntil = undefined;
  await db.put('organizationJobs', job);
  return job;
}
export async function retryOrganizationJob(id: string): Promise<OrganizationJob> {
  const job = await db.get('organizationJobs', id);
  if (!job || job.status !== 'error')
    throw new Error('Only failed organization jobs can be retried.');
  job.status = 'queued';
  job.error = undefined;
  job.leaseOwner = undefined;
  job.leaseUntil = undefined;
  await db.put('organizationJobs', job);
  return job;
}
export async function saveCategory(input: {
  id?: string;
  displayColor?: string | null;
  projectId: string;
  name: string;
  description?: string;
  provenance?: Provenance;
  color?: chrome.tabGroups.TabGroup['color'];
}): Promise<Category> {
  const parent = await db.get('projects', input.projectId);
  if (!parent) throw new Error('Project not found.');
  const name = clip(input.name, 80).trim();
  if (!name) throw new Error('Enter a category name.');
  const existing = input.id ? await db.get('categories', input.id) : undefined;
  if (existing && existing.projectId !== input.projectId)
    throw new Error('A category cannot be moved between projects by editing it.');
  const duplicate = (await db.all('categories')).some(
    (category) =>
      category.projectId === input.projectId &&
      category.name.toLowerCase() === name.toLowerCase() &&
      category.id !== input.id,
  );
  if (duplicate) throw new Error('This project already has a category with that name.');
  if (input.color !== undefined && !COLORS.includes(input.color))
    throw new Error('Choose a supported category color.');
  if (
    input.displayColor !== undefined &&
    input.displayColor !== null &&
    !/^#[0-9a-fA-F]{6}$/.test(input.displayColor)
  )
    throw new Error('Use a six-digit hex display color.');
  const color = input.color === undefined ? existing?.color : input.color;
  const description = clip(
    input.description === undefined ? existing?.description || '' : input.description,
    500,
  ).trim();
  const semanticChanged =
    !existing || existing.name !== name || existing.description !== description;
  const value: Category = {
    provenance: provenanceSchema.parse(input.provenance || { author: 'owner' }),
    id: existing?.id || uuid(),
    projectId: input.projectId,
    name,
    displayColor: input.displayColor === undefined ? existing?.displayColor : input.displayColor,
    color,
    description,
    order:
      existing?.order ??
      (await db.all('categories')).filter((c) => c.projectId === input.projectId).length,
    updatedAt: now(),
    revision: (existing?.revision || 0) + 1,
  };
  await db.put('categories', value);
  parent.updatedAt = now();
  if (semanticChanged) parent.revision += 1;
  await db.put('projects', parent);
  return value;
}
export async function assignMembership(
  input: {
    recordIds: string[];
    projectId: string | null;
    categoryId: string | null;
    expected?: Plan['expected'];
  },
  validateBrowser = true,
): Promise<void> {
  if (input.projectId && !(await db.get('projects', input.projectId)))
    throw new Error('Project not found.');
  if (!input.projectId && input.categoryId)
    throw new Error('Inbox tabs cannot have a project category.');
  if (input.categoryId) {
    const category = await db.get('categories', input.categoryId);
    if (!category || category.projectId !== input.projectId)
      throw new Error('Choose a category in this project.');
  }
  const uniqueIds = [...new Set(input.recordIds)].slice(0, 1000);
  const rows = await Promise.all(uniqueIds.map((id) => db.get('records', id)));
  if (rows.some((record) => !record?.live))
    throw new Error('A selected tab is no longer open. Refresh and retry.');
  if (rows.some((record) => record?.locked))
    throw new Error('Remove protection before reassigning a protected tab.');
  for (const id of uniqueIds) {
    const expected = input.expected?.[id];
    if (!expected) continue;
    const current = validateBrowser
      ? await currentRecord(id)
      : { r: rows.find((record) => record?.id === id)! };
    if (
      expected.url !== current.r.url ||
      expected.navigationVersion !== current.r.navigationVersion
    )
      throw new Error('The correction is stale; a page changed after it was proposed.');
  }
  await db.database.transaction('rw', 'memberships', async () => {
    for (const record of rows) {
      if (!record) continue;
      await db.put('memberships', {
        recordId: record.id,
        projectId: input.projectId,
        categoryId: input.categoryId,
        source: 'owner',
        provenance: { author: 'owner' },
        updatedAt: now(),
      } satisfies Membership);
    }
  });
}
export async function validateWorkspaceEditTargets(raw: unknown): Promise<void> {
  const draft = workspaceEditDraftSchema.parse(raw);
  const ids = new Set(draft.edits.flatMap(({ edit }) => workspaceEditRecordIds(edit)));
  if (
    (await db.all('jobs')).some(
      (job) =>
        ['queued', 'running'].includes(job.status) && job.items.some((item) => ids.has(item.id)),
    )
  )
    throw new Error('Finish inspection before editing its protected targets.');
  for (const id of ids) await currentRecord(id);
}
export async function applyWorkspaceEdits(raw: unknown, validateBrowser = true): Promise<void> {
  const draft = workspaceEditDraftSchema.parse(raw);
  // Refresh session handles before opening the atomic metadata transaction.
  if (validateBrowser) await validateWorkspaceEditTargets(draft);
  await db.database.transaction(
    'rw',
    [
      db.database.records,
      db.database.memberships,
      db.database.projects,
      db.database.categories,
      db.database.areas,
      db.database.workItems,
      db.database.jobs,
    ],
    async () => {
      const app = {
        records: await db.all('records'),
        memberships: await db.all('memberships'),
        projects: await db.all('projects'),
        categories: await db.all('categories'),
        areas: await db.all('areas'),
        workItems: await db.all('workItems'),
      };
      for (const { edit, before } of draft.edits)
        if (workspaceEditBaseline(app, edit) !== before)
          throw new Error(
            'Workspace edits are stale. A target changed after preparation; prepare a fresh draft. Nothing was applied.',
          );
      for (const { edit } of draft.edits) {
        if (edit.kind === 'category_order') {
          for (const [order, id] of edit.categoryIds.entries()) {
            const category = await db.get('categories', id);
            if (!category || category.projectId !== edit.projectId)
              throw new Error('Category changed before reordering.');
            if (category.order !== order)
              await db.put('categories', {
                ...category,
                order,
                revision: category.revision + 1,
                updatedAt: now(),
              });
          }
        } else if (edit.kind === 'move_category') {
          const category = await db.get('categories', edit.categoryId);
          const destination = await db.get('projects', edit.projectId);
          if (!category || !destination)
            throw new Error('Category or destination no longer exists.');
          const currentCategories = await db.all('categories');
          if (
            currentCategories.some(
              (item) =>
                item.projectId === destination.id &&
                item.name.toLocaleLowerCase() === category.name.toLocaleLowerCase(),
            )
          )
            throw new Error(
              'A category with this name already exists in the destination. Rename it first.',
            );
          const targets = new Set(
            app.memberships
              .filter((membership) => membership.categoryId === category.id)
              .map((membership) => membership.recordId),
          );
          if (
            (await db.all('jobs')).some(
              (job) =>
                ['queued', 'running'].includes(job.status) &&
                job.items.some((item) => targets.has(item.id)),
            )
          )
            throw new Error('Finish inspection before moving this category.');
          if (
            app.records.some(
              (record) =>
                record.locked &&
                app.memberships.some(
                  (membership) =>
                    membership.recordId === record.id && membership.categoryId === category.id,
                ),
            )
          )
            throw new Error('A protected tab prevents moving this category.');
          await db.put('categories', {
            ...category,
            projectId: destination.id,
            order:
              Math.max(
                -1,
                ...currentCategories
                  .filter((item) => item.projectId === destination.id)
                  .map((item) => item.order),
              ) + 1,
            revision: category.revision + 1,
            updatedAt: now(),
          });
          for (const membership of app.memberships.filter(
            (item) => item.categoryId === category.id,
          ))
            await db.put('memberships', {
              ...membership,
              projectId: destination.id,
              source: 'owner',
              updatedAt: now(),
            });
          for (const projectId of [category.projectId, destination.id]) {
            const parent = await db.get('projects', projectId);
            if (parent)
              await db.put('projects', {
                ...parent,
                revision: parent.revision + 1,
                updatedAt: now(),
              });
          }
        } else if (edit.kind === 'delete_category') {
          const category = await db.get('categories', edit.categoryId);
          if (!category) throw new Error('Category no longer exists.');
          for (const membership of await db.all('memberships')) {
            if (membership.categoryId === category.id)
              await db.put('memberships', { ...membership, categoryId: null, updatedAt: now() });
          }
          await db.remove('categories', category.id);
          const parent = await db.get('projects', category.projectId);
          if (parent)
            await db.put('projects', {
              ...parent,
              revision: parent.revision + 1,
              updatedAt: now(),
            });
        } else if (edit.kind === 'structure') {
          const area = edit.area
            ? await saveArea({ ...edit.area, id: edit.area.id || undefined })
            : undefined;
          if (edit.project) {
            const savedProject = await project(
              {
                ...edit.project,
                id: edit.project.id || undefined,
                ...(area ? { areaId: area.id } : {}),
              },
              false,
            );
            for (const category of edit.categories)
              await saveCategory({
                ...category,
                id: category.id || undefined,
                projectId: savedProject.id,
              });
            const category = edit.categoryName
              ? (await db.all('categories')).find(
                  (item) =>
                    item.projectId === savedProject.id &&
                    item.name.toLocaleLowerCase() === edit.categoryName?.toLocaleLowerCase(),
                )
              : undefined;
            if (edit.categoryName && !category)
              throw new Error(
                'The reviewed category could not be resolved. Nothing was committed.',
              );
            for (const recordId of edit.recordIds)
              await db.put('memberships', {
                recordId,
                projectId: savedProject.id,
                categoryId: category?.id || null,
                source: 'owner',
                provenance: { author: 'owner' },
                updatedAt: now(),
              });
          }
        } else if (edit.kind === 'project') {
          const existing = await db.get('projects', edit.projectId);
          if (!existing) throw new Error('Project no longer available.');
          if (
            (await db.all('projects')).some(
              (item) =>
                item.id !== edit.projectId && item.name.toLowerCase() === edit.name.toLowerCase(),
            )
          )
            throw new Error('A project with that name already exists.');
          await db.put('projects', {
            ...existing,
            name: edit.name,
            purpose: edit.purpose,
            areaId: edit.areaId,
            revision: existing.revision + 1,
            updatedAt: now(),
            provenance: { author: 'owner' },
          });
        } else if (edit.kind === 'category') {
          await saveCategory({ ...edit, id: edit.categoryId || undefined });
        } else if (edit.kind === 'work_item') {
          const item = await db.get('workItems', edit.workItemId);
          if (!item) throw new Error('Work item no longer available.');
          const { kind: _kind, workItemId: _id, linkedRecordId, ...changes } = edit;
          await saveWorkItem({
            ...item,
            ...changes,
            title: changes.title ?? item.title,
            notes: changes.notes ?? item.notes,
            ...(linkedRecordId !== undefined
              ? {
                  recordId: linkedRecordId,
                  ...(linkedRecordId === null ? { source: 'owner' } : {}),
                }
              : {}),
          });
        } else if (edit.kind === 'create_work_item') {
          await saveWorkItem({
            ...edit.task,
            status: 'open',
            source: 'owner',
            dueAt: edit.task.dueAt ?? null,
          });
        } else if (edit.kind === 'membership') {
          // Targets were validated together above; metadata changes do not navigate browser tabs.
          await db.put('memberships', {
            recordId: edit.recordId,
            projectId: edit.projectId,
            categoryId: edit.categoryId,
            source: 'owner',
            provenance: { author: 'owner' },
            updatedAt: now(),
          });
        } else {
          const record = await db.get('records', edit.recordId);
          if (!record) throw new Error('Tab no longer available.');
          if (edit.kind === 'tab_parent') {
            const records = await db.all('records');
            if (
              edit.parentRecordId &&
              !records.some((item) => item.id === edit.parentRecordId && item.live)
            )
              throw new Error('Parent tab is no longer available.');
            validateTabTree(
              records.map((item) =>
                item.id === record.id ? { ...item, parentRecordId: edit.parentRecordId } : item,
              ),
            );
            record.parentRecordId = edit.parentRecordId;
          } else if (edit.kind === 'branch_name') record.branchName = edit.name;
          else if (edit.kind === 'note') record.note = edit.note;
          else
            record.tags = canonicalTags(
              edit.mode === 'replace'
                ? edit.tags
                : edit.mode === 'add'
                  ? [...record.tags, ...edit.tags]
                  : record.tags.filter(
                      (tag) =>
                        !edit.tags.some((remove) => remove.toLowerCase() === tag.toLowerCase()),
                    ),
            );
          await db.put('records', record);
        }
      }
    },
  );
}
export const getCollectionAnalysis = (id: string) => db.get('collectionAnalyses', id);

export const getActionAnalysis = (id: string) => db.get('actionAnalyses', id);
export async function listActionAnalyses(): Promise<ActionAnalysis[]> {
  return (await db.all('actionAnalyses'))
    .filter((item) => item.status === 'pending')
    .sort((left, right) => right.updatedAt - left.updatedAt);
}
export async function rebaseActionAnalysis(id: string): Promise<ActionAnalysis> {
  await reconcile();
  const existing = await db.get('actionAnalyses', id);
  if (!existing) throw new Error('The saved action plan checkpoint is unavailable.');
  const live = new Map(
    (await db.all('records')).filter((record) => record.live).map((record) => [record.id, record]),
  );
  const scope = existing.scope.flatMap((item) => {
    const record = live.get(item.id);
    return record && !record.locked && record.windowId !== undefined
      ? [
          {
            id: record.id,
            url: record.url,
            navigationVersion: record.navigationVersion,
            windowId: record.windowId,
            groupId: record.groupId,
          },
        ]
      : [];
  });
  if (!scope.length) throw new Error('No eligible tabs remain in this saved action plan.');
  const unchanged = new Set(
    scope
      .filter((item) => {
        const prior = existing.scope.find((candidate) => candidate.id === item.id);
        return prior && JSON.stringify(prior) === JSON.stringify(item);
      })
      .map((item) => item.id),
  );
  const retainedActions = existing.actions.filter((action) =>
    action.recordIds.every((recordId) => unchanged.has(recordId)),
  );
  const invalidated = new Set(
    existing.actions
      .filter((action) => !action.recordIds.every((recordId) => unchanged.has(recordId)))
      .flatMap((action) => action.recordIds),
  );
  const completedIds = existing.completedIds.filter(
    (recordId) => unchanged.has(recordId) && !invalidated.has(recordId),
  );
  const failedIds = existing.failedBatch?.recordIds.filter(
    (recordId) => scope.some((item) => item.id === recordId) && !completedIds.includes(recordId),
  );
  const rebased: ActionAnalysis = {
    ...existing,
    status: 'pending',
    scope,
    completedIds,
    actions: retainedActions,
    matchIds: existing.matchIds.filter(
      (recordId) => unchanged.has(recordId) && !invalidated.has(recordId),
    ),
    summaries: existing.summaries.filter((summary) =>
      summary.recordIds.every((id) => completedIds.includes(id)),
    ),
    failedBatch: failedIds?.length ? { ...existing.failedBatch!, recordIds: failedIds } : undefined,
    revision: existing.revision + 1,
    updatedAt: Date.now(),
  };
  await db.put('actionAnalyses', rebased);
  return rebased;
}
export async function saveActionAnalysis(raw: ActionAnalysis): Promise<ActionAnalysis> {
  const analysis = actionAnalysisSchema.parse(raw);
  const existing = await db.get('actionAnalyses', analysis.id);
  if (analysis.revision !== (existing?.revision ?? 0) + 1)
    throw new Error('This action plan changed in another view. Reload its saved progress.');
  if (
    existing &&
    (existing.sourceAnalysisId !== analysis.sourceAnalysisId ||
      existing.decisionContract !== analysis.decisionContract ||
      existing.status === 'complete' ||
      JSON.stringify(existing.scope) !== JSON.stringify(analysis.scope) ||
      existing.instruction !== analysis.instruction ||
      existing.mode !== analysis.mode ||
      existing.readOnly !== analysis.readOnly ||
      existing.allowCrossWindowMove !== analysis.allowCrossWindowMove ||
      existing.allowSleepWake !== analysis.allowSleepWake ||
      existing.completedIds.some((id) => !analysis.completedIds.includes(id)) ||
      JSON.stringify(existing.actions) !==
        JSON.stringify(analysis.actions.slice(0, existing.actions.length)) ||
      JSON.stringify(existing.matchIds) !==
        JSON.stringify(analysis.matchIds.slice(0, existing.matchIds.length)) ||
      JSON.stringify(existing.summaries) !==
        JSON.stringify(analysis.summaries.slice(0, existing.summaries.length)))
  )
    throw new Error('Saved action batches or scope cannot be rewritten.');
  const scope = new Map(analysis.scope.map((item) => [item.id, item]));

  if (
    scope.size !== analysis.scope.length ||
    new Set(analysis.completedIds).size !== analysis.completedIds.length
  )
    throw new Error('Duplicate occurrence in action scope or progress.');
  if (
    analysis.completedIds.some((id) => !scope.has(id)) ||
    analysis.matchIds.some((id) => !analysis.completedIds.includes(id))
  )
    throw new Error('Action progress contains an unknown occurrence.');
  if (
    analysis.actions.some((action) =>
      action.recordIds.some((id) => !analysis.completedIds.includes(id)),
    )
  )
    throw new Error('Action checkpoint references an unfinished occurrence.');
  const summarizedIds = analysis.summaries.flatMap((summary) => summary.recordIds);
  if (
    new Set(summarizedIds).size !== summarizedIds.length ||
    summarizedIds.length !== analysis.completedIds.length ||
    summarizedIds.some((id) => !analysis.completedIds.includes(id))
  )
    throw new Error('Action batch receipts do not match completed occurrences.');
  if (
    analysis.failedBatch &&
    analysis.failedBatch.recordIds.some(
      (id) => !scope.has(id) || analysis.completedIds.includes(id),
    )
  )
    throw new Error('Failed action batch does not match unfinished progress.');
  if (analysis.status === 'complete' && analysis.completedIds.length !== analysis.scope.length)
    throw new Error('Action plan cannot complete with unfinished occurrences.');
  const live = new Map(
    (await db.all('records')).filter((record) => record.live).map((record) => [record.id, record]),
  );
  if (
    analysis.scope.some((item) => {
      const record = live.get(item.id);
      return (
        !record ||
        record.url !== item.url ||
        record.navigationVersion !== item.navigationVersion ||
        record.windowId !== item.windowId ||
        record.groupId !== item.groupId ||
        record.locked
      );
    })
  )
    throw new Error(
      'A tab changed during action planning. Saved progress was retained for review.',
    );
  await db.put('actionAnalyses', analysis);
  return analysis;
}

export async function saveInferenceReceipt(raw: InferenceReceipt): Promise<void> {
  const receipt = inferenceReceiptSchema.parse(raw);
  if (
    !(await db.get('collectionAnalyses', receipt.analysisId)) &&
    !(await db.get('actionAnalyses', receipt.analysisId))
  )
    throw new Error('The inference receipt has no saved analysis.');
  if (await db.get('inferenceReceipts', receipt.id))
    throw new Error('An inference receipt cannot be overwritten.');
  await db.put('inferenceReceipts', receipt);
}

export async function repairActionAnalysis(id: string): Promise<ActionAnalysis> {
  const source = await db.get('actionAnalyses', id);
  if (!source || source.mode !== 'decision') throw new Error('Saved decision plan is unavailable.');
  const records = (await db.all('records')).filter(
    (record) => record.live && !record.locked && source.scope.some((item) => item.id === record.id),
  );
  if (!records.length)
    throw new Error('No eligible surviving tabs. The original plan is retained.');
  return saveActionAnalysis({
    ...source,
    id: uuid(),
    sourceAnalysisId: id,
    decisionContract: 'isolated-evidence-v2',
    createdAt: now(),
    updatedAt: now(),
    revision: 1,
    status: 'pending',
    scope: records.map((record) => ({
      id: record.id,
      url: record.url,
      navigationVersion: record.navigationVersion,
      windowId: record.windowId!,
      groupId: record.groupId,
    })),
    completedIds: [],
    actions: [],
    matchIds: [],
    summaries: [],
    failedBatch: undefined,
  });
}

export async function rebaseCollectionAnalysis(id: string): Promise<CollectionAnalysis> {
  await reconcile();
  const existing = await db.get('collectionAnalyses', id);
  if (!existing) throw new Error('The saved analysis checkpoint is unavailable.');
  const live = new Map(
    (await db.all('records'))
      .filter((record) => record.live && !record.locked)
      .map((record) => [record.id, record]),
  );
  const ownerCorrected = new Set(
    (await db.all('memberships'))
      .filter((membership) => membership.source === 'owner')
      .map((membership) => membership.recordId),
  );
  const scope = existing.scope.flatMap((item) => {
    const record = live.get(item.id);
    return record && !ownerCorrected.has(item.id)
      ? [{ id: item.id, url: record.url, navigationVersion: record.navigationVersion }]
      : [];
  });
  if (!scope.length)
    throw new Error('No eligible tabs remain in this saved analysis. Its checkpoint was retained.');
  const unchanged = new Set(
    scope
      .filter((item) => {
        const prior = existing.scope.find((candidate) => candidate.id === item.id);
        return prior?.url === item.url && prior.navigationVersion === item.navigationVersion;
      })
      .map((item) => item.id),
  );
  const retained = new Set(scope.map((item) => item.id));
  const classifiedIds = existing.classifiedIds.filter((item) => unchanged.has(item));
  const discoveredIds = existing.discoveredIds.filter(
    (item) => unchanged.has(item) || (existing.classifiedIds.length > 0 && retained.has(item)),
  );
  const failedIds = existing.failedBatch?.recordIds.filter((item) => retained.has(item));
  const rebased: CollectionAnalysis = {
    ...existing,
    skippedRecordIds: existing.skippedRecordIds?.filter((id) => unchanged.has(id)),
    scope,
    discoveredIds,
    classifiedIds,
    assignments: existing.assignments.filter((item) => unchanged.has(item.recordId)),
    tagChecks: existing.tagChecks?.filter((item) => unchanged.has(item.recordId)),
    projectChecks: existing.projectChecks?.filter((item) => unchanged.has(item.recordId)),
    taxonomyProgress:
      !existing.classifiedIds.length && unchanged.size !== existing.scope.length
        ? undefined
        : existing.taxonomyProgress,
    unresolvedTagSuggestions: existing.unresolvedTagSuggestions?.filter((item) =>
      unchanged.has(item.recordId),
    ),
    unresolvedRecordIds: existing.unresolvedRecordIds.filter((item) => unchanged.has(item)),
    failedBatch:
      failedIds?.length &&
      !(
        existing.failedBatch?.stage === 'classification' &&
        discoveredIds.length < scope.length &&
        !existing.reuseAcceptedTaxonomyOnly
      )
        ? { ...existing.failedBatch!, recordIds: failedIds }
        : undefined,
    updatedAt: Date.now(),
    revision: existing.revision + 1,
  };
  await db.put('collectionAnalyses', rebased);
  return rebased;
}

export async function listTagAnalyses(analysisId: string): Promise<TagAnalysis[]> {
  return db.database.tagAnalyses.where('analysisId').equals(analysisId).toArray();
}

export async function saveTagAnalysis(raw: TagAnalysis): Promise<void> {
  const row = tagAnalysisSchema.parse(raw);
  const analysis = await db.get('collectionAnalyses', row.analysisId);
  const record = await db.get('records', row.recordId);
  const previous = await db.get('tagAnalyses', row.id);
  const owner = await db.get('memberships', row.recordId);
  const scope = analysis?.scope.find((item) => item.id === row.recordId);
  if (
    !analysis ||
    !analysis.classifiedIds.includes(row.recordId) ||
    (owner?.source === 'owner' && !analysis.tagTarget) ||
    !record?.live ||
    record.locked ||
    !scope ||
    scope.url !== row.url ||
    scope.navigationVersion !== row.navigationVersion ||
    record.url !== row.url ||
    record.navigationVersion !== row.navigationVersion ||
    (await tagEvidenceKey(record)) !== row.evidenceKey
  )
    throw Error(
      'Tag source changed. Saved tag results were retained; resume with current evidence.',
    );
  const catalog = canonicalTags(analysis.tagVocabulary || []);
  const evidence = tagEvidence(record);
  if (
    row.id !== tagResultId(row) ||
    row.catalogKey !==
      (await tagHash(
        row.contract === 'bounded-tags-v2' ? { contract: row.contract, catalog } : catalog,
      )) ||
    row.cursor > catalog.length ||
    row.tags.some((tag) => !catalog.includes(tag.name)) ||
    [...row.tags, ...row.newTags].some((tag) => !evidence[tag.source].includes(tag.quote)) ||
    row.newTags.some((tag) =>
      catalog.some((name) => name.toLowerCase() === tag.name.toLowerCase()),
    ) ||
    new Set([...row.tags, ...row.newTags].map((tag) => tag.name.toLowerCase())).size !==
      row.tags.length + row.newTags.length ||
    new Set(row.decisions.map((item) => item.name)).size !== row.decisions.length ||
    (row.contract === 'bounded-tags-v2' && row.tags.length + row.newTags.length > 6) ||
    row.decisions.some(
      (item) => ![...row.tags, ...row.newTags].some((tag) => tag.name === item.name),
    )
  )
    throw Error('Invalid tag stage identity, catalog or evidence.');
  if (
    row.revision !== (previous?.revision || 0) + 1 ||
    (previous &&
      (previous.contract !== row.contract ||
        previous.cursor > row.cursor ||
        previous.status === 'complete' ||
        previous.decisions.some(
          (item) =>
            JSON.stringify(row.decisions.find((next) => next.name === item.name)) !==
            JSON.stringify(item),
        ) ||
        (previous.cursor === row.cursor &&
          (JSON.stringify(previous.tags) !== JSON.stringify(row.tags) ||
            JSON.stringify(previous.newTags) !== JSON.stringify(row.newTags) ||
            previous.uncertain !== row.uncertain))))
  )
    throw Error(
      'Saved tag stages cannot be rewound or rewritten. Reload progress or create a repair branch.',
    );
  if (row.status === 'complete' && (!row.proposalModel || row.cursor !== catalog.length))
    throw Error('An unfinished tag proposal cannot be marked complete.');
  await db.put('tagAnalyses', row);
}

export async function saveCollectionAnalysis(raw: CollectionAnalysis): Promise<CollectionAnalysis> {
  const analysis = collectionAnalysisSchema.parse(raw);
  const existing = await db.get('collectionAnalyses', analysis.id);
  if (JSON.stringify(analysis.tagCommit) !== JSON.stringify(existing?.tagCommit))
    throw new Error('Tag completion receipts can only be written with the proposal commit.');
  if (analysis.revision !== (existing?.revision ?? 0) + 1)
    throw new Error(
      'This analysis was changed in another view. Reload its progress before resuming.',
    );
  const completedMissingCategories =
    existing &&
    existing.projects.length === analysis.projects.length &&
    existing.projects.every((project, index) => {
      const next = analysis.projects[index];
      return (
        next?.name === project.name &&
        next.purpose === project.purpose &&
        next.areaName === project.areaName &&
        (!project.categories.length ||
          JSON.stringify(project.categories) === JSON.stringify(next.categories))
      );
    });
  if (
    existing &&
    (Boolean(existing.taggingRequested) !== Boolean(analysis.taggingRequested) ||
      existing.sourceAnalysisId !== analysis.sourceAnalysisId ||
      existing.legacyCategoriesRetained !== analysis.legacyCategoriesRetained ||
      existing.decisionContract !== analysis.decisionContract ||
      JSON.stringify(existing.scope) !== JSON.stringify(analysis.scope) ||
      existing.instruction !== analysis.instruction ||
      existing.purpose !== analysis.purpose ||
      JSON.stringify(existing.tagTarget) !== JSON.stringify(analysis.tagTarget) ||
      existing.reuseAcceptedTaxonomyOnly !== analysis.reuseAcceptedTaxonomyOnly ||
      existing.discoveredIds.some((id) => !analysis.discoveredIds.includes(id)) ||
      existing.classifiedIds.some((id) => !analysis.classifiedIds.includes(id)) ||
      (existing.classifiedIds.length > 0 &&
        JSON.stringify(existing.projectSuggestion) !==
          JSON.stringify(analysis.projectSuggestion)) ||
      (existing.classifiedIds.length > 0 &&
        JSON.stringify(existing.projects) !== JSON.stringify(analysis.projects) &&
        !completedMissingCategories))
  )
    throw new Error('Analysis scope or completed batches cannot be rewritten.');
  const scope = new Map(analysis.scope.map((item) => [item.id, item]));
  if (
    new Set(analysis.skippedTagRecordIds || []).size !==
      (analysis.skippedTagRecordIds || []).length ||
    analysis.skippedTagRecordIds?.some((id) => !scope.has(id))
  )
    throw new Error('Skipped tag tabs must belong to this analysis scope.');
  const skipped = new Set(analysis.skippedRecordIds || []);
  if (
    skipped.size !== (analysis.skippedRecordIds || []).length ||
    [...skipped].some((id) => !scope.has(id)) ||
    existing?.skippedRecordIds?.some((id) => !skipped.has(id)) ||
    [...skipped].some(
      (id) =>
        !existing?.skippedRecordIds?.includes(id) && !existing?.failedBatch?.recordIds.includes(id),
    )
  )
    throw new Error('Only failed occurrences can be explicitly skipped; saved skips are retained.');
  if (
    analysis.taxonomyProgress &&
    (analysis.taxonomyProgress.cursor > analysis.taxonomyProgress.sources.length ||
      (existing?.taxonomyProgress &&
        (analysis.taxonomyProgress.cursor < existing.taxonomyProgress.cursor ||
          JSON.stringify(analysis.taxonomyProgress.sources) !==
            JSON.stringify(existing.taxonomyProgress.sources))))
  )
    throw new Error(
      'Completed taxonomy reconciliation cannot be rewound or replaced. Prepare a repair branch.',
    );
  const projectChecks = new Map(
    (analysis.projectChecks || []).map((item) => [item.recordId, item]),
  );
  if (
    projectChecks.size !== (analysis.projectChecks || []).length ||
    (analysis.projectChecks || []).some(
      (item) =>
        scope.get(item.recordId)?.url !== item.url ||
        scope.get(item.recordId)?.navigationVersion !== item.navigationVersion ||
        (item.projectName !== null &&
          !analysis.projects.some((project) => project.name === item.projectName)),
    ) ||
    existing?.projectChecks?.some(
      (item) => JSON.stringify(projectChecks.get(item.recordId)) !== JSON.stringify(item),
    )
  )
    throw new Error('Saved project decisions cannot be invented or rewritten.');
  const checks = new Map(
    (analysis.tagChecks || []).map((item) => [JSON.stringify([item.recordId, item.tag]), item]),
  );
  if (
    checks.size !== (analysis.tagChecks || []).length ||
    (analysis.tagChecks || []).some(
      (item) => !scope.has(item.recordId) || !analysis.tagVocabulary?.includes(item.tag),
    ) ||
    existing?.tagChecks?.some(
      (item) =>
        JSON.stringify(checks.get(JSON.stringify([item.recordId, item.tag]))) !==
        JSON.stringify(item),
    )
  )
    throw new Error('Saved tag decisions cannot be duplicated, invented or rewritten.');
  if (scope.size !== analysis.scope.length)
    throw new Error('Duplicate occurrence in analysis scope.');
  for (const ids of [
    analysis.discoveredIds,
    analysis.classifiedIds,
    analysis.unresolvedRecordIds,
    analysis.failedBatch?.recordIds || [],
  ]) {
    if (new Set(ids).size !== ids.length || ids.some((id) => !scope.has(id)))
      throw new Error('Analysis progress contains an invalid occurrence.');
  }
  if (
    analysis.failedBatch &&
    analysis.failedBatch.stage !== 'tagging' &&
    (analysis.failedBatch.recordIds.some((id) =>
      (analysis.failedBatch!.stage === 'discovery'
        ? analysis.discoveredIds
        : analysis.classifiedIds
      ).includes(id),
    ) ||
      (analysis.failedBatch.stage === 'classification' &&
        analysis.discoveredIds.length < analysis.scope.length &&
        !analysis.reuseAcceptedTaxonomyOnly))
  )
    throw new Error('Failed batch does not match unfinished analysis progress.');
  const assignments = new Map<string, CollectionAnalysis['assignments'][number]>();
  for (const item of analysis.assignments) {
    const occurrence = scope.get(item.recordId);
    if (
      !occurrence ||
      assignments.has(item.recordId) ||
      item.url !== occurrence.url ||
      item.navigationVersion !== occurrence.navigationVersion ||
      !analysis.projects.some(
        (project) =>
          project.name === item.projectName &&
          project.categories.some((category) => category.name === item.categoryName),
      )
    )
      throw new Error('Analysis checkpoint contains an invalid assignment.');
    assignments.set(item.recordId, item);
  }
  const decided = new Set([...assignments.keys(), ...analysis.unresolvedRecordIds]);
  const independentTags = new Map(
    (analysis.unresolvedTagSuggestions || []).map((item) => [item.recordId, item]),
  );
  if (
    independentTags.size !== (analysis.unresolvedTagSuggestions || []).length ||
    (analysis.unresolvedTagSuggestions || []).some(
      (item) =>
        !analysis.unresolvedRecordIds.includes(item.recordId) ||
        scope.get(item.recordId)?.url !== item.url ||
        scope.get(item.recordId)?.navigationVersion !== item.navigationVersion,
    ) ||
    existing?.unresolvedTagSuggestions?.some(
      (item) => JSON.stringify(independentTags.get(item.recordId)) !== JSON.stringify(item),
    )
  )
    throw new Error('Independent tag decisions cannot be invented or rewritten.');
  if (
    analysis.unresolvedRecordIds.some((id) => assignments.has(id)) ||
    decided.size !== analysis.classifiedIds.length ||
    analysis.classifiedIds.some((id) => !decided.has(id))
  )
    throw new Error('Analysis checkpoint has incomplete batch decisions.');
  if (
    existing?.classifiedIds.some(
      (id) =>
        JSON.stringify(existing.assignments.find((item) => item.recordId === id) || null) !==
          JSON.stringify(assignments.get(id) || null) ||
        existing.unresolvedRecordIds.includes(id) !== analysis.unresolvedRecordIds.includes(id),
    )
  )
    throw new Error('Completed classification decisions cannot be rewritten.');
  const live = new Map(
    (await db.all('records')).filter((item) => item.live).map((item) => [item.id, item]),
  );
  if (
    analysis.scope.some(
      (item) =>
        live.get(item.id)?.url !== item.url ||
        live.get(item.id)?.navigationVersion !== item.navigationVersion,
    )
  )
    throw new Error('A tab changed during analysis. Saved progress was retained for review.');
  await db.put('collectionAnalyses', analysis);
  return analysis;
}

export async function clearCollectionAnalysis(id: string): Promise<void> {
  await db.remove('collectionAnalyses', id);
}

/** Explicit branch: never rewrite the source checkpoint or a pending owner draft. */
export async function repairCollectionAnalysis(
  id: string,
  stage: 'discovery' | 'classification' | 'tagging' | 'skipped',
): Promise<CollectionAnalysis> {
  stage = z.enum(['discovery', 'classification', 'tagging', 'skipped']).parse(stage);
  const source = await db.get('collectionAnalyses', id);
  if (!source) throw new Error('Saved analysis is unavailable.');
  const app = await state();
  const corrected = new Set(
    app.memberships.filter((item) => item.source === 'owner').map((item) => item.recordId),
  );
  const records = app.records.filter(
    (record) =>
      record.live &&
      !record.locked &&
      !corrected.has(record.id) &&
      source.scope.some((item) => item.id === record.id),
  );
  if (!records.length)
    throw new Error('No eligible surviving occurrences. Original progress is retained.');
  const unchanged = new Set(
    records
      .filter((record) =>
        source.scope.some(
          (item) =>
            item.id === record.id &&
            item.url === record.url &&
            item.navigationVersion === record.navigationVersion,
        ),
      )
      .map((record) => record.id),
  );
  const skipped = new Set(source.skippedRecordIds || []);
  if (stage === 'skipped' && !source.projects.some((project) => project.categories.length))
    throw new Error(
      'Finish discovery or rebuild project structure before retrying skipped tabs against its categories.',
    );
  if (stage === 'skipped' && !records.some((record) => skipped.has(record.id)))
    throw new Error('No eligible skipped occurrences remain to retry.');
  const retryScope =
    stage === 'skipped'
      ? records.filter((record) => unchanged.has(record.id) || skipped.has(record.id))
      : records;
  const retained = (recordId: string) => unchanged.has(recordId) && !skipped.has(recordId);
  const branch: CollectionAnalysis = {
    ...source,
    id: uuid(),
    sourceAnalysisId: id,
    taggingRequested: stage === 'tagging',
    tagCommit: undefined,
    skippedTagRecordIds: undefined,
    skippedRecordIds: undefined,
    tagTarget: stage === 'tagging' ? source.tagTarget : undefined,
    createdAt: now(),
    updatedAt: now(),
    revision: 1,
    decisionContract: 'isolated-evidence-v2',
    purpose: stage === 'discovery' && source.purpose === 'reclassify' ? 'scoped' : source.purpose,
    legacyCategoriesRetained:
      stage === 'tagging' &&
      (Boolean(source.legacyCategoriesRetained) ||
        source.decisionContract !== 'isolated-evidence-v2'),
    scope: retryScope.map(({ id, url, navigationVersion }) => ({ id, url, navigationVersion })),
    discoveredIds:
      stage === 'discovery'
        ? []
        : stage === 'skipped'
          ? retryScope.map((record) => record.id)
          : source.discoveredIds.filter((id) => unchanged.has(id)),
    projects: stage === 'discovery' ? [] : source.projects,
    summaries: stage === 'discovery' ? [] : source.summaries,
    reuseAcceptedTaxonomyOnly:
      stage === 'discovery' ? false : stage === 'skipped' ? true : source.reuseAcceptedTaxonomyOnly,
    projectSuggestion: stage === 'discovery' ? undefined : source.projectSuggestion,
    taxonomyProgress:
      stage === 'tagging' && unchanged.size === source.scope.length
        ? source.taxonomyProgress
        : undefined,
    classifiedIds:
      stage === 'tagging'
        ? source.classifiedIds.filter((id) => unchanged.has(id))
        : stage === 'skipped'
          ? source.classifiedIds.filter(retained)
          : [],
    assignments:
      stage === 'tagging'
        ? source.assignments
            .filter((item) => unchanged.has(item.recordId))
            .map((item) => ({ ...item, suggestedTags: [] }))
        : stage === 'skipped'
          ? source.assignments.filter((item) => retained(item.recordId))
          : [],
    unresolvedRecordIds:
      stage === 'tagging'
        ? source.unresolvedRecordIds.filter((id) => unchanged.has(id))
        : stage === 'skipped'
          ? source.unresolvedRecordIds.filter(retained)
          : [],
    tagChecks: [],
    unresolvedTagSuggestions:
      stage === 'skipped'
        ? source.unresolvedTagSuggestions?.filter((item) => retained(item.recordId))
        : [],
    failedBatch: undefined,
    projectChecks:
      stage === 'tagging'
        ? source.projectChecks?.filter((item) => unchanged.has(item.recordId))
        : stage === 'skipped'
          ? source.projectChecks?.filter((item) => retained(item.recordId))
          : [],
  };
  return saveCollectionAnalysis(branch);
}

export async function repairCollectionProposal(
  id: string,
  stage: 'classification' | 'tagging' = 'classification',
): Promise<CollectionAnalysis> {
  const proposal = await db.get('collectionProposals', id);
  if (!proposal || proposal.status !== 'pending')
    throw new Error('Only a pending draft can seed a separate repair.');
  const app = await state();
  const corrected = new Set(
    app.memberships.filter((item) => item.source === 'owner').map((item) => item.recordId),
  );
  const ids = new Set(
    proposal.scopeRecordIds || [
      ...proposal.assignments.map((item) => item.recordId),
      ...proposal.unresolvedRecordIds,
    ],
  );
  const records = app.records.filter(
    (record) => ids.has(record.id) && record.live && !record.locked && !corrected.has(record.id),
  );
  if (!records.length)
    throw new Error(
      'This draft has no eligible surviving occurrences to re-evaluate. The draft is retained.',
    );
  const retainedAssignments =
    stage === 'tagging'
      ? proposal.assignments
          .filter((item) =>
            records.some(
              (record) =>
                record.id === item.recordId &&
                record.url === item.url &&
                record.navigationVersion === item.navigationVersion,
            ),
          )
          .map((item) => ({ ...item, suggestedTags: [] }))
      : [];
  const retainedUnresolved =
    stage === 'tagging'
      ? proposal.unresolvedRecordIds.filter((id) => records.some((record) => record.id === id))
      : [];
  return saveCollectionAnalysis({
    id: uuid(),
    sourceAnalysisId: `proposal:${id}`,
    taggingRequested: stage === 'tagging',
    decisionContract: 'isolated-evidence-v2',
    legacyCategoriesRetained:
      stage === 'tagging' &&
      (proposal.legacyCategoriesRetained || proposal.decisionContract !== 'isolated-evidence-v2'),
    createdAt: now(),
    updatedAt: now(),
    revision: 1,
    purpose: 'proposal',
    instruction: '',
    reuseAcceptedTaxonomyOnly: stage === 'tagging',
    scope: records.map(({ id, url, navigationVersion }) => ({ id, url, navigationVersion })),
    discoveredIds: records.map((record) => record.id),
    projects: structuredClone(proposal.projects),
    summaries: [],
    classifiedIds: [...retainedAssignments.map((item) => item.recordId), ...retainedUnresolved],
    assignments: retainedAssignments,
    unresolvedRecordIds: retainedUnresolved,
    tagVocabulary: [
      ...new Set([
        ...(app.tagVocabulary || []),
        ...proposal.assignments.flatMap((item) => item.suggestedTags || []),
        ...(proposal.unresolvedTagSuggestions || []).flatMap((item) => item.suggestedTags),
      ]),
    ],
    tagChecks: [],
  });
}

export async function saveCollectionProposal(raw: CollectionDraft): Promise<CollectionProposal> {
  const app = await state();
  const eligible = app.records.filter(
    (r) =>
      r.live &&
      !r.locked &&
      !app.memberships.some((m) => m.recordId === r.id && m.source === 'owner'),
  );
  const byId = new Map(eligible.map((r) => [r.id, r]));
  const input = validateCollectionDraft(raw, new Set(byId.keys()));
  for (const id of input.sourceJobIds || []) {
    const job = await db.get('organizationJobs', id);
    if (
      !job ||
      job.kind !== 'collection' ||
      job.status !== 'running' ||
      (job.leaseUntil || 0) <= now() ||
      !input.scopeRecordIds?.includes(job.recordId) ||
      byId.get(job.recordId)?.url !== job.url ||
      byId.get(job.recordId)?.navigationVersion !== job.navigationVersion ||
      (job.fingerprint !== undefined &&
        job.fingerprint !== organizationFingerprint(byId.get(job.recordId)!))
    )
      throw new Error('New-tab analysis became stale before its proposal was saved.');
  }
  const assigned = new Set<string>();
  for (const item of input.assignments) {
    const record = byId.get(item.recordId);
    if (
      !record ||
      assigned.has(item.recordId) ||
      item.url !== record.url ||
      item.navigationVersion !== record.navigationVersion
    )
      throw new Error(
        'Collection proposal is stale or includes a protected/unknown occurrence. Refresh and analyze again.',
      );
    const project = input.projects.find(
      (p) => p.name.toLowerCase() === item.projectName.toLowerCase(),
    );
    if (!project?.categories.some((c) => c.name.toLowerCase() === item.categoryName.toLowerCase()))
      throw new Error('Collection proposal references an unknown project category.');
    assigned.add(item.recordId);
  }
  for (const item of input.unresolvedTagSuggestions || []) {
    const record = byId.get(item.recordId);
    if (!record || record.url !== item.url || record.navigationVersion !== item.navigationVersion)
      throw new Error('An independent tag proposal is stale or protected.');
  }
  const proposal: CollectionProposal = {
    ...input,
    id: uuid(),
    createdAt: now(),
    status: 'pending',
  };
  await db.put('collectionProposals', proposal);
  return proposal;
}
export async function updateCollectionProposal(
  id: string,
  raw: CollectionDraft,
  allowScopeExpansion = false,
  options?: { expectedFingerprint?: string; merge?: boolean },
): Promise<CollectionProposal> {
  const proposal = await db.get('collectionProposals', id);
  const before = proposal ? structuredClone(proposal) : undefined;
  if (!proposal || proposal.status !== 'pending')
    throw new Error('Collection proposal is no longer available for review.');
  if (options?.expectedFingerprint && options.expectedFingerprint !== (await tagHash(proposal)))
    throw new Error(
      'This proposal changed in another chat or view. Read it again before editing; no edits were saved.',
    );
  if (proposal.copyState)
    throw new Error(
      'Window creation has started. Retry or undo this arrangement before changing its draft.',
    );
  const app = await state();
  const eligible = app.records.filter(
    (record) =>
      record.live &&
      !record.locked &&
      !app.memberships.some(
        (membership) => membership.recordId === record.id && membership.source === 'owner',
      ),
  );
  const byId = new Map(eligible.map((record) => [record.id, record]));
  const priorIds = proposal.scopeRecordIds || [
    ...proposal.assignments.map((item) => item.recordId),
    ...proposal.unresolvedRecordIds,
  ];
  const draft = validateCollectionDraft(raw, new Set([...byId.keys(), ...priorIds]));
  const previousScope = proposal.scopeRecordIds?.length
    ? proposal.scopeRecordIds
    : [
        ...new Set([
          ...proposal.assignments.map((item) => item.recordId),
          ...proposal.unresolvedRecordIds,
        ]),
      ];
  const scopeUnchanged =
    JSON.stringify(draft.scopeRecordIds) === JSON.stringify(proposal.scopeRecordIds);
  const scopeExpanded =
    allowScopeExpansion &&
    draft.scopeRecordIds &&
    previousScope.every((recordId) => draft.scopeRecordIds?.includes(recordId));
  if (
    (!scopeUnchanged && !scopeExpanded) ||
    JSON.stringify(draft.sourceJobIds) !== JSON.stringify(proposal.sourceJobIds)
  )
    throw new Error('A saved proposal cannot change its analysis scope or queue linkage.');
  if (scopeExpanded && !scopeUnchanged && !options?.merge) {
    const assignments = new Map(draft.assignments.map((item) => [item.recordId, item]));
    const unresolved = new Set(draft.unresolvedRecordIds);
    if (
      proposal.assignments.some(
        (item) => JSON.stringify(assignments.get(item.recordId)) !== JSON.stringify(item),
      ) ||
      proposal.unresolvedRecordIds.some((recordId) => !unresolved.has(recordId))
    )
      throw new Error(
        'Expanding a proposal must preserve its reviewed assignments and unresolved tabs.',
      );
  }
  for (const assignment of [...draft.assignments, ...(draft.unresolvedTagSuggestions || [])]) {
    if (draft.excludedRecordIds?.includes(assignment.recordId)) continue;
    const record = byId.get(assignment.recordId);
    if (
      !record ||
      record.url !== assignment.url ||
      record.navigationVersion !== assignment.navigationVersion
    )
      throw new Error(
        'A tab changed while you reviewed the proposal. Sync changed tabs, then review.',
      );
  }
  Object.assign(proposal, draft);
  proposal.updatedAt = Math.max(now(), (proposal.updatedAt || proposal.createdAt) + 1);
  await saveProposalRevision(before!, proposal, options?.merge ? 'Merge proposals' : 'Edit draft');
  return proposal;
}
export async function mergeCollectionProposals(raw: unknown) {
  const input = z
    .object({
      targetProposalId: z.string().min(1),
      sourceProposalId: z.string().min(1),
      targetFingerprint: z.string().min(1),
      sourceFingerprint: z.string().min(1),
      projectNames: z.array(z.string().min(1).max(80)).max(1000),
      assignmentConflict: z.enum(['keep_target', 'use_source']),
    })
    .parse(raw);
  const target = await db.get('collectionProposals', input.targetProposalId);
  const source = await db.get('collectionProposals', input.sourceProposalId);
  if (!target || !source)
    throw new Error('Source or target proposal not found. List proposals and use exact IDs.');
  if (
    (await tagHash(target)) !== input.targetFingerprint ||
    (await tagHash(source)) !== input.sourceFingerprint
  )
    throw new Error(
      'A proposal changed in another chat or view. Read both proposals again before merging.',
    );
  const { draft, conflicts } = mergeProposalDrafts(
    target,
    source,
    input.projectNames,
    input.assignmentConflict,
  );
  const proposal = await updateCollectionProposal(target.id, draft, true, {
    expectedFingerprint: input.targetFingerprint,
    merge: true,
  });
  return { proposal, conflicts };
}
export async function updateCollectionTags(raw: unknown): Promise<CollectionProposal> {
  const input = z
    .object({
      analysisId: z.string().min(1).optional(),
      id: z.string().min(1),
      expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      patches: z
        .array(
          z.object({
            recordId: z.string().min(1),
            url: z.string().max(10000),
            navigationVersion: z.number().int().min(0),
            suggestedTags: z.array(z.string().trim().min(1).max(80)),
            review: z.array(
              z.object({
                name: z.string().trim().min(1).max(80),
                outcome: z.enum(['new', 'uncertain']),
              }),
            ),
          }),
        )
        .max(1000),
    })
    .parse(raw);
  const proposal = await db.get('collectionProposals', input.id);
  const analysis = await db.get('collectionAnalyses', input.analysisId);
  if (analysis?.tagCommit) {
    if (analysis.tagCommit.proposalId !== input.id || !proposal)
      throw new Error('Tag receipt target differs.');
    return proposal;
  }
  if (
    input.analysisId &&
    (!analysis?.tagTarget ||
      analysis.tagTarget.proposalId !== input.id ||
      analysis.tagTarget.proposalFingerprint !== input.expectedFingerprint)
  )
    throw new Error('Tag commit must match its saved analysis target.');
  if (!proposal || proposal.status !== 'pending' || proposal.copyState)
    throw new Error('Choose a pending organization draft without window creation in progress.');
  if ((await tagHash(proposal)) !== input.expectedFingerprint)
    throw new Error(
      'The proposal changed during tag analysis. Saved tag progress was retained; review the updated draft.',
    );
  const scope = new Set(
    proposal.scopeRecordIds || [
      ...proposal.assignments.map((item) => item.recordId),
      ...proposal.unresolvedRecordIds,
    ],
  );
  const seen = new Set<string>();
  const draft = { ...proposal };
  const assignments = new Map(proposal.assignments.map((item) => [item.recordId, { ...item }]));
  const independent = new Map(
    (proposal.unresolvedTagSuggestions || []).map((item) => [item.recordId, { ...item }]),
  );
  const reviews = new Map((proposal.tagReview || []).map((item) => [item.recordId, item]));
  for (const patch of input.patches) {
    if (!scope.has(patch.recordId) || seen.has(patch.recordId))
      throw new Error('Tag patches must use unique occurrence IDs from this proposal.');
    seen.add(patch.recordId);
    const record = await db.get('records', patch.recordId);
    const existing = assignments.get(patch.recordId) || independent.get(patch.recordId);
    if (
      !record?.live ||
      record.locked ||
      record.url !== patch.url ||
      record.navigationVersion !== patch.navigationVersion ||
      (existing &&
        (existing.url !== patch.url || existing.navigationVersion !== patch.navigationVersion))
    )
      throw new Error('A tagged tab changed or became protected. Saved tag progress was retained.');
    const suggestedTags = canonicalTags(patch.suggestedTags);
    const assignment = assignments.get(patch.recordId);
    if (assignment) assignment.suggestedTags = suggestedTags;
    else
      independent.set(patch.recordId, {
        recordId: patch.recordId,
        url: patch.url,
        navigationVersion: patch.navigationVersion,
        suggestedTags,
      });
    if (patch.review.length)
      reviews.set(patch.recordId, { recordId: patch.recordId, tags: patch.review });
    else reviews.delete(patch.recordId);
  }
  Object.assign(draft, {
    assignments: [...assignments.values()],
    unresolvedTagSuggestions: [...independent.values()],
    tagReview: [...reviews.values()],
  });
  validateCollectionDraft(draft, scope);
  draft.updatedAt = Math.max(now(), (proposal.updatedAt || proposal.createdAt) + 1);
  await db.database.transaction(
    'rw',
    db.database.collectionProposals,
    db.database.collectionAnalyses,
    db.database.proposalRevisions,
    async () => {
      await saveProposalRevision(proposal, draft, 'Analyze tags');
      if (analysis)
        await db.put('collectionAnalyses', {
          ...analysis,
          failedBatch: undefined,
          tagCommit: {
            proposalId: input.id,
            processed: input.patches.length,
            tagged: input.patches.filter((patch) => patch.suggestedTags.length > 0).length,
            needsReview: input.patches.filter((patch) => patch.review.length > 0).length,
            skipped:
              (analysis.tagTarget?.skippedCount || 0) + (analysis.skippedTagRecordIds?.length || 0),
          },
        });
    },
  );
  return draft;
}
export async function rebaseCollectionProposal(
  id: string,
  raw?: CollectionDraft,
  expectedFingerprint?: string,
): Promise<CollectionProposal> {
  const proposal = await db.get('collectionProposals', id);
  const before = proposal ? structuredClone(proposal) : undefined;
  if (!proposal || proposal.status !== 'pending' || proposal.copyState)
    throw new Error('This proposal is no longer available to sync.');
  if (expectedFingerprint && expectedFingerprint !== (await tagHash(proposal)))
    throw new Error(
      'This proposal changed in another chat or view. Reload the saved draft before syncing local edits.',
    );
  const previousScope = proposal.scopeRecordIds?.length
    ? proposal.scopeRecordIds
    : [
        ...new Set([
          ...proposal.assignments.map((item) => item.recordId),
          ...proposal.unresolvedRecordIds,
        ]),
      ];
  const source = raw ? validateCollectionDraft(raw, new Set(previousScope)) : proposal;
  if (
    raw &&
    (JSON.stringify(raw.scopeRecordIds) !== JSON.stringify(proposal.scopeRecordIds) ||
      JSON.stringify(raw.sourceJobIds) !== JSON.stringify(proposal.sourceJobIds))
  )
    throw new Error('A saved proposal cannot change its analysis scope or queue linkage.');
  const app = await state();
  const live = new Map(app.records.map((record) => [record.id, record]));
  const ownerIds = new Set(
    app.memberships
      .filter((membership) => membership.source === 'owner')
      .map((membership) => membership.recordId),
  );
  const scopeRecordIds = previousScope.filter((recordId) => {
    const record = live.get(recordId);
    return record?.live && !record.locked && !ownerIds.has(recordId);
  });
  if (!scopeRecordIds.length)
    throw new Error(
      'No eligible tabs from this proposal are still open. The saved draft was kept.',
    );
  const scope = new Set(scopeRecordIds);
  const assignments = source.assignments.filter((assignment) => {
    const record = live.get(assignment.recordId);
    return (
      scope.has(assignment.recordId) &&
      record?.url === assignment.url &&
      record.navigationVersion === assignment.navigationVersion
    );
  });
  const assigned = new Set(assignments.map((assignment) => assignment.recordId));
  const unresolvedRecordIds = scopeRecordIds.filter((recordId) => !assigned.has(recordId));
  const draft = validateCollectionDraft(
    {
      ...source,
      assignments,
      unresolvedRecordIds,
      tagReview: source.tagReview?.filter((item) => scopeRecordIds.includes(item.recordId)),
      unresolvedTagSuggestions: source.unresolvedTagSuggestions?.filter((item) => {
        const record = live.get(item.recordId);
        return (
          unresolvedRecordIds.includes(item.recordId) &&
          record?.url === item.url &&
          record.navigationVersion === item.navigationVersion
        );
      }),
      ownerAssignedRecordIds: (source.ownerAssignedRecordIds || []).filter((recordId) =>
        assigned.has(recordId),
      ),
      scopeRecordIds,
      sourceJobIds: source.sourceJobIds,
    },
    scope,
  );
  Object.assign(proposal, draft);
  proposal.updatedAt = now();
  await saveProposalRevision(before!, proposal, 'Sync changed tabs');
  return proposal;
}
export async function applyCollectionProposal(
  id: string,
  copiedRecordIds?: ReadonlyMap<string, string>,
  validatedApp?: AppState,
): Promise<CollectionProposal> {
  const proposal = await db.get('collectionProposals', id);
  if (!proposal || proposal.status !== 'pending')
    throw new Error('Collection proposal is no longer pending.');
  const app = validatedApp || (await state());
  const includedAssignments = proposal.assignments.filter(
    (item) => !proposal.excludedRecordIds?.includes(item.recordId),
  );
  const assignments = includedAssignments.map((assignment) => {
    const recordId = copiedRecordIds?.get(assignment.recordId);
    return recordId ? { ...assignment, recordId, navigationVersion: 0 } : assignment;
  });
  if (
    proposal.copyState &&
    (!copiedRecordIds || copiedRecordIds.size !== includedAssignments.length)
  )
    throw new Error('Complete the reviewed copy arrangement before accepting its assignments.');
  const ownerIds = new Set(
    app.memberships.filter((m) => m.source === 'owner').map((m) => m.recordId),
  );
  for (const jobId of proposal.sourceJobIds || []) {
    const job = await db.get('organizationJobs', jobId);
    if (!job) throw new Error('A linked review job is missing. Nothing was applied.');
    if (!assignments.some((assignment) => assignment.recordId === job.recordId)) continue;
    const record = app.records.find((item) => item.id === job.recordId);
    if (
      !record ||
      (job.fingerprint !== undefined && job.fingerprint !== organizationFingerprint(record))
    ) {
      throw new Error(
        'A reviewed tab changed its page or native placement. Sync changed tabs, then review; nothing was applied.',
      );
    }
  }
  for (const item of assignments) {
    const record = app.records.find((r) => r.id === item.recordId);
    if (
      !record?.live ||
      record.locked ||
      ownerIds.has(item.recordId) ||
      record.url !== item.url ||
      record.navigationVersion !== item.navigationVersion
    ) {
      throw new Error(
        'A tab changed or was protected after analysis. Sync changed tabs, then review; nothing was applied.',
      );
    }
  }
  if (!copiedRecordIds)
    for (const item of proposal.unresolvedTagSuggestions || []) {
      if (proposal.excludedRecordIds?.includes(item.recordId)) continue;
      const record = app.records.find((r) => r.id === item.recordId);
      if (
        !record?.live ||
        record.locked ||
        ownerIds.has(item.recordId) ||
        record.url !== item.url ||
        record.navigationVersion !== item.navigationVersion
      )
        throw new Error('An independently tagged tab changed. Sync changed tabs before Apply.');
    }
  const aiProvenance: Provenance = {
    author: 'ai',
    model: proposal.model,
    proposalId: proposal.id,
  };
  const projectMap = new Map<string, Project>();
  const areas = [...app.areas];
  const categories = [...app.categories];
  const unresolved = copiedRecordIds
    ? []
    : app.records.filter(
        (record) =>
          proposal.unresolvedRecordIds.includes(record.id) &&
          !proposal.excludedRecordIds?.includes(record.id) &&
          record.live &&
          !record.locked &&
          !ownerIds.has(record.id),
      );
  proposal.beforeMemberships = app.memberships.filter(
    (membership) =>
      assignments.some((assignment) => assignment.recordId === membership.recordId) ||
      unresolved.some((record) => record.id === membership.recordId),
  );
  proposal.appliedMemberships = [];
  proposal.tagChanges = [];
  // Persist the domain commit and its recovery data atomically. No browser calls in this transaction.
  await db.database.transaction(
    'rw',
    ['areas', 'projects', 'categories', 'memberships', 'collectionProposals', 'records'],
    async () => {
      for (const spec of proposal.projects) {
        if (
          !assignments.some(
            (assignment) => assignment.projectName.toLowerCase() === spec.name.toLowerCase(),
          )
        )
          continue;
        let area = areas.find(
          (candidate) => candidate.name.toLowerCase() === spec.areaName?.toLowerCase(),
        );
        if (!area && spec.areaName) {
          area = {
            id: uuid(),
            name: spec.areaName,
            description: '',
            createdAt: now(),
            updatedAt: now(),
            provenance: aiProvenance,
          };
          areas.push(area);
          await db.put('areas', area);
        }
        const key = spec.name.toLowerCase();
        let projectValue = app.projects.find((candidate) => candidate.name.toLowerCase() === key);
        if (!projectValue) {
          projectValue = {
            id: uuid(),
            name: spec.name,
            purpose: spec.purpose,
            areaId: area?.id || null,
            revision: 1,
            updatedAt: now(),
            maintainReviewQueue: false,
            provenance: aiProvenance,
          };
          await db.put('projects', projectValue);
        } else if (!projectValue.areaId && area) {
          projectValue = {
            ...projectValue,
            areaId: area?.id || null,
            revision: projectValue.revision + 1,
            updatedAt: now(),
          };
          await db.put('projects', projectValue);
        }
        projectMap.set(key, projectValue);
        for (const specCategory of spec.categories) {
          if (
            categories.some(
              (category) =>
                category.projectId === projectValue.id &&
                category.name.toLowerCase() === specCategory.name.toLowerCase(),
            )
          )
            continue;
          const category: Category = {
            id: uuid(),
            projectId: projectValue.id,
            name: specCategory.name,
            description: specCategory.description,
            order: categories.filter((entry) => entry.projectId === projectValue.id).length,
            updatedAt: now(),
            revision: 1,
            provenance: aiProvenance,
          };
          categories.push(category);
          await db.put('categories', category);
        }
      }
      for (const assignment of assignments) {
        const projectValue = projectMap.get(assignment.projectName.toLowerCase());
        const category = categories.find(
          (entry) =>
            entry.projectId === projectValue?.id &&
            entry.name.toLowerCase() === assignment.categoryName.toLowerCase(),
        );
        if (!projectValue || !category)
          throw new Error(
            'A reviewed project/category could not be resolved. Nothing was committed.',
          );
        const sourceId =
          proposal.copyState?.entries.find((entry) => entry.recordId === assignment.recordId)
            ?.sourceRecordId || assignment.recordId;
        const owner = proposal.ownerAssignedRecordIds?.includes(sourceId);
        const membership: Membership = {
          recordId: assignment.recordId,
          projectId: projectValue.id,
          categoryId: category.id,
          source: owner ? 'owner' : 'accepted-ai',
          provenance: owner ? { author: 'owner' } : aiProvenance,
          reason: owner ? 'Owner correction during review.' : assignment.reason,
          updatedAt: now(),
        };
        proposal.appliedMemberships!.push(membership);
        await db.put('memberships', membership);
        if (assignment.suggestedTags?.length) {
          const record = await db.get('records', assignment.recordId);
          if (record && !record.locked) {
            const after = canonicalTags([...record.tags, ...assignment.suggestedTags]);
            proposal.tagChanges!.push({ recordId: record.id, before: [...record.tags], after });
            await db.put('records', { ...record, tags: after });
          }
        }
      }
      for (const record of unresolved) {
        const tags =
          proposal.unresolvedTagSuggestions?.find((item) => item.recordId === record.id)
            ?.suggestedTags || [];
        if (tags.length) {
          const after = canonicalTags([...record.tags, ...tags]);
          proposal.tagChanges!.push({ recordId: record.id, before: [...record.tags], after });
          await db.put('records', { ...record, tags: after });
        }
        const membership: Membership = {
          recordId: record.id,
          projectId: null,
          categoryId: null,
          source: 'unassigned',
          updatedAt: now(),
        };
        proposal.appliedMemberships!.push(membership);
        await db.put('memberships', membership);
      }
      proposal.status = 'applied';
      await db.put('collectionProposals', proposal);
    },
  );
  return proposal;
}
export async function organizeCollection(
  id: string,
): Promise<{ proposal: CollectionProposal; operation?: Operation }> {
  let proposal = await db.get('collectionProposals', id);
  if (!proposal) throw new Error('Collection proposal not found.');
  if (!proposal.sourceJobIds?.length)
    return copyCollectionToProjectWindows(id, {
      state,
      snapshot,
      applyCollectionProposal,
      applyPlan,
      bindProject,
      settings,
      saveSettings,
    });
  if (proposal.status === 'pending') proposal = await applyCollectionProposal(id);
  if (proposal.status !== 'applied')
    throw new Error('Only a reviewed, applied collection can be grouped.');
  const app = await state();
  const actions = nativeGroupActions(proposal, app);
  if (!actions.length) return { proposal };
  const operation = await applyPlan({
    summary: `AI maintenance · ${actions.length} category groups in existing windows`,
    actions,
    collectionProposalId: id,
    provenance: { author: 'ai', model: proposal.model, proposalId: id },
    expected: Object.fromEntries(
      proposal.assignments.map((assignment) => [
        assignment.recordId,
        { url: assignment.url, navigationVersion: assignment.navigationVersion },
      ]),
    ),
  });
  return { proposal: (await db.get('collectionProposals', id))!, operation };
}
export async function undoCollection(
  id: string,
): Promise<{ restored: number; skipped: number; outcomes: RestoreResult[] }> {
  const proposal = await db.get('collectionProposals', id);
  if (proposal?.copyState) return undoCollectionCopies(proposal, { state, snapshot });
  if (!proposal || proposal.status !== 'applied' || !proposal.appliedMemberships)
    throw new Error('This collection has no available assignment recovery record.');
  let outcomes: RestoreResult[] = [];
  if (proposal.operationId) {
    const operation = await db.get('operations', proposal.operationId);
    if (!operation) throw new Error('The original browser operation is unavailable.');
    const related = (await db.all('operations')).filter(
      (entry) => entry.collectionProposalId === id,
    );
    outcomes = await restoreSnapshot(operation.snapshotId, {
      onlyRecordIds: [
        ...new Set(related.flatMap((entry) => entry.actions.flatMap((action) => action.recordIds))),
      ],
    });
    if (outcomes.some((result) => !result.ok))
      return { restored: 0, skipped: proposal.appliedMemberships.length, outcomes };
  }
  let restored = 0;
  let skipped = 0;
  await db.database.transaction(
    'rw',
    ['memberships', 'collectionProposals', 'operations', 'records'],
    async () => {
      for (const applied of proposal.appliedMemberships!) {
        const current = await db.get('memberships', applied.recordId);
        // An owner correction or subsequent organization is newer authority than this old commit.
        if (
          !current ||
          current.updatedAt !== applied.updatedAt ||
          current.projectId !== applied.projectId ||
          current.categoryId !== applied.categoryId ||
          current.source !== applied.source
        ) {
          skipped += 1;
          continue;
        }
        const previous = proposal.beforeMemberships?.find(
          (membership) => membership.recordId === applied.recordId,
        );
        if (previous) await db.put('memberships', previous);
        else await db.remove('memberships', applied.recordId);
        restored += 1;
      }
      for (const change of proposal.tagChanges || []) {
        const record = await db.get('records', change.recordId);
        if (
          record &&
          !record.locked &&
          JSON.stringify(record.tags) === JSON.stringify(change.after)
        )
          await db.put('records', { ...record, tags: change.before });
      }
      for (const operation of await db.all('operations')) {
        if (operation.collectionProposalId !== id) continue;
        operation.status = 'undone';
        await db.put('operations', operation);
      }
      proposal.status = 'undone';
      await db.put('collectionProposals', proposal);
    },
  );
  outcomes.push({
    ok: true,
    title: `${restored} assignments restored; ${skipped} newer corrections retained.`,
  });
  return { restored, skipped, outcomes };
}
export async function dismissCollectionProposal(id: string): Promise<void> {
  const proposal = await db.get('collectionProposals', id);
  if (!proposal || proposal.status !== 'pending')
    throw new Error('Collection proposal is no longer pending.');
  proposal.status = 'dismissed';
  await db.put('collectionProposals', proposal);
}

export async function saveOrganizationProposal(
  input: OrganizationDraft & { sourceJobId?: string },
): Promise<OrganizationProposal> {
  if (input.sourceJobId) {
    const previous = (await db.all('proposals')).find(
      (proposal) => proposal.sourceJobId === input.sourceJobId,
    );
    if (previous) return previous;
  }
  const projectValue = await db.get('projects', input.projectId);
  if (!projectValue) throw new Error('Project no longer exists.');
  if (
    (await db.all('proposals')).some(
      (proposal) => proposal.projectId === input.projectId && proposal.status === 'pending',
    )
  )
    throw new Error('Review or dismiss the existing project proposal before creating another.');
  const ids = [
    ...input.assignments.map((assignment) => assignment.recordId),
    ...input.unresolvedRecordIds,
  ];
  const rows = await Promise.all(ids.map((id) => db.get('records', id)));
  const records = rows.filter((record): record is TabRecord => Boolean(record));
  const currentMemberships = await db.all('memberships');
  const ownerCorrections = new Set(
    currentMemberships
      .filter((membership) => membership.source === 'owner')
      .map((membership) => membership.recordId),
  );
  const categories = await db.all('categories');
  const valid = validateOrganizationDraft(
    input,
    projectValue,
    records,
    ownerCorrections,
    categories
      .filter((category) => category.projectId === input.projectId)
      .map((category) => category.name),
  );
  const signature = organizationDraftSignature(valid);
  const priorDismissal = (await db.all('proposals')).find(
    (proposal) =>
      proposal.status === 'dismissed' && organizationDraftSignature(proposal) === signature,
  );
  if (priorDismissal) {
    if (!input.sourceJobId) return priorDismissal;
    const alreadyDismissed: OrganizationProposal = {
      ...priorDismissal,
      id: uuid(),
      createdAt: now(),
      sourceJobId: input.sourceJobId,
    };
    await db.put('proposals', alreadyDismissed);
    return alreadyDismissed;
  }
  const proposal: OrganizationProposal = {
    ...valid,
    id: uuid(),
    createdAt: now(),
    status: 'pending',
    sourceJobId: input.sourceJobId,
  };
  await db.put('proposals', proposal);
  return proposal;
}
export async function reviewOrganizationTag(input: {
  id: string;
  recordId: string;
  name: string;
  include: boolean;
}): Promise<OrganizationProposal> {
  const stored = await db.get('proposals', input.id);
  const record = await db.get('records', input.recordId);
  if (!stored || stored.status !== 'pending' || !record?.live || record.locked)
    throw Error('This tag suggestion is no longer available for review.');
  const proposal = structuredClone(stored);
  resolveTagReview(proposal, record, input.name, input.include);
  await db.put('proposals', proposal);
  return proposal;
}

export async function applyOrganizationProposal(
  id: string,
  choices: { projectName: boolean; projectPurpose: boolean } = {
    projectName: false,
    projectPurpose: false,
  },
): Promise<OrganizationProposal> {
  const proposal = await db.get('proposals', id);
  if (!proposal || proposal.status !== 'pending')
    throw new Error('Organization proposal is no longer pending.');
  const projectValue = await db.get('projects', proposal.projectId);
  if (!projectValue || projectValue.revision !== proposal.projectRevision) {
    proposal.status = 'stale';
    await db.put('proposals', proposal);
    throw new Error('Project structure changed. Draft a fresh organization proposal.');
  }
  const currentMemberships = await db.all('memberships');
  const membershipsById = new Map(
    currentMemberships.map((membership) => [membership.recordId, membership]),
  );
  for (const assignment of [
    ...proposal.assignments,
    ...(proposal.unresolvedTagSuggestions || []),
  ]) {
    const record = await db.get('records', assignment.recordId);
    if (
      !record?.live ||
      record.locked ||
      record.url !== assignment.url ||
      record.navigationVersion !== assignment.navigationVersion ||
      membershipsById.get(record.id)?.source === 'owner'
    ) {
      proposal.status = 'stale';
      await db.put('proposals', proposal);
      throw new Error(
        'A proposed tab changed or received your correction. Draft organization again.',
      );
    }
  }
  const currentCategories = await db.all('categories');
  const categoriesByName = new Map(
    currentCategories
      .filter((category) => category.projectId === proposal.projectId)
      .map((category) => [category.name.trim().toLowerCase(), category]),
  );
  await db.database.transaction(
    'rw',
    'projects',
    'categories',
    'memberships',
    'proposals',
    'records',
    async () => {
      for (const suggested of proposal.categories) {
        const key = suggested.name.trim().toLowerCase();
        if (categoriesByName.has(key)) continue;
        const category: Category = {
          provenance: { author: 'ai', proposalId: proposal.id },
          id: uuid(),
          projectId: proposal.projectId,
          name: suggested.name,
          description: suggested.description,
          order: categoriesByName.size,
          updatedAt: now(),
          revision: 1,
        };
        await db.put('categories', category);
        categoriesByName.set(key, category);
      }
      for (const assignment of proposal.assignments) {
        const category = categoriesByName.get(assignment.categoryName.trim().toLowerCase());
        if (!category) throw new Error('A proposed category is no longer available.');
        if (assignment.suggestedTags?.length) {
          const record = await db.get('records', assignment.recordId);
          if (
            !record ||
            record.locked ||
            record.navigationVersion !== assignment.navigationVersion ||
            record.url !== assignment.url
          )
            throw new Error('A proposed tab changed before tag Apply.');
          record.tags = canonicalTags([...record.tags, ...assignment.suggestedTags]);
          await db.put('records', record);
        }
        await db.put('memberships', {
          recordId: assignment.recordId,
          projectId: proposal.projectId,
          categoryId: category.id,
          source: 'accepted-ai',
          provenance: { author: 'ai', proposalId: proposal.id },
          reason: assignment.reason,
          updatedAt: now(),
        });
      }
      if (proposal.projectSuggestion && choices.projectName)
        projectValue.name = proposal.projectSuggestion.name;
      for (const item of proposal.unresolvedTagSuggestions || []) {
        const record = await db.get('records', item.recordId);
        if (
          !record ||
          record.locked ||
          record.navigationVersion !== item.navigationVersion ||
          record.url !== item.url
        )
          throw new Error('A tagged tab changed before Apply.');
        await db.put('records', {
          ...record,
          tags: canonicalTags([...record.tags, ...item.suggestedTags]),
        });
      }
      if (proposal.projectSuggestion && choices.projectPurpose)
        projectValue.purpose = proposal.projectSuggestion.purpose;
      projectValue.updatedAt = now();
      projectValue.revision += 1;
      await db.put('projects', projectValue);
      proposal.status = 'applied';
      await db.put('proposals', proposal);
    },
  );
  return proposal;
}
export async function dismissOrganizationProposal(id: string): Promise<void> {
  const proposal = await db.get('proposals', id);
  if (!proposal || proposal.status !== 'pending')
    throw new Error('Organization proposal is no longer pending.');
  proposal.status = 'dismissed';
  await db.put('proposals', proposal);
}
export async function bindProject(windowId: number, projectId: string | null) {
  const window = await chrome.windows.get(windowId);
  if (window.incognito) throw new Error('Private windows are excluded.');
  if (projectId && !(await db.get('projects', projectId))) throw new Error('Project not found.');
  const b = await bindings();
  if (projectId) b.windows[windowId] = projectId;
  else {
    delete b.windows[windowId];
    // Clearing is intentional; restart inference must not restore the previous assignment.
    for (const r of await db.all('records'))
      if (r.windowId === windowId) {
        r.projectId = null;
        await db.put('records', r);
      }
  }
  await saveBindings(b);
  await reconcile();
  await db.database.transaction('rw', ['records', 'memberships'], async () => {
    for (const record of await db.all('records')) {
      if (!record.live || record.windowId !== windowId) continue;
      const membership = await db.get('memberships', record.id);
      if (membership && !['legacy', 'unassigned'].includes(membership.source)) continue;
      await db.put('memberships', {
        recordId: record.id,
        projectId,
        categoryId: null,
        source: projectId ? 'legacy' : 'unassigned',
        updatedAt: now(),
      } satisfies Membership);
    }
  });
}
export async function createWindow(projectId?: string) {
  const w = await chrome.windows.create({ focused: false });
  if (!w) throw new Error('Window could not be created');
  if (projectId) await bindProject(w.id!, projectId);
  return w;
}
export async function updateRecord(
  id: string,
  patch: Partial<Pick<TabRecord, 'locked' | 'note' | 'tags'>>,
) {
  const r = await db.get('records', id);
  if (!r) throw new Error('Tab not found.');
  if ('locked' in patch) r.locked = Boolean(patch.locked);
  if ('note' in patch) r.note = clip(patch.note, 4000);
  if ('tags' in patch)
    r.tags = Array.isArray(patch.tags) ? canonicalTags(patch.tags.map((t) => clip(t, 80))) : [];
  await db.put('records', r);
  return r;
}
export async function exportBackup(includeAssistant = true): Promise<Backup> {
  await reconcile();
  const snapshots = await db.all('snapshots');
  for (const session of await db.all('sessions'))
    if (!snapshots.some((saved) => saved.id === session.snapshot.id))
      snapshots.push(session.snapshot);
  return {
    format: 'tabloom',
    schema: SCHEMA_VERSION,
    exportedAt: now(),
    assistant: includeAssistant ? await exportAssistantState() : undefined,
    projects: await db.all('projects'),
    areas: await db.all('areas'),
    workItems: await db.all('workItems'),
    categories: await db.all('categories'),
    memberships: await db.all('memberships'),
    snapshots,
    records: (await db.all('records')).map(({ content: _content, ...r }) => r),
    operations: await db.all('operations'),
  };
}
export async function importBackup(input: unknown) {
  const value = importSnapshot(input);
  const assistant =
    value.assistant === undefined ? undefined : assistantPortableSchema.parse(value.assistant);
  for (const proposal of assistant?.proposals || [])
    validateCollectionDraft(
      proposal,
      new Set(
        proposal.scopeRecordIds || [
          ...proposal.assignments.map((item) => item.recordId),
          ...proposal.unresolvedRecordIds,
        ],
      ),
    );
  return db.database.transaction('rw', db.database.tables, async () => {
    let n = 0;
    const projectMap = new Map<string, string>();
    const areaMap = new Map<string, string>();
    const categoryMap = new Map<string, string>();
    const recordMap = new Map<string, string>();
    for (const p of (value.projects || []).slice(0, 500)) {
      const id = uuid();
      projectMap.set(p.id, id);
      await db.put('projects', {
        id,
        name: clip(p.name, 80) || 'Imported project',
        purpose: p.purpose || '',
        displayColor: p.displayColor,
        areaId: null,
        updatedAt: now(),
        revision: p.revision || 1,
        maintainReviewQueue: p.maintainReviewQueue || false,
      });
    }
    for (const area of value.areas || []) {
      const id = uuid();
      areaMap.set(area.id, id);
      await db.put('areas', { ...area, id, createdAt: now(), updatedAt: now() });
    }
    for (const p of value.projects || []) {
      const imported = await db.get('projects', mappedId(projectMap, p.id, 'project'));
      if (imported) {
        imported.areaId = p.areaId ? areaMap.get(p.areaId) || null : null;
        await db.put('projects', imported);
      }
    }
    for (const category of value.categories || []) {
      const projectId = projectMap.get(category.projectId);
      if (!projectId) throw new Error('Backup category references a missing project.');
      const id = uuid();
      categoryMap.set(category.id, id);
      await db.put('categories', {
        ...category,
        id,
        projectId,
        updatedAt: now(),
        revision: 1,
      });
    }
    for (const membership of value.memberships || []) {
      if (membership.projectId && !projectMap.has(membership.projectId))
        throw new Error('Backup tab assignment references a missing project.');
      if (!membership.projectId && membership.categoryId)
        throw new Error('Backup Inbox assignment cannot reference a category.');
      if (membership.categoryId && !categoryMap.has(membership.categoryId))
        throw new Error('Backup tab assignment references a missing category.');
      recordMap.set(membership.recordId, uuid());
    }
    for (const item of value.workItems || []) {
      await db.put('workItems', {
        ...item,
        id: uuid(),
        areaId: item.areaId ? areaMap.get(item.areaId) || null : null,
        projectId: item.projectId ? projectMap.get(item.projectId) || null : null,
        // Imported snapshots are not live records that can be focused. Keep the saved URL as a
        // reference instead of creating a dangling tab-identity link.
        recordId: null,
        source: 'owner',
        createdAt: now(),
        updatedAt: now(),
      });
    }
    for (const tab of value.snapshots.flatMap((snapshot) =>
      snapshot.windows.flatMap((window) => window.tabs),
    ))
      if (!recordMap.has(tab.recordId)) createImportedRecordId(recordMap, tab.recordId);
    for (const s of value.snapshots) {
      validateTabTree(
        s.windows.flatMap((window) =>
          window.tabs.map((tab) => ({ id: tab.recordId, parentRecordId: tab.parentRecordId })),
        ),
      );
      const imported = structuredClone(s);
      imported.id = uuid();
      imported.label = `Imported: ${clip(s.label, 180)}`;
      imported.createdAt = now();
      imported.windows = imported.windows.map((w) => ({
        ...w,
        id: -1,
        projectId: w.projectId ? projectMap.get(w.projectId) || null : null,
        tabs: (w.tabs || []).map((t) => ({
          ...t,
          recordId: recordMap.get(t.recordId) || createImportedRecordId(recordMap, t.recordId),
          parentRecordId: t.parentRecordId ? recordMap.get(t.parentRecordId) || null : null,
          openerRecordId: t.openerRecordId ? recordMap.get(t.openerRecordId) || null : null,
          title: clip(t.title, 1000),
          url: t.nativeNewTab ? t.url : pageURL(t.url)!,
          projectId: t.projectId ? projectMap.get(t.projectId) || null : null,
        })),
      }));
      await db.put('snapshots', imported);
      n++;
    }
    for (const membership of value.memberships || []) {
      await db.put('memberships', {
        ...membership,
        recordId: mappedId(recordMap, membership.recordId, 'tab'),
        projectId: membership.projectId
          ? mappedId(projectMap, membership.projectId, 'project')
          : null,
        categoryId: membership.categoryId
          ? mappedId(categoryMap, membership.categoryId, 'category')
          : null,
        updatedAt: now(),
      });
    }
    if (assistant)
      await importAssistantState(assistant, recordMap, projectMap, areaMap, categoryMap);
    return { imported: n, assistantImported: Boolean(assistant) };
  });
}
export const migration = createMigrationCoordinator({
  origin,
  state,
  snapshot,
  suspend: (id, expected) => suspendOne(id, { capture: false, expected }),
});
export async function registerReader() {
  const existing = await chrome.scripting.getRegisteredContentScripts();
  if (existing.some((s) => s.id === 'tabloom-reader'))
    await chrome.scripting.unregisterContentScripts({ ids: ['tabloom-reader'] });
  const grants = await chrome.permissions.getAll();
  const matches = grants.origins?.includes('<all_urls>')
    ? ['http://*/*', 'https://*/*']
    : grants.origins?.filter((x) => /^https?:/.test(x)) || [];
  if (matches.length)
    await chrome.scripting.registerContentScripts([
      {
        id: 'tabloom-reader',
        matches,
        js: ['reader.js'],
        runAt: 'document_idle',
        persistAcrossSessions: true,
      },
    ]);
}
export async function saveSettings(input: unknown) {
  const config = validateSettings(input);
  if (config.capturePreviews && !(await chrome.permissions.contains({ origins: ['<all_urls>'] })))
    throw new Error('Enable screenshot permission in Settings before saving preview capture.');
  await chrome.storage.local.set({ settings: config });
  await pruneSnapshots(config);
  await registerReader();
  return config;
}
export async function deleteLocalData(raw: unknown): Promise<void> {
  const input = z
    .object({
      kind: z.enum(['cache', 'analysis', 'history', 'organization', 'all']),
      confirmation: z.literal('DELETE'),
    })
    .parse(raw);
  if (await updateTicket()) throw new Error('Finish update recovery before deleting local data.');
  if (
    (await db.all('operations')).some((operation) => operation.status === 'running') ||
    (await db.all('jobs')).some((job) => ['queued', 'running'].includes(job.status)) ||
    (await db.all('assistantThreads')).some((thread) => thread.status === 'running') ||
    (await db.all('permissionReviews')).some(
      (review) => review.status === 'pending' && review.expiresAt > now(),
    )
  )
    throw new Error(
      'Stop active AI, inspection and browser operations before deleting local data.',
    );
  await db.database.transaction('rw', db.database.tables, async () => {
    if (
      (await db.all('operations')).some((operation) => operation.status === 'running') ||
      (await db.all('jobs')).some((job) => ['queued', 'running'].includes(job.status)) ||
      (await db.all('assistantThreads')).some((thread) => thread.status === 'running') ||
      (await db.all('permissionReviews')).some(
        (review) => review.status === 'pending' && review.expiresAt > now(),
      )
    )
      throw new Error('Active work started before deletion. Stop it and try again.');
    if (input.kind === 'all') {
      invalidatePreviewCapture();
      for (const table of db.database.tables) await table.clear();
      return;
    }
    if (input.kind === 'cache') {
      invalidatePreviewCapture();
      await db.database.previews.clear();
      await db.database.records.toCollection().modify({ content: null });
    }
    if (input.kind === 'analysis') {
      for (const table of [
        db.database.assistantThreads,
        db.database.assistantThreadSummaries,
        db.database.assistantAudit,
        db.database.inferenceReceipts,
        db.database.tagAnalyses,
        db.database.collectionAnalyses,
        db.database.actionAnalyses,
        db.database.permissionReviews,
      ])
        await table.clear();
    }
    if (input.kind === 'history') {
      await db.database.snapshots.clear();
      await db.database.operations.clear();
      await db.database.assistantChanges.clear();
    }
    if (input.kind === 'organization') {
      for (const table of [
        db.database.projects,
        db.database.categories,
        db.database.memberships,
        db.database.areas,
        db.database.proposals,
        db.database.collectionProposals,
        db.database.proposalRevisions,
        db.database.organizationJobs,
        db.database.collectionAnalyses,
        db.database.tagAnalyses,
      ])
        await table.clear();
      await db.database.records.toCollection().modify({ projectId: null, tags: [], note: '' });
      await db.database.workItems.toCollection().modify({ projectId: null, areaId: null });
    }
  });
  if (input.kind === 'all') {
    await chrome.storage.local.clear();
    await chrome.storage.session.clear();
  } else if (input.kind === 'organization') {
    const bind = await bindings();
    bind.windows = {};
    bind.pendingTabs = {};
    await saveBindings(bind);
  }
  if (input.kind === 'analysis')
    await chrome.storage.local.remove(['assistantPermissionPolicies', 'assistantApprovalRules']);
  await reconcile();
}
export async function startInspection(recordIds: string[], expected?: Plan['expected']) {
  const app = await state();
  const selected = [...new Set(recordIds)].filter((id) =>
    app.records.some((r) => r.id === id && !r.locked),
  );
  if (!selected.length) throw new Error('Choose at least one unprotected tab.');
  for (const id of selected) {
    if (!expected?.[id]) continue;
    const current = await currentRecord(id);
    if (
      current.r.url !== expected[id]!.url ||
      current.r.navigationVersion !== expected[id]!.navigationVersion
    )
      throw new Error('Inspection proposal is stale; a target page changed.');
  }
  const job: InspectionJob = {
    id: uuid(),
    type: 'inspection',
    createdAt: now(),
    status: 'queued',
    items: selected.map((id) => {
      const record = app.records.find((entry) => entry.id === id)!;
      return {
        id,
        status: 'pending',
        url: record.url,
        navigationVersion: record.navigationVersion,
      };
    }),
    cursor: 0,
  };
  await snapshot('Before content inspection');
  await db.put('jobs', job);
  return job;
}
export async function cancelJob(id: string) {
  const j = await db.get('jobs', id);
  if (j) {
    j.status = 'cancelled';
    await db.put('jobs', j);
  }
  return j;
}
// One short step per heartbeat. No long service-worker sleep or all-tabs wakeup.
export async function inspectionStep() {
  const jobs = (await db.all('jobs'))
    .filter((j) => ['queued', 'running'].includes(j.status))
    .sort((a, b) => a.createdAt - b.createdAt);
  const job = jobs[0];
  if (!job) return;
  job.status = 'running';
  const item = job.items[job.cursor];
  if (!item) {
    job.status = 'complete';
    await db.put('jobs', job);
    return;
  }
  try {
    const { r, tab } = await currentRecord(item.id);
    if (r.locked) throw new Error('Protected tab');
    if (!item.url && item.status === 'pending') {
      item.url = r.url;
      item.navigationVersion = r.navigationVersion;
    }
    if (!item.url || item.url !== r.url || item.navigationVersion !== r.navigationVersion) {
      item.resuspend = false;
      throw new Error(
        'Inspection target changed; the current page was retained without reading or resuspending it.',
      );
    }
    if (item.status === 'pending') {
      if (r.suspended) {
        if (tab.active) throw new Error('Active suspended tab; wake it manually first.');
        if ((await settings()).protectPinned && tab.pinned)
          throw new Error('Pinned suspended tab; wake it manually first.');
        if (!(await chrome.permissions.contains({ origins: [`${new URL(r.url).origin}/*`] })))
          throw new Error('Grant page access before waking this tab for inspection.');
        item.resuspend = true;
        item.initialActivations = r.activations || 0;
        item.startedAt = now();
        item.status = 'loading';
        // Save intent BEFORE wake so restart/cancellation recovery can return it to suspension.
        await db.put('jobs', job);
        await wakeOne(r.id);
      } else {
        await indexLoaded(r.id);
        item.status = 'done';
        job.cursor++;
      }
    } else if (item.status === 'loading') {
      if (tab.active || (r.activations || 0) !== item.initialActivations) {
        item.status = 'skipped';
        item.error = 'You started using this tab';
        item.resuspend = false;
        job.cursor++;
      } else if (tab.status === 'complete' || now() - (item.startedAt || now()) > 25000) {
        try {
          await indexLoaded(r.id);
          item.status = 'done';
        } catch (e) {
          item.status = 'error';
          item.error = errorMessage(e);
        }
        try {
          await suspendOne(r.id, { automatic: true });
        } catch (e) {
          item.error = [item.error, errorMessage(e)].filter(Boolean).join('; ');
        }
        item.resuspend = false;
        job.cursor++;
      }
    }
  } catch (e) {
    item.status = 'error';
    item.error = errorMessage(e);
    job.cursor++;
  }
  if (job.cursor >= job.items.length) job.status = 'complete';
  await db.put('jobs', job);
}
export async function recoverCancelledInspections() {
  for (const job of await db.all('jobs'))
    if (['cancelled', 'complete'].includes(job.status)) {
      for (const item of job.items.filter((i) => i.resuspend)) {
        try {
          const { r, tab } = await currentRecord(item.id);
          if (
            item.url === r.url &&
            item.navigationVersion === r.navigationVersion &&
            !tab.active &&
            (r.activations || 0) === item.initialActivations
          )
            await suspendOne(r.id, { automatic: true });
        } catch {}
        item.resuspend = false;
      }
      await db.put('jobs', job);
    }
}
export async function autoSuspend() {
  const config = await settings();
  if (!config.autoSuspend) return;
  if (config.pauseSuspensionOffline && globalThis.navigator?.onLine === false) return;
  const app = await state();
  const cutoff = now() - config.suspendMinutes * 60000;
  const inspectionIds = new Set(
    app.jobs
      .filter((j) => j.status === 'running' || j.status === 'queued')
      .flatMap((j) => j.items.map((i) => i.id)),
  );
  const candidates = app.records.filter(
    (r) =>
      !r.suspended && !r.locked && !r.active && r.lastAccessed < cutoff && !inspectionIds.has(r.id),
  );
  const eligible: TabRecord[] = [];
  const access = new Map<string, boolean>();
  for (const record of candidates) {
    if (
      (config.protectForms && record.content?.dirty) ||
      (config.protectAudio && record.content?.playing)
    )
      continue;
    const tab = await chrome.tabs.get(record.tabId!).catch(() => undefined);
    if (!tab || suspensionBlock(record, tab, config, true)) continue;
    const pattern = `${new URL(record.url).origin}/*`;
    if (!access.has(pattern))
      access.set(pattern, await chrome.permissions.contains({ origins: [pattern] }));
    if (!access.get(pattern)) continue;
    eligible.push(record);
    if (eligible.length === 5) break;
  }
  if (!eligible.length) return;
  const checkpoint = await snapshot('Before automatic suspension', true);
  const operation: Operation = {
    id: uuid(),
    createdAt: now(),
    snapshotId: checkpoint.id,
    summary: 'Automatic suspension',
    status: 'running',
    actions: eligible.slice(0, 5).map((record) => ({ type: 'suspend', recordIds: [record.id] })),
    results: [],
  };
  await db.put('operations', operation);
  for (const action of operation.actions) {
    try {
      operation.results.push({
        action,
        ok: true,
        outcomes: [await suspendOne(action.recordIds[0]!, { automatic: true })],
      });
    } catch (error) {
      operation.results.push({ action, ok: false, error: errorMessage(error) });
    }
    await db.put('operations', operation);
  }
  operation.status = operation.results.every((result) => result.ok) ? 'complete' : 'partial';
  operation.completedAt = now();
  await db.put('operations', operation);
}
export async function activation(tabId: number) {
  const b = await bindings();
  const r = await db.get('records', b.tabs[tabId]);
  if (r) {
    r.activations = (r.activations || 0) + 1;
    r.lastAccessed = now();
    await db.put('records', r);
    const config = await settings();
    const activeTab = config.wakeOnFocus ? await chrome.tabs.get(tabId) : undefined;
    const activeWindow = activeTab ? await chrome.windows.get(activeTab.windowId) : undefined;
    if (
      config.wakeOnFocus &&
      activeTab?.active &&
      activeWindow?.focused &&
      !activeWindow.incognito &&
      r.suspended &&
      !r.foreignSuspended &&
      !r.locked &&
      !(await db.all('jobs')).some(
        (job) =>
          ['queued', 'running'].includes(job.status) && job.items.some((item) => item.id === r.id),
      )
    )
      await applyPlan({
        summary: 'Wake selected suspended tab',
        actions: [{ type: 'wake', recordIds: [r.id] }],
        expected: { [r.id]: { url: r.url, navigationVersion: r.navigationVersion } },
      });
  }
}
export async function closed(tabId: number) {
  const b = await bindings();
  const r = await db.get('records', b.tabs[tabId]);
  if (r) {
    r.live = false;
    r.wasOpen = false;
    await db.put('records', r);
  }
  delete b.tabs[tabId];
  await saveBindings(b);
}
export async function wakePlaceholder(tabId: number) {
  const tab = await chrome.tabs.get(tabId);
  const info = suspendedInfo(tab.url, origin);
  if (!info?.owned) throw new Error('Not a TabFlow suspended page.');
  let r = await db.get('records', info.recordId);
  if (!r || r.tabId !== tabId) {
    await reconcile();
    r = await db.get('records', (await bindings()).tabs[tabId]);
  }
  if (!r) throw new Error('Page record is unavailable; use the original-address link.');
  await snapshot(`Before waking ${r.title}`, true);
  return wakeOne(r.id);
}
export async function trackFocus() {
  const previous = (await chrome.storage.session.get('focus')).focus as
    { id: string | null; at: number } | undefined;
  const idle = await chrome.idle.queryState(60);
  const w = await chrome.windows.getLastFocused({ populate: true });
  const tab = w.focused && !w.incognito && idle === 'active' ? w.tabs?.find((t) => t.active) : null;
  const b = await bindings();
  const id = tab ? b.tabs[tab.id!] : null;
  if (previous?.id && previous.id === id) {
    const r = await db.get('records', id);
    if (r) {
      r.focusedMs = (r.focusedMs || 0) + Math.min(60000, now() - previous.at);
      await db.put('records', r);
    }
  }
  await chrome.storage.session.set({ focus: { id, at: now() } });
}
export async function placeholderReady(tabId: number) {
  const config = await settings();
  if (config.discardPlaceholders) {
    const t = await chrome.tabs.get(tabId);
    if (!t.active && suspendedInfo(t.url, origin)?.owned)
      try {
        await chrome.tabs.discard(tabId);
      } catch {}
  }
}
export async function placeholderFavicon(tabId: number, data?: unknown) {
  const tab = await chrome.tabs.get(tabId);
  const info = suspendedInfo(tab.url, origin);
  if (!info?.owned) return null;
  const record = await db.get('records', info.recordId);
  if (!record || record.url !== info.url || (record.live && record.tabId !== tabId)) return null;
  if (data !== undefined && validFavicon(data) && !validFavicon(record.suspendedFavicon)) {
    record.suspendedFavicon = data;
    await db.put('records', record);
  }
  return validFavicon(record.suspendedFavicon) ? record.suspendedFavicon : null;
}
export async function repairPlaceholderFavicons() {
  const tabs = await chrome.tabs.query({});
  const records = new Map((await db.all('records')).map((record) => [record.id, record]));
  const stored: unknown = (await chrome.storage.session.get('faviconRepairs')).faviconRepairs;
  const attempted = new Map<string, { url: string; at: number; count: number }>(
    stored && typeof stored === 'object'
      ? Object.entries(stored).filter(
          (entry): entry is [string, { url: string; at: number; count: number }] => {
            const value: unknown = entry[1];
            return Boolean(
              value &&
              typeof value === 'object' &&
              'url' in value &&
              typeof value.url === 'string' &&
              'at' in value &&
              typeof value.at === 'number' &&
              Number.isFinite(value.at) &&
              'count' in value &&
              typeof value.count === 'number' &&
              Number.isSafeInteger(value.count) &&
              value.count > 0,
            );
          },
        )
      : [],
  );
  const live = new Set(tabs.map((tab) => String(tab.id)));
  for (const id of attempted.keys()) if (!live.has(id)) attempted.delete(id);
  let repaired = 0;
  for (const tab of tabs) {
    const info = suspendedInfo(tab.url, origin);
    const record = info?.recordId ? records.get(info.recordId) : undefined;
    const previous = attempted.get(String(tab.id));
    if (
      !info?.owned ||
      tab.id === undefined ||
      tab.active ||
      (tab.pendingUrl && tab.pendingUrl !== tab.url) ||
      (tab.status === 'loading' && !tab.discarded) ||
      record?.locked ||
      (previous &&
        previous.url === tab.url &&
        Date.now() - previous.at < (previous.count < 3 ? 30_000 : 300_000)) ||
      (tab.favIconUrl && !tab.favIconUrl.startsWith(`${origin}/icons/`))
    )
      continue;
    if (repaired++ >= 4) break;
    attempted.set(String(tab.id), {
      url: tab.url!,
      at: Date.now(),
      count: previous && previous.url === tab.url ? previous.count + 1 : 1,
    });
    const expectedUrl = tab.url;
    await chrome.storage.session.set({ faviconRepairs: Object.fromEntries(attempted) });
    const fresh = await chrome.tabs.get(tab.id);
    if (
      fresh.url !== expectedUrl ||
      (fresh.pendingUrl && fresh.pendingUrl !== expectedUrl) ||
      fresh.active ||
      (fresh.status === 'loading' && !fresh.discarded)
    )
      continue;
    try {
      await chrome.tabs.reload(tab.id);
    } catch {
      /* Presentation repair never changes the original address. */
    }
  }
}
export async function captureCurrentPreview() {
  const config = await settings();
  if (!config.capturePreviews) return;
  const window = await chrome.windows.getLastFocused({ populate: true });
  const tab =
    window.focused && !window.incognito ? window.tabs?.find((item) => item.active) : undefined;
  if (tab?.id === undefined) return;
  const record = await db.get('records', (await bindings()).tabs[tab.id]);
  if (record) await captureTabPreview(record, config);
}
export async function placeholderPreview(tabId: number) {
  const config = await settings();
  if (!config.capturePreviews) return null;
  const tab = await chrome.tabs.get(tabId);
  const info = suspendedInfo(tab.url, origin);
  if (!info?.owned) return null;
  const record = await db.get('records', info.recordId);
  if (
    !record?.live ||
    record.tabId !== tabId ||
    record.url !== info.url ||
    matchesSiteList(record.url, config.previewExcludedSites)
  )
    return null;
  return currentTabPreview(record);
}
export async function loaded(tabId: number) {
  const b = await bindings();
  const r = await db.get('records', b.tabs[tabId]);
  if (!r) return;
  const entry = (await chrome.storage.session.get(`scroll:${tabId}`))[`scroll:${tabId}`] as
    { url: string; pos: number } | undefined;
  if (entry && r.url === entry.url && (await settings()).restoreScroll) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (y) => scrollTo(0, y),
        args: [entry.pos],
      });
    } catch {}
    await chrome.storage.session.remove(`scroll:${tabId}`);
  }
  if ((await settings()).autoIndex && !r.suspended)
    try {
      await indexLoaded(r.id);
    } catch {}
}
export async function automaticBackup() {
  const config = await settings();
  if (!config.backupEnabled) return;
  if (!(await chrome.permissions.contains({ permissions: ['downloads'] }))) return;
  const last = Number((await chrome.storage.local.get('lastBackup')).lastBackup) || 0;
  if (now() - last < config.backupHours * 3600000) return;
  await snapshot('Scheduled backup checkpoint', true);
  const backup = await exportBackup(false);
  const data = JSON.stringify(backup);
  const downloadId = await chrome.downloads.download({
    url: `data:application/json;charset=utf-8,${encodeURIComponent(data)}`,
    filename: `TabFlow-backups/tabflow-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
    saveAs: false,
  });
  await chrome.storage.local.set({ lastBackup: now(), lastBackupDownloadId: downloadId });
}
