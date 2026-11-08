<script setup lang="ts">
import UiCollapsible from '../../ui/UiCollapsible.vue';
import { ref, computed, onMounted, watch } from 'vue';
import UProgress from '@nuxt/ui/components/Progress.vue';
import UiButton from '../../ui/UiButton.vue';
import PageSection from '../../ui/PageSection.vue';
import { useWorkspace } from '../../stores/workspace';
import { rpc } from '../../shared/rpc';
import type { MigrationReport, SuspenderMigration } from '../../shared/types';
const store = useWorkspace();
const emit = defineEmits<{ migrate: [] }>();
const report = ref<MigrationReport>();
const details = ref<SuspenderMigration>();
const progress = computed(() => store.app?.migration);
async function scan() {
  report.value = await rpc('migrationReport', undefined);
}
async function receipt(download = false) {
  if (!progress.value) return;
  details.value = await rpc('migrationDetails', { id: progress.value.id });
  if (download && details.value) {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(details.value, null, 2)], { type: 'application/json' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = `tabflow-import-${details.value.id}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
async function cancel() {
  if (progress.value && store.app)
    store.app.migration = await rpc('cancelMigration', { id: progress.value.id });
}
async function retry() {
  if (progress.value && store.app)
    store.app.migration = await rpc('retryMigration', { id: progress.value.id });
}
watch(
  () => progress.value?.status,
  (status) => {
    if (status && status !== 'running')
      void store.run(async () => {
        await scan();
        await receipt();
        await store.refresh();
      });
  },
);
onMounted(() => store.run(scan));
</script>
<template>
  <PageSection
    title="Suspender migration"
    description="Keep the old extension installed until all of its placeholders are recovered and verified."
  >
    <template #actions
      ><UiButton size="small" variant="ghost" @click="store.run(scan)">Scan again</UiButton
      ><UiButton size="small" :disabled="progress?.status === 'running'" @click="emit('migrate')"
        >Import Suspender tabs</UiButton
      ></template
    >
    <p v-if="report" class="text-[13px] text-secondary">
      {{ report.recognized }} recognizable foreign placeholders · {{ report.protected }} protected ·
      {{ report.unsupported.length }} unsupported
    </p>
    <div v-if="progress" class="flex flex-col gap-3 py-3">
      <div class="flex flex-wrap items-center gap-3">
        <h3 class="text-[13px] font-medium">Import {{ progress.status }}</h3>
        <span class="text-xs text-muted"
          >{{ progress.processed }} / {{ progress.total }} processed</span
        >
      </div>
      <UProgress
        :model-value="progress.processed"
        :max="Math.max(1, progress.total)"
        color="neutral"
        aria-label="Suspender import progress"
      />
      <p class="text-xs text-muted">
        {{ progress.imported }} imported · {{ progress.failed }} failed ·
        {{ progress.skipped }} skipped
      </p>
      <p
        v-if="progress.status === 'running' && progress.currentTitle"
        class="truncate text-xs text-muted"
      >
        Next: {{ progress.currentTitle }}
      </p>
      <p v-if="progress.status === 'interrupted'" class="text-[13px] text-secondary">
        Import stopped when the background worker restarted. Review the receipt and retry
        explicitly; no changes replay automatically.
      </p>
      <div class="flex flex-wrap gap-2">
        <UiButton v-if="progress.status === 'running'" size="small" @click="store.run(cancel)"
          >Cancel import</UiButton
        >
        <UiButton v-else-if="progress.status !== 'complete'" size="small" @click="store.run(retry)"
          >Retry remaining</UiButton
        >
        <UiButton size="small" variant="ghost" @click="store.run(() => receipt(true))"
          >Download import receipt</UiButton
        >
        <UiButton size="small" variant="ghost" @click="store.run(() => receipt())"
          >Show notices</UiButton
        >
        <UiButton size="small" variant="ghost" @click="store.show('timeline')"
          >Recovery history</UiButton
        >
      </div>
      <div v-if="details" class="flex flex-col gap-2 text-xs text-muted">
        <p
          v-for="item in details.items.filter((item) => item.error).slice(0, 20)"
          :key="item.recordId"
        >
          {{ item.title }}: {{ item.error }}
        </p>
        <p v-if="details.items.filter((item) => item.error).length > 20">
          Download the receipt for all notices.
        </p>
      </div>
    </div>
    <UiCollapsible v-if="report?.unsupported.length" class="text-xs text-muted"
      ><template #label>Unsupported placeholders require manual recovery</template>
      <div class="flex flex-col gap-2 py-2">
        <p v-for="item in report.unsupported.slice(0, 20)" :key="item.tabId" class="break-all">
          {{ item.title }} · {{ item.wrapper }}
        </p>
        <p>
          Recover these with the old extension or your independent session export. TabFlow does not
          guess missing addresses.
        </p>
      </div>
    </UiCollapsible>
    <p
      v-if="
        report && !report.recognized && !report.unsupported.length && progress?.status !== 'running'
      "
      class="text-xs text-secondary"
    >
      No foreign placeholders detected in normal windows. Export a fresh backup and test a few
      TabFlow wakes before disabling the old suspender. Incognito, app and other profiles are
      outside this scan.
    </p>
  </PageSection>
</template>
