import { describe, expect, it } from 'vitest';
import { tabDragIndex } from '../src/shared/tabs/tab-tree-drag';
import { newRecord } from '../src/shared/model';

describe('cached drag-session target checks', () => {
  it('rejects cycles and excessive depth without rereading the application graph per hover', () => {
    const records = ['a', 'b', 'c', 'd', 'e', 'f'].map((id, i) => ({
      ...newRecord(`https://example.test/${id}`, id),
      live: true,
      parentRecordId: i > 1 ? ['a', 'b', 'c', 'd', 'e'][i - 1]! : null,
    }));
    const app = { records, projects: [], categories: [] };
    const index = tabDragIndex(app, 'b');
    Object.defineProperty(app, 'records', {
      get() {
        throw new Error('Hot path reread the whole graph');
      },
    });
    expect(index.validTarget('c', 'inside')).toBe(false);
    expect(index.validTarget('a', 'inside')).toBe(false);
    expect(index.validTarget('a', 'before')).toBe(true);
    for (let repeat = 0; repeat < 1000; repeat++) expect(index.validTarget('a', 'root')).toBe(true);
  });
  it('blocks a branch containing a protected descendant', () => {
    const records = ['a', 'b', 'c'].map((id) => ({
      ...newRecord(`https://example.test/${id}`, id),
      live: true,
      parentRecordId: id === 'b' ? 'a' : null,
      locked: id === 'b',
    }));
    expect(
      tabDragIndex({ records, projects: [], categories: [] }, 'a').validTarget('c', 'inside'),
    ).toBe(false);
  });
});
