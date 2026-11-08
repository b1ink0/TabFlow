import {
  PhTabs as PanelsTopLeft,
  PhChatCircle as MessageSquare,
  PhCalendarDots as CalendarDays,
  PhFolders as FolderKanban,
  PhMagnifyingGlassPlus as ScanSearch,
  PhClockCounterClockwise as History,
  PhGearSix as Settings2,
  PhArrowsClockwise as RefreshCw,
} from '@phosphor-icons/vue';
export const navigation = [
  { id: 'assistant', label: 'Assistant', icon: MessageSquare },
  { id: 'today', label: 'Today', icon: CalendarDays },
  { id: 'tabs', label: 'Windows & tabs', icon: PanelsTopLeft },
  { id: 'projects', label: 'Projects', icon: FolderKanban },
  { id: 'review', label: 'Review & inspect', icon: ScanSearch },
  { id: 'timeline', label: 'Snapshots & history', icon: History },
  { id: 'settings', label: 'Settings', icon: Settings2 },
  { id: 'update', label: 'Update TabFlow', icon: RefreshCw },
];
