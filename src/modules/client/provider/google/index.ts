import type { ClientFactory } from '../../core/client.types';
import type { GoogleConfig } from './google.types';
import { createGoogleAuth } from './auth';
import { createGoogleClient } from './client';

export function createGoogle(config: GoogleConfig): ClientFactory<'google'> {
  return {
    createClient(account, ctx) {
      return createGoogleClient(account, ctx, config);
    },

    createAuth(store) {
      return createGoogleAuth(store, config);
    },
  };
}

export type { GoogleConfig } from './google.types';
export type { GoogleClient } from './client';
export type { GmailThread } from './gmail';
