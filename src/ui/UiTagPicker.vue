<script setup lang="ts">
import { computed, ref } from 'vue';
import UInputMenu from '@nuxt/ui/components/InputMenu.vue';
const props = withDefaults(
  defineProps<{ modelValue: string[]; options: string[]; limit?: number; creatable?: boolean }>(),
  { limit: undefined, creatable: true },
);
const emit = defineEmits<{ 'update:modelValue': [value: string[]] }>();
const searchTerm = ref('');
const choices = computed(() => [...new Set([...props.options, ...props.modelValue])].sort());
function update(value: unknown) {
  if (!Array.isArray(value)) return;
  emit(
    'update:modelValue',
    [
      ...new Set(
        value
          .filter((tag): tag is string => typeof tag === 'string')
          .map((tag) => tag.trim())
          .filter((tag) => tag.length > 0 && tag.length <= 80),
      ),
    ].slice(0, props.limit),
  );
}
function create(value: string) {
  const text = value.trim();
  const existing = choices.value.find(
    (tag) => tag.toLocaleLowerCase() === text.toLocaleLowerCase(),
  );
  update([...props.modelValue, existing || text]);
  searchTerm.value = '';
}
</script>
<template>
  <UInputMenu
    v-model:search-term="searchTerm"
    :model-value="modelValue"
    :items="choices"
    :virtualize="choices.length > 100"
    multiple
    :create-item="creatable && (limit === undefined || modelValue.length < limit)"
    :placeholder="creatable ? 'Search or create a tag…' : 'Choose tags…'"
    color="neutral"
    variant="outline"
    class="w-full min-w-0"
    :ui="{
      content: 'z-50 bg-overlay',
      base: 'min-h-9 gap-2',
      tagsItem: 'gap-1 rounded px-2 py-1',
    }"
    @update:model-value="update"
    @create="create"
  />
</template>
