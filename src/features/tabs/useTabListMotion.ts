import { watch } from 'vue';
import { useMediaQuery } from '@vueuse/core';
import { useWorkspace } from '../../stores/workspace';

export function useTabListMotion() {
  const store = useWorkspace();
  const reduced = useMediaQuery('(prefers-reduced-motion: reduce)');
  let until = 0,
    count = 0;
  watch(
    () => store.collapsedBranches,
    () => {
      until = performance.now() + 220;
      count = 0;
    },
    { flush: 'sync' },
  );
  function run(element: Element, done: () => void, entering: boolean) {
    if (
      !(element instanceof HTMLElement) ||
      store.draggingTabs ||
      reduced.value ||
      matchMedia('(prefers-reduced-motion: reduce)').matches ||
      performance.now() > until ||
      count++ >= 32
    ) {
      done();
      return;
    }
    const height = element.getBoundingClientRect().height;
    const previous = element.style.overflow;
    element.style.overflow = 'hidden';
    const frames = [
      { height: '0px', opacity: 0 },
      { height: `${height}px`, opacity: 1 },
    ];
    const animation = element.animate(entering ? frames : [...frames].reverse(), {
      duration: 160,
      easing: 'ease-out',
    });
    const finish = () => {
      element.style.overflow = previous;
      done();
    };
    animation.onfinish = finish;
    animation.oncancel = finish;
  }
  return {
    enter: (element: Element, done: () => void) => run(element, done, true),
    leave: (element: Element, done: () => void) => run(element, done, false),
  };
}
