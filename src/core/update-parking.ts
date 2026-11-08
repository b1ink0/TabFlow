import { sessionReloadSchema, summarizeUpdate, now, uuid } from '../shared/model';
import { errorMessage, type UpdateSummary } from '../shared/types';
import type { z } from 'zod';
import * as db from './db';

type Ticket = z.infer<typeof sessionReloadSchema>;
const updateBatchSize = 8;
const origin = chrome.runtime.getURL('').replace(/\/$/, '');
export function parkingKey(value: string): string | null {
  try {
    const url = new URL(value);
    return ['chrome:', 'brave:', 'edge:'].includes(url.protocol) &&
      url.hostname === 'version' &&
      url.pathname === '/' &&
      !url.search &&
      /^#tabflow-update=[\w-]+&tab=[\w-]+$/.test(url.hash)
      ? url.hash
      : null;
  } catch {
    return null;
  }
}
const sameURL = (a: string | undefined, b: string) =>
  a === b || !!(a && parkingKey(a) && parkingKey(a) === parkingKey(b));
function ownPage(value: string) {
  try {
    const url = new URL(value);
    return (
      `${url.protocol}//${url.host}` === origin &&
      ['/suspended.html', '/dashboard.html', '/sidepanel.html'].includes(url.pathname)
    );
  } catch {
    return false;
  }
}
export async function updateTicket(): Promise<Ticket | null> {
  const parsed = sessionReloadSchema.safeParse(
    (await chrome.storage.local.get('sessionReload')).sessionReload,
  );
  if (!parsed.success) return null;
  // Only exact private markers and this extension's known entrypoints can be restored.
  if (parsed.data.parked.some((item) => !parkingKey(item.marker) || !ownPage(item.url)))
    return null;
  return parsed.data;
}
async function persist(ticket: Ticket) {
  await chrome.storage.local.set({ sessionReload: ticket });
  if (chrome.runtime.sendMessage)
    void chrome.runtime
      .sendMessage({ type: 'updateProgress', payload: summarizeUpdate(ticket) })
      .catch(() => {});
  if (ticket.operationId) {
    const operation = await db.get('operations', ticket.operationId);
    if (operation) {
      operation.results = ticket.parked
        .filter((item) => item.status !== 'pending')
        .map((item) => ({
          action: { type: 'suspend', recordIds: [] },
          ok: item.status !== 'failed',
          error: item.error,
          outcomes: [{ skipped: `Tab ${item.tabId}: ${item.status}` }],
        }));
      if (ticket.claimed) {
        operation.status = ticket.parked.every((item) =>
          ['restored', 'retained'].includes(item.status),
        )
          ? 'complete'
          : 'partial';
        operation.completedAt = now();
      }
      await db.put('operations', operation);
    }
  }
}
async function commit(tabId: number, destination: string, expected: string) {
  const before = await chrome.tabs.get(tabId);
  if (
    !sameURL(before.url, expected) ||
    (before.pendingUrl && !sameURL(before.pendingUrl, expected))
  )
    throw new Error('Tab navigated independently; its page was retained.');
  await chrome.tabs.update(tabId, { url: destination });
  for (let attempt = 0; attempt < 100; attempt++) {
    const tab = await chrome.tabs.get(tabId);
    if (sameURL(tab.url, destination) && (!tab.pendingUrl || sameURL(tab.pendingUrl, destination)))
      return;
    if (!sameURL(tab.url, expected) && !sameURL(tab.url, destination))
      throw new Error('Tab navigated independently; its page was retained.');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Browser did not commit the update placeholder. Reload was not allowed.');
}
export async function parkUpdate(snapshotId: string, recordIds: string[]) {
  if (await updateTicket()) throw new Error('Finish the previous update before reloading again.');
  await chrome.storage.local.remove('updateCompletion');
  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
  const id = uuid();
  const ticket: Ticket = {
    snapshotId,
    recordIds,
    requestedAt: now(),
    ready: false,
    claimed: false,
    phase: 'preparing',
    operationId: uuid(),
    parked: windows
      .filter((window) => !window.incognito)
      .flatMap((window) => window.tabs || [])
      .filter((tab) => tab.id !== undefined && ownPage(tab.url || ''))
      // Park app views last so the initiating dashboard remains usable during most of the work.
      .sort(
        (a, b) =>
          Number(!a.url?.includes('/suspended.html')) - Number(!b.url?.includes('/suspended.html')),
      )
      .map((tab) => ({
        tabId: tab.id!,
        url: tab.url!,
        marker: `chrome://version/#tabflow-update=${id}&tab=${uuid()}`,
        status: 'pending',
      })),
  };
  await db.put('operations', {
    id: ticket.operationId!,
    snapshotId,
    createdAt: now(),
    kind: 'extension-update',
    summary: `Protect ${ticket.parked.length} TabFlow pages during update`,
    status: 'running',
    actions: [],
    results: [],
  });
  await persist(ticket);
  try {
    for (let index = 0; index < ticket.parked.length; index += updateBatchSize) {
      const batch = ticket.parked.slice(index, index + updateBatchSize);
      const outcomes = await Promise.allSettled(
        batch.map(async (item) => {
          await commit(item.tabId, item.marker, item.url);
          item.status = 'parked';
        }),
      );
      await persist(ticket);
      const failed = outcomes.find((outcome) => outcome.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    }
    const remaining = (await chrome.windows.getAll({ populate: true }))
      .flatMap((window) => window.tabs || [])
      .filter((tab) => ownPage(tab.url || ''));
    if (remaining.length)
      throw new Error(
        'Another TabFlow page opened during preparation. Reload was cancelled; retry when the collection is stable.',
      );
    ticket.ready = true;
    ticket.phase = 'ready';
    ticket.requestedAt = now();
    await persist(ticket);
  } catch (error) {
    ticket.claimed = true;
    ticket.phase = 'restoring';
    const operation = await db.get('operations', ticket.operationId!);
    if (operation) {
      operation.summary = `Update cancelled: ${errorMessage(error)}`;
      await db.put('operations', operation);
    }
    await persist(ticket);
    // Roll back only committed markers, never a page the owner navigated elsewhere.
    await restoreUpdate(ticket);
    throw error;
  }
}
async function restoreUpdate(ticket: Ticket) {
  const markerTabs = new Map<string, chrome.tabs.Tab[]>();
  for (const tab of await chrome.tabs.query({})) {
    const key = !tab.incognito && tab.url && parkingKey(tab.url);
    if (key) markerTabs.set(key, [...(markerTabs.get(key) || []), tab]);
  }
  for (let index = 0; index < ticket.parked.length; index += updateBatchSize) {
    const batch = ticket.parked.slice(index, index + updateBatchSize);
    await Promise.all(
      batch.map(async (item) => {
        if (item.status === 'restored' || item.status === 'retained') return;
        try {
          const matches = markerTabs.get(parkingKey(item.marker)!) || [];
          if (matches.length > 1)
            throw new Error(
              'Multiple copies of an update marker exist. Review them before retrying.',
            );
          const tab = matches[0];
          if (!tab) {
            const original = await chrome.tabs.get(item.tabId).catch(() => null);
            if (original?.pendingUrl && sameURL(original.pendingUrl, item.marker))
              throw new Error(
                'Parking navigation is still pending. Finish update after it commits.',
              );
            item.status = 'retained';
          } else {
            await commit(tab.id!, item.url, item.marker);
            item.status = 'restored';
          }
          delete item.error;
        } catch (error) {
          item.status = 'failed';
          item.error = errorMessage(error);
        }
      }),
    );
    await persist(ticket);
  }
  if (ticket.parked.every((item) => item.status === 'restored' || item.status === 'retained')) {
    await chrome.storage.local.set({
      updateCompletion: {
        finishedAt: now(),
        total: ticket.parked.length,
        restored: ticket.parked.filter((item) => item.status === 'restored').length,
        retained: ticket.parked.filter((item) => item.status === 'retained').length,
      },
    });
    await chrome.storage.local.remove('sessionReload');
    if (chrome.runtime.sendMessage)
      void chrome.runtime.sendMessage({ type: 'updateProgress', payload: null }).catch(() => {});
  } else {
    ticket.phase = 'interrupted';
    await persist(ticket);
  }
}
export async function finishUpdate(automatic = false) {
  const ticket = await updateTicket();
  if (!ticket) return false;
  if (
    automatic &&
    (!ticket.ready ||
      ticket.claimed ||
      now() - ticket.requestedAt > 120_000 ||
      ticket.requestedAt > now())
  )
    return false;
  ticket.claimed = true;
  ticket.phase = 'restoring';
  await persist(ticket);
  await restoreUpdate(ticket);
  return true;
}
export async function pauseUpdate() {
  const ticket = await updateTicket();
  if (ticket) {
    ticket.claimed = true;
    ticket.phase = 'interrupted';
    await persist(ticket);
  }
}
export async function updateSummary(): Promise<UpdateSummary | null> {
  const ticket = await updateTicket();
  if (!ticket) return null;
  return summarizeUpdate(ticket);
}
