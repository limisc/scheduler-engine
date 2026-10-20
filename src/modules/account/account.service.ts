import type { SQL } from 'bun';
import type { Crypto } from '../../utils/crypto';
import type { Account, AccountPublic } from './account.types';
import { createAccountStore } from './account.store';
import { NotFoundError } from '../../utils/error';

export function createAccountService(sql: SQL, crypto: Crypto) {
  const store = createAccountStore(sql, crypto);

  async function updateCredential(id: string, credential: string) {
    await store.update(id, { credential });
  }

  async function getIndexByFlowId(
    flowId: string,
  ): Promise<Record<string, Account>> {
    const items = await store.listByFlowId(flowId);
    return Object.fromEntries(items.map((i) => [i.slot, i.account]));
  }

  async function require(provider: string, name: string): Promise<Account> {
    const account = await store.getByName(provider, name);

    if (!account) {
      throw new NotFoundError(`Account "${provider}/${name}" not found`);
    }

    return account;
  }

  async function listPublic(): Promise<AccountPublic[]> {
    const accounts = await store.list();
    return accounts.map(toPublic);
  }

  return {
    ...store,
    updateCredential,
    getIndexByFlowId,
    require,
    listPublic,
  };
}

export function toPublic({
  credential,
  config,
  ...account
}: Account): AccountPublic {
  return { ...account, config_keys: Object.keys(config) };
}

export type AccountService = ReturnType<typeof createAccountService>;
