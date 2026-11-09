import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createToolExecutor } from '../src/ai/tools/definition';

describe('provider-independent tool execution', () => {
  const parameters = z.object({ recordId: z.string().min(1) });

  it('rejects malformed bridge input before invoking a domain callback', async () => {
    const callback = vi.fn();
    const execute = createToolExecutor({
      name: 'read_tab',
      description: 'Read a tab',
      parameters,
      function: callback,
    });
    const result = JSON.parse((await execute({ recordId: null })) as string);
    expect(result).toMatchObject({ ok: false, applied: false, automaticRetry: false });
    expect(callback).not.toHaveBeenCalled();
    await execute({ recordId: 'occurrence-id' });
    expect(callback).toHaveBeenCalledWith({ recordId: 'occurrence-id' });
  });

  it('keeps failure counters local to a run and resets after success', async () => {
    let fail = true;
    const definition = {
      name: 'read_tab',
      description: 'Read a tab',
      parameters,
      function: () => {
        if (fail) throw new Error('stale target');
        return 'ready';
      },
    };
    const first = createToolExecutor(definition);
    const second = createToolExecutor(definition);
    await first({ recordId: 'id' });
    await first({ recordId: 'id' });
    await expect(second({ recordId: 'id' })).resolves.toContain('stale target');
    fail = false;
    await expect(first({ recordId: 'id' })).resolves.toBe('ready');
    fail = true;
    await first({ recordId: 'id' });
    await first({ recordId: 'id' });
    await expect(first({ recordId: 'id' })).rejects.toThrow('three consecutive');
  });

  it('propagates cancellation and fatal failures without converting them to results', async () => {
    const abort = new DOMException('Cancelled', 'AbortError');
    const execute = createToolExecutor({
      name: 'inspect',
      description: 'Inspect',
      parameters,
      function: () => {
        throw abort;
      },
    });
    await expect(execute({ recordId: 'id' })).rejects.toBe(abort);
    const fatal = new Error('checkpoint write failed');
    const persist = createToolExecutor({
      name: 'save',
      description: 'Save',
      parameters,
      fatalOnFailure: true,
      function: () => {
        throw fatal;
      },
    });
    await expect(persist({ recordId: 'id' })).rejects.toBe(fatal);
  });
});
