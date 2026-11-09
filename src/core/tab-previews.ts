import * as db from './db';
import { matchesSiteList } from '../shared/tabs/suspension-policy';
import type { Settings, TabRecord } from '../shared/types';

let lastCapture = 0;
let captureEpoch = 0;
export function invalidatePreviewCapture() {
  captureEpoch++;
}
const imageLimit = 350_000;
const cacheLimit = 24 * 1024 * 1024;
export async function captureTabPreview(record: TabRecord, config: Settings) {
  const epoch = captureEpoch;
  if (
    !config.capturePreviews ||
    !record.live ||
    record.tabId === undefined ||
    record.windowId === undefined ||
    record.suspended ||
    matchesSiteList(record.url, config.previewExcludedSites)
  )
    return false;
  if (
    Date.now() - lastCapture < 1000 ||
    !(await chrome.permissions.contains({ origins: ['<all_urls>'] }))
  )
    return false;
  const window = await chrome.windows.get(record.windowId);
  const before = await chrome.tabs.get(record.tabId);
  if (
    epoch !== captureEpoch ||
    !window.focused ||
    window.incognito ||
    !before.active ||
    before.incognito ||
    before.status !== 'complete' ||
    before.url !== record.url
  )
    return false;
  lastCapture = Date.now();
  try {
    const screenshot = await chrome.tabs.captureVisibleTab(record.windowId, {
      format: 'jpeg',
      quality: 40,
    });
    const bytes = Uint8Array.from(
      atob(screenshot.slice(screenshot.indexOf(',') + 1)),
      (character) => character.charCodeAt(0),
    );
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
    let dataUrl: string;
    try {
      const width = Math.min(1000, bitmap.width);
      const canvas = new OffscreenCanvas(
        width,
        Math.max(1, Math.round((bitmap.height * width) / bitmap.width)),
      );
      canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.4 });
      const encoded = new Uint8Array(await blob.arrayBuffer());
      let binary = '';
      for (const byte of encoded) binary += String.fromCharCode(byte);
      dataUrl = `data:image/jpeg;base64,${btoa(binary)}`;
    } finally {
      bitmap.close();
    }
    const after = await chrome.tabs.get(record.tabId);
    const active = await chrome.tabs.query({ active: true, windowId: record.windowId });
    const current = await db.get('records', record.id);
    if (
      epoch !== captureEpoch ||
      after.url !== record.url ||
      !after.active ||
      active[0]?.id !== record.tabId ||
      after.incognito ||
      !current?.live ||
      current.tabId !== record.tabId ||
      current.url !== record.url ||
      current.navigationVersion !== record.navigationVersion ||
      dataUrl.length > imageLimit
    )
      return false;
    await db.put('previews', {
      id: record.id,
      url: record.url,
      navigationVersion: record.navigationVersion,
      capturedAt: Date.now(),
      dataUrl,
    });
    let size = 0,
      count = 0;
    for (const preview of await db.database.previews.orderBy('capturedAt').reverse().toArray()) {
      size += preview.dataUrl.length;
      count++;
      if (size > cacheLimit || count > 500) await db.remove('previews', preview.id);
    }
    return true;
  } catch {
    return false;
  }
}

export async function currentTabPreview(record: TabRecord) {
  const preview = await db.get('previews', record.id);
  if (
    !preview ||
    preview.url !== record.url ||
    preview.navigationVersion !== record.navigationVersion ||
    preview.dataUrl.length > imageLimit ||
    !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(preview.dataUrl)
  )
    return null;
  return preview;
}
