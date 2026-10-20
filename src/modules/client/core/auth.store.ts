export function createAuthStore(ttl = 10 * 60_000) {
  const pending = new Map<string, { name: string; timer: NodeJS.Timeout }>();

  function create(name: string): string {
    const state = crypto.randomUUID();
    const timer = setTimeout(() => {
      clear(state);
    }, ttl);

    pending.set(state, { name, timer });
    timer.unref();

    return state;
  }

  function take(state: string): string | null {
    const entry = pending.get(state);
    if (!entry) return null;

    clearTimeout(entry.timer);
    pending.delete(state);

    return entry.name;
  }

  function clear(state: string): void {
    const entry = pending.get(state);
    if (!entry) return;

    clearTimeout(entry.timer);
    pending.delete(state);
  }

  return {
    create,
    take,
    clear,
  };
}

export type AuthStore = ReturnType<typeof createAuthStore>;
