<script setup lang="ts">
import UCheckbox from '@nuxt/ui/components/Checkbox.vue';
import type { ClassValue } from 'clsx';
defineProps<{
  modelValue: boolean;
  label: string;
  class?: ClassValue;
  disabled?: boolean;
  indeterminate?: boolean;
}>();
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();
</script>
<template>
  <UCheckbox
    :model-value="indeterminate ? 'indeterminate' : modelValue"
    :aria-label="label"
    :disabled="disabled"
    color="neutral"
    size="md"
    :class="$props.class"
    :ui="{
      base: 'cursor-pointer rounded ring-line-strong data-[state=unchecked]:bg-surface',
      root: 'inline-flex shrink-0',
    }"
    @update:model-value="emit('update:modelValue', $event === true)"
  />
</template>
