<script setup lang="ts">
import { ref } from 'vue';
import { PhImage, PhX } from '@phosphor-icons/vue';
import UiButton from '../../ui/UiButton.vue';
import {
  assistantImagesSchema,
  MAX_IMAGE_BYTES,
  type AssistantImage,
} from '../../shared/assistant-images';
defineProps<{ disabled?: boolean; enabled: boolean; hideButton?: boolean }>();
const images = defineModel<AssistantImage[]>({ required: true });
const picker = ref<HTMLInputElement>(),
  error = ref('');
const emit = defineEmits<{ attached: [] }>();
defineExpose({ pick: () => picker.value?.click() });
async function attach(event: Event) {
  const input = event.target as HTMLInputElement;
  try {
    const additions: AssistantImage[] = [];
    for (const file of input.files || []) {
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type))
        throw new Error('Choose PNG, JPEG or WebP images.');
      if (file.size > MAX_IMAGE_BYTES) throw new Error('Each image must be 4 MB or smaller.');
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('Could not read image.'));
        reader.onload = () =>
          typeof reader.result === 'string'
            ? resolve(reader.result)
            : reject(new Error('Could not read image.'));
        reader.readAsDataURL(file);
      });
      additions.push({ id: crypto.randomUUID(), name: file.name.slice(0, 240), dataUrl });
    }
    images.value = assistantImagesSchema.parse([...images.value, ...additions]);
    error.value = '';
    emit('attached');
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    input.value = '';
  }
}
</script>
<template>
  <div class="flex min-w-0 flex-col gap-2">
    <div v-if="images.length" data-attachment-preview class="flex flex-wrap gap-2">
      <div
        v-for="image in images"
        :key="image.id"
        class="relative flex w-24 flex-col gap-1 rounded-lg bg-surface p-1"
      >
        <img
          :src="image.dataUrl"
          :alt="image.name"
          class="h-16 w-full rounded object-contain"
        /><span class="truncate text-xs">{{ image.name }}</span
        ><UiButton
          square
          size="small"
          variant="secondary"
          class="absolute top-0 right-0"
          :disabled="disabled"
          :aria-label="`Remove image ${image.name}`"
          @click="images = images.filter((item) => item.id !== image.id)"
          ><PhX class="size-3"
        /></UiButton>
      </div>
    </div>
    <UiButton
      v-if="!hideButton"
      size="small"
      variant="ghost"
      class="self-start"
      :disabled="disabled || !enabled"
      :title="
        enabled
          ? 'PNG, JPEG or WebP; 4 images, 4 MB each, 8 MB total'
          : 'Enable image input for this model in model settings'
      "
      @click="picker?.click()"
      ><PhImage class="size-4" />Attach images</UiButton
    >
    <input
      ref="picker"
      type="file"
      accept="image/png,image/jpeg,image/webp"
      multiple
      class="sr-only"
      tabindex="-1"
      aria-label="Choose image attachments"
      :disabled="disabled || !enabled"
      @change="attach"
    />
    <p v-if="error" role="alert" class="text-xs text-danger">{{ error }}</p>
  </div>
</template>
