<script setup lang="ts">
import UPopover from '@nuxt/ui/components/Popover.vue';
import UColorPicker from '@nuxt/ui/components/ColorPicker.vue';
import UiButton from './UiButton.vue';
const value = defineModel<string>({ required: true });
defineProps<{ label: string }>();
const palette = [
  ['Blue', '#8fb3e8'],
  ['Purple', '#c1a0df'],
  ['Orange', '#d8ac80'],
  ['Cyan', '#8fbfc7'],
  ['Pink', '#d5a1b8'],
  ['Yellow', '#d4c383'],
  ['Red', '#db9a93'],
  ['Green', '#9bbc9e'],
  ['Teal', '#57b2a3'],
  ['Indigo', '#8f91e8'],
  ['Brown', '#b79979'],
  ['Grey', '#aba8a0'],
];
</script>
<template>
  <UPopover :ui="{ content: 'w-64 bg-overlay p-3' }"
    ><UiButton variant="secondary" :aria-label="label"
      ><span
        class="size-3 rounded-full border border-line-strong"
        :style="{ backgroundColor: value || 'var(--text-muted)' }"
      />{{ value || 'Automatic' }}</UiButton
    >
    <template #content
      ><div class="flex flex-col gap-3">
        <div class="flex flex-wrap gap-2">
          <button
            v-for="[name, color] in palette"
            :key="color"
            type="button"
            class="flex size-8 items-center justify-center rounded-md hover:bg-hover"
            :aria-label="`${name} ${color}`"
            :title="name"
            :aria-pressed="value === color"
            @click="value = color || ''"
          >
            <span
              class="size-5 rounded-full border border-line-strong"
              :style="{ backgroundColor: color }"
            />
          </button>
        </div>
        <UColorPicker
          :model-value="value || '#8fb3e8'"
          format="hex"
          @update:model-value="value = $event || ''"
        />
        <label class="field-label"
          >Custom hex<input
            :value="value"
            class="field"
            placeholder="#8fb3e8"
            maxlength="7"
            @change="
              value = /^#[0-9a-fA-F]{6}$/.test(($event.target as HTMLInputElement).value)
                ? ($event.target as HTMLInputElement).value
                : value
            "
        /></label>
        <UiButton size="small" variant="ghost" @click="value = ''">Automatic color</UiButton>
      </div></template
    ></UPopover
  >
</template>
