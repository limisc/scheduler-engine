import type { TokenPayload } from './client.types';

export function createTokenCache() {
  const cache = new Map<string, TokenPayload>();
  const inFlight = new Map<string, Promise<string>>();

  async function getToken(
    key: string,
    refresh: () => Promise<TokenPayload>,
    force = false,
  ): Promise<string> {
    if (force) {
      evict(key);
    } else {
      const cached = cache.get(key);
      if (cached && Date.now() < cached.expiresAt - 60_000) {
        return cached.token;
      }
    }

    let promise = inFlight.get(key);
    if (promise) return promise;

    promise = (async () => {
      try {
        const payload = await refresh();
        setToken(key, payload);
        return payload.token;
      } finally {
        inFlight.delete(key);
      }
    })();

    inFlight.set(key, promise);
    return promise;
  }

  function setToken(key: string, payload: TokenPayload): void {
    cache.set(key, payload);
  }

  function evict(key: string): void {
    inFlight.delete(key);
    cache.delete(key);
  }

  return {
    getToken,
    setToken,
    evict,
  };
}

export type TokenCache = ReturnType<typeof createTokenCache>;
