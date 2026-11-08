<script setup lang="ts">
import ProvenanceLabel from '../../ui/ProvenanceLabel.vue';
import { computed, ref, watch } from 'vue';
import { useNow, useIntervalFn } from '@vueuse/core';
import {
  PhCalendarDots as CalendarDays,
  PhCheck as Check,
  PhPlus as Plus,
  PhArrowCounterClockwise as RotateCcw,
  PhSparkle as Sparkles,
  PhSpinnerGap as LoaderCircle,
} from '@phosphor-icons/vue';
import UiButton from '../../ui/UiButton.vue';
import UiSelect from '../../ui/UiSelect.vue';
import UiSearchInput from '../../ui/UiSearchInput.vue';
import UiDisclosure from '../../ui/UiDisclosure.vue';
import EmptyState from '../../ui/EmptyState.vue';
import { useWorkspace } from '../../stores/workspace';
import { rpc } from '../../shared/rpc';
import type { WorkItem } from '../../shared/types';
import type { CalendarEvent } from '../../shared/types';
import type { DailyFocusDraft } from '../../ai/client';
import { runModelInference } from '../../ai/inference-lane';

const store = useWorkspace();
const now = useNow({ scheduler: (callback) => useIntervalFn(callback, 60_000) });
const scopeProject = ref('');
const workSearch = ref('');
const workStatus = ref('');
const title = ref('');
const notes = ref('');
const areaId = ref('');
const projectId = ref('');
const recordId = ref('');
const due = ref('');
const priority = ref('normal');
const newArea = ref('');
const submitting = ref(false);
const captureOpen = ref(false);
const calendarOpen = ref(false);
const focusing = ref(false);
const focusDraft = ref<DailyFocusDraft | null>(null);
const calendarBusy = ref(false);
const calendarError = ref('');
const areas = computed(() => store.app?.areas || []);
const projects = computed(() => store.app?.projects || []);
const records = computed(() => store.records);
const completedItems = computed(() =>
  (store.app?.workItems || [])
    .filter(
      (item) =>
        item.status === 'done' && (!scopeProject.value || item.projectId === scopeProject.value),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 8),
);
function tabContext(id: string) {
  const membership = store.app?.memberships.find((item) => item.recordId === id);
  return [
    projects.value.find((project) => project.id === membership?.projectId)?.name,
    store.app?.categories.find((category) => category.id === membership?.categoryId)?.name,
  ]
    .filter(Boolean)
    .join(' · ');
}
function domain(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
const scopedRecords = computed(() =>
  records.value.filter(
    (record) =>
      !scopeProject.value ||
      store.app?.memberships.some(
        (membership) =>
          membership.recordId === record.id && membership.projectId === scopeProject.value,
      ),
  ),
);
const resumeRecords = computed(() =>
  [...scopedRecords.value]
    .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))
    .slice(0, 6),
);
const dayLabel = computed(() =>
  now.value.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }),
);
const openItems = computed(() =>
  [...(store.app?.workItems || [])]
    .filter(
      (item) =>
        item.status !== 'done' && (!scopeProject.value || item.projectId === scopeProject.value),
    )
    .sort((a, b) => {
      const urgency = { urgent: 0, high: 1, normal: 2, low: 3 };
      const priorityOrder = urgency[a.priority] - urgency[b.priority];
      if (priorityOrder) return priorityOrder;
      return (a.dueAt ?? Number.MAX_SAFE_INTEGER) - (b.dueAt ?? Number.MAX_SAFE_INTEGER);
    }),
);
const visibleItems = computed(() =>
  openItems.value.filter(
    (item) =>
      (!workStatus.value || item.status === workStatus.value) &&
      (!workSearch.value ||
        `${item.title} ${item.notes} ${records.value.find((record) => record.id === item.recordId)?.title || ''}`
          .toLocaleLowerCase()
          .includes(workSearch.value.toLocaleLowerCase())),
  ),
);
watch(
  () => JSON.stringify([scopeProject.value, openItems.value]),
  () => {
    focusDraft.value = null;
  },
);
const dueToday = computed(
  () =>
    openItems.value.filter((item) => {
      const end = new Date(now.value);
      end.setHours(23, 59, 59, 999);
      return item.dueAt !== null && item.dueAt <= end.getTime();
    }).length,
);
const areaOptions = computed(() => [
  { label: 'No area', value: '' },
  ...areas.value.map((area) => ({ label: area.name, value: area.id })),
]);
const projectOptions = computed(() => [
  { label: 'No project', value: '' },
  ...projects.value.map((project) => ({ label: project.name, value: project.id })),
]);
const recordOptions = computed(() => [
  { label: 'No linked tab', value: '' },
  ...records.value.map((record) => ({
    label: `${record.title} · ${new URL(record.url).hostname}`,
    value: record.id,
  })),
]);
const statusOptions = [
  { label: 'Open', value: 'open' },
  { label: 'In progress', value: 'doing' },
  { label: 'Waiting', value: 'waiting' },
  { label: 'Done', value: 'done' },
];
const priorityOptions = [
  { label: 'Low', value: 'low' },
  { label: 'Normal', value: 'normal' },
  { label: 'High', value: 'high' },
  { label: 'Urgent', value: 'urgent' },
];
function formatDue(value: number | null) {
  if (value === null) return 'No due date';
  return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
async function addArea() {
  if (!newArea.value.trim()) return;
  await store.run(async () => {
    const area = await rpc('area', { name: newArea.value });
    await store.refresh();
    areaId.value = area.id;
    newArea.value = '';
  });
}
async function addItem() {
  if (!title.value.trim() || submitting.value) return;
  submitting.value = true;
  try {
    await store.run(async () => {
      await rpc('workItem', {
        title: title.value,
        notes: notes.value,
        areaId: areaId.value || null,
        projectId: projectId.value || null,
        recordId: recordId.value || null,
        status: 'open',
        priority: priority.value as WorkItem['priority'],
        dueAt: due.value ? new Date(due.value).getTime() : null,
        source: recordId.value ? 'tab' : 'owner',
      });
      title.value = '';
      notes.value = '';
      due.value = '';
      recordId.value = '';
      captureOpen.value = false;
      await store.refresh();
    });
  } finally {
    submitting.value = false;
  }
}
async function updateStatus(item: WorkItem, status: string) {
  await store.run(async () => {
    await rpc('workItem', { ...item, status: status as WorkItem['status'] });
    await store.refresh();
  });
}
async function planDay() {
  if (!store.app || focusing.value) return;
  focusing.value = true;
  focusDraft.value = null;
  try {
    await store.run(async () => {
      const origin = `${new URL(store.app!.settings.aiBase).origin}/*`;
      if (
        !(await chrome.permissions.contains({ origins: [origin] })) &&
        !(await chrome.permissions.request({ origins: [origin] }))
      )
        throw new Error('Generative model access was declined.');
      const { generateDailyFocus } = await import('../../ai/client');
      focusDraft.value = await runModelInference(
        () =>
          generateDailyFocus(
            { ...store.app!, workItems: openItems.value, records: scopedRecords.value },
            {
              calendarEvents: store.calendarEvents,
            },
          ),
        { parallelism: store.app!.settings.maxConcurrentInference },
      );
    });
  } finally {
    focusing.value = false;
  }
}
function focusTitle(id: string) {
  return openItems.value.find((item) => item.id === id)?.title ?? id;
}
async function connectCalendar() {
  const settings = store.app?.settings;
  if (!settings?.googleCalendarClientId.trim()) {
    calendarError.value = 'Add the Google OAuth client ID in Settings first.';
    return;
  }
  calendarBusy.value = true;
  calendarError.value = '';
  try {
    const required = {
      permissions: ['identity'] as chrome.runtime.ManifestPermission[],
      origins: ['https://www.googleapis.com/*', 'https://oauth2.googleapis.com/*'],
    };
    if (!(await chrome.permissions.request(required)))
      throw new Error('Google Calendar permission was declined.');
    const { authorizeGoogleCalendar, fetchTodayCalendarEvents } =
      await import('../../providers/google-calendar');
    const authorized = await authorizeGoogleCalendar(settings.googleCalendarClientId);
    store.calendarAccessToken = authorized.accessToken;
    store.calendarTokenExpiresAt = authorized.expiresAt;
    store.calendarEvents = await fetchTodayCalendarEvents(authorized.accessToken);
    store.calendarFetchedAt = Date.now();
  } catch (error) {
    calendarError.value =
      error instanceof Error ? error.message : 'Could not connect Google Calendar.';
  } finally {
    calendarBusy.value = false;
  }
}
async function refreshCalendar() {
  if (!store.calendarAccessToken || Date.now() >= store.calendarTokenExpiresAt) {
    await connectCalendar();
    return;
  }
  calendarBusy.value = true;
  calendarError.value = '';
  try {
    const { fetchTodayCalendarEvents } = await import('../../providers/google-calendar');
    store.calendarEvents = await fetchTodayCalendarEvents(store.calendarAccessToken);
    store.calendarFetchedAt = Date.now();
  } catch (error) {
    calendarError.value =
      error instanceof Error ? error.message : 'Could not refresh Google Calendar.';
  } finally {
    calendarBusy.value = false;
  }
}
async function disconnectCalendar() {
  const token = store.calendarAccessToken;
  store.calendarAccessToken = '';
  store.calendarTokenExpiresAt = 0;
  store.calendarEvents = [];
  store.calendarFetchedAt = null;
  calendarError.value = '';
  const { revokeGoogleCalendarToken } = await import('../../providers/google-calendar');
  const origins = ['https://www.googleapis.com/*', 'https://oauth2.googleapis.com/*'];
  try {
    if (token) await revokeGoogleCalendarToken(token);
  } catch (error) {
    calendarError.value =
      error instanceof Error ? error.message : 'Could not revoke Google access.';
  } finally {
    try {
      const identityPermission = {
        permissions: ['identity'] as chrome.runtime.ManifestPermission[],
      };
      if (await chrome.permissions.contains(identityPermission))
        await chrome.permissions.remove(identityPermission);
      if (await chrome.permissions.contains({ origins }))
        await chrome.permissions.remove({ origins });
    } catch {
      calendarError.value ||=
        'Calendar access was revoked, but browser permissions could not be removed.';
    }
  }
}
function eventTime(event: CalendarEvent) {
  if (event.allDay) return 'All day';
  return new Date(event.start).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
}
function fetchedTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
</script>

<template>
  <div class="flex min-w-0 max-w-5xl flex-col gap-6">
    <section class="flex flex-col gap-3">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="flex flex-col gap-1">
          <h2 class="text-base font-semibold">{{ dayLabel }}</h2>
        </div>
        <UiSelect
          v-model="scopeProject"
          :options="[
            { label: 'All projects', value: '' },
            ...projects.map((project) => ({ label: project.name, value: project.id })),
          ]"
          class="w-56"
          aria-label="Today project"
        />
      </div>
      <div class="flex flex-wrap items-center justify-between gap-3">
        <p class="text-[13px] text-secondary">
          {{ openItems.length }} {{ openItems.length === 1 ? 'next action' : 'next actions' }} ·
          {{ dueToday }} due or overdue · {{ scopedRecords.length }} open tabs
        </p>
        <div class="flex items-center gap-2">
          <UiButton
            size="small"
            variant="ghost"
            :disabled="focusing || !openItems.length"
            @click="planDay"
          >
            <LoaderCircle v-if="focusing" class="size-3.5 animate-spin" />
            <Sparkles v-else class="size-3.5" />
            {{ focusing ? 'Planning from your work…' : 'Plan saved work' }}
          </UiButton>
          <UiButton
            size="small"
            variant="primary"
            @click="
              captureOpen = !captureOpen;
              if (!title.trim()) projectId = scopeProject;
            "
            ><Plus class="size-3.5" />Add next action</UiButton
          >
        </div>
      </div>
      <article v-if="focusDraft" class="flex flex-col gap-3 border-l-2 border-accent pl-3">
        <p class="text-xs leading-5">{{ focusDraft.summary }}</p>
        <ol v-if="focusDraft.priorities.length" class="flex flex-col gap-2">
          <li v-for="(priorityItem, index) in focusDraft.priorities" :key="priorityItem.workItemId">
            <div class="flex items-start gap-2 text-xs">
              <span class="font-semibold tabular-nums text-muted">{{ index + 1 }}.</span>
              <div class="flex min-w-0 flex-col gap-1">
                <span class="font-medium">{{ focusTitle(priorityItem.workItemId) }}</span>
                <span class="text-muted">{{ priorityItem.reason }}</span>
              </div>
            </div>
          </li>
        </ol>
        <ul v-if="focusDraft.evidenceGaps.length" class="flex flex-col gap-1 text-xs text-muted">
          <li v-for="gap in focusDraft.evidenceGaps" :key="gap">Missing evidence: {{ gap }}</li>
        </ul>
      </article>
    </section>

    <UiDisclosure v-if="captureOpen" v-model:open="captureOpen" label="Capture work">
      <div class="flex flex-col gap-5 px-3 pb-5">
        <section class="flex flex-col gap-3">
          <h3 class="text-sm font-semibold">Contexts</h3>
          <div class="flex flex-wrap items-center gap-2">
            <UiSelect
              v-model="areaId"
              :options="areaOptions"
              class="w-44"
              aria-label="Work context"
            />
            <input
              v-model="newArea"
              class="field min-w-40 flex-1 text-xs"
              placeholder="Add Personal, Work, Home…"
              aria-label="New context name"
              @keydown.enter.prevent="addArea"
            />
            <UiButton size="small" :disabled="!newArea.trim()" @click="addArea">
              <Plus class="size-3.5" />Add context
            </UiButton>
          </div>
        </section>

        <form class="flex flex-col gap-3" @submit.prevent="addItem">
          <h3 class="text-sm font-semibold">Next step</h3>
          <input
            v-model="title"
            class="field text-xs"
            maxlength="240"
            placeholder="Reply to the landlord, review issue #42, prepare for a meeting…"
            aria-label="Work item"
            required
          />
          <textarea
            v-model="notes"
            class="field min-h-16 resize-y text-xs"
            maxlength="4000"
            placeholder="Notes or the next concrete step"
            aria-label="Work item notes"
          />
          <div class="flex flex-wrap items-center gap-2">
            <UiSelect v-model="areaId" :options="areaOptions" class="w-44" aria-label="Context" />
            <UiSelect
              v-model="projectId"
              :options="projectOptions"
              class="w-44"
              aria-label="Project"
            />
            <UiSelect
              v-model="recordId"
              :options="recordOptions"
              class="w-64"
              aria-label="Linked open tab"
            />
            <UiSelect
              v-model="priority"
              :options="priorityOptions"
              class="w-32"
              aria-label="Priority"
            />
            <label class="flex items-center gap-2 text-xs text-muted">
              Due
              <input
                v-model="due"
                class="field text-xs"
                type="datetime-local"
                aria-label="Due date"
              />
            </label>
            <UiButton
              type="submit"
              variant="primary"
              size="small"
              :disabled="!title.trim() || submitting"
            >
              <Plus class="size-3.5" />Add to Today
            </UiButton>
          </div>
        </form>
      </div>
    </UiDisclosure>

    <section class="flex flex-col gap-1" aria-label="Open work">
      <div class="flex flex-wrap items-center gap-3 pb-2">
        <h2 class="min-w-0 flex-1 text-sm font-semibold">Next actions</h2>
        <UiSearchInput
          v-model="workSearch"
          label="Search next actions"
          placeholder="Find an action…"
          class="w-56 max-w-full"
        /><UiSelect
          v-model="workStatus"
          :options="[
            { label: 'All active statuses', value: '' },
            ...statusOptions.filter((option) => option.value !== 'done'),
          ]"
          class="w-44"
          aria-label="Filter next actions"
        />
      </div>
      <article
        v-for="item in visibleItems"
        :key="item.id"
        class="flex flex-wrap items-center gap-3 border-b border-line py-3"
      >
        <div class="flex min-w-52 flex-1 flex-col gap-1">
          <h3 class="text-[13px] font-medium">{{ item.title }}</h3>
          <ProvenanceLabel :provenance="item.provenance" />
          <p v-if="item.notes" class="text-xs leading-5 text-muted">{{ item.notes }}</p>
          <div class="flex flex-wrap items-center gap-2 text-xs text-muted">
            <span v-if="item.areaId">{{
              areas.find((area) => area.id === item.areaId)?.name
            }}</span>
            <span v-if="item.projectId">{{
              projects.find((project) => project.id === item.projectId)?.name
            }}</span>
            <button
              v-if="item.recordId"
              class="truncate text-accent hover:underline"
              :title="item.url || undefined"
              @click.prevent="store.run(() => rpc('focus', { id: item.recordId! }))"
            >
              {{ records.find((record) => record.id === item.recordId)?.title || 'Linked tab' }}
            </button>
            <span v-if="item.dueAt !== null">{{ formatDue(item.dueAt) }}</span>
          </div>
        </div>
        <span v-if="item.priority !== 'normal'" class="text-xs capitalize text-muted">{{
          item.priority
        }}</span>
        <UiSelect
          :model-value="item.status"
          :options="statusOptions"
          class="w-36"
          aria-label="Work item status"
          @update:model-value="(status) => updateStatus(item, status)"
        />
      </article>
      <EmptyState
        v-if="!visibleItems.length"
        :title="openItems.length ? 'No matching actions' : 'Give this day a next step'"
        :description="
          openItems.length
            ? 'Change the search or status filter to see your saved actions.'
            : 'Add an action and optionally link it to a project or tab.'
        "
        ><UiButton size="small" @click="captureOpen = true">Capture work</UiButton></EmptyState
      >
    </section>

    <section class="flex flex-col gap-2" aria-label="Continue browsing">
      <div class="flex items-center justify-between gap-2">
        <h2 class="text-sm font-semibold">Continue browsing</h2>
        <span class="text-xs text-muted">Recently used</span>
      </div>
      <button
        v-for="record in resumeRecords"
        :key="record.id"
        type="button"
        class="flex min-w-0 items-center gap-3 rounded-md px-3 py-2 text-left hover:bg-hover"
        @click="store.run(() => rpc('focus', { id: record.id }))"
      >
        <span class="flex min-w-0 flex-1 flex-col gap-1"
          ><span class="truncate text-[13px] font-medium">{{ record.title }}</span
          ><span class="truncate text-xs text-muted"
            >{{ tabContext(record.id) ? `${tabContext(record.id)} · ` : '' }}{{ domain(record.url)
            }}<template v-if="record.tags.length"> · {{ record.tags.join(' · ') }}</template></span
          ></span
        ><span class="text-xs text-muted">{{ record.suspended ? 'Sleeping' : 'Open' }}</span>
      </button>
      <p v-if="!resumeRecords.length" class="py-2 text-xs text-muted">
        No open tabs in this project. Assign tabs from Workspace to see them here.
      </p>
    </section>

    <UiDisclosure
      v-model:open="calendarOpen"
      label="Schedule"
      :count="store.calendarFetchedAt ? store.calendarEvents.length : undefined"
    >
      <div class="flex flex-col gap-3 px-3 pb-3">
        <div class="flex flex-wrap items-center gap-2">
          <UiButton
            size="small"
            :disabled="calendarBusy"
            @click="
              store.calendarFetchedAt || store.calendarAccessToken
                ? refreshCalendar()
                : connectCalendar()
            "
          >
            <LoaderCircle v-if="calendarBusy" class="size-3.5 animate-spin" />
            <CalendarDays v-else class="size-3.5" />
            {{
              calendarBusy
                ? 'Loading calendar…'
                : store.calendarFetchedAt
                  ? 'Refresh calendar'
                  : 'Connect Google Calendar'
            }}
          </UiButton>
          <UiButton
            v-if="store.calendarAccessToken"
            size="small"
            variant="ghost"
            @click="disconnectCalendar"
          >
            Disconnect
          </UiButton>
          <span v-if="store.calendarFetchedAt" class="text-xs text-muted">
            {{ store.calendarEvents.length }} events · fetched
            {{ fetchedTime(store.calendarFetchedAt) }} · titles go to your model only when planning
          </span>
          <span v-else class="text-xs text-muted"
            >Optional, read-only schedule access. Nothing syncs in the background.</span
          >
        </div>
        <p v-if="calendarError" class="text-xs text-danger" role="alert">{{ calendarError }}</p>
        <div
          v-if="store.calendarFetchedAt"
          class="flex flex-col gap-1"
          aria-label="Today’s calendar events"
        >
          <article
            v-for="event in store.calendarEvents"
            :key="event.id"
            class="flex items-center gap-3 border-b border-line py-2 text-xs"
          >
            <time class="w-16 shrink-0 text-muted">{{ eventTime(event) }}</time>
            <a
              v-if="event.htmlLink"
              :href="event.htmlLink"
              target="_blank"
              rel="noreferrer"
              class="min-w-0 flex-1 truncate hover:underline"
              >{{ event.title }}</a
            >
            <span v-else class="min-w-0 flex-1 truncate">{{ event.title }}</span>
          </article>
          <p v-if="!store.calendarEvents.length" class="py-2 text-xs text-muted">
            No events on this calendar today.
          </p>
        </div>
      </div>
    </UiDisclosure>
    <section v-if="completedItems.length" class="flex flex-col gap-2">
      <h3 class="text-sm font-semibold">Completed recently</h3>
      <div
        v-for="item in completedItems"
        :key="item.id"
        class="flex items-center gap-2 text-xs text-muted"
      >
        <Check class="size-3.5" />
        <span class="min-w-0 flex-1 truncate">{{ item.title }}</span>
        <UiButton size="small" variant="ghost" @click="updateStatus(item, 'open')">
          <RotateCcw class="size-3" />Reopen
        </UiButton>
      </div>
    </section>
  </div>
</template>
