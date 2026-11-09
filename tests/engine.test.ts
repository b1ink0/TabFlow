import 'fake-indexeddb/auto';
import { assistantThreadSchema, assistantMessageSchema } from '../src/shared/assistant/assistant';
import { skipFailedCollectionBatch } from '../src/shared/organization/collection-analysis';
import { listProposalRevisions, restoreProposalRevision } from '../src/core/proposal-history';
import { assistantPortableSchema } from '../src/core/assistant-portable';
import { tagSavedProposal } from '../src/ai/workflows/proposal-tagging';
import type { AssistantArtifact } from '../src/shared/assistant/assistant-actions';
import {
  tagEvidenceKey,
  tagHash,
  tagResultId,
  type TagAnalysis,
} from '../src/shared/organization/tag-analysis';
import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import type { PageContent } from '../src/shared/types';
import { database, get as getStoredEntity } from '../src/core/db';
import { DEFAULTS, importSnapshot, newRecord } from '../src/shared/model';
import { nativeGroupActions } from '../src/shared/organization/collection';
import { workspaceEditBaseline, type WorkspaceEdit } from '../src/shared/workspace/workspace-edits';
import {
  captureTabPreview,
  currentTabPreview,
  invalidatePreviewCapture,
} from '../src/core/tab-previews';

const origin = 'chrome-extension://tabloom-test';
const tabs = new Map<number, chrome.tabs.Tab>();
const groups = new Map<number, chrome.tabGroups.TabGroup>();
const local: Record<string, unknown> = {},
  session: Record<string, unknown> = {};
let nextTab = 100,
  nextWindow = 20,
  nextGroup = 50;
const moves: Array<{ ids: number | number[]; windowId: number; index: number }> = [];
let hostAccess = true,
  dirty = false;
