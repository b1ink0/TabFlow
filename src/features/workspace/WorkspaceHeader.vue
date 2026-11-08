<script setup lang="ts">
import { PhList as Menu } from '@phosphor-icons/vue';
import UiButton from '../../ui/UiButton.vue';
defineProps<{ title: string; description?: string; compact?: boolean }>();
const emit = defineEmits<{ navigation: [] }>();
</script>
<template>
  <header
    class="relative after:pointer-events-none after:absolute after:inset-x-4 after:bottom-0 after:h-px after:bg-line"
    :class="
      compact
        ? 'flex shrink-0 items-center justify-between gap-2 px-4 py-3'
        : 'flex min-h-16 shrink-0 items-center justify-between gap-2 px-4 py-3 sm:min-h-24 sm:gap-4 sm:px-8 sm:py-5 sm:after:inset-x-8'
    "
  >
    <div class="flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
      <UiButton
        square
        variant="ghost"
        size="small"
        :class="compact ? undefined : 'lg:hidden'"
        title="Open navigation"
        aria-label="Open navigation"
        data-navigation-trigger
        @click="emit('navigation')"
        ><Menu class="size-4"
      /></UiButton>
      <div class="flex min-w-0 flex-col gap-1.5">
        <h1
          :class="
            compact
              ? 'truncate text-base font-semibold tracking-tight'
              : 'truncate text-base font-semibold tracking-tight sm:text-xl'
          "
        >
          <slot name="title">{{ title }}</slot>
        </h1>
        <p v-if="description && !compact" class="hidden text-[13px] leading-5 text-muted sm:block">
          {{ description }}
        </p>
      </div>
    </div>
    <div :class="compact ? 'flex shrink-0 items-center gap-1' : 'flex shrink-0 items-center gap-2'">
      <slot />
    </div>
  </header>
</template>
