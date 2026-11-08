<script setup lang="ts">
import UiDataBlock from '../../ui/UiDataBlock.vue';
import UiCollapsible from '../../ui/UiCollapsible.vue';
import { ref, watch } from 'vue';
import { liveQuery } from 'dexie';
import { database } from '../../core/db';
import type { AssistantAuditEntry } from '../../shared/types';
import UiButton from '../../ui/UiButton.vue';
const props = defineProps<{ messageId: string }>();
const open = ref(false),
  page = ref(0),
  total = ref(0),
  entries = ref<AssistantAuditEntry[]>([]),
  error = ref('');
watch(
  () => props.messageId,
  () => {
    page.value = 0;
    total.value = 0;
    entries.value = [];
    error.value = '';
  },
);
watch([open, page, () => props.messageId], (_value, _old, onCleanup) => {
  if (!open.value) return;
  const subscription = liveQuery(async () => ({
    total: await database.assistantAudit.where('messageId').equals(props.messageId).count(),
    entries: await database.assistantAudit
      .where('[messageId+sequence]')
      .between([props.messageId, 0], [props.messageId, Number.MAX_SAFE_INTEGER])
      .offset(page.value * 50)
      .limit(50)
      .toArray(),
  })).subscribe({
    next: (result) => {
      total.value = result.total;
      entries.value = result.entries;
    },
    error: (value) => {
      error.value = String(value);
    },
  });
  onCleanup(() => subscription.unsubscribe());
});
</script>
<template>
  <UiCollapsible class="text-xs text-muted" @update:open="open = $event"
    ><template #label>Full run history</template>
    <div v-if="open" class="flex flex-col gap-2 pt-2">
      <p v-if="error" role="status">{{ error }}</p>
      <p v-else-if="!total">
        No extended history. Older messages retain their saved activity below.
      </p>
      <UiCollapsible v-for="entry in entries" :key="entry.id"
        ><template #label>
          {{ entry.sequence }} · {{ new Date(entry.createdAt).toLocaleTimeString() }} ·
          {{ entry.event ? `${entry.event.tool} · ${entry.event.phase}` : entry.text }}
        </template>
        <UiDataBlock v-if="entry.event" :value="entry.event.details || entry.event.summary" />
      </UiCollapsible>
      <div v-if="total" class="flex items-center gap-2">
        <UiButton size="small" variant="ghost" :disabled="page === 0" @click="page--"
          >Previous</UiButton
        >
        <span>{{ page * 50 + 1 }}–{{ Math.min(total, (page + 1) * 50) }} of {{ total }}</span>
        <UiButton size="small" variant="ghost" :disabled="(page + 1) * 50 >= total" @click="page++"
          >Next</UiButton
        >
        <UiButton
          size="small"
          variant="ghost"
          @click="page = Math.max(0, Math.ceil(total / 50) - 1)"
          >Latest</UiButton
        >
      </div>
    </div>
  </UiCollapsible>
</template>
