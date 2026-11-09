<script setup lang="ts">
import { computed } from 'vue';
import {
  PhDotsThree as Ellipsis,
  PhLockKey as LockKeyhole,
  PhMoon as Moon,
  PhPushPin as Pin,
  PhSpeakerHigh as Volume2,
  PhSpeakerSlash as VolumeX,
} from '@phosphor-icons/vue';
import UContextMenu from '@nuxt/ui/components/ContextMenu.vue';
import { useTabCommands, useTabContext } from './tab-commands';
import { toRef } from 'vue';
import UDropdownMenu from '@nuxt/ui/components/DropdownMenu.vue';
import UiTabHoverCard from '../../ui/UiTabHoverCard.vue';
import UiButton from '../../ui/UiButton.vue';
import UiBranchToggle from '../../ui/UiBranchToggle.vue';
import UiCheckbox from '../../ui/UiCheckbox.vue';
import { cn } from '../../shared/utils/cn';
import { useWorkspace } from '../../stores/workspace';
import { useDialog } from '../../stores/dialog';
import { rpc } from '../../shared/rpc';
import { parseTagSelection } from '../../shared/tabs/tags';
import type { TabRecord } from '../../shared/types';

const props = defineProps<{
  record: TabRecord;
  currentWindowId?: number;
  selecting?: boolean;
  selected?: boolean;
  draggable?: boolean;
  treeDepth?: number;
  childCount?: number;
}>();
const emit = defineEmits<{
  assign: [record: TabRecord];
  inbox: [record: TabRecord];
  toggle: [id: string];
  order: [record: TabRecord, direction: -1 | 1];
  native: [record: TabRecord, command: 'move' | 'group' | 'reorder' | 'pin' | 'mute' | 'ungroup'];
}>();
const store = useWorkspace();
const dialog = useDialog();
const browserApi = chrome;
const membership = computed(() =>
  store.app?.memberships.find((item) => item.recordId === props.record.id),
);
const domain = computed(() => {
  try {
    return new URL(props.record.url).hostname.replace(/^www\./, '');
  } catch {
    return props.record.url;
  }
});
async function tags() {
  const value = await dialog.ask('Edit tab labels', [
    {
      name: 'tags',
      label: 'Tags',
      value: JSON.stringify(props.record.tags),
      tagOptions: store.tagVocabulary,
    },
    { name: 'note', label: 'Note', value: props.record.note },
  ]);
  if (!value) return;
  await store.run(async () => {
    await rpc('record', {
      id: props.record.id,
      patch: {
        tags: parseTagSelection(value.tags),
        note: value.note || '',
      },
    });
    await store.refresh();
  });
}
async function activate() {
  if (store.draggingTabs || Date.now() < store.suppressTabClicksUntil) return;
  await store.run(() => store.focusTab(props.record.id));
}
const secondaryActions = computed(() => [
  { label: 'Select tab', onSelect: () => emit('toggle', props.record.id) },
  ...(props.draggable
    ? [
        {
          label: 'Move up in TabFlow',
          disabled: props.record.locked,
          onSelect: () => emit('order', props.record, -1),
        },
        {
          label: 'Move down in TabFlow',
          disabled: props.record.locked,
          onSelect: () => emit('order', props.record, 1),
        },
      ]
    : []),
  { label: 'Assign project or category', onSelect: () => emit('assign', props.record) },
  {
    label: 'Move to Inbox',
    disabled: !props.record.projectId,
    onSelect: () => emit('inbox', props.record),
  },
  {
    label: props.record.suspended ? 'Wake tab' : 'Suspend tab',
    onSelect: () =>
      store.run(() =>
        store.apply(
          [{ type: props.record.suspended ? 'wake' : 'suspend', recordIds: [props.record.id] }],
          props.record.suspended ? 'Wake tab' : 'Suspend tab',
        ),
      ),
  },
  {
    label: props.record.locked ? 'Remove protection' : 'Protect tab',
    onSelect: () =>
      store.run(async () => {
        await rpc('record', { id: props.record.id, patch: { locked: !props.record.locked } });
        await store.refresh();
      }),
  },
  { label: 'Edit tags and note', onSelect: tags },
  ...(['move', 'group', 'ungroup', 'reorder', 'pin', 'mute'] as const).map((command) => ({
    label:
      command === 'move'
        ? 'Move to browser window…'
        : command === 'group'
          ? 'Put in native group…'
          : command === 'ungroup'
            ? 'Remove native group'
            : command === 'reorder'
              ? 'Change native position…'
              : command === 'pin'
                ? props.record.pinned
                  ? 'Unpin tab'
                  : 'Pin tab'
                : props.record.muted
                  ? 'Unmute tab'
                  : 'Mute tab',
    disabled: props.record.locked,
    onSelect: () => emit('native', props.record, command),
  })),
]);
const { contextGeneration, onContext, contextOpen, menuOpen } = useTabContext();
const browserActions = useTabCommands(toRef(props, 'record'));
const actions = computed(() => [
  { label: 'Ask assistant', onSelect: () => store.askAssistant([props.record.id]) },
  ...browserActions.value.slice(0, 3),
  ...secondaryActions.value.filter((item) =>
    /^(Wake tab|Suspend tab|Select tab)$/.test(item.label),
  ),
  {
    label: 'Organize',
    children: secondaryActions.value.filter((item) =>
      /^(Assign|Move to Inbox|Edit tags)/.test(item.label),
    ),
  },
  {
    label: 'Browser and protection',
    children: secondaryActions.value.filter(
      (item) =>
        !/^(Wake tab|Suspend tab|Select tab|Assign|Move to Inbox|Edit tags)/.test(item.label),
    ),
  },
  ...browserActions.value.slice(3),
]);
</script>

