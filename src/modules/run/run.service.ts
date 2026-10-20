import type { SQL } from 'bun';
import type { Run } from './run.types';
import { createRunStore } from './run.store';
import { createStepStore } from './step.store';
import { formatError, ValidationError } from '../../utils/error';

export function createRunService(sql: SQL) {
  const store = createRunStore(sql);
  const steps = createStepStore(sql);

  /** Marks a run completed and releases children waiting on it. */
  async function complete(id: string, output: unknown): Promise<number> {
    return sql.begin(async (tx) => {
      const s = createRunStore(tx);

      const run = await s.complete(id, output);
      if (!run) return 0;

      const children = await s.updateChildren(id, { status: 'pending' });
      return children.length;
    });
  }

  /** Schedules another attempt of the same run; completed steps are kept. */
  async function retry(
    run: Run,
    error: unknown,
    availableAt: Date,
  ): Promise<void> {
    await store.update(
      run.id,
      {
        status: 'pending',
        attempt: run.attempt + 1,
        error: formatError(error),
        available_at: availableAt,
        started_at: null,
        heartbeat_at: null,
      },
      'running',
    );
  }

  /** Fails a run and every blocked run downstream of it. */
  async function fail(id: string, error: unknown): Promise<void> {
    const completedAt = new Date();

    await sql.begin(async (tx) => {
      const s = createRunStore(tx);

      await s.update(id, {
        status: 'failed',
        error: formatError(error),
        heartbeat_at: null,
        completed_at: completedAt,
      });

      await s.failChildren(id, completedAt);
    });
  }

  /** Requeues a failed run with a fresh attempt budget. */
  async function requeue(id: string): Promise<Run> {
    const run = await store.update(
      id,
      {
        status: 'pending',
        attempt: 1,
        error: null,
        available_at: new Date(),
        started_at: null,
        completed_at: null,
      },
      'failed',
    );

    if (!run) {
      throw new ValidationError(`Run "${id}" is not failed`);
    }

    return run;
  }

  async function resolveBlocked(runs: Run[]): Promise<number> {
    const blocked = runs.filter((r) => r.status === 'blocked');
    if (blocked.length === 0) return 0;

    const updated = await store.resolveBlocked(blocked.map((r) => r.id));
    return updated.filter((r) => r.status === 'pending').length;
  }

  async function getStepMemo(runId: string): Promise<Map<string, unknown>> {
    const completed = await steps.listCompleted(runId);
    return new Map(completed.map((s) => [s.name, s.output]));
  }

  async function failStep(id: string, error: unknown): Promise<void> {
    await steps.fail(id, formatError(error));
  }

  return {
    ...store,
    complete,
    retry,
    fail,
    requeue,
    resolveBlocked,

    startStep: steps.start,
    completeStep: steps.complete,
    failStep,
    listSteps: steps.listByRun,
    getStepMemo,
  };
}

export type RunService = ReturnType<typeof createRunService>;
