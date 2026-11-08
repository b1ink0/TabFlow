import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { nativeContextMenus } from '../src/core/context-menus';
import { DEFAULTS, newRecord } from '../src/shared/model';
import type { AppState } from '../src/shared/types';
const mocks = vi.hoisted(() => ({
  state: vi.fn(),
  all: vi.fn(),
  execute: vi.fn(),
  update: vi.fn(),
  apply: vi.fn(),
}));
vi.mock('../src/core/db', () => ({ all: mocks.all }));
vi.mock('../src/core/engine', () => ({
  state: mocks.state,
  serialized: async <T>(task: () => Promise<T>) => task(),
  updateRecord: mocks.update,
  applyPlan: mocks.apply,
}));
vi.mock('../src/core/assistant-actions', () => ({ executeWorkspaceEdit: mocks.execute }));
let click: Parameters<typeof chrome.contextMenus.onClicked.addListener>[0];
let tabContext = true;
let lastError: { message: string } | undefined;
const create = vi.fn((properties: chrome.contextMenus.CreateProperties, callback?: () => void) => {
  if (properties.contexts?.includes('tab') && !tabContext)
    lastError = { message: 'Unsupported context' };
  callback?.();
  lastError = undefined;
  return properties.id || '';
});
const setSession = vi.fn(async () => undefined),
  setLocal = vi.fn(async () => undefined);
const tab: chrome.tabs.Tab = {
  id: 10,
  windowId: 1,
  index: 0,
  pinned: false,
  highlighted: false,
  active: true,
  incognito: false,
  selected: true,
  discarded: false,
  frozen: false,
  lastAccessed: 1,
  autoDiscardable: true,
  groupId: -1,
  url: 'https://example.test/reading',
};
beforeEach(() => {
  vi.clearAllMocks();
  tabContext = true;
  const app: AppState = {
    records: [{ ...newRecord(tab.url!, 'reading-tab'), live: true, tabId: tab.id, windowId: 1 }],
    projects: [
      {
        id: 'reading-project',
        name: 'Reading',
        purpose: '',
        revision: 1,
        updatedAt: 1,
        maintainReviewQueue: false,
      },
    ],
    categories: [],
    memberships: [],
    areas: [],
    workItems: [],
    windows: [],
    groups: [],
    proposals: [],
    collectionProposals: [],
    organizationJobs: [],
    snapshots: [],
    operations: [],
    jobs: [],
    settings: { ...DEFAULTS },
    version: 'test',
  };
  mocks.state.mockResolvedValue(app);
  mocks.all.mockImplementation(async (name: string) =>
    name === 'projects' ? app.projects : name === 'categories' ? app.categories : [],
  );
  mocks.execute.mockResolvedValue({ id: 'owner-change' });
  vi.stubGlobal('chrome', {
    contextMenus: {
      create,
      removeAll: (callback: () => void) => callback(),
      onClicked: {
        addListener: (listener: typeof click) => {
          click = listener;
        },
      },
    },
    runtime: {
      get lastError() {
        return lastError;
      },
      sendMessage: vi.fn(async () => undefined),
    },
    storage: { session: { set: setSession }, local: { set: setLocal } },
  });
});
afterEach(() => vi.unstubAllGlobals());
describe('native workspace menus', () => {
  it('retains page/link/action menus when the browser does not support tab-strip contexts', async () => {
    tabContext = false;
    await nativeContextMenus(
      vi.fn(async () => 99),
      vi.fn(),
    )();
    expect(
      create.mock.calls.some(([properties]) => properties.id === 'tabflow-page-find-link'),
    ).toBe(true);
    expect(create.mock.calls.some(([properties]) => properties.id === 'tabflow-tab-reveal')).toBe(
      false,
    );
    expect(setLocal).toHaveBeenCalledWith({ nativeContextMenuSupport: { tabStrip: false } });
  });
  it('uses the clicked occurrence for journaled assignments and only attaches context for assistant actions', async () => {
    const open = vi.fn(async () => 99),
      report = vi.fn();
    await nativeContextMenus(open, report)();
    click({ menuItemId: 'tabflow-tab-uncategorized-reading-project', editable: false }, tab);
    await vi.waitFor(() => expect(mocks.execute).toHaveBeenCalledOnce());
    expect(mocks.execute.mock.calls[0]?.[0].edits[0].edit).toEqual({
      kind: 'membership',
      recordId: 'reading-tab',
      projectId: 'reading-project',
      categoryId: null,
    });
    click({ menuItemId: 'tabflow-page-ask', editable: false }, tab);
    await vi.waitFor(() =>
      expect(setSession).toHaveBeenCalledWith({
        workspaceIntent: expect.objectContaining({
          recordId: 'reading-tab',
          kind: 'ask',
          targetTabId: 99,
        }),
      }),
    );
    expect(open).toHaveBeenCalledWith('assistant');
    expect(report).not.toHaveBeenCalled();
  });
});