const storage = (values: Record<string, unknown>) => ({
  get: async (key: string) => ({ [key]: values[key] }),
  set: async (patch: Record<string, unknown>) => Object.assign(values, patch),
  remove: async (key: string | string[]) => {
    for (const item of Array.isArray(key) ? key : [key]) delete values[item];
  },
  clear: async () => {
    for (const key of Object.keys(values)) delete values[key];
  },
});
function window(id: number): chrome.windows.Window {
  return {
    id,
    focused: id === 1,
    incognito: false,
    type: 'normal',
    state: 'normal',
    alwaysOnTop: false,
    tabs: [...tabs.values()].filter((t) => t.windowId === id),
  };
}
function addTab(id: number, windowId: number, url: string, index = 0) {
  tabs.set(id, {
    id,
    windowId,
    url,
    title: `Page ${id}`,
    index,
    groupId: -1,
    pinned: false,
    active: false,
    audible: false,
    incognito: false,
    highlighted: false,
    selected: false,
    discarded: false,
    frozen: false,
    autoDiscardable: true,
    status: 'complete',
    lastAccessed: Date.now() - 3600000,
  });
}
const chromeMock = {
  runtime: { getURL: (path: string) => `${origin}/${path}` },
  storage: { local: storage(local), session: storage(session) },
  windows: {
    getAll: async () => [...new Set([...tabs.values()].map((t) => t.windowId))].map(window),
    get: async (id: number) => window(id),
    getLastFocused: async () => window(1),
    create: async (options?: { url?: string; focused?: boolean }) => {
      const id = nextWindow++;
      addTab(nextTab++, id, options?.url || 'chrome://newtab/');
      return window(id);
    },
  },
  tabs: {
    query: async (filter: { windowId?: number; groupId?: number; active?: boolean }) =>
      [...tabs.values()].filter(
        (tab) =>
          (filter.windowId === undefined || tab.windowId === filter.windowId) &&
          (filter.groupId === undefined || tab.groupId === filter.groupId) &&
          (filter.active === undefined || tab.active === filter.active),
      ),
    get: async (id: number) => {
      const t = tabs.get(id);
      if (!t) throw new Error('Tab missing');
      return { ...t };
    },
    update: async (id: number, patch: Partial<chrome.tabs.Tab> & { muted?: boolean }) => {
      const t = tabs.get(id)!;
      Object.assign(t, patch);
      if (patch.muted !== undefined) t.mutedInfo = { muted: patch.muted };
      return { ...t };
    },
    move: async (ids: number | number[], patch: { windowId: number; index: number }) => {
      moves.push({ ids, ...patch });
      const result = [];
      for (const id of Array.isArray(ids) ? ids : [ids]) {
        const t = tabs.get(id)!;
        t.windowId = patch.windowId;
        t.index =
          patch.index < 0
            ? [...tabs.values()].filter((t) => t.windowId === patch.windowId).length
            : patch.index;
        result.push({ ...t });
      }
      return result;
    },
    create: async (patch: { windowId: number; url: string; active: boolean; pinned?: boolean }) => {
      const id = nextTab++;
      addTab(id, patch.windowId, patch.url);
      Object.assign(tabs.get(id)!, patch);
      return { ...tabs.get(id)! };
    },
    duplicate: async (sourceId: number) => {
      const source = tabs.get(sourceId)!;
      const id = nextTab++;
      tabs.set(id, { ...source, id, index: source.index + 1 });
      return { ...tabs.get(id)! };
    },
    remove: async (id: number) => {
      tabs.delete(id);
    },
    ungroup: async (ids: number | number[]) => {
      for (const id of Array.isArray(ids) ? ids : [ids]) tabs.get(id)!.groupId = -1;
    },
    group: async (options: {
      groupId?: number;
      createProperties?: { windowId: number };
      tabIds: number[];
    }) => {
      const id = options.groupId ?? nextGroup++;
      if (!groups.has(id))
        groups.set(id, {
          id,
          windowId: options.createProperties!.windowId,
          title: '',
          color: 'grey',
          collapsed: false,
          shared: false,
        });
      for (const t of options.tabIds) tabs.get(t)!.groupId = id;
      return id;
    },
    discard: async () => {},
    reload: async (_id: number) => {},
    captureVisibleTab: async () => 'data:image/jpeg;base64,YQ==',
  },
  tabGroups: {
    move: async (id: number, patch: { windowId: number; index: number }) => {
      const group = groups.get(id)!;
      group.windowId = patch.windowId;
      for (const tab of tabs.values()) if (tab.groupId === id) tab.windowId = patch.windowId;
      return group;
    },
    query: async (filter: { windowId?: number }) =>
      [...groups.values()].filter(
        (g) => filter.windowId === undefined || g.windowId === filter.windowId,
      ),
    update: async (id: number, patch: Partial<chrome.tabGroups.TabGroup>) => {
      const g = groups.get(id)!;
      Object.assign(g, patch);
      return g;
    },
  },
  permissions: {
    contains: async () => hostAccess,
    getAll: async () => ({
      origins: hostAccess ? ['http://*/*', 'https://*/*'] : [],
      permissions: [],
    }),
  },
  scripting: {
    executeScript: async (options: { target: { tabId: number }; files?: string[] }) => {
      if (options.files) return [{ result: undefined }];
      const t = tabs.get(options.target.tabId)!;
      const content: PageContent = {
        title: t.title!,
        url: t.url!,
        description: 'A page',
        headings: ['Main'],
        text: 'Useful text',
        scroll: 64,
        capturedAt: Date.now(),
        dirty,
        playing: false,
      };
      return [{ result: content }];
    },
    getRegisteredContentScripts: async () => [],
    registerContentScripts: async () => {},
  },
  idle: { queryState: async () => 'active' },
  downloads: { download: async () => 1 },
};
let permissions: typeof import('../src/core/permission-review');
let engine: typeof import('../src/core/engine');
let executeWorkspaceEdit: typeof import('../src/core/assistant-actions').executeWorkspaceEdit;
let executeAssistantAction: typeof import('../src/core/assistant-actions').executeAssistantAction;
let redoAssistantChange: typeof import('../src/core/assistant-actions').redoAssistantChange;
let undoAssistantChange: typeof import('../src/core/assistant-actions').undoAssistantChange;
let revokeApprovals: typeof import('../src/core/assistant-actions').revokeApprovals;
let interruptAssistantActions: typeof import('../src/core/assistant-actions').interruptAssistantActions;
beforeAll(async () => {
  vi.stubGlobal('chrome', chromeMock);
  engine = await import('../src/core/engine');
  permissions = await import('../src/core/permission-review');
  ({
    executeAssistantAction,
    executeWorkspaceEdit,
    undoAssistantChange,
    redoAssistantChange,
    revokeApprovals,
    interruptAssistantActions,
  } = await import('../src/core/assistant-actions'));
});
beforeEach(async () => {
  for (const table of database.tables) await table.clear();
  tabs.clear();
  groups.clear();
  for (const k of Object.keys(local)) delete local[k];
  for (const k of Object.keys(session)) delete session[k];
  hostAccess = true;
  dirty = false;
  nextTab = 100;
  nextWindow = 20;
  nextGroup = 50;
  moves.length = 0;
  addTab(11, 1, 'https://example.com/one', 0);
  addTab(12, 1, 'https://example.com/two', 1);
  addTab(13, 2, 'https://example.com/three', 0);
  local.settings = { ...DEFAULTS };
});
describe('coordinator integration', () => {
  it('prioritizes focus without interrupting a running mutation or losing queued work', async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = engine.serialized(async () => {
      order.push('start');
      await gate;
      order.push('end');
    });
    const normal = engine.serialized(async () => {
      order.push('normal');
    });
    const focus = engine.serialized(async () => {
      order.push('focus');
    }, true);
    expect(order).toEqual(['start']);
    release();
    await Promise.all([running, normal, focus]);
    expect(order).toEqual(['start', 'end', 'focus', 'normal']);
    await expect(
      engine.serialized(async () => {
        throw new Error('failed');
      }, true),
    ).rejects.toThrow('failed');
    await engine.serialized(async () => {
      order.push('continued');
    });
    expect(order.at(-1)).toBe('continued');
  });
  afterEach(() => vi.restoreAllMocks());
  async function permissionFixture(
    instruction = 'Add the reference tag to this selected tab.',
    artifactOverride?: AssistantArtifact,
  ) {
    const app = await engine.state();
    const record = app.records.find((item) => item.tabId === 11)!;
    const edit = {
      kind: 'tags' as const,
      recordId: record.id,
      mode: 'add' as const,
      tags: ['reference'],
    };
    const artifact: AssistantArtifact = artifactOverride || {
      kind: 'command',
      command: {
        kind: 'workspace_edits',
        summary: 'Tag the selected reference',
        edits: [{ edit, before: workspaceEditBaseline(app, edit) }],
      },
    };
    const request = {
      task: 'work' as const,
      recordIds: [record.id],
      selectedRecordIds: [record.id],
      projectId: null,
      restrictToScope: true,
      allowCrossWindowMove: false,
      allowSleepWake: false,
    };
    await database.assistantThreads.put(
      assistantThreadSchema.parse({
        id: 'permission-chat',
        title: 'Synthetic permissions',
        createdAt: 1,
        updatedAt: 1,
        projectId: null,
        status: 'ready',
        messages: [
          { id: 'permission-user', role: 'user', content: instruction, createdAt: 1, request },
          {
            id: 'permission-answer',
            role: 'assistant',
            content: 'Prepared action',
            createdAt: 2,
            requestMessageId: 'permission-user',
            deliveryStatus: 'complete',
            ...(artifact.kind === 'command'
              ? { commandDraft: artifact.command }
              : artifact.kind === 'plan'
                ? { plan: artifact.plan }
                : {}),
          },
        ],
      }),
    );
    local.settings = {
      ...DEFAULTS,
      aiModel: 'synthetic-reviewer',
      aiContextTokens: 32768,
      aiCompletionTokens: 1024,
    };
    return {
      record,
      artifact,
      threadId: 'permission-chat',
      messageId: 'permission-answer',
      oneOff: false,
    };
  }
  it('applies both composed tag additions and journals one reversible final effect', async () => {
    const app = await engine.state();
    const record = app.records[0]!;
    const edits: WorkspaceEdit[] = ['alpha', 'beta'].map((tag) => ({
      kind: 'tags',
      recordId: record.id,
      mode: 'add',
      tags: [tag],
    }));
    const artifact: AssistantArtifact = {
      kind: 'command',
      command: {
        kind: 'workspace_edits',
        summary: 'Add both tags',
        edits: edits.map((edit) => ({ edit, before: workspaceEditBaseline(app, edit) })),
      },
    };
    const context = await permissionFixture('Add alpha and beta.', artifact);
    const trace = await executeAssistantAction({ ...context, mode: 'once' });
    expect((await database.records.get(record.id))?.tags).toEqual(['alpha', 'beta']);
    await undoAssistantChange(trace.id);
    expect((await database.records.get(record.id))?.tags).toEqual([]);
    await redoAssistantChange(trace.id);
    expect((await database.records.get(record.id))?.tags).toEqual(['alpha', 'beta']);
  });
  it('persists custom display colors separately from native group colors and retains them in backups', async () => {
    const project = await engine.project(
      { name: 'Colored project', displayColor: '#238abc' },
      false,
    );
    const category = await engine.saveCategory({
      projectId: project.id,
      name: 'Colored category',
      color: 'blue',
      displayColor: '#c57329',
    });
    await engine.project({ id: project.id, name: project.name, purpose: 'Updated purpose' }, false);
    expect((await database.projects.get(project.id))?.displayColor).toBe('#238abc');
    expect(category.color).toBe('blue');
    expect(category.displayColor).toBe('#c57329');
    await expect(
      engine.project({ name: 'Invalid color', displayColor: 'url(unsafe)' }, false),
    ).rejects.toThrow('hex');
    const backup = await engine.exportBackup(false);
    expect(backup.projects.find((item) => item.id === project.id)?.displayColor).toBe('#238abc');
    await engine.importBackup(backup);
    expect(
      (await database.projects.toArray()).filter((item) => item.displayColor === '#238abc'),
    ).toHaveLength(2);
    expect(
      (await database.categories.toArray()).filter(
        (item) => item.displayColor === '#c57329' && item.color === 'blue',
      ),
    ).toHaveLength(2);
  });
  it('keeps category deletion inside the exact attached scope', async () => {
    const app = await engine.state();
    const project = await engine.project({ name: 'Category scope fixture' }, false);
    const category = await engine.saveCategory({ projectId: project.id, name: 'Shared category' });
    await engine.assignMembership(
      {
        recordIds: app.records.map((item) => item.id),
        projectId: project.id,
        categoryId: category.id,
      },
      false,
    );
    const current = await engine.state();
    const edit: WorkspaceEdit = { kind: 'delete_category', categoryId: category.id };
    const artifact: AssistantArtifact = {
      kind: 'command',
      command: {
        kind: 'workspace_edits',
        summary: 'Delete shared category',
        edits: [{ edit, before: workspaceEditBaseline(current, edit) }],
      },
    };
    const context = await permissionFixture('Delete the selected category.', artifact);
    const review = await permissions.preparePermissionReview({ ...context, oneOff: true });
    expect(review.decision).toBe('ask');
    expect(review.reason).toContain('scope');
    await expect(executeAssistantAction({ ...context, mode: 'once' })).rejects.toThrow('scope');
    expect(await database.categories.get(category.id)).toBeDefined();
  });
  it('restores more than twenty saved tags after a manual tag rename', async () => {
    const app = await engine.state(),
      record = app.records[0]!;
    const tags = Array.from({ length: 35 }, (_, index) => `label-${index}`);
    await engine.updateRecord(record.id, { tags });
    const current = await engine.state();
    const edit: WorkspaceEdit = {
      kind: 'tags',
      recordId: record.id,
      mode: 'replace',
      tags: ['renamed', ...tags.slice(1)],
    };
    const change = await executeWorkspaceEdit({
      kind: 'workspace_edits',
      summary: 'Rename label',
      edits: [{ edit, before: workspaceEditBaseline(current, edit) }],
    });
    await undoAssistantChange(change.id);
    expect((await database.records.get(record.id))?.tags).toEqual(tags);
    await redoAssistantChange(change.id);
    expect((await database.records.get(record.id))?.tags).toEqual(['renamed', ...tags.slice(1)]);
  });
  it('journals manual category deletion and restores exact category membership on Undo and Redo', async () => {
    const app = await engine.state(),
      record = app.records[0]!;
    const project = await engine.project({ name: 'Delete category fixture' }, false);
    const category = await engine.saveCategory({
      projectId: project.id,
      name: 'Temporary category',
    });
    await engine.assignMembership(
      { recordIds: [record.id], projectId: project.id, categoryId: category.id },
      false,
    );
    const before = await engine.state();
    const edit: WorkspaceEdit = { kind: 'delete_category', categoryId: category.id };
    const change = await executeWorkspaceEdit({
      kind: 'workspace_edits',
      summary: 'Delete temporary category',
      edits: [{ edit, before: workspaceEditBaseline(before, edit) }],
    });
    expect(change.source).toBe('owner');
    expect(await database.categories.get(category.id)).toBeUndefined();
    expect(await database.memberships.get(record.id)).toMatchObject({
      projectId: project.id,
      categoryId: null,
    });
    await undoAssistantChange(change.id);
    expect(await database.categories.get(category.id)).toMatchObject({
      name: category.name,
      projectId: project.id,
    });
    expect(await database.memberships.get(record.id)).toMatchObject({
      projectId: project.id,
      categoryId: category.id,
    });
    await redoAssistantChange(change.id);
    expect(await database.categories.get(category.id)).toBeUndefined();
    expect(await database.memberships.get(record.id)).toMatchObject({
      projectId: project.id,
      categoryId: null,
    });
    expect(moves).toHaveLength(0);
  });
  it('reorders project categories with manual Undo without changing memberships', async () => {
    const project = await engine.project({ name: 'Category order fixture' }, false);
    const first = await engine.saveCategory({ projectId: project.id, name: 'First' });
    const second = await engine.saveCategory({ projectId: project.id, name: 'Second' });
    const before = await engine.state();
    const edit: WorkspaceEdit = {
      kind: 'category_order',
      projectId: project.id,
      categoryIds: [second.id, first.id],
    };
    const change = await executeWorkspaceEdit({
      kind: 'workspace_edits',
      summary: 'Reorder categories',
      edits: [{ edit, before: workspaceEditBaseline(before, edit) }],
    });
    expect((await database.categories.get(second.id))?.order).toBe(0);
    await undoAssistantChange(change.id);
    expect((await database.categories.get(first.id))?.order).toBe(0);
    expect((await database.categories.get(second.id))?.order).toBe(1);
    expect(await database.memberships.toArray()).toEqual(before.memberships);
  });
  it('creates an accepted area, project and category with assignments in one reviewed transaction and Undo/Redo', async () => {
    const before = await engine.state();
    const record = before.records[0]!;
    const edit: WorkspaceEdit = {
      kind: 'structure',
      area: { id: null, name: 'Leisure', description: 'Personal interests' },
      project: { id: null, name: 'Gaming collection', purpose: 'Steam references' },
      categories: [{ id: null, name: 'Steam', description: 'Game pages', color: 'blue' }],
      recordIds: [record.id],
      categoryName: 'Steam',
    };
    const artifact: AssistantArtifact = {
      kind: 'command',
      command: {
        kind: 'workspace_edits',
        summary: 'Create Gaming and assign this tab',
        edits: [{ edit, before: workspaceEditBaseline(before, edit) }],
      },
    };
    const context = await permissionFixture(
      'Create Leisure / Gaming collection / Steam and assign this tab.',
      artifact,
    );
    const trace = await executeAssistantAction({ ...context, mode: 'once' });
    const applied = await engine.state();
    const area = applied.areas.find((item) => item.name === 'Leisure')!;
    const project = applied.projects.find((item) => item.name === 'Gaming collection')!;
    const category = applied.categories.find(
      (item) => item.projectId === project.id && item.name === 'Steam',
    )!;
    expect(project.areaId).toBe(area.id);
    expect(applied.memberships.find((item) => item.recordId === record.id)).toMatchObject({
      projectId: project.id,
      categoryId: category.id,
    });
    expect(moves).toHaveLength(0);
    await undoAssistantChange(trace.id);
    const undone = await engine.state();
    expect(undone.areas).toEqual(before.areas);
    expect(undone.projects).toEqual(before.projects);
    expect(undone.categories).toEqual(before.categories);
    expect(undone.memberships.map(({ updatedAt: _time, ...item }) => item)).toEqual(
      before.memberships.map(({ updatedAt: _time, ...item }) => item),
    );
    await redoAssistantChange(trace.id);
    const redone = await engine.state();
    expect(redone.projects.find((item) => item.id === project.id)).toMatchObject({
      areaId: area.id,
    });
    expect(redone.memberships.find((item) => item.recordId === record.id)?.categoryId).toBe(
      category.id,
    );
  });
  it('rejects stale structure assignments before creating any area/project/category', async () => {
    const before = await engine.state();
    const record = before.records[0]!;
    const edit: WorkspaceEdit = {
      kind: 'structure',
      area: { id: null, name: 'Never created', description: '' },
      project: { id: null, name: 'Never created', purpose: '' },
      categories: [{ id: null, name: 'New category', description: '', color: 'grey' }],
      recordIds: [record.id],
      categoryName: 'New category',
    };
    const draft = {
      kind: 'workspace_edits',
      summary: 'Stale structure',
      edits: [{ edit, before: workspaceEditBaseline(before, edit) }],
    };
    await database.records.update(record.id, { locked: true });
    await expect(engine.applyWorkspaceEdits(draft, false)).rejects.toThrow('unprotected');
    expect(await database.areas.toArray()).toEqual(before.areas);
    expect(await database.projects.toArray()).toEqual(before.projects);
    expect(await database.categories.toArray()).toEqual(before.categories);
  });
  it('creates dated linked task batches and updates their details with guarded Undo', async () => {
    const app = await engine.state();
    const record = app.records[0]!;
    const edits: WorkspaceEdit[] = ['Read', 'Review'].map((title) => ({
      kind: 'create_work_item',
      task: {
        title,
        notes: 'Saved reference',
        areaId: null,
        projectId: null,
        priority: 'high',
        dueAt: 1900000000000,
        recordId: record.id,
      },
    }));
    const artifact: AssistantArtifact = {
      kind: 'command',
      command: {
        kind: 'workspace_edits',
        summary: 'Two follow-ups',
        edits: edits.map((edit) => ({ edit, before: workspaceEditBaseline(app, edit) })),
      },
    };
    const context = await permissionFixture('Create two dated follow-ups.', artifact);
    const trace = await executeAssistantAction({ ...context, mode: 'once' });
    const items = await database.workItems.toArray();
    expect(items).toHaveLength(2);
    expect(items.every((item) => item.dueAt === 1900000000000 && item.recordId === record.id)).toBe(
      true,
    );
    await undoAssistantChange(trace.id);
    expect(await database.workItems.count()).toBe(0);
    await redoAssistantChange(trace.id);
    expect(await database.workItems.count()).toBe(2);
    const updatedApp = await engine.state();
    const item = (await database.workItems.toArray())[0]!;
    const edit: WorkspaceEdit = {
      kind: 'work_item',
      workItemId: item.id,
      status: 'doing',
      priority: 'normal',
      title: 'Revised task',
      notes: 'Updated details',
      dueAt: null,
      linkedRecordId: null,
    };
    await engine.applyWorkspaceEdits(
      {
        kind: 'workspace_edits',
        summary: 'Update task',
        edits: [{ edit, before: workspaceEditBaseline(updatedApp, edit) }],
      },
      false,
    );
    expect(await database.workItems.get(item.id)).toMatchObject({
      title: 'Revised task',
      notes: 'Updated details',
      dueAt: null,
      recordId: null,
      status: 'doing',
    });
  });
  it('keeps draft edit history with guarded Undo and Redo without applying organization', async () => {
    const record = (await engine.state()).records[0]!;
    const memberships = await database.memberships.toArray();
    const proposal = await engine.saveCollectionProposal({
      name: 'First',
      summary: 'References',
      projects: [],
      assignments: [],
      unresolvedRecordIds: [record.id],
      scopeRecordIds: [record.id],
    });
    const updated = await engine.updateCollectionProposal(
      proposal.id,
      { ...proposal, name: 'Second' },
      false,
      { expectedFingerprint: await tagHash(proposal) },
    );
    const rows = await listProposalRevisions(proposal.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.canUndo).toBe(true);
    expect(rows[0]).not.toHaveProperty('before');
    await expect(
      restoreProposalRevision({
        id: rows[0]!.id,
        direction: 'undo',
        expectedFingerprint: await tagHash(proposal),
      }),
    ).rejects.toThrow('changed after review');
    const undone = await restoreProposalRevision({
      id: rows[0]!.id,
      direction: 'undo',
      expectedFingerprint: await tagHash(updated),
    });
    expect(undone.name).toBe('First');
    expect(undone.status).toBe('pending');
    const redone = await restoreProposalRevision({
      id: rows[0]!.id,
      direction: 'redo',
      expectedFingerprint: await tagHash(undone),
    });
    expect(redone.name).toBe('Second');
    expect(await database.memberships.toArray()).toEqual(memberships);
  });
  it('round-trips chats and pending drafts in backups without restoring approval authority or live handles', async () => {
    const context = await permissionFixture();
    const proposal = await engine.saveCollectionProposal({
      name: 'Saved references',
      summary: 'Pending',
      projects: [],
      assignments: [],
      unresolvedRecordIds: [context.record.id],
      scopeRecordIds: [context.record.id],
    });
    const thread = (await database.assistantThreads.get(context.threadId))!;
    thread.messages[1]!.collectionProposalId = proposal.id;
    thread.messages[1]!.collectionApplyRequested = true;
    thread.messages[1]!.permissionReviewIds = ['old-authority'];
    await database.assistantThreads.put(thread);
    await permissions.setPermissionPolicy({ threadId: thread.id, mode: 'all' });
    local.settings = { ...DEFAULTS, aiKey: 'fictional-key-not-portable' };
    const backup = await engine.exportBackup();
    const archived = assistantPortableSchema.parse(backup.assistant);
    expect(archived.threads).toHaveLength(1);
    expect(archived.proposals).toHaveLength(1);
    expect(JSON.stringify(backup)).not.toContain('fictional-key-not-portable');
    const beforeTabs = tabs.size;
    const imported = await engine.importBackup(backup);
    expect(imported.assistantImported).toBe(true);
    const importedThread = (await database.assistantThreads.toArray()).find(
      (item) => item.id !== thread.id,
    )!;
    expect(importedThread.messages[1]?.collectionApplyRequested).toBe(false);
    expect(importedThread.messages[1]?.permissionReviewIds).toEqual([]);
    expect(importedThread.messages[1]?.completedArtifacts).toContain('command');
    expect(await permissions.permissionPolicy(importedThread.id)).toMatchObject({ mode: 'ask' });
    const importedProposal = (await database.collectionProposals.toArray()).find(
      (item) => item.id !== proposal.id,
    )!;
    expect(importedThread.messages[1]?.collectionProposalId).toBe(importedProposal.id);
    expect((await database.records.get(importedProposal.unresolvedRecordIds[0]!))?.live).toBe(
      false,
    );
    expect(tabs.size).toBe(beforeTabs);
  });
  const permissionResponse = (
    decision: string,
    reason = 'The exact tag edit fulfills the user request.',
  ) =>
    new Response(
      JSON.stringify({
        id: 'synthetic-response',
        object: 'chat.completion',
        created: 1,
        model: 'synthetic-reviewer',
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: { role: 'assistant', content: JSON.stringify({ decision, reason }) },
          },
        ],
      }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  it('requires delegation, reviews without tools and consumes an exact approval only once', async () => {
    const input = await permissionFixture();
    await expect(permissions.preparePermissionReview(input)).rejects.toThrow('off for this chat');
    await permissions.setPermissionPolicy({ threadId: input.threadId, mode: 'review' });
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.tools).toBeUndefined();
      expect(body.messages[0].content).toContain('NOT permission to apply');
      expect(JSON.parse(body.messages[1].content).originalRequest).toBe(
        'Add the reference tag to this selected tab.',
      );
      return permissionResponse('allow');
    });
    const pending = await permissions.preparePermissionReview(input);
    expect((await permissions.resolvePermissionReview(pending.id)).decision).toBe('allow');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await database.records.get(input.record.id))?.tags).toEqual([]);
    const request = { ...input, mode: 'reviewed', permissionReviewId: pending.id };
    const trace = await executeAssistantAction(request);
    expect(trace.permissionReview?.id).toBe(pending.id);
    expect((await database.records.get(input.record.id))?.tags).toEqual(['reference']);
    expect((await executeAssistantAction(request)).id).toBe(trace.id);
    const other = {
      ...input.artifact,
      kind: 'command' as const,
      command: { kind: 'snapshot', label: 'Unrelated' },
    };
    await expect(executeAssistantAction({ ...request, artifact: other })).rejects.toThrow();
    await undoAssistantChange(trace.id);
    expect((await database.records.get(input.record.id))?.tags).toEqual([]);
  });
  it('records a decline for a proposal-only request without executing and lets the owner override', async () => {
    const input = await permissionFixture('Prepare tags for review. Do not apply any changes.');
    await permissions.setPermissionPolicy({ threadId: input.threadId, mode: 'review' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      permissionResponse(
        'deny',
        'The user requested a draft and explicitly prohibited applying it.',
      ),
    );
    const pending = await permissions.preparePermissionReview(input);
    expect((await permissions.resolvePermissionReview(pending.id)).decision).toBe('deny');
    await expect(
      executeAssistantAction({ ...input, mode: 'reviewed', permissionReviewId: pending.id }),
    ).rejects.toThrow('current permission review');
    expect((await database.records.get(input.record.id))?.tags).toEqual([]);
    expect((await executeAssistantAction({ ...input, mode: 'once' })).status).toBe('complete');
  });
  it('runs Approve all without a reviewer only under the current chat policy and saved draft scope', async () => {
    const input = await permissionFixture();
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(permissionResponse('deny'));
    const request = { ...input, mode: 'automatic' as const };
    await expect(executeAssistantAction(request)).rejects.toThrow('Approve all is not enabled');
    const policy = await permissions.setPermissionPolicy({ threadId: input.threadId, mode: 'all' });
    await permissions.setPermissionPolicy({ threadId: input.threadId, mode: 'ask' });
    await expect(
      executeAssistantAction({ ...request, permissionPolicyRevision: policy.revision }),
    ).rejects.toThrow('Approve all is not enabled');
    const enabled = await permissions.setPermissionPolicy({
      threadId: input.threadId,
      mode: 'all',
    });
    const thread = (await database.assistantThreads.get(input.threadId))!;
    const user = thread.messages.find((message) => message.role === 'user')!;
    const originalRequest = user.request;
    user.request = { ...user.request!, restrictToScope: true, recordIds: [] };
    await database.assistantThreads.put(thread);
    await expect(
      executeAssistantAction({ ...request, permissionPolicyRevision: enabled.revision }),
    ).rejects.toThrow('selected tab scope');
    user.request = originalRequest;
    await database.assistantThreads.put(thread);
    const approved = { ...request, permissionPolicyRevision: enabled.revision };
    const trace = await executeAssistantAction(approved);
    expect(trace.status).toBe('complete');
    expect(trace.mode).toBe('automatic');
    expect((await database.records.get(input.record.id))?.tags).toEqual(['reference']);
    expect((await executeAssistantAction(approved)).id).toBe(trace.id);
    expect(fetch).not.toHaveBeenCalled();
    expect(await database.permissionReviews.count()).toBe(0);
    await undoAssistantChange(trace.id);
    expect((await database.records.get(input.record.id))?.tags).toEqual([]);
  });
  it('asks on malformed responses, a changed draft, missing configuration and an oversized exact action', async () => {
    const input = await permissionFixture();
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(permissionResponse('always-allow'));
    let pending = await permissions.preparePermissionReview({ ...input, oneOff: true });
    expect((await permissions.resolvePermissionReview(pending.id)).decision).toBe('ask');
    const changed = structuredClone(input.artifact);
    if (changed.kind === 'command' && changed.command.kind === 'workspace_edits')
      changed.command.summary = 'Not the saved draft';
    pending = await permissions.preparePermissionReview({
      ...input,
      artifact: changed,
      oneOff: true,
    });
    expect(pending.reason).toContain('differs');
    expect(fetch).toHaveBeenCalledTimes(1);
    local.settings = { ...DEFAULTS, aiModel: '', aiContextTokens: 0 };
    pending = await permissions.preparePermissionReview({ ...input, oneOff: true });
    expect((await permissions.resolvePermissionReview(pending.id)).reason).toContain('Configure');
    local.settings = {
      ...DEFAULTS,
      aiModel: 'synthetic-reviewer',
      aiContextTokens: 1500,
      aiCompletionTokens: 1024,
    };
    pending = await permissions.preparePermissionReview({ ...input, oneOff: true });
    expect((await permissions.resolvePermissionReview(pending.id)).decision).toBe('ask');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('invalidates a model approval after policy, target, expiry, or selected answer changes', async () => {
    const input = await permissionFixture();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => permissionResponse('allow'));
    await permissions.setPermissionPolicy({ threadId: input.threadId, mode: 'review' });
    let pending = await permissions.preparePermissionReview(input);
    await permissions.resolvePermissionReview(pending.id);
    tabs.get(11)!.pinned = true;
    await expect(
      executeAssistantAction({ ...input, mode: 'reviewed', permissionReviewId: pending.id }),
    ).rejects.toThrow('changed after approval');
    tabs.get(11)!.pinned = false;
    pending = await permissions.preparePermissionReview(input);
    await permissions.resolvePermissionReview(pending.id);
    await database.permissionReviews.update(pending.id, { expiresAt: 0 });
    await expect(
      executeAssistantAction({ ...input, mode: 'reviewed', permissionReviewId: pending.id }),
    ).rejects.toThrow('current permission review');
    pending = await permissions.preparePermissionReview(input);
    await permissions.resolvePermissionReview(pending.id);
    await permissions.setPermissionPolicy({ threadId: input.threadId, mode: 'ask' });
    await expect(
      executeAssistantAction({ ...input, mode: 'reviewed', permissionReviewId: pending.id }),
    ).rejects.toThrow('current permission review');
    pending = await permissions.preparePermissionReview({ ...input, oneOff: true });
    await permissions.resolvePermissionReview(pending.id);
    await database.assistantThreads.update(input.threadId, { selectedLeafId: 'permission-user' });
    await expect(
      executeAssistantAction({ ...input, mode: 'reviewed', permissionReviewId: pending.id }),
    ).rejects.toThrow('selected answer branch');
  });
  it('asks before inference when an edit baseline or protected target is no longer valid', async () => {
    const input = await permissionFixture();
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(permissionResponse('allow'));
    await database.records.update(input.record.id, { tags: ['owner-choice'] });
    const changed = await permissions.preparePermissionReview({ ...input, oneOff: true });
    expect(changed.decision).toBe('ask');
    expect(changed.status).toBe('complete');
    expect(changed.reason).toContain('no longer match');
    await database.records.update(input.record.id, { tags: [], locked: true });
    const locked = await permissions.preparePermissionReview({ ...input, oneOff: true });
    expect(locked.decision).toBe('ask');
    expect(locked.reason).toContain('protected');
    expect(fetch).not.toHaveBeenCalled();
    expect(await database.assistantChanges.count()).toBe(0);
  });
  it('uses later user instructions and invalidates older authority before execution', async () => {
    const input = await permissionFixture();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => permissionResponse('allow'));
    const pending = await permissions.preparePermissionReview({ ...input, oneOff: true });
    await permissions.resolvePermissionReview(pending.id);
    const thread = (await database.assistantThreads.get(input.threadId))!;
    thread.messages.push(
      assistantMessageSchema.parse({
        id: 'later-user',
        role: 'user',
        content: 'Do not apply it. Keep the draft only.',
        createdAt: 3,
      }),
    );
    await database.assistantThreads.put(thread);
    await expect(
      executeAssistantAction({ ...input, mode: 'reviewed', permissionReviewId: pending.id }),
    ).rejects.toThrow('changed after approval');
    expect((await database.permissionReviews.get(pending.id))?.decision).toBe('ask');
    const context = await permissions.permissionContext(
      input.threadId,
      input.messageId,
      input.artifact,
    );
    expect(JSON.parse(context.packet).latestUserRequest).toBe(
      'Do not apply it. Keep the draft only.',
    );
    expect((await database.records.get(input.record.id))?.tags).toEqual([]);
  });
  it('revokes an in-flight review without holding the browser coordinator and never resumes it on restart', async () => {
    const input = await permissionFixture();
    await permissions.setPermissionPolicy({ threadId: input.threadId, mode: 'review' });
    let started!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          started();
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        }),
    );
    const pending = await permissions.preparePermissionReview(input);
    const running = permissions.resolvePermissionReview(pending.id);
    await requestStarted;
    await engine.serialized(() =>
      permissions.setPermissionPolicy({ threadId: input.threadId, mode: 'ask' }),
    );
    const stopped = await running;
    expect(stopped.decision).toBe('ask');
    expect(stopped.status).toBe('interrupted');
    expect(await database.assistantChanges.count()).toBe(0);
    const next = await permissions.preparePermissionReview({ ...input, oneOff: true });
    await permissions.interruptPermissionReviews();
    expect((await permissions.resolvePermissionReview(next.id)).status).toBe('interrupted');
  });
  it('can Undo successive project edits without confusing new revision counters with manual changes', async () => {
    const project = await engine.project({ name: 'Original name' });
    const rename = async (name: string, messageId: string) => {
      const app = await engine.state();
      const edit: WorkspaceEdit = {
        kind: 'project',
        projectId: project.id,
        name,
        purpose: '',
        areaId: null,
      };
      return executeAssistantAction({
        threadId: 'chat',
        messageId,
        mode: 'once',
        artifact: {
          kind: 'command',
          command: {
            kind: 'workspace_edits',
            summary: `Rename to ${name}`,
            edits: [{ edit, before: workspaceEditBaseline(app, edit) }],
          },
        },
      });
    };
    const first = await rename('First name', 'first');
    const second = await rename('Second name', 'second');
    expect((await undoAssistantChange(second.id)).status).toBe('undone');
    expect((await undoAssistantChange(first.id)).status).toBe('undone');
    expect((await database.projects.get(project.id))?.name).toBe('Original name');
  });

  it('rechecks native Redo and rejects changes made after Undo', async () => {
    const app = await engine.state();
    const record = app.records.find((item) => item.tabId === 11)!;
    const operation = await engine.applyPlan({
      summary: 'Pin reference',
      actions: [{ type: 'pin', recordIds: [record.id], enabled: true }],
    });
    expect((await engine.undoOperation(operation.id)).every((item) => item.ok)).toBe(true);
    const redone = await engine.redoOperation(operation.id);
    expect(redone.id).not.toBe(operation.id);
    expect(tabs.get(11)?.pinned).toBe(true);
    await expect(engine.redoOperation(operation.id)).rejects.toThrow('not available');
    await engine.undoOperation(redone.id);
    tabs.get(11)!.mutedInfo = { muted: true };
    await expect(engine.redoOperation(redone.id)).rejects.toThrow('later browser change');
  });
  it('duplicates as an independent occurrence and retains a changed duplicate on Undo', async () => {
    const app = await engine.state();
    const record = app.records.find((item) => item.tabId === 11)!;
    const operation = await engine.tabCommand({
      id: record.id,
      command: 'duplicate',
      expected: { url: record.url, navigationVersion: record.navigationVersion },
    });
    expect(operation.status).toBe('complete');
    const copyId = operation.tabCommand!.created!.recordId!;
    expect(copyId).not.toBe(record.id);
    expect((await engine.state()).records.find((item) => item.id === copyId)?.url).toBe(record.url);
    const tabId = operation.tabCommand!.created!.tabId;
    tabs.get(tabId)!.url = 'https://example.test/independent';
    await expect(engine.undoOperation(operation.id)).rejects.toThrow('changed');
    expect(tabs.has(tabId)).toBe(true);
  });
  it('shows New tab below immediately in its source membership and sibling branch, keeping its UUID on first navigation', async () => {
    const source = (await engine.state()).records.find((record) => record.tabId === 11)!;
    const parent = (await engine.state()).records.find((record) => record.id !== source.id)!;
    await database.records.update(source.id, { parentRecordId: parent.id });
    const project = await engine.project({ name: 'Reading collection' });
    const category = await engine.saveCategory({ projectId: project.id, name: 'Research' });
    await engine.assignMembership({
      recordIds: [source.id],
      projectId: project.id,
      categoryId: category.id,
    });
    const expected = { url: source.url, navigationVersion: source.navigationVersion };
    const duplicate = await engine.tabCommand({ id: source.id, command: 'duplicate', expected });
    expect(duplicate.status).toBe('complete');
    expect(await database.memberships.get(duplicate.tabCommand!.created!.recordId!)).toMatchObject({
      projectId: project.id,
      categoryId: category.id,
      source: 'owner',
    });
    const created = await engine.tabCommand({ id: source.id, command: 'new', expected });
    expect(created.status).toBe('complete');
    const tabId = created.tabCommand!.created!.tabId;
    const tab = tabs.get(tabId)!;
    const blank = (await engine.state()).records.find((record) => record.tabId === tabId)!;
    expect(blank).toMatchObject({
      id: created.tabCommand!.created!.recordId,
      nativeNewTab: true,
      url: tab.url,
      parentRecordId: parent.id,
      live: true,
      suspended: false,
    });
    expect(await database.memberships.get(blank.id)).toMatchObject({
      projectId: project.id,
      categoryId: category.id,
      source: 'owner',
    });
    const blankCopy = await engine.tabCommand({
      id: blank.id,
      command: 'duplicate',
      expected: { url: blank.url, navigationVersion: blank.navigationVersion },
    });
    expect(
      (await engine.state()).records.find(
        (record) => record.id === blankCopy.tabCommand!.created!.recordId,
      ),
    ).toMatchObject({ nativeNewTab: true, live: true, parentRecordId: parent.id });
    expect(await database.memberships.get(blankCopy.tabCommand!.created!.recordId!)).toMatchObject({
      projectId: project.id,
      categoryId: category.id,
    });
    tab.pendingUrl = 'https://example.test/new-research';
    await engine.reconcile();
    expect((await engine.state()).records.find((record) => record.id === blank.id)).toMatchObject({
      live: true,
      url: tab.pendingUrl,
      navigationVersion: blank.navigationVersion + 1,
    });
    tab.url = tab.pendingUrl;
    tab.pendingUrl = undefined;
    await engine.reconcile();
    const record = (await engine.state()).records.find((item) => item.tabId === tabId)!;
    expect(record.id).toBe(blank.id);
    expect(record.nativeNewTab).toBeUndefined();
    expect(record.parentRecordId).toBe(parent.id);
    expect(record.navigationVersion).toBe(blank.navigationVersion + 1);
    expect(await database.memberships.get(record.id)).toMatchObject({
      projectId: project.id,
      categoryId: category.id,
      source: 'owner',
    });
    await expect(engine.undoOperation(created.id)).rejects.toThrow('changed');
    expect(tabs.has(tabId)).toBe(true);
  });
  it('never adopts unrelated browser new tabs or internal pages and retains edited blank tabs on Undo', async () => {
    const source = (await engine.state()).records.find((record) => record.tabId === 11)!;
    addTab(90, 1, 'chrome://newtab/');
    addTab(91, 1, 'chrome://settings/');
    const operation = await engine.tabCommand({
      id: source.id,
      command: 'new',
      expected: { url: source.url, navigationVersion: source.navigationVersion },
    });
    const created = operation.tabCommand!.created!;
    const state = await engine.state();
    expect(state.records.some((record) => record.tabId === 90 || record.tabId === 91)).toBe(false);
    expect(state.records.find((record) => record.id === created.recordId)?.nativeNewTab).toBe(true);
    await engine.updateRecord(created.recordId!, { note: 'Keep this new tab' });
    await expect(engine.undoOperation(operation.id)).rejects.toThrow('changed');
    expect(tabs.has(created.tabId)).toBe(true);
    const untouched = await engine.tabCommand({
      id: source.id,
      command: 'new',
      expected: { url: source.url, navigationVersion: source.navigationVersion },
    });
    expect((await engine.undoOperation(untouched.id)).every((result) => result.ok)).toBe(true);
    expect(tabs.has(untouched.tabCommand!.created!.tabId)).toBe(false);
  });
  it('exports marked new tabs and restores them as native blanks without widening internal-page imports', async () => {
    const source = (await engine.state()).records.find((record) => record.tabId === 11)!;
    const operation = await engine.tabCommand({
      id: source.id,
      command: 'new',
      expected: { url: source.url, navigationVersion: source.navigationVersion },
    });
    const created = operation.tabCommand!.created!;
    const saved = await engine.snapshot('New tab fixture');
    const portable = await engine.exportBackup();
    expect(
      importSnapshot(portable).snapshots.flatMap((s) => s.windows.flatMap((w) => w.tabs)),
    ).toContainEqual(expect.objectContaining({ recordId: created.recordId, nativeNewTab: true }));
    const assistant = assistantPortableSchema.parse(portable.assistant);
    expect(assistant.records.find((record) => record.id === created.recordId)).toMatchObject({
      url: 'chrome://newtab/',
      nativeNewTab: true,
    });
    const malformed = structuredClone(portable);
    const tab = malformed.snapshots
      .flatMap((s) => s.windows.flatMap((w) => w.tabs))
      .find((record) => record.recordId === created.recordId)!;
    tab.url = 'chrome://settings/';
    expect(() => importSnapshot(malformed)).toThrow();
    tab.url = 'chrome://newtab/';
    delete tab.nativeNewTab;
    expect(() => importSnapshot(malformed)).toThrow();
    expect(() =>
      assistantPortableSchema.parse({
        ...assistant,
        records: assistant.records.map((record) =>
          record.id === created.recordId ? { ...record, url: 'chrome://settings/' } : record,
        ),
      }),
    ).toThrow();
    tabs.delete(created.tabId);
    await engine.reconcile();
    expect(
      (
        await engine.restoreSnapshot(saved.id, {
          onlyMissing: true,
          onlyRecordIds: [created.recordId!],
        })
      ).every((result) => result.ok),
    ).toBe(true);
    const restored = (await engine.state()).records.find(
      (record) => record.id === created.recordId,
    )!;
    expect(restored).toMatchObject({
      nativeNewTab: true,
      suspended: false,
      live: true,
      url: 'chrome://newtab/',
    });
    expect(tabs.get(restored.tabId!)?.url).toBe('chrome://newtab/');
    await engine.importBackup(portable);
    const imported = (await database.snapshots.toArray()).find(
      (snapshot) => snapshot.label === 'Imported: New tab fixture',
    )!;
    const importedBlank = imported.windows
      .flatMap((window) => window.tabs)
      .find((record) => record.nativeNewTab)!;
    expect(importedBlank).toMatchObject({ nativeNewTab: true, url: 'chrome://newtab/' });
    expect(importedBlank.recordId).not.toBe(created.recordId);
    expect(await database.records.get(importedBlank.recordId)).toMatchObject({
      nativeNewTab: true,
      url: 'chrome://newtab/',
      live: false,
    });
  });
  it('bounds snapshot history while protecting running recovery and expiring old arrangement Undo', async () => {
    const base = await engine.snapshot('Retention fixture');
    await database.snapshots.clear();
    await database.snapshots.bulkPut(
      Array.from({ length: 20 }, (_, index) => ({
        ...structuredClone(base),
        id: `retention-${index}`,
        createdAt: index,
      })),
    );
    await database.operations.bulkPut([
      {
        id: 'expired-recovery',
        createdAt: 1,
        snapshotId: 'retention-0',
        summary: 'Old move',
        status: 'complete',
        actions: [],
        results: [],
      },
      {
        id: 'running-recovery',
        createdAt: 2,
        snapshotId: 'retention-1',
        summary: 'Running move',
        status: 'running',
        actions: [],
        results: [],
      },
    ]);
    await engine.pruneSnapshots({ ...DEFAULTS, snapshotRetention: 10 });
    expect(await database.snapshots.count()).toBe(11);
    expect(await database.snapshots.get('retention-0')).toBeUndefined();
    expect(await database.snapshots.get('retention-1')).toBeDefined();
    expect(
      (await engine.state()).operations.find((operation) => operation.id === 'expired-recovery')
        ?.recoveryAvailable,
    ).toBe(false);
    await database.operations.update('running-recovery', { status: 'complete' });
    await engine.pruneSnapshots({ ...DEFAULTS, snapshotRetention: 10 });
    expect(await database.snapshots.count()).toBe(10);
  });
  it('records opener lineage, inherits membership and preserves an explicit detach across polls', async () => {
    const parent = (await engine.state()).records[0]!;
    const project = await engine.project({ name: 'Opener research' }, false);
    const category = await engine.saveCategory({ projectId: project.id, name: 'References' });
    await engine.assignMembership(
      { recordIds: [parent.id], projectId: project.id, categoryId: category.id },
      false,
    );
    const native = await chrome.tabs.create({
      windowId: parent.windowId!,
      url: 'https://example.test/child',
      active: false,
      openerTabId: parent.tabId,
    });
    const child = (await engine.state()).records.find((record) => record.tabId === native.id)!;
    expect(child.parentRecordId).toBe(parent.id);
    expect(child.openerRecordId).toBe(parent.id);
    expect(await database.memberships.get(child.id)).toMatchObject({
      projectId: project.id,
      categoryId: category.id,
      source: 'inherited',
    });
    const edit = { kind: 'tab_parent' as const, recordId: child.id, parentRecordId: null };
    await executeWorkspaceEdit({
      kind: 'workspace_edits',
      summary: 'Detach child',
      edits: [{ edit, before: workspaceEditBaseline(await engine.state(), edit) }],
    });
    expect(
      (await engine.state()).records.find((record) => record.id === child.id)?.parentRecordId,
    ).toBeNull();
    expect((await database.records.get(child.id))?.openerRecordId).toBe(parent.id);
    const backup = await engine.exportBackup();
    await engine.importBackup(backup);
    const imported = (await database.records.toArray()).find(
      (record) => !record.live && record.url === child.url,
    )!;
    expect(imported.parentRecordId).toBeNull();
    expect(imported.openerRecordId).not.toBe(parent.id);
    expect(await database.records.get(imported.openerRecordId!)).toBeDefined();
  });
  it('journals tab branches, preserves native placement and refuses cycles or stale Undo', async () => {
    const records = (await engine.state()).records;
    const parent = records[0]!,
      child = records[1]!;
    const native = JSON.stringify([...tabs.values()]);
    const edit = { kind: 'tab_parent' as const, recordId: child.id, parentRecordId: parent.id };
    const app = await engine.state();
    const change = await executeWorkspaceEdit({
      kind: 'workspace_edits',
      summary: 'Nest a tab',
      edits: [{ edit, before: workspaceEditBaseline(app, edit) }],
    });
    expect((await database.records.get(child.id))?.parentRecordId).toBe(parent.id);
    expect(JSON.stringify([...tabs.values()])).toBe(native);
    const cycle = { kind: 'tab_parent' as const, recordId: parent.id, parentRecordId: child.id };
    const current = await engine.state();
    expect(() => workspaceEditBaseline(current, cycle)).toThrow('cycle');
    expect((await undoAssistantChange(change.id)).status).toBe('undone');
    expect((await database.records.get(child.id))?.parentRecordId).toBeNull();
    await redoAssistantChange(change.id);
    const detached = { ...edit, parentRecordId: null };
    await executeWorkspaceEdit({
      kind: 'workspace_edits',
      summary: 'Detach a tab',
      edits: [{ edit: detached, before: workspaceEditBaseline(await engine.state(), detached) }],
    });
    expect((await undoAssistantChange(change.id)).status).toBe('partial');
    expect((await database.records.get(child.id))?.parentRecordId).toBeNull();
    expect(JSON.stringify([...tabs.values()])).toBe(native);
  });
  it('does not move category members outside attached scope or after protection changes', async () => {
    const records = (await engine.state()).records;
    const source = await engine.project({ name: 'Scoped source' }, false);
    const target = await engine.project({ name: 'Scoped destination' }, false);
    const category = await engine.saveCategory({ projectId: source.id, name: 'Scoped references' });
    await engine.assignMembership(
      {
        recordIds: records.slice(0, 2).map((record) => record.id),
        projectId: source.id,
        categoryId: category.id,
      },
      false,
    );
    const edit = { kind: 'move_category' as const, categoryId: category.id, projectId: target.id };
    const command = {
      kind: 'workspace_edits' as const,
      summary: 'Move category',
      edits: [{ edit, before: workspaceEditBaseline(await engine.state(), edit) }],
    };
    const input = await permissionFixture('Move this category.', { kind: 'command', command });
    await expect(executeAssistantAction({ ...input, mode: 'once' })).rejects.toThrow('scope');
    await engine.updateRecord(records[1]!.id, { locked: true });
    await expect(executeWorkspaceEdit(command)).rejects.toThrow(/protect/i);
    expect((await database.categories.get(category.id))?.projectId).toBe(source.id);
    for (const record of records.slice(0, 2))
      expect((await database.memberships.get(record.id))?.projectId).toBe(source.id);
  });
  it('moves a category with its memberships atomically, restores it on Undo, and retains later references safely', async () => {
    const records = (await engine.state()).records;
    const source = await engine.project({ name: 'Reading source' }, false);
    const target = await engine.project({ name: 'Reading destination' }, false);
    const category = await engine.saveCategory({ projectId: source.id, name: 'Research' });
    await engine.assignMembership(
      { recordIds: [records[0]!.id], projectId: source.id, categoryId: category.id },
      false,
    );
    const edit = { kind: 'move_category' as const, categoryId: category.id, projectId: target.id };
    const before = await engine.state();
    const native = JSON.stringify([...tabs.values()]);
    const change = await executeWorkspaceEdit({
      kind: 'workspace_edits',
      summary: 'Move Research category',
      edits: [{ edit, before: workspaceEditBaseline(before, edit) }],
    });
    expect((await database.categories.get(category.id))?.projectId).toBe(target.id);
    expect((await database.memberships.get(records[0]!.id))?.projectId).toBe(target.id);
    expect(JSON.stringify([...tabs.values()])).toBe(native);
    expect((await undoAssistantChange(change.id)).status).toBe('undone');
    expect((await database.categories.get(category.id))?.projectId).toBe(source.id);
    expect((await database.memberships.get(records[0]!.id))?.projectId).toBe(source.id);
    await redoAssistantChange(change.id);
    await engine.assignMembership(
      { recordIds: [records[1]!.id], projectId: target.id, categoryId: category.id },
      false,
    );
    expect((await undoAssistantChange(change.id)).status).toBe('partial');
    expect((await database.categories.get(category.id))?.projectId).toBe(target.id);
    for (const membership of await database.memberships.toArray())
      if (membership.categoryId === category.id) expect(membership.projectId).toBe(target.id);
  });
  it('requires exact deletion confirmation, blocks active work, and resets local organization without closing pages', async () => {
    const record = (await engine.state()).records[0]!;
    const project = await engine.project({ name: 'Disposable organization' }, false);
    await engine.assignMembership(
      { recordIds: [record.id], projectId: project.id, categoryId: null },
      false,
    );
    await engine.updateRecord(record.id, { tags: ['reading'], note: 'Owner note' });
    const native = JSON.stringify([...tabs.values()]);
    await expect(engine.deleteLocalData({ kind: 'all', confirmation: 'yes' })).rejects.toThrow();
    expect(await database.projects.get(project.id)).toBeDefined();
    await database.operations.put({
      id: 'active-reset-guard',
      createdAt: 1,
      snapshotId: 'unused',
      summary: 'Running work',
      status: 'running',
      actions: [],
      results: [],
    });
    await expect(
      engine.deleteLocalData({ kind: 'organization', confirmation: 'DELETE' }),
    ).rejects.toThrow('Stop active');
    await database.operations.delete('active-reset-guard');
    await engine.deleteLocalData({ kind: 'organization', confirmation: 'DELETE' });
    expect(await database.projects.count()).toBe(0);
    expect((await database.records.get(record.id))?.tags).toEqual([]);
    expect(
      (await engine.state()).memberships.every((membership) => membership.projectId === null),
    ).toBe(true);
    expect(JSON.stringify([...tabs.values()])).toBe(native);
    local.settings = { ...DEFAULTS, aiKey: 'fictional-reset-key' };
    await engine.deleteLocalData({ kind: 'all', confirmation: 'DELETE' });
    expect(local.settings).toBeUndefined();
    expect(await database.projects.count()).toBe(0);
    expect(JSON.stringify([...tabs.values()])).toBe(native);
    expect((await engine.state()).records.length).toBeGreaterThan(0);
  });
  it('retains a duplicate reassigned by its owner or queued for inspection', async () => {
    const record = (await engine.state()).records.find((item) => item.tabId === 11)!;
    const operation = await engine.tabCommand({
      id: record.id,
      command: 'duplicate',
      expected: { url: record.url, navigationVersion: record.navigationVersion },
    });
    const id = operation.tabCommand!.created!.recordId!;
    const project = await engine.project({ name: 'New reference project' });
    await engine.assignMembership({ recordIds: [id], projectId: project.id, categoryId: null });
    await expect(engine.undoOperation(operation.id)).rejects.toThrow('changed');
    expect((await database.records.get(id))?.live).toBe(true);
    const other = await engine.tabCommand({
      id: record.id,
      command: 'duplicate',
      expected: { url: record.url, navigationVersion: record.navigationVersion },
    });
    const inspectedId = other.tabCommand!.created!.recordId!;
    await engine.startInspection([inspectedId]);
    await expect(engine.undoOperation(other.id)).rejects.toThrow('inspection target');
    expect((await database.records.get(inspectedId))?.live).toBe(true);
  });
  it('does not reuse an explicitly undone duplicate identity after session bindings are lost', async () => {
    const record = (await engine.state()).records.find((item) => item.tabId === 11)!;
    const operation = await engine.tabCommand({
      id: record.id,
      command: 'duplicate',
      expected: { url: record.url, navigationVersion: record.navigationVersion },
    });
    const duplicateId = operation.tabCommand!.created!.recordId!;
    await engine.undoOperation(operation.id);
    expect((await database.records.get(duplicateId))?.wasOpen).toBe(false);
    delete session.bindings;
    expect((await engine.state()).records.find((item) => item.tabId === 11)?.id).toBe(record.id);
  });
  it('closes explicitly, restores asleep on Undo, and can Redo the reviewed close', async () => {
    const app = await engine.state();
    const record = app.records.find((item) => item.tabId === 11)!;
    await engine.updateRecord(record.id, {
      tags: ['keep-reference'],
      note: 'Retain this annotation',
    });
    const operation = await engine.tabCommand({
      id: record.id,
      command: 'close',
      expected: { url: record.url, navigationVersion: record.navigationVersion },
    });
    expect(tabs.has(11)).toBe(false);
    expect((await database.records.get(record.id))?.wasOpen).toBe(false);
    const create = chromeMock.tabs.create;
    vi.spyOn(chromeMock.tabs, 'create').mockImplementationOnce(async (options) => {
      const tab = await create(options);
      tab.pendingUrl = tab.url;
      tab.url = 'about:blank';
      return tab;
    });
    expect((await engine.undoOperation(operation.id)).every((item) => item.ok)).toBe(true);
    const restored = (await engine.state()).records.find((item) => item.id === record.id)!;
    expect(restored.live).toBe(true);
    expect(restored.suspended).toBe(true);
    expect(restored.tags).toEqual(['keep-reference']);
    expect(restored.note).toBe('Retain this annotation');
    const redone = await engine.redoOperation(operation.id);
    expect(redone.status).toBe('complete');
    expect((await database.records.get(record.id))?.live).toBe(false);
  });
  it('redos metadata using before-value guards and preserves subsequent edits', async () => {
    const record = (await engine.state()).records.find((item) => item.tabId === 11)!;
    const edit = { kind: 'note' as const, recordId: record.id, note: 'Reviewed reference' };
    const artifact = {
      kind: 'command' as const,
      command: {
        kind: 'workspace_edits' as const,
        summary: 'Reference note',
        edits: [{ edit, before: workspaceEditBaseline(await engine.state(), edit) }],
      },
    };
    const trace = await executeAssistantAction({
      threadId: 'redo-chat',
      messageId: 'redo-message',
      mode: 'once',
      artifact,
    });
    await undoAssistantChange(trace.id);
    expect((await redoAssistantChange(trace.id)).status).toBe('complete');
    expect((await database.records.get(record.id))?.note).toBe('Reviewed reference');
    await undoAssistantChange(trace.id);
    await database.records.update(record.id, { note: 'New owner note' });
    const retained = await redoAssistantChange(trace.id);
    expect(retained.status).toBe('partial');
    expect((await database.records.get(record.id))?.note).toBe('New owner note');
  });
  it('enforces scoped saved approvals, executes once, and preserves later manual values on Undo', async () => {
    let app = await engine.state();
    const record = app.records.find((item) => item.tabId === 11)!;
    const build = async (
      messageId: string,
      mode: 'once' | 'chat' | 'automatic',
      threadId = 'chat-one',
    ) => {
      app = await engine.state();
      const edits: WorkspaceEdit[] = [
        { kind: 'tags', recordId: record.id, mode: 'add', tags: ['reference'] },
        { kind: 'note', recordId: record.id, note: 'Read methods' },
      ];
      return {
        messageId,
        threadId,
        mode,
        artifact: {
          kind: 'command' as const,
          command: {
            kind: 'workspace_edits' as const,
            summary: 'Reference metadata',
            edits: edits.map((edit) => ({ edit, before: workspaceEditBaseline(app, edit) })),
          },
        },
      };
    };
    await expect(executeAssistantAction(await build('not-approved', 'automatic'))).rejects.toThrow(
      'Approval is required',
    );
    const input = await build('approved', 'chat');
    const trace = await executeAssistantAction(input);
    expect(trace.deltas).toHaveLength(2);
    expect((await executeAssistantAction(input)).id).toBe(trace.id);
    expect(await database.assistantChanges.count()).toBe(1);
    await expect(
      executeAssistantAction(await build('other-chat', 'automatic', 'chat-two')),
    ).rejects.toThrow('Approval is required');
    await engine.updateRecord(record.id, { tags: ['manual'] });
    const undone = await undoAssistantChange(trace.id);
    expect(undone.status).toBe('partial');
    expect((await database.records.get(record.id))?.tags).toEqual(['manual']);
    expect((await database.records.get(record.id))?.note).toBe('');
    await revokeApprovals('chat-one');
    await expect(executeAssistantAction(await build('revoked', 'automatic'))).rejects.toThrow(
      'Approval is required',
    );
  });
  it('journals generated project IDs atomically and keeps a project that gained later references', async () => {
    await engine.state();
    const trace = await executeAssistantAction({
      threadId: 'chat',
      messageId: 'create',
      mode: 'always',
      artifact: {
        kind: 'project',
        project: { name: 'Research desk', purpose: 'Reference work', areaId: null },
      },
    });
    expect(trace.projectId).toBeTruthy();
    expect(trace.deltas.some((item) => item.table === 'projects' && item.before === null)).toBe(
      true,
    );
    await engine.saveWorkItem({ title: 'Read sources', projectId: trace.projectId });
    const retained = await undoAssistantChange(trace.id);
    expect(retained.status).toBe('partial');
    expect(await database.projects.get(trace.projectId!)).toBeTruthy();
    const empty = await executeAssistantAction({
      threadId: 'other',
      messageId: 'another',
      mode: 'once',
      artifact: { kind: 'project', project: { name: 'Empty desk', purpose: '', areaId: null } },
    });
    expect((await undoAssistantChange(empty.id)).status).toBe('undone');
    expect(await database.projects.get(empty.projectId!)).toBeUndefined();
    await database.assistantChanges.put({ ...empty, id: 'interrupted-trace', status: 'running' });
    await interruptAssistantActions();
    expect((await database.assistantChanges.get('interrupted-trace'))?.status).toBe('interrupted');
  });
  it('rolls back both metadata and its journal when a reviewed batch fails', async () => {
    const project = await engine.project({ name: 'Sources' });
    await engine.saveCategory({ projectId: project.id, name: 'References' });
    const app = await engine.state();
    const record = app.records.find((item) => item.tabId === 11)!;
    const edits: WorkspaceEdit[] = [
      { kind: 'note', recordId: record.id, note: 'Must not persist' },
      {
        kind: 'category',
        projectId: project.id,
        categoryId: null,
        name: 'References',
        description: '',
        color: 'grey',
      },
    ];
    await expect(
      executeAssistantAction({
        threadId: 'chat',
        messageId: 'invalid',
        mode: 'once',
        artifact: {
          kind: 'command',
          command: {
            kind: 'workspace_edits',
            summary: 'Invalid creation',
            edits: edits.map((edit) => ({ edit, before: workspaceEditBaseline(app, edit) })),
          },
        },
      }),
    ).rejects.toThrow('already has a category');
    expect((await database.records.get(record.id))?.note).toBe('');
    const trace = (await database.assistantChanges.toArray())[0]!;
    expect(trace.status).toBe('failed');
    expect(trace.deltas).toEqual([]);
  });
  it('retains a tab changed manually after an assistant browser action', async () => {
    const app = await engine.state();
    const record = app.records.find((item) => item.tabId === 11)!;
    const operation = await engine.applyPlan({
      summary: 'Group source',
      actions: [
        { type: 'group', recordIds: [record.id], windowId: 1, name: 'Sources', color: 'blue' },
      ],
    });
    tabs.get(11)!.pinned = true;
    const results = await engine.undoOperation(operation.id);
    expect(results.some((item) => !item.ok && item.error?.includes('later browser change'))).toBe(
      true,
    );
    expect(tabs.get(11)?.pinned).toBe(true);
  });
  it('records pending native navigation as the sleep result so Undo can restore the page', async () => {
    const app = await engine.state();
    const record = app.records.find((item) => item.tabId === 11)!;
    const update = chromeMock.tabs.update;
    vi.spyOn(chromeMock.tabs, 'update').mockImplementation(async (id, patch) => {
      if (patch.url?.startsWith(origin + '/suspended.html')) {
        const tab = tabs.get(id)!;
        tab.pendingUrl = patch.url;
        return { ...tab };
      }
      return update(id, patch);
    });
    const operation = await engine.applyPlan({
      summary: 'Sleep source',
      actions: [{ type: 'suspend', recordIds: [record.id] }],
    });
    const tab = tabs.get(11)!;
    tab.url = tab.pendingUrl;
    delete tab.pendingUrl;
    expect(operation.postState?.[record.id]?.suspended).toBe(true);
    expect((await engine.undoOperation(operation.id)).every((item) => item.ok)).toBe(true);
    expect(tabs.get(11)?.url).toBe(record.url);
  });
  it('applies reviewed metadata atomically, preserves tags, and refuses stale or protected targets', async () => {
    const project = await engine.project({ name: 'Research', purpose: 'Reference material' });
    const category = await engine.saveCategory({ projectId: project.id, name: 'Sources' });
    let app = await engine.state();
    const record = app.records.find((item) => item.tabId === 11)!;
    await engine.updateRecord(record.id, { tags: ['existing'] });
    app = await engine.state();
    const edits: WorkspaceEdit[] = [
      { kind: 'tags', recordId: record.id, mode: 'add', tags: ['source'] },
      { kind: 'note', recordId: record.id, note: 'Read later' },
      { kind: 'membership', recordId: record.id, projectId: project.id, categoryId: category.id },
      {
        kind: 'project',
        projectId: project.id,
        name: 'Reference desk',
        purpose: 'Curated research',
        areaId: null,
      },
      {
        kind: 'category',
        categoryId: category.id,
        projectId: project.id,
        name: 'Primary sources',
        description: 'Original material',
        color: 'blue',
      },
    ];
    const draft = {
      kind: 'workspace_edits' as const,
      summary: 'Review edits',
      edits: edits.map((edit) => ({ edit, before: workspaceEditBaseline(app, edit) })),
    };
    await engine.applyWorkspaceEdits(draft);
    expect((await database.records.get(record.id))?.tags).toEqual(['existing', 'source']);
    expect((await database.records.get(record.id))?.note).toBe('Read later');
    expect((await database.memberships.get(record.id))?.categoryId).toBe(category.id);
    expect((await database.categories.get(category.id))?.color).toBe('blue');
    await expect(engine.applyWorkspaceEdits(draft)).rejects.toThrow('stale');
    app = await engine.state();
    const note: WorkspaceEdit = { kind: 'note', recordId: record.id, note: 'Must roll back' };
    const duplicate: WorkspaceEdit = {
      kind: 'category',
      categoryId: null,
      projectId: project.id,
      name: 'Primary sources',
      description: '',
      color: 'grey',
    };
    await expect(
      engine.applyWorkspaceEdits({
        kind: 'workspace_edits',
        summary: 'Invalid batch',
        edits: [note, duplicate].map((edit) => ({
          edit,
          before: workspaceEditBaseline(app, edit),
        })),
      }),
    ).rejects.toThrow('already has a category');
    expect((await database.records.get(record.id))?.note).toBe('Read later');
    await engine.updateRecord(record.id, { locked: true });
    await expect(
      engine.applyWorkspaceEdits({
        kind: 'workspace_edits',
        summary: 'Protected',
        edits: [{ edit: note, before: workspaceEditBaseline(app, note) }],
      }),
    ).rejects.toThrow('unprotected');
  });
  it('never bursts a 300-tab wake request and persists a pause before starting more pages', async () => {
    for (let index = 0; index < 300; index++)
      addTab(
        1000 + index,
        1,
        `${origin}/suspended.html#id=wake-${index}&url=${encodeURIComponent(`https://example.test/wake/${index}`)}&title=Page`,
        index + 3,
      );
    const records = (await engine.state()).records.filter((record) => record.tabId! >= 1000);
    expect(records).toHaveLength(300);
    const operation = await engine.applyPlan({
      summary: 'Wake test pages',
      actions: [{ type: 'wake', recordIds: records.map((record) => record.id) }],
    });
    expect(operation.results).toHaveLength(0);
    expect(
      [...tabs.values()].filter((tab) => tab.url?.startsWith('https://example.test/wake/')),
    ).toHaveLength(0);
    const update = vi.spyOn(chromeMock.tabs, 'update').mockImplementation(async (id, patch) => {
      const tab = tabs.get(id)!;
      Object.assign(tab, patch, patch.url ? { status: 'loading' } : {});
      return { ...tab };
    });
    await engine.wakeOperationStep();
    for (let tick = 0; tick < 5; tick++) await engine.wakeOperationStep();
    expect(update).toHaveBeenCalledTimes(1);
    const saved = (await database.operations.get(operation.id))!;
    expect(saved.activeWake).toBeDefined();
    expect((await engine.state()).operations.find((op) => op.id === operation.id)?.status).toBe(
      'running',
    );
    vi.spyOn(Date, 'now').mockReturnValue(saved.activeWake!.startedAt + 31000);
    await engine.wakeOperationStep();
    expect((await database.operations.get(operation.id))?.status).toBe('interrupted');
    await engine.wakeOperationStep();
    expect(update).toHaveBeenCalledTimes(1);
    tabs.get(saved.activeWake!.tabId)!.status = 'complete';
    await engine.controlWakeOperation(operation.id, true);
    await engine.wakeOperationStep();
    expect((await database.operations.get(operation.id))?.results).toHaveLength(1);
    expect(update).toHaveBeenCalledTimes(1);
    await engine.controlWakeOperation(operation.id, false);
    await engine.wakeOperationStep();
    expect(update).toHaveBeenCalledTimes(1);
    await database.records.update(operation.actions[1]!.recordIds[0]!, { locked: true });
    await engine.controlWakeOperation(operation.id, true);
    await engine.wakeOperationStep();
    const protectedResult = (await database.operations.get(operation.id))!;
    expect(protectedResult.status).toBe('interrupted');
    expect(protectedResult.pauseReason).toContain('protected');
    expect(protectedResult.results).toHaveLength(1);
    expect(update).toHaveBeenCalledTimes(1);
  });
  it('persists tag proposals independently, protects completed stages and preserves results across repair branches', async () => {
    const record = (await engine.state()).records[0]!;
    await engine.saveCollectionAnalysis({
      id: 'durable-tags',
      createdAt: 1,
      updatedAt: 1,
      revision: 1,
      purpose: 'proposal',
      instruction: '',
      reuseAcceptedTaxonomyOnly: true,
      decisionContract: 'isolated-evidence-v2',
      scope: [{ id: record.id, url: record.url, navigationVersion: record.navigationVersion }],
      discoveredIds: [record.id],
      classifiedIds: [record.id],
      projects: [],
      summaries: [],
      assignments: [],
      unresolvedRecordIds: [record.id],
      tagVocabulary: ['Reference'],
    });
    const identity = {
      analysisId: 'durable-tags',
      recordId: record.id,
      evidenceKey: await tagEvidenceKey(record),
      catalogKey: await tagHash(['Reference']),
    };
    const row: TagAnalysis = {
      ...identity,
      id: tagResultId(identity),
      contract: 'bounded-tags-v1',
      revision: 1,
      updatedAt: 1,
      url: record.url,
      navigationVersion: record.navigationVersion,
      cursor: 1,
      status: 'proposed',
      proposalModel: 'chat',
      tags: [{ name: 'Reference', source: 'url', quote: 'example.com' }],
      newTags: [],
      uncertain: false,
      decisions: [],
    };
    await engine.saveTagAnalysis(row);
    expect((await engine.getCollectionAnalysis('durable-tags'))?.revision).toBe(1);
    await engine.saveTagAnalysis({ ...row, revision: 2, status: 'complete' });
    await expect(engine.saveTagAnalysis({ ...row, revision: 3 })).rejects.toThrow(
      'rewound or rewritten',
    );
    const fork = await engine.repairCollectionAnalysis('durable-tags', 'tagging');
    expect(await engine.listTagAnalyses(fork.id)).toEqual([]);
    expect((await engine.listTagAnalyses('durable-tags'))[0]?.status).toBe('complete');
    await database.records.update(record.id, { title: 'Different subject' });
    await expect(engine.saveTagAnalysis({ ...row, id: 'forged', revision: 1 })).rejects.toThrow(
      'source changed',
    );
  });
  it('persists explicit failed-batch skips and clears them only in a separate repair branch', async () => {
    const records = (await engine.state()).records;
    const scope = records.map(({ id, url, navigationVersion }) => ({ id, url, navigationVersion }));
    const source = await engine.saveCollectionAnalysis({
      id: 'skip-category',
      createdAt: 1,
      updatedAt: 1,
      revision: 1,
      purpose: 'proposal',
      instruction: '',
      reuseAcceptedTaxonomyOnly: true,
      scope,
      discoveredIds: scope.map((item) => item.id),
      classifiedIds: [],
      projects: [
        {
          name: 'Reading',
          purpose: 'Reference reading',
          areaName: null,
          categories: [{ name: 'References', description: 'Reference material' }],
        },
      ],
      summaries: [],
      assignments: [],
      unresolvedRecordIds: [],
      failedBatch: {
        stage: 'classification',
        recordIds: [records[0]!.id],
        attempts: 6,
        error: 'Malformed model response',
        failedAt: 1,
      },
    });
    const skipped = await engine.saveCollectionAnalysis(skipFailedCollectionBatch(source));
    expect(skipped.skippedRecordIds).toEqual([records[0]!.id]);
    expect(skipped.assignments).toEqual([]);
    expect(skipped.failedBatch).toBeUndefined();
    await expect(
      engine.saveCollectionAnalysis({
        ...skipped,
        revision: skipped.revision + 1,
        skippedRecordIds: [records[1]!.id],
      }),
    ).rejects.toThrow('Only failed');
    const branch = await engine.repairCollectionAnalysis(source.id, 'classification');
    expect(branch.skippedRecordIds).toBeUndefined();
    expect((await engine.getCollectionAnalysis(source.id))?.skippedRecordIds).toEqual([
      records[0]!.id,
    ]);
    const completed = await engine.saveCollectionAnalysis({
      ...skipped,
      revision: skipped.revision + 1,
      classifiedIds: scope.map((item) => item.id),
      unresolvedRecordIds: scope.map((item) => item.id),
      unresolvedTagSuggestions: [
        {
          recordId: records[1]!.id,
          url: records[1]!.url,
          navigationVersion: records[1]!.navigationVersion,
          suggestedTags: ['saved-reference'],
        },
      ],
    });
    const retrySkipped = await engine.repairCollectionAnalysis(source.id, 'skipped');
    expect(retrySkipped.classifiedIds).toEqual(
      completed.classifiedIds.filter((id) => id !== records[0]!.id),
    );
    expect(retrySkipped.unresolvedTagSuggestions).toEqual(completed.unresolvedTagSuggestions);
    expect(retrySkipped.skippedRecordIds).toBeUndefined();
    expect((await engine.getCollectionAnalysis(source.id))?.skippedRecordIds).toEqual([
      records[0]!.id,
    ]);
    const discovery = await engine.saveCollectionAnalysis({
      ...source,
      id: 'skip-discovery',
      projects: [],
      reuseAcceptedTaxonomyOnly: false,
      discoveredIds: [],
      failedBatch: { ...source.failedBatch!, stage: 'discovery' },
    });
    const advanced = await engine.saveCollectionAnalysis(skipFailedCollectionBatch(discovery));
    expect(advanced.discoveredIds).toEqual([records[0]!.id]);
    expect(advanced.classifiedIds).toEqual([]);
    expect(advanced.scope).toEqual(scope);
    expect(advanced.projects).toEqual([]);
  });
  it('commits tag patches and their completion receipt atomically and returns the receipt on replay', async () => {
    const record = (await engine.state()).records[0]!;
    const proposal = await engine.saveCollectionProposal({
      projects: [],
      assignments: [],
      unresolvedRecordIds: [record.id],
      scopeRecordIds: [record.id],
      summary: 'Reading draft',
    });
    const fingerprint = await tagHash(proposal);
    await engine.saveCollectionAnalysis({
      id: 'tag-commit-atomic',
      createdAt: 1,
      updatedAt: 1,
      revision: 1,
      purpose: 'proposal',
      instruction: 'Tag the saved draft',
      reuseAcceptedTaxonomyOnly: true,
      scope: [{ id: record.id, url: record.url, navigationVersion: record.navigationVersion }],
      discoveredIds: [record.id],
      classifiedIds: [record.id],
      projects: [],
      summaries: [],
      assignments: [],
      unresolvedRecordIds: [record.id],
      tagTarget: { proposalId: proposal.id, proposalFingerprint: fingerprint },
    });
    const input = {
      id: proposal.id,
      analysisId: 'tag-commit-atomic',
      expectedFingerprint: fingerprint,
      patches: [
        {
          recordId: record.id,
          url: record.url,
          navigationVersion: record.navigationVersion,
          suggestedTags: ['reading'],
          review: [],
        },
      ],
    };
    const failReceipt = () => {
      throw new Error('Receipt storage unavailable');
    };
    database.collectionAnalyses.hook('updating', failReceipt);
    try {
      await expect(engine.updateCollectionTags(input)).rejects.toThrow(
        'Receipt storage unavailable',
      );
    } finally {
      database.collectionAnalyses.hook('updating').unsubscribe(failReceipt);
    }
    expect(await database.collectionProposals.get(proposal.id)).toEqual(proposal);
    expect((await database.collectionAnalyses.get(input.analysisId))?.tagCommit).toBeUndefined();
    expect(await database.proposalRevisions.where('proposalId').equals(proposal.id).count()).toBe(
      0,
    );
    const saved = await engine.updateCollectionTags(input);
    expect(saved.unresolvedTagSuggestions?.[0]?.suggestedTags).toEqual(['reading']);
    expect((await database.collectionAnalyses.get(input.analysisId))?.tagCommit?.processed).toBe(1);
    expect(await engine.updateCollectionTags(input)).toEqual(saved);
    expect(await database.proposalRevisions.where('proposalId').equals(proposal.id).count()).toBe(
      1,
    );
  });
  it('retains reusable tag vocabulary after its last tab is closed', async () => {
    const record = (await engine.state()).records.find((item) => item.tabId === 11)!;
    await database.records.update(record.id, { tags: ['saved-reference'] });
    tabs.delete(11);
    await engine.closed(11);
    const app = await engine.state();
    expect(app.records.some((item) => item.id === record.id)).toBe(false);
    expect(app.tagVocabulary).toContain('saved-reference');
  });
  it('persists validated faded icons through snapshots and sleeping-copy restoration', async () => {
    const record = (await engine.state()).records.find((item) => item.tabId === 11)!;
    const icon = `data:image/png;base64,${readFileSync(new URL('../public/icons/32.png', import.meta.url)).toString('base64')}`;
    await database.records.update(record.id, { suspendedFavicon: icon });
    const saved = await engine.snapshot('Icon persistence');
    expect(
      saved.windows.flatMap((window) => window.tabs).find((item) => item.recordId === record.id)
        ?.suspendedFavicon,
    ).toBe(icon);
    const outcomes = await engine.restoreSnapshot(saved.id, { newWindows: true });
    const copy = (await engine.state()).records.find(
      (item) => item.id === outcomes.find((item) => item.sourceRecordId === record.id)?.recordId,
    )!;
    expect(await engine.placeholderFavicon(copy.tabId!)).toBe(icon);
    expect(await engine.placeholderFavicon(11, icon)).toBeNull();
    expect(await engine.placeholderFavicon(copy.tabId!, 'data:image/svg+xml,bad')).toBe(icon);
  });
  it('repairs only owned inactive placeholders once and retains navigated pages during repair', async () => {
    const record = (await engine.state()).records.find((item) => item.tabId === 11)!;
    await engine.applyPlan({
      summary: 'Sleep fixture',
      actions: [{ type: 'suspend', recordIds: [record.id] }],
    });
    tabs.get(11)!.active = false;
    tabs.get(11)!.favIconUrl = `${origin}/icons/16.png`;
    const reload = vi.spyOn(chromeMock.tabs, 'reload');
    await engine.repairPlaceholderFavicons();
    await engine.repairPlaceholderFavicons();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledWith(11);
    // A reload request is not proof the icon was repaired: retry after backoff,
    // including a dormant restored placeholder reporting loading while discarded.
    session.faviconRepairs = {
      '11': { url: tabs.get(11)!.url, at: Date.now() - 31_000, count: 1 },
    };
    tabs.get(11)!.discarded = true;
    tabs.get(11)!.status = 'loading';
    tabs.get(11)!.pendingUrl = tabs.get(11)!.url;
    await engine.repairPlaceholderFavicons();
    expect(reload).toHaveBeenCalledTimes(2);
    tabs.get(11)!.discarded = false;
    tabs.get(11)!.status = 'complete';
    delete tabs.get(11)!.pendingUrl;
    delete session.faviconRepairs;
    const get = chromeMock.tabs.get;
    vi.spyOn(chromeMock.tabs, 'get').mockImplementationOnce(async (id) => {
      tabs.get(id)!.url = 'https://example.test/owner-navigation';
      return get(id);
    });
    await engine.repairPlaceholderFavicons();
    expect(reload).toHaveBeenCalledTimes(2);
    expect(tabs.get(11)!.url).toBe('https://example.test/owner-navigation');
  });
  it('adds reviewed tags only on Apply and Undo preserves subsequent owner tag edits', async () => {
    const app = await engine.state();
    const first = app.records[0]!,
      second = app.records[1]!;
    await database.records.update(first.id, { tags: ['owner'] });
    const proposal = await engine.saveCollectionProposal({
      summary: 'Tagged references',
      projects: [
        {
          name: 'Research',
          purpose: 'Read',
          areaName: 'Personal',
          categories: [{ name: 'Docs', description: '' }],
        },
      ],
      assignments: app.records.map((record) => ({
        recordId: record.id,
        url: record.url,
        navigationVersion: record.navigationVersion,
        projectName: 'Research',
        categoryName: 'Docs',
        reason: 'Reference',
        confidence: 0.9,
        suggestedTags: ['reference'],
      })),
      unresolvedRecordIds: [],
    });
    expect((await database.records.get(first.id))!.tags).toEqual(['owner']);
    await engine.applyCollectionProposal(proposal.id);
    expect((await database.records.get(first.id))!.tags).toEqual(['owner', 'reference']);
    await database.records.update(second.id, { tags: ['reference', 'newer-owner-edit'] });
    await engine.undoCollection(proposal.id);
    expect((await database.records.get(first.id))!.tags).toEqual(['owner']);
    expect((await database.records.get(second.id))!.tags).toEqual([
      'reference',
      'newer-owner-edit',
    ]);
  });
  it('applies independent tags to unresolved tabs and undoes them without assigning a project', async () => {
    const app = await engine.state();
    const first = app.records[0]!;
    const proposal = await engine.saveCollectionProposal({
      summary: 'Tags without destinations',
      projects: [],
      assignments: [],
      unresolvedRecordIds: app.records.map((record) => record.id),
      unresolvedTagSuggestions: [
        {
          recordId: first.id,
          url: first.url,
          navigationVersion: first.navigationVersion,
          suggestedTags: ['Vue', 'reference'],
        },
      ],
    });
    expect((await database.records.get(first.id))?.tags).toEqual([]);
    await engine.applyCollectionProposal(proposal.id);
    expect((await database.records.get(first.id))?.tags).toEqual(['Vue', 'reference']);
    expect((await database.memberships.get(first.id))?.projectId).toBeNull();
    await engine.undoCollection(proposal.id);
    expect((await database.records.get(first.id))?.tags).toEqual([]);
  });
  it('retains reviewed tags on scoped project proposals, including uncertain tabs', async () => {
    const app = await engine.state();
    const first = app.records[0]!;
    const project = await engine.project({ name: 'Tag review' });
    const proposal = await engine.saveOrganizationProposal({
      projectId: project.id,
      projectRevision: project.revision,
      summary: 'Independent labels',
      categories: [],
      assignments: [],
      unresolvedRecordIds: [first.id],
      unresolvedTagSuggestions: [
        {
          recordId: first.id,
          url: first.url,
          navigationVersion: first.navigationVersion,
          suggestedTags: ['reference'],
        },
      ],
    });
    expect((await database.records.get(first.id))?.tags).toEqual([]);
    await engine.applyOrganizationProposal(proposal.id);
    expect((await database.records.get(first.id))?.tags).toEqual(['reference']);
    expect((await database.memberships.get(first.id))?.projectId).not.toBe(project.id);
  });
  it('rejects native split placement and retains split pairs during recovery', async () => {
    tabs.get(11)!.splitViewId = 7;
    tabs.get(12)!.splitViewId = 7;
    const record = (await engine.state()).records.find((item) => item.tabId === 11)!;
    expect(record.splitViewId).toBe(7);
    await expect(
      engine.applyPlan({
        summary: 'Move',
        actions: [{ type: 'move', recordIds: [record.id], windowId: 2 }],
      }),
    ).rejects.toThrow('native split');
    const snapshot = await engine.snapshot('Split retained');
    const result = await engine.restoreSnapshot(snapshot.id);
    expect(result.some((outcome) => outcome.error?.includes('Native split retained'))).toBe(true);
    expect(tabs.get(11)!.splitViewId).toBe(7);
    expect(tabs.get(12)!.splitViewId).toBe(7);
    expect(
      moves.some((move) => (Array.isArray(move.ids) ? move.ids : [move.ids]).includes(11)),
    ).toBe(false);
  });
  it('checks fresh split state after the snapshot and journals the rejected action', async () => {
    const record = (await engine.state()).records.find((item) => item.tabId === 11)!;
    const original = chromeMock.tabs.get;
    const get = vi.spyOn(chromeMock.tabs, 'get');
    get.mockImplementationOnce((id) => {
      tabs.get(11)!.splitViewId = 9;
      tabs.get(12)!.splitViewId = 9;
      return original(id);
    });
    const result = await engine.applyPlan({
      summary: 'Move',
      actions: [{ type: 'move', recordIds: [record.id], windowId: 2 }],
    });
    expect(result.status).toBe('partial');
    expect(result.results[0]?.error).toContain('native split');
    expect(tabs.get(11)!.windowId).toBe(1);
  });
  it('moves a complete native group with metadata intact and rejects newly added members', async () => {
    const groupId = await chromeMock.tabs.group({
      createProperties: { windowId: 1 },
      tabIds: [11, 12],
    });
    await chromeMock.tabGroups.update(groupId, { title: 'Work', color: 'purple', collapsed: true });
    const members = (await engine.state()).records.filter((record) => record.groupId === groupId);
    await expect(
      engine.applyPlan({
        summary: 'Incomplete group',
        actions: [
          { type: 'moveGroup', nativeGroupId: groupId, recordIds: [members[0]!.id], windowId: 2 },
        ],
      }),
    ).rejects.toThrow('membership changed');
    const result = await engine.applyPlan({
      summary: 'Whole group',
      actions: [
        {
          type: 'moveGroup',
          nativeGroupId: groupId,
          recordIds: members.map((record) => record.id),
          windowId: 2,
        },
      ],
    });
    expect(result.status).toBe('complete');
    expect(groups.get(groupId)).toMatchObject({
      title: 'Work',
      color: 'purple',
      collapsed: true,
      windowId: 2,
    });
    expect(tabs.get(11)!.windowId).toBe(2);
    expect(tabs.get(12)!.windowId).toBe(2);
    expect(await database.snapshots.get(result.snapshotId)).toBeDefined();
  });
  it('targets exact same-name groups without recoloring or merging the wrong group', async () => {
    const first = await chromeMock.tabs.group({ createProperties: { windowId: 1 }, tabIds: [12] });
    const second = await chromeMock.tabs.group({ createProperties: { windowId: 1 }, tabIds: [] });
    await chromeMock.tabGroups.update(first, { title: 'Work', color: 'purple' });
    await chromeMock.tabGroups.update(second, { title: 'Work', color: 'red' });
    const record = (await engine.state()).records.find((item) => item.tabId === 11)!;
    const rejected = await engine.applyPlan({
      summary: 'Ambiguous group',
      actions: [{ type: 'group', recordIds: [record.id], windowId: 1, name: 'Work' }],
    });
    expect(rejected.status).toBe('partial');
    expect(tabs.get(11)!.groupId).toBe(-1);
    const applied = await engine.applyPlan({
      summary: 'Exact group',
      actions: [
        {
          type: 'group',
          recordIds: [record.id],
          windowId: 1,
          nativeGroupId: second,
          name: 'Work',
          color: 'blue',
        },
      ],
    });
    expect(applied.status).toBe('complete');
    expect(tabs.get(11)!.groupId).toBe(second);
    expect(groups.get(first)!.color).toBe('purple');
    expect(groups.get(second)!.color).toBe('red');
  });
  it('journals explicit pin/mute changes without waking pages and rejects protected targets', async () => {
    const app = await engine.state();
    const record = app.records.find((item) => item.tabId === 11)!;
    const beforeUrl = tabs.get(11)!.url;
    const operation = await engine.applyPlan({
      summary: 'Pin and mute',
      actions: [
        { type: 'pin', recordIds: [record.id], enabled: true },
        { type: 'mute', recordIds: [record.id], enabled: true },
      ],
    });
    expect(operation.status).toBe('complete');
    expect(tabs.get(11)!.pinned).toBe(true);
    expect(tabs.get(11)!.mutedInfo?.muted).toBe(true);
    expect(tabs.get(11)!.url).toBe(beforeUrl);
    expect(
      (await database.snapshots.get(operation.snapshotId))!.windows
        .flatMap((window) => window.tabs)
        .find((item) => item.recordId === record.id)?.pinned,
    ).toBe(false);
    await database.records.update(record.id, { locked: true });
    await expect(
      engine.applyPlan({
        summary: 'Unpin',
        actions: [{ type: 'pin', recordIds: [record.id], enabled: false }],
      }),
    ).rejects.toThrow('Protected');
    await expect(
      engine.assignMembership({ recordIds: [record.id], projectId: null, categoryId: null }),
    ).rejects.toThrow('protection');
    expect(tabs.get(11)!.pinned).toBe(true);
  });
  it('restores explicit mute state from the operation snapshot without waking the tab', async () => {
    const record = (await engine.state()).records.find((item) => item.tabId === 11)!;
    const url = tabs.get(11)!.url;
    const operation = await engine.applyPlan({
      summary: 'Mute',
      actions: [{ type: 'mute', recordIds: [record.id], enabled: true }],
    });
    await engine.undoOperation(operation.id);
    expect(tabs.get(11)!.mutedInfo?.muted).toBe(false);
    expect(tabs.get(11)!.url).toBe(url);
  });
  it('journals each pin occurrence when a later native update fails', async () => {
    const records = (await engine.state()).records
      .filter((item) => item.windowId === 1)
      .sort((a, b) => a.index - b.index);
    const update = chromeMock.tabs.update;
    vi.spyOn(chromeMock.tabs, 'update').mockImplementation(async (id, patch) => {
      if (id === 12) throw new Error('Native update refused');
      return update(id, patch);
    });
    const result = await engine.applyPlan({
      summary: 'Pin selection',
      actions: [{ type: 'pin', recordIds: records.map((record) => record.id), enabled: true }],
    });
    expect(result.status).toBe('partial');
    expect(result.results.map((item) => item.ok)).toEqual([true, false]);
    expect(tabs.get(11)!.pinned).toBe(true);
    expect(tabs.get(12)!.pinned).toBe(false);
    expect(result.results[1]?.error).toBe('Native update refused');
  });
  it('restores copied tab branches with remapped parents while retaining original identities', async () => {
    const records = (await engine.state()).records;
    const parent = records[0]!,
      child = records[1]!;
    await database.records.update(parent.id, { branchName: 'Saved research' });
    await database.records.update(child.id, {
      parentRecordId: parent.id,
      openerRecordId: parent.id,
    });
    const saved = await engine.snapshot('Nested source');
    const outcomes = await engine.restoreSnapshot(saved.id, { newWindows: true });
    expect(outcomes.every((item) => item.ok)).toBe(true);
    const copiedParent = outcomes.find((item) => item.sourceRecordId === parent.id)!.recordId!;
    const copiedChild = outcomes.find((item) => item.sourceRecordId === child.id)!.recordId!;
    expect(copiedParent).not.toBe(parent.id);
    expect(copiedChild).not.toBe(child.id);
    expect(await database.records.get(copiedChild)).toMatchObject({
      parentRecordId: copiedParent,
      openerRecordId: copiedParent,
    });
    expect(await database.records.get(copiedParent)).toMatchObject({
      branchName: 'Saved research',
    });
    expect(await database.records.get(child.id)).toMatchObject({
      parentRecordId: parent.id,
      live: true,
    });
  });
  it('retains muted state when restoring a snapshot into new sleeping copies', async () => {
    tabs.get(11)!.mutedInfo = { muted: true };
    const before = await engine.snapshot('Muted source');
    const restored = await engine.restoreSnapshot(before.id, { newWindows: true });
    expect(restored.every((item) => item.ok)).toBe(true);
    const copy = [...tabs.values()].find(
      (tab) => tab.id !== 11 && tab.url?.includes(encodeURIComponent('https://example.com/one')),
    );
    expect(copy?.mutedInfo?.muted).toBe(true);
    expect(tabs.get(11)!.url).toBe('https://example.com/one');
  });
  it('saves newly observed duplicate occurrences without waiting for a ten-minute checkpoint', async () => {
    await engine.state();
    const first = await getStoredEntity('sessions', 'current');
    await engine.state();
    expect((await getStoredEntity('sessions', 'current'))?.snapshot.id).toBe(first?.snapshot.id);
    addTab(14, 2, 'https://example.com/three', 1);
    await engine.state();
    const current = await getStoredEntity('sessions', 'current');
    const duplicates = current!.snapshot.windows
      .flatMap((window) => window.tabs)
      .filter((tab) => tab.url.endsWith('/three'));
    expect(new Set(duplicates.map((tab) => tab.recordId)).size).toBe(2);
    expect((await engine.state()).session?.tabCount).toBe(4);
  });
  it('matches a surviving awake duplicate before a lost sleeping duplicate after session bindings clear', async () => {
    const url = 'https://example.com/duplicate';
    tabs.get(11)!.url = url;
    tabs.get(12)!.url =
      `${origin}/suspended.html#id=a-sleep&url=${encodeURIComponent(url)}&title=Sleeping`;
    await database.records.put({ ...newRecord(url, 'b-awake'), wasOpen: true });
    await engine.saveSession();
    tabs.delete(12);
    delete session.bindings;
    await engine.preserveSession();
    const app = await engine.state();
    expect(app.records.find((record) => record.tabId === 11)?.id).toBe('b-awake');
    expect(app.session?.missingTabs).toBe(1);
    const outcomes = await engine.resumeSession();
    expect(outcomes[0]?.recordId).toBe('a-sleep');
    expect((await engine.state()).records.find((record) => record.id === 'b-awake')?.tabId).toBe(
      11,
    );
  });
  it('retains the complete session before empty startup reconciliation and repeated worker boots', async () => {
    await engine.state();
    tabs.clear();
    await engine.preserveSession();
    expect((await engine.state()).session?.missingTabs).toBe(3);
    await engine.preserveSession();
    expect((await engine.state()).session?.tabCount).toBe(3);
    expect(
      (await engine.exportBackup()).snapshots.some(
        (saved) => saved.windows.reduce((count, window) => count + window.tabs.length, 0) === 3,
      ),
    ).toBe(true);
    expect(tabs.size).toBe(0);
    const outcomes = await engine.resumeSession();
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(3);
    expect(
      [...tabs.values()].filter((tab) => tab.url?.startsWith(`${origin}/suspended.html`)),
    ).toHaveLength(3);
    expect(await engine.resumeSession()).toEqual([]);
  });
  it('keeps later work in remaining windows alongside the earlier closed-window recovery', async () => {
    await engine.state();
    await engine.preserveSession();
    tabs.delete(13);
    await engine.state();
    addTab(14, 1, 'https://example.com/latest-work', 2);
    await engine.state();
    tabs.clear();
    await engine.preserveSession();
    expect((await engine.state()).session?.tabCount).toBe(4);
    const outcomes = await engine.resumeSession();
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(4);
    expect(
      (await engine.state()).records.some((record) => record.url.endsWith('/latest-work')),
    ).toBe(true);
  });
  it('resumes only missing tabs without moving, waking, or overwriting survivors and group edits', async () => {
    const app = await engine.state();
    await engine.applyPlan({
      summary: 'Group',
      actions: [
        {
          type: 'group',
          recordIds: app.records
            .filter((record) => record.windowId === 1)
            .map((record) => record.id),
          windowId: 1,
          name: 'Original',
        },
      ],
    });
    await engine.saveSession();
    tabs.delete(11);
    tabs.get(12)!.url = 'https://example.com/owner-new-page';
    const group = [...groups.values()][0]!;
    group.title = 'Owner renamed';
    group.collapsed = true;
    const before = { ...tabs.get(12)! };
    const outcomes = await engine.resumeSession();
    expect(outcomes).toHaveLength(1);
    expect(tabs.get(12)).toEqual(before);
    expect(groups.get(group.id)?.title).toBe('Owner renamed');
    expect(groups.get(group.id)?.collapsed).toBe(true);
    expect([...tabs.values()].find((tab) => tab.id !== 12 && tab.windowId === 1)?.groupId).toBe(
      group.id,
    );
    expect((await engine.state()).session?.missingTabs).toBe(0);
  });
  it('keeps a neutral active slot when restoring a window made entirely of collapsed groups', async () => {
    const app = await engine.state();
    const ids = app.records.filter((record) => record.windowId === 1).map((record) => record.id);
    await engine.applyPlan({
      summary: 'Group',
      actions: [{ type: 'group', recordIds: ids, windowId: 1, name: 'Collapsed work' }],
    });
    [...groups.values()][0]!.collapsed = true;
    await engine.saveSession();
    tabs.delete(11);
    tabs.delete(12);
    await engine.resumeSession();
    const restored = (await engine.state()).records.filter((record) => ids.includes(record.id));
    const windowId = restored[0]!.windowId;
    expect(restored).toHaveLength(2);
    expect(
      [...tabs.values()].some((tab) => tab.windowId === windowId && tab.url === 'chrome://newtab/'),
    ).toBe(true);
    expect(
      [...groups.values()].some(
        (group) =>
          group.windowId === windowId && group.title === 'Collapsed work' && group.collapsed,
      ),
    ).toBe(true);
  });
  it('records partial recovery and explicitly retries only missing identities', async () => {
    await engine.saveSession();
    tabs.delete(11);
    tabs.delete(12);
    const create = chromeMock.tabs.create;
    vi.spyOn(chromeMock.tabs, 'create')
      .mockImplementationOnce(async () => {
        throw new Error('Creation failed');
      })
      .mockImplementation(create);
    const first = await engine.resumeSession();
    expect(first.filter((outcome) => !outcome.ok)).toHaveLength(1);
    expect(
      (await engine.state()).operations.find((operation) => operation.kind === 'session-resume')
        ?.status,
    ).toBe('partial');
    expect((await engine.state()).session?.missingTabs).toBe(1);
    expect(await engine.resumeSession()).toHaveLength(1);
    expect(await engine.resumeSession()).toHaveLength(0);
  });
  it('parks only own pages and restores their exact native slots once', async () => {
    const app = await engine.state();
    await engine.applyPlan({
      summary: 'Sleep',
      actions: [
        { type: 'suspend', recordIds: [app.records.find((record) => record.tabId === 11)!.id] },
      ],
    });
    addTab(14, 1, `${origin}/dashboard.html#timeline`, 3);
    const before = [...tabs.values()].map((tab) => ({ ...tab }));
    await engine.prepareSessionReload();
    expect(tabs.get(11)?.url).toMatch(/^chrome:\/\/version\/#tabflow-update=/);
    expect(tabs.get(14)?.url).toMatch(/^chrome:\/\/version\/#tabflow-update=/);
    expect(tabs.get(12)?.url).toBe(before.find((tab) => tab.id === 12)?.url);
    expect((await engine.state()).session?.missingTabs).toBe(0);
    expect(await engine.finishSessionReload(true)).toBe(true);
    expect(local.sessionReload).toBeUndefined();
    expect([...tabs.values()]).toEqual(before);
    expect((await engine.state()).session?.missingTabs).toBe(0);
    expect(await engine.finishSessionReload()).toBe(false);
    expect(await engine.resumeSession()).toHaveLength(0);
  });
  it('prepares and restores 608 exact app slots in bounded batches with one restore inventory read', async () => {
    for (let index = 0; index < 608; index++)
      addTab(
        1000 + index,
        index < 304 ? 1 : 2,
        `${origin}/suspended.html#id=large-${index}&url=https%3A%2F%2Fexample.test%2Fsame`,
      );
    const original = [...tabs.values()].map((tab) => ({ ...tab }));
    const nativeUpdate = chromeMock.tabs.update;
    let running = 0;
    let peak = 0;
    vi.spyOn(chromeMock.tabs, 'update').mockImplementation(async (id, patch) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 1));
      try {
        return await nativeUpdate(id, patch);
      } finally {
        running--;
      }
    });
    const { parkUpdate, finishUpdate, updateTicket } = await import('../src/core/update-parking');
    const query = vi.spyOn(chromeMock.tabs, 'query');
    await parkUpdate('large-snapshot', []);
    expect((await updateTicket())?.parked).toHaveLength(608);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(8);
    const beforeRestoreQueries = query.mock.calls.length;
    expect(await finishUpdate(true)).toBe(true);
    expect(query.mock.calls.length - beforeRestoreQueries).toBe(1);
    expect(local.sessionReload).toBeUndefined();
    expect(local.updateCompletion).toMatchObject({ total: 608, restored: 608, retained: 0 });
    expect([...tabs.values()]).toEqual(original);
  });
  it('retains failed update receipts and waits for explicit retry after interruption or expiry', async () => {
    const app = await engine.state();
    await engine.applyPlan({
      summary: 'Sleep',
      actions: [
        { type: 'suspend', recordIds: [app.records.find((record) => record.tabId === 11)!.id] },
      ],
    });
    await engine.prepareSessionReload();
    vi.spyOn(chromeMock.tabs, 'update').mockRejectedValueOnce(new Error('Failed'));
    expect(await engine.finishSessionReload(true)).toBe(true);
    expect((await engine.state()).update).toMatchObject({ remaining: 1, interrupted: true });
    expect(await engine.finishSessionReload(true)).toBe(false);
    await expect(engine.resumeSession()).rejects.toThrow('Finish');
    expect(await engine.finishSessionReload()).toBe(true);
    expect(local.sessionReload).toBeUndefined();
    await engine.prepareSessionReload();
    const { updateTicket } = await import('../src/core/update-parking');
    const ticket = (await updateTicket())!;
    ticket.requestedAt = Date.now() - 120_001;
    local.sessionReload = ticket;
    expect(await engine.finishSessionReload(true)).toBe(false);
    expect(tabs.get(11)?.url).toMatch(/^chrome:\/\/version\//);
    expect(await engine.finishSessionReload()).toBe(true);
  });
  it('retains owner navigation and preserves the current position of a moved parked tab', async () => {
    const app = await engine.state();
    await engine.applyPlan({
      summary: 'Sleep',
      actions: [
        {
          type: 'suspend',
          recordIds: app.records
            .filter((record) => [11, 12].includes(record.tabId!))
            .map((record) => record.id),
        },
      ],
    });
    const original = tabs.get(12)?.url;
    await engine.prepareSessionReload();
    Object.assign(tabs.get(11)!, { url: 'https://owner.test/new' });
    Object.assign(tabs.get(12)!, { windowId: 2, groupId: 88, index: 9, pinned: true });
    await engine.finishSessionReload(true);
    expect(tabs.get(11)?.url).toBe('https://owner.test/new');
    expect(tabs.get(12)).toMatchObject({
      url: original,
      windowId: 2,
      groupId: 88,
      index: 9,
      pinned: true,
    });
  });
  it('aborts reload and rolls back committed slots when parking fails', async () => {
    const app = await engine.state();
    await engine.applyPlan({
      summary: 'Sleep',
      actions: [
        {
          type: 'suspend',
          recordIds: app.records
            .filter((record) => [11, 12].includes(record.tabId!))
            .map((record) => record.id),
        },
      ],
    });
    const before = [...tabs.values()].map((tab) => ({ ...tab }));
    const realUpdate = chromeMock.tabs.update;
    vi.spyOn(chromeMock.tabs, 'update').mockImplementation(async (id, patch) => {
      if (id === 12 && patch.url?.startsWith('chrome://version/'))
        throw new Error('Parking denied');
      return realUpdate(id, patch);
    });
    await expect(engine.prepareSessionReload()).rejects.toThrow('Parking denied');
    expect([...tabs.values()]).toEqual(before);
    expect(local.sessionReload).toBeUndefined();
  });
  it('does not trust forged parking destinations or ambiguous copied markers', async () => {
    const app = await engine.state();
    await engine.applyPlan({
      summary: 'Sleep',
      actions: [{ type: 'suspend', recordIds: [app.records[0]!.id] }],
    });
    await engine.prepareSessionReload();
    const { updateTicket } = await import('../src/core/update-parking');
    const ticket = (await updateTicket())!;
    addTab(16, 1, ticket.parked[0]!.marker);
    expect(await engine.finishSessionReload(true)).toBe(true);
    expect((await engine.state()).update?.remaining).toBe(1);
    ticket.parked[0]!.url = 'https://untrusted.test/';
    local.sessionReload = ticket;
    expect(await engine.finishSessionReload()).toBe(false);
    expect(tabs.get(16)?.url).toBe(ticket.parked[0]!.marker);
  });
  it('honors the previous installed buildâ€™s one-time recovery ticket without claiming slot preservation', async () => {
    await engine.saveSession();
    const saved = (await database.sessions.get('current'))!.snapshot;
    local.sessionReload = {
      snapshotId: saved.id,
      requestedAt: Date.now(),
      recordIds: saved.windows.flatMap((window) => window.tabs.map((tab) => tab.recordId)),
    };
    tabs.delete(11);
    expect(await engine.finishSessionReload(false)).toBe(false);
    expect(await engine.finishSessionReload(true)).toBe(true);
    expect(local.sessionReload).toBeUndefined();
    expect((await engine.state()).session?.missingTabs).toBe(0);
    expect(await engine.finishSessionReload(true)).toBe(false);
  });
  it('waits for browser URL commitment and rejects unplanned newly opened TabFlow pages', async () => {
    const app = await engine.state();
    await engine.applyPlan({
      summary: 'Sleep',
      actions: [{ type: 'suspend', recordIds: [app.records[0]!.id] }],
    });
    const before = tabs.get(11)?.url;
    const realUpdate = chromeMock.tabs.update;
    vi.spyOn(chromeMock.tabs, 'update').mockImplementation(async (id, patch) => {
      if (patch.url?.startsWith('chrome://version/')) {
        setTimeout(() => {
          Object.assign(tabs.get(id)!, patch);
          addTab(16, 1, `${origin}/dashboard.html#tabs`);
        }, 25);
        return { ...tabs.get(id)! };
      }
      return realUpdate(id, patch);
    });
    await expect(engine.prepareSessionReload()).rejects.toThrow('Another TabFlow page');
    expect(tabs.get(11)?.url).toBe(before);
    expect(tabs.get(16)?.url).toBe(`${origin}/dashboard.html#tabs`);
  });
  it('matches browser-rewritten internal schemes and pauses an update across browser startup', async () => {
    const app = await engine.state();
    await engine.applyPlan({
      summary: 'Sleep',
      actions: [{ type: 'suspend', recordIds: [app.records[0]!.id] }],
    });
    const before = tabs.get(11)?.url;
    await engine.prepareSessionReload();
    tabs.get(11)!.url = tabs.get(11)!.url!.replace('chrome:', 'brave:');
    const { pauseUpdate } = await import('../src/core/update-parking');
    await pauseUpdate();
    expect((await engine.state()).session?.missingTabs).toBe(0);
    expect(await engine.finishSessionReload(true)).toBe(false);
    expect(await engine.finishSessionReload(false)).toBe(true);
    expect(tabs.get(11)?.url).toBe(before);
  });
  it('allows a reviewed current session while retaining the missing recovery source as a snapshot', async () => {
    await engine.saveSession();
    await engine.preserveSession();
    tabs.delete(13);
    await engine.state();
    await expect(engine.saveSession()).rejects.toThrow('Resume missing');
    await engine.saveSession(true);
    expect((await engine.state()).session?.missingTabs).toBe(0);
    expect(
      (await engine.exportBackup()).snapshots.some(
        (saved) => saved.windows.reduce((count, window) => count + window.tabs.length, 0) === 3,
      ),
    ).toBe(true);
  });
  function legacy(
    tabId: number,
    url = 'https://example.com/search?a=1&url=https://nested.test/&b=2#part',
  ) {
    tabs.get(tabId)!.url =
      `chrome-extension://old/suspended.html#ttl=Saved%20tab&pos=42&uri=${url}`;
  }
  let previewClock = Date.now();
  function mockPreviewCanvas() {
    previewClock += 10_000;
    vi.spyOn(Date, 'now').mockReturnValue(previewClock);
    vi.stubGlobal('createImageBitmap', async () => ({ width: 1600, height: 900, close: () => {} }));
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        constructor(
          public width: number,
          public height: number,
        ) {}
        getContext() {
          return { drawImage: () => {} };
        }
        async convertToBlob() {
          return new Blob(['test JPEG pixels'], { type: 'image/jpeg' });
        }
      },
    );
  }
  it('captures only an actually visible HTTP page and excludes screenshots from state and backup', async () => {
    mockPreviewCanvas();
    tabs.get(11)!.active = true;
    const record = (await engine.state()).records.find((record) => record.tabId === 11)!;
    const config = { ...DEFAULTS, capturePreviews: true };
    expect(await captureTabPreview(record, config)).toBe(true);
    expect(await currentTabPreview(record)).toMatchObject({ id: record.id, url: record.url });
    expect(JSON.stringify(await engine.state())).not.toContain('data:image/jpeg');
    expect(JSON.stringify(await engine.exportBackup())).not.toContain('data:image/jpeg');
    local.settings = config;
    await engine.applyPlan({
      summary: 'With preview',
      actions: [{ type: 'suspend', recordIds: [record.id] }],
    });
    expect(await engine.placeholderPreview(11)).toMatchObject({ id: record.id });
    expect(await engine.placeholderPreview(12)).toBeNull();
  });
  it('never switches/wakes tabs for previews and honors excluded sites and permission denial', async () => {
    mockPreviewCanvas();
    const record = (await engine.state()).records.find((record) => record.tabId === 11)!;
    const camera = vi.spyOn(chromeMock.tabs, 'captureVisibleTab');
    const update = vi.spyOn(chromeMock.tabs, 'update');
    expect(await captureTabPreview(record, { ...DEFAULTS, capturePreviews: true })).toBe(false);
    tabs.get(11)!.active = true;
    expect(
      await captureTabPreview(record, {
        ...DEFAULTS,
        capturePreviews: true,
        previewExcludedSites: 'example.com',
      }),
    ).toBe(false);
    hostAccess = false;
    expect(await captureTabPreview(record, { ...DEFAULTS, capturePreviews: true })).toBe(false);
    expect(camera).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
  it('rejects captures if navigation or selection changes during the browser screenshot operation', async () => {
    mockPreviewCanvas();
    tabs.get(11)!.active = true;
    const record = (await engine.state()).records.find((record) => record.tabId === 11)!;
    vi.spyOn(chromeMock.tabs, 'captureVisibleTab').mockImplementation(async () => {
      invalidatePreviewCapture();
      return 'data:image/jpeg;base64,YQ==';
    });
    expect(await captureTabPreview(record, { ...DEFAULTS, capturePreviews: true })).toBe(false);
    expect(await currentTabPreview(record)).toBeNull();
    await database.previews.put({
      id: record.id,
      url: record.url,
      navigationVersion: record.navigationVersion,
      capturedAt: Date.now(),
      dataUrl: 'data:image/jpeg;base64,YQ==',
    });
    expect(
      await currentTabPreview({ ...record, navigationVersion: record.navigationVersion + 1 }),
    ).toBeNull();
    expect(await currentTabPreview({ ...record, url: 'https://another.test/' })).toBeNull();
  });
  it('does not repopulate cleared previews from a capture waiting for permission', async () => {
    mockPreviewCanvas();
    tabs.get(11)!.active = true;
    const record = (await engine.state()).records.find((record) => record.tabId === 11)!;
    const camera = vi.spyOn(chromeMock.tabs, 'captureVisibleTab');
    vi.spyOn(chrome.permissions, 'contains').mockImplementationOnce(async () => {
      await engine.deleteLocalData({ kind: 'cache', confirmation: 'DELETE' });
      return true;
    });
    expect(await captureTabPreview(record, { ...DEFAULTS, capturePreviews: true })).toBe(false);
    expect(camera).not.toHaveBeenCalled();
    expect(await database.previews.count()).toBe(0);
  });
  it('bounds the local screenshot cache instead of growing alongside all history', async () => {
    mockPreviewCanvas();
    tabs.get(11)!.active = true;
    const record = (await engine.state()).records.find((record) => record.tabId === 11)!;
    await database.previews.bulkPut(
      Array.from({ length: 100 }, (_, index) => ({
        id: `older-${index}`,
        url: record.url,
        navigationVersion: 0,
        capturedAt: Date.now() - index - 1,
        dataUrl: `data:image/jpeg;base64,${'A'.repeat(300_000)}`,
      })),
    );
    expect(await captureTabPreview(record, { ...DEFAULTS, capturePreviews: true })).toBe(true);
    expect(
      (await database.previews.toArray()).reduce((sum, preview) => sum + preview.dataUrl.length, 0),
    ).toBeLessThanOrEqual(24 * 1024 * 1024);
  });
  it('journals imported duplicate occurrences independently and preserves their native slots', async () => {
    legacy(11);
    legacy(12);
    tabs.get(11)!.pinned = true;
    tabs.get(11)!.groupId = 8;
    tabs.get(12)!.groupId = 9;
    const before = await engine.state();
    const records = before.records.filter((record) => record.foreignSuspended);
    expect(new Set(records.map((record) => record.id)).size).toBe(2);
    const started = await engine.migration.start();
    const update = vi.spyOn(chromeMock.tabs, 'update');
    expect((await getStoredEntity('operations', started.operationId))?.snapshotId).toBeTruthy();
    expect(update).not.toHaveBeenCalled();
    await engine.migration.step(started.id);
    const completed = await engine.migration.step(started.id);
    expect(completed).toMatchObject({ status: 'complete', imported: 2, failed: 0 });
    expect(tabs.get(11)).toMatchObject({ pinned: true, groupId: 8, windowId: 1, index: 0 });
    expect(tabs.get(12)).toMatchObject({ groupId: 9, windowId: 1, index: 1 });
    expect(tabs.get(13)?.url).toBe('https://example.com/three');
    expect((await getStoredEntity('operations', started.operationId))?.results).toHaveLength(2);
    const migrated = (await engine.state()).records.filter((record) => record.suspended);
    expect(new Set(migrated.map((record) => record.id))).toEqual(
      new Set(records.map((record) => record.id)),
    );
    expect(migrated.every((record) => record.url.includes('&url=https://nested.test/'))).toBe(true);
  });
  it('imports hundreds of mixed-window duplicate placeholders without waking sites or losing occurrence receipts', async () => {
    groups.set(80, {
      id: 80,
      windowId: 1,
      title: 'Keep owner group',
      color: 'purple',
      collapsed: true,
      shared: false,
    });
    for (let index = 0; index < 250; index++) {
      const tabId = 1000 + index;
      addTab(
        tabId,
        1 + (index % 2),
        `https://scale.test/task?kind=${index % 5}&url=https://nested.test/`,
        index,
      );
      legacy(tabId, tabs.get(tabId)!.url!);
      tabs.get(tabId)!.pinned = index % 40 === 0;
      if (index % 2 === 0 && !tabs.get(tabId)!.pinned) tabs.get(tabId)!.groupId = 80;
    }
    const slots = [...tabs.values()].map(({ id, windowId, index, pinned, groupId }) => ({
      id,
      windowId,
      index,
      pinned,
      groupId,
    }));
    const groupMetadata = [...groups.values()].map((group) => ({ ...group }));
    const started = await engine.migration.start();
    const updates = vi.spyOn(chromeMock.tabs, 'update');
    let result = started;
    for (let index = 0; index < 250; index++) result = await engine.migration.step(started.id);
    expect(result).toMatchObject({
      total: 250,
      processed: 250,
      imported: 250,
      failed: 0,
      status: 'complete',
    });
    expect(
      updates.mock.calls.every(([, patch]) => patch.url?.startsWith(origin + '/suspended.html')),
    ).toBe(true);
    const receipt = await database.migrations.get(started.id);
    expect(new Set(receipt?.items.map((item) => item.recordId)).size).toBe(250);
    expect((await database.operations.get(started.operationId))?.results).toHaveLength(250);
    expect(tabs.get(1000)).toMatchObject({ windowId: 1, pinned: true });
    expect(tabs.get(1001)).toMatchObject({ windowId: 2, pinned: false });
    expect(tabs.get(11)?.url).toBe('https://example.com/one');
    expect(
      [...tabs.values()].map(({ id, windowId, index, pinned, groupId }) => ({
        id,
        windowId,
        index,
        pinned,
        groupId,
      })),
    ).toEqual(slots);
    expect([...groups.values()]).toEqual(groupMetadata);
    expect(moves).toHaveLength(0);
  });
  it('retains earlier migration receipts when one tab fails and retries only unfinished tabs', async () => {
    legacy(11);
    legacy(12);
    const update = chromeMock.tabs.update;
    const fail = vi.spyOn(chromeMock.tabs, 'update').mockImplementation(async (id, patch) => {
      if (id === 12) throw new Error('Browser refused navigation');
      return update(id, patch);
    });
    const started = await engine.migration.start();
    await engine.migration.step(started.id);
    expect(await engine.migration.step(started.id)).toMatchObject({
      status: 'partial',
      imported: 1,
      failed: 1,
    });
    expect((await getStoredEntity('operations', started.operationId))?.results).toHaveLength(2);
    expect(tabs.get(12)?.url).toContain('chrome-extension://old/');
    fail.mockRestore();
    const retried = vi.spyOn(chromeMock.tabs, 'update');
    await engine.migration.retry(started.id);
    expect(await engine.migration.step(started.id)).toMatchObject({
      status: 'complete',
      imported: 2,
    });
    expect(retried.mock.calls.map((call) => call[0])).toEqual([12]);
  });
  it('cancels between occurrences and never replays an interrupted import automatically', async () => {
    legacy(11);
    legacy(12);
    const started = await engine.migration.start();
    await engine.migration.step(started.id);
    await engine.migration.cancel(started.id);
    expect(await engine.migration.step(started.id)).toMatchObject({
      status: 'cancelled',
      imported: 1,
    });
    expect(tabs.get(12)?.url).toContain('chrome-extension://old/');
    await engine.migration.retry(started.id);
    await engine.migration.recover();
    expect(await engine.migration.step(started.id)).toMatchObject({
      status: 'interrupted',
      imported: 1,
    });
    expect(tabs.get(12)?.url).toContain('chrome-extension://old/');
    await engine.migration.retry(started.id);
    expect(await engine.migration.step(started.id)).toMatchObject({
      status: 'complete',
      imported: 2,
    });
  });
  it('does not count accepted browser navigation as imported until the owned URL actually commits', async () => {
    legacy(11);
    const started = await engine.migration.start();
    let destination = '';
    const update = vi.spyOn(chromeMock.tabs, 'update').mockImplementation(async (id, patch) => {
      destination = patch.url!;
      return { ...tabs.get(id)!, pendingUrl: destination };
    });
    expect(await engine.migration.step(started.id)).toMatchObject({
      status: 'running',
      imported: 0,
      processed: 0,
    });
    expect((await database.migrations.get(started.id))?.items[0]?.status).toBe('navigating');
    expect(await engine.migration.step(started.id)).toMatchObject({ imported: 0 });
    expect(update).toHaveBeenCalledTimes(1);
    tabs.get(11)!.url = destination;
    expect(await engine.migration.step(started.id)).toMatchObject({
      status: 'complete',
      imported: 1,
      processed: 1,
    });
    expect(update).toHaveBeenCalledTimes(1);
    expect((await database.operations.get(started.operationId))?.results).toHaveLength(1);
  });
  it('records an uncommitted navigation timeout without replaying it', async () => {
    legacy(11);
    const started = await engine.migration.start();
    const update = vi
      .spyOn(chromeMock.tabs, 'update')
      .mockImplementation(async (id) => ({ ...tabs.get(id)! }));
    await engine.migration.step(started.id);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 30_001);
    expect(await engine.migration.step(started.id)).toMatchObject({
      status: 'partial',
      failed: 1,
      imported: 0,
    });
    expect(update).toHaveBeenCalledTimes(1);
    expect(tabs.get(11)?.url).toContain('chrome-extension://old/');
  });
  it('recovers a committed migration navigation with a missing receipt without navigating again', async () => {
    legacy(11);
    const started = await engine.migration.start();
    const record = (await engine.state()).records.find((record) => record.tabId === 11)!;
    await engine.applyPlan({
      summary: 'Simulated committed import',
      actions: [{ type: 'suspend', recordIds: [record.id] }],
    });
    const updates = vi.spyOn(chromeMock.tabs, 'update');
    await engine.migration.recover();
    expect(await engine.migration.step(started.id)).toMatchObject({
      imported: 1,
      status: 'complete',
    });
    expect(updates).not.toHaveBeenCalled();
  });
  it('keeps protected and independently navigated migration targets and reports unsupported wrappers', async () => {
    legacy(11);
    legacy(12);
    tabs.get(13)!.url = 'chrome-extension://old/suspended.html#uri=file:///private.txt';
    const record = (await engine.state()).records.find((record) => record.tabId === 11)!;
    await engine.updateRecord(record.id, { locked: true });
    expect(await engine.migration.report()).toMatchObject({
      recognized: 2,
      protected: 1,
      unsupported: [{ tabId: 13 }],
    });
    const started = await engine.migration.start();
    tabs.get(12)!.url = 'https://example.com/independent';
    expect(await engine.migration.step(started.id)).toMatchObject({
      skipped: 1,
      failed: 1,
      imported: 0,
      status: 'partial',
    });
    expect(tabs.get(11)?.url).toContain('chrome-extension://old/');
    expect(tabs.get(12)?.url).toBe('https://example.com/independent');
    expect(tabs.get(13)?.url).toContain('file:///private.txt');
  });
  it('rechecks pinned/audio/loading changes immediately before suspension', async () => {
    const record = (await engine.state()).records.find((record) => record.tabId === 11)!;
    const read = chromeMock.scripting.executeScript;
    vi.spyOn(chromeMock.scripting, 'executeScript').mockImplementation(async (options) => {
      const result = await read(options);
      if (!options.files) tabs.get(11)!.pinned = true;
      return result;
    });
    const result = await engine.applyPlan({
      summary: 'Race protection',
      actions: [{ type: 'suspend', recordIds: [record.id] }],
    });
    expect(result.results[0]?.outcomes).toEqual([{ skipped: 'Pinned tab' }]);
    expect(tabs.get(11)?.url).toBe(record.url);
  });
  it('does not replace a legacy placeholder moved between the migration check and final navigation', async () => {
    legacy(11);
    const started = await engine.migration.start();
    const get = chromeMock.tabs.get;
    let reads = 0;
    vi.spyOn(chromeMock.tabs, 'get').mockImplementation(async (id) => {
      if (id === 11 && ++reads === 3) tabs.get(11)!.groupId = 99;
      return get(id);
    });
    expect(await engine.migration.step(started.id)).toMatchObject({
      failed: 1,
      imported: 0,
      status: 'partial',
    });
    expect(tabs.get(11)).toMatchObject({ groupId: 99 });
    expect(tabs.get(11)?.url).toContain('chrome-extension://old/');
  });
  it.each(['audible', 'status'] as const)(
    'rechecks a browser %s change before suspension',
    async (property) => {
      const record = (await engine.state()).records.find((record) => record.tabId === 11)!;
      const read = chromeMock.scripting.executeScript;
      vi.spyOn(chromeMock.scripting, 'executeScript').mockImplementation(async (options) => {
        const result = await read(options);
        if (!options.files) {
          if (property === 'audible') tabs.get(11)!.audible = true;
          else tabs.get(11)!.status = 'loading';
        }
        return result;
      });
      const result = await engine.applyPlan({
        summary: 'Browser-state race',
        actions: [{ type: 'suspend', recordIds: [record.id] }],
      });
      expect(result.results[0]?.outcomes?.[0]?.skipped).toBeTruthy();
      expect(tabs.get(11)?.url).toBe(record.url);
    },
  );
  it('journals automatic suspension and does not let protected tabs starve eligible pages', async () => {
    local.settings = {
      ...DEFAULTS,
      autoSuspend: true,
      suspendMinutes: 5,
      neverSuspendSites: 'https://example.com/one',
      protectGrouped: true,
    };
    tabs.get(12)!.groupId = 7;
    const app = await engine.state();
    for (const record of app.records)
      await database.records.put({ ...record, lastAccessed: Date.now() - 3600000 });
    await engine.autoSuspend();
    expect(tabs.get(11)?.url).toBe('https://example.com/one');
    expect(tabs.get(12)?.url).toBe('https://example.com/two');
    expect(tabs.get(13)?.url).toContain(origin + '/suspended.html');
    expect((await database.operations.toArray())[0]).toMatchObject({
      summary: 'Automatic suspension',
      status: 'complete',
    });
  });
  it('allows an explicit form-protection setting and restores only selected owned placeholders on focus', async () => {
    dirty = true;
    local.settings = { ...DEFAULTS, protectForms: false, wakeOnFocus: true, restoreScroll: false };
    const record = (await engine.state()).records.find((record) => record.tabId === 11)!;
    await engine.applyPlan({
      summary: 'Explicit form setting',
      actions: [{ type: 'suspend', recordIds: [record.id] }],
    });
    expect(tabs.get(11)?.url).toContain(origin + '/suspended.html');
    tabs.get(11)!.active = true;
    await engine.activation(11);
    expect(tabs.get(11)?.url).toBe(record.url);
    expect(session['scroll:11']).toBeUndefined();
    legacy(12);
    await engine.state();
    await engine.activation(12);
    expect(tabs.get(12)?.url).toContain('chrome-extension://old/');
  });
  it('does not wake an active sleeping tab in an unfocused project-copy window', async () => {
    local.settings = { ...DEFAULTS, wakeOnFocus: true };
    tabs.get(13)!.active = true;
    const record = (await engine.state()).records.find((record) => record.tabId === 13)!;
    await engine.applyPlan({
      summary: 'Sleeping background project',
      actions: [{ type: 'suspend', recordIds: [record.id] }],
    });
    await engine.activation(13);
    expect(tabs.get(13)?.url).toContain(origin + '/suspended.html');
  });
  it('sends snapshot summaries to views while keeping full recovery and export data', async () => {
    const saved = await engine.snapshot('Recovery payload');
    const summary = (await engine.state()).snapshots.find((item) => item.id === saved.id)!;
    expect(summary).toMatchObject({ id: saved.id, windowCount: 2, tabCount: 3 });
    expect(summary).not.toHaveProperty('windows');
    expect((await getStoredEntity('snapshots', saved.id))!.windows).toEqual(saved.windows);
    const backup = await engine.exportBackup();
    expect(backup.snapshots.find((item) => item.id === saved.id)?.windows).toEqual(saved.windows);
  });
  it('keeps operation actions and outcomes out of periodic view payloads without losing recovery evidence', async () => {
    const record = (await engine.state()).records.find((item) => item.tabId === 11)!;
    const operation = await engine.applyPlan({
      summary: 'Summary test',
      actions: [{ type: 'suspend', recordIds: [record.id] }],
    });
    const summary = (await engine.state()).operations.find((item) => item.id === operation.id)!;
    expect(summary).toMatchObject({
      actionCount: 1,
      affectedOccurrences: 1,
      successfulActions: 1,
      failedActions: 0,
    });
    expect(summary).not.toHaveProperty('actions');
    expect(summary).not.toHaveProperty('results');
    expect((await getStoredEntity('operations', operation.id))?.results).toEqual(operation.results);
    expect(
      (await engine.exportBackup()).operations?.find((item) => item.id === operation.id)?.actions,
    ).toEqual(operation.actions);
  });
  async function copyProposal() {
    const app = await engine.state();
    return engine.saveCollectionProposal({
      model: 'large â†’ decision',
      summary: 'Fresh workspaces',
      scopeRecordIds: app.records.filter((record) => record.live).map((record) => record.id),
      projects: [
        {
          name: 'Atlas Planner',
          purpose: 'Build the application',
          areaName: 'Atlas',
          categories: [
            { name: 'Pull requests', description: 'Review code' },
            { name: 'Issues', description: 'Investigate issues' },
          ],
        },
        {
          name: 'Atlas UI',
          purpose: 'React interface',
          areaName: 'Atlas',
          categories: [{ name: 'Implementation', description: 'UI code' }],
        },
      ],
      assignments: app.records
        .filter((record) => record.live)
        .map((record) => ({
          recordId: record.id,
          url: record.url,
          navigationVersion: record.navigationVersion,
          projectName: record.tabId === 13 ? 'Atlas UI' : 'Atlas Planner',
          categoryName:
            record.tabId === 13
              ? 'Implementation'
              : record.tabId === 11
                ? 'Pull requests'
                : 'Issues',
          confidence: 0.9,
          reason: 'Reviewed evidence',
        })),
      unresolvedRecordIds: [],
    });
  }
  it('creates category groups in fresh project windows with independent sleeping copies and unchanged originals', async () => {
    groups.set(9, {
      id: 9,
      windowId: 1,
      title: 'Messy old group',
      color: 'red',
      collapsed: true,
      shared: false,
    });
    tabs.get(11)!.groupId = 9;
    tabs.get(12)!.groupId = 9;
    tabs.get(11)!.url =
      'chrome-extension://legacy/suspended.html#ttl=Saved&pos=5&uri=https://example.com/one';
    const originals = structuredClone([...tabs.values()]);
    const proposal = await copyProposal();
    const result = await engine.organizeCollection(proposal.id);
    expect(result.operation).toMatchObject({ kind: 'collection-copy', status: 'complete' });
    expect([...tabs.values()].filter((tab) => tab.windowId < 20)).toEqual(originals);
    expect(groups.get(9)).toMatchObject({
      title: 'Messy old group',
      color: 'red',
      collapsed: true,
    });
    const state = await engine.state();
    const copies = state.records.filter((record) => record.sourceRecordId && record.live);
    expect(copies).toHaveLength(3);
    expect(new Set(copies.map((record) => record.id)).size).toBe(3);
    expect(
      copies.every(
        (record) =>
          record.suspended && record.id !== record.sourceRecordId && record.windowId! >= 20,
      ),
    ).toBe(true);
    expect(
      [...groups.values()]
        .filter((group) => group.windowId >= 20)
        .map((group) => group.title)
        .sort(),
    ).toEqual(['Implementation', 'Issues', 'Pull requests']);
    expect(state.windows.filter((window) => window.projectId)).toHaveLength(2);
    expect(
      state.memberships
        .filter((membership) => membership.projectId)
        .every((membership) => copies.some((copy) => copy.id === membership.recordId)),
    ).toBe(true);
    expect(state.settings).toMatchObject({
      maintainCollectionReview: true,
      reviewProjectWindowsOnly: true,
    });
    for (const copy of copies)
      expect(await engine.queueOrganizationTab(copy.tabId!)).toBeUndefined();
  });
  it('remaps branches when copying project windows and retains independently renamed copies on Undo', async () => {
    const sources = (await engine.state()).records;
    const parent = sources[0]!,
      child = sources[1]!;
    await database.records.update(parent.id, { branchName: 'Research branch' });
    await database.records.update(child.id, { parentRecordId: parent.id });
    const proposal = await copyProposal();
    const result = await engine.organizeCollection(proposal.id);
    expect(result.operation?.status).toBe('complete');
    const copies = (await engine.state()).records.filter((record) => record.sourceRecordId);
    const copiedParent = copies.find((record) => record.sourceRecordId === parent.id)!;
    const copiedChild = copies.find((record) => record.sourceRecordId === child.id)!;
    expect(copiedChild.parentRecordId).toBe(copiedParent.id);
    expect(copiedChild.parentRecordId).not.toBe(parent.id);
    const edit = {
      kind: 'branch_name' as const,
      recordId: copiedParent.id,
      name: 'Owner revised branch',
    };
    await executeWorkspaceEdit({
      kind: 'workspace_edits',
      summary: 'Rename copied branch',
      edits: [{ edit, before: workspaceEditBaseline(await engine.state(), edit) }],
    });
    await engine.undoCollection(proposal.id);
    expect((await database.records.get(copiedParent.id))?.live).toBe(true);
    expect((await database.records.get(copiedParent.id))?.branchName).toBe('Owner revised branch');
    expect((await database.records.get(parent.id))?.live).toBe(true);
    expect((await database.records.get(child.id))?.live).toBe(true);
  });
  it('observes the planned UUID when a new window returns before its first URL commits', async () => {
    const proposal = await copyProposal();
    const originalCreate = chromeMock.windows.create;
    const originalQuery = chromeMock.tabs.query;
    const create = vi
      .spyOn(chromeMock.windows, 'create')
      .mockImplementationOnce(async (options) => {
        const created = await originalCreate(options);
        return {
          ...created,
          tabs: created.tabs?.map((tab) => ({ ...tab, url: undefined, pendingUrl: tab.url })),
        };
      });
    const query = vi.spyOn(chromeMock.tabs, 'query').mockImplementationOnce(async (filter) =>
      (await originalQuery(filter)).map((tab) => ({
        ...tab,
        url: undefined,
        pendingUrl: tab.url,
      })),
    );
    const result = await engine.organizeCollection(proposal.id);
    expect(result.operation?.status).toBe('complete');
    expect(result.proposal.copyState?.entries.every((entry) => entry.created)).toBe(true);
    expect(
      (await engine.state()).records.filter((record) => record.live && record.sourceRecordId),
    ).toHaveLength(3);
    create.mockRestore();
    query.mockRestore();
  });
  it('retries only incomplete copy creation and does not duplicate completed project windows or occurrences', async () => {
    const proposal = await copyProposal();
    const create = vi
      .spyOn(chromeMock.tabs, 'create')
      .mockRejectedValueOnce(new Error('Temporary creation failure'));
    const partial = await engine.organizeCollection(proposal.id);
    expect(partial.operation?.status).toBe('partial');
    expect(partial.proposal.status).toBe('pending');
    expect(partial.proposal.copyState?.entries.filter((entry) => entry.created)).toHaveLength(2);
    expect((await engine.state()).memberships.every((entry) => entry.projectId === null)).toBe(
      true,
    );
    const windows = partial.proposal.copyState!.windows.map((window) => window.windowId);
    create.mockRestore();
    const complete = await engine.organizeCollection(proposal.id);
    expect(complete.operation?.status).toBe('complete');
    expect(complete.proposal.copyState!.windows.map((window) => window.windowId)).toEqual(windows);
    expect(
      (await engine.state()).records.filter((record) => record.live && record.sourceRecordId),
    ).toHaveLength(3);
    const count = tabs.size;
    await engine.organizeCollection(proposal.id);
    expect(tabs.size).toBe(count);
  });
  it('recovers a copy created before its receipt write by UUID without replaying it on an explicit retry', async () => {
    tabs.get(12)!.url = tabs.get(11)!.url;
    const proposal = await copyProposal();
    const originalCreate = chromeMock.tabs.create;
    const create = vi.spyOn(chromeMock.tabs, 'create').mockImplementationOnce(async (options) => {
      await originalCreate(options);
      throw new Error('Interrupted after native creation');
    });
    const partial = await engine.organizeCollection(proposal.id);
    expect(partial.operation?.status).toBe('partial');
    const beforeRetry = tabs.size;
    create.mockRestore();
    await engine.state();
    expect(tabs.size).toBe(beforeRetry);
    const complete = await engine.organizeCollection(proposal.id);
    expect(complete.operation?.status).toBe('complete');
    expect(tabs.size).toBe(beforeRetry);
    const copies = (await engine.state()).records.filter((record) => record.sourceRecordId);
    expect(copies).toHaveLength(3);
    expect(copies.filter((record) => record.url === tabs.get(11)!.url)).toHaveLength(2);
    expect(new Set(copies.map((record) => record.id)).size).toBe(3);
  });
  it('retries partial native category grouping without recreating copies', async () => {
    const proposal = await copyProposal();
    const update = vi
      .spyOn(chromeMock.tabGroups, 'update')
      .mockRejectedValueOnce(new Error('Group update failed'));
    const partial = await engine.organizeCollection(proposal.id);
    expect(partial.operation?.status).toBe('partial');
    expect(partial.proposal.status).toBe('applied');
    const count = tabs.size;
    update.mockRestore();
    const complete = await engine.organizeCollection(proposal.id);
    expect(complete.operation?.status).toBe('complete');
    expect(tabs.size).toBe(count);
  });
  it('retains independently navigated copies and unrelated later tabs during explicit copy Undo', async () => {
    const proposal = await copyProposal();
    const complete = await engine.organizeCollection(proposal.id);
    const copies = (await engine.state()).records.filter((record) => record.sourceRecordId);
    tabs.get(copies[0]!.tabId!)!.url = 'https://example.com/new-work';
    const copyWindow = complete.proposal.copyState!.windows[0]!.windowId;
    addTab(999, copyWindow, 'https://example.com/later');
    const result = await engine.undoCollection(proposal.id);
    expect(result).toMatchObject({ restored: 2, skipped: 1 });
    expect(tabs.get(copies[0]!.tabId!)?.url).toBe('https://example.com/new-work');
    expect(tabs.get(999)?.url).toBe('https://example.com/later');
    expect(tabs.get(11)?.url).toBe('https://example.com/one');
    expect(tabs.get(12)?.url).toBe('https://example.com/two');
    expect(tabs.get(13)?.url).toBe('https://example.com/three');
  });
  it('reviews already-grouped random tabs and placement changes without trusting inherited native grouping', async () => {
    const proposal = await copyProposal();
    const complete = await engine.organizeCollection(proposal.id);
    const win = complete.proposal.copyState!.windows[0]!.windowId;
    addTab(999, win, 'https://entertainment.example.com/random');
    tabs.get(999)!.groupId = [...groups.values()].find((group) => group.windowId === win)!.id;
    await engine.state();
    const first = await engine.queueOrganizationTab(999);
    expect(first).toMatchObject({ kind: 'collection', status: 'queued' });
    expect(await engine.queueOrganizationTab(11)).toBeUndefined();
    tabs.get(999)!.groupId = -1;
    await engine.state();
    const second = await engine.queueOrganizationTab(999);
    expect(second?.id).not.toBe(first?.id);
    expect(second?.url).toBe(first?.url);
    expect(second?.navigationVersion).toBe(first?.navigationVersion);
    const claimed = await engine.claimCollectionJobs('panel');
    expect(claimed.map((job) => job.id)).toEqual([second?.id]);
    expect((await database.organizationJobs.get(first!.id))?.status).toBe('stale');
  });
  it('maintains new tabs across unbound windows with scoped, leased review proposals', async () => {
    const project = await engine.project({ name: 'Personal references' });
    await engine.saveCategory({
      projectId: project.id,
      name: 'Reading',
      description: 'Personal reading',
    });
    const app = await engine.state();
    const first = app.records.find((record) => record.tabId === 11)!;
    const otherWindow = app.records.find((record) => record.tabId === 13)!;
    expect(await engine.queueOrganizationTab(11)).toBeUndefined();
    local.settings = { ...DEFAULTS, maintainCollectionReview: true };
    const firstJob = await engine.queueOrganizationTab(11);
    const otherJob = await engine.queueOrganizationTab(13);
    expect(firstJob).toMatchObject({ kind: 'collection', recordId: first.id });
    expect(otherJob?.projectId).toBeUndefined();
    expect((await engine.queueOrganizationTab(11))?.id).toBe(firstJob?.id);
    const jobs = await engine.claimCollectionJobs('one');
    expect(jobs).toHaveLength(2);
    expect(await engine.claimCollectionJobs('two')).toEqual([]);
    await expect(
      engine.renewCollectionJobs(
        jobs.map((job) => job.id),
        'two',
      ),
    ).rejects.toThrow(/another dashboard/);
    await engine.renewCollectionJobs(
      jobs.map((job) => job.id),
      'one',
    );
    const proposal = await engine.saveCollectionProposal({
      scopeRecordIds: [first.id, otherWindow.id],
      sourceJobIds: jobs.map((job) => job.id),
      summary: 'Two new tabs only',
      projects: [
        {
          name: project.name,
          areaName: 'Personal',
          purpose: '',
          categories: [{ name: 'Reading', description: '' }],
        },
        {
          name: 'Unused choice',
          areaName: 'Unused area',
          purpose: '',
          categories: [{ name: 'Unused', description: '' }],
        },
      ],
      assignments: [
        {
          recordId: first.id,
          url: first.url,
          navigationVersion: first.navigationVersion,
          projectName: project.name,
          categoryName: 'Reading',
          reason: 'Reference',
          confidence: 0.8,
        },
      ],
      unresolvedRecordIds: [otherWindow.id],
    });
    await expect(
      engine.finishOrganizationJob({ id: firstJob!.id, status: 'complete', runnerId: 'two' }),
    ).rejects.toThrow(/another dashboard/);
    for (const job of jobs)
      await engine.finishOrganizationJob({ id: job.id, status: 'complete', runnerId: 'one' });
    await engine.queueOrganizationTab(12);
    expect(await engine.claimCollectionJobs('one')).toEqual([]);
    await engine.applyCollectionProposal(proposal.id);
    expect(await database.projects.toArray()).toHaveLength(1);
    expect((await database.areas.toArray()).some((area) => area.name === 'Unused area')).toBe(
      false,
    );
    expect((await engine.claimCollectionJobs('one')).map((job) => job.recordId)).toEqual([
      app.records.find((record) => record.tabId === 12)!.id,
    ]);
    expect(tabs.get(11)?.windowId).toBe(1);
    expect(tabs.get(13)?.windowId).toBe(2);
  });
  it('rejects stale collection intake and preserves owner corrections after a queue lease', async () => {
    const project = await engine.project({ name: 'Daily' });
    await engine.saveCategory({ projectId: project.id, name: 'Routine', description: '' });
    local.settings = { ...DEFAULTS, maintainCollectionReview: true };
    const app = await engine.state();
    const record = app.records.find((item) => item.tabId === 11)!;
    await engine.queueOrganizationTab(11);
    await database.memberships.put({
      recordId: record.id,
      projectId: project.id,
      categoryId: null,
      source: 'owner',
      updatedAt: Date.now(),
    });
    expect(await engine.claimCollectionJobs('one')).toEqual([]);
    expect((await database.organizationJobs.toArray())[0]?.status).toBe('stale');
    expect(await engine.queueOrganizationTab(11)).toBeUndefined();
    const job = await engine.queueOrganizationTab(13);
    await engine.claimCollectionJobs('one');
    await database.organizationJobs.update(job!.id, { leaseUntil: Date.now() - 1 });
    expect((await engine.claimCollectionJobs('two'))[0]).toMatchObject({
      id: job!.id,
      attempts: 2,
      leaseOwner: 'two',
    });
    await expect(
      engine.finishOrganizationJob({ id: job!.id, status: 'error', runnerId: 'one' }),
    ).rejects.toThrow(/another dashboard/);
  });
  it('does not inspect a page that navigates after being queued', async () => {
    const record = (await engine.state()).records.find((entry) => entry.tabId === 11)!;
    const job = await engine.startInspection([record.id]);
    tabs.get(11)!.url = 'https://example.com/independent-page';
    await engine.reconcile();
    await engine.inspectionStep();
    const saved = await database.jobs.get(job.id);
    expect(saved?.items[0]).toMatchObject({
      status: 'error',
      error: expect.stringContaining('Inspection target changed'),
    });
    expect(
      (await engine.state()).records.find((entry) => entry.id === record.id)?.content,
    ).toBeNull();
    expect(tabs.get(11)?.url).toBe('https://example.com/independent-page');
  });
  it('does not resuspend an independently navigated page when cancelling an inspection wake', async () => {
    const record = (await engine.state()).records.find((entry) => entry.tabId === 11)!;
    await engine.applyPlan({
      summary: 'Sleep one',
      actions: [{ type: 'suspend', recordIds: [record.id] }],
    });
    const job = await engine.startInspection([record.id]);
    await engine.inspectionStep();
    expect((await database.jobs.get(job.id))?.items[0]?.resuspend).toBe(true);
    tabs.get(11)!.url = 'https://example.com/owner-new-page';
    await engine.reconcile();
    await engine.cancelJob(job.id);
    await engine.recoverCancelledInspections();
    expect(tabs.get(11)?.url).toBe('https://example.com/owner-new-page');
    expect((await database.jobs.get(job.id))?.items[0]?.resuspend).toBe(false);
  });
  it('does not wake or rearrange unrelated tabs when undoing a native group action', async () => {
    const records = (await engine.state()).records;
    const target = records.find((record) => record.tabId === 11)!;
    const unrelated = records.find((record) => record.tabId === 12)!;
    const group = await engine.applyPlan({
      summary: 'Group selected reference',
      actions: [{ type: 'group', recordIds: [target.id], windowId: 1, name: 'Selected reference' }],
    });
    groups.set(40, {
      id: 40,
      windowId: 1,
      title: 'Later owner group',
      color: 'grey',
      collapsed: false,
      shared: false,
    });
    tabs.get(12)!.groupId = 40;
    await engine.applyPlan({
      summary: 'Sleep unrelated tab later',
      actions: [{ type: 'suspend', recordIds: [unrelated.id] }],
    });
    const sleepingUrl = tabs.get(12)?.url;
    const result = await engine.undoOperation(group.id);
    expect(result.every((item) => item.ok)).toBe(true);
    expect(tabs.get(12)?.url).toBe(sleepingUrl);
    expect(tabs.get(12)?.groupId).toBe(40);
    expect(tabs.get(11)?.groupId).toBe(-1);
  });
  it('retains a protected target during undo and rejects active inspection targets before applying', async () => {
    const target = (await engine.state()).records.find((record) => record.tabId === 11)!;
    const operation = await engine.applyPlan({
      summary: 'Group one',
      actions: [{ type: 'group', recordIds: [target.id], windowId: 1, name: 'Keep' }],
    });
    const groupId = tabs.get(11)?.groupId;
    await engine.updateRecord(target.id, { locked: true });
    const outcome = await engine.undoOperation(operation.id);
    expect(outcome).toMatchObject([{ ok: false, error: expect.stringContaining('Protected') }]);
    expect(tabs.get(11)?.groupId).toBe(groupId);
    await engine.updateRecord(target.id, { locked: false });
    await database.jobs.put({
      id: 'inspection',
      type: 'inspection',
      createdAt: 1,
      status: 'running',
      cursor: 0,
      items: [{ id: target.id, status: 'loading' }],
    });
    await expect(
      engine.applyPlan({
        summary: 'Move inspection target',
        actions: [{ type: 'move', recordIds: [target.id], windowId: 2 }],
      }),
    ).rejects.toThrow('active inspection');
    expect(tabs.get(11)?.windowId).toBe(1);
  });
  it('rejects a reviewed plan after the owner moves its occurrence to another window', async () => {
    const target = (await engine.state()).records.find((record) => record.tabId === 11)!;
    const plan = {
      summary: 'In-window grouping',
      actions: [{ type: 'group' as const, recordIds: [target.id], windowId: 1, name: 'Reference' }],
      expected: {
        [target.id]: {
          url: target.url,
          navigationVersion: target.navigationVersion,
          windowId: 1,
          groupId: -1,
        },
      },
    };
    tabs.get(11)!.windowId = 2;
    await expect(engine.applyPlan(plan)).rejects.toThrow('browser location changed');
    expect(tabs.get(11)?.windowId).toBe(2);
  });
  it('uses occurrence membership for project filters when several projects share one window', async () => {
    const windowProject = await engine.project({ name: 'Window context', windowId: 1 });
    const semanticProject = await engine.project({ name: 'Entertainment' });
    const first = (await engine.state()).records.find((record) => record.tabId === 11)!;
    await engine.assignMembership({
      recordIds: [first.id],
      projectId: semanticProject.id,
      categoryId: null,
    });
    let state = await engine.state();
    expect(state.records.find((record) => record.tabId === 11)?.projectId).toBe(semanticProject.id);
    expect(state.records.find((record) => record.tabId === 12)?.projectId).toBe(windowProject.id);
    await engine.bindProject(1, null);
    state = await engine.state();
    expect(state.records.find((record) => record.tabId === 11)?.projectId).toBe(semanticProject.id);
    expect(state.records.find((record) => record.tabId === 12)?.projectId).toBeNull();
  });
  it('undoes reviewed native and semantic organization while retaining later tabs and owner corrections', async () => {
    groups.set(9, {
      id: 9,
      windowId: 1,
      title: 'Original references',
      color: 'grey',
      collapsed: true,
      shared: false,
    });
    tabs.get(11)!.groupId = 9;
    tabs.get(12)!.groupId = 9;
    const app = await engine.state();
    const proposal = await engine.saveCollectionProposal({
      model: 'large â†’ small',
      summary: 'Reviewed references',
      projects: [
        {
          name: 'Research',
          purpose: 'Read references',
          areaName: 'Personal',
          categories: [{ name: 'Reading', description: 'Source material' }],
        },
      ],
      assignments: app.records.map((record) => ({
        recordId: record.id,
        url: record.url,
        navigationVersion: record.navigationVersion,
        projectName: 'Research',
        categoryName: 'Reading',
        reason: 'Title and original address',
        confidence: 0.9,
      })),
      unresolvedRecordIds: [],
    });
    const result = await engine.organizeCollection(proposal.id);
    expect(result.operation?.collectionProposalId).toBe(proposal.id);
    expect(result.operation?.status).toBe('complete');
    const organized = await engine.state();
    expect(
      organized.projects.find((project) => project.name === 'Research')?.provenance,
    ).toMatchObject({ author: 'ai', proposalId: proposal.id });
    expect(
      organized.records
        .filter((record) => record.sourceRecordId)
        .every((record) => record.projectId === organized.projects[0]?.id),
    ).toBe(true);
    expect(
      app.records.every(
        (original) =>
          organized.records.find((record) => record.id === original.id)?.windowId ===
          original.windowId,
      ),
    ).toBe(true);
    const kept = organized.records.find((record) => record.sourceRecordId)!;
    await engine.assignMembership({
      recordIds: [kept.id],
      projectId: organized.projects[0]!.id,
      categoryId: null,
    });
    addTab(14, 1, 'https://example.com/later');
    const recovered = await engine.undoCollection(proposal.id);
    expect(recovered).toMatchObject({ restored: 2, skipped: 1 });
    expect(tabs.get(14)?.url).toBe('https://example.com/later');
    expect(
      [...groups.values()].some(
        (group) => group.title === 'Original references' && group.collapsed,
      ),
    ).toBe(true);
    const after = await engine.state();
    expect(after.memberships.filter((entry) => entry.projectId)).toEqual([
      expect.objectContaining({ recordId: kept.id, source: 'owner', categoryId: null }),
    ]);
    expect(
      after.operations.find((operation) => operation.id === result.operation?.id)?.status,
    ).toBe('undone');
    expect(after.collectionProposals.find((item) => item.id === proposal.id)?.status).toBe(
      'undone',
    );
  });
  it('persists bulk tag checkpoints through real storage and patches tags without replacing owner membership or protected draft rows', async () => {
    const records = (await engine.state()).records.slice(0, 2);
    const [record, protectedRecord] = records;
    const proposal = await engine.saveCollectionProposal({
      summary: 'Saved reading scope',
      scopeRecordIds: records.map((item) => item.id),
      projects: [
        {
          name: 'Reading',
          purpose: 'Reading',
          areaName: 'Learning',
          categories: [{ name: 'Sources', description: 'Reference pages' }],
        },
      ],
      assignments: [
        {
          recordId: record!.id,
          url: record!.url,
          navigationVersion: record!.navigationVersion,
          projectName: 'Reading',
          categoryName: 'Sources',
          reason: 'Saved evidence',
          confidence: 0.9,
        },
      ],
      unresolvedRecordIds: [protectedRecord!.id],
    });
    const project = await engine.project({ name: 'Owner library' }, false);
    await engine.assignMembership({
      recordIds: [record!.id],
      projectId: project.id,
      categoryId: null,
    });
    await engine.updateRecord(record!.id, { tags: ['Reference'] });
    await engine.updateRecord(protectedRecord!.id, { locked: true });
    const app = await engine.state();
    const before = structuredClone(app.memberships);
    const provider = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    tags: [],
                    newTags: [{ name: 'Example', source: 'url', quote: 'example.com' }],
                    uncertain: false,
                  }),
                },
                finish_reason: 'stop',
              },
            ],
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    );
    const result = await tagSavedProposal(
      {
        ...app,
        settings: {
          ...app.settings,
          smallModel: 'synthetic-tags',
          smallContextTokens: 32768,
          smallCompletionTokens: 2048,
          tagVerification: 'none',
        },
      },
      proposal,
      {
        checkpoint: {
          id: 'stored-tags',
          load: () => getStoredEntity('collectionAnalyses', 'stored-tags'),
          save: engine.saveCollectionAnalysis,
          tags: {
            analysisId: 'stored-tags',
            load: () => engine.listTagAnalyses('stored-tags'),
            save: engine.saveTagAnalysis,
          },
        },
      },
    );
    expect(result).toMatchObject({ processed: 1, skipped: 1 });
    expect((await engine.listTagAnalyses('stored-tags'))[0]?.status).toBe('complete');
    expect((await getStoredEntity('collectionAnalyses', 'stored-tags'))?.tagVocabulary).toContain(
      'Reference',
    );
    const input = {
      id: proposal.id,
      expectedFingerprint: result.fingerprint,
      patches: result.patches,
    };
    const updated = await engine.updateCollectionTags(input);
    expect(updated.assignments[0]?.suggestedTags).toEqual(['Example']);
    expect(updated.unresolvedRecordIds).toEqual(proposal.unresolvedRecordIds);
    expect(updated.projects).toEqual(proposal.projects);
    expect(updated.status).toBe('pending');
    expect((await engine.state()).memberships).toEqual(before);
    expect((await database.records.get(record!.id))?.tags).toEqual(['Reference']);
    await expect(engine.updateCollectionTags(input)).rejects.toThrow('proposal changed');
    expect(provider).toHaveBeenCalledTimes(1);
  });
  it('does not review or automatically apply a draft-only turn, and permits explicitly requested application', async () => {
    const record = (await engine.state()).records[0]!;
    const proposal = await engine.saveCollectionProposal({
      summary: 'Tag suggestions only',
      projects: [],
      assignments: [],
      scopeRecordIds: [record.id],
      unresolvedRecordIds: [record.id],
    });
    const thread = assistantThreadSchema.parse({
      id: 'draft-only-chat',
      title: 'Draft tags',
      createdAt: 1,
      updatedAt: 1,
      projectId: null,
      status: 'ready',
      messages: [
        {
          id: 'tag-request',
          role: 'user',
          content: 'Add tags to the draft without applying.',
          createdAt: 1,
          request: {
            task: 'work',
            recordIds: [record.id],
            selectedRecordIds: [],
            projectId: null,
            allowCrossWindowMove: false,
            allowSleepWake: false,
          },
        },
        {
          id: 'tag-answer',
          role: 'assistant',
          content: 'Saved tag suggestions.',
          createdAt: 2,
          requestMessageId: 'tag-request',
          deliveryStatus: 'complete',
          collectionProposalId: proposal.id,
        },
      ],
    });
    await database.assistantThreads.put(thread);
    await permissions.setPermissionPolicy({ threadId: thread.id, mode: 'review' });
    const artifact = { kind: 'collection' as const, proposalId: proposal.id };
    const review = await permissions.preparePermissionReview({
      threadId: thread.id,
      messageId: 'tag-answer',
      artifact,
      oneOff: false,
    });
    expect(review.decision).toBe('ask');
    expect(review.reason).toContain('application was not requested');
    const policy = await permissions.setPermissionPolicy({ threadId: thread.id, mode: 'all' });
    const input = {
      threadId: thread.id,
      messageId: 'tag-answer',
      artifact,
      mode: 'automatic',
      permissionPolicyRevision: policy.revision,
    };
    await expect(executeAssistantAction(input)).rejects.toThrow('application was not requested');
    expect((await getStoredEntity('collectionProposals', proposal.id))?.status).toBe('pending');
    expect(await database.assistantChanges.count()).toBe(0);
    thread.messages[1]!.collectionApplyRequested = true;
    thread.messages[0]!.content = 'Apply this saved organization.';
    await database.assistantThreads.put(thread);
    expect((await executeAssistantAction(input)).status).toBe('complete');
  });
  it('binds manual organization consent to the reviewed draft and never applies a later revision', async () => {
    const before = await engine.state();
    const record = before.records[0]!;
    const proposal = await engine.saveCollectionProposal({
      name: 'Weekend reading',
      summary: 'Reading references',
      scopeRecordIds: [record.id],
      projects: [
        {
          name: 'Reading',
          purpose: 'Reading references',
          areaName: 'Personal',
          categories: [{ name: 'References', description: 'Reading material' }],
        },
      ],
      assignments: [
        {
          recordId: record.id,
          url: record.url,
          navigationVersion: record.navigationVersion,
          projectName: 'Reading',
          categoryName: 'References',
          reason: 'Reference',
          confidence: 0.9,
        },
      ],
      unresolvedRecordIds: [],
    });
    const request = {
      threadId: 'reading-chat',
      messageId: 'reading-action',
      mode: 'once',
      artifact: {
        kind: 'collection',
        proposalId: proposal.id,
        proposalFingerprint: await tagHash(proposal),
      },
    };
    await database.collectionProposals.update(proposal.id, { name: 'Updated reading draft' });
    await expect(executeAssistantAction(request)).rejects.toThrow('draft changed after review');
    expect((await engine.state()).memberships).toEqual(before.memberships);
    expect(await database.assistantChanges.count()).toBe(0);
    expect((await database.collectionProposals.get(proposal.id))?.status).toBe('pending');
    const refreshed = await getStoredEntity('collectionProposals', proposal.id);
    request.artifact.proposalFingerprint = await tagHash(refreshed);
    const applied = await executeAssistantAction(request);
    expect(applied.status).toBe('complete');
    expect(applied.summary).toContain('Apply organization');
    expect(applied.summary).toContain('Updated reading draft');
    expect(
      (await engine.state()).memberships.find((item) => item.recordId === record.id)?.projectId,
    ).toBeTruthy();
    expect((await executeAssistantAction(request)).id).toBe(applied.id);
    expect(await database.assistantChanges.count()).toBe(1);
    await undoAssistantChange(applied.id);
    expect((await engine.state()).memberships).toEqual(
      before.memberships.map(({ recordId, projectId, categoryId, source }) =>
        expect.objectContaining({ recordId, projectId, categoryId, source }),
      ),
    );
  });
  it('applies all merged tags beyond twenty, keeps existing tags and restores them on Undo', async () => {
    const record = (await engine.state()).records[0]!;
    const original = Array.from({ length: 21 }, (_, i) => `existing-${i}`);
    await engine.updateRecord(record.id, { tags: original });
    const make = (prefix: string) =>
      engine.saveCollectionProposal({
        summary: 'Reading references',
        scopeRecordIds: [record.id],
        projects: [],
        assignments: [],
        unresolvedRecordIds: [record.id],
        unresolvedTagSuggestions: [
          {
            recordId: record.id,
            url: record.url,
            navigationVersion: record.navigationVersion,
            suggestedTags: Array.from({ length: 12 }, (_, i) => `${prefix}-${i}`),
          },
        ],
      });
    const target = await make('reading');
    const source = await make('reference');
    const { proposal } = await engine.mergeCollectionProposals({
      targetProposalId: target.id,
      sourceProposalId: source.id,
      targetFingerprint: await tagHash(target),
      sourceFingerprint: await tagHash(source),
      projectNames: [],
      assignmentConflict: 'keep_target',
    });
    expect(proposal.unresolvedTagSuggestions?.[0]?.suggestedTags).toHaveLength(24);
    expect((await database.records.get(record.id))?.tags).toEqual(original);
    await engine.applyCollectionProposal(target.id);
    const expected = [...original, ...proposal.unresolvedTagSuggestions![0]!.suggestedTags];
    expect((await database.records.get(record.id))?.tags).toEqual(expected);
    await engine.snapshot('Merged tags retained');
    const backup = await engine.exportBackup();
    expect(
      backup.snapshots
        .find((snapshot) => snapshot.label === 'Merged tags retained')
        ?.windows.flatMap((window) => window.tabs)
        .find((tab) => tab.recordId === record.id)?.tags,
    ).toEqual(expected);
    await engine.importBackup(backup);
    await engine.undoCollection(target.id);
    expect((await database.records.get(record.id))?.tags).toEqual(original);
    expect(await getStoredEntity('collectionProposals', source.id)).toEqual(source);
  });
  it('rolls back the entire semantic collection commit when a membership write fails', async () => {
    const before = await engine.state();
    const records = before.records;
    const proposal = await engine.saveCollectionProposal({
      summary: 'Atomic draft',
      projects: [
        {
          name: 'Atomic project',
          purpose: '',
          areaName: 'Work',
          categories: [{ name: 'References', description: '' }],
        },
      ],
      assignments: records.map((record) => ({
        recordId: record.id,
        url: record.url,
        navigationVersion: record.navigationVersion,
        projectName: 'Atomic project',
        categoryName: 'References',
        reason: '',
        confidence: 0.9,
      })),
      unresolvedRecordIds: [],
    });
    const write = () => {
      throw new Error('Simulated storage failure');
    };
    database.memberships.hook('updating', write);
    try {
      await expect(engine.applyCollectionProposal(proposal.id)).rejects.toThrow(
        'Simulated storage failure',
      );
    } finally {
      database.memberships.hook('updating').unsubscribe(write);
    }
    const state = await engine.state();
    expect(state.projects).toEqual([]);
    expect(state.areas).toEqual([]);
    expect(state.categories).toEqual([]);
    expect(state.memberships).toEqual(before.memberships);
    expect(state.collectionProposals[0]?.status).toBe('pending');
    expect(state.operations).toEqual([]);
  });
  it('excludes assigned and uncertain tabs from every Apply effect, with guarded draft Undo/Redo', async () => {
    const before = await engine.state();
    const [first, second, third] = before.records;
    const proposal = await engine.saveCollectionProposal({
      summary: 'Review only the intended tabs',
      scopeRecordIds: [first!.id, second!.id, third!.id],
      projects: [
        {
          name: 'Chosen references',
          purpose: '',
          areaName: null,
          categories: [{ name: 'Reading', description: '' }],
        },
      ],
      assignments: [first!, second!].map((record) => ({
        recordId: record.id,
        url: record.url,
        navigationVersion: record.navigationVersion,
        projectName: 'Chosen references',
        categoryName: 'Reading',
        reason: 'Choice',
        confidence: 1,
        suggestedTags: ['reading'],
      })),
      unresolvedRecordIds: [third!.id],
      unresolvedTagSuggestions: [
        {
          recordId: third!.id,
          url: third!.url,
          navigationVersion: third!.navigationVersion,
          suggestedTags: ['excluded-label'],
        },
      ],
    });
    const removed = await engine.updateCollectionProposal(
      proposal.id,
      { ...proposal, excludedRecordIds: [first!.id, third!.id] },
      false,
      { expectedFingerprint: await tagHash(proposal) },
    );
    const [revision] = await listProposalRevisions(proposal.id);
    const undone = await restoreProposalRevision({
      id: revision!.id,
      direction: 'undo',
      expectedFingerprint: await tagHash(removed),
    });
    expect(undone.excludedRecordIds).toBeUndefined();
    const redone = await restoreProposalRevision({
      id: revision!.id,
      direction: 'redo',
      expectedFingerprint: await tagHash(undone),
    });
    expect(redone.excludedRecordIds).toEqual([first!.id, third!.id]);
    await database.records.update(first!.id, { locked: true });
    await database.records.update(third!.id, {
      url: 'https://changed.example.test/',
      navigationVersion: third!.navigationVersion + 1,
    });
    await engine.applyCollectionProposal(proposal.id);
    const after = await engine.state();
    expect(after.memberships.find((item) => item.recordId === second!.id)?.projectId).toBe(
      after.projects.find((item) => item.name === 'Chosen references')?.id,
    );
    for (const record of [first!, third!]) {
      expect(after.memberships.find((item) => item.recordId === record.id)).toEqual(
        before.memberships.find((item) => item.recordId === record.id),
      );
      expect(after.records.find((item) => item.id === record.id)?.tags).toEqual(record.tags);
    }
    expect(after.records.find((item) => item.id === second!.id)?.tags).toContain('reading');
    expect(moves).toHaveLength(0);
  });
  it('applies a project and category without inventing an area and restores membership on undo', async () => {
    const before = await engine.state();
    const record = before.records[0]!;
    const proposal = await engine.saveCollectionProposal({
      summary: 'A project without an area',
      scopeRecordIds: [record.id],
      projects: [
        {
          name: 'Independent gaming',
          purpose: '',
          areaName: null,
          categories: [{ name: 'Steam', description: '' }],
        },
      ],
      assignments: [
        {
          recordId: record.id,
          url: record.url,
          navigationVersion: record.navigationVersion,
          projectName: 'Independent gaming',
          categoryName: 'Steam',
          reason: 'Owner choice',
          confidence: 1,
        },
      ],
      unresolvedRecordIds: [],
    });
    await engine.applyCollectionProposal(proposal.id);
    const applied = await engine.state();
    const project = applied.projects.find((item) => item.name === 'Independent gaming')!;
    expect(project.areaId).toBeNull();
    expect(applied.areas).toEqual(before.areas);
    const category = applied.categories.find(
      (item) => item.projectId === project.id && item.name === 'Steam',
    )!;
    expect(applied.memberships.find((item) => item.recordId === record.id)).toMatchObject({
      projectId: project.id,
      categoryId: category.id,
    });
    expect(moves).toHaveLength(0);
    await engine.undoCollection(proposal.id);
    expect((await engine.state()).memberships).toEqual(before.memberships);
  });
  it('applies a reviewed whole-collection taxonomy and snapshots native project grouping', async () => {
    const app = await engine.state();
    const records = app.records;
    const proposal = await engine.saveCollectionProposal({
      summary: 'Three tabs form a work context.',
      projects: [
        {
          name: 'Work planning',
          purpose: 'Track work',
          areaName: 'Work',
          categories: [{ name: 'Planning', description: 'Planning references' }],
        },
      ],
      assignments: records.map((record) => ({
        recordId: record.id,
        url: record.url,
        navigationVersion: record.navigationVersion,
        projectName: 'Work planning',
        categoryName: 'Planning',
        reason: 'Matching work context',
        confidence: 0.8,
      })),
      unresolvedRecordIds: [],
    });
    await engine.applyCollectionProposal(proposal.id);
    const result = await engine.state();
    expect(result.areas.map((area) => area.name)).toContain('Work');
    expect(result.projects.map((project) => project.name)).toContain('Work planning');
    expect(
      result.memberships.filter((membership) => membership.source === 'accepted-ai'),
    ).toHaveLength(3);
    expect(moves).toHaveLength(0);
    const accepted = result.collectionProposals.find((item) => item.id === proposal.id)!;
    const actions = nativeGroupActions(accepted, result);
    expect(actions).toHaveLength(2);
    expect(actions.map((action) => action.windowId).sort()).toEqual([1, 2]);
    const operation = await engine.applyPlan({
      summary: 'Group reviewed collection tabs',
      actions,
    });
    expect(operation.status).toBe('complete');
    expect(moves).toHaveLength(0);
    expect((await database.operations.toArray()).at(-1)?.snapshotId).toBeTruthy();
    expect(
      (await engine.state()).records.filter(
        (record) => record.windowId === 1 && record.groupId >= 0,
      ),
    ).toHaveLength(2);
    expect(
      (await engine.state()).records.filter(
        (record) => record.windowId === 2 && record.groupId >= 0,
      ),
    ).toHaveLength(1);
  });
  it('accepts projects spanning windows without creating or moving browser tabs', async () => {
    const before = await engine.state();
    const records = before.records;
    const proposal = await engine.saveCollectionProposal({
      summary: 'Virtual projects in existing browser placement.',
      projects: [
        {
          name: 'Research',
          purpose: '',
          areaName: 'Work',
          categories: [{ name: 'Reading', description: '' }],
        },
        {
          name: 'Daily',
          purpose: '',
          areaName: 'Personal',
          categories: [{ name: 'Routine', description: '' }],
        },
      ],
      assignments: [
        {
          recordId: records[0]!.id,
          url: records[0]!.url,
          navigationVersion: 0,
          projectName: 'Research',
          categoryName: 'Reading',
          reason: '',
          confidence: 0.8,
        },
        {
          recordId: records[1]!.id,
          url: records[1]!.url,
          navigationVersion: 0,
          projectName: 'Daily',
          categoryName: 'Routine',
          reason: '',
          confidence: 0.8,
        },
        {
          recordId: records[2]!.id,
          url: records[2]!.url,
          navigationVersion: 0,
          projectName: 'Research',
          categoryName: 'Reading',
          reason: '',
          confidence: 0.8,
        },
      ],
      unresolvedRecordIds: [],
    });
    const accepted = await engine.applyCollectionProposal(proposal.id);
    const after = await engine.state();
    expect(accepted.status).toBe('applied');
    expect(after.projects).toHaveLength(2);
    expect(after.memberships).toHaveLength(3);
    expect(after.windows.map((window) => window.projectId)).toEqual([null, null]);
    expect([...tabs.values()].map((tab) => [tab.id, tab.windowId, tab.groupId])).toEqual([
      [11, 1, -1],
      [12, 1, -1],
      [13, 2, -1],
    ]);
    expect(moves).toHaveLength(0);
    expect(await database.operations.toArray()).toHaveLength(0);
    await expect(engine.applyCollectionProposal(proposal.id)).rejects.toThrow('no longer pending');
    await engine.undoCollection(proposal.id);
    expect((await engine.state()).memberships).toEqual(before.memberships);
    expect(tabs.size).toBe(3);
  });
  it('keeps new and moved tabs in Inbox despite a bound window and native group', async () => {
    const project = await engine.project({ name: 'Research', windowId: 1 });
    const initial = await engine.state();
    expect(initial.records.find((record) => record.tabId === 11)?.projectId).toBe(project.id);
    addTab(14, 1, 'https://example.com/random');
    tabs.get(14)!.groupId = 77;
    const created = (await engine.state()).records.find((record) => record.tabId === 14)!;
    expect(created.projectId).toBeNull();
    expect(
      (await engine.state()).memberships.find((entry) => entry.recordId === created.id),
    ).toMatchObject({ projectId: null, categoryId: null, source: 'unassigned' });
    tabs.get(14)!.windowId = 2;
    expect(
      (await engine.state()).records.find((record) => record.id === created.id)?.projectId,
    ).toBeNull();
    tabs.get(14)!.windowId = 1;
    local.settings = { ...DEFAULTS, maintainCollectionReview: true };
    expect(await engine.queueOrganizationTab(14)).toMatchObject({
      recordId: created.id,
      kind: 'collection',
    });
  });
  it('reuses an older draft and returns its uncertain tabs to Inbox with reversible receipts', async () => {
    const original = await engine.project({ name: 'Old window project', windowId: 1 });
    const before = await engine.state();
    const first = before.records.find((record) => record.tabId === 11)!;
    const uncertain = before.records.find((record) => record.tabId === 12)!;
    const proposal = await engine.saveCollectionProposal({
      summary: 'Saved before workspace redesign',
      projects: [
        {
          name: 'Research',
          purpose: '',
          areaName: 'Work',
          categories: [{ name: 'Reading', description: '' }],
        },
      ],
      assignments: [
        {
          recordId: first.id,
          url: first.url,
          navigationVersion: first.navigationVersion,
          projectName: 'Research',
          categoryName: 'Reading',
          reason: 'Title evidence',
          confidence: 0.8,
        },
      ],
      unresolvedRecordIds: before.records
        .filter((record) => record.id !== first.id)
        .map((record) => record.id),
    });
    await engine.applyCollectionProposal(proposal.id);
    const after = await engine.state();
    expect(after.records.find((record) => record.id === uncertain.id)?.projectId).toBeNull();
    expect(tabs.get(12)?.windowId).toBe(1);
    expect(moves).toHaveLength(0);
    await engine.undoCollection(proposal.id);
    expect(
      (await engine.state()).records.find((record) => record.id === uncertain.id)?.projectId,
    ).toBe(original.id);
  });
  it('persists an owner Inbox choice across reconciliation, movement and portable backup', async () => {
    const project = await engine.project({ name: 'Research', windowId: 1 });
    const record = (await engine.state()).records.find((item) => item.tabId === 11)!;
    await engine.assignMembership({ recordIds: [record.id], projectId: null, categoryId: null });
    tabs.get(11)!.windowId = 2;
    tabs.get(11)!.groupId = 77;
    const updated = await engine.state();
    expect(updated.records.find((item) => item.id === record.id)?.projectId).toBeNull();
    expect(updated.memberships.find((item) => item.recordId === record.id)).toMatchObject({
      projectId: null,
      source: 'owner',
    });
    expect(await engine.queueOrganizationTab(11)).toBeUndefined();
    await engine.snapshot('Inbox correction');
    const backup = await engine.exportBackup();
    await engine.importBackup(backup);
    const imported = await engine.state();
    const copy = imported.memberships.find(
      (item) => item.recordId !== record.id && item.projectId === null && item.source === 'owner',
    )!;
    expect(copy).toBeDefined();
    const snapshot = imported.snapshots.find(
      (item) => item.label === 'Imported: Inbox correction',
    )!;
    expect(
      (await getStoredEntity('snapshots', snapshot.id))!.windows
        .flatMap((item) => item.tabs)
        .some((item) => item.recordId === copy.recordId),
    ).toBe(true);
    await engine.assignMembership({
      recordIds: [record.id],
      projectId: project.id,
      categoryId: null,
    });
    expect((await engine.state()).records.find((item) => item.id === record.id)?.projectId).toBe(
      project.id,
    );
  });
  it('keeps ongoing review for a project tab outside a bound project window', async () => {
    const project = await engine.project({ name: 'Research' });
    const record = (await engine.state()).records.find((item) => item.tabId === 11)!;
    await database.memberships.put({
      recordId: record.id,
      projectId: project.id,
      categoryId: null,
      source: 'accepted-ai',
      updatedAt: Date.now(),
    });
    local.settings = {
      ...DEFAULTS,
      maintainCollectionReview: true,
      reviewProjectWindowsOnly: true,
    };
    expect(await engine.queueOrganizationTab(11)).toMatchObject({ recordId: record.id });
    expect(await engine.queueOrganizationTab(12)).toBeUndefined();
  });
  it('persists owner edits to collection assignments and lets uncertain occurrences stay unassigned', async () => {
    const records = (await engine.state()).records;
    const proposal = await engine.saveCollectionProposal({
      summary: 'Review these references.',
      projects: [
        {
          name: 'Work',
          purpose: 'Work references.',
          areaName: 'Work',
          categories: [
            { name: 'Planning', description: 'Plans.' },
            { name: 'Research', description: 'Sources.' },
          ],
        },
      ],
      assignments: records.map((record) => ({
        recordId: record.id,
        url: record.url,
        navigationVersion: record.navigationVersion,
        projectName: 'Work',
        categoryName: 'Planning',
        reason: 'Initial proposal.',
        confidence: 0.7,
      })),
      unresolvedRecordIds: [],
    });
    const edited = await engine.updateCollectionProposal(proposal.id, {
      summary: proposal.summary,
      projects: proposal.projects,
      assignments: proposal.assignments
        .filter((assignment) => assignment.recordId !== records[1]?.id)
        .map((assignment, index) => ({
          ...assignment,
          categoryName: index === 0 ? 'Research' : assignment.categoryName,
          reason: 'Owner reviewed this assignment.',
          confidence: 1,
        })),
      unresolvedRecordIds: [records[1]!.id],
      ownerAssignedRecordIds: [records[0]!.id],
    });
    expect(edited.assignments[0]?.categoryName).toBe('Research');
    expect(edited.unresolvedRecordIds).toContain(records[1]!.id);
    await engine.applyCollectionProposal(proposal.id);
    const state = await engine.state();
    expect(state.memberships.filter((membership) => membership.source === 'owner')).toHaveLength(1);
    expect(
      state.memberships.filter((membership) => membership.source === 'accepted-ai'),
    ).toHaveLength(1);
  });
  it('extends a pending partial collection only through the validated expansion path', async () => {
    const records = (await engine.state()).records;
    const first = records[0]!;
    const proposal = await engine.saveCollectionProposal({
      summary: 'First page',
      projects: [
        {
          name: 'Research',
          purpose: 'Sources',
          areaName: 'Personal',
          categories: [{ name: 'References', description: '' }],
        },
      ],
      assignments: [
        {
          recordId: first.id,
          url: first.url,
          navigationVersion: first.navigationVersion,
          projectName: 'Research',
          categoryName: 'References',
          reason: 'Reviewed',
          confidence: 0.9,
        },
      ],
      unresolvedRecordIds: [],
      scopeRecordIds: [first.id],
    });
    const expanded = {
      summary: 'All tabs',
      projects: proposal.projects,
      assignments: proposal.assignments,
      unresolvedRecordIds: records.slice(1).map((item) => item.id),
      scopeRecordIds: records.map((item) => item.id),
    };
    await expect(engine.updateCollectionProposal(proposal.id, expanded)).rejects.toThrow(
      /cannot change its analysis scope/,
    );
    await expect(
      engine.updateCollectionProposal(
        proposal.id,
        { ...expanded, assignments: [{ ...expanded.assignments[0]!, reason: 'Rewritten' }] },
        true,
      ),
    ).rejects.toThrow(/preserve its reviewed assignments/);
    const saved = await engine.updateCollectionProposal(proposal.id, expanded, true);
    expect(saved.id).toBe(proposal.id);
    expect(saved.scopeRecordIds).toHaveLength(records.length);
    expect(saved.assignments).toEqual(proposal.assignments);
  });
  it('keeps independent pending collection drafts and edits only the chosen ID', async () => {
    const first = (await engine.state()).records[0]!;
    const draft = {
      summary: 'First idea',
      projects: [
        {
          name: 'Research',
          purpose: 'Sources',
          areaName: 'Personal',
          categories: [{ name: 'References', description: '' }],
        },
      ],
      assignments: [
        {
          recordId: first.id,
          url: first.url,
          navigationVersion: first.navigationVersion,
          projectName: 'Research',
          categoryName: 'References',
          reason: 'Title',
          confidence: 0.9,
        },
      ],
      unresolvedRecordIds: [],
      scopeRecordIds: [first.id],
    };
    const older = await engine.saveCollectionProposal(draft);
    const newer = await engine.saveCollectionProposal({ ...draft, summary: 'Second idea' });
    expect(newer.id).not.toBe(older.id);
    await engine.updateCollectionProposal(older.id, { ...draft, summary: 'Edited first idea' });
    const proposals = (await engine.state()).collectionProposals;
    expect(proposals.find((item) => item.id === older.id)?.summary).toBe('Edited first idea');
    expect(proposals.find((item) => item.id === newer.id)?.summary).toBe('Second idea');
  });
  it('persists analysis batches and rejects replay or rewriting completed decisions', async () => {
    const record = (await engine.state()).records[0]!;
    const initial = {
      id: 'resume-analysis',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      revision: 1,
      purpose: 'proposal' as const,
      instruction: 'Organize all tabs',
      reuseAcceptedTaxonomyOnly: false,
      scope: [{ id: record.id, url: record.url, navigationVersion: record.navigationVersion }],
      discoveredIds: [record.id],
      classifiedIds: [],
      projects: [
        {
          name: 'Research',
          purpose: 'Sources',
          areaName: 'Personal',
          categories: [{ name: 'References', description: '' }],
        },
      ],
      summaries: ['Research'],
      assignments: [],
      unresolvedRecordIds: [],
    };
    initial.projects.push({
      name: 'Personal inbox',
      purpose: 'Communication',
      areaName: 'Personal',
      categories: [],
    });
    await engine.saveCollectionAnalysis(initial);
    const decided = {
      ...initial,
      revision: 2,
      classifiedIds: [record.id],
      assignments: [
        {
          recordId: record.id,
          url: record.url,
          navigationVersion: record.navigationVersion,
          projectName: 'Research',
          categoryName: 'References',
          reason: 'Title',
          confidence: 0.9,
        },
      ],
    };
    await engine.saveCollectionAnalysis(decided);
    expect((await engine.getCollectionAnalysis(initial.id))?.classifiedIds).toEqual([record.id]);
    await expect(engine.saveCollectionAnalysis(decided)).rejects.toThrow(/another view/);
    await expect(
      engine.saveCollectionAnalysis({
        ...decided,
        revision: 3,
        assignments: [{ ...decided.assignments[0]!, reason: 'Changed' }],
      }),
    ).rejects.toThrow(/cannot be rewritten/);
    const repaired = await engine.saveCollectionAnalysis({
      ...decided,
      revision: 3,
      projects: decided.projects.map((project) =>
        project.name === 'Personal inbox'
          ? { ...project, categories: [{ name: 'Inbox', description: 'Inbox pages' }] }
          : project,
      ),
    });
    expect(repaired.classifiedIds).toEqual([record.id]);
    expect(repaired.assignments).toEqual(decided.assignments);
    await expect(
      engine.saveCollectionAnalysis({
        ...repaired,
        revision: 4,
        projects: repaired.projects.map((project) => ({
          ...project,
          name: project.name + ' changed',
        })),
      }),
    ).rejects.toThrow(/cannot be rewritten/);
  });
  it('persists action batches independently of chat and rejects a rewritten completed batch', async () => {
    const record = (await engine.state()).records[0]!;
    const initial = {
      id: 'durable-action-plan',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      revision: 1,
      status: 'pending' as const,
      instruction: 'Group this tab',
      mode: 'generative' as const,
      readOnly: false,
      allowCrossWindowMove: false,
      allowSleepWake: false,
      scope: [
        {
          id: record.id,
          url: record.url,
          navigationVersion: record.navigationVersion,
          windowId: record.windowId!,
          groupId: record.groupId,
        },
      ],
      completedIds: [] as string[],
      actions: [] as import('../src/shared/types').PlanAction[],
      matchIds: [] as string[],
      summaries: [] as import('../src/shared/types').ActionAnalysis['summaries'],
    };
    await engine.saveActionAnalysis(initial);
    const action = {
      type: 'group' as const,
      recordIds: [record.id],
      windowId: record.windowId,
      name: 'Code',
      color: 'blue' as const,
    };
    const completed = await engine.saveActionAnalysis({
      ...initial,
      revision: 2,
      completedIds: [record.id],
      actions: [action],
      summaries: [{ recordIds: [record.id], text: 'Grouped', model: 'first-model' }],
    });
    expect(
      (await engine.listActionAnalyses()).find((item) => item.id === initial.id)?.completedIds,
    ).toEqual([record.id]);
    await expect(
      engine.saveActionAnalysis({
        ...completed,
        revision: 3,
        actions: [{ ...action, name: 'Other' }],
      }),
    ).rejects.toThrow(/cannot be rewritten/);
    await expect(engine.saveActionAnalysis({ ...completed, revision: 2 })).rejects.toThrow(
      /another view/,
    );
    const final = await engine.saveActionAnalysis({
      ...completed,
      revision: 3,
      status: 'complete',
    });
    expect(final.status).toBe('complete');
    expect((await engine.listActionAnalyses()).some((item) => item.id === initial.id)).toBe(false);
  });
  it('persists a failed batch until retry completes and rejects completed batch failures', async () => {
    const record = (await engine.state()).records[0]!;
    const initial = {
      id: 'failed-batch-analysis',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      revision: 1,
      purpose: 'proposal' as const,
      instruction: '',
      reuseAcceptedTaxonomyOnly: false,
      scope: [{ id: record.id, url: record.url, navigationVersion: record.navigationVersion }],
      discoveredIds: [record.id],
      classifiedIds: [],
      projects: [
        {
          name: 'Research',
          purpose: 'Sources',
          areaName: 'Personal',
          categories: [{ name: 'References', description: '' }],
        },
      ],
      summaries: ['Research'],
      assignments: [],
      unresolvedRecordIds: [],
      failedBatch: {
        stage: 'classification' as const,
        recordIds: [record.id],
        attempts: 3,
        error: 'Output limit',
        failedAt: Date.now(),
      },
    };
    await engine.saveCollectionAnalysis(initial);
    expect((await engine.getCollectionAnalysis(initial.id))?.failedBatch?.recordIds).toEqual([
      record.id,
    ]);
    await expect(
      engine.saveCollectionAnalysis({
        ...initial,
        revision: 2,
        classifiedIds: [record.id],
        unresolvedRecordIds: [record.id],
      }),
    ).rejects.toThrow(/Failed batch/);
    await engine.saveCollectionAnalysis({
      ...initial,
      revision: 2,
      classifiedIds: [record.id],
      unresolvedRecordIds: [record.id],
      failedBatch: undefined,
    });
    expect((await engine.getCollectionAnalysis(initial.id))?.failedBatch).toBeUndefined();
    const tagged = await engine.saveCollectionAnalysis({
      ...initial,
      id: 'durable-tags',
      revision: 1,
      classifiedIds: [record.id],
      failedBatch: undefined,
      assignments: [
        {
          recordId: record.id,
          url: record.url,
          navigationVersion: record.navigationVersion,
          projectName: 'Research',
          categoryName: 'References',
          reason: 'Evidence',
          confidence: 0.9,
          suggestedTags: ['reference'],
        },
      ],
      tagVocabulary: ['reference', 'Vue'],
    });
    const failedTags = await engine.saveCollectionAnalysis({
      ...tagged,
      revision: 2,
      tagChecks: [{ recordId: record.id, tag: 'reference', selected: true, confidence: 0.9 }],
      failedBatch: {
        stage: 'tagging',
        recordIds: [record.id],
        attempts: 3,
        error: 'Interrupted tag batch',
        failedAt: Date.now(),
      },
    });
    expect((await engine.getCollectionAnalysis(tagged.id))?.assignments[0]?.suggestedTags).toEqual([
      'reference',
    ]);
    expect((await engine.getCollectionAnalysis(tagged.id))?.tagChecks).toHaveLength(1);
    await expect(
      engine.saveCollectionAnalysis({
        ...failedTags,
        revision: 3,
        tagChecks: [{ recordId: record.id, tag: 'reference', selected: false, confidence: 0.9 }],
      }),
    ).rejects.toThrow('cannot be duplicated, invented or rewritten');
  });
  it('rebases one navigated occurrence while retaining other completed classifications', async () => {
    const records = (await engine.state()).records.slice(0, 2);
    const [changed, retained] = records;
    expect(changed).toBeDefined();
    expect(retained).toBeDefined();
    const analysis = {
      id: 'navigated-analysis',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      revision: 1,
      purpose: 'proposal' as const,
      instruction: '',
      reuseAcceptedTaxonomyOnly: false,
      scope: records.map(({ id, url, navigationVersion }) => ({ id, url, navigationVersion })),
      discoveredIds: records.map((record) => record.id),
      classifiedIds: records.map((record) => record.id),
      projects: [
        {
          name: 'Research',
          purpose: 'Sources',
          areaName: 'Personal',
          categories: [{ name: 'References', description: '' }],
        },
      ],
      summaries: ['Research'],
      assignments: records.map((record) => ({
        recordId: record.id,
        url: record.url,
        navigationVersion: record.navigationVersion,
        projectName: 'Research',
        categoryName: 'References',
        reason: 'Title',
        confidence: 0.9,
      })),
      unresolvedRecordIds: [],
    };
    await engine.saveCollectionAnalysis(analysis);
    await database.records.put({ ...changed!, navigationVersion: changed!.navigationVersion + 1 });
    await expect(engine.saveCollectionAnalysis({ ...analysis, revision: 2 })).rejects.toThrow(
      /tab changed/,
    );
    const rebased = await engine.rebaseCollectionAnalysis(analysis.id);
    expect(rebased.scope.find((item) => item.id === changed!.id)?.navigationVersion).toBe(
      changed!.navigationVersion + 1,
    );
    expect(rebased.classifiedIds).toEqual([retained!.id]);
    expect(rebased.assignments.map((item) => item.recordId)).toEqual([retained!.id]);
    expect(rebased.discoveredIds).toEqual(records.map((record) => record.id));
    expect(rebased.revision).toBe(2);
  });
  it('rebases a changed action-plan occurrence while keeping the other completed batch', async () => {
    const [changed, retained] = (await engine.state()).records.slice(0, 2);
    expect(changed).toBeDefined();
    expect(retained).toBeDefined();
    const scope = [changed!, retained!].map((record) => ({
      id: record.id,
      url: record.url,
      navigationVersion: record.navigationVersion,
      windowId: record.windowId!,
      groupId: record.groupId,
    }));
    await engine.saveActionAnalysis({
      id: 'changed-action-batch',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      revision: 1,
      status: 'pending',
      instruction: 'Find both',
      mode: 'generative',
      readOnly: true,
      allowCrossWindowMove: false,
      allowSleepWake: false,
      scope,
      completedIds: [changed!.id, retained!.id],
      actions: [],
      matchIds: [changed!.id, retained!.id],
      summaries: [
        { recordIds: [changed!.id], text: 'First', model: 'first-model' },
        { recordIds: [retained!.id], text: 'Second', model: 'first-model' },
      ],
    });
    await database.records.put({ ...changed!, navigationVersion: changed!.navigationVersion + 1 });
    const rebased = await engine.rebaseActionAnalysis('changed-action-batch');
    expect(rebased.completedIds).toEqual([retained!.id]);
    expect(rebased.matchIds).toEqual([retained!.id]);
    expect(rebased.summaries.map((item) => item.text)).toEqual(['Second']);
    expect(rebased.scope.find((item) => item.id === changed!.id)?.navigationVersion).toBe(
      changed!.navigationVersion + 1,
    );
    expect(rebased.status).toBe('pending');
  });
  it('rebases a saved project draft without losing its completed choice or project suggestion', async () => {
    const [retained, changed] = (await engine.state()).records.slice(0, 2);
    expect(retained).toBeDefined();
    expect(changed).toBeDefined();
    const analysis = {
      id: 'project-analysis:research',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      revision: 1,
      purpose: 'project' as const,
      instruction: 'project:research:1',
      reuseAcceptedTaxonomyOnly: false,
      scope: [retained!, changed!].map(({ id, url, navigationVersion }) => ({
        id,
        url,
        navigationVersion,
      })),
      discoveredIds: [retained!.id, changed!.id],
      classifiedIds: [retained!.id],
      projects: [
        {
          name: 'Research',
          purpose: '',
          areaName: 'General',
          categories: [{ name: 'Sources', description: '' }],
        },
      ],
      projectSuggestion: { name: 'Research notes', purpose: 'Compare sources' },
      summaries: ['Source references'],
      assignments: [
        {
          recordId: retained!.id,
          url: retained!.url,
          navigationVersion: retained!.navigationVersion,
          projectName: 'Research',
          categoryName: 'Sources',
          reason: 'Reference title',
          confidence: 0.9,
        },
      ],
      unresolvedRecordIds: [],
    };
    await engine.saveCollectionAnalysis(analysis);
    await database.records.put({ ...changed!, navigationVersion: changed!.navigationVersion + 1 });
    const rebased = await engine.rebaseCollectionAnalysis(analysis.id);
    expect(rebased.classifiedIds).toEqual([retained!.id]);
    expect(rebased.assignments).toEqual(analysis.assignments);
    expect(rebased.projectSuggestion).toEqual(analysis.projectSuggestion);
    expect(rebased.scope[1]?.navigationVersion).toBe(changed!.navigationVersion + 1);
  });
  it('keeps a saved collection draft and reopens only changed occurrences for review', async () => {
    const records = (await engine.state()).records;
    const proposal = await engine.saveCollectionProposal({
      summary: 'Candidate work project.',
      projects: [
        {
          name: 'Reading',
          purpose: 'Read later',
          areaName: 'Personal',
          categories: [{ name: 'Articles', description: 'Reading' }],
        },
      ],
      assignments: records.map((record) => ({
        recordId: record.id,
        url: record.url,
        navigationVersion: record.navigationVersion,
        projectName: 'Reading',
        categoryName: 'Articles',
        reason: 'Article title',
        confidence: 0.7,
      })),
      unresolvedRecordIds: [],
    });
    tabs.get(11)!.url = 'https://example.com/new-page';
    await expect(engine.applyCollectionProposal(proposal.id)).rejects.toThrow('Sync changed tabs');
    expect(
      (await engine.state()).collectionProposals.find((entry) => entry.id === proposal.id)?.status,
    ).toBe('pending');
    const rebased = await engine.rebaseCollectionProposal(proposal.id, {
      summary: 'Owner edited summary',
      projects: [
        {
          name: 'Reading edited',
          purpose: 'Read later',
          areaName: 'Personal',
          categories: [{ name: 'Articles', description: 'Reading' }],
        },
      ],
      assignments: proposal.assignments.map((assignment) => ({
        ...assignment,
        projectName: 'Reading edited',
      })),
      unresolvedRecordIds: [],
    });
    expect(rebased.summary).toBe('Owner edited summary');
    expect(rebased.assignments).toHaveLength(2);
    expect(rebased.unresolvedRecordIds).toHaveLength(1);
    expect(rebased.unresolvedRecordIds).toContain(
      records.find((record) => record.tabId === 11)!.id,
    );
    await engine.applyCollectionProposal(proposal.id);
    const result = await engine.state();
    expect(
      result.memberships.filter((membership) => membership.source === 'accepted-ai'),
    ).toHaveLength(2);
    expect(result.collectionProposals.find((entry) => entry.id === proposal.id)?.status).toBe(
      'applied',
    );
  });
  it('persists daily work contexts and links follow-ups to exact tab occurrences', async () => {
    const area = await engine.saveArea({ name: 'Personal', description: 'Life admin' });
    const record = (await engine.state()).records.find((item) => item.tabId === 11)!;
    const item = await engine.saveWorkItem({
      title: 'Reply to the landlord',
      areaId: area.id,
      recordId: record.id,
      dueAt: 123456,
      priority: 'high',
    });
    expect(item).toMatchObject({
      title: 'Reply to the landlord',
      areaId: area.id,
      recordId: record.id,
      url: record.url,
      source: 'tab',
      priority: 'high',
    });
    expect((await engine.state()).workItems).toContainEqual(item);
    await expect(
      engine.saveWorkItem({ title: 'Invalid link', recordId: 'missing', source: 'tab' }),
    ).rejects.toThrow('tab is no longer open');
    await expect(engine.saveArea({ name: 'personal' })).rejects.toThrow('already exist');
  });
  it('exports and imports contexts and work without retaining a dead live-tab identity', async () => {
    const area = await engine.saveArea({ name: 'Home' });
    const project = await engine.project({
      name: 'Household',
      purpose: 'Home administration',
      areaId: area.id,
    });
    await engine.saveWorkItem({
      title: 'Review the utility bill',
      areaId: area.id,
      recordId: (await engine.state()).records.find((item) => item.tabId === 11)?.id,
      source: 'tab',
    });
    const backup = await engine.exportBackup();
    expect(backup.schema).toBe(6);
    await engine.importBackup(backup);
    const imported = (await database.workItems.toArray()).find(
      (item) => item.title === 'Review the utility bill' && item.id !== backup.workItems?.[0]?.id,
    );
    expect(imported).toMatchObject({
      areaId: expect.not.stringContaining(area.id),
      recordId: null,
      url: 'https://example.com/one',
      source: 'owner',
    });
    const importedProject = (await database.projects.toArray()).find(
      (item) => item.name === project.name && item.id !== project.id,
    );
    expect(importedProject?.areaId).toBeTruthy();
    expect(importedProject?.areaId).not.toBe(area.id);
  });
  it('snapshots and reorders through the browser tab API', async () => {
    const app = await engine.state();
    const first = app.records.find((record) => record.tabId === 11)!;
    await engine.applyPlan({
      summary: 'Reorder tab',
      actions: [{ type: 'reorder', recordIds: [first.id], index: 1 }],
    });
    expect(moves.at(-1)).toEqual({ ids: 11, windowId: 1, index: 1 });
    expect(await database.snapshots.count()).toBe(1);
    expect((await database.operations.toArray()).at(-1)?.actions[0]?.type).toBe('reorder');
  });
  it('preserves distinct duplicate tab occurrences', async () => {
    addTab(14, 2, 'https://example.com/one', 1);
    const app = await engine.state();
    expect(app.records).toHaveLength(4);
    expect(new Set(app.records.map((r) => r.id)).size).toBe(4);
  });
  it('suspends in place and snapshots original addresses', async () => {
    const app = await engine.state();
    const r = app.records.find((r) => r.tabId === 11)!;
    const op = await engine.applyPlan({
      summary: 'Sleep',
      actions: [{ type: 'suspend', recordIds: [r.id] }],
    });
    expect(op.status).toBe('complete');
    expect(tabs.get(11)?.url).toContain('/suspended.html#');
    expect(tabs.get(11)?.windowId).toBe(1);
    const s = (await getStoredEntity('snapshots', op.snapshotId))!;
    expect(s.windows.flatMap((w) => w.tabs).find((t) => t.recordId === r.id)?.url).toBe(
      'https://example.com/one',
    );
  });
  it('undoes suspension without replacing the browser tab slot', async () => {
    const r = (await engine.state()).records.find((r) => r.tabId === 11)!;
    const op = await engine.applyPlan({
      summary: 'Sleep',
      actions: [{ type: 'suspend', recordIds: [r.id] }],
    });
    const result = await engine.undoOperation(op.id);
    expect(result.every((r) => r.ok)).toBe(true);
    expect(tabs.get(11)?.url).toBe('https://example.com/one');
    expect(tabs.size).toBe(3);
  });
  it('protects dirty inputs from suspension', async () => {
    dirty = true;
    const r = (await engine.state()).records.find((r) => r.tabId === 11)!;
    const result = await engine.applyPlan({
      summary: 'Sleep',
      actions: [{ type: 'suspend', recordIds: [r.id] }],
    });
    expect(result.results[0]?.outcomes?.[0]?.skipped).toContain('Unsaved');
    expect(tabs.get(11)?.url).toBe('https://example.com/one');
  });
  it('rejects stale plans after navigation', async () => {
    const r = (await engine.state()).records.find((r) => r.tabId === 11)!;
    tabs.get(11)!.url = 'https://example.com/new';
    await expect(
      engine.applyPlan({
        summary: 'Stale',
        actions: [{ type: 'suspend', recordIds: [r.id] }],
        expected: { [r.id]: { url: r.url, navigationVersion: r.navigationVersion } },
      }),
    ).rejects.toThrow(/stale/);
  });
  it('restores missing tabs as suspended placeholders', async () => {
    const s = await engine.snapshot('Before close');
    tabs.delete(12);
    await engine.closed(12);
    const result = await engine.restoreSnapshot(s.id);
    expect(result.every((r) => r.ok)).toBe(true);
    expect(
      [...tabs.values()].some((t) => t.url?.includes('url=https%3A%2F%2Fexample.com%2Ftwo')),
    ).toBe(true);
  });
  it('does not navigate a tab the user has repurposed', async () => {
    const s = await engine.snapshot('Before navigation');
    tabs.get(11)!.url = 'https://example.com/new';
    await engine.restoreSnapshot(s.id);
    expect(tabs.get(11)?.url).toBe('https://example.com/new');
    expect(tabs.size).toBe(4);
  });
  it('migrates pinned legacy placeholders without waking pages', async () => {
    tabs.get(11)!.url =
      'chrome-extension://legacy/suspended.html#ttl=Saved&pos=5&uri=https://example.com/one';
    tabs.get(11)!.pinned = true;
    const started = await engine.migration.start();
    const result = await engine.migration.step(started.id);
    expect(result.imported).toBe(1);
    expect(tabs.get(11)?.url).toContain(origin + '/suspended.html');
    expect(tabs.get(11)?.pinned).toBe(true);
  });
  it('keeps later tabs when restoring an earlier snapshot', async () => {
    const s = await engine.snapshot('Earlier');
    addTab(14, 1, 'https://example.com/later');
    await engine.restoreSnapshot(s.id);
    expect(tabs.get(14)?.url).toBe('https://example.com/later');
  });
  it('exports original URLs while omitting cached content', async () => {
    const r = (await engine.state()).records.find((r) => r.tabId === 11)!;
    await engine.indexLoaded(r.id);
    await engine.snapshot('Export');
    const backup = await engine.exportBackup();
    expect(backup.records?.[0]).not.toHaveProperty('content');
    expect(JSON.stringify(backup)).not.toContain('/suspended.html');
  });
  it('round trips exported snapshots through strict import validation', async () => {
    await engine.snapshot('Saved');
    const backup = await engine.exportBackup();
    const result = await engine.importBackup(backup);
    expect(result.imported).toBe(backup.snapshots.length);
    expect((await engine.state()).snapshots).toHaveLength(backup.snapshots.length + 1);
  });
  it('pauses automatic suspension when page protections cannot be checked', async () => {
    hostAccess = false;
    local.settings = { ...DEFAULTS, autoSuspend: true, suspendMinutes: 5 };
    await engine.autoSuspend();
    expect([...tabs.values()].every((t) => !t.url?.includes('suspended.html'))).toBe(true);
  });
  it('clears a project assignment without restart inference resurrecting it', async () => {
    const p = await engine.project({ name: 'Project', windowId: 1 });
    expect((await engine.state()).windows.find((w) => w.id === 1)?.projectId).toBe(p.id);
    await engine.bindProject(1, null);
    expect((await engine.state()).windows.find((w) => w.id === 1)?.projectId).toBe(null);
    expect(
      (await engine.state()).records
        .filter((r) => r.windowId === 1)
        .every((r) => r.projectId === null),
    ).toBe(true);
  });
  it('persists owner category corrections by tab occurrence across refreshes', async () => {
    const p = await engine.project({
      name: 'Research',
      windowId: 1,
      purpose: 'Compare source material',
    });
    const category = await engine.saveCategory({ projectId: p.id, name: 'Primary sources' });
    const tab = (await engine.state()).records.find((record) => record.tabId === 11)!;
    await engine.assignMembership({
      recordIds: [tab.id],
      projectId: p.id,
      categoryId: category.id,
    });

    const refreshed = await engine.state();
    const membership = refreshed.memberships.find((entry) => entry.recordId === tab.id);
    expect(refreshed.projects.find((project) => project.id === p.id)?.purpose).toBe(
      'Compare source material',
    );
    expect(membership).toMatchObject({ projectId: p.id, categoryId: category.id, source: 'owner' });
    expect(refreshed.categories.find((entry) => entry.id === category.id)?.name).toBe(
      'Primary sources',
    );
  });
  it('exports and imports project categories with occurrence identity linked to snapshots', async () => {
    const project = await engine.project({
      name: 'Research',
      windowId: 1,
      purpose: 'Compare sources',
    });
    const category = await engine.saveCategory({
      projectId: project.id,
      name: 'Primary sources',
      color: 'purple',
    });
    const tab = (await engine.state()).records.find((record) => record.tabId === 11)!;
    await engine.assignMembership({
      recordIds: [tab.id],
      projectId: project.id,
      categoryId: category.id,
    });
    await engine.snapshot('Before import');
    const backup = await engine.exportBackup();
    expect(backup.memberships?.find((entry) => entry.recordId === tab.id)?.categoryId).toBe(
      category.id,
    );

    await engine.importBackup(backup);

    const app = await engine.state();
    const importedProject = app.projects.find((entry) => entry.id !== project.id)!;
    const importedCategory = app.categories.find(
      (entry) => entry.projectId === importedProject.id,
    )!;
    const importedMembership = app.memberships.find(
      (entry) => entry.projectId === importedProject.id && entry.source === 'owner',
    )!;
    const importedSnapshot = app.snapshots.find(
      (entry) => entry.label === 'Imported: Before import',
    )!;
    expect(importedProject.purpose).toBe('Compare sources');
    expect(importedMembership.categoryId).toBe(importedCategory.id);
    expect(importedCategory.color).toBe('purple');
    await engine.saveCategory({ id: category.id, projectId: project.id, name: 'Sources renamed' });
    expect((await engine.state()).categories.find((entry) => entry.id === category.id)?.color).toBe(
      'purple',
    );
    expect(importedMembership.recordId).not.toBe(tab.id);
    expect(
      (await getStoredEntity('snapshots', importedSnapshot.id))!.windows
        .flatMap((window) => window.tabs)
        .map((entry) => entry.recordId),
    ).toContain(importedMembership.recordId);
  });
  it('keeps a reviewed project proposal valid when only category color changes', async () => {
    const project = await engine.project({ name: 'Research', windowId: 1 });
    const category = await engine.saveCategory({
      projectId: project.id,
      name: 'Sources',
      description: 'Original references',
    });
    const before = await engine.state();
    const record = before.records.find((item) => item.tabId === 11)!;
    const revision = before.projects.find((item) => item.id === project.id)!.revision;
    const proposal = await engine.saveOrganizationProposal({
      projectId: project.id,
      projectRevision: revision,
      summary: 'Source',
      categories: [],
      assignments: [
        {
          recordId: record.id,
          url: record.url,
          navigationVersion: record.navigationVersion,
          categoryName: category.name,
          reason: 'Source title',
          confidence: 0.8,
        },
      ],
      unresolvedRecordIds: [],
    });
    await engine.saveCategory({
      id: category.id,
      projectId: project.id,
      name: category.name,
      color: 'purple',
    });
    const after = await engine.state();
    expect(after.projects.find((item) => item.id === project.id)?.revision).toBe(revision);
    expect(after.categories.find((item) => item.id === category.id)?.description).toBe(
      'Original references',
    );
    await engine.applyOrganizationProposal(proposal.id);
    expect(
      (await engine.state()).memberships.find((item) => item.recordId === record.id)?.categoryId,
    ).toBe(category.id);
  });
  it('applies a reviewable organization proposal only to semantic project state', async () => {
    const project = await engine.project({ name: 'Research', windowId: 1 });
    const tab = (await engine.state()).records.find((record) => record.tabId === 11)!;
    const proposal = await engine.saveOrganizationProposal({
      projectId: project.id,
      projectRevision: project.revision,
      summary: 'One primary source.',
      categories: [{ name: 'Primary sources', description: 'Original sources.' }],
      assignments: [
        {
          recordId: tab.id,
          url: tab.url,
          navigationVersion: tab.navigationVersion,
          categoryName: 'Primary sources',
          reason: 'Repository title.',
          confidence: 0.9,
        },
      ],
      unresolvedRecordIds: [],
    });

    await engine.applyOrganizationProposal(proposal.id);

    const app = await engine.state();
    const membership = app.memberships.find((entry) => entry.recordId === tab.id);
    expect(app.proposals.find((entry) => entry.id === proposal.id)?.status).toBe('applied');
    expect(membership?.source).toBe('accepted-ai');
    expect(app.categories.some((entry) => entry.id === membership?.categoryId)).toBe(true);
    expect(tabs.get(11)?.groupId).toBe(-1);
  });
  it('applies project identity suggestions only when the owner selects each field', async () => {
    const project = await engine.project({
      name: 'New project',
      purpose: 'Existing owner context',
    });
    const tab = (await engine.state()).records.find((record) => record.tabId === 11)!;
    const proposal = await engine.saveOrganizationProposal({
      projectId: project.id,
      projectRevision: project.revision,
      summary: 'A coherent software project from the selected tabs.',
      projectSuggestion: {
        name: 'Atlas Planner',
        purpose: 'Build and deploy the Atlas Planner application.',
      },
      categories: [{ name: 'Source code', description: 'Repositories and implementation.' }],
      assignments: [
        {
          recordId: tab.id,
          url: tab.url,
          navigationVersion: tab.navigationVersion,
          categoryName: 'Source code',
          reason: 'The page is a source repository.',
          confidence: 0.9,
        },
      ],
      unresolvedRecordIds: [],
    });

    await engine.applyOrganizationProposal(proposal.id, {
      projectName: true,
      projectPurpose: false,
    });

    const savedProject = (await engine.state()).projects.find((entry) => entry.id === project.id);
    expect(savedProject).toMatchObject({
      name: 'Atlas Planner',
      purpose: 'Existing owner context',
    });
    expect(tabs.get(11)?.groupId).toBe(-1);
  });
  it('remembers dismissed project suggestions and does not reopen an identical draft', async () => {
    const project = await engine.project({ name: 'New project' });
    const tab = (await engine.state()).records.find((record) => record.tabId === 11)!;
    const draft = {
      projectId: project.id,
      projectRevision: project.revision,
      summary: 'A useful project structure.',
      projectSuggestion: { name: 'Example project', purpose: 'Study this example.' },
      categories: [{ name: 'Source code', description: 'Repositories and implementation.' }],
      assignments: [
        {
          recordId: tab.id,
          url: tab.url,
          navigationVersion: tab.navigationVersion,
          categoryName: 'Source code',
          reason: 'The title identifies the repository.',
          confidence: 0.9,
        },
      ],
      unresolvedRecordIds: [],
    };
    const original = await engine.saveOrganizationProposal(draft);
    await engine.dismissOrganizationProposal(original.id);

    const duplicate = await engine.saveOrganizationProposal({
      ...draft,
      summary: 'Wording differs but the proposed decisions are the same.',
      sourceJobId: 'job-after-dismissal',
    });

    expect(duplicate.status).toBe('dismissed');
    expect(duplicate.sourceJobId).toBe('job-after-dismissal');
    expect(
      (await engine.state()).proposals.filter((proposal) => proposal.status === 'pending'),
    ).toHaveLength(0);
  });
  it('stales a pending organization proposal instead of overwriting a later owner correction', async () => {
    const created = await engine.project({ name: 'Research', windowId: 1 });
    const category = await engine.saveCategory({ projectId: created.id, name: 'Owner choice' });
    const project = (await engine.state()).projects.find((entry) => entry.id === created.id)!;
    const tab = (await engine.state()).records.find((record) => record.tabId === 11)!;
    const proposal = await engine.saveOrganizationProposal({
      projectId: project.id,
      projectRevision: project.revision,
      summary: '',
      categories: [{ name: 'Proposed', description: '' }],
      assignments: [
        {
          recordId: tab.id,
          url: tab.url,
          navigationVersion: tab.navigationVersion,
          categoryName: 'Proposed',
          reason: 'Model suggestion.',
          confidence: 0.7,
        },
      ],
      unresolvedRecordIds: [],
    });
    await engine.assignMembership({
      recordIds: [tab.id],
      projectId: project.id,
      categoryId: category.id,
    });

    await expect(engine.applyOrganizationProposal(proposal.id)).rejects.toThrow(/correction/);

    const app = await engine.state();
    expect(app.proposals.find((entry) => entry.id === proposal.id)?.status).toBe('stale');
    expect(app.memberships.find((entry) => entry.recordId === tab.id)?.categoryId).toBe(
      category.id,
    );
  });
  it('refuses to apply an organization proposal after a tab navigates', async () => {
    const project = await engine.project({ name: 'Research', windowId: 1 });
    const tab = (await engine.state()).records.find((record) => record.tabId === 11)!;
    const proposal = await engine.saveOrganizationProposal({
      projectId: project.id,
      projectRevision: project.revision,
      summary: '',
      categories: [{ name: 'Original page', description: '' }],
      assignments: [
        {
          recordId: tab.id,
          url: tab.url,
          navigationVersion: tab.navigationVersion,
          categoryName: 'Original page',
          reason: 'Original title.',
          confidence: 0.8,
        },
      ],
      unresolvedRecordIds: [],
    });
    Object.assign(tabs.get(11)!, { url: 'https://example.net/new-page', title: 'New page' });
    await engine.state();

    await expect(engine.applyOrganizationProposal(proposal.id)).rejects.toThrow(/changed/);

    const app = await engine.state();
    expect(app.proposals.find((entry) => entry.id === proposal.id)?.status).toBe('stale');
    expect(app.memberships.find((entry) => entry.recordId === tab.id)?.source).toBe('legacy');
  });
  it('queues new project tabs only after the owner enables review maintenance and leases once', async () => {
    const project = await engine.project({
      name: 'Research',
      windowId: 1,
      maintainReviewQueue: true,
    });
    const tab = (await engine.state()).records.find((record) => record.tabId === 11)!;
    const queued = await engine.queueOrganizationTab(tab.tabId!);
    expect(queued).toMatchObject({ status: 'queued', projectId: project.id, recordId: tab.id });

    const claimed = await engine.claimOrganizationJob('dashboard-test');
    expect(claimed?.job.leaseOwner).toBe('dashboard-test');
    expect(await engine.claimOrganizationJob('second-dashboard')).toBeUndefined();

    const draftProposal = await engine.saveOrganizationProposal({
      projectId: project.id,
      projectRevision: project.revision,
      summary: 'One suggestion.',
      categories: [{ name: 'Source', description: 'Source material.' }],
      assignments: [
        {
          recordId: tab.id,
          url: tab.url,
          navigationVersion: tab.navigationVersion,
          categoryName: 'Source',
          reason: 'Page title.',
          confidence: 0.8,
        },
      ],
      unresolvedRecordIds: [],
      sourceJobId: queued!.id,
    });
    await engine.finishOrganizationJob({ id: queued!.id, status: 'complete' });
    expect(draftProposal.sourceJobId).toBe(queued?.id);
    expect((await database.organizationJobs.get(queued!.id))?.status).toBe('complete');
  });
  it('recovers missed navigation events after a worker restart without duplicating queued work', async () => {
    const project = await engine.project({
      name: 'Research',
      windowId: 1,
      maintainReviewQueue: true,
    });
    const records = (await engine.state()).records;
    const tab = records.find((record) => record.tabId === 11)!;
    const previous = new Map(
      records
        .filter((record) => record.tabId !== undefined)
        .map((record) => [record.tabId!, engine.organizationFingerprint(record)]),
    );
    Object.assign(tabs.get(11)!, {
      url: 'https://example.com/recovered-navigation',
      title: 'Recovered navigation',
    });

    for (const tabId of await engine.recoverOrganizationEvents(previous))
      await engine.queueOrganizationTab(tabId);
    for (const tabId of await engine.recoverOrganizationEvents(previous))
      await engine.queueOrganizationTab(tabId);

    const jobs = await database.organizationJobs.where('recordId').equals(tab.id).toArray();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ projectId: project.id, status: 'queued' });
    expect(jobs[0]?.url).toBe('https://example.com/recovered-navigation');
  });
  it('pauses queued analysis when disabled and reclaims a retried failure', async () => {
    const project = await engine.project({
      name: 'Research',
      windowId: 1,
      maintainReviewQueue: true,
    });
    const tab = (await engine.state()).records.find((record) => record.tabId === 11)!;
    const queued = await engine.queueOrganizationTab(tab.tabId!);
    await engine.project({ id: project.id, name: project.name, maintainReviewQueue: false });

    expect(await engine.claimOrganizationJob('paused-dashboard')).toBeUndefined();
    expect((await database.organizationJobs.get(queued!.id))?.status).toBe('queued');

    await engine.project({ id: project.id, name: project.name, maintainReviewQueue: true });
    const firstAttempt = await engine.claimOrganizationJob('dashboard-test');
    expect(firstAttempt?.job.attempts).toBe(1);
    await engine.finishOrganizationJob({
      id: queued!.id,
      status: 'error',
      error: 'temporary error',
    });
    await engine.retryOrganizationJob(queued!.id);
    const secondAttempt = await engine.claimOrganizationJob('dashboard-test');
    expect(secondAttempt?.job).toMatchObject({ id: queued!.id, attempts: 2, status: 'running' });
  });
  it('prunes old terminal organization jobs while keeping failures available for retry', async () => {
    const old = Date.now() - 31 * 24 * 60 * 60 * 1000;
    for (const status of ['complete', 'stale', 'error'] as const) {
      await database.organizationJobs.put({
        id: `retention-${status}`,
        recordId: 'record-1',
        projectId: 'project-1',
        url: 'https://example.com',
        navigationVersion: 1,
        createdAt: old,
        status,
        attempts: 1,
      });
    }

    await engine.claimOrganizationJob('retention-test');

    expect(await database.organizationJobs.get('retention-complete')).toBeUndefined();
    expect(await database.organizationJobs.get('retention-stale')).toBeUndefined();
    expect(await database.organizationJobs.get('retention-error')).toMatchObject({
      status: 'error',
    });
  });
  it('keeps maintenance opt-in and never queues a tab with an owner correction', async () => {
    const project = await engine.project({ name: 'Research', windowId: 1 });
    const tabsInProject = (await engine.state()).records.filter((record) => record.windowId === 1);
    expect(await engine.queueOrganizationTab(tabsInProject[0]!.tabId!)).toBeUndefined();
    await engine.project({
      id: project.id,
      name: project.name,
      maintainReviewQueue: true,
    });
    const ownerSelected = tabsInProject[1]!;
    const category = await engine.saveCategory({ projectId: project.id, name: 'Owner choice' });
    await engine.assignMembership({
      recordIds: [ownerSelected.id],
      projectId: project.id,
      categoryId: category.id,
    });
    expect(await engine.queueOrganizationTab(ownerSelected.tabId!)).toBeUndefined();
  });
  it('groups within the existing window and undo restores a cross-window move', async () => {
    const r = (await engine.state()).records.find((r) => r.tabId === 11)!;
    await engine.applyPlan({
      summary: 'Group',
      actions: [{ type: 'group', recordIds: [r.id], windowId: 1, name: 'Research', color: 'blue' }],
    });
    expect(tabs.get(11)?.windowId).toBe(1);
    expect(groups.get(tabs.get(11)!.groupId)?.title).toBe('Research');
    const op = await engine.applyPlan({
      summary: 'Move',
      actions: [{ type: 'move', recordIds: [r.id], windowId: 2 }],
    });
    expect(tabs.get(11)?.windowId).toBe(2);
    await engine.undoOperation(op.id);
    expect(tabs.get(11)?.windowId).toBe(1);
    expect(tabs.size).toBe(3);
  });
  it('restores two windows of the same project into two distinct windows', async () => {
    const p = await engine.project({ name: 'Shared', windowId: 1 });
    await engine.bindProject(2, p.id);
    const s = await engine.snapshot('Two windows');
    tabs.clear();
    delete session.bindings;
    const result = await engine.restoreSnapshot(s.id);
    expect(result.every((r) => r.ok)).toBe(true);
    expect(new Set([...tabs.values()].map((t) => t.windowId)).size).toBe(2);
  });
  it('restores original identity and project across a full browser restart', async () => {
    const p = await engine.project({ name: 'Research', windowId: 1 });
    const r = (await engine.state()).records.find((r) => r.tabId === 11)!;
    await engine.applyPlan({ summary: 'Sleep', actions: [{ type: 'suspend', recordIds: [r.id] }] });
    const url = tabs.get(11)!.url!;
    tabs.delete(11);
    addTab(71, 8, url);
    delete session.bindings;
    const app = await engine.state();
    const restored = app.records.find((t) => t.tabId === 71)!;
    expect(restored.id).toBe(r.id);
    expect(restored.projectId).toBe(p.id);
    expect(restored.url).toBe(r.url);
  });
  it('cancelled inspection re-suspends a tab that it temporarily woke', async () => {
    const r = (await engine.state()).records.find((r) => r.tabId === 11)!;
    await engine.applyPlan({ summary: 'Sleep', actions: [{ type: 'suspend', recordIds: [r.id] }] });
    const job = await engine.startInspection([r.id]);
    await engine.inspectionStep();
    expect(tabs.get(11)?.url).toBe(r.url);
    await engine.cancelJob(job.id);
    await engine.recoverCancelledInspections();
    expect(tabs.get(11)?.url).toContain('/suspended.html#');
  });
  it('does not wake suspended tabs for inspection without page access', async () => {
    const r = (await engine.state()).records.find((r) => r.tabId === 11)!;
    await engine.applyPlan({ summary: 'Sleep', actions: [{ type: 'suspend', recordIds: [r.id] }] });
    hostAccess = false;
    await engine.startInspection([r.id]);
    await engine.inspectionStep();
    expect(tabs.get(11)?.url).toContain('/suspended.html#');
    expect((await engine.state()).jobs[0]?.items[0]?.error).toContain('Grant page access');
  });
});

