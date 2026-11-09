<script setup lang="ts">
import {
  PhMoon as Moon,
  PhLockKey as LockKeyhole,
  PhFileText as FileText,
  PhDotsThree as Ellipsis,
} from '@phosphor-icons/vue';
import UContextMenu from '@nuxt/ui/components/ContextMenu.vue';
import { useTabCommands, useTabContext, useTabPlacement } from './tab-commands';
import { toRef } from 'vue';
import UDropdownMenu from '@nuxt/ui/components/DropdownMenu.vue';
import UiTabHoverCard from '../../ui/UiTabHoverCard.vue';
import UiButton from '../../ui/UiButton.vue';
import UiBranchToggle from '../../ui/UiBranchToggle.vue';
import UiCheckbox from '../../ui/UiCheckbox.vue';
import { useDialog } from '../../stores/dialog';
import { useWorkspace } from '../../stores/workspace';
import { rpc } from '../../shared/rpc';
import { parseTagSelection } from '../../shared/tabs/tags';
import { cn } from '../../shared/utils/cn';
import type { TabRecord } from '../../shared/types';
import { computed } from 'vue';
import ProvenanceLabel from '../../ui/ProvenanceLabel.vue';
const browserApi = chrome;
const props = withDefaults(
  defineProps<{
    record: TabRecord;
    draggable?: boolean;
    treeDepth?: number;
    childCount?: number;
    separator?: boolean;
  }>(),
  {
    draggable: true,
    treeDepth: 0,
    childCount: 0,
  },
);
const store = useWorkspace();
const membership = computed(() =>
  store.app?.memberships.find((entry) => entry.recordId === props.record.id),
);
const dialog = useDialog();
const favicon = () =>
  chrome.runtime.getURL(`_favicon/?pageUrl=${encodeURIComponent(props.record.url)}&size=32`);
const focus = () => {
  if (store.draggingTabs || Date.now() < store.suppressTabClicksUntil) return;
  return store.run(() => store.focusTab(props.record.id));
};
const protect = () =>
  store.run(async () => {
    await rpc('record', { id: props.record.id, patch: { locked: !props.record.locked } });
    await store.refresh();
  });
const note = () =>
  store.run(async () => {
    const value = await dialog.ask('Tab note', [
      {
        name: 'tags',
        label: 'Tags',
        value: JSON.stringify(props.record.tags),
        tagOptions: store.tagVocabulary,
      },
      { name: 'note', label: 'Why are you keeping this tab?', value: props.record.note },
    ]);
    if (value) {
      await rpc('record', {
        id: props.record.id,
        patch: { note: value.note || '', tags: parseTagSelection(value.tags) },
      });
      await store.refresh();
    }
  });

const address = computed(() => {
  try {
    const url = new URL(props.record.url);
    return url.hostname.replace(/^www\./, '') + (url.pathname === '/' ? '' : url.pathname);
  } catch {
    return props.record.url;
  }
});
const secondaryActions = computed(() => [
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
  { label: props.record.locked ? 'Remove protection' : 'Protect tab', onSelect: protect },
  { label: 'Edit tags and note', onSelect: note },
]);
const { contextGeneration, onContext, contextOpen, menuOpen } = useTabContext();
const placement = useTabPlacement(toRef(props, 'record'));
const browserActions = useTabCommands(toRef(props, 'record'));
const actions = computed(() => [
  { label: 'Ask assistant', onSelect: () => store.askAssistant([props.record.id]) },
  ...browserActions.value.slice(0, 3),
  ...secondaryActions.value.filter((item) =>
    /^(Wake tab|Suspend tab|Select tab)$/.test(item.label),
  ),
  {
    label: 'Organize',
    children: [
      placement.assign,
      ...secondaryActions.value.filter((item) =>
        /^(Assign|Move to Inbox|Edit tags)/.test(item.label),
      ),
    ],
  },
  {
    label: 'Browser and protection',
    children: [
      ...placement.browser.value,
      ...secondaryActions.value.filter(
        (item) =>
          !/^(Wake tab|Suspend tab|Select tab|Assign|Move to Inbox|Edit tags)/.test(item.label),
      ),
    ],
  },
  ...browserActions.value.slice(3),
]);
</script>
<template>
  <div
    :data-tabloom-id="record.id"
    :data-protected="record.locked"
    :data-tab-row-separator="separator ? '' : undefined"
    :style="separator ? { '--tab-title-inset': `${64 + treeDepth * 4}px` } : undefined"
    :class="
      cn(
        'group/tab relative flex min-h-12 min-w-0 items-center gap-2 rounded-md px-2 hover:bg-hover transition-colors duration-150',
        store.selected.has(record.id) && 'bg-selected',
        separator &&
          'after:pointer-events-none after:absolute after:bottom-0 after:left-(--tab-title-inset) after:right-2 after:h-px after:bg-line',
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
          :model-value="store.selected.has(record.id)"
          :label="'Select ' + record.title"
          @update:model-value="store.toggle(record.id)"
        />
        <div
          data-tab-tree-content
          class="flex min-w-0 flex-1 items-center gap-2"
          :style="{ paddingInlineStart: `${8 + treeDepth * 4}px` }"
        >
          <UiBranchToggle
            v-if="childCount"
            :record-id="record.id"
            :count="childCount"
            :src="favicon()"
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
              ]
                .filter(Boolean)
                .join(' \u00b7 ')
            "
            @tag="
              (tag) => {
                store.filterTag(tag);
                store.show('tabs');
              }
            "
          >
            <button
              class="flex min-h-12 min-w-0 flex-1 items-center gap-2 rounded py-1.5 text-left"
              @click="focus"
            >
              <img
                v-if="!childCount"
                :src="favicon()"
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
                <span data-tab-tree-title class="truncate text-[13px] font-normal text-ink">{{
                  record.branchName || record.title
                }}</span>
                <span class="truncate text-xs text-muted">{{ address }}</span>
              </span>
            </button></UiTabHoverCard
          >
        </div>
        <ProvenanceLabel
          compact
          class="hidden xl:inline-flex"
          :source="membership?.source"
          :provenance="membership?.provenance"
          :reason="membership?.reason"
          assignment
        />
        <Moon
          v-if="record.suspended"
          class="size-3.5 shrink-0 text-muted"
          aria-label="Suspended"
          title="Suspended"
        />
        <LockKeyhole
          v-if="record.locked"
          class="size-3.5 shrink-0 text-secondary"
          aria-label="Protected"
          title="Protected"
        />
        <FileText
          v-if="record.content"
          class="hidden size-3.5 shrink-0 text-muted xl:block"
          aria-label="Content indexed"
          title="Content indexed"
        />
        <UDropdownMenu
          v-model:open="menuOpen"
          :content="{ onCloseAutoFocus: dialog.protectFocus }"
          :items="actions"
          :ui="{ content: 'min-w-44 bg-overlay', item: 'min-h-9 text-[13px]' }"
        >
          <UiButton
            square
            variant="ghost"
            size="small"
            :title="'Actions for ' + record.title"
            :aria-label="'Actions for ' + record.title"
            class="absolute right-1 top-1/2 -translate-y-1/2 bg-overlay opacity-0 group-hover/tab:opacity-100 group-focus-within/tab:opacity-100 [@media(hover:none)]:opacity-100"
            ><Ellipsis class="size-4"
          /></UiButton>
        </UDropdownMenu>
      </div>
    </UContextMenu>
  </div>
</template>
