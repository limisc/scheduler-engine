import type { Run, Runner } from './run.types';
import type { RunService } from './run.service';
import { FatalError } from '../../utils/error';

export async function createStepRunner(
  run: Run,
  runs: RunService,
): Promise<Runner> {
  const memo = await runs.getStepMemo(run.id);
  const seen = new Set<string>();

  return {
    async step<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
      if (seen.has(name)) {
        throw new FatalError(`Duplicate step name "${name}" in one run`);
      }

      seen.add(name);

      if (memo.has(name)) return memo.get(name) as T;

      const stepId = await runs.startStep(run.id, name, run.attempt);

      try {
        const output = await fn();
        // round-trip through JSON so a fresh result matches a replayed one
        const stored =
          output === undefined ? null : JSON.parse(JSON.stringify(output));
        await runs.completeStep(stepId, stored);
        memo.set(name, stored);
        return stored as T;
      } catch (error) {
        await runs.failStep(stepId, error);
        throw error;
      }
    },
  };
}
