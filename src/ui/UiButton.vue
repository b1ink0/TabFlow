<script setup lang="ts">
import UButton from '@nuxt/ui/components/Button.vue';
import UTooltip from '@nuxt/ui/components/Tooltip.vue';
import { ref, useAttrs, watch, type ComponentPublicInstance } from 'vue';
import { useEventListener } from '@vueuse/core';
import { cn } from '../shared/cn';
import type { ClassValue } from 'clsx';
defineOptions({ inheritAttrs: false });
const attrs = useAttrs();
const tooltipOpen = ref(false);
const trigger = ref<ComponentPublicInstance>();
function updateTooltip(next: boolean) {
  const element: unknown = trigger.value?.$el;
  tooltipOpen.value =
    next &&
    element instanceof HTMLElement &&
    (element.matches(':hover') || element.matches(':focus-visible'));
}
watch(tooltipOpen, (open, _previous, onCleanup) => {
  if (!open) return;
  const stopMove = useEventListener(document, 'pointermove', (event) => {
    const element: unknown = trigger.value?.$el;
    if (
      !(element instanceof HTMLElement) ||
      !(event.target instanceof Node) ||
      !element.contains(event.target)
    )
      tooltipOpen.value = false;
  });
  const stopDown = useEventListener(
    document,
    'pointerdown',
    () => {
      tooltipOpen.value = false;
    },
    { capture: true },
  );
  const stopBlur = useEventListener(window, 'blur', () => {
    tooltipOpen.value = false;
  });
  onCleanup(() => {
    stopMove();
    stopDown();
    stopBlur();
  });
});
withDefaults(
  defineProps<{
    variant?: 'primary' | 'ghost' | 'danger' | 'default' | 'secondary';
    size?: 'small' | 'default';
    type?: 'button' | 'submit' | 'reset';
    disabled?: boolean;
    square?: boolean;
  }>(),
  { variant: 'default', size: 'default', type: 'button', disabled: false, square: false },
);
</script>
<template>
  <UTooltip
    :open="tooltipOpen"
    :disable-hoverable-content="true"
    :text="typeof attrs.title === 'string' ? attrs.title : undefined"
    :disabled="!attrs.title"
    :delay-duration="250"
    :content="{ collisionPadding: 12 }"
    :ui="{
      content: 'h-auto max-w-[min(20rem,calc(100vw-24px))] py-1.5',
      text: 'min-w-0 whitespace-normal break-words',
    }"
    @update:open="updateTooltip"
  >
    <UButton
      ref="trigger"
      v-bind="{ ...attrs, class: undefined, title: undefined }"
      :type="type"
      :disabled="disabled"
      :color="variant === 'danger' ? 'error' : 'neutral'"
      :variant="
        variant === 'primary'
          ? 'solid'
          : variant === 'secondary'
            ? 'outline'
            : variant === 'ghost' || variant === 'danger'
              ? 'ghost'
              : 'soft'
      "
      :size="size === 'small' ? 'sm' : 'md'"
      :class="
        cn(
          'shrink-0 cursor-pointer justify-center gap-2 rounded-md font-medium transition-colors duration-150',
          size === 'small'
            ? 'min-h-8 text-[13px] max-sm:min-h-10'
            : 'min-h-9 text-[13px] max-sm:min-h-10',
          square && (size === 'small' ? 'size-8 p-0 max-sm:size-10' : 'size-9 p-0 max-sm:size-10'),
          variant !== 'primary' && 'not-disabled:hover:bg-hover not-disabled:active:bg-selected',
          attrs.class as ClassValue,
        )
      "
      @pointerdown="tooltipOpen = false"
      @pointerleave="tooltipOpen = false"
      @blur="tooltipOpen = false"
    >
      <slot />
    </UButton>
  </UTooltip>
</template>
