import { createModules, type ModulesConfig } from '../modules';
import { createSignal } from '../runtime/signal';
import { migrate } from '../db/migrate';
import { createEngine, type EngineHooks } from './engine';
import { createScheduler } from './scheduler';
import { createAdmin } from './admin';
import { createServer, type ServerOptions } from './server';
import { DEFAULT_ZONE } from '../utils/time';
import { createLogger } from '../utils/logger';

export interface AppConfig extends ModulesConfig {
  /** IANA zone schedules are evaluated in, unless a schedule sets its own. */
  zone?: string;
  /** Parallel runs (default 3). */
  concurrency?: number;
  /** Days to keep finished runs (default 90). */
  retentionDays?: number;
  hooks?: EngineHooks;
  /** Backoff between attempts, in ms (default 5s doubling up to 10m). */
  retryDelay?: { base: number; max: number };
  server?: ServerOptions | false;
}

export function createApp(config: AppConfig) {
  const { sql, zone = DEFAULT_ZONE } = config;
  const log = createLogger('App');

  const modules = createModules(config);
  const signal = createSignal();

  const engine = createEngine(modules, signal, {
    concurrency: config.concurrency,
    hooks: config.hooks,
    retryDelay: config.retryDelay,
  });
  const scheduler = createScheduler(modules, signal, {
    zone,
    retentionDays: config.retentionDays,
  });
  const admin = createAdmin(modules, signal, { zone });
  const server =
    config.server === false ? null : createServer(admin, config.server);

  let started = false;

  async function start(): Promise<void> {
    if (started) return;
    started = true;

    await migrate(sql);
    await checkFlows();

    engine.start();
    scheduler.start();
    server?.start();
  }

  async function stop(): Promise<void> {
    if (!started) return;
    started = false;

    await server?.stop();
    await scheduler.stop();
    await engine.stop();
    signal.destroy();
    await sql.close();
  }

  async function checkFlows(): Promise<void> {
    for (const flow of await modules.flows.list()) {
      if (!flow.enabled) continue;

      try {
        await modules.flows.assertReady(flow);
      } catch (error) {
        log.warn(`flow "${flow.name}" is enabled but not runnable: ${error}`);
      }
    }
  }

  return {
    admin,
    modules,
    start,
    stop,
    get url() {
      return server?.url;
    },
  };
}

export type App = ReturnType<typeof createApp>;
