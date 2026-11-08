<script setup lang="ts">
import { refDebounced } from '@vueuse/core';
import { computed, onUnmounted, ref, watch } from 'vue';
import USelectMenu from '@nuxt/ui/components/SelectMenu.vue';
import { PhPlus, PhImage, PhX, PhCopy, PhCaretLeft, PhCaretRight } from '@phosphor-icons/vue';
import UiButton from '../../ui/UiButton.vue';
import UiScrollArea from '../../ui/UiScrollArea.vue';
import { installScrollFade } from '../../ui/scroll-fade';
import { searchAttachments, type AssistantAttachment } from '../../shared/assistant-context';
import type { AppState } from '../../shared/types';
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
const settledSearch = refDebounced(search, 160);
const selectionError = ref('');
watch(search, () => {
  page.value = 0;
});
const result = computed(() => searchAttachments(props.app, settledSearch.value, page.value * 50));
const items = computed(() =>
  result.value.items.map((item) => ({
    ...item,
    value: key(item),
    label: `${item.kind} · ${item.label}`,
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
          placeholder: 'Search tabs, projects, tags…',
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
            'z-50 w-[min(24rem,calc(100vw-1.5rem))] overflow-hidden rounded-lg bg-overlay ring-line-strong',
          input: 'border-0 p-2',
          viewport: 'max-h-44 p-1 [scrollbar-width:none]! [&::-webkit-scrollbar]:hidden',
          item: 'min-h-8 rounded-md px-2 py-1.5 text-xs',
          itemLabel: 'truncate',
          itemDescription: 'truncate',
          trailing: 'hidden',
        }"
      >
        <template #default><PhPlus class="size-4 shrink-0" /></template>
        <template #content-top>
          <div ref="pickerHeader" class="flex items-center gap-2 px-2 pt-1">
            <UiButton
              size="small"
              variant="ghost"
              :disabled="disabled || !imagesEnabled"
              :title="
                imagesEnabled ? 'PNG, JPEG or WebP images' : 'Enable image input in model settings'
              "
              @click.stop="
                emit('images');
                open = false;
              "
              ><PhImage class="size-4" />Attach images</UiButton
            >
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
            <span class="tabular-nums" :aria-label="`Context page ${page + 1}`"
              >{{ page * 50 + (items.length ? 1 : 0) }}-{{ page * 50 + items.length }}</span
            >
            <UiButton
              square
              size="small"
              variant="ghost"
              aria-label="Next context page"
              title="Next context page"
              :disabled="!result.hasMore"
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
