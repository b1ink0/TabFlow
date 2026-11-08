<script setup lang="ts">
import UiReorderList from '../../ui/UiReorderList.vue';
import type { ReorderEvent } from '../../shared/reorder';
import {
  PhPlus as Plus,
  PhSidebarSimple as PanelLeftClose,
  PhSidebar as PanelLeftOpen,
} from '@phosphor-icons/vue';
import { navigation } from './navigation';
import UiButton from '../../ui/UiButton.vue';
import UiThemeToggle from '../../ui/UiThemeToggle.vue';
import UiScrollArea from '../../ui/UiScrollArea.vue';
import { useWorkspace } from '../../stores/workspace';
import { projectColorStyle } from '../../shared/category-colors';
import { cn } from '../../shared/cn';
import { useReorderGesture, droppedOrder } from './useReorderGesture';
defineProps<{ collapsed?: boolean }>();
const emit = defineEmits<{ createProject: []; navigate: []; toggle: [] }>();
const store = useWorkspace();
const reorderGesture = useReorderGesture();
function projectsDropped(event: ReorderEvent) {
  reorderGesture.finish();
  const ids = droppedOrder(
    event,
    store.orderedProjects.map((project) => project.id),
    '[data-project-order-id]',
    'projectOrderId',
  );
  store.reorderProjects(ids);
}
function navigate(id: string) {
  if (id === 'projects') store.projectSection = 'tabs';
  store.show(id);
  emit('navigate');
}
</script>
<template>
  <aside
    :class="
      cn(
        'flex h-full shrink-0 flex-col gap-6 bg-sidebar px-3 py-4 transition-[width] duration-180',
        collapsed ? 'w-16' : 'w-56',
      )
    "
  >
    <div :class="cn('flex h-9 items-center gap-2 px-2', collapsed && 'justify-center px-0')">
      <img src="/icons/mark.svg" alt="" class="size-6 shrink-0" /><span
        v-if="!collapsed"
        class="flex-1 text-base font-semibold tracking-tight"
        >TabFlow</span
      >
    </div>
    <UiScrollArea
      class="min-h-0 flex-1"
      content-class="flex flex-col gap-6"
      label="Application navigation"
    >
      <nav
        :class="cn('flex flex-col gap-1', collapsed && 'items-center')"
        aria-label="Main navigation"
      >
        <UiButton
          v-for="item in navigation"
          :key="item.id"
          variant="ghost"
          :square="collapsed"
          :size="collapsed ? 'small' : 'default'"
          :title="collapsed ? item.label : undefined"
          :aria-label="collapsed ? item.label : undefined"
          :aria-current="store.view === item.id ? 'page' : undefined"
          :class="
            cn(
              'gap-3 text-[13px]',
              collapsed ? 'justify-center px-0' : 'w-full justify-start px-2.5',
              store.view === item.id ? 'bg-raised text-ink' : 'text-muted',
            )
          "
          @click="navigate(item.id)"
        >
          <component :is="item.icon" class="size-4 shrink-0" /><span
            v-if="!collapsed"
            class="flex min-w-0 flex-col items-start text-left"
          >
            <span>{{ item.label }}</span>
            <span
              v-if="item.id === 'update' && store.app?.update?.interrupted"
              class="text-xs text-muted"
              >Needs attention</span
            >
          </span>
        </UiButton>
      </nav>
      <div class="flex flex-col gap-2">
        <div
          :class="
            cn('flex items-center gap-2', collapsed ? 'justify-center' : 'justify-between px-2')
          "
        >
          <span v-if="!collapsed" class="text-xs font-medium text-muted">Projects</span
          ><UiButton
            square
            size="small"
            variant="ghost"
            title="Create project"
            aria-label="Create project"
            @click="emit('createProject')"
            ><Plus class="size-3.5"
          /></UiButton>
        </div>
        <UiReorderList
          draggable="[data-project-order-id]"
          handle="[data-project-order-id]"
          :class="cn('flex flex-col gap-0.5', collapsed && 'items-center')"
          @start="reorderGesture.start"
          @click.capture="reorderGesture.click"
          @end="projectsDropped"
          @cancel="reorderGesture.finish"
        >
          <UiButton
            v-for="project in store.orderedProjects"
            :key="project.id"
            :data-project-order-id="project.id"
            variant="ghost"
            size="small"
            :square="collapsed"
            :title="project.name"
            :aria-current="
              store.view === 'projects' && store.activeProject?.id === project.id
                ? 'page'
                : undefined
            "
            :class="
              cn(
                'min-w-0 gap-2',
                collapsed ? 'justify-center px-0' : 'w-full justify-start px-2.5',
                store.activeProject?.id === project.id &&
                  store.view === 'projects' &&
                  'bg-selected text-ink',
              )
            "
            @click="
              store.projectFilter = project.id;
              navigate('projects');
            "
          >
            <span
              class="flex size-5 shrink-0 items-center justify-center rounded bg-raised text-xs"
              :style="{ color: projectColorStyle(project) }"
              >{{ project.name.slice(0, 1).toUpperCase() }}</span
            ><span v-if="!collapsed" data-reorder-label class="min-w-0 flex-1 truncate text-left">{{
              project.name
            }}</span
            ><span v-if="!collapsed" class="text-xs tabular-nums text-muted">{{
              store.records.filter((record) => record.projectId === project.id).length
            }}</span>
          </UiButton>
          <p
            v-if="!collapsed && !store.app?.projects.length"
            class="px-2.5 py-2 text-xs text-muted"
          >
            No projects yet
          </p>
        </UiReorderList>
      </div>
    </UiScrollArea>
    <div
      :class="
        cn('flex gap-2', collapsed ? 'flex-col items-center' : 'items-center justify-between px-2')
      "
    >
      <UiThemeToggle />
      <UiButton
        square
        variant="ghost"
        size="small"
        :title="collapsed ? 'Expand navigation' : 'Collapse navigation'"
        :aria-label="collapsed ? 'Expand navigation' : 'Collapse navigation'"
        @click="emit('toggle')"
        ><PanelLeftOpen v-if="collapsed" class="size-4" /><PanelLeftClose v-else class="size-4"
      /></UiButton>
    </div>
  </aside>
</template>
