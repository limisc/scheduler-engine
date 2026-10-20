import type { SQL } from 'bun';
import type { Step } from './step.types';
import { expect } from '../../utils/common';
import { jsonb } from '../../db/json';

export function createStepStore(sql: SQL) {
  /** Starts a step, resetting a previous failed or interrupted attempt. */
  async function start(
    runId: string,
    name: string,
    attempt: number,
  ): Promise<string> {
    const rows = await sql<{ id: string }[]>`
      INSERT INTO steps ${sql({
        status: 'running',
        run_id: runId,
        name,
        attempt,
        started_at: new Date(),
      })}
      ON CONFLICT (run_id, name) DO UPDATE SET
        status = 'running',
        attempt = EXCLUDED.attempt,
        output = NULL,
        error = NULL,
        started_at = EXCLUDED.started_at,
        completed_at = NULL
      WHERE steps.status <> 'completed'
      RETURNING id
    `;

    return expect(rows, `Step "${name}" already completed`).id;
  }

  async function complete(id: string, output: unknown): Promise<void> {
    await sql`
      UPDATE steps
      SET
        status = 'completed',
        output = ${jsonb(sql, output)},
        completed_at = statement_timestamp()
      WHERE id = ${id}
    `;
  }

  async function fail(id: string, error: string): Promise<void> {
    await sql`
      UPDATE steps
      SET
        status = 'failed',
        error = ${error},
        completed_at = statement_timestamp()
      WHERE id = ${id}
    `;
  }

  async function listByRun(runId: string): Promise<Step[]> {
    return sql<Step[]>`
      SELECT * FROM steps
      WHERE run_id = ${runId}
      ORDER BY started_at, name
    `;
  }

  async function listCompleted(runId: string): Promise<Step[]> {
    return sql<Step[]>`
      SELECT * FROM steps
      WHERE run_id = ${runId}
        AND status = 'completed'
    `;
  }

  return {
    start,
    complete,
    fail,
    listByRun,
    listCompleted,
  };
}

export type StepStore = ReturnType<typeof createStepStore>;
