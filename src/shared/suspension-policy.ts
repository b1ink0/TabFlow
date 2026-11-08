import type { Settings, TabRecord } from './types';

/** Domain rules include subdomains; URL rules match an origin and path prefix. No regex execution. */
export function matchesSiteList(url: string, rules: string): boolean {
  const page = new URL(url);
  return rules.split(/[\n,]+/).some((line) => {
    const rule = line.trim();
    if (!rule || rule.startsWith('#')) return false;
    if (/^https?:\/\//i.test(rule)) {
      try {
        const target = new URL(rule);
        return (
          page.origin === target.origin &&
          page.pathname.startsWith(target.pathname) &&
          (!target.search || page.search === target.search)
        );
      } catch {
        return false;
      }
    }
    const domain = rule.toLowerCase().replace(/^\*\./, '').replace(/\/$/, '');
    return (
      page.hostname.toLowerCase() === domain || page.hostname.toLowerCase().endsWith(`.${domain}`)
    );
  });
}

export function suspensionBlock(
  record: TabRecord,
  tab: chrome.tabs.Tab,
  config: Settings,
  automatic: boolean,
): string | null {
  if (record.locked) return 'Protected tab';
  if (record.foreignSuspended) return null;
  if (automatic && tab.active) return 'Active tab';
  if (tab.status === 'loading') return 'Page is loading';
  if (config.protectPinned && tab.pinned) return 'Pinned tab';
  if (config.protectAudio && tab.audible) return 'Playing audio';
  if (config.protectGrouped && tab.groupId !== -1) return 'Native group protected';
  if (matchesSiteList(record.url, config.neverSuspendSites)) return 'Site excluded from suspension';
  return null;
}
