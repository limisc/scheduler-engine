import type { Account } from '../../account/account.types';
import type { AuthHandler, ClientFactory } from './client.types';
import type { Client, Clients, Provider } from '../provider';
import { entries } from '../../../utils/common';
import { FatalError } from '../../../utils/error';
import { createAuthStore } from './auth.store';
import { createTokenCache } from './token-cache';

export type Providers = {
  [P in Provider]?: ClientFactory<P>;
};

interface ClientRegistryOptions {
  providers?: Providers;
  updateCredential: (accountId: string, credential: string) => Promise<void>;
}

export function createClientRegistry({
  providers,
  updateCredential,
}: ClientRegistryOptions) {
  const authStore = createAuthStore();

  const factories = new Map<Provider, ClientFactory['createClient']>();
  const auths = new Map<string, AuthHandler>();
  const clients = new Map<string, { updatedAt: number; client: Client }>();
  const tokens = createTokenCache();

  function register<P extends Provider>(
    provider: P,
    { createClient, createAuth }: ClientFactory<P>,
  ): void {
    factories.set(provider, createClient as ClientFactory['createClient']);

    if (createAuth) {
      auths.set(provider, createAuth(authStore));
    }
  }

  function has(provider: string): boolean {
    return factories.has(provider as Provider);
  }

  function get<P extends Provider>(provider: P, account: Account): Clients[P] {
    const { id: accountId } = account;
    const updatedAt = account.updated_at.getTime();

    const cached = clients.get(accountId);
    if (cached && cached.updatedAt >= updatedAt) {
      return cached.client as Clients[P];
    }

    const factory = factories.get(provider);
    if (!factory) {
      throw new FatalError(`Provider "${provider}" is not registered`);
    }

    if (cached) tokens.evict(accountId);

    const client = factory(account, {
      getToken: (refresh, force) => tokens.getToken(accountId, refresh, force),
      updateCredential: (credential) => updateCredential(accountId, credential),
    });

    clients.set(accountId, { updatedAt, client });
    return client as Clients[P];
  }

  function getAuthHandler(provider: string): AuthHandler | undefined {
    return auths.get(provider);
  }

  function evict(accountId: string): void {
    tokens.evict(accountId);
    clients.delete(accountId);
  }

  if (providers) {
    for (const [provider, factory] of entries(providers)) {
      register(provider, factory as ClientFactory<typeof provider>);
    }
  }

  return {
    register,
    has,
    get,
    getAuthHandler,
    evict,
    setToken: tokens.setToken,
  };
}

export type ClientRegistry = ReturnType<typeof createClientRegistry>;
