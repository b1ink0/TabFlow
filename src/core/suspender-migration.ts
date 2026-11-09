import * as db from './db';
import { now, uuid } from '../shared/model';
import { suspendedInfo } from '../shared/tabs/urls';
import {
  errorMessage,
  type AppState,
  type MigrationProgress,
  type MigrationReport,
  type Outcome,
  type Snapshot,
  type SuspenderMigration,
  type Operation,
} from '../shared/types';

export function migrationProgress(job: SuspenderMigration): MigrationProgress {
  return {
    id: job.id,
    operationId: job.operationId,
    status: job.status,
    total: job.items.length,
    processed: job.items.filter((item) => ['imported', 'failed', 'skipped'].includes(item.status))
      .length,
    imported: job.items.filter((item) => item.status === 'imported').length,
    failed: job.items.filter((item) => item.status === 'failed').length,
    skipped: job.items.filter((item) => item.status === 'skipped').length,
    currentTitle:
      job.items.find((item) => item.status === 'navigating')?.title ||
      job.items.find((item) => item.status === 'pending')?.title,
  };
}

export function createMigrationCoordinator(dependencies: {
  origin: string;
  state: () => Promise<AppState>;
  snapshot: (label: string) => Promise<Snapshot>;
  suspend: (
    id: string,
    expected: { wrapper: string; windowId: number; groupId: number },
  ) => Promise<Outcome>;
}) {
  async function report(): Promise<MigrationReport> {
    const app = await dependencies.state();
    const tabs = (await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] }))
      .filter((window) => !window.incognito)
      .flatMap((window) => window.tabs || []);
    return {
      recognized: app.records.filter((record) => record.live && record.foreignSuspended).length,
      protected: app.records.filter(
        (record) => record.live && record.foreignSuspended && record.locked,
      ).length,
      unsupported: tabs
        .filter((tab) => {
          try {
            const url = new URL(tab.url || '');
            return (
              url.protocol === 'chrome-extension:' &&
              `${url.protocol}//${url.host}` !== dependencies.origin &&
              /\/suspend(?:ed)?\.html$/.test(url.pathname) &&
              !suspendedInfo(tab.url, dependencies.origin)
            );
          } catch {
            return false;
          }
        })
        .map((tab) => ({
          tabId: tab.id!,
          title: tab.title || 'Unrecognized placeholder',
          wrapper: tab.url!,
        })),
    };
  }
  async function persist(job: SuspenderMigration, operation: Operation) {
    await db.database.transaction(
      'rw',
      db.database.migrations,
      db.database.operations,
      async () => {
        await db.put('migrations', job);
        await db.put('operations', operation);
      },
    );
    return migrationProgress(job);
  }
  async function start() {
    const running = await db.database.migrations.where('status').equals('running').first();
    if (running) throw new Error('A Suspender import is already running.');
    const app = await dependencies.state();
    const records = app.records
      .filter((record) => record.live && record.foreignSuspended)
      .sort((a, b) => a.windowId! - b.windowId! || a.index - b.index);
    if (!records.length)
      throw new Error(
        'No recognizable foreign placeholders remain. Check unsupported entries before removing the old extension.',
      );
    const checkpoint = await dependencies.snapshot('Before importing Suspender placeholders');
    const operation: Operation = {
      id: uuid(),
      snapshotId: checkpoint.id,
      createdAt: now(),
      summary: 'Import Suspender placeholders',
      status: 'running',
      actions: records.map((record) => ({ type: 'suspend', recordIds: [record.id] })),
      results: [],
    };
    const job: SuspenderMigration = {
      id: uuid(),
      operationId: operation.id,
      createdAt: now(),
      status: 'running',
      items: [],
    };
    for (const record of records) {
      const tab = await chrome.tabs.get(record.tabId!);
      job.items.push({
        recordId: record.id,
        tabId: record.tabId!,
        windowId: tab.windowId,
        groupId: tab.groupId,
        url: record.url,
        wrapper: tab.url!,
        title: record.title,
        status: record.locked ? 'skipped' : 'pending',
        ...(record.locked ? { error: 'Protected tab; remove protection before retrying.' } : {}),
      });
      if (record.locked)
        operation.results.push({
          action: { type: 'suspend', recordIds: [record.id] },
          ok: true,
          outcomes: [{ skipped: 'Protected tab' }],
        });
    }
    return persist(job, operation);
  }
  async function step(id: string) {
    const job = await db.get('migrations', id);
    if (!job) throw new Error('Import record is unavailable.');
    if (job.status !== 'running') return migrationProgress(job);
    const operation = await db.get('operations', job.operationId);
    if (!operation) throw new Error('Import recovery journal is unavailable.');
    const item =
      job.items.find((entry) => entry.status === 'navigating') ||
      job.items.find((entry) => entry.status === 'pending');
    if (item) {
      const action = { type: 'suspend' as const, recordIds: [item.recordId] };
      try {
        const record = await db.get('records', item.recordId);
        if (!record?.live || record.tabId !== item.tabId || record.url !== item.url)
          throw new Error('Tab identity changed; retained without importing.');
        const tab = await chrome.tabs.get(item.tabId);
        const info = suspendedInfo(tab.url, dependencies.origin);
        if (info?.owned && info.recordId === item.recordId && info.url === item.url) {
          item.status = 'imported';
        } else if (item.status === 'navigating') {
          if (tab.url !== item.wrapper)
            throw new Error(
              'Tab changed while import navigation was pending; retained without replaying.',
            );
          if (now() - (item.navigationStartedAt || 0) >= 30_000)
            throw new Error(
              'Browser did not commit the import navigation within 30 seconds. Review the current tab before retrying.',
            );
          return persist(job, operation);
        } else {
          if (
            tab.url !== item.wrapper ||
            tab.windowId !== item.windowId ||
            tab.groupId !== item.groupId ||
            !info ||
            info.owned ||
            info.url !== item.url
          )
            throw new Error('Placeholder navigated or moved; retained without importing.');
          item.status = 'navigating';
          item.navigationStartedAt = now();
          await persist(job, operation);
          const outcome = await dependencies.suspend(item.recordId, {
            wrapper: item.wrapper,
            windowId: item.windowId,
            groupId: item.groupId,
          });
          if (!outcome.done)
            throw new Error(outcome.skipped || 'Placeholder could not be imported.');
          const actual = await chrome.tabs.get(item.tabId);
          const imported = suspendedInfo(actual.url, dependencies.origin);
          if (!imported?.owned || imported.recordId !== item.recordId || imported.url !== item.url)
            return persist(job, operation);
          item.status = 'imported';
        }
        operation.results.push({ action, ok: true, outcomes: [{ done: true }] });
      } catch (error) {
        item.status = 'failed';
        item.error = errorMessage(error);
        operation.results.push({ action, ok: false, error: item.error });
      }
    }
    if (!job.items.some((entry) => entry.status === 'pending' || entry.status === 'navigating')) {
      job.status = job.items.every((entry) => entry.status === 'imported') ? 'complete' : 'partial';
      operation.status = job.status === 'complete' ? 'complete' : 'partial';
      operation.completedAt = now();
    }
    return persist(job, operation);
  }
  async function cancel(id: string) {
    const job = await db.get('migrations', id);
    if (!job || job.status !== 'running') throw new Error('No running import to cancel.');
    const operation = await db.get('operations', job.operationId);
    if (!operation) throw new Error('Import journal is unavailable.');
    job.status = 'cancelled';
    operation.status = 'partial';
    operation.completedAt = now();
    return persist(job, operation);
  }
  async function retry(id: string) {
    const job = await db.get('migrations', id);
    if (!job || job.status === 'running' || job.status === 'complete')
      throw new Error('This import cannot be retried.');
    if (await db.database.migrations.where('status').equals('running').first())
      throw new Error('Another import is running.');
    const operation = await db.get('operations', job.operationId);
    if (!operation || operation.status === 'undone')
      throw new Error('An undone or missing import cannot be retried. Start a new import.');
    await dependencies.state();
    await dependencies.snapshot('Before retrying Suspender import');
    for (const item of job.items)
      if (item.status !== 'imported') {
        item.status = 'pending';
        delete item.error;
        delete item.navigationStartedAt;
      }
    job.status = 'running';
    operation.status = 'running';
    delete operation.completedAt;
    return persist(job, operation);
  }
  async function recover() {
    for (const job of await db.database.migrations.where('status').equals('running').toArray()) {
      const operation = await db.get('operations', job.operationId);
      if (!operation) {
        job.status = 'interrupted';
        await db.put('migrations', job);
        continue;
      }
      for (const item of job.items.filter(
        (entry) => entry.status === 'pending' || entry.status === 'navigating',
      )) {
        const record = await db.get('records', item.recordId);
        const tab =
          record?.live && record.tabId !== undefined
            ? await chrome.tabs.get(record.tabId).catch(() => undefined)
            : undefined;
        const info = suspendedInfo(tab?.url, dependencies.origin);
        if (
          info?.owned &&
          info.recordId === item.recordId &&
          info.url === item.url &&
          record?.url === item.url
        ) {
          item.status = 'imported';
          operation.results.push({
            action: { type: 'suspend', recordIds: [item.recordId] },
            ok: true,
            outcomes: [{ done: true }],
          });
        }
      }
      // Repair committed receipts, but never navigate or replay unfinished browser changes on startup.
      job.status = job.items.every((item) => item.status === 'imported')
        ? 'complete'
        : 'interrupted';
      operation.status = job.status === 'complete' ? 'complete' : 'interrupted';
      if (job.status === 'complete') operation.completedAt = now();
      await persist(job, operation);
    }
  }
  return { report, start, step, cancel, retry, recover };
}
