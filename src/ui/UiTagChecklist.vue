<script setup lang="ts">
import { computed, ref } from 'vue';
import UiCheckbox from './UiCheckbox.vue';
import UiSearchInput from './UiSearchInput.vue';
import UiSelect from './UiSelect.vue';
import UiScrollArea from './UiScrollArea.vue';
import UiButton from './UiButton.vue';
const props = defineProps<{
  modelValue: string[];
  options: string[];
  mode: 'any' | 'all';
  untagged: boolean;
}>();
const emit = defineEmits<{
  'update:modelValue': [value: string[]];
  'update:mode': [value: 'any' | 'all'];
  'update:untagged': [value: boolean];
}>();
const query = ref(''),
  limit = ref(100);
const matches = computed(() =>
  [...new Set([...props.modelValue, ...props.options])]
    .sort(
      (left, right) =>
        Number(props.modelValue.includes(right)) - Number(props.modelValue.includes(left)) ||
        left.localeCompare(right),
    )
    .filter((tag) => tag.toLocaleLowerCase().includes(query.value.toLocaleLowerCase())),
);
function toggle(tag: string) {
  emit('update:untagged', false);
  emit(
    'update:modelValue',
    props.modelValue.includes(tag)
      ? props.modelValue.filter((item) => item !== tag)
      : [...props.modelValue, tag].slice(0, 20),
  );
}
</script>
<template>
  <div class="flex min-w-0 flex-col gap-2">
    <UiSearchInput
      v-model="query"
      label="Find tags"
      placeholder="Find a tag…"
      @update:model-value="limit = 100"
    /><UiScrollArea
      :style="{ height: `${Math.min(6, Math.max(2, matches.length + 1)) * 40}px` }"
      label="Available tags"
      content-class="flex flex-col gap-0.5"
      ><label class="flex min-h-9 items-center gap-2 rounded px-2 hover:bg-hover"
        ><UiCheckbox
          :model-value="untagged"
          label="Untagged only"
          @update:model-value="
            emit('update:untagged', $event);
            emit('update:modelValue', []);
          "
        /><span class="text-[13px]">Untagged</span></label
      ><label
        v-for="tag in matches.slice(0, limit)"
        :key="tag"
        class="flex min-h-9 min-w-0 items-center gap-2 rounded px-2 hover:bg-hover"
        ><UiCheckbox
          :model-value="modelValue.includes(tag)"
          :label="`Filter tag ${tag}`"
          :disabled="modelValue.length >= 20 && !modelValue.includes(tag)"
          @update:model-value="toggle(tag)"
        /><span class="min-w-0 flex-1 truncate text-[13px]">{{ tag }}</span></label
      >
      <p v-if="!matches.length" class="px-2 py-2 text-xs text-muted">No matching tags</p>
      <UiButton v-if="matches.length > limit" size="small" @click="limit += 100"
        >Show more tags</UiButton
      ></UiScrollArea
    ><UiSelect
      v-if="modelValue.length > 1"
      :model-value="mode"
      :options="[
        { label: 'Match any selected tag', value: 'any' },
        { label: 'Match all selected tags', value: 'all' },
      ]"
      aria-label="Tag matching"
      @update:model-value="emit('update:mode', $event === 'all' ? 'all' : 'any')"
    />
  </div>
</template>
