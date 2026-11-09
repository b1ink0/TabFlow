<script setup lang="ts">
import USelectMenu from '@nuxt/ui/components/SelectMenu.vue';
import { PhSortAscending as SortAscending } from '@phosphor-icons/vue';
import { useAttrs, computed, ref } from 'vue';
import { cn } from '../shared/utils/cn';
import type { ClassValue } from 'clsx';
defineOptions({ inheritAttrs: false });
const attrs = useAttrs();
const props = withDefaults(
  defineProps<{
    modelValue: string;
    options: Array<{ label: string; value: string; color?: string }>;
    placeholder?: string;
    disabled?: boolean;
    creatable?: boolean;
    iconOnly?: boolean;
    variant?: 'outline' | 'ghost';
  }>(),
  { placeholder: 'Choose an option', variant: 'outline' },
);
const emit = defineEmits<{ 'update:modelValue': [value: string]; create: [value: string] }>();
const open = ref(false);
function create(value: string) {
  open.value = false;
  if (value.trim()) emit('create', value.trim());
}
// Reka reserves the empty string for clearing. Keep explicit "No area/project" choices usable.
const emptyChoice = computed(() => {
  let value = '__tabloom_empty_choice__';
  while (props.options.some((option) => option.value === value)) value += '_';
  return value;
});
const items = computed(() =>
  props.options.map((option) => ({ ...option, value: option.value || emptyChoice.value })),
);
const selected = computed(
  () =>
    props.modelValue ||
    (props.options.some((option) => option.value === '') ? emptyChoice.value : undefined),
);
</script>
<template>
  <USelectMenu
    v-model:open="open"
    v-bind="{ ...attrs, class: undefined }"
    :model-value="selected"
    :items="items"
    :virtualize="items.length > 100"
    value-key="value"
    :search-input="
      iconOnly
        ? false
        : {
            placeholder: 'Search options…',
            ui: {
              base: 'rounded-md',
            },
          }
    "
    :create-item="creatable"
    :placeholder="placeholder"
    :disabled="disabled"
    color="neutral"
    :variant="variant"
    size="md"
    :class="
      cn(
        'min-h-9 min-w-0 w-full rounded-md text-[13px]',
        iconOnly && 'size-9 w-9 shrink-0 justify-center p-2',
        attrs.class as ClassValue,
      )
    "
    :ui="{
      content: 'z-50 min-w-48 max-w-[calc(100vw-24px)] bg-overlay ring-line-strong',
      item: 'flex items-center gap-2 min-h-9 rounded-md before:rounded-md text-[13px]',
      itemWrapper: 'min-w-0 flex-1',
      itemLabel: 'min-w-0 truncate leading-5',
      itemTrailing: 'relative flex size-4 shrink-0 items-center justify-center self-center',
      itemTrailingIcon: 'size-3.5 shrink-0',
      value: 'truncate',
      leading: iconOnly ? 'hidden' : undefined,
      trailing: iconOnly ? 'hidden' : undefined,
    }"
    @create="create"
    @update:model-value="
      emit('update:modelValue', $event === emptyChoice ? '' : String($event ?? ''))
    "
  >
    <template v-if="iconOnly" #default><SortAscending class="size-4" /></template>
    <template #leading
      ><span
        v-if="options.find((item) => item.value === modelValue)?.color"
        class="size-3 shrink-0 rounded-full border border-line-strong"
        :style="{ backgroundColor: options.find((item) => item.value === modelValue)?.color }"
    /></template>
    <template #item-leading="{ item }"
      ><span
        v-if="item.color"
        data-select-color
        class="size-3 shrink-0 rounded-full border border-line-strong"
        :style="{ backgroundColor: item.color }"
    /></template>
  </USelectMenu>
</template>
