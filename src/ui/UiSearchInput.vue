<script setup lang="ts">
import UInput from '@nuxt/ui/components/Input.vue';
defineProps<{ modelValue: string; placeholder?: string; label: string }>();
defineEmits<{ 'update:modelValue': [value: string] }>();
</script>
<template>
  <UInput
    :model-value="modelValue"
    type="search"
    icon="i-ph-magnifying-glass-bold"
    :aria-label="label"
    :placeholder="placeholder"
    color="neutral"
    variant="outline"
    class="w-full min-w-0"
    :ui="{
      base: 'min-h-9 rounded-md text-[13px]',
    }"
    @update:model-value="$emit('update:modelValue', String($event ?? ''))"
  />
</template>
