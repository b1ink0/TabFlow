import * as db from './db';
import type { Snapshot, TabRecord, SessionSummary } from '../shared/types';
import { uuid, now } from '../shared/model';

export async function forgetSessionRecord(id: string) {
  for (const saved of await db.all('sessions')) {
    const windows = saved.snapshot.windows
      .map((window) => ({ ...window, tabs: window.tabs.filter((tab) => tab.recordId !== id) }))
      .filter((window) => window.tabs.length);
    if (JSON.stringify(windows) === JSON.stringify(saved.snapshot.windows)) continue;
    await db.put('sessions', {
      ...saved,
      snapshot: { ...saved.snapshot, id: uuid(), createdAt: now(), windows },
    });
  }
}

// Separate from checkpoint retention: startup/empty windows must not erase the last collection.
export async function sessionForResume() {
  const recovery = await db.get('sessions', 'recovery');
  if (recovery && missingSessionIds(recovery.snapshot, await db.all('records')).length)
    return recovery;
  return (await db.get('sessions', 'current')) || recovery;
}
export function missingSessionIds(snapshot: Snapshot, records: TabRecord[]) {
  const live = new Set(records.filter((record) => record.live).map((record) => record.id));
  return snapshot.windows
    .flatMap((window) => window.tabs.map((tab) => tab.recordId))
    .filter((id) => !live.has(id));
}
export async function retainSessionForResume() {
  const current = await db.get('sessions', 'current');
  if (!current) return;
  const recovery = await db.get('sessions', 'recovery');
  if (recovery && missingSessionIds(recovery.snapshot, await db.all('records')).length) return;
  await db.put('sessions', { id: 'recovery', snapshot: current.snapshot });
}
export async function observeSession(snapshot: Snapshot) {
  if (!snapshot.windows.length) return;
  const current = await db.get('sessions', 'current');
  const windows = new Set(snapshot.windows.map((window) => window.id));
  if (current?.snapshot.windows.some((window) => !windows.has(window.id)))
    await retainSessionForResume();
  if (current && JSON.stringify(current.snapshot.windows) === JSON.stringify(snapshot.windows))
    return;
  const recovery = await db.get('sessions', 'recovery');
  if (recovery) {
    const liveIds = new Set(
      snapshot.windows.flatMap((window) => window.tabs.map((tab) => tab.recordId)),
    );
    const windows = structuredClone(snapshot.windows);
    let virtualWindowId =
      Math.max(
        0,
        ...windows.map((window) => window.id),
        ...recovery.snapshot.windows.map((window) => window.id),
      ) + 1;
    for (const previous of recovery.snapshot.windows) {
      const missing = previous.tabs.filter((tab) => !liveIds.has(tab.recordId));
      if (!missing.length) continue;
      const target = windows.find((window) => window.id === previous.id);
      if (
        target &&
        previous.tabs.some((tab) => target.tabs.some((live) => live.recordId === tab.recordId))
      ) {
        target.tabs.push(...missing);
        target.tabs.sort((a, b) => a.index - b.index);
        for (const group of previous.groups)
          if (!target.groups.some((live) => live.id === group.id)) target.groups.push(group);
      } else {
        windows.push({ ...previous, id: target ? virtualWindowId++ : previous.id, tabs: missing });
      }
    }
    if (
      windows.some((window) => window.tabs.some((tab) => !liveIds.has(tab.recordId))) &&
      JSON.stringify(windows) !== JSON.stringify(recovery.snapshot.windows)
    )
      await db.put('sessions', {
        id: 'recovery',
        snapshot: { ...snapshot, label: 'Saved session recovery', windows },
      });
  }
  await db.put('sessions', { id: 'current', snapshot });
}
export async function savedSessionSummary(records: TabRecord[]): Promise<SessionSummary | null> {
  const recovery = await db.get('sessions', 'recovery');
  const current = await db.get('sessions', 'current');
  const source =
    recovery && missingSessionIds(recovery.snapshot, records).length ? recovery : current;
  if (!source) return null;
  return {
    savedAt: source.snapshot.createdAt,
    windowCount: source.snapshot.windows.length,
    tabCount: source.snapshot.windows.reduce((count, window) => count + window.tabs.length, 0),
    missingTabs: missingSessionIds(source.snapshot, records).length,
  };
}
