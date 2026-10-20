export function createSignal(timeout = 60_000) {
  const listeners = new Set<() => void>();
  const scheduled = new Set<NodeJS.Timeout>();

  function broadcast(): void {
    for (const fn of listeners) {
      fn();
    }

    listeners.clear();
  }

  async function sleep(): Promise<void> {
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined;

      const wake = () => {
        listeners.delete(wake);
        if (timer !== undefined) clearTimeout(timer);
        resolve();
      };

      listeners.add(wake);
      timer = setTimeout(wake, timeout);
      timer.unref();
    });
  }

  function wakeAfter(delay: number): void {
    const timer = setTimeout(() => {
      scheduled.delete(timer);
      broadcast();
    }, delay);

    timer.unref();
    scheduled.add(timer);
  }

  function destroy(): void {
    for (const t of scheduled) {
      clearTimeout(t);
    }

    scheduled.clear();
    broadcast();
  }

  return {
    broadcast,
    sleep,
    wakeAfter,
    destroy,
  };
}

export type Signal = ReturnType<typeof createSignal>;
