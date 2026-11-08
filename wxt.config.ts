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
    // Public development identity; retain it so placeholder URLs survive folder moves.
    key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0EqD4CkRUer/Fw27VBEki6Kxqq1OsudV5bFxp7HocxP79Bx1T7CoC0f7sF7/6u8gMq04ENEr66q/P3efVZxAO1tR3asEsSlZMyDXSh6iUvBafGyXNvi2MbXDRt75fTNvFHyph5nG8v7UMIEwTB9zhWgm480ieH6pay9lwxxGoL8qZrQAzO5Xyzi9V20a+RgwtSfg1rB9iTdYDKcyGa/KHmMGtlHWNzFkwiFpJ3L3IEQJ/eKcDNRIpQP32vjMEDVALaNX61s87egnGrP7ECdm6gAku3AOvUOnjmfIFfXCj8IU4QJYiqFsNxgd6jTwTDM5r7WdMxcUeABc2cRg0hDAlwIDAQAB',
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
