import { useWorkspace } from '../../stores/workspace';
import { ref } from 'vue';
import { useEventListener } from '@vueuse/core';
import { dragLift, type DragPoint } from '../../ui/drag-lift';
import type { ReorderEvent } from '../../shared/utils/reorder';
export type { ReorderEvent } from '../../shared/utils/reorder';
const dragGeometry = new WeakMap<
  HTMLElement,
  { top: number; left: number; rows: { id: string; x: number; y: number }[] }
>();
export function droppedOrder(
  event: ReorderEvent,
  ids: string[],
  selector: string,
  key: string,
  header?: string,
  horizontal = false,
) {
  const sourceId = event.item.dataset[key];
  const from = sourceId ? ids.indexOf(sourceId) : -1;
  if (!sourceId || from < 0) return ids;
  const next = ids.filter((id) => id !== sourceId);
  let index = event.newDraggableIndex ?? from;
  const original = 'originalEvent' in event ? event.originalEvent : undefined;
  const point =
    original instanceof MouseEvent
      ? original
      : original instanceof TouchEvent
        ? original.changedTouches[0]
        : undefined;
  if (point) {
    const geometry = dragGeometry.get(event.from);
    if (geometry?.rows.length) {
      const container = event.from.getBoundingClientRect();
      const coordinate = horizontal
        ? point.clientX - container.left + geometry.left
        : point.clientY - container.top + geometry.top;
      index = geometry.rows.filter(
        (row) => row.id !== sourceId && (horizontal ? row.x : row.y) < coordinate,
      ).length;
      next.splice(index, 0, sourceId);
      dragGeometry.delete(event.from);
      return next;
    }
    const target = document
      .elementFromPoint(point.clientX, point.clientY)
      ?.closest<HTMLElement>(selector);
    const targetId = target?.dataset[key];
    if (
      target &&
      event.to.contains(target) &&
      targetId &&
      targetId !== sourceId &&
      next.includes(targetId)
    ) {
      const box = (
        header ? target.querySelector(header) || target : target
      ).getBoundingClientRect();
      index =
        next.indexOf(targetId) +
        Number(
          horizontal
            ? point.clientX > box.left + box.width / 2
            : point.clientY > box.top + box.height / 2,
        );
    }
  }
  dragGeometry.delete(event.from);
  next.splice(Math.max(0, Math.min(index, next.length)), 0, sourceId);
  return next;
}
export function useReorderGesture() {
  const store = useWorkspace();
  const active = ref(false);
  let grab: DragPoint | undefined;
  let lift: ReturnType<typeof dragLift> | undefined;
  let frame = 0;
  useEventListener(
    'pointerdown',
    (event) => {
      grab = { clientX: event.clientX, clientY: event.clientY };
    },
    { capture: true },
  );
  useEventListener('pointermove', (event) => {
    const preview = lift && document.querySelector<HTMLElement>('.tab-drag-preview');
    if (preview) lift?.(preview, event);
  });
  return {
    active,
    start: (event: ReorderEvent) => {
      if (event.item.matches('[role=tab]') && grab) {
        lift = dragLift(event.item, grab);
        frame = requestAnimationFrame(() => {
          const preview = document.querySelector<HTMLElement>('.tab-drag-preview');
          if (preview && grab) lift?.(preview, grab);
        });
      }
      const container = event.from.getBoundingClientRect();
      const rows = Array.from(event.from.children).flatMap((child) => {
        if (!(child instanceof HTMLElement)) return [];
        const id =
          child.dataset.projectOrderId || child.dataset.categoryOrderId || child.dataset.categoryId;
        if (!id) return [];
        const header =
          child.querySelector('.project-reorder-trigger, .category-reorder-trigger') || child;
        const rect = header.getBoundingClientRect();
        return [{ id, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }];
      });
      dragGeometry.set(event.from, { top: container.top, left: container.left, rows });
      active.value = true;
      store.draggingTabs = true;
    },
    finish: () => {
      cancelAnimationFrame(frame);
      lift = undefined;
      active.value = false;
      store.draggingTabs = false;
      store.suppressTabClicksUntil = Date.now() + 400;
    },
    click: (event: MouseEvent) => {
      if (
        event.detail &&
        Date.now() < store.suppressTabClicksUntil &&
        event.target instanceof Element &&
        event.target.closest(
          '.project-reorder-trigger, .category-reorder-trigger, [data-category-id], button[data-project-order-id], [role=tab]',
        )
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
  };
}
