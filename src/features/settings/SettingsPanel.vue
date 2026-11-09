<script setup lang="ts">
import TagManager from './TagManager.vue';
import CategoryManager from './CategoryManager.vue';
import DataManagement from './DataManagement.vue';
import BrowserPanelSettings from './BrowserPanelSettings.vue';
import UiCollapsible from '../../ui/UiCollapsible.vue';
import { ref, onBeforeUnmount, computed, watch, toRaw } from 'vue';
import { PhArrowLeft, PhCaretRight } from '@phosphor-icons/vue';
import UiSearchInput from '../../ui/UiSearchInput.vue';
import { useMediaQuery } from '@vueuse/core';
import UiToggle from '../../ui/UiToggle.vue';
import UiButton from '../../ui/UiButton.vue';
import UiCheckbox from '../../ui/UiCheckbox.vue';
import UiSelect from '../../ui/UiSelect.vue';
import UiScrollArea from '../../ui/UiScrollArea.vue';
import ModelRuntimeControls from './ModelRuntimeControls.vue';
import { useWorkspace } from '../../stores/workspace';
import { rpc } from '../../shared/rpc';
import { validateSettings } from '../../shared/model';
import type { Settings } from '../../shared/types';
const activeSection = ref('models');
const detailOpen = ref(false),
  sectionSearch = ref('');
const roomy = useMediaQuery('(min-width: 768px)');
const settingSections = [
  { label: 'Models', value: 'models' },
  { label: 'Suspension', value: 'suspension' },
  { label: 'Backups & privacy', value: 'backups' },
  { label: 'Calendar', value: 'calendar' },
  { label: 'Side panel', value: 'layout' },
  { label: 'Tags', value: 'tags' },
  { label: 'Categories', value: 'categories' },
  { label: 'Data management', value: 'data' },
];
const filteredSections = computed(() =>
  settingSections.filter((item) =>
    item.label.toLowerCase().includes(sectionSearch.value.trim().toLowerCase()),
  ),
);
function selectSection(value: string) {
  activeSection.value = value;
  detailOpen.value = true;
  void save();
}
const browserApi = chrome;
const startupUrl = browserApi.runtime.getURL('dashboard.html#tabs');
const store = useWorkspace();
const config = ref<Settings>(
  store.settingsDraft
    ? structuredClone(toRaw(store.settingsDraft))
    : validateSettings(store.app!.settings),
);
const imageInput = computed({
  get: () =>
    Boolean(
      config.value.aiModel &&
      config.value.imageModel === config.value.aiModel &&
      config.value.imageBase === config.value.aiBase,
    ),
  set: (enabled: boolean) => {
    config.value.imageModel = enabled ? config.value.aiModel : '';
    config.value.imageBase = enabled ? config.value.aiBase : '';
  },
});
const generativeModelIds = ref<string[]>([]),
  smallModelIds = ref<string[]>([]),
  decisionModelIds = ref<string[]>([]),
  discovering = ref(false);
