<script setup lang="ts">
import { computed, ref } from 'vue';
import UModal from '@nuxt/ui/components/Modal.vue';
import {
  PhDownloadSimple as Download,
  PhFileArrowUp as FileOutput,
  PhSpinnerGap as LoaderCircle,
} from '@phosphor-icons/vue';
import UiButton from '../../ui/UiButton.vue';
import UiSelect from '../../ui/UiSelect.vue';
import UiToggle from '../../ui/UiToggle.vue';
import { useWorkspace } from '../../stores/workspace';
import {
  externalClassification,
  externalClassificationScope,
  downloadClassificationFile,
} from '../../shared/external-classification';
const store = useWorkspace();
const props = withDefaults(
  defineProps<{
    initialScope?: string;
    recordIds?: readonly string[];
    label?: string;
    compact?: boolean;
    hideTrigger?: boolean;
  }>(),
  { initialScope: 'all', recordIds: undefined, label: 'Classify externally' },
);
const open = ref(false),
  scope = ref('all');
const packet = ref<ReturnType<typeof externalClassification>>();
const includeCachedText = ref(false);
const preparing = ref(false);
function show() {
  scope.value = props.initialScope;
  packet.value = undefined;
  open.value = true;
}
defineExpose({ show });
const selectedIds = computed(() => props.recordIds ?? [...store.selected]);
const options = computed(() => [
  { label: 'All open tabs', value: 'all' },
  ...(selectedIds.value.length || props.initialScope === 'selection'
    ? [{ label: `Selected tabs · ${selectedIds.value.length}`, value: 'selection' }]
    : []),
  ...(store.app?.windows || []).map((window, index) => ({
    label: `Window ${index + 1} · ${store.records.filter((record) => record.windowId === window.id).length} tabs`,
    value: `window:${window.id}`,
  })),
  ...(store.app?.projects || []).map((project) => ({
    label: `Project · ${project.name}`,
    value: `project:${project.id}`,
  })),
]);
async function prepare() {
  if (preparing.value) return;
  const key = scope.value,
    selected = [...selectedIds.value],
    cached = includeCachedText.value;
  preparing.value = true;
  try {
    await store.run(async () => {
      await store.refresh();
      if (!store.app) return;
      if (key !== scope.value || cached !== includeCachedText.value) return;
      const resolved = externalClassificationScope(store.app, key, selected);
      packet.value = externalClassification(store.app, resolved.ids, cached, resolved);
    });
  } finally {
    preparing.value = false;
  }
}
</script>
<template>
  <UiButton
    v-if="!hideTrigger"
    size="small"
    :variant="compact ? 'ghost' : 'default'"
    :aria-label="label"
    :title="compact ? label : undefined"
    @click="show"
    ><FileOutput class="size-3.5" /><span v-if="!compact">{{ label }}</span></UiButton
  >
  <UModal
    v-model:open="open"
    title="Classify with another AI"
    description="Attach the two files to a new AI chat and send. The Markdown contains the complete request; no pasted prompt needed."
    :ui="{ content: 'max-w-lg bg-overlay', footer: 'justify-end gap-2' }"
  >
    <template #body
      ><div class="flex flex-col gap-4 text-[13px]">
        <label class="field-label"
          >Tabs to include<UiSelect
            v-model="scope"
            :options="options"
            aria-label="External classification scope"
            @update:model-value="packet = undefined"
        /></label>
        <UiToggle
          v-model="includeCachedText"
          label="Include cached text excerpts"
          @update:model-value="packet = undefined"
        />
        <p class="text-muted">
          Includes titles, sanitized addresses, notes, tags and existing organization. URL queries,
          fragments and credentials are excluded. Optional cached text includes up to 1,500
          characters per tab and may contain private page content. Review files before sharing.
        </p>
        <UiButton
          class="self-start"
          :disabled="preparing || (scope === 'selection' && !selectedIds.length)"
          @click="prepare"
          ><LoaderCircle v-if="preparing" class="size-3.5 animate-spin" />{{
            preparing ? 'Preparing…' : 'Prepare files'
          }}</UiButton
        >
        <div v-if="packet" class="flex flex-col gap-3 border-t border-line pt-3">
          <p>
            {{ packet.data.scope.label }} · {{ packet.data.tabs.length }} occurrences · no browser
            changes
          </p>
          <UiButton
            @click="
              downloadClassificationFile('tabflow-context.md', packet.instructions, 'text/markdown')
            "
            ><Download class="size-3.5" />Download context (.md)</UiButton
          >
          <UiButton
            @click="
              downloadClassificationFile(
                'tabflow-tab-data.json',
                JSON.stringify(packet.data, null, 2),
                'application/json',
              )
            "
            ><Download class="size-3.5" />Download tab data (.json)</UiButton
          >
          <p class="text-xs text-muted">
            Attach both files to a new AI chat and press Send. No extra prompt to write or paste.
            Download its complete JSON response, then Projects → Import draft → Save review draft.
            Review projects, categories and suggested tags, then choose Use organization in TabFlow.
            Creating native project windows is optional. Nothing is applied by exporting or
            importing.
          </p>
        </div>
      </div></template
    >
    <template #footer><UiButton @click="open = false">Done</UiButton></template>
  </UModal>
</template>
