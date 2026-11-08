<script setup lang="ts">
import UDropdownMenu from '@nuxt/ui/components/DropdownMenu.vue';
import UiButton from '../../ui/UiButton.vue';
import { PhCaretDown, PhCheck } from '@phosphor-icons/vue';
import { computed } from 'vue';
import { useWorkspace } from '../../stores/workspace';
import { actionPresentation } from '../../shared/action-presentation';
import {
  actionCapabilities,
  capabilityLabels,
  type AssistantArtifact,
  type ApprovalMode,
} from '../../shared/assistant-actions';
const props = defineProps<{
  artifact: AssistantArtifact;
  disabled?: boolean;
  approveDisabled?: boolean;
}>();
const emit = defineEmits<{ approve: [mode: ApprovalMode]; deny: []; review: [] }>();
const capabilities = computed(() => actionCapabilities(props.artifact));
const store = useWorkspace();
const presentation = computed(() => actionPresentation(props.artifact, store.app || undefined));
const items = computed(() => [
  {
    label: 'Ask orchestrator to review',
    description: `${presentation.value.label} · ${capabilities.value.map((item) => capabilityLabels[item]).join(', ')}`,
    onSelect: () => emit('review'),
  },
]);
</script>
<template>
  <div class="flex flex-col gap-2" role="group" :aria-label="`Approval: ${presentation.label}`">
    <div class="flex min-w-0 flex-col gap-1 text-xs text-secondary">
      <p class="break-words">{{ presentation.description }}</p>
      <p v-if="presentation.effect" class="text-muted">{{ presentation.effect }}</p>
    </div>
    <div class="flex flex-wrap items-center justify-end gap-2">
      <UiButton size="small" variant="ghost" :disabled="disabled" @click="emit('deny')">{{
        presentation.denyLabel || 'Deny'
      }}</UiButton>
      <UiButton
        size="small"
        variant="primary"
        :disabled="disabled || approveDisabled"
        :title="`Approve once: ${presentation.label}`"
        @click="emit('approve', 'once')"
        ><PhCheck class="size-3.5" />{{ presentation.label }}</UiButton
      >
      <UDropdownMenu :items="items"
        ><UiButton
          square
          size="small"
          :disabled="disabled || approveDisabled"
          aria-label="Approval options"
          title="Approval options"
          ><PhCaretDown class="size-3.5" /></UiButton
      ></UDropdownMenu>
    </div>
  </div>
</template>
