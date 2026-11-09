import { onUnmounted } from 'vue';
import { useEventListener } from '@vueuse/core';
import type { MoveEvent, DraggableEvent } from 'vue-draggable-plus';
import { useWorkspace } from '../../stores/workspace';
import { rpc } from '../../shared/rpc';
import { workspaceEditBaseline } from '../../shared/workspace/workspace-edits';
import {
  tabTreeDrop,
  tabTreeSectionDrop,
  type TreeDropPosition,
} from '../../shared/tabs/tab-tree-drop';
import { tabDragIndex } from '../../shared/tabs/tab-tree-drag';
import { dragLift, type DragPoint } from '../../ui/drag-lift';
import { dragMarker } from '../../ui/drag-marker';

export function useTabTreeDrag(
  commitOrder: (
    sourceId: string,
    targetId: string,
    position: TreeDropPosition,
    movedIds: string[],
    sectionId?: string,
  ) => void,
) {
  const store = useWorkspace();
  let intent:
    | {
        sourceId: string;
        targetId: string;
        position: TreeDropPosition;
        section?: { id: string; projectId: string; categoryId: string | null };
      }
    | undefined;
  let indicator: HTMLElement | undefined;
  const marker = dragMarker();
  let lastPoint: { clientX: number; clientY: number } | undefined;
  let draggedId: string | undefined;
  let index: ReturnType<typeof tabDragIndex> | undefined;
  let frame = 0,
    viewport: HTMLElement | undefined;
  let preview: HTMLElement | null = null;
  let grabPoint: DragPoint | undefined;
  let lift: ReturnType<typeof dragLift> | undefined;
  useEventListener(
    'pointerdown',
    (event) => {
      if (event.target instanceof Element && event.target.closest('[data-tab-tree-id]'))
        grabPoint = { clientX: event.clientX, clientY: event.clientY };
    },
    { capture: true },
  );
  let lastIndicatorKey = '';
  let needsHitTest = false;
  function setIndicator(node?: HTMLElement, position?: TreeDropPosition, label = '') {
    const key = node ? `${node.dataset.tabTreeId || node.dataset.sectionId}:${position}` : '';
    if (indicator === node && key === lastIndicatorKey) {
      if (node && position) marker.update(node, position);
      return;
    }
    clear();
    indicator = node;
    lastIndicatorKey = key;
    if (node && position) {
      node.dataset.treeDrop = position;
      node.dataset.treeDropLabel = label;
      marker.update(node, position);
    }
  }
  function tick() {
    frame = 0;
    if (!draggedId || !lastPoint || !store.draggingTabs) return;
    preview ||= document.querySelector<HTMLElement>('.tab-drag-preview[data-tab-tree-id]');
    if (preview) lift?.(preview, lastPoint);
    let scrolled = false;
    if (viewport) {
      const rect = viewport.getBoundingClientRect();
      let bottom = Math.min(rect.bottom, innerHeight);
      for (const footer of document.querySelectorAll('[data-tabflow-sticky-footer]')) {
        const box = footer.getBoundingClientRect();
        if (box.width && box.left < rect.right && box.right > rect.left && box.top > rect.top)
          bottom = Math.min(bottom, box.top);
      }
      const top = Math.max(0, rect.top),
        zone = 48;
      const velocity =
        lastPoint.clientY > bottom - zone
          ? Math.min(18, (lastPoint.clientY - bottom + zone) / 3)
          : lastPoint.clientY < top + zone
            ? -Math.min(18, (top + zone - lastPoint.clientY) / 3)
            : 0;
      if (lastPoint.clientX >= rect.left && lastPoint.clientX <= rect.right && velocity) {
        const previous = viewport.scrollTop;
        viewport.scrollTop += velocity;
        scrolled = previous !== viewport.scrollTop;
      }
    }
    if (store.tabTreeMode && (needsHitTest || scrolled)) chooseTarget(draggedId, lastPoint);
    needsHitTest = false;
    if (scrolled) frame = requestAnimationFrame(tick);
  }
  useEventListener(
    document,
    'pointermove',
    (event) => {
      if (store.draggingTabs) {
        lastPoint = { clientX: event.clientX, clientY: event.clientY };
        needsHitTest = true;
        if (draggedId && !frame) frame = requestAnimationFrame(tick);
      }
    },
    { capture: true },
  );
  function clear() {
    marker.clear();
    indicator?.removeAttribute('data-tree-drop');
    indicator?.removeAttribute('data-tree-drop-label');
    indicator = undefined;
    lastIndicatorKey = '';
  }
  function cancel() {
    intent = undefined;
    draggedId = undefined;
    index = undefined;
    cancelAnimationFrame(frame);
    frame = 0;
    clear();
  }
  useEventListener(window, 'blur', cancel);
  useEventListener(document, 'pointercancel', cancel);
  useEventListener(document, 'keydown', (event) => {
    if (event.key === 'Escape') {
      cancel();
    }
  });
  function start(event: DraggableEvent) {
    intent = undefined;
    lastPoint = undefined;
    preview = null;
    const box = event.item.getBoundingClientRect();
    lift = dragLift(
      event.item,
      grabPoint || { clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 },
    );
    draggedId = event.item.dataset.tabTreeId;
    index = store.app && draggedId ? tabDragIndex(store.app, draggedId) : undefined;
    viewport = event.from.closest<HTMLElement>('[data-reka-scroll-area-viewport]') || undefined;
    while (viewport && viewport.scrollHeight <= viewport.clientHeight + 1)
      viewport =
        viewport.parentElement?.closest<HTMLElement>('[data-reka-scroll-area-viewport]') ||
        undefined;
    clear();
    store.draggingTabs = true;
  }
  function move(event: MoveEvent, pointer: Event) {
    if (!store.tabTreeMode) return true;
    const sourceId = event.dragged.dataset.tabTreeId;
    const point =
      pointer instanceof MouseEvent
        ? pointer
        : pointer instanceof TouchEvent
          ? pointer.touches[0]
          : lastPoint;
    if (sourceId && point) {
      lastPoint = { clientX: point.clientX, clientY: point.clientY };
      needsHitTest = true;
      if (!frame) frame = requestAnimationFrame(tick);
    }
    return false;
  }
  function chooseTarget(sourceId: string, point: { clientX: number; clientY: number }) {
    intent = undefined;
    const element = document.elementFromPoint(point.clientX, point.clientY);
    const row = element?.closest<HTMLElement>('[data-tab-tree-id]');
    const targetId = row?.dataset.tabTreeId;
    if (!row || !targetId) {
      const section = element?.closest<HTMLElement>('[data-section-id][data-project-id]');
      if (
        section?.dataset.projectId &&
        section.dataset.sectionId &&
        !section.querySelector('[data-tab-tree-id]') &&
        store.app
      ) {
        try {
          const destination = {
            id: section.dataset.sectionId,
            projectId: section.dataset.projectId,
            categoryId: section.dataset.categoryId || null,
          };
          if (!index?.validSection(destination.projectId, destination.categoryId)) {
            setIndicator();
            return;
          }
          intent = { sourceId, targetId: '', position: 'root', section: destination };
          setIndicator(section, 'inside', 'Move into category');
        } catch {
          /* Invalid section drops do not commit. */
        }
      }
      if (!intent) setIndicator();
      return;
    }
    if (sourceId === targetId) {
      setIndicator();
      return;
    }
    const rect = row.getBoundingClientRect();
    const fraction = (point.clientY - rect.top) / rect.height;
    const icon = row.querySelector('[data-tab-tree-icon]')?.getBoundingClientRect();
    const position: TreeDropPosition =
      icon && point.clientX < icon.left - 8
        ? 'root'
        : fraction < 0.25
          ? 'before'
          : fraction > 0.75
            ? 'after'
            : 'inside';
    try {
      if (!store.app) return;
      if (!index?.validTarget(targetId, position)) {
        setIndicator();
        return;
      }
      intent = { sourceId, targetId, position };
      setIndicator(
        row,
        position,
        position === 'inside'
          ? 'Nest inside'
          : position === 'before'
            ? 'Move above'
            : position === 'after'
              ? 'Move below'
              : 'Move to root',
      );
    } catch {
      // Invalid targets have no drop indicator and cannot commit a partial move.
    }
  }
  async function end(event: DraggableEvent) {
    if (store.tabTreeMode && draggedId && lastPoint) chooseTarget(draggedId, lastPoint);
    cancelAnimationFrame(frame);
    frame = 0;
    store.draggingTabs = false;
    store.suppressTabClicksUntil = Date.now() + 400;
    clear();
    const drop = intent;
    draggedId = undefined;
    index = undefined;
    viewport = undefined;
    intent = undefined;
    if (!store.tabTreeMode) return false;
    if (!drop || event.item.dataset.tabTreeId !== drop.sourceId) return true;
    await store.run(async () => {
      if (!store.app) return;
      const plan = drop.section
        ? tabTreeSectionDrop(
            store.app,
            drop.sourceId,
            drop.section.projectId,
            drop.section.categoryId,
          )
        : tabTreeDrop(store.app, drop.sourceId, drop.targetId, drop.position);
      if (plan.edits.length)
        await rpc('executeWorkspaceEdit', {
          kind: 'workspace_edits',
          summary: drop.position === 'inside' ? 'Nest tab branch' : 'Move tab branch',
          edits: plan.edits.map((edit) => ({
            edit,
            before: workspaceEditBaseline(store.app!, edit),
          })),
        });
      commitOrder(drop.sourceId, drop.targetId, drop.position, plan.movedIds, drop.section?.id);
      if (plan.parentRecordId)
        store.collapsedBranches = store.collapsedBranches.filter(
          (id) => id !== plan.parentRecordId,
        );
      await store.refresh();
    });
    return true;
  }
  onUnmounted(() => {
    cancelAnimationFrame(frame);
    clear();
  });
  return { start, move, end };
}
