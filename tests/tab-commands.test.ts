import { beforeEach, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { newRecord } from '../src/shared/model';
import { useTabCommands } from '../src/features/tabs/tab-commands';
const fixture = vi.hoisted(() => ({
  store: {
    records: [] as Array<{ id: string; parentRecordId?: string | null }>,
    semanticTabOrder: {} as Record<string, string[]>,
    notify: vi.fn(),
    refresh: vi.fn(async () => undefined),
    run: async (task: () => Promise<void>) => task(),
  },
  rpc: vi.fn(),
}));
vi.mock('../src/stores/workspace', () => ({ useWorkspace: () => fixture.store }));
vi.mock('../src/stores/dialog', () => ({ useDialog: () => ({ ask: vi.fn() }) }));
vi.mock('../src/shared/rpc', () => ({ rpc: fixture.rpc }));
beforeEach(() => {
  vi.clearAllMocks();
  fixture.store.records = [
    { id: 'source' },
    { id: 'child', parentRecordId: 'source' },
    { id: 'created' },
    { id: 'other' },
  ];
  fixture.store.semanticTabOrder = { category: ['source', 'child', 'other'], unrelated: ['other'] };
  fixture.rpc.mockResolvedValue({
    summary: 'New tab below',
    tabCommand: { created: { recordId: 'created' } },
  });
});
it('places the new sibling beside its source branch in custom orders after command completion', async () => {
  const source = { ...newRecord('https://example.test/source', 'source'), live: true };
  const commands = useTabCommands(ref(source));
  await commands.value[0]!.onSelect?.(new Event('select'));
  expect(fixture.rpc).toHaveBeenCalledWith('tabCommand', {
    id: 'source',
    command: 'new',
    expected: { url: source.url, navigationVersion: 0 },
  });
  expect(fixture.store.semanticTabOrder.category).toEqual(['source', 'child', 'created', 'other']);
  expect(fixture.store.semanticTabOrder.unrelated).toEqual(['other']);
});
