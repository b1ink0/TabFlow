import { describe, it, expect } from 'vitest';
import { matchesSiteList, suspensionBlock } from '../src/shared/suspension-policy';
import { DEFAULTS, newRecord } from '../src/shared/model';
describe('site suspension policy', () => {
  it('matches exact domains and subdomains, never suffix lookalikes', () => {
    expect(matchesSiteList('https://mail.example.com/x', 'example.com')).toBe(true);
    expect(matchesSiteList('https://example.com.attacker.test/x', 'example.com')).toBe(false);
    expect(matchesSiteList('https://notexample.com/', 'example.com')).toBe(false);
    expect(matchesSiteList('https://example.com/', '# comment\n*.example.com')).toBe(true);
  });
  it('matches URL prefixes within the correct origin, ignores malformed rules and does not execute regex', () => {
    expect(matchesSiteList('https://example.com/editor/one', 'https://example.com/editor/')).toBe(
      true,
    );
    expect(matchesSiteList('https://example.com/other', 'https://example.com/editor/')).toBe(false);
    expect(
      matchesSiteList('https://example.com.attacker.test/editor/', 'https://example.com/editor/'),
    ).toBe(false);
    expect(matchesSiteList('https://example.com/', '/.*/\nhttps://[')).toBe(false);
  });
  it('honors manual protection and never treats a new foreign placeholder as an awake page', () => {
    const record = newRecord('https://example.com/');
    const tab = {
      active: true,
      pinned: true,
      audible: true,
      groupId: 10,
      status: 'complete',
    } as chrome.tabs.Tab;
    expect(suspensionBlock(record, tab, DEFAULTS, true)).toBe('Active tab');
    expect(suspensionBlock({ ...record, foreignSuspended: true }, tab, DEFAULTS, false)).toBeNull();
    expect(
      suspensionBlock({ ...record, locked: true, foreignSuspended: true }, tab, DEFAULTS, false),
    ).toBe('Protected tab');
    expect(
      suspensionBlock(
        record,
        { ...tab, active: false, pinned: false, audible: false },
        { ...DEFAULTS, protectGrouped: true },
        false,
      ),
    ).toBe('Native group protected');
  });
});
