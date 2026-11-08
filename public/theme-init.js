// Run before application modules: appearance never waits for Vue or background RPC.
(() => {
  const apply = () => {
    let theme = 'dark';
    try {
      if (globalThis.localStorage.getItem('tabflow-theme') === 'light') theme = 'light';
    } catch {
      // Keep the existing dark default if browser storage is unavailable.
    }
    globalThis.document.documentElement.classList.toggle('dark', theme === 'dark');
    globalThis.document.documentElement.classList.toggle('light', theme === 'light');
  };
  apply();
  globalThis.addEventListener('storage', (event) => {
    if (event.key === 'tabflow-theme' || event.key === null) apply();
  });
})();
