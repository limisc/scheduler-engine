interface TickerOptions {
  interval?: number;
  onTick: () => Promise<void>;
  onError?: (error: unknown) => void;
}

export function createTicker({
  interval = 5_000,
  onTick,
  onError,
}: TickerOptions) {
  let running = false;
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> | null = null;

  async function tick(): Promise<void> {
    if (!running) return;

    const start = Date.now();

    try {
      inFlight = onTick();
      await inFlight;
    } catch (error) {
      onError?.(error);
    } finally {
      inFlight = null;
    }

    if (running) {
      const delay = Math.max(0, start + interval - Date.now());
      timer = setTimeout(tick, delay);
    }
  }

  return {
    start(): void {
      if (running) return;
      running = true;
      void tick();
    },

    async stop(): Promise<void> {
      running = false;

      if (timer) {
        clearTimeout(timer);
        timer = null;
      }

      if (inFlight) {
        await inFlight.catch(() => {});
      }
    },
  };
}

export type Ticker = ReturnType<typeof createTicker>;
