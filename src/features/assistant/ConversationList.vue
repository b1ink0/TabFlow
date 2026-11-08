<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  PhDotsThree as Ellipsis,
  PhChatCircle as MessageSquare,
  PhPlus as Plus,
  PhX as X,
} from '@phosphor-icons/vue';
import UDropdownMenu from '@nuxt/ui/components/DropdownMenu.vue';
import UiButton from '../../ui/UiButton.vue';
import UiSearchInput from '../../ui/UiSearchInput.vue';
import UiDisclosure from '../../ui/UiDisclosure.vue';
import UiScrollArea from '../../ui/UiScrollArea.vue';
import UiLoadMore from '../../ui/UiLoadMore.vue';
import { cn } from '../../shared/cn';
import type { AssistantThread } from '../../shared/assistant';

const props = defineProps<{
  threads: AssistantThread[];
  activeId: string;
  projects: { id: string; name: string }[];
  busy: boolean;
  docked?: boolean;
  hasMore?: boolean;
}>();
const emit = defineEmits<{
  select: [id: string];
  create: [projectId: string | null];
  move: [id: string, projectId: string | null];
  close: [];
  rename: [id: string];
  remove: [id: string];
  search: [query: string];
  more: [];
}>();
const query = ref('');
watch(query, (value) => emit('search', value));
const expanded = ref(new Set<string>(['workspace']));
watch(
  () => props.threads.find((thread) => thread.id === props.activeId)?.projectId,
  (projectId) => {
    if (projectId) expanded.value = new Set([...expanded.value, projectId]);
  },
  { immediate: true },
);
const groups = computed(() => [
  { id: 'workspace', projectId: null, name: 'Unassigned' },
  ...props.projects.map((project) => ({
    id: project.id,
    projectId: project.id,
    name: project.name,
  })),
]);
const visibleGroups = computed(() =>
  groups.value
    .map((group) => ({
      ...group,
      threads: props.threads.filter(
        (thread) =>
          thread.projectId === group.projectId &&
          (!query.value ||
            `${thread.title} ${group.name}`.toLowerCase().includes(query.value.toLowerCase())),
      ),
    }))
    .filter((group) => !query.value || group.threads.length),
);
function setExpanded(id: string, open: boolean) {
  const next = new Set(expanded.value);
  if (open) next.add(id);
  else next.delete(id);
  expanded.value = next;
}
function menuItems(thread: AssistantThread) {
  return [
    { label: 'Rename chat', onSelect: () => emit('rename', thread.id) },
    {
      label: 'Move to Unassigned',
      disabled: !thread.projectId,
      onSelect: () => emit('move', thread.id, null),
    },
    ...props.projects.map((project) => ({
      label: `Move to ${project.name}`,
      disabled: thread.projectId === project.id,
      onSelect: () => emit('move', thread.id, project.id),
    })),
    { label: 'Delete chat', onSelect: () => emit('remove', thread.id) },
  ];
}
</script>

<template>
  <aside
    class="flex h-full min-h-0 shrink-0 flex-col border-r border-line bg-chat-sidebar"
    :class="docked ? 'w-64' : 'w-full'"
    aria-label="Saved chats"
  >
    <div class="flex items-center gap-2 px-3 py-3">
      <span class="min-w-0 flex-1 text-[13px] font-semibold">Chats</span>
      <UiButton
        square
        size="small"
        variant="ghost"
        :disabled="busy"
        title="New unassigned chat"
        aria-label="New unassigned chat"
        @click="emit('create', null)"
        ><Plus class="size-4"
      /></UiButton>
      <UiButton
        square
        size="small"
        variant="ghost"
        title="Hide saved chats"
        aria-label="Hide saved chats"
        @click="emit('close')"
        ><X class="size-4"
      /></UiButton>
    </div>
    <div class="px-3 pb-3">
      <UiSearchInput v-model="query" label="Search saved chats" placeholder="Search chats" />
    </div>
    <UiScrollArea
      as="nav"
      class="flex-1"
      content-class="flex flex-col gap-1 px-2 pb-3"
      label="Chat projects"
    >
      <UiDisclosure
        v-for="group in visibleGroups"
        :key="group.id"
        :open="Boolean(query) || expanded.has(group.id)"
        :label="group.name"
        :count="group.threads.length"
        @update:open="setExpanded(group.id, $event)"
      >
        <template #actions>
          <UiButton
            square
            size="small"
            variant="ghost"
            :disabled="busy"
            :title="`New chat in ${group.name}`"
            :aria-label="`New chat in ${group.name}`"
            @click="emit('create', group.projectId)"
            ><Plus class="size-3.5"
          /></UiButton>
        </template>
        <div class="flex flex-col gap-0.5 pb-2 pl-5">
          <div
            v-for="thread in group.threads"
            :key="thread.id"
            class="group/chat flex min-w-0 items-center rounded-md hover:bg-hover"
          >
            <button
              type="button"
              :class="
                cn(
                  'flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-xs',
                  activeId === thread.id ? 'bg-selected text-ink' : 'text-secondary',
                )
              "
              :aria-current="activeId === thread.id ? 'page' : undefined"
              :title="thread.title"
              :disabled="busy"
              @click="emit('select', thread.id)"
            >
              <MessageSquare class="size-3.5 shrink-0 text-muted" /><span
                class="min-w-0 flex-1 truncate"
                >{{ thread.title }}</span
              >
            </button>
            <UDropdownMenu
              :items="menuItems(thread)"
              :ui="{ content: 'min-w-48 bg-overlay', item: 'min-h-9 text-[13px]' }"
            >
              <UiButton
                square
                size="small"
                variant="ghost"
                :disabled="busy || thread.status === 'running'"
                :title="`Move ${thread.title}`"
                :aria-label="`Move ${thread.title}`"
                class="opacity-0 group-hover/chat:opacity-100 group-focus-within/chat:opacity-100 max-xl:opacity-100"
                ><Ellipsis class="size-3.5"
              /></UiButton>
            </UDropdownMenu>
          </div>
        </div>
      </UiDisclosure>
      <p v-if="!visibleGroups.length" class="px-3 py-2 text-xs text-muted">No matching chats.</p>
      <UiLoadMore v-if="hasMore" :remaining="1" @load="emit('more')" />
    </UiScrollArea>
  </aside>
</template>
