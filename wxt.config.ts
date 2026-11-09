import { defineConfig } from 'wxt';
import ui from '@nuxt/ui/vite';

import { applicationIcons } from './src/config/icons';

export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-vue'],
  vite: () => ({
    resolve: { dedupe: ['vue', 'reka-ui'] },
    plugins: [
      ui({
        router: false,
        colorMode: false,
        autoImport: false,
        components: false,
        dts: false,
        experimental: { componentDetection: true },
        ui: {
          colors: { primary: 'neutral', neutral: 'neutral' },
          icons: applicationIcons,
        },
        icon: { mode: 'svg', clientBundle: { icons: Object.values(applicationIcons), scan: true } },
      }),
    ],
  }),
  manifest: ({ command }) => ({
    ...(process.env.TABFLOW_EXTENSION_KEY?.trim()
      ? { key: process.env.TABFLOW_EXTENSION_KEY.trim() }
      : {}),
    name: 'TabFlow',
    description:
      'Visible tabs, project windows, local AI organization, lightweight suspension, and recoverable snapshots.',
    minimum_chrome_version: '121',
    permissions: [
      'tabs',
      'tabGroups',
      'storage',
      'alarms',
      'scripting',
      'idle',
      'unlimitedStorage',
      'favicon',
      'sidePanel',
      'contextMenus',
    ],
    optional_permissions: ['downloads', 'identity'],
    optional_host_permissions: ['http://*/*', 'https://*/*', '<all_urls>'],
    action: {
      default_title: 'Open TabFlow',
      default_icon: {
        16: 'icons/16.png',
        32: 'icons/32.png',
        48: 'icons/48.png',
        128: 'icons/128.png',
      },
    },
    side_panel: { default_path: 'sidepanel.html' },
    options_page: 'dashboard.html#settings',
    commands: {
      'open-dashboard': {
        suggested_key: { default: 'Ctrl+Shift+Y', mac: 'Command+Shift+Y' },
        description: 'Open TabFlow',
      },
    },
    icons: { 16: 'icons/16.png', 32: 'icons/32.png', 48: 'icons/48.png', 128: 'icons/128.png' },
    content_security_policy: {
      extension_pages: `script-src 'self'; object-src 'none'; base-uri 'none'; connect-src 'self' http: https:${command === 'serve' ? ' ws://localhost:3000' : ''}; img-src 'self' data:; style-src 'self' 'unsafe-inline';`,
    },
  }),
});
