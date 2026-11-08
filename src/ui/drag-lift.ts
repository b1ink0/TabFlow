export type DragPoint = { clientX: number; clientY: number };

/** Keep the rendered row's geometry and the pointer's original grab point. */
export function dragLift(source: HTMLElement, grab: DragPoint) {
  const box = source.getBoundingClientRect();
  const style = getComputedStyle(source);
  const offsetX = grab.clientX - box.left,
    offsetY = grab.clientY - box.top;
  let initialized: HTMLElement | undefined;
  return (preview: HTMLElement, point: DragPoint) => {
    if (initialized !== preview) {
      preview.dataset.dragLift = '';
      preview.setAttribute('aria-hidden', 'true');
      preview.inert = true;
      Object.assign(preview.style, {
        position: 'fixed',
        left: '0',
        top: '0',
        translate: 'none',
        margin: '0',
        width: `${Math.min(box.width, innerWidth - 16)}px`,
        height: `${box.height}px`,
        minHeight: `${box.height}px`,
        padding: style.padding,
        boxSizing: 'border-box',
        zIndex: '1000',
      });
      initialized = preview;
    }
    preview.style.setProperty(
      '--tab-drag-transform',
      `translate3d(${Math.max(8, Math.min(point.clientX - offsetX, innerWidth - Math.min(box.width, innerWidth - 16) - 8))}px,${Math.max(0, Math.min(point.clientY - offsetY, innerHeight - box.height))}px,0)`,
    );
    positionDragFeedback(preview);
  };
}
import { positionDragFeedback } from './drag-marker';
