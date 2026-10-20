import type { GoogleClient } from './google/client';

/**
 * Provider name → client type. Augment it to add custom providers:
 *
 * declare module '@limisc/scheduler-engine' {
 *   interface Clients { acme: AcmeClient }
 * }
 */
export interface Clients {
  google: GoogleClient;
}

export type Provider = keyof Clients;

export type Client = Clients[Provider];

export { createGoogle } from './google';
