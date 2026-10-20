import type { Signal } from '../runtime/signal';
import type { Modules } from '../modules';
import type { Flow, FlowDefinition } from '../modules/flow/flow.types';
import type { Run } from '../modules/run/run.types';
import { createWorker } from '../runtime/worker';
import { createStepRunner } from '../modules/run/step-runner';
import { parseConfig, parsePayload } from '../modules/flow/flow.validator';
import {
  FatalError,
  formatError,
  isFatalError,
  ValidationError,
} from '../utils/error';
import { backoff, sleep } from '../utils/common';
import { createLogger } from '../utils/logger';

export interface RunEvent {
  run: Run;
  flow: Flow | null;
}

export interface EngineHooks {
  onRunCompleted?: (event: RunEvent & { output: unknown }) => unknown;
  /** Called once a run failed for good (no retries left or fatal). */
  onRunFailed?: (event: RunEvent & { error: string }) => unknown;
}

export interface EngineOptions {
  concurrency?: number;
  hooks?: EngineHooks;
  /** Time in-flight runs get to finish on shutdown before being aborted. */
  shutdownGrace?: number;
  /** Backoff between attempts, in ms. */
  retryDelay?: { base: number; max: number };
}

const DEFAULT_RETRIES = 2;
const DEFAULT_TIMEOUT = 10 * 60_000;
const HEARTBEAT_INTERVAL = 30_000;
const RETRY_DELAY = { base: 5_000, max: 10 * 60_000 };

export function createEngine(
  modules: Modules,
  signal: Signal,
  {
    concurrency = 3,
    hooks = {},
    shutdownGrace = 30_000,
    retryDelay = RETRY_DELAY,
  }: EngineOptions = {},
) {
  const log = createLogger('Engine');
  const shutdown = new AbortController();

  const worker = createWorker<Run>({
    concurrency,
    signal,
    onError(error) {
      log.error('worker error', error);
    },
    adapter: {
      async fetch() {
        if (shutdown.signal.aborted) return null;
        return modules.runs.claim();
      },

      async process(run) {
        const def = modules.fr.get(run.def);
        const flow = await getFlow(run);
        const maxAttempts = getMaxAttempts(def);

        if (run.attempt > maxAttempts) {
          throw new FatalError(`Exceeded ${maxAttempts} attempts`);
        }

        const config = fatal(() => parseConfig(def, flow.config));
        const payload = fatal(() => parsePayload(def, run.payload));
        const clients = await modules.getClients(flow);
        const runner = await createStepRunner(run, modules.runs);

        const timeout = def.timeout ?? DEFAULT_TIMEOUT;
        const abort = AbortSignal.any([
          shutdown.signal,
          AbortSignal.timeout(timeout),
        ]);

        const heartbeat = setInterval(() => {
          modules.runs.heartbeat(run.id).catch((error) => {
            log.warn(`heartbeat failed for run ${run.id}`, error);
          });
        }, HEARTBEAT_INTERVAL);

        log.info(`run ${run.id} ${flow.name} started (attempt ${run.attempt})`);

        try {
          return await Promise.race([
            def.run({
              run: {
                id: run.id,
                flow: flow.name,
                attempt: run.attempt,
                trigger: run.trigger,
                scheduledAt: run.scheduled_at,
              },
              step: runner.step,
              clients,
              config,
              payload,
              signal: abort,
              log: log.child(flow.name),
            }),
            aborted(abort),
          ]);
        } finally {
          clearInterval(heartbeat);
        }
      },

      async onSuccess(run, output) {
        const released = await modules.runs.complete(run.id, output);
        if (released > 0) signal.broadcast();

        log.info(`run ${run.id} completed`);
        if (!hooks.onRunCompleted) return;

        await notify(async () => {
          const flow = await findFlow(run);
          return hooks.onRunCompleted?.({ run, flow, output });
        });
      },

      async onFailure(run, error) {
        // interrupted by shutdown: hand the run back for the next start
        if (shutdown.signal.aborted) {
          await modules.runs.update(
            run.id,
            {
              status: 'pending',
              available_at: new Date(),
              started_at: null,
              heartbeat_at: null,
            },
            'running',
          );
          log.warn(`run ${run.id} interrupted by shutdown, requeued`);
          return;
        }

        const maxAttempts = modules.fr.has(run.def)
          ? getMaxAttempts(modules.fr.get(run.def))
          : 1;

        if (!isFatalError(error) && run.attempt < maxAttempts) {
          const delay = backoff(run.attempt, retryDelay.base, retryDelay.max);
          await modules.runs.retry(run, error, new Date(Date.now() + delay));
          signal.wakeAfter(delay + 100);

          log.warn(
            `run ${run.id} attempt ${run.attempt}/${maxAttempts} failed, retrying in ${Math.round(delay / 1_000)}s: ${formatError(error)}`,
          );
          return;
        }

        await modules.runs.fail(run.id, error);

        log.error(`run ${run.id} failed: ${formatError(error)}`);
        if (!hooks.onRunFailed) return;

        await notify(async () => {
          const flow = await findFlow(run);
          return hooks.onRunFailed?.({ run, flow, error: formatError(error) });
        });
      },
    },
  });

  async function findFlow(run: Run): Promise<Flow | null> {
    return run.flow_id ? modules.flows.getById(run.flow_id) : null;
  }

  async function getFlow(run: Run): Promise<Flow> {
    const flow = await findFlow(run);
    if (!flow) throw new FatalError('Flow instance was removed');
    return flow;
  }

  async function notify(fn: () => unknown): Promise<void> {
    try {
      await fn();
    } catch (error) {
      log.error('hook failed', error);
    }
  }

  return {
    start(): void {
      worker.start();
    },

    async stop(): Promise<void> {
      const stopped = worker.stop();

      const graceful = await Promise.race([
        stopped.then(() => true),
        sleep(shutdownGrace).then(() => false),
      ]);

      if (!graceful) {
        shutdown.abort(new Error('Shutting down'));
        await stopped;
      }
    },
  };
}

function getMaxAttempts(def: FlowDefinition): number {
  return Math.max(0, def.retries ?? DEFAULT_RETRIES) + 1;
}

function fatal<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof ValidationError) {
      throw new FatalError(error.message, { cause: error });
    }
    throw error;
  }
}

function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const fail = () => {
      const reason = signal.reason;
      reject(
        reason instanceof DOMException && reason.name === 'TimeoutError'
          ? new Error('Flow timed out')
          : reason,
      );
    };

    if (signal.aborted) fail();
    else signal.addEventListener('abort', fail, { once: true });
  });
}
