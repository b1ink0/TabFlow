import {
  permissionPolicy,
  setPermissionPolicy,
  preparePermissionReview,
  resolvePermissionReview,
  interruptPermissionReviews,
  reviewSummary,
} from './permission-review';
import * as engine from './engine';
import { BackupTransfers } from './backup-transfer';
import { nativeContextMenus } from './context-menus';
import { listProposalRevisions, restoreProposalRevision } from './proposal-history';
import {
  executeAssistantAction,
  executeWorkspaceEdit,
  denyAssistantAction,
  undoAssistantChange,
  redoAssistantChange,
  revokeApprovals,
  interruptAssistantActions,
} from './assistant-actions';
import * as db from './db';
import type { RpcRequest } from '../shared/rpc';
import { errorMessage } from '../shared/types';
import { invalidatePreviewCapture } from './tab-previews';
import { finishUpdate, pauseUpdate, updateTicket } from './update-parking';
export function startBackground() {
  const backupTransfers = new BackupTransfers();
  let timer: ReturnType<typeof setTimeout>;
  const pendingOrganizationTabIds = new Map<number, number>();
  let organizationEventSequence = 0;
  let pendingOrganizationWrite: Promise<void> = Promise.resolve();
  const report = (e: unknown) => {
    console.error('[TabFlow]', e);
    void chrome.storage.local.set({ lastError: { message: errorMessage(e), at: Date.now() } });
  };
  let browserJobsScheduled = false;
  const runBrowserJobs = () => {
    if (browserJobsScheduled) return;
    browserJobsScheduled = true;
    setTimeout(() => {
      browserJobsScheduled = false;
      void engine
        .serialized(async () => {
          await engine.wakeOperationStep();
          await engine.inspectionStep();
          await engine.recoverCancelledInspections();
          const operations = await db.database.operations
            .where('status')
            .equals('running')
            .filter((entry) => Boolean(entry.queued))
            .count();
          const jobs = await db.database.jobs.where('status').anyOf('queued', 'running').count();
          if (operations > 0 || jobs > 0) runBrowserJobs();
        })
        .catch(report);
    }, 500);
  };
  const broadcastMigration = (progress: import('../shared/types').MigrationProgress) => {
    void chrome.runtime
      .sendMessage({ type: 'migrationProgress', payload: progress })
      .catch(() => {});
  };
  const runMigration = (id: string) => {
    setTimeout(() => {
      void engine
        .serialized(() => engine.migration.step(id))
        .then((progress) => {
          broadcastMigration(progress);
          if (progress.status === 'running') runMigration(id);
        })
        .catch(report);
    }, 100);
  };
  const persistPendingOrganizationTabs = () => {
    const ids = [...pendingOrganizationTabIds.keys()];
    pendingOrganizationWrite = pendingOrganizationWrite
      .catch(() => {})
      .then(() => chrome.storage.session.set({ pendingOrganizationTabIds: ids }));
    return pendingOrganizationWrite;
  };
  const flushPendingOrganizationTabs = async () => {
    await pendingOrganizationWrite;
    await engine.reconcile();
    const pending = [...pendingOrganizationTabIds.entries()];
    for (const [id, sequence] of pending) {
      await engine.queueOrganizationTab(id);
      if (pendingOrganizationTabIds.get(id) === sequence) {
        pendingOrganizationTabIds.delete(id);
        await persistPendingOrganizationTabs();
      }
    }
    await engine.repairPlaceholderFavicons();
  };
  const schedule = (organizationTabId?: number) => {
    if (organizationTabId !== undefined) {
      pendingOrganizationTabIds.set(organizationTabId, ++organizationEventSequence);
      void persistPendingOrganizationTabs().catch(report);
    }
    clearTimeout(timer);
    timer = setTimeout(() => {
      void engine.serialized(flushPendingOrganizationTabs).catch((error: unknown) => {
        report(error);
        clearTimeout(timer);
        timer = setTimeout(() => schedule(), 5000);
      });
    }, 400);
  };
  const openDashboard = async (view?: string) => {
    const url = chrome.runtime.getURL('dashboard.html');
    const destination = view ? `${url}#${encodeURIComponent(view)}` : url;
    const tabs = await chrome.tabs.query({ url: `${url}*` });
    if (tabs.length) {
      await chrome.windows.update(tabs[0]!.windowId, { focused: true });
      await chrome.tabs.update(tabs[0]!.id!, {
        active: true,
        ...(view ? { url: destination } : {}),
      });
      return tabs[0]!.id!;
    }
    const created = await chrome.tabs.create({ url: destination });
    if (created.id === undefined) throw new Error('Browser did not return the workspace tab.');
    return created.id;
  };
  const refreshNativeMenus = nativeContextMenus(openDashboard, report);
  const init = async (extensionUpdate = false) => {
    await interruptAssistantActions();
    await interruptPermissionReviews();
    await engine.preserveSession();
    if (extensionUpdate) await engine.finishSessionReload(true);
    else {
      const pendingUpdate = await updateTicket();
      if (pendingUpdate && (!pendingUpdate.ready || pendingUpdate.claimed)) await pauseUpdate();
    }
    const savedPending = (await chrome.storage.session.get('pendingOrganizationTabIds'))
      .pendingOrganizationTabIds;
    if (Array.isArray(savedPending))
      for (const id of savedPending)
        if (typeof id === 'number' && Number.isSafeInteger(id))
          pendingOrganizationTabIds.set(id, ++organizationEventSequence);
    const previousOrganizationState = new Map<number, string>();
    for (const record of await db.all('records'))
      if (record.live && record.tabId !== undefined)
        previousOrganizationState.set(record.tabId, engine.organizationFingerprint(record));
    for (const id of await engine.recoverOrganizationEvents(previousOrganizationState))
      pendingOrganizationTabIds.set(id, ++organizationEventSequence);
    await persistPendingOrganizationTabs();
    await flushPendingOrganizationTabs();
    for (const op of await db.all('operations'))
      if (op.status === 'running') {
        op.status = 'interrupted';
        await db.put('operations', op);
      }
    await engine.migration.recover();
    await engine.registerReader();
    await refreshNativeMenus();
    await chrome.alarms.create('heartbeat', { periodInMinutes: 0.5 });
  };
  chrome.runtime.onInstalled.addListener((details) => {
    void (async () => {
      if (details.reason === 'update' && (await updateTicket()))
        await openDashboard('update').catch(report);
      await engine.serialized(() => init(details.reason === 'update'));
    })().catch(report);
  });
  chrome.runtime.onStartup.addListener(() => {
    void engine
      .serialized(async () => {
        await pauseUpdate();
        await init();
      })
      .catch(report);
  });
  chrome.action.onClicked.addListener((tab) => {
    if (chrome.sidePanel?.open && tab.windowId !== undefined)
      void chrome.sidePanel.open({ windowId: tab.windowId }).catch(report);
    else void openDashboard().catch(report);
  });
  chrome.commands.onCommand.addListener(() => {
    void openDashboard().catch(report);
  });
  chrome.tabs.onCreated.addListener((tab) => schedule(tab.id));
  chrome.tabs.onReplaced.addListener((addedTabId) => schedule(addedTabId));
  chrome.tabs.onMoved.addListener(schedule);
  chrome.tabs.onAttached.addListener(schedule);
  chrome.tabs.onDetached.addListener(schedule);
  chrome.tabs.onRemoved.addListener((id, info) => {
    void engine
      .serialized(async () => {
        if (info.isWindowClosing) await engine.preserveSession();
        await engine.closed(id);
      })
      .catch(report);
    schedule();
  });
  chrome.tabs.onActivated.addListener((info) => {
    invalidatePreviewCapture();
    void engine
      .serialized(async () => {
        await engine.activation(info.tabId);
        await engine.trackFocus();
        await engine.captureCurrentPreview();
      })
      .catch(report);
  });
  chrome.tabs.onUpdated.addListener((id, change) => {
    if (change.url) invalidatePreviewCapture();
    if (
      change.url ||
      change.title ||
      change.status === 'complete' ||
      Object.hasOwn(change, 'groupId')
    )
      schedule(id);
    else if (
      change.pinned !== undefined ||
      change.mutedInfo !== undefined ||
      change.audible !== undefined ||
      change.discarded !== undefined ||
      change.favIconUrl !== undefined ||
      change.splitViewId !== undefined
    )
      schedule();
    if (change.status === 'complete')
      void engine
        .serialized(async () => {
          await engine.reconcile();
          await engine.loaded(id);
          await engine.captureCurrentPreview();
        })
        .catch(report);
  });
  chrome.tabGroups.onUpdated.addListener((group) => {
    void chrome.tabs
      .query({ groupId: group.id })
      .then((tabs) => {
        for (const tab of tabs) schedule(tab.id);
      })
      .catch(report);
  });
  chrome.tabGroups.onRemoved.addListener(() => schedule());
  chrome.tabGroups.onMoved.addListener(() => schedule());
  chrome.tabGroups.onCreated.addListener(() => schedule());
  chrome.windows.onRemoved.addListener(schedule);
  chrome.windows.onFocusChanged.addListener(() => {
    invalidatePreviewCapture();
    void engine.serialized(() => engine.trackFocus()).catch(report);
  });
  chrome.permissions.onAdded.addListener(() => {
    void engine.serialized(() => engine.registerReader()).catch(report);
  });
  chrome.permissions.onRemoved.addListener(() => {
    void engine.serialized(() => engine.registerReader()).catch(report);
  });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== 'heartbeat') return;
    void engine
      .serialized(async () => {
        await engine.reconcile();
        await engine.repairPlaceholderFavicons();
        await engine.trackFocus();
        await engine.captureCurrentPreview();
        await engine.inspectionStep();
        await engine.recoverCancelledInspections();
        await engine.autoSuspend();
        runBrowserJobs();
        await engine.automaticBackup();
        const saved = await chrome.storage.local.get('lastCheckpoint');
        const last = Number(saved.lastCheckpoint) || 0;
        if (Date.now() - last > 600000) {
          await engine.snapshot('Automatic checkpoint', true);
          await chrome.storage.local.set({ lastCheckpoint: Date.now() });
        }
      })
      .catch(report);
  });
  async function route(
    request: RpcRequest,
    sender: chrome.runtime.MessageSender,
  ): Promise<unknown> {
    const p = request.payload;
    switch (request.type) {
      case 'permissionPolicy':
        return permissionPolicy(request.payload.threadId);
      case 'setPermissionPolicy':
        return setPermissionPolicy(request.payload);
      case 'preparePermissionReview':
        return preparePermissionReview(request.payload);
      case 'listPermissionReviews':
        return (
          await db.database.permissionReviews
            .where('[messageId+createdAt]')
            .between(
              [request.payload.messageId, 0],
              [request.payload.messageId, Number.MAX_SAFE_INTEGER],
            )
            .reverse()
            .limit(100)
            .toArray()
        ).map(reviewSummary);
      case 'permissionReviewDetails':
        return db.get('permissionReviews', request.payload.id);

      case 'executeAssistantAction': {
        const trace = await executeAssistantAction(request.payload);
        runBrowserJobs();
        return trace;
      }
      case 'redoAssistantChange': {
        const trace = await redoAssistantChange(request.payload.id);
        runBrowserJobs();
        return trace;
      }
      case 'undoAssistantChange':
        return undoAssistantChange(request.payload.id);
      case 'denyAssistantAction':
        return denyAssistantAction(request.payload);
      case 'assistantChangeDetails':
        return db.get('assistantChanges', request.payload.id);
      case 'listAssistantChanges': {
        const { database } = db;
        const query = request.payload.messageId
          ? database.assistantChanges.where('messageId').equals(request.payload.messageId)
          : database.assistantChanges.orderBy('createdAt').reverse();
        return (await query.offset(Math.max(0, request.payload.offset)).limit(100).toArray()).map(
          ({ deltas, ...trace }) => ({ ...trace, deltas: [], deltaCount: deltas.length }),
        );
      }
      case 'revokeAssistantApprovals':
        return revokeApprovals(request.payload.threadId);
      case 'openDashboard':
        return openDashboard(request.payload.view);
      case 'openBrowserAppearance':
        await chrome.tabs.create({ url: 'chrome://settings/appearance' });
        return;
      case 'state':
        backupTransfers.active();
        return engine.state();
      case 'saveSession':
        return engine.saveSession(request.payload?.replaceMissing);
      case 'resumeSession':
        return engine.resumeSession();
      case 'reloadSafely':
        await engine.prepareSessionReload();
        setTimeout(() => chrome.runtime.reload(), 250);
        return;
      case 'finishUpdate':
        await finishUpdate();
        return;
      case 'operationDetails':
        return db.get('operations', request.payload.id);
      case 'settings':
        return engine.saveSettings(request.payload);
      case 'snapshot':
        return engine.snapshot(request.payload.label);
      case 'apply': {
        const operation = await engine.applyPlan(request.payload);
        if (operation.queued) runBrowserJobs();
        return operation;
      }
      case 'controlWakeOperation': {
        const operation = await engine.controlWakeOperation(
          request.payload.id,
          request.payload.resume,
        );
        if (request.payload.resume) runBrowserJobs();
        return operation;
      }
      case 'restore':
        return engine.restoreSnapshot(request.payload.id, {
          newWindows: request.payload.newWindows,
        });
      case 'tabCommand':
        return engine.tabCommand(request.payload);
      case 'redo': {
        const operation = await engine.redoOperation(request.payload.id);
        if (operation.queued) runBrowserJobs();
        return operation;
      }
      case 'undo':
        return engine.undoOperation(request.payload.id);
      case 'project':
        return engine.project(request.payload);
      case 'area':
        return engine.saveArea(request.payload);
      case 'workItem':
        return engine.saveWorkItem(request.payload);
      case 'category':
        return engine.saveCategory(request.payload);
      case 'assignMembership':
        return engine.assignMembership(request.payload);
      case 'executeWorkspaceEdit':
        return executeWorkspaceEdit(request.payload);
      case 'applyWorkspaceEdits':
        return engine.applyWorkspaceEdits(request.payload);
      case 'proposeOrganization':
        return engine.saveOrganizationProposal(request.payload);
      case 'proposeCollection':
        return engine.saveCollectionProposal(request.payload);
      case 'listTagAnalyses':
        return engine.listTagAnalyses(request.payload.analysisId);
      case 'saveTagAnalysis':
        return engine.saveTagAnalysis(request.payload);
      case 'reviewOrganizationTag':
        return engine.reviewOrganizationTag(request.payload);
      case 'getCollectionAnalysis':
        return engine.getCollectionAnalysis(request.payload.id);
      case 'getActionAnalysis':
        return engine.getActionAnalysis(request.payload.id);
      case 'listActionAnalyses':
        return engine.listActionAnalyses();
      case 'saveActionAnalysis':
        return engine.saveActionAnalysis(request.payload);
      case 'repairActionAnalysis':
        return engine.repairActionAnalysis(request.payload.id);
      case 'rebaseActionAnalysis':
        return engine.rebaseActionAnalysis(request.payload.id);
      case 'saveCollectionAnalysis':
        return engine.saveCollectionAnalysis(request.payload);
      case 'saveInferenceReceipt':
        return engine.saveInferenceReceipt(request.payload);
      case 'repairCollectionAnalysis':
        return engine.repairCollectionAnalysis(request.payload.id, request.payload.stage);
      case 'repairCollectionProposal':
        return engine.repairCollectionProposal(request.payload.id, request.payload.stage);
      case 'rebaseCollectionAnalysis':
        return engine.rebaseCollectionAnalysis(request.payload.id);
      case 'clearCollectionAnalysis':
        return engine.clearCollectionAnalysis(request.payload.id);
      case 'updateCollectionDraft':
        return engine.updateCollectionProposal(request.payload.id, request.payload.draft, false, {
          expectedFingerprint: request.payload.expectedFingerprint,
        });
      case 'getCollectionProposal':
        return db.get('collectionProposals', request.payload.id);
      case 'listProposalRevisions':
        return listProposalRevisions(request.payload.proposalId, request.payload.offset);
      case 'restoreProposalRevision':
        return restoreProposalRevision(request.payload);
      case 'rebaseCollectionDraft':
        return engine.rebaseCollectionProposal(
          request.payload.id,
          request.payload.draft,
          request.payload.expectedFingerprint,
        );
      case 'extendCollectionDraft':
        return engine.updateCollectionProposal(request.payload.id, request.payload.draft, true, {
          expectedFingerprint: request.payload.expectedFingerprint,
        });
      case 'mergeCollectionProposals':
        return engine.mergeCollectionProposals(request.payload);
      case 'updateCollectionTags':
        return engine.updateCollectionTags(request.payload);
      case 'applyCollection':
        return engine.applyCollectionProposal(request.payload.id);
      case 'organizeCollection':
        return engine.organizeCollection(request.payload.id);
      case 'undoCollection':
        return engine.undoCollection(request.payload.id);
      case 'dismissCollection':
        return engine.dismissCollectionProposal(request.payload.id);
      case 'applyOrganization':
        return engine.applyOrganizationProposal(request.payload.id, {
          projectName: request.payload.projectName,
          projectPurpose: request.payload.projectPurpose,
        });
      case 'dismissOrganization':
        return engine.dismissOrganizationProposal(request.payload.id);
      case 'queueOrganizationTab':
        await engine.reconcile();
        return engine.queueOrganizationTab(request.payload.tabId);
      case 'claimOrganizationJob':
        return engine.claimOrganizationJob(request.payload.runnerId);
      case 'claimCollectionJobs':
        return engine.claimCollectionJobs(request.payload.runnerId);
      case 'renewCollectionJobs':
        return engine.renewCollectionJobs(request.payload.ids, request.payload.runnerId);
      case 'finishOrganizationJob':
        return engine.finishOrganizationJob(request.payload);
      case 'retryOrganizationJob':
        return engine.retryOrganizationJob(request.payload.id);
      case 'bindProject':
        return engine.bindProject(request.payload.windowId, request.payload.projectId);
      case 'createWindow':
        return engine.createWindow(request.payload.projectId);
      case 'record':
        return engine.updateRecord(request.payload.id, request.payload.patch);
      case 'export':
        return engine.exportBackup();
      case 'deleteLocalData':
        if (backupTransfers.active())
          throw new Error('Finish or cancel the backup transfer before deleting data.');
        await engine.deleteLocalData(request.payload);
        void chrome.runtime
          .sendMessage({ type: 'localDataChanged', payload: { kind: request.payload.kind } })
          .catch(() => undefined);
        return;
      case 'backupExportStart':
        return backupTransfers.export(await engine.exportBackup());
      case 'backupExportRead':
        return backupTransfers.read(request.payload);
      case 'backupTransferRelease':
        return backupTransfers.release(request.payload.id);
      case 'backupImportStart':
        return backupTransfers.beginImport(request.payload);
      case 'backupImportWrite':
        return backupTransfers.write(request.payload);
      case 'backupImportCommit':
        return engine.importBackup(backupTransfers.finishImport(request.payload.id));
      case 'import':
        return engine.importBackup(p);
      case 'migrate': {
        const progress = await engine.migration.start();
        runMigration(progress.id);
        return progress;
      }
      case 'migrationReport':
        return engine.migration.report();
      case 'migrationDetails':
        return db.get('migrations', request.payload.id);
      case 'cancelMigration': {
        const progress = await engine.migration.cancel(request.payload.id);
        broadcastMigration(progress);
        return progress;
      }
      case 'retryMigration': {
        const progress = await engine.migration.retry(request.payload.id);
        runMigration(progress.id);
        return progress;
      }
      case 'clearPreviews':
        await db.database.previews.clear();
        return;
      case 'inspect': {
        const job = await engine.startInspection(request.payload.ids, request.payload.expected);
        runBrowserJobs();
        return job;
      }
      case 'cancel':
        return engine.cancelJob(request.payload.id);
      case 'tick':
        await engine.inspectionStep();
        return engine.recoverCancelledInspections();
      case 'focus': {
        const r = await db.get('records', request.payload.id);
        if (!r?.live || r.windowId === undefined || r.tabId === undefined)
          throw new Error('Tab is closed.');
        await chrome.windows.update(r.windowId, { focused: true });
        await chrome.tabs.update(r.tabId, { active: true });
        return;
      }
      case 'groupUpdate':
        return chrome.tabGroups.update(request.payload.id, {
          collapsed: request.payload.collapsed,
        });
      case 'placeholder':
        if (sender.tab?.id !== undefined) return engine.placeholderReady(sender.tab.id);
        return;
      case 'placeholderFavicon':
        return sender.tab?.id === undefined
          ? null
          : engine.placeholderFavicon(sender.tab.id, request.payload?.data);
      case 'placeholderPreview':
        if (sender.tab?.id === undefined) return null;
        return engine.placeholderPreview(sender.tab.id);
      case 'wakePlaceholder':
        if (sender.tab?.id === undefined) throw new Error('No sender tab.');
        return engine.wakePlaceholder(sender.tab.id);
      default:
        throw new Error('Unknown request type.');
    }
  }
  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL('')))
      return false;
    if (!message || typeof message !== 'object' || !('type' in message)) {
      sendResponse({ ok: false, error: 'Invalid request' });
      return false;
    }
    if (
      message.type === 'updateProgress' ||
      message.type === 'localDataChanged' ||
      message.type === 'workspaceIntent'
    )
      return false;
    const request = message as RpcRequest;
    if (
      sender.url.includes('/suspended.html') &&
      !['placeholder', 'wakePlaceholder', 'placeholderPreview', 'placeholderFavicon'].includes(
        request.type,
      )
    ) {
      sendResponse({ ok: false, error: 'Unavailable from a suspended page' });
      return false;
    }
    const response =
      request.type === 'resolvePermissionReview'
        ? resolvePermissionReview(request.payload.id)
        : engine.serialized(() => route(request, sender));
    void response.then(
      (value) => {
        if (
          [
            'project',
            'category',
            'executeWorkspaceEdit',
            'executeAssistantAction',
            'undoAssistantChange',
            'redoAssistantChange',
            'deleteLocalData',
            'import',
            'backupImportCommit',
          ].includes(request.type)
        )
          void refreshNativeMenus().catch(report);
        sendResponse({ ok: true, value });
      },
      (e) => sendResponse({ ok: false, error: errorMessage(e) }),
    );
    return true;
  });
  // Every worker boot reconciles identities, marks interrupted operations, and recreates alarms.
  void engine.serialized(init).catch(report);
}
