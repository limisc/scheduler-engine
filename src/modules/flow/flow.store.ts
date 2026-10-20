import type { SQL } from 'bun';
import type { Flow, FlowPatch, SyncInput } from './flow.types';
import { defined, expect, isEmpty } from '../../utils/common';

export function createFlowStore(sql: SQL) {
  async function create(
    input: Required<Omit<FlowPatch, 'next_at'>> & { def: string },
  ): Promise<Flow> {
    const rows = await sql<Flow[]>`
      INSERT INTO flows ${sql(input)}
      RETURNING *
    `;

    return expect(rows, 'Failed to create flow');
  }

  async function update(id: string, input: FlowPatch): Promise<Flow | null> {
    const patch = defined(input);
    if (isEmpty(patch)) return getById(id);

    const [row] = await sql<Flow[]>`
      UPDATE flows
      SET ${sql(patch)},
        updated_at = now()
      WHERE id = ${id}
      RETURNING *
    `;

    return row ?? null;
  }

  async function remove(id: string): Promise<void> {
    await sql`DELETE FROM flows WHERE id = ${id}`;
  }

  async function getById(id: string): Promise<Flow | null> {
    const [row] = await sql<Flow[]>`
      SELECT * FROM flows WHERE id = ${id}
    `;

    return row ?? null;
  }

  async function getByName(name: string): Promise<Flow | null> {
    const [row] = await sql<Flow[]>`
      SELECT * FROM flows WHERE name = ${name}
    `;

    return row ?? null;
  }

  async function list(): Promise<Flow[]> {
    return sql<Flow[]>`SELECT * FROM flows ORDER BY name`;
  }

  /** Due flows, row-locked so admin edits wait for the scheduler's tx. */
  async function listDue(before: Date, limit = 100): Promise<Flow[]> {
    return sql<Flow[]>`
      SELECT *
      FROM flows
      WHERE enabled
        AND schedules IS NOT NULL
        AND (next_at IS NULL OR next_at <= ${before})
      ORDER BY
        next_at ASC NULLS FIRST,
        CASE WHEN parent_flow IS NULL THEN 0 ELSE 1 END
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    `;
  }

  /** Stores the next occurrence; a flow with none left is disabled. */
  async function sync(inputs: SyncInput[]): Promise<void> {
    if (inputs.length === 0) return;

    const values = inputs.map((i) => ({
      id: i.id,
      next_at: i.next_at?.toISOString() ?? null,
    }));

    await sql`
      UPDATE flows AS f
      SET
        enabled = v.next_at IS NOT NULL,
        next_at = v.next_at,
        updated_at = now()
      FROM jsonb_to_recordset(${values}::jsonb) AS v(id uuid, next_at timestamptz)
      WHERE f.id = v.id
    `;
  }

  /** True when `childId` is `parentId` or one of its ancestors. */
  async function createsCycle(
    childId: string,
    parentId: string,
  ): Promise<boolean> {
    const rows = await sql<{ found: boolean }[]>`
      WITH RECURSIVE ancestors AS (
        SELECT id, parent_flow
        FROM flows
        WHERE id = ${parentId}

        UNION

        SELECT f.id, f.parent_flow
        FROM flows f
        JOIN ancestors a ON f.id = a.parent_flow
      )
      SELECT EXISTS (
        SELECT 1 FROM ancestors WHERE id = ${childId}
      ) AS found
    `;

    return rows[0]?.found ?? false;
  }

  return {
    create,
    update,
    remove,
    getById,
    getByName,
    list,
    listDue,
    sync,
    createsCycle,
  };
}

export type FlowStore = ReturnType<typeof createFlowStore>;
