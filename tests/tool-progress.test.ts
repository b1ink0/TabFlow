import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineTool } from '../src/ai/tools/definition';
import { ToolProgress } from '../src/ai/tools/progress';
import { discoverableTools } from '../src/ai/tools/catalog';

describe('unchanged read progress', () => {
  const parameters = z.object({ query: z.string(), offset: z.number().default(0) });
  it('warns on repeated successful reads and recognizes reordered JSON', async () => {
    const progress = new ToolProgress();
    let count = 0;
    const tool = progress.wrap(
      defineTool({
        name: 'read_resources',
        description: 'Read resources',
        effect: 'read',
        parameters,
        function: () => (++count % 2 ? '{"total":0,"items":[]}' : '{"items":[],"total":0}'),
      }),
    );
    await tool.execute({ query: 'absent', offset: 0 });
    expect(progress.warning).toBe(false);
    await tool.execute({ offset: 0, query: 'absent' });
    expect(progress.warning).toBe(true);
    expect(progress.stalled).toBe(false);
    await tool.execute({ query: 'absent', offset: 0 });
    expect(progress.stalled).toBe(true);
    expect(progress.guidance()).toContain('read_attached_context');
    expect(progress.fallback()).toContain('no matches in the data it searched');
  });

  it('allows different pages, changed results and a fresh read after a change', async () => {
    const progress = new ToolProgress();
    let revision = 1;
    const read = progress.wrap(
      defineTool({
        name: 'read_resources',
        description: 'Read',
        effect: 'read',
        parameters,
        function: () => JSON.stringify({ revision }),
      }),
    );
    for (const offset of [0, 1, 2, 3]) await read.execute({ query: '', offset });
    expect(progress.warning).toBe(false);
    await read.execute({ query: '', offset: 0 });
    expect(progress.warning).toBe(true);
    revision++;
    await read.execute({ query: '', offset: 0 });
    expect(progress.warning).toBe(false);
    await read.execute({ query: '', offset: 0 });
    expect(progress.warning).toBe(true);
    const change = progress.wrap(
      defineTool({
        name: 'edit_resource',
        description: 'Change',
        parameters: z.object({}),
        function: () => 'saved',
      }),
    );
    await change.execute({});
    await read.execute({ query: '', offset: 0 });
    expect(progress.warning).toBe(false);
  });

  it('cannot bypass read tracking through the tool-discovery proxy', async () => {
    const progress = new ToolProgress();
    const read = progress.wrap(
      defineTool({
        name: 'read_resources',
        description: 'Read resources',
        effect: 'read',
        parameters,
        function: () => '{"total":0}',
      }),
    );
    const [search, dispatch] = discoverableTools([read]).map((tool) => progress.wrap(tool));
    await search!.execute({ query: 'read_resources', offset: 0 });
    for (let i = 0; i < 3; i++)
      await dispatch!.execute({
        name: 'read_resources',
        argumentsJson: '{"query":"absent","offset":0}',
      });
    expect(progress.stalled).toBe(true);
  });

  it('leaves error limits and real tool execution with the validated executor', async () => {
    const progress = new ToolProgress();
    const callback = vi.fn(() => {
      throw new Error('invalid target');
    });
    const tool = progress.wrap(
      defineTool({
        name: 'read_resources',
        description: 'Read',
        effect: 'read',
        parameters,
        function: callback,
      }),
    );
    await tool.execute({ query: '', offset: 0 });
    await tool.execute({ query: '', offset: 0 });
    await expect(tool.execute({ query: '', offset: 0 })).rejects.toThrow('three consecutive');
    expect(progress.stalled).toBe(false);
    expect(callback).toHaveBeenCalledTimes(3);
  });
});
