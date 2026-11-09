import { afterEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref } from 'vue';
import { useTabSearch } from '../src/features/tabs/useTabSearch';
import { newRecord } from '../src/shared/model';

const search = vi.hoisted(() => vi.fn());
vi.mock('../src/shared/tabs/tab-search', () => ({ searchTabIds: search }));
afterEach(() => vi.useRealTimers());

describe('search refresh lifecycle', () => {
  it('ignores telemetry refreshes and retains results during quiet reindexing', async () => {
    vi.useFakeTimers();
    const scope = effectScope();
    const query = ref('example');
    const record = { ...newRecord('https://example.test'), live: true };
    const records = ref([record]);
    search.mockResolvedValue(new Set([record.id]));
    const result = scope.run(() =>
      useTabSearch(
        query,
        () => records.value,
        () => undefined,
      ),
    )!;
    await nextTick();
    const original = result.matches.value;
    expect(result.searching.value).toBe(false);
    const calls = search.mock.calls.length;
    records.value = [{ ...record, focusedMs: 500, lastAccessed: 20 }];
    await nextTick();
    expect(search).toHaveBeenCalledTimes(calls);
    expect(result.matches.value).toBe(original);

    let complete!: (ids: Set<string>) => void;
    search.mockImplementationOnce(
      () => new Promise<Set<string>>((resolve) => (complete = resolve)),
    );
    records.value = [{ ...record, note: 'New searchable evidence' }];
    await nextTick();
    expect(result.searching.value).toBe(false);
    expect(result.matches.value).toBe(original);
    complete(new Set([record.id]));
    await nextTick();
    expect(result.matches.value).toBe(original);

    search.mockResolvedValueOnce(new Set());
    records.value = [{ ...record, title: 'Different', note: 'Changed again' }];
    await nextTick();
    expect(result.matches.value?.size).toBe(0);
    expect(result.matches.value).not.toBe(original);
    scope.stop();
  });

  it('does not let a stale query overwrite a newer result', async () => {
    vi.useFakeTimers();
    const scope = effectScope();
    const query = ref('old');
    let oldResult!: (ids: Set<string>) => void;
    search.mockImplementationOnce(
      () => new Promise<Set<string>>((resolve) => (oldResult = resolve)),
    );
    const result = scope.run(() =>
      useTabSearch(
        query,
        () => [],
        () => undefined,
      ),
    )!;
    query.value = 'new';
    search.mockResolvedValueOnce(new Set(['new']));
    await nextTick();
    await vi.advanceTimersByTimeAsync(160);
    expect([...result.matches.value!]).toEqual(['new']);
    oldResult(new Set(['old']));
    await nextTick();
    expect([...result.matches.value!]).toEqual(['new']);
    query.value = '';
    await nextTick();
    expect(result.matches.value).toBeNull();
    expect(result.searching.value).toBe(false);
    scope.stop();
  });
});
