<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useEventListener } from '@vueuse/core';
import UiButton from '../../ui/UiButton.vue';
import { rpc } from '../../shared/rpc';
import { useWorkspace } from '../../stores/workspace';

const store = useWorkspace();
const side = ref<'left' | 'right' | null>(null);
async function refreshPosition() {
  try {
    const layout = await chrome.sidePanel?.getLayout?.();
    side.value = layout?.side === 'left' || layout?.side === 'right' ? layout.side : null;
  } catch {
    side.value = null;
  }
}
onMounted(refreshPosition);
useEventListener(window, 'focus', refreshPosition);
useEventListener(document, 'visibilitychange', () => {
  if (!document.hidden) void refreshPosition();
});
</script>
<template>
  <section class="flex min-w-0 flex-col items-start gap-3 pb-6">
    <h2 class="text-sm font-semibold">Browser side panel</h2>
    <p class="text-[13px] text-secondary" role="status">
      {{
        side
          ? `Current position: ${side === 'left' ? 'Left' : 'Right'}`
          : 'Position managed by your browser'
      }}
    </p>
    <UiButton @click="store.run(() => rpc('openBrowserAppearance', undefined))">
      Change in browser settings
    </UiButton>
    <p class="text-xs leading-5 text-muted">
      Choose Left or Right in your browser’s Appearance settings. This moves TabFlow beside web
      pages. The browser controls placement; TabFlow cannot change it directly.
    </p>
  </section>
</template>
