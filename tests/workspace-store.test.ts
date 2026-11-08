import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { AppState } from '../src/shared/types';
import { useWorkspace } from '../src/stores/workspace';
import { rpc } from '../src/shared/rpc';
import { DEFAULTS, newRecord } from '../src/shared/model';
import { useDialog } from '../src/stores/dialog';
import { watch, nextTick } from 'vue';

vi.mock('../src/shared/rpc', () => ({ rpc: vi.fn() }));
beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
});
describe('workspace surface lifecycle', () => {
  it('refreshes an existing workspace without disabling it or replacing unchanged collections', async () => {
    const store = useWorkspace();
    const state: AppState = {
      records: [{ ...newRecord('https://example.test'), live: true }],
      projects: [],
      areas: [],
      workItems: [],
      categories: [],
      memberships: [],
      proposals: [],
      collectionProposals: [],
      organizationJobs: [],
      windows: [],
      groups: [],
      snapshots: [],
      operations: [],
      jobs: [],
      settings: { ...DEFAULTS },
      version: 'test',
    };
    vi.mocked(rpc).mockResolvedValueOnce(state);
    await store.refresh();
    store.toggle(state.records[0]!.id);
    const original = store.app,
      records = store.records,
      projects = store.app!.projects;
    const disabled: boolean[] = [];
    const stop = watch(
      () => store.loading,
      (value) => disabled.push(value),
      { flush: 'sync' },
    );
    let respond!: (value: AppState) => void;
    vi.mocked(rpc).mockImplementationOnce(
      () =>
        new Promise<AppState>((resolve) => {
          respond = resolve;
        }),
    );
    const pending = store.refresh();
    await nextTick();
    expect(store.loading).toBe(false);
    respond(structuredClone(state));
    await pending;
    expect(store.app).toBe(original);
    expect(store.records).toBe(records);
    expect(store.app!.projects).toBe(projects);
    expect([...store.selected]).toEqual([state.records[0]!.id]);
    expect(disabled).toEqual([]);
    vi.mocked(rpc).mockResolvedValueOnce({ ...structuredClone(state), version: 'updated' });
    await store.refresh();
    expect(store.app!.version).toBe('updated');
    expect(store.records).toBe(records);
    expect(store.app!.projects).toBe(projects);
    const settings = store.app!.settings;
    const changed = structuredClone(state);
    changed.records[0]!.locked = true;
    vi.mocked(rpc).mockResolvedValueOnce(changed);
    await store.refresh();
    expect(store.records[0]!.locked).toBe(true);
    expect(store.records).not.toBe(records);
    expect(store.app!.settings).toBe(settings);
    expect(store.app!.projects).toBe(projects);
    const usable = store.app;
    vi.mocked(rpc).mockRejectedValueOnce(new Error('Worker temporarily unavailable'));
    await expect(store.refresh()).rejects.toThrow('Worker temporarily unavailable');
    expect(store.app).toBe(usable);
    expect(disabled).toEqual([]);
    stop();
  });
  it('toggles a whole selected group off without clearing selection in other groups', () => {
    const store = useWorkspace();
    store.selected = new Set(['elsewhere']);
    store.select(['first', 'second']);
    expect([...store.selected]).toEqual(['elsewhere', 'first', 'second']);
    store.select(['first', 'second']);
    expect([...store.selected]).toEqual(['elsewhere']);
    store.selected = new Set(['elsewhere', 'first']);
    store.select(['first', 'second']);
    expect([...store.selected]).toEqual(['elsewhere', 'first', 'second']);
  });
  it('waits for inline option creation and retains a failed dialog for retry', async () => {
    const dialog = useDialog();
    const result = dialog.ask('Assign', [
      {
        name: 'project',
        label: 'Project',
        options: [],
        create: async (label) => ({ label, value: 'new-id' }),
      },
    ]);
    const field = dialog.current!.fields[0]!;
    const creating = dialog.createOption(field, 'New project');
    dialog.close(true);
    expect(dialog.current).not.toBeNull();
    await creating;
    expect(dialog.current!.values.project).toBe('new-id');
    expect(field.options).toEqual([{ label: 'New project', value: 'new-id' }]);
    field.create = async () => {
      throw new Error('Could not create');
    };
    await dialog.createOption(field, 'Another');
    expect(dialog.error).toBe('Could not create');
    expect(dialog.current).not.toBeNull();
    dialog.close(true);
    expect(await result).toEqual({ project: 'new-id' });
  });
  it('makes concurrent refresh callers await the same state and permits retry after failure', async () => {
    const store = useWorkspace();
    let resolveState!: (state: AppState) => void;
    const state: AppState = {
      records: [],
      projects: [],
      areas: [],
      workItems: [],
      categories: [],
      memberships: [],
      proposals: [],
      collectionProposals: [],
      organizationJobs: [],
      windows: [],
      groups: [],
      snapshots: [],
      operations: [],
      jobs: [],
      settings: { ...DEFAULTS },
      version: 'test',
    };
    vi.mocked(rpc).mockImplementationOnce(
      () =>
        new Promise<AppState>((resolve) => {
          resolveState = resolve;
        }),
    );
    const first = store.refresh();
    let completed = false;
    const second = store.refresh().then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);
    expect(rpc).toHaveBeenCalledTimes(1);
    resolveState(state);
    await Promise.all([first, second]);
    expect(store.app?.records).toEqual([]);
    vi.mocked(rpc).mockRejectedValueOnce(new Error('Worker restarting'));
    await expect(store.refresh()).rejects.toThrow('Worker restarting');
    expect(store.loading).toBe(false);
    vi.mocked(rpc).mockResolvedValueOnce(state);
    await store.refresh();
    expect(rpc).toHaveBeenCalledTimes(3);
  });
  it('emits repeated notices as separate events and preserves error severity', async () => {
    const store = useWorkspace();
    store.notify('Saved');
    const sequence = store.notification!.sequence;
    store.notify('Saved');
    expect(store.notification!.sequence).toBe(sequence + 1);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await store.run(async () => {
      throw new Error('Permission declined');
    });
    expect(store.notification).toMatchObject({ message: 'Permission declined', error: true });
    log.mockRestore();
  });
});
