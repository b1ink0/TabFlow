export function parseTagSelection(value: string | undefined): string[] {
  const parsed: unknown = JSON.parse(value || '[]');
  if (
    !Array.isArray(parsed) ||
    !parsed.every((tag) => typeof tag === 'string' && tag.trim().length > 0 && tag.length <= 80)
  )
    throw new Error('Use nonempty tags, each at most 80 characters.');
  return [
    ...new Set(
      parsed.filter((tag): tag is string => typeof tag === 'string').map((tag) => tag.trim()),
    ),
  ];
}
import type { AppState } from '../types';

/** The same saved-label inventory backs attachment selection and assistant discovery. */
export function workspaceTags(app: Pick<AppState, 'tagVocabulary' | 'records'>) {
  const counts = new Map<string, { name: string; count: number; savedCount: number }>();
  for (const name of app.tagVocabulary || []) counts.set(name, { name, count: 0, savedCount: 0 });
  for (const record of app.records)
    for (const name of new Set(record.tags)) {
      const tag = counts.get(name) || { name, count: 0, savedCount: 0 };
      tag.savedCount++;
      if (record.live) tag.count++;
      counts.set(name, tag);
    }
  return [...counts.values()].sort((a, b) => a.name.localeCompare(b.name));
}
