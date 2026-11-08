<script setup lang="ts">
import { ref } from 'vue';
import UCollapsible from '@nuxt/ui/components/Collapsible.vue';
import { PhCaretRight } from '@phosphor-icons/vue';
const props = withDefaults(defineProps<{ open?: boolean }>(), { open: undefined });
const emit = defineEmits<{ 'update:open': [value: boolean] }>();
const localOpen = ref(false);
function update(value: boolean) {
  localOpen.value = value;
  emit('update:open', value);
}
</script>
<template>
  <UCollapsible
    data-ui-collapsible
    :open="props.open ?? localOpen"
    :unmount-on-hide="true"
    class="min-w-0"
    @update:open="update"
  >
    <template #default="{ open: expanded }">
      <button
        type="button"
        class="flex min-h-8 min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-xs text-muted hover:bg-hover"
      >
        <PhCaretRight
          class="size-3.5 shrink-0 transition-transform"
          :class="expanded && 'rotate-90'"
        />
        <span class="min-w-0 break-words"><slot name="label" /></span>
      </button>
    </template>
    <template #content><slot /></template>
  </UCollapsible>
</template>
