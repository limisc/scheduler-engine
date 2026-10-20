import type { Signal } from '../runtime/signal';
import type { Modules } from '../modules';
import type { Flow } from '../modules/flow/flow.types';
import type { CreateRunInput } from '../modules/run/run.types';
import { createTicker } from '../runtime/ticker';
import { DEFAULT_ZONE, findEarliest } from '../utils/time';
import { createLogger } from '../utils/logger';

export interface SchedulerOptions {
  interval?: number;
  zone?: string;
  /** A running run without a heartbeat for this long is requeued. */
  staleAfter?: number;
  /** Finished runs older than this many days are deleted. */
  retentionDays?: number;
}

const PRUNE_INTERVAL = 60 * 60_000;

export function createScheduler(
  modules: Modules,
  signal: Signal,
  {
    interval = 5_000,
    zone = DEFAULT_ZONE,
    staleAfter = 2 * 60_000,
    retentionDays = 90,
  }: SchedulerOptions = {},
) {
  const log = createLogger('Scheduler');
  const unknown = new Set<string>();
  let prunedAt = 0;

  async function tick(): Promise<void> {
    const now = new Date();

    await reap(now);
    await schedule(now);

    if (now.getTime() - prunedAt >= PRUNE_INTERVAL) {
      prunedAt = now.getTime();
      await prune(now);
    }
  }

  async function schedule(now: Date): Promise<void> {
    const count = await modules.tx(async (services) => {
      const due = await services.flows.listDue(now);
      const flows = due.filter(isRegistered);
      if (flows.length === 0) return 0;

      const plans = plan(flows, now, {
        zone,
        catchUp: (flow) => modules.fr.get(flow.def).catchUp ?? 'latest',
      });

      const runs = await services.runs.createBatch(createRunInputs(plans));

      let pending = runs.filter((r) => r.status === 'pending').length;
      pending += await services.runs.resolveBlocked(runs);

      await services.flows.sync(
        plans.map((p) => ({ id: p.flow.id, next_at: p.next_at })),
      );

      return pending;
    });

    if (count > 0) signal.broadcast();
  }

  function isRegistered(flow: Flow): boolean {
    if (modules.fr.has(flow.def)) return true;

    if (!unknown.has(flow.id)) {
      unknown.add(flow.id);
      log.warn(
        `flow "${flow.name}" uses unregistered definition "${flow.def}", skipping`,
      );
    }

    return false;
  }

  async function reap(now: Date): Promise<void> {
    const runs = await modules.runs.reap(new Date(now.getTime() - staleAfter));
    if (runs.length === 0) return;

    log.warn(`requeued ${runs.length} stale run(s)`);
    signal.broadcast();
  }

  async function prune(now: Date): Promise<void> {
    const before = new Date(now.getTime() - retentionDays * 86_400_000);
    const count = await modules.runs.prune(before);
    if (count > 0) log.info(`pruned ${count} finished run(s)`);
  }

  const ticker = createTicker({
    interval,
    onTick: tick,
    onError(error) {
      log.error('tick failed', error);
    },
  });

  return {
    start: ticker.start,
    stop: ticker.stop,
    tick,
  };
}

export interface Plan {
  flow: Flow;
  times: Date[];
  next_at: Date | null;
}

interface PlanOptions {
  zone?: string;
  catchUp?: (flow: Flow) => 'latest' | 'all';
}

/** Occurrences due at `now` for each flow, plus the following one. */
export function plan(
  flows: Flow[],
  now: Date,
  { zone = DEFAULT_ZONE, catchUp = () => 'latest' }: PlanOptions = {},
): Plan[] {
  const plans: Plan[] = [];

  for (const flow of flows) {
    let { schedules, next_at } = flow;
    if (!schedules || schedules.length === 0) {
      plans.push({ flow, times: [], next_at: null });
      continue;
    }

    if (next_at === null) {
      plans.push({
        flow,
        times: [],
        next_at: findEarliest(schedules, now, zone),
      });
      continue;
    }

    let times: Date[] = [];
    let it = 0;

    while (next_at !== null && next_at.getTime() <= now.getTime()) {
      if (++it > 1024) break;

      times.push(next_at);
      next_at = findEarliest(schedules, next_at, zone);
    }

    if (next_at !== null && next_at.getTime() <= now.getTime()) {
      next_at = findEarliest(schedules, now, zone);
    }

    if (catchUp(flow) === 'latest') {
      times = times.slice(-1);
    }

    plans.push({ flow, times, next_at });
  }

  return plans;
}

function createRunInputs(plans: Plan[]): CreateRunInput[] {
  const inputs: CreateRunInput[] = [];

  for (const { flow, times } of plans) {
    for (const scheduled_at of times) {
      inputs.push({
        status: flow.parent_flow ? 'blocked' : 'pending',
        trigger: 'schedule',
        flow_id: flow.id,
        def: flow.def,
        scheduled_at,
      });
    }
  }

  return inputs;
}
