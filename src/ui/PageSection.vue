<script setup lang="ts">
defineProps<{ title: string; description?: string }>();
</script>
<template>
  <section class="flex min-w-0 flex-col gap-5 border-b border-line py-6 last:border-b-0">
    <header class="flex flex-wrap items-start justify-between gap-3">
      <div class="flex min-w-0 basis-56 flex-1 flex-col gap-1.5">
        <h2 class="text-sm font-semibold text-ink">{{ title }}</h2>
        <p v-if="description" class="max-w-xl text-[13px] leading-5 text-muted">
          {{ description }}
        </p>
      </div>
      <div v-if="$slots.actions" class="flex min-w-0 flex-wrap items-center gap-2">
        <slot name="actions" />
      </div>
    </header>
    <slot />
  </section>
</template>
