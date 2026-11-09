<script setup lang="ts">
import { computed, ref } from 'vue';
import UPopover from '@nuxt/ui/components/Popover.vue';
import USlider from '@nuxt/ui/components/Slider.vue';
import UCollapsible from '@nuxt/ui/components/Collapsible.vue';
import {
  PhCaretDown as ChevronDown,
  PhArrowsClockwise as RefreshCw,
  PhSpinnerGap as LoaderCircle,
  PhGearSix as Settings2,
} from '@phosphor-icons/vue';
import UiButton from '../../ui/UiButton.vue';
import UiSelect from '../../ui/UiSelect.vue';
import UiToggle from '../../ui/UiToggle.vue';
import UiScrollArea from '../../ui/UiScrollArea.vue';
import { useWorkspace } from '../../stores/workspace';
import { validateSettings } from '../../shared/model';
import { rpc } from '../../shared/rpc';
import type { Settings } from '../../shared/types';

const props = defineProps<{ label: string; disabled?: boolean }>();
const store = useWorkspace();
const open = ref(false);
const role = ref<'generative' | 'small' | 'decision'>('generative');
const draft = ref<Settings>(validateSettings(store.app!.settings));
let original = validateSettings(draft.value);
const ids = ref<Record<'generative' | 'small' | 'decision', string[]>>({
  generative: [],
  small: [],
  decision: [],
});
const discovering = ref(false),
  saving = ref(false);
