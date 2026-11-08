import { describe, expect, it } from 'vitest';
import { boundOrchestratorRequest } from '../src/ai/request-context';
import { splitOversizedBatch } from '../src/ai/context';
import { newRecord } from '../src/shared/model';

const call = (id: string) => ({
  role: 'assistant',
  content: null,
  tool_calls: [{ id, type: 'function', function: { name: 'list_tabs', arguments: '{}' } }],
  reasoning_content: 'Retained reasoning state',
});
describe('bounded tool continuation context', () => {
  it('retains the owner request and latest complete tool round while compacting old rounds', () => {
    const request = {
      tools: [{ name: 'list_tabs' }],
      messages: [
        { role: 'system', content: 'Original safety instructions' },
        { role: 'user', content: 'Old chat '.repeat(400) },
        { role: 'assistant', content: 'Old answer '.repeat(400) },
        { role: 'user', content: 'Organize all tabs without applying changes' },
        call('old'),
        {
          role: 'tool',
          tool_call_id: 'old',
          content: JSON.stringify({
            total: 600,
            proposalId: 'saved-draft',
            tabs: 'Evidence '.repeat(2000),
          }),
        },
        call('latest'),
        { role: 'tool', tool_call_id: 'latest', content: '{"total":600,"nextOffset":30}' },
      ],
    };
    const result = boundOrchestratorRequest(request, 3000);
    expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThanOrEqual(3000);
    expect(result.messages[0]?.role).toBe('system');
    expect(result.messages[0]?.content).toContain('saved-draft');
    expect(result.messages.find((entry) => entry.role === 'user')?.content).toBe(
      'Organize all tabs without applying changes',
    );
    expect(
      result.messages.filter((entry) => entry.role === 'tool').map((entry) => entry.tool_call_id),
    ).toEqual(['latest']);
    expect(result.messages.find((entry) => entry.tool_calls)?.tool_calls?.[0]?.id).toBe('latest');
    expect(result.messages.find((entry) => entry.tool_calls)?.reasoning_content).toBe(
      'Retained reasoning state',
    );
    // Parsing creates a separate request; saved full history is not rewritten.
    expect(request.messages).toHaveLength(8);
  });
  it('retains all tool results paired with a multi-call latest round', () => {
    const latest = call('a');
    latest.tool_calls.push({ ...latest.tool_calls[0]!, id: 'b' });
    const request = {
      messages: [
        { role: 'system', content: 'Rules' },
        { role: 'user', content: 'Old '.repeat(2000) },
        { role: 'user', content: 'Current' },
        latest,
        { role: 'tool', tool_call_id: 'a', content: '{}' },
        { role: 'tool', tool_call_id: 'b', content: '{}' },
      ],
    };
    expect(boundOrchestratorRequest(request, 1500).messages.slice(-3)).toEqual(
      request.messages.slice(-3),
    );
  });
  it('fails locally rather than deleting the current owner request or latest evidence', () => {
    expect(() =>
      boundOrchestratorRequest(
        {
          messages: [
            { role: 'system', content: 'Rules' },
            { role: 'user', content: 'Owner instruction '.repeat(1000) },
            call('latest'),
            { role: 'tool', tool_call_id: 'latest', content: '{}' },
          ],
        },
        1000,
      ),
    ).toThrow(/exceed the estimated context budget/);
  });
  it('splits oversized occurrences in original order', () => {
    const records = [0, 1, 2, 3].map((index) => newRecord(`https://example.com/${index}`));
    const queue: (typeof records)[] = [];
    expect(splitOversizedBatch(queue, records, { content: 'x'.repeat(500) }, 100, 'test')).toBe(
      true,
    );
    expect(queue.flat().map((record) => record.url)).toEqual(records.map((record) => record.url));
  });
});
