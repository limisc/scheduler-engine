import type { SQL } from 'bun';
import type {
  CreateRunInput,
  ListRunsInput,
  Run,
  RunStatus,
  RunWithFlow,
  UpdateRunInput,
} from './run.types';
import { defined, isEmpty } from '../../utils/common';
import { jsonb } from '../../db/json';

export function createRunStore(sql: SQL) {
  async function create(input: CreateRunInput): Promise<Run> {
    const [row] = await sql<Run[]>`
      INSERT INTO runs ${sql(toRow(input))}
      RETURNING *
    `;

    return row!;
  }

  /** Inserts runs, skipping schedule occurrences that already exist. */
  async function createBatch(inputs: CreateRunInput[]): Promise<Run[]> {
    if (inputs.length === 0) return [];

    return sql<Run[]>`
      INSERT INTO runs ${sql(inputs.map(toRow))}
      ON CONFLICT (flow_id, scheduled_at)
        WHERE trigger = 'schedule'
      DO NOTHING
      RETURNING *
    `;
  }

  /**
   * Claims the next runnable run. Runs of an instance that is already
   * running are skipped; the partial unique index settles races.
   */
  async function claim(): Promise<Run | null> {
    for (let i = 0; i < 3; i++) {
      try {
        const [row] = await sql<Run[]>`
          UPDATE runs
          SET status = 'running',
            started_at = statement_timestamp(),
            heartbeat_at = statement_timestamp()
          WHERE id = (
            SELECT r.id
            FROM runs r
            WHERE r.status = 'pending'
              AND r.available_at <= statement_timestamp() + INTERVAL '200 milliseconds'
              AND NOT EXISTS (
                SELECT 1
                FROM runs x
                WHERE x.flow_id = r.flow_id
                  AND x.status = 'running'
              )
            ORDER BY r.available_at ASC, r.scheduled_at ASC
            FOR UPDATE SKIP LOCKED
            LIMIT 1
          )
          RETURNING *
        `;

        return row ?? null;
      } catch (error) {
        if (!isUniqueViolation(error, 'idx_runs_flow_running')) throw error;
      }
    }

    return null;
  }

  async function getById(id: string): Promise<Run | null> {
    const [row] = await sql<Run[]>`SELECT * FROM runs WHERE id = ${id}`;
    return row ?? null;
  }

  async function list({
    flow_id,
    status,
    before,
    limit = 20,
  }: ListRunsInput = {}): Promise<RunWithFlow[]> {
    return sql<RunWithFlow[]>`
      SELECT r.*, f.name AS flow
      FROM runs r
      LEFT JOIN flows f ON f.id = r.flow_id
      WHERE (${flow_id ?? null}::uuid IS NULL OR r.flow_id = ${flow_id ?? null}::uuid)
        AND (${status ?? null}::text IS NULL OR r.status = ${status ?? null}::text)
        AND (${before ?? null}::timestamptz IS NULL OR r.created_at < ${before ?? null}::timestamptz)
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT ${Math.min(Math.max(limit, 1), 200)}
    `;
  }

  /** Updates a run, optionally only while it is in `status`. */
  async function update(
    id: string,
    input: UpdateRunInput,
    status?: RunStatus,
  ): Promise<Run | null> {
    const patch = defined(input);
    if (isEmpty(patch)) return getById(id);

    const [row] = await sql<Run[]>`
      UPDATE runs
      SET ${sql(patch)}
      WHERE id = ${id}
        AND (${status ?? null}::text IS NULL OR status = ${status ?? null}::text)
      RETURNING *
    `;

    return row ?? null;
  }

  /** Completes a running run; null when it was no longer running. */
  async function complete(id: string, output: unknown): Promise<Run | null> {
    const [row] = await sql<Run[]>`
      UPDATE runs
      SET
        status = 'completed',
        output = ${jsonb(sql, output ?? null)},
        error = NULL,
        heartbeat_at = NULL,
        completed_at = statement_timestamp()
      WHERE id = ${id}
        AND status = 'running'
      RETURNING *
    `;

    return row ?? null;
  }

  async function heartbeat(id: string): Promise<void> {
    await sql`
      UPDATE runs
      SET heartbeat_at = statement_timestamp()
      WHERE id = ${id}
        AND status = 'running'
    `;
  }

  async function updateChildren(
    parentRun: string,
    input: UpdateRunInput,
  ): Promise<Run[]> {
    const patch = defined(input);
    if (isEmpty(patch)) return [];

    return sql<Run[]>`
      UPDATE runs
      SET ${sql(patch)}
      WHERE parent_run = ${parentRun}
        AND status = 'blocked'
      RETURNING *
    `;
  }

  async function failChildren(
    parentRun: string,
    completedAt: Date,
  ): Promise<void> {
    const error = `Aborted: parent run ${parentRun} failed`;

    await sql`
      WITH RECURSIVE descendants AS (
        SELECT id
        FROM runs
        WHERE parent_run = ${parentRun}
          AND status = 'blocked'

        UNION

        SELECT r.id
        FROM runs r
        JOIN descendants d ON r.parent_run = d.id
        WHERE r.status = 'blocked'
      )
      UPDATE runs
      SET
        status = 'failed',
        error = ${error},
        completed_at = ${completedAt}
      FROM descendants
      WHERE runs.id = descendants.id
    `;
  }

  /**
   * Attaches blocked runs to the latest parent-flow run at or before their
   * scheduled time (within freshness), then:
   * parent completed → pending, parent failed or missing → failed,
   * otherwise stays blocked until the parent finishes.
   */
  async function resolveBlocked(ids: string[]): Promise<Run[]> {
    if (ids.length === 0) return [];

    return sql<Run[]>`
      WITH target AS (
        SELECT
          r.id,
          f.parent_flow,
          p.id AS parent_id,
          p.status AS parent_status
        FROM runs r
        JOIN flows f ON f.id = r.flow_id
        LEFT JOIN LATERAL (
          SELECT pr.id, pr.status
          FROM runs pr
          WHERE pr.flow_id = f.parent_flow
            AND pr.id <> r.id
            AND pr.scheduled_at <= r.scheduled_at
            AND (
              pr.status IN ('blocked', 'pending', 'running')
              OR f.freshness_seconds IS NULL
              OR pr.completed_at >= r.scheduled_at - f.freshness_seconds * INTERVAL '1 second'
            )
          ORDER BY
            pr.scheduled_at DESC,
            pr.id DESC
          LIMIT 1
        ) AS p ON true
        WHERE r.id IN ${sql(ids)}
          AND r.status = 'blocked'
        FOR UPDATE OF r
      )
      UPDATE runs AS r
      SET
        parent_run = t.parent_id,
        status = CASE
          WHEN t.parent_flow IS NULL THEN 'pending'
          WHEN t.parent_id IS NULL THEN 'failed'
          WHEN t.parent_status = 'failed' THEN 'failed'
          WHEN t.parent_status = 'completed' THEN 'pending'
          ELSE 'blocked'
        END,
        error = CASE
          WHEN t.parent_flow IS NULL THEN NULL
          WHEN t.parent_id IS NULL THEN 'Parent run not found or not fresh'
          WHEN t.parent_status = 'failed' THEN 'Parent run failed'
          ELSE NULL
        END,
        completed_at = CASE
          WHEN t.parent_flow IS NOT NULL
            AND (t.parent_id IS NULL OR t.parent_status = 'failed')
          THEN statement_timestamp()
          ELSE NULL
        END
      FROM target t
      WHERE r.id = t.id
      RETURNING r.*
    `;
  }

  /** Requeues runs whose worker stopped heartbeating (crash, kill -9). */
  async function reap(staleBefore: Date): Promise<Run[]> {
    return sql<Run[]>`
      UPDATE runs
      SET
        status = 'pending',
        attempt = attempt + 1,
        error = 'Recovered: worker heartbeat lost',
        available_at = statement_timestamp(),
        started_at = NULL,
        heartbeat_at = NULL
      WHERE status = 'running'
        AND heartbeat_at < ${staleBefore}
      RETURNING *
    `;
  }

  /** Fails runs of a flow that have not started yet. */
  async function failQueued(flowId: string, error: string): Promise<number> {
    const rows = await sql`
      UPDATE runs
      SET
        status = 'failed',
        error = ${error},
        completed_at = statement_timestamp()
      WHERE flow_id = ${flowId}
        AND status IN ('blocked', 'pending')
      RETURNING id
    `;

    return rows.length;
  }

  async function prune(before: Date, limit = 1_000): Promise<number> {
    const rows = await sql`
      DELETE FROM runs
      WHERE id IN (
        SELECT id
        FROM runs
        WHERE status IN ('completed', 'failed')
          AND completed_at < ${before}
        ORDER BY completed_at
        LIMIT ${limit}
      )
      RETURNING id
    `;

    return rows.length;
  }

  return {
    create,
    createBatch,
    claim,
    getById,
    list,
    update,
    complete,
    heartbeat,
    updateChildren,
    failChildren,
    resolveBlocked,
    reap,
    failQueued,
    prune,
  };
}

export type RunStore = ReturnType<typeof createRunStore>;

function toRow(input: CreateRunInput) {
  return {
    status: input.status,
    trigger: input.trigger,
    flow_id: input.flow_id,
    def: input.def,
    payload: input.payload ?? {},
    scheduled_at: input.scheduled_at,
    available_at: input.available_at ?? input.scheduled_at,
  };
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { errno?: string; constraint?: string };
  return e.errno === '23505' && e.constraint === constraint;
}
