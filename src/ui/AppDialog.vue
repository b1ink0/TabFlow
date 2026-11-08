<script setup lang="ts">
import UModal from '@nuxt/ui/components/Modal.vue';
import UiButton from './UiButton.vue';
import UiSelect from './UiSelect.vue';
import UiColorPicker from './UiColorPicker.vue';
import UiTagPicker from './UiTagPicker.vue';
import { useDialog } from '../stores/dialog';
const store = useDialog();
</script>
<template>
  <UModal
    :open="Boolean(store.current)"
    :title="store.current?.title"
    :description="store.current?.description"
    :ui="{
      content: 'w-[min(440px,calc(100vw-32px))] divide-y-0 rounded-xl bg-overlay ring-line-strong',
      header: 'p-4 pb-2 border-0',
      body: 'px-4 py-2 border-0',
      footer: 'justify-end gap-2 px-4 pt-3 pb-4 border-0',
      title: 'text-base font-semibold',
      description: 'text-[13px] leading-5 text-muted',
      overlay: 'bg-black/65',
    }"
    @update:open="
      (open) => {
        if (!open) store.close(false);
      }
    "
  >
    <template v-if="store.current?.fields.length || store.error" #body>
      <form
        v-if="store.current"
        id="tabloom-dialog-form"
        class="flex flex-col gap-4"
        @submit.prevent="store.close(true)"
      >
        <label v-for="field in store.current.fields" :key="field.name" class="field-label">
          {{ field.label }}
          <UiTagPicker
            v-if="field.tagOptions"
            :model-value="JSON.parse(store.current.values[field.name] || '[]')"
            :options="field.tagOptions"
            :aria-label="field.label"
            @update:model-value="store.current.values[field.name] = JSON.stringify($event)"
          />
          <UiSelect
            v-else-if="field.options"
            :model-value="store.current.values[field.name] || ''"
            :options="field.options"
            :aria-label="field.label"
            :creatable="Boolean(field.create)"
            :disabled="store.creating"
            @create="store.createOption(field, $event)"
            @update:model-value="store.current.values[field.name] = $event"
          />
          <UiColorPicker
            v-else-if="field.color"
            v-model="store.current.values[field.name]!"
            :label="field.label"
          />
          <input
            v-else
            v-model="store.current.values[field.name]"
            class="field"
            autocomplete="off"
          />
        </label>
      </form>
      <p v-if="store.error" class="text-[13px] text-danger" role="alert">{{ store.error }}</p>
    </template>
    <template #footer>
      <UiButton variant="ghost" @click="store.close(false)">Cancel</UiButton>
      <UiButton
        :disabled="store.creating"
        :loading="store.creating"
        :type="store.current?.fields.length ? 'submit' : 'button'"
        :form="store.current?.fields.length ? 'tabloom-dialog-form' : undefined"
        variant="primary"
        @click="if (!store.current?.fields.length) store.close(true);"
        >{{ store.creating ? 'Creating…' : store.current?.confirmLabel }}</UiButton
      >
    </template>
  </UModal>
</template>
