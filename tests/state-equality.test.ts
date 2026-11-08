import { describe, expect, it } from 'vitest';
import { newRecord } from '../src/shared/model';
import { reuseUnchangedRecords } from '../src/shared/state-equality';

describe('worker refresh identities', () => {
  it('reuses unchanged duplicate occurrences without merging their identities', () => {
    const records = [newRecord('https://example.test'), newRecord('https://example.test')];
    const incoming = structuredClone(records);
    const reused = reuseUnchangedRecords(records, incoming);
    expect(reused[0]).toBe(records[0]);
    expect(reused[1]).toBe(records[1]);
    expect(reused[0]?.id).not.toBe(reused[1]?.id);
  });
  it('keeps fresh navigation, protection, owner notes and nested cache/tag changes', () => {
    const record = newRecord('https://example.test');
    for (const patch of [
      { navigationVersion: 1 },
      { locked: true },
      { note: 'Owner correction' },
      { tags: ['changed'] },
    ]) {
      const updated = { ...structuredClone(record), ...patch };
      expect(reuseUnchangedRecords([record], [updated])[0]).toBe(updated);
    }
    const cached = {
      ...record,
      content: {
        url: record.url,
        title: 'Original',
        description: '',
        headings: ['Original'],
        text: 'Cached text',
        scroll: 0,
        capturedAt: 1,
        dirty: false,
        playing: false,
      },
    };
    const updated = structuredClone(cached);
    updated.content.headings = ['Changed'];
    expect(reuseUnchangedRecords([cached], [updated])[0]).toBe(updated);
  });
});
