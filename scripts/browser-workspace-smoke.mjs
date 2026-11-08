import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const chromiumPath = process.env.TABFLOW_CHROMIUM_PATH || process.env.TABLOOM_CHROMIUM_PATH;

const temporary = await mkdtemp(path.join(tmpdir(), 'tabflow-workspace-'));
if (
  !path.resolve(temporary).startsWith(path.resolve(tmpdir()) + path.sep) ||
  !path.basename(temporary).startsWith('tabflow-workspace-')
)
  throw new Error('Unsafe fixture directory.');
const extension = path.join(temporary, 'extension');
await cp(path.resolve('.output/chrome-mv3'), extension, { recursive: true });
const manifestPath = path.join(extension, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
manifest.host_permissions = ['http://127.0.0.1/*'];
await writeFile(manifestPath, JSON.stringify(manifest));
const server = createServer((_request, response) =>
  response.end('<!doctype html><title>Workspace fixture</title><h1>Local reference</h1>'),
);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let context;
try {
  context = await chromium.launchPersistentContext(path.join(temporary, 'profile'), {
    channel: chromiumPath ? undefined : 'chromium',
    executablePath: chromiumPath || undefined,
    headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  const id = new URL(worker.url()).host;
  const sourcePage = await context.newPage();
  await sourcePage.goto(`${base}/parent`);
  const dashboard = await context.newPage();
  const errors = [];
  dashboard.on('pageerror', (error) => errors.push(error.message));
  await dashboard.goto(`chrome-extension://${id}/dashboard.html#tabs`);
  await dashboard.getByRole('searchbox', { name: 'Search tabs', exact: true }).waitFor();
  const call = (type, payload) =>
    dashboard.evaluate(
      async ({ type, payload }) => {
        const result = await chrome.runtime.sendMessage({ type, payload });
        if (!result.ok) throw new Error(result.error);
        return result.value;
      },
      { type, payload },
    );
  const original = (await call('state')).records.find((record) => record.url === `${base}/parent`);
  assert(original);
  const project = await call('project', { name: 'Fixture research' });
  const category = await call('category', { projectId: project.id, name: 'References' });
  await call('assignMembership', {
    recordIds: [original.id],
    projectId: project.id,
    categoryId: category.id,
  });
  const nativeChild = await dashboard.evaluate(
    ({ tabId, windowId, url }) =>
      chrome.tabs.create({ windowId, openerTabId: tabId, active: false, url }),
    { tabId: original.tabId, windowId: original.windowId, url: `${base}/child` },
  );
  await dashboard.waitForFunction(
    async (id) => (await chrome.tabs.get(id)).status === 'complete',
    nativeChild.id,
  );
  let state = await call('state');
  const child = state.records.find((record) => record.tabId === nativeChild.id);
  assert.equal(child.parentRecordId, original.id);
  assert.equal(child.openerRecordId, original.id);
  assert.equal(
    state.memberships.find((item) => item.recordId === child.id).categoryId,
    category.id,
  );
  const trace = await call('executeWorkspaceEdit', {
    kind: 'workspace_edits',
    summary: 'Detach local child',
    edits: [
      {
        edit: { kind: 'tab_parent', recordId: child.id, parentRecordId: null },
        before: JSON.stringify({
          url: child.url,
          navigationVersion: child.navigationVersion,
          parentRecordId: original.id,
          parent: null,
        }),
      },
    ],
  });
  assert.equal(
    (await call('state')).records.find((record) => record.id === child.id).parentRecordId,
    null,
  );
  assert.equal((await call('undoAssistantChange', { id: trace.id })).status, 'undone');
  assert.equal(
    (await call('state')).records.find((record) => record.id === child.id).parentRecordId,
    original.id,
  );
  const duplicate = await call('tabCommand', {
    id: child.id,
    command: 'duplicate',
    expected: { url: child.url, navigationVersion: child.navigationVersion },
  });
  state = await call('state');
  const copy = state.records.find((record) => record.id === duplicate.tabCommand.created.recordId);
  assert.equal(copy.parentRecordId, original.id);
  assert.equal(state.memberships.find((item) => item.recordId === copy.id).categoryId, category.id);
  const blank = await call('tabCommand', {
    id: child.id,
    command: 'new',
    expected: { url: child.url, navigationVersion: child.navigationVersion },
  });
  await dashboard.evaluate(({ id, url }) => chrome.tabs.update(id, { url }), {
    id: blank.tabCommand.created.tabId,
    url: `${base}/new-reference`,
  });
  await dashboard.waitForFunction(
    async ({ id, url }) => {
      const tab = await chrome.tabs.get(id);
      return tab.url === url && tab.status === 'complete';
    },
    { id: blank.tabCommand.created.tabId, url: `${base}/new-reference` },
  );
  await dashboard.waitForFunction(
    async (id) => {
      const result = await chrome.runtime.sendMessage({ type: 'state' });
      return result.ok && result.value.records.some((record) => record.tabId === id);
    },
    blank.tabCommand.created.tabId,
    { timeout: 10000 },
  );
  state = await call('state');
  const newReference = state.records.find(
    (record) => record.tabId === blank.tabCommand.created.tabId,
  );
  assert(newReference);
  assert.equal(newReference.parentRecordId, original.id);
  assert.equal(
    state.memberships.find((item) => item.recordId === newReference.id).categoryId,
    category.id,
  );
  const transfer = await call('backupExportStart');
  let text = '',
    offset = 0;
  while (offset !== null) {
    const chunk = await call('backupExportRead', { id: transfer.id, offset });
    text += chunk.text;
    offset = chunk.nextOffset;
  }
  await call('backupTransferRelease', { id: transfer.id });
  const backup = JSON.parse(text);
  assert(
    backup.assistant.records.some(
      (record) => record.id === child.id && record.parentRecordId === original.id,
    ),
  );
  assert.equal('previews' in backup, false);
  const liveIds = (await call('state')).records.map((record) => record.id).sort();
  const importedTransfer = await call('backupImportStart', { length: text.length });
  for (let offset = 0; offset < text.length; offset += 512 * 1024)
    await call('backupImportWrite', {
      id: importedTransfer.id,
      offset,
      text: text.slice(offset, offset + 512 * 1024),
    });
  const imported = await call('backupImportCommit', { id: importedTransfer.id });
  assert.equal(imported.assistantImported, true);
  assert.deepEqual((await call('state')).records.map((record) => record.id).sort(), liveIds);
  const menuSupport = await dashboard.evaluate(async () => {
    const value = (await chrome.storage.local.get('nativeContextMenuSupport'))
      .nativeContextMenuSupport;
    await chrome.contextMenus.update('tabflow-page', { title: 'TabFlow' });
    if (value?.tabStrip) await chrome.contextMenus.update('tabflow-tab', { title: 'TabFlow' });
    return value;
  });
  assert.equal(typeof menuSupport.tabStrip, 'boolean');
  const panelLayout = await dashboard.evaluate(() => chrome.sidePanel.getLayout());
  assert(['left', 'right'].includes(panelLayout.side));
  const beforeAppearance = await dashboard.evaluate(async () =>
    (await chrome.tabs.query({})).map((tab) => tab.id),
  );
  await call('openBrowserAppearance');
  const appearance = await dashboard.evaluate(
    async (before) => (await chrome.tabs.query({})).find((tab) => !before.includes(tab.id)),
    beforeAppearance,
  );
  assert(appearance, 'Browser appearance shortcut opens a native settings tab');
  await dashboard.waitForFunction(async (id) => {
    const tab = await chrome.tabs.get(id);
    return /^(chrome|brave):\/\/settings\/appearance/.test(tab.url || '');
  }, appearance.id);
  await dashboard.evaluate((id) => chrome.tabs.remove(id), appearance.id);
  assert.deepEqual(errors, []);
  console.log(
    `Native workspace checks passed: opener/membership inheritance, duplicate/new-tab branches, journal Undo, backup export/import IPC, native panel layout/appearance shortcut and context-menu registration (tab strip: ${menuSupport.tabStrip}). Native OS menu clicking and closed-window session restoration are separate acceptance checks.`,
  );
} finally {
  await context?.close();
  server.close();
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
