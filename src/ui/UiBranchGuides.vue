<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef } from 'vue';
import { useEventListener, useMutationObserver, useResizeObserver } from '@vueuse/core';

const svg = ref<SVGSVGElement>();
const target = computed(() => svg.value?.parentElement);
const viewBox = ref('0 0 1 1');
const paths = shallowRef<Array<{ id: string; parentId: string; d: string }>>([]);
const families = computed(() => {
  const grouped = new Map<string, typeof paths.value>();
  for (const path of paths.value) {
    const family = grouped.get(path.parentId) || [];
    family.push(path);
    grouped.set(path.parentId, family);
  }
  return [...grouped].map(([id, children]) => ({ id, children }));
});
const hovered = ref<string>(),
  focused = ref<string>();
const highlighted = computed(() => {
  const selected = hovered.value || focused.value;
  const parents = new Set<string>();
  const byChild = new Map(paths.value.map((path) => [path.id, path.parentId]));
  let id = selected;
  while (id && !parents.has(id)) {
    parents.add(id);
    id = byChild.get(id);
  }
  return parents;
});
interface Anchor {
  x: number;
  left: number;
  top: number;
  bottom: number;
  parent?: string;
}
let frame = 0;
function measure() {
  const element = svg.value;
  if (!element?.parentElement) return;
  if (element.classList.contains('invisible')) return;
  const bounds = element.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return;
  viewBox.value = `0 0 ${bounds.width} ${bounds.height}`;
  const nodes = new Map<string, Anchor>();
  for (const row of element.parentElement.querySelectorAll<HTMLElement>('[data-tab-tree-id]')) {
    const icon = row.querySelector<HTMLElement>('[data-tab-tree-icon]');
    if (!icon || !row.dataset.tabTreeId) continue;
    const rect = icon.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    nodes.set(row.dataset.tabTreeId, {
      x: rect.left + rect.width / 2 - bounds.left,
      left: rect.left - bounds.left,
      top: rect.top - bounds.top,
      bottom: rect.bottom - bounds.top,
      parent: row.dataset.tabTreeParent,
    });
  }
  const next: Array<{ id: string; parentId: string; d: string }> = [];
  const families = new Map<string, Array<{ id: string; anchor: Anchor }>>();
  for (const [id, child] of nodes) {
    const parent = child.parent ? nodes.get(child.parent) : undefined;
    if (!parent || child.top <= parent.bottom) continue;
    const family = families.get(child.parent!) || [];
    family.push({ id, anchor: child });
    families.set(child.parent!, family);
  }
  for (const [parentId, children] of families) {
    const parent = nodes.get(parentId)!;
    if (children.length > 1) {
      const rail = Math.min(parent.left, ...children.map(({ anchor }) => anchor.left)) - 4;
      const parentY = parent.bottom;
      const shoulderY = parentY + 6;
      const shoulderRadius = Math.min(4, (parent.x - rail) / 2);
      for (const [index, { id, anchor: child }] of children.entries()) {
        const childY = (child.top + child.bottom) / 2;
        const radius = Math.min(4, (childY - shoulderY) / 4);
        const last = index === children.length - 1;
        next.push({
          id,
          parentId,
          d: last
            ? `M ${parent.x} ${parentY} V ${shoulderY - shoulderRadius} Q ${parent.x} ${shoulderY} ${parent.x - shoulderRadius} ${shoulderY} H ${rail + shoulderRadius} Q ${rail} ${shoulderY} ${rail} ${shoulderY + shoulderRadius} V ${childY - radius} Q ${rail} ${childY} ${rail + radius} ${childY} H ${child.left}`
            : `M ${rail} ${childY - radius} Q ${rail} ${childY} ${rail + radius} ${childY} H ${child.left}`,
        });
      }
      continue;
    }
    const { id, anchor: child } = children[0]!;
    const start = parent.bottom,
      end = child.top;
    const middle = (start + end) / 2;
    const offset = child.x - parent.x;
    const direction = Math.sign(offset);
    const radius = Math.min(4, Math.abs(offset) / 2, (end - start) / 4);
    next.push({
      id,
      parentId,
      d: radius
        ? `M ${parent.x} ${start} V ${middle - radius} Q ${parent.x} ${middle} ${parent.x + direction * radius} ${middle} H ${child.x - direction * radius} Q ${child.x} ${middle} ${child.x} ${middle + radius} V ${end}`
        : `M ${parent.x} ${start} V ${end}`,
    });
  }
  if (
    next.length !== paths.value.length ||
    next.some(
      (path, index) =>
        path.id !== paths.value[index]?.id ||
        path.parentId !== paths.value[index]?.parentId ||
        path.d !== paths.value[index]?.d,
    )
  )
    paths.value = next;
}
function schedule() {
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(measure);
}
function rowId(node: EventTarget | null) {
  if (!(node instanceof Element)) return undefined;
  const row = node.closest<HTMLElement>('[data-tab-tree-id]');
  return row && target.value?.contains(row) ? row.dataset.tabTreeId : undefined;
}
useEventListener(target, 'pointerover', (event) => {
  hovered.value = rowId(event.target);
});
useEventListener(target, 'pointerleave', () => {
  hovered.value = undefined;
});
useEventListener(target, 'focusin', (event) => {
  focused.value = rowId(event.target);
});
useEventListener(target, 'focusout', (event) => {
  focused.value = rowId(event.relatedTarget);
});
useResizeObserver(target, schedule);
useMutationObserver(target, schedule, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['class', 'style', 'data-tab-tree-id', 'data-tab-tree-parent'],
});
onMounted(schedule);
onUnmounted(() => cancelAnimationFrame(frame));
</script>
<template>
  <svg
    ref="svg"
    :viewBox="viewBox"
    preserveAspectRatio="none"
    style="border: 0"
    aria-hidden="true"
    data-tab-parent-connectors
    class="pointer-events-none absolute inset-0 z-1 size-full overflow-visible fill-none"
  >
    <g
      v-for="family in families"
      :key="family.id"
      :opacity="highlighted.has(family.id) ? 1 : 'var(--tree-guide-opacity)'"
      :style="{ color: 'var(--tree-guide-color)' }"
    >
      <path
        v-for="path in family.children"
        :key="path.id"
        :data-child-id="path.id"
        :data-parent-id="path.parentId"
        :d="path.d"
        :stroke="highlighted.has(path.parentId) ? 'var(--text-muted)' : 'currentColor'"
        stroke-width="1.25"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </g>
  </svg>
</template>
