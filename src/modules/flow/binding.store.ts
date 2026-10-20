import type { SQL } from 'bun';

export interface Binding {
  flow_id: string;
  slot: string;
  account_id: string;
}

export function createBindingStore(sql: SQL) {
  async function set(
    flowId: string,
    slot: string,
    accountId: string,
  ): Promise<void> {
    await sql`
      INSERT INTO bindings ${sql({
        flow_id: flowId,
        slot,
        account_id: accountId,
      })}
      ON CONFLICT (flow_id, slot) DO UPDATE SET
        account_id = EXCLUDED.account_id
    `;
  }

  async function remove(flowId: string, slot: string): Promise<void> {
    await sql`
      DELETE FROM bindings
      WHERE flow_id = ${flowId}
        AND slot = ${slot}
    `;
  }

  async function listByFlow(
    flowId: string,
  ): Promise<{ slot: string; provider: string; account: string }[]> {
    return sql`
      SELECT b.slot, a.provider, a.name AS account
      FROM bindings b
      JOIN accounts a ON a.id = b.account_id
      WHERE b.flow_id = ${flowId}
      ORDER BY b.slot
    `;
  }

  return {
    set,
    remove,
    listByFlow,
  };
}

export type BindingStore = ReturnType<typeof createBindingStore>;