<template>
  <div
    :data-workspace-record-id="record.id"
    :data-protected="record.locked"
    :class="
      cn(
        'group relative flex min-w-0 items-center gap-2 rounded-md px-2 hover:bg-hover',
        selected && 'bg-selected',
        record.active && record.windowId === currentWindowId && 'ring-1 ring-line bg-raised',
      )
    "
    :data-tab-tree-id="record.id"
    :data-tab-tree-parent="record.parentRecordId || undefined"
    @contextmenu.capture="onContext"
  >
    <UContextMenu
      :key="contextGeneration"
      v-model:open="contextOpen"
      :items="actions"
      :modal="false"
      :content="{ onCloseAutoFocus: dialog.protectFocus }"
    >
      <div class="contents">
        <UiCheckbox
          v-if="selecting"
          :model-value="Boolean(selected)"
          :label="`Select ${record.title}`"
          @update:model-value="emit('toggle', record.id)"
        />
        <div
          data-tab-tree-content
          class="flex min-w-0 flex-1 items-center gap-2"
          :style="{ paddingInlineStart: `${(selecting ? 8 : 0) + (treeDepth || 0) * 4}px` }"
        >
          <UiBranchToggle
            v-if="childCount"
            :record-id="record.id"
            :count="childCount || 0"
            :src="
              browserApi.runtime.getURL(
                `_favicon/?pageUrl=${encodeURIComponent(record.url)}&size=32`,
              )
            "
            :fallback="browserApi.runtime.getURL('icons/16.png')"
          />
          <UiTabHoverCard
            :disabled="store.draggingTabs || contextOpen || menuOpen"
            :title="record.title"
            :url="record.url"
            :note="record.note"
            :tags="record.tags"
            :details="
              [
                record.suspended ? 'Sleeping' : 'Awake',
                record.locked ? 'Protected' : '',
                record.pinned ? 'Pinned' : '',
                membership?.source === 'owner'
                  ? 'Your correction'
                  : membership?.source === 'accepted-ai'
                    ? 'AI assigned'
                    : '',
                membership?.reason || '',
              ]
                .filter(Boolean)
                .join(' \u00b7 ')
            "
            @tag="store.filterTag"
          >
            <button
              type="button"
              class="flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-md py-1 text-left"
              :aria-current="
                record.active && record.windowId === currentWindowId ? 'page' : undefined
              "
              @click="activate"
            >
              <img
                v-if="!childCount"
                :src="
                  browserApi.runtime.getURL(
                    `_favicon/?pageUrl=${encodeURIComponent(record.url)}&size=32`,
                  )
                "
                alt=""
                data-tab-tree-icon
                :draggable="false"
                class="size-4 shrink-0 rounded-sm"
                @error="
                  ($event.target as HTMLImageElement).src =
                    browserApi.runtime.getURL('icons/16.png')
                "
              />
              <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                <span data-tab-tree-title class="truncate text-[13px] leading-5 text-ink">{{
                  record.branchName || record.title
                }}</span>
                <span class="flex min-w-0 items-center gap-1 text-xs text-muted"
                  ><span class="truncate">{{ domain }}</span
                  ><span
                    v-if="record.windowId !== currentWindowId"
                    class="shrink-0"
                    title="Tab is in another browser window"
                    >· other window</span
                  ></span
                >
              </span>
            </button></UiTabHoverCard
          >
        </div>
        <Pin v-if="record.pinned" class="size-3 shrink-0 text-muted" aria-label="Pinned tab" />
        <VolumeX v-if="record.muted" class="size-3.5 shrink-0 text-muted" aria-label="Muted tab" />
        <Volume2
          v-else-if="record.audible"
          class="size-3.5 shrink-0 text-muted"
          aria-label="Playing audio"
        />
        <Moon
          v-if="record.suspended"
          class="size-3.5 shrink-0 text-muted"
          aria-label="Sleeping tab"
        />
        <LockKeyhole
          v-if="record.locked"
          class="size-3.5 shrink-0 text-muted"
          aria-label="Protected tab"
        />
        <UDropdownMenu
          v-model:open="menuOpen"
          :items="actions"
          :content="{ onCloseAutoFocus: dialog.protectFocus }"
          ><UiButton
            size="small"
            variant="ghost"
            :aria-label="`Actions for ${record.title}`"
            :title="`Actions for ${record.title}`"
            class="absolute right-1 top-1/2 -translate-y-1/2 bg-overlay opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100"
            ><Ellipsis class="size-4" /></UiButton
        ></UDropdownMenu>
      </div>
    </UContextMenu>
  </div>
</template>
