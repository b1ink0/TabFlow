<script setup lang="ts">
import USwitch from '@nuxt/ui/components/Switch.vue';
const props = defineProps<{
  modelValue: boolean;
  label: string;
  description?: string;
  trailing?: boolean;
}>();
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();
</script>
<template>
  <USwitch
    :model-value="modelValue"
    :label="label"
    :description="description"
    color="neutral"
    :ui="{
      base: '',
      container: props.trailing ? 'order-2 self-center shrink-0' : undefined,
      root: 'flex items-start gap-3 py-1',
      label: 'text-[13px] font-normal text-ink',
      description: 'text-xs leading-5 text-muted',
      wrapper: 'min-w-0 flex-1',
    }"
    @update:model-value="emit('update:modelValue', $event)"
  />
</template>
