<script setup lang="ts">
import UiCollapsible from '../../ui/UiCollapsible.vue';
import { z } from 'zod';
import UiSelect from '../../ui/UiSelect.vue';
const effortSchema = z.enum(['server', 'none', 'low', 'medium', 'high']);
const tokenFieldSchema = z.enum(['max_tokens', 'max_completion_tokens']);
const effort = defineModel<z.infer<typeof effortSchema>>('effort', { required: true });
const tokens = defineModel<number>('tokens', { required: true });
const tokenField = defineModel<z.infer<typeof tokenFieldSchema>>('tokenField', { required: true });
</script>
<template>
  <UiCollapsible class="text-xs text-muted"
    ><template #label>Thinking and server compatibility</template>
    <div class="flex flex-wrap gap-3 pt-3">
      <label class="field-label min-w-40 flex-1"
        >Reasoning effort<UiSelect
          :model-value="effort"
          :options="[
            { label: 'Server / model default', value: 'server' },
            { label: 'Off (if supported)', value: 'none' },
            { label: 'Low', value: 'low' },
            { label: 'Medium', value: 'medium' },
            { label: 'High', value: 'high' },
          ]"
          aria-label="Reasoning effort"
          @update:model-value="effort = effortSchema.parse($event)"
      /></label>
      <label class="field-label w-40"
        >Thinking + output tokens<input
          v-model.number="tokens"
          class="field"
          type="number"
          min="1024"
          max="65536"
          step="1024"
      /></label>
      <label class="field-label min-w-48 flex-1"
        >Server token parameter<UiSelect
          :model-value="tokenField"
          :options="[
            { label: 'max_tokens (local compatibility)', value: 'max_tokens' },
            { label: 'max_completion_tokens', value: 'max_completion_tokens' },
          ]"
          aria-label="Server token parameter"
          @update:model-value="tokenField = tokenFieldSchema.parse($event)"
      /></label>
    </div>
    <p class="pt-2 text-xs leading-5">
      Default leaves reasoning to your server. Other choices send reasoning_effort; support depends
      on its model/template. The budget includes thinking, so leave room for a final answer.
      Sampling stays with the server. Tool activity is shown in chat; reasoning state is kept only
      in memory during that run.
    </p>
  </UiCollapsible>
</template>
