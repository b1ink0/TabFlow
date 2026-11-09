import { describe, expect, it } from 'vitest';
import { newRecord } from '../src/shared/model';
import {
  orderTabTreeDrop,
  tabTreeDrop,
  tabTreeSectionDrop,
} from '../src/shared/tabs/tab-tree-drop';
import type { Membership } from '../src/shared/types';

function fixture() {
  const records = ['a', 'b', 'c', 'd'].map((id) => ({
    ...newRecord(`https://example.test/${id}`, id),
    live: true,
    parentRecordId: id === 'b' ? 'a' : null,
  }));
  const memberships: Membership[] = records.map((record) => ({
    recordId: record.id,
    projectId: record.id === 'd' ? 'other' : 'one',
    categoryId: record.id === 'd' ? 'target-category' : 'source-category',
    source: 'owner',
    updatedAt: 1,
  }));
  return { records, memberships };
}
describe('branch drop effects', () => {
  it('moves a whole subtree into an empty category and rejects invalid destinations', () => {
    const app = {
      ...fixture(),
      projects: [
        {
          id: 'other',
          name: 'Other',
          purpose: '',
          revision: 1,
          updatedAt: 1,
          maintainReviewQueue: false,
        },
      ],
      categories: [
        {
          id: 'empty',
          projectId: 'other',
          name: 'Empty',
          description: '',
          order: 0,
          revision: 1,
          updatedAt: 1,
        },
      ],
    };
    const plan = tabTreeSectionDrop(app, 'a', 'other', 'empty');
    expect(plan.movedIds).toEqual(['a', 'b']);
    expect(plan.edits.filter((edit) => edit.kind === 'membership')).toHaveLength(2);
    expect(() => tabTreeSectionDrop(app, 'a', 'missing', 'empty')).toThrow('existing');
  });
  it('moves an entire branch into another project/category in one validated edit draft', () => {
    const app = fixture();
    const plan = tabTreeDrop(app, 'a', 'd', 'inside');
    expect(plan.movedIds).toEqual(['a', 'b']);
    expect(plan.edits).toEqual([
      { kind: 'tab_parent', recordId: 'a', parentRecordId: 'd' },
      { kind: 'membership', recordId: 'a', projectId: 'other', categoryId: 'target-category' },
      { kind: 'membership', recordId: 'b', projectId: 'other', categoryId: 'target-category' },
    ]);
    expect(app.records[0]?.parentRecordId).toBeNull();
  });
  it('rejects cycles, protected descendants and moves deeper than five levels', () => {
    const app = fixture();
    expect(() => tabTreeDrop(app, 'a', 'b', 'inside')).toThrow('itself');
    app.records[1]!.locked = true;
    expect(() => tabTreeDrop(app, 'a', 'c', 'inside')).toThrow('protection');
    app.records[1]!.locked = false;
    app.records.push(
      ...['e', 'f', 'g'].map((id, index) => ({
        ...newRecord(`https://example.test/${id}`, id),
        live: true,
        parentRecordId: ['d', 'e', 'f'][index]!,
      })),
    );
    expect(() => tabTreeDrop(app, 'a', 'g', 'inside')).toThrow('five');
  });
  it('detaches a child to root and reorders a whole branch without splitting its children', () => {
    const app = fixture();
    expect(tabTreeDrop(app, 'b', 'c', 'root').parentRecordId).toBeNull();
    expect(orderTabTreeDrop(app.records, ['a', 'b'], 'c', 'after')).toEqual(['c', 'a', 'b', 'd']);
    expect(orderTabTreeDrop(app.records, ['d'], 'a', 'after')).toEqual(['a', 'b', 'd', 'c']);
  });
});
