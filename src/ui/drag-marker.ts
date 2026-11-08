export function positionDragFeedback(preview: HTMLElement) {
  const feedback = document.querySelector<HTMLElement>('[data-drag-feedback]');
  if (!feedback) return;
  const box = preview.getBoundingClientRect();
  feedback.style.left = `${Math.max(8, box.left)}px`;
  feedback.style.maxWidth = `${Math.min(box.width, innerWidth - 16)}px`;
  const height = feedback.getBoundingClientRect().height;
  feedback.style.top = `${box.bottom + height + 6 <= innerHeight ? box.bottom + 4 : Math.max(4, box.top - height - 4)}px`;
}

export function dragMarker() {
  let marker: HTMLDivElement | undefined;
  let feedback: HTMLDivElement | undefined;
  return {
    update(target: HTMLElement, position: string) {
      marker ||= document.createElement('div');
      marker.className = 'drag-drop-marker';
      marker.setAttribute('aria-hidden', 'true');
      feedback ||= document.createElement('div');
      feedback.className = 'drag-drop-feedback';
      feedback.dataset.dragFeedback = '';
      feedback.setAttribute('aria-hidden', 'true');
      const action =
        target.dataset.treeDropLabel ||
        { before: 'Move above', after: 'Move below', inside: 'Nest inside', root: 'Move to root' }[
          position
        ] ||
        'Move';
      const title = target
        .querySelector('[data-tab-tree-title], [data-reorder-label]')
        ?.textContent?.trim();
      const message = title ? `${action} · ${title}` : action;
      if (feedback.textContent !== message) feedback.textContent = message;
      if (!feedback.isConnected) document.body.appendChild(feedback);
      const box = target.getBoundingClientRect();
      const inside = position === 'inside';
      Object.assign(marker.style, {
        left: `${box.left}px`,
        top: `${inside ? box.top : (position === 'after' || position === 'root' ? box.bottom : box.top) - 1}px`,
        width: `${box.width}px`,
        height: inside ? `${box.height}px` : '2px',
        border: inside ? '1px solid var(--text-muted)' : 'none',
        background: inside ? 'transparent' : 'var(--text-muted)',
        borderRadius: inside ? '6px' : '0',
      });
      if (!marker.isConnected) document.body.appendChild(marker);
      const preview = document.querySelector<HTMLElement>('.tab-drag-preview');
      if (preview) positionDragFeedback(preview);
    },
    clear() {
      marker?.remove();
      marker = undefined;
      feedback?.remove();
      feedback = undefined;
    },
  };
}
