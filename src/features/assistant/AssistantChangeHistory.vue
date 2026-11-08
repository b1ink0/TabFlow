<script setup lang="ts">
import { computed, ref, onMounted } from 'vue';
import { PhArrowCounterClockwise } from '@phosphor-icons/vue';
import UiButton from '../../ui/UiButton.vue';
import UiCollapsible from '../../ui/UiCollapsible.vue';
import UiDataBlock from '../../ui/UiDataBlock.vue';
import { useWorkspace } from '../../stores/workspace';
import { rpc } from '../../shared/rpc';
import {
  currentAssistantTrace,
  capabilityLabels,
  type AssistantChange,
} from '../../shared/assistant-actions';
import { useAssistantConversations } from '../../stores/assistant';
const props = defineProps<{ messageId?: string; threadId?: string; traceIds?: string[] }>();
const store = useWorkspace();
const chat = useAssistantConversations();
const page = ref<AssistantChange[]>([]);
const offset = ref(0);
const details = ref(new Map<string, AssistantChange>());
function capabilityText(trace: AssistantChange) {
  return trace.capabilities.map((item) => capabilityLabels[item]).join(', ');
}
const traces = computed(() =>
  (offset.value ||
  (props.messageId &&
    !(store.app?.assistantChanges || []).some((item) => item.messageId === props.messageId))
    ? page.value
    : store.app?.assistantChanges || []
  )
    .map((trace) =>
      currentAssistantTrace(
        trace,
        store.app?.operations.find((item) => item.id === trace.operationId),
      ),
    )
    .filter(
      (item) =>
        (!props.messageId || item.messageId === props.messageId) &&
        (!props.threadId || item.threadId === props.threadId),
    ),
);
async function loadPage(next: number) {
  await store.run(async () => {
    page.value = await rpc('listAssistantChanges', { messageId: props.messageId, offset: next });
    offset.value = next;
  });
}
onMounted(() => {
  if (props.messageId && props.traceIds?.length && !traces.value.length) void loadPage(0);
});
async function loadDetails(id: string, open: boolean) {
  if (!open) return;
  await store.run(async () => {
    const value = await rpc('assistantChangeDetails', { id });
    if (value) details.value.set(id, value);
  });
}
async function undo(id: string, redo = false) {
  await store.run(async () => {
    const result = await rpc(redo ? 'redoAssistantChange' : 'undoAssistantChange', { id });
    page.value = page.value.map((trace) =>
      trace.id === id ? { ...result, deltas: [], deltaCount: result.deltas.length } : trace,
    );
    if (details.value.has(id)) details.value.set(id, result);
    const message =
      chat.current?.id === result.threadId
        ? chat.current.messages.find((item) => item.id === result.messageId)
        : undefined;
    if (message && !message.outcome?.includes(result.outcome)) {
      message.outcome = `${message.outcome || ''}\n${result.outcome}`.trim().slice(-2000);
      await chat.save();
    }
    store.notify(result.outcome);
    await store.refresh();
  });
}
</script>
<template>
  <div
    v-if="traces.length || offset > 0"
    class="flex flex-col gap-2"
    aria-label="Assistant action trace"
  >
    <article
      v-for="trace in traces"
      :key="trace.id"
      class="flex flex-col gap-2 rounded-md bg-raised px-3 py-2 text-xs"
    >
      <div class="flex flex-wrap items-center justify-between gap-2">
        <strong>{{ trace.summary }}</strong
        ><span class="text-muted"
          >{{ trace.status }} ·
          {{
            trace.source === 'owner'
              ? 'Manual edit'
              : trace.mode === 'reviewed'
                ? 'Orchestrator approved'
                : trace.mode === 'automatic'
                  ? 'Approve all'
                  : trace.mode === 'once'
                    ? 'Approved once'
                    : trace.mode === 'chat'
                      ? 'Allowed for chat'
                      : 'Always allowed'
          }}</span
        >
      </div>
      <p class="whitespace-pre-wrap">{{ trace.outcome }}</p>
      <p v-if="trace.recoveryAvailable === false" class="text-muted">Recovery snapshot expired</p>
      <p v-if="trace.permissionReview" class="text-muted">
        {{ trace.permissionReview.reason }} ? {{ trace.permissionReview.model }}
      </p>
      <UiCollapsible @update:open="loadDetails(trace.id, $event)"
        ><template #label
          >Change details · {{ trace.deltaCount ?? trace.deltas.length }} values</template
        >
        <div class="flex flex-col gap-2 py-2">
          <span class="text-muted"
            >{{ new Date(trace.createdAt).toLocaleString() }} · {{ capabilityText(trace) }}</span
          >
          <div
            v-for="(delta, index) in details.get(trace.id)?.deltas || trace.deltas"
            :key="index"
            class="flex flex-col gap-1"
          >
            <strong
              >{{ store.records.find((item) => item.id === delta.id)?.title || delta.table }} ·
              {{ delta.field }}</strong
            ><span>Before</span><UiDataBlock :value="delta.before || 'null'" /><span>After</span
            ><UiDataBlock :value="delta.after || 'null'" />
          </div>
          <p v-for="item in trace.undoResults" :key="item.id">
            {{ item.restored ? 'Restored' : 'Retained' }} · {{ item.reason || item.id }}
          </p>
          <span
            v-if="!trace.operationId && !(trace.deltaCount ?? trace.deltas.length)"
            class="text-muted"
            >No reversible workspace values. Inspection can be stopped from browser work progress;
            loading a page cannot undo its network requests.</span
          >
        </div>
      </UiCollapsible>
      <div
        v-if="
          !trace.archived &&
          trace.recoveryAvailable !== false &&
          (trace.operationId || (trace.deltaCount ?? trace.deltas.length)) &&
          !['running', 'undone', 'denied'].includes(trace.status)
        "
        class="flex justify-end"
      >
        <UiButton size="small" @click="undo(trace.id)"
          ><PhArrowCounterClockwise class="size-3.5" />Undo action</UiButton
        >
      </div>
      <p v-if="trace.archived" class="text-muted">Imported history · read-only</p>
      <div v-if="!trace.archived && trace.status === 'undone'" class="flex justify-end">
        <UiButton size="small" @click="undo(trace.id, true)">Redo action</UiButton>
      </div>
    </article>
    <div v-if="!messageId" class="flex items-center justify-end gap-2">
      <UiButton size="small" :disabled="offset === 0" @click="loadPage(Math.max(0, offset - 100))"
        >Previous actions</UiButton
      ><UiButton size="small" :disabled="traces.length < 100" @click="loadPage(offset + 100)"
        >Older actions</UiButton
      >
    </div>
  </div>
</template>
