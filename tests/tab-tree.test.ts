import { describe, expect, it } from 'vitest';
import {
  automaticTabParent,
  tabAncestors,
  tabTreeRows,
  validateTabTree,
} from '../src/shared/tabs/tab-tree';
import { newRecord } from '../src/shared/model';

describe('persistent tab branches', () => {
  const chain = Array.from({ length: 5 }, (_, index) => ({
    ...newRecord(`https://example.test/${index}`, `tab-${index}`),
    parentRecordId: index ? `tab-${index - 1}` : null,
  }));
  it('allows five levels, rejects cycles and subtree moves beyond the depth limit', () => {
    expect(() => validateTabTree(chain)).not.toThrow();
    expect(tabAncestors('tab-4', chain)).toEqual(['tab-3', 'tab-2', 'tab-1', 'tab-0']);
    expect(() => validateTabTree([...chain, { id: 'too-deep', parentRecordId: 'tab-4' }])).toThrow(
      'five',
    );
    expect(() =>
      validateTabTree(
        chain.map((record) =>
          record.id === 'tab-0' ? { ...record, parentRecordId: 'tab-3' } : record,
        ),
      ),
    ).toThrow('cycle');
    expect(automaticTabParent('tab-4', chain)).toBe('tab-3');
  });
  it('collapses descendants, promotes out-of-scope children and expands matching results', () => {
    expect(tabTreeRows(chain, ['tab-1']).map((row) => row.record.id)).toEqual(['tab-0', 'tab-1']);
    expect(tabTreeRows(chain.slice(2), []).map((row) => row.depth)).toEqual([0, 1, 2]);
    expect(tabTreeRows(chain, ['tab-1'], true)).toHaveLength(5);
    expect(
      tabTreeRows(
        chain.filter((record) => record.id === 'tab-4'),
        [],
      )[0]?.depth,
    ).toBe(0);
    expect(chain[4]?.parentRecordId).toBe('tab-3');
  });
});
