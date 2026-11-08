import { useColorMode } from '@vueuse/core';
import { nextTick } from 'vue';

export function useTheme() {
  const preference = useColorMode({
    storageKey: 'tabflow-theme',
    initialValue: 'dark',
    disableTransition: false,
  });
  async function toggle(event?: Event) {
    const root = document.documentElement;
    if (root.dataset.themeTransition) return;
    const next = root.classList.contains('dark') ? 'light' : 'dark';
    const update = async () => {
      preference.value = next;
      await nextTick();
    };
    if (!document.startViewTransition || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      await update();
      return;
    }
    const button = event?.currentTarget instanceof HTMLElement ? event.currentTarget : undefined;
    const bounds = button?.getBoundingClientRect();
    const x = bounds ? bounds.left + bounds.width / 2 : innerWidth / 2;
    const y = bounds ? bounds.top + bounds.height / 2 : innerHeight / 2;
    const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
    root.dataset.themeTransition = 'running';
    try {
      const transition = document.startViewTransition(update);
      await transition.ready;
      root.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
        {
          duration: 360,
          easing: 'ease-out',
          pseudoElement: '::view-transition-new(root)',
        },
      );
      await transition.finished;
    } catch {
      // A failed/unsupported visual transition must not block the saved appearance.
      await update();
    } finally {
      delete root.dataset.themeTransition;
    }
  }
  return { preference, toggle };
}
