import type { TabRecord } from '../types';
import { validFavicon } from './favicon';
const short = (v: unknown, n: number) => String(v ?? '').slice(0, n);
/** Remove known attribution parameters while preserving functional queries and fragments. */
export function cleanPageLink(value: string): string {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return value;
    for (const key of [...url.searchParams.keys()])
      if (/^utm_/i.test(key) || /^(fbclid|gclid|dclid|msclkid|mc_cid|mc_eid)$/i.test(key))
        url.searchParams.delete(key);
    return url.href;
  } catch {
    return value;
  }
}
export function pageURL(value: unknown): string | null {
  try {
    const u = new URL(String(value));
    return ['http:', 'https:'].includes(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}
/** Native blank destinations are tracked only after an explicit app creation. */
export function isNativeNewTabURL(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    ['about:blank', 'chrome://newtab/', 'brave://newtab/', 'edge://newtab/'].includes(value)
  );
}
export function suspendedInfo(value: string | undefined, ownOrigin = '') {
  try {
    const u = new URL(value || '');
    if (u.protocol !== 'chrome-extension:' || !/\/suspend(?:ed)?\.html$/.test(u.pathname))
      return null;
    const m = u.hash.match(/(?:#|&)uri=(.*)$/s);
    const p = new URLSearchParams(m ? u.hash.slice(0, m.index).replace(/^#/, '') : u.hash.slice(1));
    let original = m ? m[1] || null : p.get('url');
    if (m) {
      if (original && /^https?%3a/i.test(original)) {
        try {
          original = decodeURIComponent(original);
        } catch {
          /* Retain recovery value. */
        }
      }
    }
    const url = pageURL(original);
    if (!url) return null;
    return {
      url,
      title: short(p.get('title') || p.get('ttl') || url, 1000),
      scroll: Math.max(0, Math.min(10_000_000, Number(p.get('pos')) || 0)),
      recordId: p.get('id') || null,
      favicon: validFavicon(p.get('icon')) ? p.get('icon')! : undefined,
      owned: Boolean(ownOrigin && `${u.protocol}//${u.host}` === ownOrigin),
      wrapper: value,
    };
  } catch {
    return null;
  }
}
export function makeSuspendedURL(
  origin: string,
  record: Pick<TabRecord, 'id' | 'url' | 'title' | 'scroll' | 'suspendedFavicon'>,
) {
  if (!pageURL(record.url)) throw new Error('Only HTTP(S) pages can be suspended.');
  return `${origin}/suspended.html#${new URLSearchParams({ id: record.id, url: record.url, title: short(record.title, 1000), pos: String(record.scroll || 0), ...(validFavicon(record.suspendedFavicon) ? { icon: record.suspendedFavicon } : {}) })}`;
}
