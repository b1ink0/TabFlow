// A workflow holds one slot through all its model and tool rounds. Web Locks
// coordinate dashboard and side-panel views; local slots cover test environments.
const laneName = 'tabflow-model-inference';
const localSlots: { tail: Promise<void>; pending: number }[] = [];

function slotCount(value: number | undefined): number {
  return Number.isInteger(value) && value! >= 1 && value! <= 8 ? value! : 1;
}

function waitForSlot(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', aborted);
      resolve();
    }, 80);
    function aborted() {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    }
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) aborted();
  });
}

export async function runModelInference<T>(
  task: () => Promise<T>,
  options: { signal?: AbortSignal; onWaiting?: () => void; parallelism?: number } = {},
): Promise<T> {
  options.signal?.throwIfAborted();
  const capacity = slotCount(options.parallelism);
  let acquired = false;
  const waiting = options.onWaiting
    ? setTimeout(() => {
        if (!acquired) options.onWaiting?.();
      }, 150)
    : undefined;
  try {
    if (navigator.locks) {
      while (true) {
        options.signal?.throwIfAborted();
        for (let index = 0; index < capacity; index++) {
          const result = await navigator.locks.request(
            `${laneName}:${index}`,
            { ifAvailable: true },
            async (lock) => {
              if (!lock) return { acquired: false as const };
              acquired = true;
              options.signal?.throwIfAborted();
              return { acquired: true as const, value: await task() };
            },
          );
          if (result.acquired) return result.value;
        }
        await waitForSlot(options.signal);
      }
    }
    while (localSlots.length < capacity) localSlots.push({ tail: Promise.resolve(), pending: 0 });
    const slot = localSlots
      .slice(0, capacity)
      .reduce((best, current) => (current.pending < best.pending ? current : best));
    slot.pending++;
    const previous = slot.tail;
    let release!: () => void;
    slot.tail = new Promise<void>((resolve) => (release = resolve));
    try {
      await previous;
      acquired = true;
      options.signal?.throwIfAborted();
      return await task();
    } finally {
      slot.pending--;
      release();
    }
  } finally {
    clearTimeout(waiting);
  }
}
