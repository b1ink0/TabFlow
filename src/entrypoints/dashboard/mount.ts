import { createApp } from 'vue';
import { createPinia } from 'pinia';
import ui from '@nuxt/ui/vue-plugin';
import App from './App.vue';
import '../../assets/main.css';

export function mountWorkspace(surface: 'dashboard' | 'sidepanel') {
  createApp(App, { surface }).provide('weight', 'bold').use(createPinia()).use(ui).mount('#app');
}
