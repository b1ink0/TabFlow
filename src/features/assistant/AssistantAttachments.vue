<script setup lang="ts">
import { refDebounced } from '@vueuse/core';
import { computed, onUnmounted, ref, watch } from 'vue';
import USelectMenu from '@nuxt/ui/components/SelectMenu.vue';
import {
  PhPlus,
  PhImage,
  PhX,
  PhCopy,
  PhCaretLeft,
  PhCaretRight,
  PhBrowser,
  PhFolderSimple,
  PhTag,
  PhShapes,
  PhAppWindow,
  PhFileText,
  PhSelection,
} from '@phosphor-icons/vue';
import UiButton from '../../ui/UiButton.vue';
import UiScrollArea from '../../ui/UiScrollArea.vue';
import { installScrollFade } from '../../ui/scroll-fade';
import {
  searchAttachments,
  type AssistantAttachment,
} from '../../shared/assistant/assistant-context';
import type { AppState } from '../../shared/types';
import { workspaceTags } from '../../shared/tabs/tags';
const props = defineProps<{
  app: AppState;
  disabled?: boolean;
  triggerTarget?: HTMLElement;
  imagesEnabled?: boolean;
}>();
const emit = defineEmits<{ images: [] }>();
const open = ref(false);
const pickerHeader = ref<HTMLElement>();
let removeFade: (() => void) | undefined;
watch(
  pickerHeader,
  (header) => {
    removeFade?.();
    const viewport = header?.parentElement?.querySelector<HTMLElement>('[data-slot=viewport]');
    removeFade = viewport ? installScrollFade(viewport) : undefined;
  },
  { flush: 'post' },
);
onUnmounted(() => removeFade?.());
const attachments = defineModel<AssistantAttachment[]>({ required: true });
const key = (item: AssistantAttachment) => `${item.kind}:${item.id}`;
const search = ref('');
const page = ref(0);
type ContextKind = AssistantAttachment['kind'] | 'all' | 'selected';
const kind = ref<ContextKind>('all');
const kinds: Array<{ value: ContextKind; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'tab', label: 'Tabs' },
  { value: 'tag', label: 'Tags' },
  { value: 'category', label: 'Categories' },
  { value: 'project', label: 'Projects' },
  { value: 'window', label: 'Windows' },
  { value: 'proposal', label: 'Drafts' },
  { value: 'selected', label: 'Selected' },
];
const icons = {
  tab: PhBrowser,
  project: PhFolderSimple,
  tag: PhTag,
  category: PhShapes,
  window: PhAppWindow,
  proposal: PhFileText,
  selection: PhSelection,
};
const placeholder = computed(() =>
  kind.value === 'all'
    ? 'Search workspace context…'
    : kind.value === 'selected'
      ? 'Search selected context…'
      : `Search ${kinds.find((item) => item.value === kind.value)?.label.toLowerCase() || 'context'}…`,
);
const settledSearch = refDebounced(search, 160);
const selectionError = ref('');
watch([search, kind], () => {
  page.value = 0;
});
const records = computed(() => new Map(props.app.records.map((record) => [record.id, record])));
const scopeCounts = computed(() => {
  const counts = new Map<string, number>();
  const memberships = new Map(props.app.memberships.map((item) => [item.recordId, item]));
  const add = (value: string) => counts.set(value, (counts.get(value) || 0) + 1);
  for (const record of props.app.records.filter((item) => item.live)) {
    const membership = memberships.get(record.id);
    add(`window:${record.windowId}`);
    const project = membership ? membership.projectId : record.projectId;
    if (project) add(`project:${project}`);
    if (membership?.categoryId) add(`category:${membership.categoryId}`);
  }
  for (const tag of workspaceTags(props.app)) counts.set(`tag:${tag.name}`, tag.count);
  return counts;
});
const result = computed(() => {
  if (kind.value !== 'selected')
    return searchAttachments(
      props.app,
      settledSearch.value,
      page.value * 50,
      50,
      kind.value === 'all' ? undefined : kind.value,
    );
  const needle = settledSearch.value.trim().toLocaleLowerCase();
  const matching = attachments.value.filter((item) =>
    `${item.label} ${item.id} ${item.kind === 'tab' ? records.value.get(item.id)?.url || '' : ''}`
      .toLocaleLowerCase()
      .includes(needle),
  );
  return {
    items: matching.slice(page.value * 50, (page.value + 1) * 50),
    hasMore: matching.length > (page.value + 1) * 50,
  };
});
function description(item: AssistantAttachment) {
  if (item.kind === 'tab') {
    const record = records.value.get(item.id);
    if (!record?.live) return 'No longer open';
    try {
      return new URL(record.url).host || record.url;
    } catch {
      return record.url;
    }
  }
  if (item.kind === 'selection') return `${item.recordIds?.length || 0} selected tabs`;
  if (item.kind === 'proposal')
    return (
      props.app.collectionProposals.find((entry) => entry.id === item.id)?.status || 'Saved draft'
    );
  const count = scopeCounts.value.get(key(item)) || 0;
  const summary = count ? `${count} open ${count === 1 ? 'tab' : 'tabs'}` : 'No open tabs';
  if (item.kind === 'category') {
    const category = props.app.categories.find((entry) => entry.id === item.id);
    const project = props.app.projects.find((entry) => entry.id === category?.projectId);
    return project ? `${project.name} · ${summary}` : summary;
  }
  return summary;
}
const items = computed(() =>
  result.value.items.map((item) => ({
    ...item,
    value: key(item),
    disabled: search.value !== settledSearch.value,
    label:
      item.kind === 'category'
        ? props.app.categories.find((entry) => entry.id === item.id)?.name || item.label
        : item.label,
    description: description(item),
  })),
);
const selected = computed({
  get: () => attachments.value.map(key),
  set: (values: string[]) => {
    if (values.length > 100) {
      selectionError.value =
        'Attach up to 100 items. Attach a window, project or proposal to include its tabs.';
      return;
    }
    selectionError.value = '';
    const available = [...attachments.value, ...result.value.items];
    attachments.value = [
      ...new Map(
        available.filter((item) => values.includes(key(item))).map((item) => [key(item), item]),
      ).values(),
    ];
  },
});
async function copy(item: AssistantAttachment) {
  await navigator.clipboard.writeText(
    item.kind === 'selection' ? item.recordIds?.join('\n') || '' : item.id,
  );
}
</script>
<template>
  <div class="flex min-w-0 flex-col gap-2" data-assistant-attachments>
    <UiScrollArea
      v-if="attachments.length"
      data-attachment-preview
      viewport-class="max-h-32"
      content-class="flex flex-wrap gap-1 px-1"
    >
      <div
        v-for="item in attachments"
        :key="key(item)"
        class="flex min-w-0 max-w-full items-center gap-1 rounded-md bg-selected px-2 py-1 text-xs"
      >
        <span class="min-w-0 truncate" :title="`${item.kind}: ${item.label}`">{{
          item.label
        }}</span>
        <UiButton
          square
          size="small"
          variant="ghost"
          :aria-label="`Copy ${item.kind} ID: ${item.label}`"
          title="Copy ID"
          @click="copy(item)"
          ><PhCopy class="size-3"
        /></UiButton>
        <UiButton
          square
          size="small"
          variant="ghost"
          :disabled="disabled"
          :aria-label="`Remove attachment: ${item.label}`"
          title="Remove attachment"
          @click="attachments = attachments.filter((entry) => key(entry) !== key(item))"
          ><PhX class="size-3"
        /></UiButton>
      </div>
    </UiScrollArea>
    <Teleport :to="triggerTarget || 'body'" :disabled="!triggerTarget">
      <USelectMenu
        v-model:open="open"
        v-model="selected"
        v-model:search-term="search"
        ignore-filter
        multiple
        :items="items"
        value-key="value"
        :disabled="disabled"
        :search-input="{
          placeholder,
          variant: 'outline',
          ui: { base: 'min-h-8 rounded-md px-3 py-1.5 text-xs' },
        }"
        :filter-fields="['label', 'description', 'id']"
        color="neutral"
        variant="ghost"
        size="sm"
        aria-label="Add attachments"
        class="size-8 min-h-8 shrink-0 justify-center p-0"
        :ui="{
          content:
            'z-50 max-h-[min(23rem,var(--reka-combobox-content-available-height,23rem))] w-[min(24rem,calc(100vw-1.5rem))] overflow-hidden rounded-lg bg-overlay ring-line-strong',
          input: 'border-0 p-2',
          viewport: 'max-h-44 p-1 [scrollbar-width:none]! [&::-webkit-scrollbar]:hidden',
          item: 'flex min-h-10 items-center gap-2 rounded-md px-2 py-1.5 text-xs',
          itemWrapper: 'flex min-w-0 flex-1 flex-col gap-0.5',
          itemLabel: 'truncate',
          itemDescription: 'truncate text-[11px] leading-4 text-muted',
          trailing: 'hidden',
        }"
      >
        <template #default><PhPlus class="size-4 shrink-0" /></template>
        <template #item-leading="{ item }"
          ><component
            :is="icons[item.kind]"
            class="size-4 shrink-0 text-muted"
            weight="bold"
            :data-context-kind="item.kind"
            aria-hidden="true"
        /></template>
        <template #empty>{{
          kind === 'selected' && !attachments.length ? 'No context selected' : 'No matching context'
        }}</template>
        <template #content-top>
          <div ref="pickerHeader" class="flex flex-col gap-1 px-2 pt-1">
            <div class="flex items-center justify-between gap-2">
              <UiButton
                size="small"
                variant="ghost"
                :disabled="disabled || !imagesEnabled"
                :title="
                  imagesEnabled
                    ? 'PNG, JPEG or WebP images'
                    : 'Enable image input in model settings'
                "
                @click.stop="
                  emit('images');
                  open = false;
                "
                ><PhImage class="size-4" />Attach images</UiButton
              >
              <div class="flex items-center gap-1">
                <UiButton
                  size="small"
                  variant="ghost"
                  aria-label="Review selected context"
                  @click.stop="kind = 'selected'"
                  >{{ attachments.length }} selected</UiButton
                >
                <UiButton
                  v-if="attachments.length"
                  size="small"
                  variant="ghost"
                  aria-label="Clear selected context"
                  @click.stop="attachments = []"
                  >Clear</UiButton
                >
              </div>
            </div>
            <UiScrollArea
              horizontal
              hide-scrollbar
              label="Context types"
              viewport-class="max-w-full"
              content-class="flex w-max gap-1 py-1"
              @pointerdown.stop
            >
              <div role="group" aria-label="Context types" class="flex gap-1">
                <UiButton
                  v-for="option in kinds"
                  :key="option.value"
                  size="small"
                  :variant="kind === option.value ? 'secondary' : 'ghost'"
                  :aria-pressed="kind === option.value"
                  class="shrink-0 px-2"
                  @click.stop="kind = option.value"
                  >{{ option.label }}</UiButton
                >
              </div>
            </UiScrollArea>
          </div>
        </template>
        <template #content-bottom>
          <div
            class="flex items-center justify-between gap-1 border-t border-line px-1 py-1 text-xs"
          >
            <UiButton
              square
              size="small"
              variant="ghost"
              aria-label="Previous context page"
              title="Previous context page"
              :disabled="page === 0"
              @click="page--"
              ><PhCaretLeft class="size-3.5"
            /></UiButton>
            <span class="tabular-nums" :aria-label="`Context page ${page + 1}`">{{
              items.length ? `${page * 50 + 1}-${page * 50 + items.length}` : '0 results'
            }}</span>
            <UiButton
              square
              size="small"
              variant="ghost"
              aria-label="Next context page"
              title="Next context page"
              :disabled="!result.hasMore || search !== settledSearch"
              @click="page++"
              ><PhCaretRight class="size-3.5"
            /></UiButton>
          </div>
        </template>
      </USelectMenu>
    </Teleport>
    <p v-if="selectionError" role="alert" class="text-xs text-muted">{{ selectionError }}</p>
  </div>
</template>
