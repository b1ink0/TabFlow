<script setup lang="ts">
import UPopover from '@nuxt/ui/components/Popover.vue';
import { onUnmounted, ref, watch } from 'vue';
import { useEventListener } from '@vueuse/core';
import UiButton from './UiButton.vue';
const props = defineProps<{
  title: string;
  url: string;
  details: string;
  note?: string;
  tags?: readonly string[];
  disabled?: boolean;
}>();
const emit = defineEmits<{ tag: [name: string] }>();
const open = ref(false);
const trigger = ref<HTMLElement>(),
  popup = ref<HTMLElement>();
let leaveTimer: ReturnType<typeof setTimeout> | undefined;
function dismiss() {
  clearTimeout(leaveTimer);
  open.value = false;
}
watch(open, (shown, _previous, onCleanup) => {
  if (!shown) return;
  const stopMove = useEventListener(document, 'pointermove', (event) => {
    if (!open.value) return;
    clearTimeout(leaveTimer);
    if (
      event.target instanceof Node &&
      (trigger.value?.contains(event.target) || popup.value?.contains(event.target))
    )
      return;
    leaveTimer = setTimeout(dismiss, 150);
  });
  const stopDown = useEventListener(
    document,
    'pointerdown',
    (event) => {
      if (!(event.target instanceof Node) || !popup.value?.contains(event.target)) dismiss();
    },
    { capture: true },
  );
  const stopScroll = useEventListener(document, 'scroll', dismiss, { capture: true });
  const stopBlur = useEventListener(window, 'blur', dismiss);
  onCleanup(() => {
    stopMove();
    stopDown();
    stopScroll();
    stopBlur();
    clearTimeout(leaveTimer);
  });
});
onUnmounted(() => clearTimeout(leaveTimer));
watch(
  () => props.disabled,
  (disabled) => {
    if (disabled) open.value = false;
  },
);
</script>

<template>
  <div ref="trigger" class="flex min-w-0 flex-1">
    <UPopover
      :open="!disabled && open"
      mode="hover"
      :open-delay="650"
      :close-delay="150"
      :content="{ side: 'bottom', align: 'start', collisionPadding: 12 }"
      class="min-w-0 flex-1"
      :ui="{ content: 'z-50 w-72 max-w-[calc(100vw-24px)] bg-surface p-3 shadow-lg' }"
      @update:open="open = !disabled && $event"
    >
      <slot />
      <template #content>
        <div ref="popup" class="flex min-w-0 flex-col gap-2 text-xs" data-tab-hover-card>
          <p class="line-clamp-2 break-words text-[13px] font-medium leading-5 text-ink">
            {{ title }}
          </p>
          <p class="line-clamp-2 break-all leading-5 text-secondary">{{ url }}</p>
          <p class="text-muted">{{ details }}</p>
          <p v-if="note" class="line-clamp-2 break-words leading-5 text-secondary">{{ note }}</p>
          <div
            v-if="tags?.length"
            class="flex max-h-40 flex-wrap gap-1 overflow-y-auto"
            aria-label="Tab tags"
          >
            <UiButton
              v-for="tag in tags"
              :key="tag"
              size="small"
              variant="ghost"
              :title="`Filter tabs tagged ${tag}`"
              :aria-label="`Filter tabs tagged ${tag}`"
              @click="
                emit('tag', tag);
                open = false;
              "
              >{{ tag }}</UiButton
            >
          </div>
        </div>
      </template>
    </UPopover>
  </div>
</template>
