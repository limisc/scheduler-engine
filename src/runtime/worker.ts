import type { Signal } from './signal';

export interface WorkerAdapter<T> {
  fetch: () => Promise<T | null>;
  process: (item: T) => Promise<unknown>;
  onSuccess: (item: T, output: unknown) => Promise<void>;
  onFailure: (item: T, error: unknown) => Promise<void>;
}

interface WorkerOptions<T> {
  concurrency?: number;
  signal: Signal;
  adapter: WorkerAdapter<T>;
  onError?: (error: unknown) => void;
}

export function createWorker<T>({
  concurrency = 3,
  signal,
  adapter,
  onError,
}: WorkerOptions<T>) {
  let running = false;
  const threads = new Set<Promise<void>>();

  async function thread(): Promise<void> {
    while (running) {
      try {
        const item = await adapter.fetch();

        if (item) {
          let output: unknown;

          try {
            output = await adapter.process(item);
          } catch (error) {
            await adapter.onFailure(item, error);
            continue;
          }

          await adapter.onSuccess(item, output);
        } else {
          await signal.sleep();
        }
      } catch (error) {
        onError?.(error);
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
  }

  function start(): void {
    if (running) return;
    running = true;

    for (let i = 0; i < concurrency; i++) {
      const p = thread().finally(() => threads.delete(p));
      threads.add(p);
    }
  }

  async function stop(): Promise<void> {
    if (!running) return;
    running = false;

    signal.broadcast();

    await Promise.allSettled(threads);
    threads.clear();
  }

  return { start, stop };
}

export type Worker = ReturnType<typeof createWorker>;
