<script setup lang="ts">
import UiCollapsible from '../../ui/UiCollapsible.vue';
import { computed } from 'vue';
import UiButton from '../../ui/UiButton.vue';
import PageSection from '../../ui/PageSection.vue';
import EmptyState from '../../ui/EmptyState.vue';
import { useWorkspace } from '../../stores/workspace';
import { rpc } from '../../shared/rpc';
import SuspenderMigrationPanel from './SuspenderMigrationPanel.vue';
const store = useWorkspace();
const emit = defineEmits<{ migrate: [] }>();
const summaries = computed(() => [
  {
    title: 'Missing cached content',
    description: 'Inspect pages to improve search and AI answers.',
    rows: store.records.filter((record) => !record.content && !record.locked),
  },
  {
    title: 'Not used in seven days',
    description: 'Find pages you may want to return to.',
    rows: store.records.filter((record) => Date.now() - record.lastAccessed > 7 * 86400000),
  },
]);
</script>
<template>
  <div class="flex max-w-4xl flex-col">
    <SuspenderMigrationPanel @migrate="emit('migrate')" />
    <PageSection
      title="Collection health"
      description="Useful context without waking your whole session."
    >
      <div
        v-for="summary in summaries"
        :key="summary.title"
        class="flex min-w-0 flex-col gap-3 border-b border-line py-4 last:border-b-0"
      >
        <div class="flex min-w-0 items-start gap-3">
          <span class="min-w-10 text-xl font-medium tabular-nums text-ink">{{
            summary.rows.length
          }}</span>
          <div class="flex min-w-0 flex-1 flex-col gap-1">
            <h3 class="text-[13px] font-medium">{{ summary.title }}</h3>
            <p class="text-[13px] leading-5 text-muted">{{ summary.description }}</p>
          </div>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <UiButton
            size="small"
            variant="ghost"
            :disabled="!summary.rows.length"
            @click="
              store.selected = new Set(summary.rows.map((record) => record.id));
              store.show('tabs');
            "
            >Review tabs</UiButton
          >
          <UiButton
            size="small"
            :disabled="!summary.rows.length"
            @click="store.run(() => store.inspect(summary.rows.map((record) => record.id)))"
            >Inspect</UiButton
          >
        </div>
      </div>
    </PageSection>
    <PageSection title="Inspection activity" description="Track running and completed inspections.">
      <div
        v-for="job in store.app?.jobs"
        :key="job.id"
        class="flex items-start gap-4 border-b border-line py-3 last:border-b-0"
      >
        <div class="flex min-w-0 flex-1 flex-col gap-1.5">
          <h3 class="text-[13px] font-medium">Content inspection · {{ job.status }}</h3>
          <p class="text-xs text-muted">
            {{ job.cursor }} / {{ job.items.length }} processed ·
            {{ new Date(job.createdAt).toLocaleString() }}
          </p>
          <UiCollapsible v-if="job.items.some((item) => item.error)" class="text-xs text-muted"
            ><template #label>Notices</template>
            <div class="flex flex-col gap-1 py-2">
              <p v-for="item in job.items.filter((entry) => entry.error)" :key="item.id">
                {{ item.error }}
              </p>
            </div>
          </UiCollapsible>
        </div>
        <UiButton
          v-if="['queued', 'running'].includes(job.status)"
          size="small"
          variant="ghost"
          @click="
            store.run(async () => {
              await rpc('cancel', { id: job.id });
              await store.refresh();
            })
          "
          >Cancel</UiButton
        >
      </div>
      <EmptyState
        v-if="!store.app?.jobs.length"
        title="No inspections yet"
        description="Select a few tabs to inspect. Suspended pages are processed one at a time."
      />
    </PageSection>
  </div>
</template>
