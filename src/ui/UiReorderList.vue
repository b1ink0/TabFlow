<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';
import { useEventListener } from '@vueuse/core';
import type { ReorderEvent } from '../shared/utils/reorder';
import { dragLift } from './drag-lift';
import { dragMarker } from './drag-marker';
const props = defineProps<{ draggable: string; handle: string; disabled?: boolean }>();
const emit = defineEmits<{
  start: [event: ReorderEvent];
  end: [event: ReorderEvent];
  cancel: [];
}>();
const root = ref<HTMLElement>();
const marker = dragMarker();
let lift: ReturnType<typeof dragLift> | undefined;
let source: HTMLElement | undefined,
  preview: HTMLElement | undefined,
  indicator: HTMLElement | undefined;
let pointer = -1,
  startX = 0,
  startY = 0,
  x = 0,
  y = 0,
  dragging = false,
  ready = false;
let hold: ReturnType<typeof setTimeout> | undefined;
let frame = 0;
function clear() {
  marker.clear();
  clearTimeout(hold);
  cancelAnimationFrame(frame);
  frame = 0;
  preview?.remove();
  preview = undefined;
  lift = undefined;
  indicator?.removeAttribute('data-reorder-drop');
  indicator = undefined;
  source?.classList.remove('sortable-chosen', 'reorder-source');
  if (root.value?.hasPointerCapture(pointer)) root.value.releasePointerCapture(pointer);
  source = undefined;
  pointer = -1;
  dragging = false;
}
function cancel() {
  const wasDragging = dragging;
  clear();
  if (wasDragging) emit('cancel');
}
function down(event: PointerEvent) {
  if (props.disabled || event.button !== 0 || !root.value || !(event.target instanceof HTMLElement))
    return;
  const item = event.target.closest<HTMLElement>(props.draggable);
  const header = event.target.closest<HTMLElement>(props.handle);
  if (
    !item ||
    item.parentElement !== root.value ||
    !header ||
    !item.contains(header) ||
    event.target.closest('[aria-haspopup=menu]')
  )
    return;
  event.stopPropagation();
  source = item;
  pointer = event.pointerId;
  startX = x = event.clientX;
  startY = y = event.clientY;
  ready = event.pointerType !== 'touch';
  if (!ready)
    hold = setTimeout(() => {
      ready = true;
    }, 200);
}
function tick() {
  frame = 0;
  if (!dragging || !root.value) return;
  const viewport = root.value.closest<HTMLElement>('[data-reka-scroll-area-viewport]');
  if (viewport) {
    const box = viewport.getBoundingClientRect();
    const footer = document.querySelector('[data-tabflow-sticky-footer]')?.getBoundingClientRect();
    const bottom = Math.min(box.bottom, footer?.top ?? innerHeight);
    if (y > bottom - 40) viewport.scrollTop += Math.min(14, (y - bottom + 40) / 3);
    else if (y < box.top + 40) viewport.scrollTop -= Math.min(14, (box.top + 40 - y) / 3);
  }
  frame = requestAnimationFrame(tick);
}
function move(event: PointerEvent) {
  if (event.pointerId !== pointer || !source || !root.value) return;
  x = event.clientX;
  y = event.clientY;
  if (!dragging) {
    if (Math.hypot(x - startX, y - startY) < 6) return;
    if (!ready) {
      cancel();
      return;
    }
    dragging = true;
    root.value.setPointerCapture(pointer);
    emit('start', { item: source, from: root.value, to: root.value, originalEvent: event });
    const header = source.querySelector<HTMLElement>(props.handle) || source;
    lift = dragLift(header, { clientX: startX, clientY: startY });
    preview = header.cloneNode(true) as HTMLElement;
    preview.removeAttribute('id');
    for (const element of preview.querySelectorAll('[id]')) element.removeAttribute('id');
    preview.classList.add('tab-drag-preview');
    document.body.appendChild(preview);
    source.classList.add('sortable-chosen', 'reorder-source');
    frame = requestAnimationFrame(tick);
  }
  event.preventDefault();
  if (preview) lift?.(preview, event);
  const target = document.elementFromPoint(x, y)?.closest<HTMLElement>(props.draggable);
  indicator?.removeAttribute('data-reorder-drop');
  indicator = undefined;
  if (target && target !== source && target.parentElement === root.value) {
    indicator = target.querySelector<HTMLElement>(props.handle) || target;
    indicator.dataset.reorderDrop =
      y < indicator.getBoundingClientRect().top + indicator.offsetHeight / 2 ? 'before' : 'after';
    marker.update(indicator, indicator.dataset.reorderDrop);
  } else marker.clear();
}
function up(event: PointerEvent) {
  if (event.pointerId !== pointer || !source || !root.value) return;
  const item = source,
    from = root.value,
    commit = dragging;
  clear();
  if (commit) {
    event.preventDefault();
    emit('end', { item, from, to: from, originalEvent: event });
  }
}
useEventListener('keydown', (event) => {
  if (event.key === 'Escape') cancel();
});
useEventListener('blur', cancel);
onBeforeUnmount(cancel);
</script>
<template>
  <div
    ref="root"
    @pointerdown="down"
    @pointermove="move"
    @pointerup="up"
    @pointercancel="cancel"
    @lostpointercapture="cancel"
    @dragstart.prevent
  >
    <slot />
  </div>
</template>