const generativeOptions = computed(() => {
  const ids = new Set([config.value.aiModel, ...generativeModelIds.value].filter(Boolean));
  return [...ids].map((id) => ({ label: id, value: id }));
});
const smallModelOptions = computed(() => {
  const ids = new Set([config.value.smallModel, ...smallModelIds.value].filter(Boolean));
  return [...ids].map((id) => ({ label: id, value: id }));
});
const decisionOptions = computed(() => {
  const ids = new Set([config.value.decisionModel, ...decisionModelIds.value].filter(Boolean));
  return [...ids].map((id) => ({ label: id, value: id }));
});
async function grantServer(role: 'generative' | 'small' | 'decision' = 'generative') {
  const s = validateSettings(config.value);
  const base =
    role === 'decision' ? s.decisionBase : role === 'small' ? s.smallModelBase : s.aiBase;
  const origins = [`${new URL(base).origin}/*`];
  if (
    !(await browserApi.permissions.contains({ origins })) &&
    !(await browserApi.permissions.request({ origins }))
  )
    throw new Error('Server permission declined.');
}
async function discoverGenerative() {
  discovering.value = true;
  try {
    await grantServer('generative');
    const { generativeModels } = await import('../../ai/providers/models');
    generativeModelIds.value = await generativeModels(config.value, AbortSignal.timeout(15000));
    if (!generativeModelIds.value.length)
      throw new Error('No models found. Start your server and load a model.');
    if (!generativeModelIds.value.includes(config.value.aiModel))
      config.value.aiModel = generativeModelIds.value[0] || '';
  } finally {
    discovering.value = false;
  }
}
async function discoverDecision() {
  discovering.value = true;
  try {
    await grantServer('decision');
    const { decisionModels } = await import('../../ai/providers/models');
    decisionModelIds.value = await decisionModels(config.value, AbortSignal.timeout(15000));
    if (!decisionModelIds.value.length)
      throw new Error('No decision models found at the configured Bud/Jev endpoint.');
    if (!decisionModelIds.value.includes(config.value.decisionModel))
      config.value.decisionModel = decisionModelIds.value[0] || '';
  } finally {
    discovering.value = false;
  }
}
async function discoverSmallModel() {
  discovering.value = true;
  try {
    await grantServer('small');
    const { smallModels } = await import('../../ai/providers/models');
    smallModelIds.value = await smallModels(config.value, AbortSignal.timeout(15000));
    if (!smallModelIds.value.length)
      throw new Error('No chat models found at the small-model endpoint.');
    if (!smallModelIds.value.includes(config.value.smallModel))
      config.value.smallModel = smallModelIds.value[0] || '';
  } finally {
    discovering.value = false;
  }
}
const saveError = ref(''),
  saving = ref(false),
  dirty = ref(Boolean(store.settingsDraft));
let savedEditor = validateSettings(store.app!.settings);
const editedKeys = new Set(
  Object.entries(config.value)
    .filter(([key, value]) => value !== savedEditor[key as keyof Settings])
    .map(([key]) => key),
);
let lastSaved = JSON.stringify(savedEditor),
  revision = 0;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let saveQueue: Promise<void> = Promise.resolve();
watch(
  config,
  () => {
    revision++;
    for (const [key, value] of Object.entries(config.value))
      if (value !== savedEditor[key as keyof Settings]) editedKeys.add(key);
    dirty.value = JSON.stringify(config.value) !== lastSaved || editedKeys.size > 0;
    store.settingsDraft = dirty.value ? structuredClone(toRaw(config.value)) : undefined;
    saveError.value = '';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      void save();
    }, 450);
  },
  { deep: true },
);
async function save() {
  clearTimeout(saveTimer);
  let snapshot: Settings;
  try {
    snapshot = validateSettings(structuredClone(JSON.parse(JSON.stringify(config.value))));
  } catch {
    saveError.value = 'Enter valid settings values to save your changes.';
    return;
  }
  const encoded = JSON.stringify(snapshot),
    version = revision;
  if (encoded === lastSaved && !editedKeys.size) return;
  const patch = Object.fromEntries(Object.entries(snapshot).filter(([key]) => editedKeys.has(key)));
  saveQueue = saveQueue.then(async () => {
    if (encoded === lastSaved) {
      if (version === revision) {
        dirty.value = false;
        editedKeys.clear();
        if (JSON.stringify(store.settingsDraft) === encoded) store.settingsDraft = undefined;
      }
      return;
    }
    saving.value = true;
    try {
      if (
        snapshot.capturePreviews &&
        !(await browserApi.permissions.contains({ origins: ['<all_urls>'] }))
      )
        throw new Error('Use Enable screenshot permission before turning on previews.');
      const next = validateSettings({ ...store.app?.settings, ...patch });
      await rpc('settings', next);
      lastSaved = encoded;
      savedEditor = snapshot;
      if (store.app) store.app.settings = next;
      if (version === revision) {
        dirty.value = false;
        editedKeys.clear();
        saveError.value = '';
        if (JSON.stringify(store.settingsDraft) === encoded) store.settingsDraft = undefined;
      }
    } catch (cause) {
      if (version === revision)
        saveError.value = cause instanceof Error ? cause.message : String(cause);
    } finally {
      saving.value = false;
    }
  });
  await saveQueue;
}
onBeforeUnmount(() => {
  clearTimeout(saveTimer);
  if (dirty.value) void save();
});
if (dirty.value)
  saveTimer = setTimeout(() => {
    void save();
  }, 450);