const modelKey = computed(() =>
  role.value === 'generative' ? 'aiModel' : role.value === 'small' ? 'smallModel' : 'decisionModel',
);
const contextKey = computed(() =>
  role.value === 'generative'
    ? 'aiContextTokens'
    : role.value === 'small'
      ? 'smallContextTokens'
      : 'decisionContextTokens',
);
const outputKey = computed(() =>
  role.value === 'generative' ? 'aiCompletionTokens' : 'smallCompletionTokens',
);
const modelOptions = computed(() =>
  [...new Set([draft.value[modelKey.value], ...ids.value[role.value]].filter(Boolean))].map(
    (id) => ({ label: id, value: id }),
  ),
);
const context = computed({
  get: () => draft.value[contextKey.value],
  set: (value: number) => {
    draft.value[contextKey.value] = value;
  },
});
const sliderMaximum = computed(() => Math.max(131072, context.value));
const imageInput = computed({
  get: () =>
    Boolean(
      draft.value.aiModel &&
      draft.value.imageModel === draft.value.aiModel &&
      draft.value.imageBase === draft.value.aiBase,
    ),
  set: (enabled: boolean) => {
    draft.value.imageModel = enabled ? draft.value.aiModel : '';
    draft.value.imageBase = enabled ? draft.value.aiBase : '';
  },
});
const locked = computed(() => props.disabled || discovering.value || saving.value);
function setOpen(value: boolean) {
  if (value) {
    draft.value = validateSettings(store.app!.settings);
    original = validateSettings(draft.value);
  }
  open.value = value;
}
async function discover() {
  if (locked.value) return;
  discovering.value = true;
  try {
    const selectedRole = role.value;
    const settings = validateSettings(draft.value);
    const base =
      selectedRole === 'generative'
        ? settings.aiBase
        : selectedRole === 'small'
          ? settings.smallModelBase
          : settings.decisionBase;
    const permission = { origins: [`${new URL(base).origin}/*`] };
    if (
      !(await chrome.permissions.contains(permission)) &&
      !(await chrome.permissions.request(permission))
    )
      throw Error('Model server access was declined.');
    const { generativeModels, smallModels, decisionModels } =
      await import('../../ai/providers/models');
    const list =
      selectedRole === 'generative'
        ? generativeModels
        : selectedRole === 'small'
          ? smallModels
          : decisionModels;
    ids.value[selectedRole] = await list(settings, AbortSignal.timeout(15000));
    if (!ids.value[selectedRole].length) throw Error('No models found at the configured server.');
  } catch (error) {
    store.notify(error instanceof Error ? error.message : String(error));
  } finally {
    discovering.value = false;
  }
}
async function save() {
  if (locked.value || !store.app) return;
  saving.value = true;
  try {
    await store.run(async () => {
      await store.refresh();
      if (!store.app) return;
      const next = { ...store.app.settings };
      // Merge only edited quick controls; other views may have saved unrelated preferences.
      const modelKeys = [
        'aiModel',
        'smallModel',
        'decisionModel',
        'imageModel',
        'imageBase',
      ] as const;
      const numberKeys = [
        'aiContextTokens',
        'smallContextTokens',
        'decisionContextTokens',
        'aiCompletionTokens',
        'smallCompletionTokens',
      ] as const;
      for (const key of modelKeys)
        if (draft.value[key] !== original[key]) next[key] = draft.value[key];
      for (const key of numberKeys)
        if (draft.value[key] !== original[key]) next[key] = draft.value[key];
      if (draft.value.useDedicatedDecisionModel !== original.useDedicatedDecisionModel)
        next.useDedicatedDecisionModel = draft.value.useDedicatedDecisionModel;
      if (draft.value.tagModelRole !== original.tagModelRole)
        next.tagModelRole = draft.value.tagModelRole;
      if (draft.value.tagVerification !== original.tagVerification)
        next.tagVerification = draft.value.tagVerification;
      await rpc('settings', validateSettings(next));
      await store.refresh();
      open.value = false;
      store.notify('Model settings saved for the next request or Resume.');
    });
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <UPopover
    :open="open"
    :content="{ side: 'top', align: 'start' }"
    :ui="{ content: 'z-50 bg-overlay ring-line-strong' }"
    @update:open="setOpen"
  >
    <UiButton
      size="small"
      variant="ghost"
      class="min-w-0 max-w-56 shrink truncate px-2"
      :disabled="disabled"
      aria-label="Model quick settings"
      :title="label"
    >
      <span class="min-w-0 truncate">{{ label }}</span
      ><ChevronDown class="size-3 shrink-0" />
    </UiButton>
    <template #content>
      <div class="flex max-h-[80dvh] w-[min(22rem,calc(100vw-2rem))] flex-col">
        <UiScrollArea
          class="min-h-0"
          viewport-class="max-h-[min(32rem,60dvh)]"
          content-class="flex flex-col gap-4 p-4"
        >
          <div class="flex items-center justify-between gap-2">
            <h3 class="text-sm font-semibold">Models and routing</h3>
            <UiButton
              square
              size="small"
              variant="ghost"
              title="Server URLs and all preferences"
              @click="
                open = false;
                store.show('settings');
              "
              ><Settings2 class="size-4"
            /></UiButton>
          </div>
          <label class="field-label"
            >Model role<UiSelect
              v-model="role"
              :disabled="locked"
              :options="[
                { label: 'Chat / discovery', value: 'generative' },
                { label: 'Small chat / classification', value: 'small' },
                { label: 'Decision model', value: 'decision' },
              ]"
          /></label>
          <label class="field-label"
            >Model<UiSelect
              v-model="draft[modelKey]"
              :options="modelOptions"
              :disabled="locked"
              placeholder="Discover models"
              aria-label="Quick model"
          /></label>
          <UiButton size="small" variant="secondary" :disabled="locked" @click="discover"
            ><LoaderCircle v-if="discovering" class="size-3.5 animate-spin" /><RefreshCw
              v-else
              class="size-3.5"
            />Discover models</UiButton
          >
          <label class="field-label"
            >Loaded context tokens<input
              v-model.number="context"
              type="number"
              min="0"
              max="1048576"
              class="field"
              :disabled="locked"
              aria-label="Quick loaded context tokens"
          /></label>
          <USlider
            v-model="context"
            :min="0"
            :max="sliderMaximum"
            :step="1024"
            color="neutral"
            :disabled="locked"
            aria-label="Loaded context tokens"
          />
          <p class="text-xs leading-5 text-muted">
            Match the context loaded on your server. This changes TabFlow’s request budget; it does
            not reload or reconfigure the server.
          </p>
          <label v-if="role !== 'decision'" class="field-label"
            >Maximum output tokens<input
              v-model.number="draft[outputKey]"
              type="number"
              :min="role === 'generative' ? 1024 : 512"
              max="65536"
              class="field"
              :disabled="locked"
          /></label>
          <UiToggle
            v-if="role === 'generative'"
            v-model="imageInput"
            :disabled="locked"
            label="Image input for this model"
            description="Enable for a model and endpoint that accept images."
          />
          <UCollapsible class="flex flex-col gap-3">
            <UiButton size="small" variant="ghost" class="group justify-between" :disabled="locked"
              >Classification and tags<ChevronDown
                class="size-3.5 transition-transform group-data-[state=open]:rotate-180"
            /></UiButton>
            <template #content
              ><div class="flex flex-col gap-3 pb-1">
                <UiToggle
                  v-model="draft.useDedicatedDecisionModel"
                  :disabled="locked"
                  label="Decision model for categories"
                />
                <label class="field-label"
                  >Tag proposer<UiSelect
                    v-model="draft.tagModelRole"
                    :disabled="locked"
                    :options="[
                      { label: 'Small chat model', value: 'small' },
                      { label: 'Generative model', value: 'generative' },
                    ]"
                /></label>
                <label class="field-label"
                  >Tag verification<UiSelect
                    v-model="draft.tagVerification"
                    :disabled="locked"
                    :options="[
                      { label: 'Chat checks proposed tags', value: 'chat' },
                      { label: 'Owner review only', value: 'none' },
                      { label: 'Decision checks proposed tags', value: 'decision' },
                    ]"
                /></label></div
            ></template>
          </UCollapsible>
        </UiScrollArea>
        <div class="flex shrink-0 justify-end border-t border-line px-4 py-3">
          <UiButton variant="primary" :disabled="locked" @click="save"
            ><LoaderCircle v-if="saving" class="size-3.5 animate-spin" />Save model
            settings</UiButton
          >
        </div>
      </div>
    </template>
  </UPopover>
</template>
