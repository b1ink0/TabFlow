<script setup lang="ts">
import { CollapsibleRoot, CollapsibleTrigger, CollapsibleContent } from 'reka-ui';
import { PhCaretRight as ChevronRight } from '@phosphor-icons/vue';
withDefaults(
  defineProps<{
    open: boolean;
    label: string;
    count?: number;
    level?: 2 | 3;
    flat?: boolean;
    dragHeader?: boolean | 'category';
  }>(),
  {
    level: 2,
    dragHeader: false,
    count: undefined,
  },
);
const emit = defineEmits<{ 'update:open': [value: boolean] }>();
</script>
<template>
  <CollapsibleRoot
    data-disclosure
    :open="flat || open"
    class="flex min-w-0 flex-col"
    @update:open="emit('update:open', $event)"
  >
    <header
      v-if="!flat"
      :class="
        dragHeader === 'category'
          ? 'category-reorder-trigger'
          : dragHeader && 'project-reorder-trigger'
      "
      class="group/disclosure relative flex min-h-12 min-w-0 items-center gap-2 rounded-md hover:bg-hover after:pointer-events-none after:absolute after:bottom-0 after:left-10 after:right-3 after:h-px after:bg-line"
    >
      <component :is="level === 2 ? 'h2' : 'h3'" class="flex min-w-0 flex-1">
        <CollapsibleTrigger
          :class="dragHeader && 'touch-none cursor-grab select-none active:cursor-grabbing'"
          class="flex min-h-12 min-w-0 flex-1 items-center gap-3 rounded-md px-3 py-2 text-left text-[13px] text-ink"
        >
          <ChevronRight
            :class="[
              'size-4 shrink-0 text-muted transition-transform duration-150',
              open && 'rotate-90',
            ]"
          />
          <slot name="marker" />
          <span class="flex min-w-0 flex-1 flex-col gap-0.5"
            ><span data-reorder-label class="truncate font-medium">{{ label }}</span
            ><slot name="description"
          /></span>
          <span
            v-if="count !== undefined"
            class="shrink-0 text-xs font-normal tabular-nums text-muted"
            >{{ count }}</span
          >
        </CollapsibleTrigger>
      </component>
      <div v-if="$slots.actions" class="flex shrink-0 items-center gap-1 pr-2">
        <slot name="actions" />
      </div>
    </header>
    <CollapsibleContent
      class="overflow-hidden data-[state=open]:animate-[reveal_160ms_ease-out] data-[state=closed]:animate-[conceal_140ms_ease-in]"
    >
      <slot />
    </CollapsibleContent>
  </CollapsibleRoot>
</template>