async function enablePreviews() {
  if (!(await browserApi.permissions.request({ origins: ['<all_urls>'] })))
    throw new Error('Screenshot permission declined. Previews remain disabled.');
  config.value.capturePreviews = true;
  await save();
}
</script>
<template>
  <form class="flex min-h-0 min-w-0 flex-1 flex-col" @submit.prevent="save">
    <div class="flex min-h-0 min-w-0 flex-1 gap-4 pb-3">
      <UiScrollArea
        v-show="roomy || !detailOpen"
        class="min-w-0 flex-1 md:w-52 md:flex-none"
        content-class="flex flex-col gap-3"
        label="Settings sections"
      >
        <UiSearchInput
          v-model="sectionSearch"
          label="Search settings"
          placeholder="Search settings…"
        />
        <nav class="flex flex-col gap-1" aria-label="Settings categories">
          <UiButton
            v-for="item in filteredSections"
            :key="item.value"
            variant="ghost"
            class="w-full justify-start"
            :class="roomy && activeSection === item.value && 'bg-selected'"
            :aria-current="roomy && activeSection === item.value ? 'page' : undefined"
            @click="selectSection(item.value)"
            ><span class="min-w-0 flex-1 text-left">{{ item.label }}</span
            ><PhCaretRight class="size-3.5 shrink-0 text-muted"
          /></UiButton>
          <p v-if="!filteredSections.length" class="px-2 py-3 text-xs text-muted">
            No matching settings.
          </p>
        </nav>
      </UiScrollArea>
      <div v-show="roomy || detailOpen" class="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
        <div class="flex min-h-9 shrink-0 items-center gap-2">
          <UiButton
            v-if="!roomy"
            square
            size="small"
            variant="ghost"
            aria-label="Back to settings"
            title="Back to settings"
            @click="
              detailOpen = false;
              void save();
            "
            ><PhArrowLeft class="size-4"
          /></UiButton>
          <h2 class="min-w-0 flex-1 truncate text-sm font-semibold">
            {{ settingSections.find((item) => item.value === activeSection)?.label }}
          </h2>
          <span v-if="saving || dirty || saveError" class="text-xs text-muted" role="status">{{
            saving ? 'Saving…' : saveError ? 'Not saved' : 'Unsaved'
          }}</span>
        </div>
        <p
          v-if="saveError"
          role="alert"
          class="flex flex-wrap items-center gap-2 text-xs text-danger"
        >
          {{ saveError }}<UiButton size="small" variant="ghost" @click="save">Retry save</UiButton>
        </p>
        <UiScrollArea
          class="min-h-0 flex-1"
          content-class="flex min-w-0 max-w-2xl flex-col pb-4"
          label="Settings detail"
        >
          <TagManager v-if="activeSection === 'tags'" />
          <CategoryManager v-if="activeSection === 'categories'" />
          <DataManagement v-if="activeSection === 'data'" />
          <BrowserPanelSettings v-if="activeSection === 'layout'" />
          <section v-if="activeSection === 'models'" class="flex min-w-0 flex-col gap-5 pb-6">
            <div class="flex items-center gap-3">
              <h2 class="text-sm font-semibold">Generative orchestrator</h2>
            </div>
            <p class="text-xs leading-5 text-muted">Chat, summaries and organization drafts.</p>
            <label class="field-label"
              >OpenAI-compatible endpoint<input
                v-model="config.aiBase"
                class="field"
                type="url"
                required
            /></label>
            <UiButton :disabled="discovering" @click="store.run(discoverGenerative)">
              {{ discovering ? 'Connecting…' : 'Discover generative models' }}
            </UiButton>
            <UiSelect
              v-model="config.aiModel"
              :options="generativeOptions"
              :placeholder="config.aiModel || 'Discover models from this endpoint'"
              aria-label="Generative model"
            />
            <UiCollapsible class="text-xs text-muted"
              ><template #label>Enter a model ID manually</template>
              <input
                v-model="config.aiModel"
                class="field"
                aria-label="Custom generative model ID"
              />
            </UiCollapsible>
            <ModelRuntimeControls
              v-model:effort="config.aiReasoningEffort"
              v-model:tokens="config.aiCompletionTokens"
              v-model:token-field="config.aiTokenField"
            />
            <label class="field-label max-w-64"
              >Loaded generative context tokens<input
                v-model.number="config.aiContextTokens"
                type="number"
                class="field max-w-32"
                min="0"
                max="1048576"
                step="1024"
            /></label>
            <UiToggle
              v-model="imageInput"
              trailing
              label="Image input for this generative model"
              description="Enable only if this exact model and endpoint accept image messages."
            />
            <UiToggle
              v-model="config.aiStreamResponses"
              trailing
              label="Stream assistant replies"
              description="Show replies as they arrive. Disable this if your server does not support streamed tool calls."
            />
            <div class="flex flex-col gap-1">
              <label class="field-label"
                >Simultaneous model workflows<input
                  v-model.number="config.maxConcurrentInference"
                  type="number"
                  class="field max-w-32"
                  min="1"
                  max="8"
                  step="1"
              /></label>
              <p class="text-xs leading-5 text-muted">
                One is safest for a single local server. Raise this only if your server can process
                concurrent requests; one workflow holds a slot through all tool rounds.
              </p>
            </div>
            <label class="field-label"
              >Generative API token<input
                v-model="config.aiKey"
                class="field"
                type="password"
                autocomplete="off"
            /></label>
            <div class="flex flex-col gap-3 border-t border-line pt-4">
              <div class="flex flex-col gap-1">
                <h3 class="text-xs font-semibold">
                  Small chat model - default for bounded decisions
                </h3>
                <p class="text-xs leading-5 text-muted">
                  Optional OpenAI-compatible model for bounded tab and tag decisions.
                </p>
              </div>
              <label class="field-label"
                >Small model server URL<input
                  v-model="config.smallModelBase"
                  class="field"
                  type="url"
                  required
              /></label>
              <UiButton :disabled="discovering" @click="store.run(discoverSmallModel)">
                {{ discovering ? 'Connecting...' : 'Find small chat models' }}
              </UiButton>
              <label class="field-label"
                >Selected small model<UiSelect
                  v-model="config.smallModel"
                  :options="smallModelOptions"
                  :placeholder="config.smallModel || 'Find models from this endpoint first'"
                  aria-label="Small chat model for decisions"
              /></label>
              <UiCollapsible class="text-xs text-muted"
                ><template #label>Enter a small model ID manually</template>
                <input
                  v-model="config.smallModel"
                  class="field"
                  aria-label="Custom small model ID"
                />
              </UiCollapsible>
              <ModelRuntimeControls
                v-model:effort="config.smallReasoningEffort"
                v-model:tokens="config.smallCompletionTokens"
                v-model:token-field="config.smallTokenField"
              />
              <label class="field-label max-w-64"
                >Loaded small-model context tokens<input
                  v-model.number="config.smallContextTokens"
                  type="number"
                  class="field max-w-32"
                  min="0"
                  max="1048576"
                  step="1024"
              /></label>
              <label class="field-label"
                >Small model API token<input
                  v-model="config.smallModelKey"
                  class="field"
                  type="password"
                  autocomplete="off"
              /></label>
            </div>
            <div class="flex flex-col gap-3 border-t border-line pt-4">
              <h3 class="text-xs font-semibold">Independent tag proposals</h3>
              <label class="field-label"
                >Tag proposer<UiSelect
                  v-model="config.tagModelRole"
                  :options="[
                    { label: 'Small chat model', value: 'small' },
                    { label: 'Generative model', value: 'generative' },
                  ]"
                  aria-label="Tag proposer"
              /></label>
              <label class="field-label"
                >Tag verification<UiSelect
                  v-model="config.tagVerification"
                  :options="[
                    { label: 'Chat checks proposed tags', value: 'chat' },
                    { label: 'Owner review only', value: 'none' },
                    { label: 'Decision API checks proposed tags', value: 'decision' },
                  ]"
                  aria-label="Tag verification"
              /></label>
              <p class="text-xs leading-5 text-muted">
                Tags use a separate saved chat proposal. Optional verification checks only its
                selected labels. New and uncertain labels wait for your review.
              </p>
            </div>
            <label class="field-label max-w-64"
              >Minimum classification score<input
                v-model.number="config.classificationMinConfidence"
                type="number"
                class="field max-w-32"
                min="0"
                max="1"
                step="0.05"
              /><span class="text-xs text-muted"
                >Lower-scored collection choices stay uncertain for review. Model scores are not
                calibrated guarantees.</span
              ></label
            >
            <div class="flex items-start gap-3 border-t border-line pt-4">
              <UiCheckbox
                v-model="config.useDedicatedDecisionModel"
                label="Use dedicated decision API for category and native-group choices"
              />
              <div class="flex flex-col gap-1">
                <h3 class="text-xs font-semibold">Dedicated decision API (optional override)</h3>
                <button
                  type="button"
                  class="w-fit text-left text-xs font-medium text-ink underline-offset-2 hover:underline"
                  @click="config.useDedicatedDecisionModel = !config.useDedicatedDecisionModel"
                >
                  {{
                    config.useDedicatedDecisionModel
                      ? 'Using dedicated decision API'
                      : 'Use dedicated decision API instead'
                  }}
                </button>
                <p class="text-xs leading-5 text-muted">
                  Selects project/category destinations and native groups. Tag proposals use the
                  separate chat role above; enabling this does not check every tab against every
                  tag. All suggestions still require review.
                </p>
              </div>
            </div>
            <template
              v-if="config.useDedicatedDecisionModel || config.tagVerification === 'decision'"
            >
              <p class="text-xs leading-5 text-muted">
                Requires a System One-compatible decision endpoint. Enter the server root URL (for
                example http://127.0.0.1:8080); the SDK calls /v1/systemone. The selected model must
                be a decision model supported by that server.
              </p>
              <label class="field-label"
                >Decision protocol<UiSelect
                  v-model="config.decisionProvider"
                  :options="[
                    { label: 'System One', value: 'jev' },
                    { label: 'Bud/Jev /v1/systemone', value: 'bud' },
                  ]"
                  aria-label="Dedicated decision protocol"
              /></label>
              <label class="field-label"
                >Decision server URL<input
                  v-model="config.decisionBase"
                  class="field"
                  type="url"
                  required
              /></label>
              <UiButton :disabled="discovering" @click="store.run(discoverDecision)">
                {{ discovering ? 'Connecting...' : 'Find decision models' }}
              </UiButton>
              <label class="field-label"
                >Selected decision model<UiSelect
                  v-model="config.decisionModel"
                  :options="decisionOptions"
                  :placeholder="config.decisionModel || 'Find models from this endpoint first'"
                  aria-label="Dedicated decision model"
              /></label>
              <UiCollapsible class="text-xs text-muted"
                ><template #label>Enter a decision model ID manually</template>
                <input
                  v-model="config.decisionModel"
                  class="field"
                  aria-label="Custom decision model ID"
                />
              </UiCollapsible>
              <label class="field-label"
                >Decision API token<input
                  v-model="config.decisionKey"
                  class="field"
                  type="password"
                  autocomplete="off"
              /></label>
              <label v-if="config.useDedicatedDecisionModel" class="field-label max-w-64"
                >Loaded decision context tokens<input
                  v-model.number="config.decisionContextTokens"
                  type="number"
                  class="field max-w-32"
                  min="0"
                  max="1048576"
                  step="1024"
              /></label>
            </template>
            <label class="field-label"
              >Attempts per failed analysis request<input
                v-model.number="config.aiMaxAttempts"
                type="number"
                class="field max-w-32"
                min="1"
                max="10"
            /></label>
            <label class="field-label"
              >Tabs per organization request<input
                v-model.number="config.aiBatchSize"
                type="number"
                class="field max-w-32"
                min="5"
                max="60"
            /></label>
            <label class="field-label"
              >Evidence characters per request<input
                v-model.number="config.aiEvidenceCharacters"
                type="number"
                class="field max-w-32"
                min="0"
                max="2000000"
                step="1000"
            /></label>
            <p class="text-xs leading-5 text-muted">
              Match each context value above to the model actually loaded on its server. Zero means
              unknown; whole-collection analysis waits for a value. Tab count and evidence size are
              upper bounds; TabFlow splits requests further to fit prompts, taxonomy and evidence.
              Chat models also reserve thinking/output tokens; dedicated decision models do not.
              Cached originals remain available for later inspection.
            </p>
            <div class="flex flex-wrap gap-2">
              <UiButton @click="store.run(() => grantServer('generative'))"
                >Grant generative access</UiButton
              >
              <UiButton @click="store.run(() => grantServer('small'))">
                Grant small-model access
              </UiButton>
              <UiButton
                v-if="config.useDedicatedDecisionModel"
                @click="store.run(() => grantServer('decision'))"
              >
                Grant decision access
              </UiButton>
            </div>
            <UiToggle
              v-model="config.maintainCollectionReview"
              trailing
              label="Suggest projects for new tabs"
              description="Opt in after accepting project categories. While the dashboard is open, your small model or System One model classifies new and navigated tabs in any window. Suggestions wait in Projects for review and Apply. Nothing moves or closes automatically. Grant access to the selected decision server above."
            />
            <UiToggle
              v-if="config.maintainCollectionReview"
              v-model="config.reviewProjectWindowsOnly"
              trailing
              label="Review only project tabs"
              description="Monitor tabs assigned to projects, including across different browser windows. Leave unrelated and scratch tabs out of ongoing review."
            />
            <p class="text-xs leading-6 text-muted">
              Credentials stay in this browser profile and are omitted from backups. Use your PC's
              LAN address when a model runs on another device.
            </p>
          </section>
          <section v-if="activeSection === 'calendar'" class="flex min-w-0 flex-col gap-5 pb-6">
            <div class="flex items-center gap-3">
              <h2 class="text-sm font-semibold">Google Calendar (optional)</h2>
            </div>
            <p class="text-xs leading-5 text-muted">
              Connect from Today to read today’s event times. TabFlow asks Google for read-only
              Calendar access only when you connect. No client secret is needed; the client ID below
              is public.
            </p>
            <label class="field-label"
              >Google OAuth client ID<input
                v-model="config.googleCalendarClientId"
                class="field"
                type="text"
                autocomplete="off"
                placeholder="…apps.googleusercontent.com"
            /></label>
            <p class="text-xs leading-5 text-muted">
              Create a Chrome Extension OAuth client in Google Cloud, using the ID shown for the
              loaded TabFlow extension, and enable Google Calendar API. Save this ID, then choose
              Connect in Today. Event titles are sent to your configured model only when you ask it
              to plan your day.
            </p>
          </section>
          <section v-if="activeSection === 'suspension'" class="flex min-w-0 flex-col gap-5 pb-6">
            <div class="flex items-center gap-3">
              <h2 class="text-sm font-semibold">Suspension & indexing</h2>
            </div>
            <UiToggle
              v-model="config.autoSuspend"
              trailing
              label="Automatically suspend inactive tabs"
            />
            <label class="field-label"
              >Inactive for, in minutes<input
                v-model.number="config.suspendMinutes"
                type="number"
                class="field max-w-32"
                min="5"
                max="10080"
            /></label>
            <UiToggle v-model="config.protectPinned" trailing label="Protect pinned tabs" />
            <UiToggle v-model="config.protectAudio" trailing label="Protect audible tabs" />
            <UiToggle
              v-model="config.protectForms"
              trailing
              label="Protect unsaved form input"
              description="Conservative native input and editable-content checks; custom applications may need a site exception."
            />
            <UiToggle
              v-model="config.protectGrouped"
              trailing
              label="Protect all native grouped tabs"
            />
            <label class="field-label"
              >Never suspend these sites<textarea
                v-model="config.neverSuspendSites"
                class="field"
                rows="3"
                placeholder="mail.google.com&#10;https://example.com/editor/"
              />
            </label>
            <p class="text-xs text-muted">
              One domain or HTTP(S) URL prefix per line. Domains include subdomains. No regular
              expressions. Active and individually protected tabs always stay awake during automatic
              suspension.
            </p>
            <UiToggle
              v-model="config.pauseSuspensionOffline"
              trailing
              label="Pause automatic suspension when offline"
            />
            <UiToggle
              v-model="config.wakeOnFocus"
              trailing
              label="Wake TabFlow placeholders when selected"
              description="Off by default. Only the selected owned tab wakes; foreign placeholders and inspection targets are left alone."
            />
            <UiToggle
              v-model="config.restoreScroll"
              trailing
              label="Restore scroll position when waking"
            />
            <h3 class="text-sm font-semibold">Last-visible page previews</h3>
            <UiToggle
              v-model="config.capturePreviews"
              trailing
              label="Show a screenshot behind suspended-page controls"
              description="Optional local snapshots of pages you view. No background tab switching or bulk waking."
            />
            <UiButton class="w-fit" @click="store.run(enablePreviews)"
              >Enable screenshot permission</UiButton
            >
            <label class="field-label"
              >Never capture these sites<textarea
                v-model="config.previewExcludedSites"
                class="field"
                rows="2"
                placeholder="bank.example.com"
              />
            </label>
            <p class="text-xs leading-5 text-muted">
              Previews may contain private on-screen information. Stored locally in a bounded 24 MB
              cache, outside backups and AI requests. Only previously viewed pages have previews;
              old suspender images cannot be imported. Changes save automatically.
            </p>
            <UiButton
              variant="ghost"
              @click="
                store.run(async () => {
                  await rpc('clearPreviews', undefined);
                  store.notify('Local screenshots cleared');
                })
              "
              >Delete all local previews</UiButton
            >
            <UiToggle
              v-model="config.discardPlaceholders"
              trailing
              label="Discard inactive placeholders"
              description="Experimental: asks the browser to release inactive placeholder pages."
            />
            <UiToggle v-model="config.autoIndex" trailing label="Cache content when pages load" />
            <label class="field-label"
              >Maximum cached characters per page<input
                v-model.number="config.textLimit"
                type="number"
                class="field max-w-32"
                min="500"
                max="20000" /></label
            ><UiButton
              @click="
                store.run(async () => {
                  const ok = await browserApi.permissions.request({
                    origins: ['http://*/*', 'https://*/*'],
                  });
                  if (!ok) throw new Error('Permission declined');
                })
              "
              >Enable page inspection</UiButton
            >
            <p class="text-xs leading-6 text-muted">
              Page access enables indexing and input/media checks. Automatic suspension skips pages
              it cannot check. Explicit manual suspension works without this access.
            </p>
          </section>
          <section v-if="activeSection === 'backups'" class="flex min-w-0 flex-col gap-5 pb-6">
            <div class="flex items-center gap-3">
              <h2 class="text-sm font-semibold">Snapshots & backups</h2>
            </div>
            <UiCollapsible
              ><template #label>Startup and recovery</template>
              <div class="flex flex-col gap-3 pt-2">
                <label class="field-label"
                  >TabFlow startup address
                  <input
                    :value="startupUrl"
                    readonly
                    class="field"
                    @focus="($event.target as HTMLInputElement).select()"
                  />
                </label>
                <p class="text-xs leading-5 text-muted">
                  Add this address in your browser's startup settings to open TabFlow. Saved-session
                  recovery appears in Windows &amp; tabs and Snapshots &amp; history. No homepage or
                  new-tab preference is changed automatically.
                </p>
              </div></UiCollapsible
            >
            <label class="field-label"
              >Snapshots to keep<input
                v-model.number="config.snapshotRetention"
                type="number"
                class="field max-w-32"
                min="10"
                max="5000"
            /></label>
            <UiToggle
              v-model="config.backupEnabled"
              trailing
              label="Scheduled JSON backup downloads"
            />
            <label v-if="config.backupEnabled" class="field-label"
              >Backup interval, in hours<input
                v-model.number="config.backupHours"
                type="number"
                class="field max-w-32"
                min="1"
                max="168" /></label
            ><UiButton
              v-if="config.backupEnabled"
              @click="
                store.run(async () => {
                  await browserApi.permissions.request({ permissions: ['downloads'] });
                })
              "
              >Allow backup downloads</UiButton
            >
            <p class="text-xs leading-6 text-muted">
              Backups omit page previews, cached text and credentials. Older snapshots expire with
              their browser Undo; active operations remain protected.
            </p>
            <UiCollapsible
              ><template #label>Permissions and recovery limits</template>
              <div class="flex flex-col gap-3 pt-2">
                <div class="flex items-center gap-2 text-xs font-medium">Automation boundary</div>
                <p class="text-xs leading-6 text-muted">
                  AI changes require Apply. Protected tabs are excluded. Unsaved web-app state
                  cannot be fully restored from a URL snapshot.
                </p>
                <UiButton
                  @click="
                    store.run(async () => {
                      const p = await browserApi.permissions.getAll();
                      if (p.origins?.length)
                        await browserApi.permissions.remove({ origins: p.origins });
                    })
                  "
                  >Revoke optional host access</UiButton
                >
              </div></UiCollapsible
            >
          </section>
        </UiScrollArea>
      </div>
    </div>
  </form>
</template>
