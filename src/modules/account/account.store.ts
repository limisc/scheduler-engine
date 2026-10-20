import type { SQL } from 'bun';
import type { Crypto } from '../../utils/crypto';
import type { Provider } from '../client/provider';
import type {
  Account,
  AccountRow,
  UpdateAccountInput,
  UpsertAccountInput,
} from './account.types';
import { expect, isEmpty } from '../../utils/common';

export function createAccountStore(sql: SQL, { encrypt, decrypt }: Crypto) {
  async function upsert(input: UpsertAccountInput): Promise<Account> {
    const config = input.config ? encrypt(JSON.stringify(input.config)) : null;

    const rows = await sql<AccountRow[]>`
      INSERT INTO accounts ${sql({
        provider: input.provider,
        name: input.name,
        credential: encrypt(input.credential),
        config,
      })}
      ON CONFLICT (provider, name) DO UPDATE SET
        credential = EXCLUDED.credential,
        config = COALESCE(EXCLUDED.config, accounts.config),
        updated_at = now()
      RETURNING *
    `;

    return toAccount(expect(rows, 'Failed to upsert account'));
  }

  async function update(
    id: string,
    { name, credential, config }: UpdateAccountInput,
  ): Promise<void> {
    const patch: Record<string, string | null> = {};

    if (name !== undefined) {
      patch.name = name;
    }

    if (credential !== undefined) {
      patch.credential = encrypt(credential);
    }

    if (config !== undefined) {
      patch.config = config ? encrypt(JSON.stringify(config)) : null;
    }

    if (isEmpty(patch)) return;

    await sql`
      UPDATE accounts
      SET ${sql(patch)},
        updated_at = now()
      WHERE id = ${id}
    `;
  }

  async function remove(id: string): Promise<void> {
    await sql`DELETE FROM accounts WHERE id = ${id}`;
  }

  async function getByName(
    provider: string,
    name: string,
  ): Promise<Account | null> {
    const [row] = await sql<AccountRow[]>`
      SELECT * FROM accounts
      WHERE provider = ${provider} AND name = ${name}
    `;

    return row ? toAccount(row) : null;
  }

  async function list(): Promise<Account[]> {
    const rows = await sql<AccountRow[]>`
      SELECT * FROM accounts ORDER BY provider, name
    `;

    return rows.map(toAccount);
  }

  async function listByFlowId(
    flowId: string,
  ): Promise<{ slot: string; account: Account }[]> {
    const rows = await sql<({ slot: string } & AccountRow)[]>`
      SELECT
        b.slot,
        a.*
      FROM accounts a
      JOIN bindings b ON b.account_id = a.id
      WHERE b.flow_id = ${flowId}
    `;

    return rows.map(({ slot, ...row }) => ({
      slot,
      account: toAccount(row),
    }));
  }

  function toAccount(row: AccountRow): Account {
    return {
      id: row.id,
      provider: row.provider as Provider,
      name: row.name,
      credential: decrypt(row.credential),
      config: row.config ? JSON.parse(decrypt(row.config)) : {},
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  return {
    upsert,
    update,
    remove,
    getByName,
    list,
    listByFlowId,
  };
}

export type AccountStore = ReturnType<typeof createAccountStore>;
