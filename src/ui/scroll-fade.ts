import type { ObjectDirective } from 'vue';

type FadeBinding = { target: HTMLElement; refresh: () => void; dispose: () => void };
const bindings = new WeakMap<HTMLElement, FadeBinding>();

function mount(root: HTMLElement) {
  const target =
    root.querySelector<HTMLElement>('[data-reka-scroll-area-viewport], [role=tablist]') || root;
  if (bindings.get(root)?.target === target) return;
  bindings.get(root)?.dispose();
  let frame = 0;
  let lastState = '';
  function refresh() {
    frame = 0;
    const {
      clientWidth: width,
      clientHeight: height,
      scrollWidth,
      scrollHeight,
      scrollLeft,
      scrollTop,
    } = target;
    const x = Math.abs(scrollLeft);
    const rtl = getComputedStyle(target).direction === 'rtl';
    const left = rtl ? scrollWidth - width - x > 1 : x > 1;
    const right = rtl ? x > 1 : scrollWidth - width - x > 1;
    const top = scrollTop > 1;
    const bottom = scrollHeight - height - scrollTop > 1;
    const horizontal = scrollWidth > width + 1;
    const vertical = scrollHeight > height + 1;
    const stickyHeader = target.querySelector<HTMLElement>('[data-scroll-fade-header]');
    const topInset = stickyHeader
      ? Math.max(
          0,
          Math.min(
            height,
            stickyHeader.getBoundingClientRect().bottom - target.getBoundingClientRect().top,
          ),
        )
      : 0;
    const state = [width, height, horizontal, vertical, left, right, top, bottom, topInset].join(
      ':',
    );
    if (state === lastState) return;
    lastState = state;
    target.dataset.scrollFade = [
      horizontal && left && 'left',
      horizontal && right && 'right',
      vertical && top && 'top',
      vertical && bottom && 'bottom',
    ]
      .filter(Boolean)
      .join(' ');
    const masks: string[] = [];
    if (horizontal) {
      const fade = Math.min(16, width / 4);
      masks.push(
        `linear-gradient(to right, ${left ? `transparent, black ${fade}px` : 'black, black 0px'}, ${right ? `black calc(100% - ${fade}px), transparent` : 'black 100%, black'})`,
      );
    }
    if (vertical) {
      const fade = Math.min(16, height / 4);
      masks.push(
        `linear-gradient(to bottom, ${top ? (topInset ? `black ${topInset}px, transparent ${topInset}px, black ${topInset + fade}px` : `transparent, black ${fade}px`) : 'black, black 0px'}, ${bottom ? `black calc(100% - ${fade}px), transparent` : 'black 100%, black'})`,
      );
    }
    target.style.maskImage = masks.length ? masks.join(', ') : 'none';
    target.style.maskComposite = 'intersect';
  }
  function schedule() {
    if (!frame) frame = requestAnimationFrame(refresh);
  }
  const resize = new ResizeObserver(schedule);
  function observeContent() {
    resize.disconnect();
    resize.observe(target);
    for (const child of target.children) resize.observe(child);
  }
  const mutations = new MutationObserver(() => {
    observeContent();
    schedule();
  });
  mutations.observe(target, { childList: true, subtree: true, characterData: true });
  observeContent();
  target.addEventListener('scroll', schedule, { passive: true });
  schedule();
  bindings.set(root, {
    target,
    refresh: schedule,
    dispose: () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutations.disconnect();
      target.removeEventListener('scroll', schedule);
      target.style.removeProperty('mask-image');
      target.style.removeProperty('mask-composite');
      delete target.dataset.scrollFade;
    },
  });
}

/** Fade only scrollable edges with hidden content; usable on a viewport or its wrapper. */
export function installScrollFade(root: HTMLElement) {
  mount(root);
  return () => {
    bindings.get(root)?.dispose();
    bindings.delete(root);
  };
}

export const vScrollFade: ObjectDirective<HTMLElement> = {
  mounted: mount,
  updated: (root) => {
    mount(root);
    bindings.get(root)?.refresh();
  },
  unmounted: (root) => {
    bindings.get(root)?.dispose();
    bindings.delete(root);
  },
};
