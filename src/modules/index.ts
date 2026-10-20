import type { SQL } from 'bun';
import type { Client } from './client/provider';
import type { Flow, FlowDefinition } from './flow/flow.types';
import { createCrypto, type Crypto } from '../utils/crypto';
import { createAccountService } from './account/account.service';
import { createFlowRegistry, type FlowRegistry } from './flow/flow.registry';
import { createFlowService } from './flow/flow.service';
import { createRunService } from './run/run.service';
import {
  createClientRegistry,
  type Providers,
} from './client/core/client.registry';
import { FatalError } from '../utils/error';

export interface ModulesConfig {
  sql: SQL;
  /** base64 encoded 32 byte key for account credentials */
  encryptionKey: string;
  defs: FlowDefinition<any, any, any>[];
  providers: Providers;
}

function createServices(sql: SQL, crypto: Crypto, fr: FlowRegistry) {
  const accounts = createAccountService(sql, crypto);
  const flows = createFlowService(sql, fr, accounts);
  const runs = createRunService(sql);

  return {
    accounts,
    flows,
    runs,
  };
}

export function createModules({
  sql,
  encryptionKey,
  defs,
  providers,
}: ModulesConfig) {
  const crypto = createCrypto(encryptionKey);

  const fr = createFlowRegistry();
  fr.registerAll(defs);

  const services = createServices(sql, crypto, fr);

  const cr = createClientRegistry({
    providers,
    updateCredential: services.accounts.updateCredential,
  });

  /** Clients for each slot of the flow, validated against its definition. */
  async function getClients(flow: Flow): Promise<Record<string, Client>> {
    const { slots } = fr.get(flow.def);
    if (!slots || Object.keys(slots).length === 0) return {};

    const bound = await services.accounts.getIndexByFlowId(flow.id);
    const clients: Record<string, Client> = {};

    for (const [key, slot] of Object.entries(slots)) {
      const account = bound[key];

      if (!account) {
        throw new FatalError(
          `Flow "${flow.name}" has no account bound to slot "${key}"`,
        );
      }

      if (account.provider !== slot.provider) {
        throw new FatalError(
          `Slot "${key}" of "${flow.name}" requires provider "${slot.provider}", got "${account.provider}"`,
        );
      }

      clients[key] = cr.get(account.provider, account);
    }

    return clients;
  }

  return {
    ...services,
    cr,
    fr,
    sql,
    getClients,

    async tx<T>(fn: (s: Services) => Promise<T>): Promise<T> {
      return sql.begin((tx) => fn(createServices(tx, crypto, fr)));
    },
  };
}

export type Services = ReturnType<typeof createServices>;
export type Modules = ReturnType<typeof createModules>;
