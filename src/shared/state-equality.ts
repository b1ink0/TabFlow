import type { AppState, TabRecord } from './types';

function shareValue(current: unknown, incoming: unknown): unknown {
  if (Object.is(current, incoming)) return current;
  if (Array.isArray(incoming)) {
    const previous = Array.isArray(current) ? current : [];
    const byId = new Map(
      previous.flatMap((item: unknown) =>
        item && typeof item === 'object' && 'id' in item ? [[item.id, item]] : [],
      ),
    );
    const next = incoming.map((item: unknown, index: number) =>
      shareValue(
        item && typeof item === 'object' && 'id' in item ? byId.get(item.id) : previous[index],
        item,
      ),
    );
    return next.length === previous.length && next.every((item, index) => item === previous[index])
      ? previous
      : next;
  }
  if (incoming && typeof incoming === 'object') {
    const previous =
      current && typeof current === 'object' && !Array.isArray(current)
        ? Object.fromEntries(Object.entries(current))
        : {};
    const next = Object.fromEntries(
      Object.entries(incoming).map(([key, value]) => [key, shareValue(previous[key], value)]),
    );
    return current !== null &&
      typeof current === 'object' &&
      !Array.isArray(current) &&
      Object.keys(previous).length === Object.keys(next).length &&
      Object.entries(next).every(
        ([key, value]) => Object.hasOwn(previous, key) && value === previous[key],
      )
      ? current
      : next;
  }
  return incoming;
}

/** Internal coordinator snapshots retain identities for every unchanged subtree, not only rows. */
export function reuseWorkspaceState(current: AppState | undefined, incoming: AppState): AppState {
  return shareValue(current, incoming) as AppState;
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left))
    return (
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameValue(value, right[index]))
    );
  if (
    !left ||
    !right ||
    typeof left !== 'object' ||
    typeof right !== 'object' ||
    Array.isArray(right)
  )
    return false;
  const entries = Object.entries(left);
  const other = new Map<string, unknown>(Object.entries(right));
  return (
    entries.length === other.size &&
    entries.every(([key, value]) => other.has(key) && sameValue(value, other.get(key)))
  );
}

/** Preserve unchanged row identities across serialized worker refreshes. */
export function reuseUnchangedRecords(current: TabRecord[], incoming: TabRecord[]): TabRecord[] {
  const byId = new Map(current.map((record) => [record.id, record]));
  return incoming.map((record) => {
    const previous = byId.get(record.id);
    return previous && sameValue(previous, record) ? previous : record;
  });
}
