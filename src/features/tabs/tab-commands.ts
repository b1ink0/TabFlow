import { computed, ref, type Ref } from 'vue';
import type { DropdownMenuItem } from '@nuxt/ui/components/DropdownMenu.vue';
import type { PlanAction, TabRecord } from '../../shared/types';
import { rpc } from '../../shared/rpc';
import { useWorkspace } from '../../stores/workspace';
import { useDialog } from '../../stores/dialog';
import { cleanPageLink } from '../../shared/tabs/urls';
import { workspaceEditBaseline, type WorkspaceEdit } from '../../shared/workspace/workspace-edits';
import { tabAncestors } from '../../shared/tabs/tab-tree';
export function useTabCommands(record: Ref<TabRecord>) {
  const store = useWorkspace();
  const dialog = useDialog();
  async function branch(kind: 'tab_parent' | 'branch_name', detach = false) {
    await store.run(async () => {
      const target = record.value;
      const value = detach
        ? { parent: '' }
        : await dialog.ask(
            kind === 'branch_name' ? 'Name tab branch' : 'Nest under tab',
            [
              kind === 'branch_name'
                ? { name: 'name', label: 'Branch name', value: target.branchName || '' }
                : {
                    name: 'parent',
                    label: 'Parent tab',
                    value: target.parentRecordId || '',
                    options: [
                      { label: 'No parent', value: '' },
                      ...store.records
                        .filter(
                          (item) =>
                            item.live &&
                            item.id !== target.id &&
                            !tabAncestors(item.id, store.records).includes(target.id),
                        )
                        .map((item) => ({
                          label: item.branchName || item.title || item.url,
                          value: item.id,
                        })),
                    ],
                  },
            ],
            'This changes the sidebar branch only. Browser placement, projects and categories stay as they are.',
          );
      if (!value || !store.app) return;
      const edit: WorkspaceEdit =
        kind === 'branch_name'
          ? { kind, recordId: target.id, name: 'name' in value ? String(value.name || '') : '' }
          : { kind, recordId: target.id, parentRecordId: value.parent || null };
      await rpc('executeWorkspaceEdit', {
        kind: 'workspace_edits',
        summary: kind === 'branch_name' ? 'Rename tab branch' : 'Change tab branch',
        edits: [{ edit, before: workspaceEditBaseline(store.app, edit) }],
      });
      await store.refresh();
    });
  }
  async function execute(command: 'new' | 'duplicate' | 'close' | 'reload') {
    const target = record.value;
    if (
      command === 'close' &&
      !(await dialog.ask(
        'Close this tab?',
        [],
        'A snapshot is saved first. Undo reopens the address as a sleeping tab; unsaved page content cannot be restored.',
        'Close tab',
      ))
    )
      return;
    await store.run(async () => {
      const operation = await rpc('tabCommand', {
        id: target.id,
        command,
        expected: { url: target.url, navigationVersion: target.navigationVersion },
      });
      store.notify(operation.pauseReason || operation.summary);
      await store.refresh();
      const createdId = operation.tabCommand?.created?.recordId;
      if (createdId && (command === 'new' || command === 'duplicate')) {
        store.semanticTabOrder = Object.fromEntries(
          Object.entries(store.semanticTabOrder).map(([key, saved]) => {
            if (!saved.includes(target.id)) return [key, saved];
            const ids = saved.filter((id) => id !== createdId);
            let index = ids.indexOf(target.id) + 1;
            while (
              index < ids.length &&
              tabAncestors(ids[index]!, store.records).includes(target.id)
            )
              index++;
            ids.splice(index, 0, createdId);
            return [key, ids];
          }),
        );
      }
    });
  }
  async function copy(clean = false) {
    await store.run(async () => {
      await navigator.clipboard.writeText(
        clean ? cleanPageLink(record.value.url) : record.value.url,
      );
      store.notify(clean ? 'Clean link copied' : 'Link copied');
    });
  }
  return computed<DropdownMenuItem[]>(() => [
    { label: 'New tab below', disabled: record.value.locked, onSelect: () => execute('new') },
    { label: 'Duplicate tab', disabled: record.value.locked, onSelect: () => execute('duplicate') },
    {
      label: 'Reload tab',
      disabled: record.value.locked || record.value.suspended,
      onSelect: () => execute('reload'),
    },
    { label: 'Copy link', onSelect: () => copy() },
    { label: 'Copy clean link', onSelect: () => copy(true) },
    { label: 'Show in workspace', onSelect: () => store.revealTab(record.value.id) },
    {
      label: 'Tab branch',
      disabled: record.value.locked,
      children: [
        { label: 'Nest under tab…', onSelect: () => branch('tab_parent') },
        {
          label: 'Detach from branch',
          disabled: !record.value.parentRecordId,
          onSelect: () => branch('tab_parent', true),
        },
        { label: 'Name branch…', onSelect: () => branch('branch_name') },
      ],
    },
    { label: 'Close tab', disabled: record.value.locked, onSelect: () => execute('close') },
  ]);
}