describe('classification repair branches', () => {
  it('merges explicit proposal IDs atomically, preserves the source and rejects stale cross-chat writes', async () => {
    const records = (await engine.state()).records.filter((item) => item.live).slice(0, 2);
    const target = await engine.saveCollectionProposal({
      summary: 'Main collection',
      name: 'Keep this name',
      scopeRecordIds: records.map((r) => r.id),
      projects: [],
      assignments: [],
      unresolvedRecordIds: records.map((r) => r.id),
    });
    const record = records[0]!;
    const source = await engine.saveCollectionProposal({
      summary: 'Additional references',
      scopeRecordIds: [record.id],
      projects: [
        {
          name: 'Video study',
          purpose: 'Study lessons',
          areaName: 'Learning',
          categories: [{ name: 'Lessons', description: 'Course material' }],
        },
      ],
      assignments: [
        {
          recordId: record.id,
          url: record.url,
          navigationVersion: record.navigationVersion,
          projectName: 'Video study',
          categoryName: 'Lessons',
          reason: 'Course reference',
          confidence: 0.9,
          suggestedTags: ['video'],
        },
      ],
      unresolvedRecordIds: [],
    });
    const targetFingerprint = await tagHash(target);
    const input = {
      targetProposalId: target.id,
      sourceProposalId: source.id,
      targetFingerprint,
      sourceFingerprint: await tagHash(source),
      projectNames: [],
      assignmentConflict: 'keep_target' as const,
    };
    const browserBefore = [...tabs.values()].map((item) => ({ ...item }));
    const merged = await engine.mergeCollectionProposals(input);
    expect(merged.proposal.name).toBe('Keep this name');
    expect(merged.proposal.assignments).toHaveLength(1);
    expect(merged.proposal.unresolvedRecordIds).toEqual([records[1]!.id]);
    expect(await database.collectionProposals.get(source.id)).toEqual(source);
    await expect(engine.mergeCollectionProposals(input)).rejects.toThrow('changed in another chat');
    await expect(
      engine.updateCollectionProposal(
        target.id,
        { ...merged.proposal, name: 'Stale edit' },
        false,
        { expectedFingerprint: targetFingerprint },
      ),
    ).rejects.toThrow('changed in another chat');
    expect((await database.collectionProposals.get(target.id))?.name).toBe('Keep this name');
    expect([...tabs.values()]).toEqual(browserBefore);
    expect(await database.operations.count()).toBe(0);
  });
  it('retains native decision plans and durable receipts without allowing provenance rewrites', async () => {
    const record = (await engine.state()).records.find((item) => item.tabId === 11)!;
    const original = await engine.saveActionAnalysis({
      id: 'legacy-native',
      createdAt: 1,
      updatedAt: 1,
      revision: 1,
      status: 'pending',
      instruction: 'Group tabs',
      mode: 'decision',
      readOnly: false,
      allowCrossWindowMove: false,
      allowSleepWake: false,
      scope: [
        {
          id: record.id,
          url: record.url,
          navigationVersion: record.navigationVersion,
          windowId: record.windowId!,
          groupId: record.groupId,
        },
      ],
      completedIds: [],
      actions: [],
      matchIds: [],
      summaries: [],
    });
    const repaired = await engine.repairActionAnalysis(original.id);
    expect(repaired.sourceAnalysisId).toBe(original.id);
    expect(repaired.decisionContract).toBe('isolated-evidence-v2');
    expect(await getStoredEntity('actionAnalyses', original.id)).toEqual(original);
    await expect(
      engine.saveActionAnalysis({
        ...original,
        revision: 2,
        decisionContract: 'isolated-evidence-v2',
      }),
    ).rejects.toThrow('cannot be rewritten');
    for (let i = 0; i < 107; i++)
      await engine.saveInferenceReceipt({
        id: `receipt-${i}`,
        analysisId: repaired.id,
        contract: 'isolated-evidence-v2',
        stage: 'classification',
        model: 'test',
        startedAt: i,
        finishedAt: i + 1,
        outcome: 'responded',
        request: '{"synthetic":true}',
        response: '{}',
      });
    expect((await getStoredEntity('inferenceReceipts', 'receipt-106'))?.analysisId).toBe(
      repaired.id,
    );
    await expect(
      engine.saveInferenceReceipt({
        id: 'receipt-106',
        analysisId: repaired.id,
        contract: 'isolated-evidence-v2',
        stage: 'classification',
        model: 'test',
        startedAt: 0,
        finishedAt: 1,
        outcome: 'failed',
        request: '{}',
      }),
    ).rejects.toThrow('cannot be overwritten');
  });
  it('retains legacy checkpoints and forks only the explicitly requested stages', async () => {
    const record = (await engine.state()).records.find((item) => item.tabId === 11)!;
    const source = {
      id: 'legacy-grounding',
      createdAt: 1,
      updatedAt: 1,
      revision: 1,
      purpose: 'proposal' as const,
      instruction: '',
      reuseAcceptedTaxonomyOnly: false,
      scope: [{ id: record.id, url: record.url, navigationVersion: record.navigationVersion }],
      discoveredIds: [record.id],
      classifiedIds: [record.id],
      projects: [
        {
          name: 'Work',
          purpose: 'Work',
          areaName: 'Work',
          categories: [{ name: 'Code', description: 'Source code' }],
        },
      ],
      summaries: ['Legacy discovery'],
      assignments: [
        {
          recordId: record.id,
          url: record.url,
          navigationVersion: record.navigationVersion,
          projectName: 'Work',
          categoryName: 'Code',
          reason: 'Legacy decision',
          confidence: 0.99,
          suggestedTags: ['rust'],
        },
      ],
      unresolvedRecordIds: [],
      tagVocabulary: ['rust'],
      tagChecks: [{ recordId: record.id, tag: 'rust', selected: true, confidence: 0.99 }],
    };
    await engine.saveCollectionAnalysis(source);
    const tags = await engine.repairCollectionAnalysis(source.id, 'tagging');
    expect(tags.id).not.toBe(source.id);
    expect(tags.sourceAnalysisId).toBe(source.id);
    expect(tags.legacyCategoriesRetained).toBe(true);
    expect(tags.tagChecks).toEqual([]);
    expect(tags.classifiedIds).toEqual(source.classifiedIds);
    expect(tags.assignments[0]?.suggestedTags).toEqual([]);
    const categories = await engine.repairCollectionAnalysis(source.id, 'classification');
    expect(categories.classifiedIds).toEqual([]);
    expect(categories.discoveredIds).toEqual(source.discoveredIds);
    expect(categories.projects).toEqual(source.projects);
    expect(categories.summaries).toEqual(source.summaries);
    const structure = await engine.repairCollectionAnalysis(source.id, 'discovery');
    expect(structure.discoveredIds).toEqual([]);
    expect(structure.projects).toEqual([]);
    expect(structure.classifiedIds).toEqual([]);
    expect(structure.summaries).toEqual([]);
    expect(structure.reuseAcceptedTaxonomyOnly).toBe(false);
    await engine.saveCollectionAnalysis({
      ...source,
      id: 'legacy-second-pass',
      purpose: 'reclassify',
      reuseAcceptedTaxonomyOnly: true,
    });
    const secondPassStructure = await engine.repairCollectionAnalysis(
      'legacy-second-pass',
      'discovery',
    );
    expect(secondPassStructure.purpose).toBe('scoped');
    expect(secondPassStructure.reuseAcceptedTaxonomyOnly).toBe(false);
    expect(await getStoredEntity('collectionAnalyses', source.id)).toEqual(source);
    const again = await engine.repairCollectionAnalysis(tags.id, 'tagging');
    expect(again.legacyCategoriesRetained).toBe(true);
  });
  it('keeps a pending proposal unchanged while preparing a separate repair analysis', async () => {
    const record = (await engine.state()).records.find((item) => item.tabId === 11)!;
    const draft = await engine.saveCollectionProposal({
      scopeRecordIds: [record.id],
      model: 'legacy',
      summary: 'Saved owner draft',
      projects: [
        {
          name: 'Work',
          purpose: 'Work',
          areaName: 'Work',
          categories: [{ name: 'Code', description: 'Source code' }],
        },
      ],
      assignments: [
        {
          recordId: record.id,
          url: record.url,
          navigationVersion: record.navigationVersion,
          projectName: 'Work',
          categoryName: 'Code',
          reason: 'Legacy decision',
          confidence: 0.99,
          suggestedTags: ['rust'],
        },
      ],
      unresolvedRecordIds: [],
    });
    const before = await getStoredEntity('collectionProposals', draft.id);
    const analysis = await engine.repairCollectionProposal(draft.id);
    expect(analysis.sourceAnalysisId).toBe(`proposal:${draft.id}`);
    expect(analysis.classifiedIds).toEqual([]);
    expect(analysis.discoveredIds).toEqual([record.id]);
    expect(analysis.tagVocabulary).toContain('rust');
    const tagsOnly = await engine.repairCollectionProposal(draft.id, 'tagging');
    expect(tagsOnly.taggingRequested).toBe(true);
    expect(analysis.taggingRequested).toBe(false);
    expect(tagsOnly.reuseAcceptedTaxonomyOnly).toBe(true);
    expect(tagsOnly.classifiedIds).toEqual([record.id]);
    expect(tagsOnly.assignments[0]).toMatchObject({ categoryName: 'Code', suggestedTags: [] });
    expect(tagsOnly.legacyCategoriesRetained).toBe(true);
    expect(tagsOnly.id).not.toBe(analysis.id);
    expect(await getStoredEntity('collectionProposals', draft.id)).toEqual(before);
  });
});
