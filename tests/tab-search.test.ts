import { describe, it, expect, vi } from 'vitest';
import { searchTabIds } from '../src/shared/tab-search';
import { newRecord } from '../src/shared/model';
describe('bounded local tab search', () => {
  it('yields between chunks, preserves duplicate occurrences and includes semantic labels', async () => {
    const records = Array.from({ length: 111 }, (_, index) => ({
      ...newRecord('https://example.test/shared', `tab-${index}`),
      title: `Reference ${index}`,
      live: true,
    }));
    const yieldTask = vi.fn(async () => undefined);
    const all = await searchTabIds(records, {}, 'shared', { yieldTask });
    expect(all.size).toBe(111);
    expect(yieldTask).toHaveBeenCalledTimes(3);
    const semantic = await searchTabIds(
      records,
      {
        memberships: [
          {
            recordId: 'tab-55',
            projectId: 'project',
            categoryId: null,
            source: 'owner',
            updatedAt: 1,
          },
        ],
        projects: [
          {
            id: 'project',
            name: 'Hardware Workshop',
            purpose: '',
            updatedAt: 1,
            revision: 1,
            maintainReviewQueue: false,
          },
        ],
      },
      'workshop',
    );
    expect([...semantic]).toEqual(['tab-55']);
  });
  it('cancels an obsolete search before it can return remaining results', async () => {
    const records = Array.from({ length: 111 }, (_, index) => ({
      ...newRecord('https://example.test/', `tab-${index}`),
      live: true,
    }));
    const controller = new AbortController();
    const yieldTask = vi.fn(async () => {
      controller.abort();
    });
    await expect(
      searchTabIds(records, {}, 'example', { signal: controller.signal, yieldTask }),
    ).rejects.toThrow();
    expect(yieldTask).toHaveBeenCalledTimes(1);
  });
});
