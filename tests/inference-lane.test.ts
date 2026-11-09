import { afterEach, describe, expect, it, vi } from 'vitest';
import { runModelInference } from '../src/ai/inference/inference-lane';

afterEach(() => vi.unstubAllGlobals());

describe('model inference lane', () => {
  it('runs competing workflows sequentially and releases the lane after failure', async () => {
    vi.stubGlobal('navigator', { locks: undefined });
    let active = 0;
    let peak = 0;
    const run = (delay: number, fail = false) =>
      runModelInference(async () => {
        active++;
        peak = Math.max(active, peak);
        await new Promise((resolve) => setTimeout(resolve, delay));
        active--;
        if (fail) throw new Error('model failure');
      });
    const results = await Promise.allSettled([run(10, true), run(1), run(1)]);
    expect(peak).toBe(1);
    expect(results.map((result) => result.status)).toEqual(['rejected', 'fulfilled', 'fulfilled']);
  });

  it('does not start a cancelled request waiting behind another workflow', async () => {
    vi.stubGlobal('navigator', { locks: undefined });
    let release!: () => void;
    let started!: () => void;
    const firstStarted = new Promise<void>((resolve) => (started = resolve));
    const first = runModelInference(() => {
      started();
      return new Promise<void>((resolve) => (release = resolve));
    });
    await firstStarted;
    const controller = new AbortController();
    const secondTask = vi.fn(async () => undefined);
    const second = runModelInference(secondTask, { signal: controller.signal });
    controller.abort();
    release();
    await first;
    await expect(second).rejects.toMatchObject({ name: 'AbortError' });
    expect(secondTask).not.toHaveBeenCalled();
  });

  it('allows two model workflows but queues a third when configured for two', async () => {
    vi.stubGlobal('navigator', { locks: undefined });
    let active = 0;
    let peak = 0;
    const releases: (() => void)[] = [];
    const run = () =>
      runModelInference(
        async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise<void>((resolve) => releases.push(resolve));
          active--;
        },
        { parallelism: 2 },
      );
    const pending = [run(), run(), run()];
    await vi.waitFor(() => expect(releases.length).toBe(2));
    expect(peak).toBe(2);
    releases[0]?.();
    await vi.waitFor(() => expect(releases.length).toBe(3));
    releases[1]?.();
    releases[2]?.();
    await Promise.all(pending);
    expect(peak).toBe(2);
  });

  it('shares bounded slots through the browser Web Locks API', async () => {
    const held = new Set<string>();
    vi.stubGlobal('navigator', {
      locks: {
        request: async <T>(
          name: string,
          _options: { ifAvailable: boolean },
          callback: (lock: { name: string } | null) => Promise<T>,
        ) => {
          if (held.has(name)) return callback(null);
          held.add(name);
          try {
            return await callback({ name });
          } finally {
            held.delete(name);
          }
        },
      },
    });
    let active = 0;
    let peak = 0;
    const releases: (() => void)[] = [];
    const run = () =>
      runModelInference(
        async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise<void>((resolve) => releases.push(resolve));
          active--;
        },
        { parallelism: 2 },
      );
    const pending = [run(), run(), run()];
    await vi.waitFor(() => expect(releases.length).toBe(2));
    expect(peak).toBe(2);
    releases[0]?.();
    await vi.waitFor(() => expect(releases.length).toBe(3));
    releases[1]?.();
    releases[2]?.();
    await Promise.all(pending);
    expect(peak).toBe(2);
  });
});
