<script setup lang="ts">
import { PhMoon as Moon, PhSun as Sun } from '@phosphor-icons/vue';
import UiButton from './UiButton.vue';
import { useTheme } from './theme';
const { preference, toggle } = useTheme();
</script>
<template>
  <UiButton
    square
    variant="ghost"
    size="small"
    :aria-label="preference === 'light' ? 'Switch to dark mode' : 'Switch to light mode'"
    :title="preference === 'light' ? 'Switch to dark mode' : 'Switch to light mode'"
    @click="toggle"
  >
    <Moon v-if="preference === 'light'" class="size-4" /><Sun v-else class="size-4" />
  </UiButton>
</template>
