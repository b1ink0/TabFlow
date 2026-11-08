<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { ScrollAreaRoot, ScrollAreaViewport, ScrollAreaScrollbar, ScrollAreaThumb } from 'reka-ui';
import { cn } from '../shared/cn';
import { vScrollFade } from './scroll-fade';
const props = withDefaults(
  defineProps<{
    as?: string;
    contentClass?: string;
    viewportClass?: string;
    label?: string;
    horizontal?: boolean;
    hideScrollbar?: boolean;
  }>(),
  {
    as: 'div',
    contentClass: undefined,
    viewportClass: undefined,
    label: undefined,
    horizontal: false,
    hideScrollbar: false,
  },
);
const viewport = ref<InstanceType<typeof ScrollAreaViewport>>();
function wheel(event: WheelEvent) {
  const element = viewport.value?.viewportElement;
  if (
    !props.horizontal ||
    !(element instanceof HTMLElement) ||
    event.ctrlKey ||
    Math.abs(event.deltaX) >= Math.abs(event.deltaY)
  )
    return;
  const before = element.scrollLeft;
  element.scrollLeft += event.deltaY;
  if (element.scrollLeft !== before) event.preventDefault();
}
const emit = defineEmits<{ viewport: [element: HTMLElement | undefined] }>();
onMounted(() => {
  const element = viewport.value?.viewportElement;
  if (element instanceof HTMLElement) emit('viewport', element);
});
onUnmounted(() => emit('viewport', undefined));
</script>
<template>
  <ScrollAreaRoot
    v-scroll-fade
    :as="as"
    :aria-label="as === 'nav' ? label : undefined"
    :type="hideScrollbar ? 'always' : 'hover'"
    class="relative min-h-0 min-w-0 overflow-hidden"
    data-tabflow-scroll
    @wheel="wheel"
    ><ScrollAreaViewport
      ref="viewport"
      :class="cn('size-full rounded-[inherit]', viewportClass)"
      :aria-label="label"
      :tabindex="label ? 0 : undefined"
      ><div :class="contentClass"><slot /></div></ScrollAreaViewport
    ><ScrollAreaScrollbar
      :orientation="horizontal ? 'horizontal' : 'vertical'"
      :class="
        cn(
          'z-10 flex touch-none select-none p-0.5',
          horizontal ? 'h-2 flex-col' : 'w-2',
          (hideScrollbar || horizontal) && 'pointer-events-none opacity-0',
        )
      "
      ><ScrollAreaThumb
        class="relative flex-1 rounded-full bg-line-strong hover:bg-muted" /></ScrollAreaScrollbar
  ></ScrollAreaRoot>
</template>
