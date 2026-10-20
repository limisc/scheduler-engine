import type { Account } from '../../account/account.types';
import type { Clients, Provider } from '../provider';
import type { AuthStore } from './auth.store';

export interface TokenPayload {
  token: string;
  expiresAt: number;
}

export interface AuthHandler {
  getAuthUrl: (name: string) => string;
  handleCallback: (params: URLSearchParams) => Promise<AuthResult>;
}

export interface AuthResult {
  name: string;
  credential: string;
  config?: Record<string, unknown>;
  payload?: TokenPayload;
}

export interface ClientContext {
  getToken: (
    refresh: () => Promise<TokenPayload>,
    force?: boolean,
  ) => Promise<string>;

  updateCredential: (credential: string) => Promise<void>;
}

export interface ClientFactory<P extends Provider = Provider> {
  createClient: (account: Account, ctx: ClientContext) => Clients[P];
  createAuth?: (store: AuthStore) => AuthHandler;
}
