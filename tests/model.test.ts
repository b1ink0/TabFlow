import { describe, it, expect } from 'vitest';
import {
  newRecord,
  validatePlan,
  validateSettings,
  DEFAULTS,
  importSnapshot,
} from '../src/shared/model';
import { cleanPageLink, makeSuspendedURL, suspendedInfo, pageURL } from '../src/shared/urls';
describe('suspended-page recovery', () => {
  it('removes attribution without dropping functional search parameters or fragments', () => {
    const clean = new URL(
      cleanPageLink(
        'https://example.test/search?q=one%26two&page=2&utm_source=mail&UTM_campaign=test&fbclid=tracking#result',
      ),
    );
    expect(clean.searchParams.get('q')).toBe('one&two');
    expect(clean.searchParams.get('page')).toBe('2');
    expect(clean.hash).toBe('#result');
    expect([...clean.searchParams.keys()]).toEqual(['q', 'page']);
    expect(cleanPageLink('chrome://settings/')).toBe('chrome://settings/');
  });
  it('does not confuse a URL query parameter in the raw legacy tail with the wrapper recovery address', () => {
    const original =
      'https://example.com/search?q=one+two&url=https://redirect.test/x&id=another&title=Wrong&pos=999#anchor';
    expect(
      suspendedInfo(`chrome-extension://old/suspended.html#ttl=Saved&uri=${original}`)?.url,
    ).toBe(original);
    expect(
      suspendedInfo(`chrome-extension://old/suspended.html#ttl=Saved&pos=42&uri=${original}`),
    ).toMatchObject({ title: 'Saved', scroll: 42, recordId: null });
  });
  it('round trips nested query strings, fragments, Unicode titles and scroll positions', () => {
    const record = {
      ...newRecord('https://example.com/search?a=1&b=%26#part'),
      title: '日本語 · A & B',
      scroll: 512,
    };
    const wrapper = makeSuspendedURL('chrome-extension://ours', record);
    const decoded = suspendedInfo(wrapper, 'chrome-extension://ours');
    expect(decoded).toMatchObject({
      url: record.url,
      title: record.title,
      scroll: 512,
      recordId: record.id,
      owned: true,
    });
  });
  it('imports legacy raw uri tails without truncating query parameters', () => {
    expect(
      suspendedInfo(
        'chrome-extension://legacy/suspended.html#ttl=Example&pos=8&uri=https://example.com/?a=1&b=2#section',
      )?.url,
    ).toBe('https://example.com/?a=1&b=2#section');
  });
  it('imports percent-encoded legacy URLs', () => {
    expect(
      suspendedInfo(
        'chrome-extension://legacy/suspended.html#ttl=Example&uri=https%3A%2F%2Fexample.com%2F%3Fa%3D1%26b%3D2',
      )?.url,
    ).toBe('https://example.com/?a=1&b=2');
  });
  it('rejects scripts, internal URLs, and unrelated extension pages', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,hello', 'chrome://settings'])
      expect(pageURL(url)).toBeNull();
    expect(suspendedInfo('chrome-extension://x/options.html#uri=https://example.com')).toBeNull();
    expect(suspendedInfo('chrome-extension://x/suspended.html#uri=javascript:alert(1)')).toBeNull();
  });
  it('does not claim another extension placeholder as its own', () =>
    expect(
      suspendedInfo(
        'chrome-extension://other/suspended.html#uri=https://example.com',
        'chrome-extension://ours',
      )?.owned,
    ).toBe(false));
});
describe('plans and settings', () => {
  it('rejects a window move disguised as a native group assignment', () => {
    const record = { ...newRecord('https://example.com/'), live: true, windowId: 1 };
    expect(() =>
      validatePlan(
        {
          summary: 'Proposed grouping',
          actions: [
            {
              type: 'move',
              recordIds: [record.id],
              windowId: 1,
              name: 'Project group',
              color: 'blue',
            },
          ],
        },
        [record],
        [{ id: 1, focused: true, projectId: null }],
      ),
    ).toThrow(/move action.*does not join a group/);
    expect(
      validatePlan(
        {
          summary: 'Proposed grouping',
          actions: [
            {
              type: 'group',
              recordIds: [record.id],
              windowId: 1,
              name: 'Project group',
              color: 'blue',
            },
          ],
        },
        [record],
        [{ id: 1, focused: true, projectId: null }],
      ).actions[0]?.type,
    ).toBe('group');
  });
  const r = { ...newRecord('https://example.com'), live: true };
  const windows = [{ id: 1, focused: true, projectId: null }];
  it('forbids close/delete actions', () =>
    expect(() =>
      validatePlan({ actions: [{ type: 'close', recordIds: [r.id] }] }, [r], windows),
    ).toThrow());
  it('blocks protected tabs', () =>
    expect(() =>
      validatePlan(
        { actions: [{ type: 'suspend', recordIds: [r.id] }] },
        [{ ...r, locked: true }],
        windows,
      ),
    ).toThrow(/Protected/));
  it('blocks unknown tabs and windows', () => {
    expect(() =>
      validatePlan({ actions: [{ type: 'wake', recordIds: ['unknown'] }] }, [r], windows),
    ).toThrow(/no longer open/);
    expect(() =>
      validatePlan({ actions: [{ type: 'move', recordIds: [r.id], windowId: 2 }] }, [r], windows),
    ).toThrow(/window/);
  });
  it('accepts an in-window reorder and rejects invalid reorder requests', () => {
    const first = { ...r, id: 'first', windowId: 1, index: 0 };
    const second = { ...r, id: 'second', windowId: 1, index: 1 };
    expect(
      validatePlan(
        { actions: [{ type: 'reorder', recordIds: ['first'], index: 1 }] },
        [first, second],
        windows,
      ).actions[0],
    ).toMatchObject({ type: 'reorder', recordIds: ['first'], index: 1 });
    expect(() =>
      validatePlan(
        { actions: [{ type: 'reorder', recordIds: ['first'], index: 2 }] },
        [first, second],
        windows,
      ),
    ).toThrow(/outside this window/);
    expect(() =>
      validatePlan(
        { actions: [{ type: 'reorder', recordIds: ['first', 'second'], index: 1 }] },
        [first, second],
        windows,
      ),
    ).toThrow(/one tab/);
  });
  it('blocks pinned tab grouping', () =>
    expect(() =>
      validatePlan(
        { actions: [{ type: 'group', recordIds: [r.id], windowId: 1, name: 'Docs' }] },
        [{ ...r, pinned: true }],
        windows,
      ),
    ).toThrow(/Pinned/));
  it('rejects conflicting group assignments', () =>
    expect(() =>
      validatePlan(
        {
          actions: ['A', 'B'].map((name) => ({
            type: 'group',
            recordIds: [r.id],
            windowId: 1,
            name,
          })),
        },
        [r],
        windows,
      ),
    ).toThrow(/multiple/));
  it('filters invented search match ids', () =>
    expect(validatePlan({ actions: [], matchIds: [r.id, 'other'] }, [r], windows).matchIds).toEqual(
      [r.id],
    ));
  it('validates server protocols, embedded credentials and bounds', () => {
    expect(validateSettings({}).autoSuspend).toBe(false);
    expect(validateSettings({}).maxConcurrentInference).toBe(1);
    expect(
      validateSettings({ ...DEFAULTS, maxConcurrentInference: 3 }).maxConcurrentInference,
    ).toBe(3);
    expect(() => validateSettings({ ...DEFAULTS, maxConcurrentInference: 9 })).toThrow();
    expect(validateSettings({}).googleCalendarClientId).toBe('');
    expect(validateSettings({}).decisionProvider).toBe('jev');
    expect(validateSettings({}).useDedicatedDecisionModel).toBe(false);
    expect(
      validateSettings({ ...DEFAULTS, googleCalendarClientId: 'public.apps.googleusercontent.com' })
        .googleCalendarClientId,
    ).toBe('public.apps.googleusercontent.com');
    expect(validateSettings({ aiProvider: 'bud' }).useDedicatedDecisionModel).toBe(true);
    expect(
      validateSettings({
        aiProvider: 'lmstudio',
        aiModel: 'large-chat',
        decisionProvider: 'bud',
        decisionModel: 'laya',
        useDedicatedDecisionModel: true,
      }),
    ).toMatchObject({
      aiModel: 'large-chat',
      decisionModel: 'laya',
      useDedicatedDecisionModel: true,
    });
    for (const aiBase of ['file:///tmp/model', 'https://user:pass@example.com'])
      expect(() => validateSettings({ ...DEFAULTS, aiBase })).toThrow();
    expect(() => validateSettings({ ...DEFAULTS, aiBatchSize: 500 })).toThrow();
  });
  it('rejects corrupt or unsupported backups', () => {
    expect(() => importSnapshot({ format: 'other' })).toThrow();
    expect(() =>
      importSnapshot({ format: 'tabloom', schema: 7, exportedAt: 1, projects: [], snapshots: [] }),
    ).toThrow();
    expect(
      importSnapshot({
        format: 'tabloom',
        schema: 1,
        exportedAt: 1,
        projects: [{ id: 'old', name: 'Old project', updatedAt: 1 }],
        snapshots: [],
      }).projects[0],
    ).toMatchObject({ purpose: '', revision: 1, maintainReviewQueue: false });
  });
  it('imports the configured retained history without the obsolete 500-snapshot cap', () => {
    const snapshots = Array.from({ length: 501 }, (_, index) => ({
      id: `snapshot-${index}`,
      createdAt: index,
      label: 'Saved arrangement',
      automatic: true,
      windows: [],
    }));
    expect(
      importSnapshot({ format: 'tabloom', schema: 6, exportedAt: 1, projects: [], snapshots })
        .snapshots,
    ).toHaveLength(501);
    expect(validateSettings({ snapshotRetention: 5000 }).snapshotRetention).toBe(5000);
  });
});
