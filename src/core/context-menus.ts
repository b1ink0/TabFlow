import * as db from './db';
import * as engine from './engine';
import { executeWorkspaceEdit } from './assistant-actions';
import { workspaceEditBaseline } from '../shared/workspace/workspace-edits';
import { pageURL } from '../shared/tabs/urls';
import type { WorkspaceIntent } from '../shared/workspace/workspace-intent';

export function nativeContextMenus(
  openDashboard: (view?: string) => Promise<number>,
  report: (error: unknown) => void,
) {
  const handlers = new Map<
    string,
    (info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab) => Promise<void>
  >();
  let tail: Promise<void> = Promise.resolve();
  async function show(
    kind: WorkspaceIntent['kind'],
    recordId?: string,
    query?: string,
    notice?: string,
  ) {
    const targetTabId = await openDashboard(kind === 'ask' ? 'assistant' : 'tabs');
    const intent: WorkspaceIntent = {
      id: crypto.randomUUID(),
      at: Date.now(),
      targetTabId,
      kind,
      recordId,
      query,
      notice,
    };
    await chrome.storage.session.set({ workspaceIntent: intent });
    void chrome.runtime
      .sendMessage({ type: 'workspaceIntent', payload: intent })
      .catch(() => undefined);
  }
  async function target(tab?: chrome.tabs.Tab) {
    if (tab?.id === undefined || tab.incognito) throw new Error('Choose a normal browser tab.');
    const app = await engine.state();
    const record = app.records.find((item) => item.tabId === tab.id);
    if (!record) throw new Error('This browser page is not a managed web tab.');
    return { app, record };
  }
  async function create(
    properties: chrome.contextMenus.CreateProperties,
    handler?: (info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab) => Promise<void>,
  ) {
    const id = String(properties.id);
    const created = await new Promise<boolean>((resolve) => {
      try {
        chrome.contextMenus.create(properties, () => resolve(!chrome.runtime.lastError));
      } catch {
        resolve(false);
      }
    });
    if (created && handler) handlers.set(id, handler);
    return created;
  }
  async function populate(prefix: string, contexts: ['page', 'link', 'action'] | ['tab']) {
    if (!(await create({ id: prefix, title: 'TabFlow', contexts }))) return false;
    const pageContexts =
      contexts[0] === 'tab' ? (['tab'] as ['tab']) : (['page', 'action'] as ['page', 'action']);
    const add = (
      suffix: string,
      title: string,
      handler: (info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab) => Promise<void>,
      parentId = prefix,
    ) => create({ id: `${prefix}-${suffix}`, parentId, title, contexts: pageContexts }, handler);
    await add('open', 'Open TabFlow', async () => {
      await openDashboard('tabs');
    });
    await add('reveal', 'Show this tab in TabFlow', async (_info, tab) => {
      const { record } = await target(tab);
      await show('reveal', record.id);
    });
    await add('ask', 'Ask assistant about this tab', async (_info, tab) => {
      const { record } = await target(tab);
      await show('ask', record.id);
    });
    await add('protect', 'Protect / unprotect this tab', async (_info, tab) => {
      const { record } = await target(tab);
      await engine.updateRecord(record.id, { locked: !record.locked });
    });
    await add('sleep', 'Suspend / wake this tab', async (_info, tab) => {
      const { record } = await target(tab);
      await engine.applyPlan({
        summary: record.suspended ? 'Wake tab from browser menu' : 'Suspend tab from browser menu',
        actions: [{ type: record.suspended ? 'wake' : 'suspend', recordIds: [record.id] }],
        expected: { [record.id]: { url: record.url, navigationVersion: record.navigationVersion } },
      });
    });
    const organize = `${prefix}-organize`;
    await create({
      id: organize,
      parentId: prefix,
      title: 'Assign project or category',
      contexts: pageContexts,
    });
    async function assign(
      tab: chrome.tabs.Tab | undefined,
      projectId: string | null,
      categoryId: string | null,
    ) {
      const { app, record } = await target(tab);
      const edit = { kind: 'membership' as const, recordId: record.id, projectId, categoryId };
      await executeWorkspaceEdit({
        kind: 'workspace_edits',
        summary: 'Assign tab from browser menu',
        edits: [{ edit, before: workspaceEditBaseline(app, edit) }],
      });
    }
    await add('inbox', 'Inbox', async (_info, tab) => assign(tab, null, null), organize);
    const projects = (await db.all('projects')).sort((a, b) => a.name.localeCompare(b.name));
    const categories = await db.all('categories');
    for (const project of projects.slice(0, 24)) {
      const parentId = `${prefix}-project-${project.id}`;
      await create({
        id: parentId,
        parentId: organize,
        title: project.name,
        contexts: pageContexts,
      });
      await add(
        `uncategorized-${project.id}`,
        'Uncategorized',
        async (_info, tab) => assign(tab, project.id, null),
        parentId,
      );
      const choices = categories
        .filter((category) => category.projectId === project.id)
        .sort((a, b) => a.order - b.order);
      for (const category of choices.slice(0, 24))
        await add(
          `category-${category.id}`,
          category.name,
          async (_info, tab) => assign(tab, project.id, category.id),
          parentId,
        );
      if (choices.length > 24)
        await add(
          `more-${project.id}`,
          'More categories in TabFlow…',
          async (_info, tab) => {
            const { record } = await target(tab);
            await show('reveal', record.id);
          },
          parentId,
        );
    }
    await add(
      'manage',
      'All projects in TabFlow…',
      async (_info, tab) => {
        const { record } = await target(tab);
        await show('reveal', record.id);
      },
      organize,
    );
    if (contexts[0] !== 'tab')
      await create(
        {
          id: `${prefix}-find-link`,
          parentId: prefix,
          title: 'Find this link in TabFlow',
          contexts: ['link'],
        },
        async (info) => {
          const url = pageURL(info.linkUrl);
          if (!url) throw new Error('Only web links can be searched.');
          await show('find-link', undefined, url);
        },
      );
    return true;
  }
  if (chrome.contextMenus?.onClicked)
    chrome.contextMenus.onClicked.addListener((info, tab) => {
      if (!String(info.menuItemId).startsWith('tabflow-')) return;
      void engine
        .serialized(async () => {
          const handler = handlers.get(String(info.menuItemId));
          if (handler) await handler(info, tab);
        })
        .catch((error: unknown) => {
          report(error);
          void show(
            'reveal',
            undefined,
            undefined,
            error instanceof Error ? error.message : String(error),
          ).catch(report);
        });
    });
  return () => {
    tail = tail
      .catch(() => undefined)
      .then(async () => {
        if (!chrome.contextMenus?.create) return;
        await new Promise<void>((resolve, reject) =>
          chrome.contextMenus.removeAll(() => {
            const error = chrome.runtime.lastError;
            if (error) reject(new Error(error.message));
            else resolve();
          }),
        );
        handlers.clear();
        await populate('tabflow-page', ['page', 'link', 'action']);
        const tabStrip = await populate('tabflow-tab', ['tab']);
        await chrome.storage.local.set({ nativeContextMenuSupport: { tabStrip } });
      });
    return tail;
  };
}