export function useTabContext() {
  const contextGeneration = ref(0);
  const contextOpen = ref(false),
    menuOpen = ref(false);
  let lastContext = 0;
  function onContext(event: MouseEvent) {
    const time = Date.now();
    if (event.shiftKey || (lastContext && time - lastContext < 10000)) {
      lastContext = 0;
      contextOpen.value = false;
      menuOpen.value = false;
      event.stopImmediatePropagation();
      contextGeneration.value++;
    } else lastContext = time;
  }
  return { contextGeneration, onContext, contextOpen, menuOpen };
}

export function useTabPlacement(record: Ref<TabRecord>) {
  const store = useWorkspace();
  const dialog = useDialog();
  async function apply(type: 'move' | 'group' | 'ungroup' | 'reorder' | 'pin' | 'mute') {
    const target = record.value;
    const action: PlanAction = { type, recordIds: [target.id] };
    if (type === 'pin' || type === 'mute')
      action.enabled = !(type === 'pin' ? target.pinned : target.muted);
    if (type === 'move') {
      const value = await dialog.ask('Move to browser window', [
        {
          name: 'window',
          label: 'Window',
          options: (store.app?.windows || []).map((item, index) => ({
            label: `Window ${index + 1}`,
            value: String(item.id),
          })),
        },
      ]);
      if (!value) return;
      action.windowId = Number(value.window);
    }
    if (type === 'group') {
      const value = await dialog.ask('Put in native group', [
        {
          name: 'group',
          label: 'Group',
          options: [
            { label: 'New group in this window', value: 'new' },
            ...(store.app?.groups || []).map((item) => ({
              label: item.title || 'Untitled group',
              value: String(item.id),
            })),
          ],
        },
        { name: 'name', label: 'Name for a new group' },
      ]);
      if (!value) return;
      const group = store.app?.groups.find((item) => String(item.id) === value.group);
      action.windowId = group?.windowId ?? target.windowId;
      action.name = group?.title || value.name || 'Untitled group';
      action.color = group?.color || 'grey';
      action.nativeGroupId = group?.id;
    }
    if (type === 'reorder') {
      const value = await dialog.ask('Change native position', [
        { name: 'position', label: 'Position (starts at 1)', value: String(target.index + 1) },
      ]);
      if (!value) return;
      action.index = Number(value.position) - 1;
    }
    await store.run(() => store.apply([action], `Browser ${type}`));
  }
  async function assign() {
    const target = record.value;
    const choices = [
      { label: 'Inbox', value: 'inbox' },
      ...(store.app?.projects || []).map((item) => ({
        label: item.name,
        value: `project:${item.id}`,
      })),
      ...(store.app?.categories || []).map((item) => ({
        label: `${store.app?.projects.find((project) => project.id === item.projectId)?.name || 'Project'} / ${item.name}`,
        value: `category:${item.id}`,
      })),
    ];
    const value = await dialog.ask('Assign project or category', [
      { name: 'destination', label: 'Destination', options: choices },
    ]);
    if (!value) return;
    const category = store.app?.categories.find(
      (item) => `category:${item.id}` === value.destination,
    );
    const project = store.app?.projects.find((item) => `project:${item.id}` === value.destination);
    await store.run(async () => {
      await rpc('assignMembership', {
        recordIds: [target.id],
        projectId: category?.projectId || project?.id || null,
        categoryId: category?.id || null,
        expected: { [target.id]: { url: target.url, navigationVersion: target.navigationVersion } },
      });
      await store.refresh();
    });
  }
  return {
    assign: { label: 'Assign project or category', onSelect: assign },
    browser: computed<DropdownMenuItem[]>(() => [
      {
        label: 'Move to browser window…',
        disabled: record.value.locked,
        onSelect: () => apply('move'),
      },
      {
        label: 'Put in native group…',
        disabled: record.value.locked,
        onSelect: () => apply('group'),
      },
      {
        label: 'Remove native group',
        disabled: record.value.locked || record.value.groupId === -1,
        onSelect: () => apply('ungroup'),
      },
      {
        label: 'Change native position…',
        disabled: record.value.locked,
        onSelect: () => apply('reorder'),
      },
      {
        label: record.value.pinned ? 'Unpin tab' : 'Pin tab',
        disabled: record.value.locked,
        onSelect: () => apply('pin'),
      },
      {
        label: record.value.muted ? 'Unmute tab' : 'Mute tab',
        disabled: record.value.locked,
        onSelect: () => apply('mute'),
      },
    ]),
  };
}
