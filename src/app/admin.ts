import { z } from 'zod';
import type { Signal } from '../runtime/signal';
import type { Modules } from '../modules';
import type { Flow } from '../modules/flow/flow.types';
import type { RunStatus } from '../modules/run/run.types';
import { toPublic } from '../modules/account/account.service';
import { parse, parsePayload } from '../modules/flow/flow.validator';
import { NotFoundError, ValidationError } from '../utils/error';
import { DEFAULT_ZONE, schedulesSchema, upcoming } from '../utils/time';

const nameSchema = z.string().min(1).max(63);
const configSchema = z.record(z.string(), z.unknown());
const freshnessSchema = z.number().int().positive().nullable();

export const createFlowSchema = z.strictObject({
  name: nameSchema,
  def: z.string().min(1),
  schedules: schedulesSchema.nullable().optional(),
  config: configSchema.optional(),
  parent: nameSchema.nullable().optional(),
  freshness_seconds: freshnessSchema.optional(),
  bindings: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional(),
});

export const updateFlowSchema = z.strictObject({
  name: nameSchema.optional(),
  schedules: schedulesSchema.nullable().optional(),
  config: configSchema.optional(),
  parent: nameSchema.nullable().optional(),
  freshness_seconds: freshnessSchema.optional(),
  enabled: z.boolean().optional(),
});

export const listRunsSchema = z.strictObject({
  flow: nameSchema.optional(),
  status: z
    .enum(['blocked', 'pending', 'running', 'completed', 'failed'])
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  before: z.coerce.date().optional(),
});

export type CreateFlowRequest = z.infer<typeof createFlowSchema>;
export type UpdateFlowRequest = z.infer<typeof updateFlowSchema>;
export type ListRunsRequest = z.infer<typeof listRunsSchema>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Everything an operator can do, independent of transport.
 * Used by the HTTP API and, later, the Telegram bot.
 */
export function createAdmin(
  modules: Modules,
  signal: Signal,
  { zone = DEFAULT_ZONE }: { zone?: string } = {},
) {
  const { accounts, flows, runs, fr, cr } = modules;

  async function toView(flow: Flow) {
    const parent = flow.parent_flow
      ? await flows.getById(flow.parent_flow)
      : null;

    return {
      id: flow.id,
      name: flow.name,
      def: flow.def,
      registered: fr.has(flow.def),
      enabled: flow.enabled,
      schedules: flow.schedules,
      next_at: flow.next_at,
      config: flow.config,
      parent: parent?.name ?? null,
      freshness_seconds: flow.freshness_seconds,
      created_at: flow.created_at,
      updated_at: flow.updated_at,
    };
  }

  // definitions

  function listDefs() {
    return fr.list();
  }

  // flows

  async function listFlows() {
    return Promise.all((await flows.list()).map(toView));
  }

  async function getFlow(name: string) {
    const flow = await flows.require(name);

    return {
      ...(await toView(flow)),
      bindings: await flows.listBindings(name),
      upcoming: flow.schedules
        ? upcoming(flow.schedules, 3, new Date(), zone)
        : [],
      runs: await runs.list({ flow_id: flow.id, limit: 5 }),
    };
  }

  async function createFlow(input: CreateFlowRequest) {
    const flow = await flows.create(parse(createFlowSchema, input, 'flow'));
    return getFlow(flow.name);
  }

  async function updateFlow(name: string, input: UpdateFlowRequest) {
    const flow = await flows.update(
      name,
      parse(updateFlowSchema, input, 'flow update'),
    );
    return getFlow(flow.name);
  }

  async function enableFlow(name: string) {
    return updateFlow(name, { enabled: true });
  }

  async function disableFlow(name: string) {
    return updateFlow(name, { enabled: false });
  }

  async function bind(name: string, slot: string, account: string) {
    await flows.bind(name, slot, account);
    return getFlow(name);
  }

  async function unbind(name: string, slot: string) {
    await flows.unbind(name, slot);
    return getFlow(name);
  }

  async function removeFlow(name: string): Promise<void> {
    await flows.remove(name);
  }

  // accounts

  async function listAccounts() {
    return accounts.listPublic();
  }

  async function removeAccount(provider: string, name: string): Promise<void> {
    const account = await accounts.require(provider, name);
    await accounts.remove(account.id);
    cr.evict(account.id);
  }

  function connectUrl(provider: string, name: string): string {
    parse(nameSchema, name, 'account name');

    const handler = cr.getAuthHandler(provider);
    if (!handler) {
      throw new NotFoundError(`Provider "${provider}" does not support OAuth`);
    }

    return handler.getAuthUrl(name);
  }

  async function completeAuth(provider: string, params: URLSearchParams) {
    const handler = cr.getAuthHandler(provider);
    if (!handler) {
      throw new NotFoundError(`Provider "${provider}" does not support OAuth`);
    }

    const result = await handler.handleCallback(params);
    const account = await accounts.upsert({
      provider,
      name: result.name,
      credential: result.credential,
      config: result.config,
    });

    cr.evict(account.id);
    if (result.payload) cr.setToken(account.id, result.payload);

    return toPublic(account);
  }

  /** Stores a credential directly, for providers without OAuth. */
  async function setAccount(
    provider: string,
    name: string,
    credential: string,
    config?: Record<string, unknown>,
  ) {
    if (!cr.has(provider)) {
      throw new ValidationError(`Provider "${provider}" is not registered`);
    }

    parse(nameSchema, name, 'account name');

    const account = await accounts.upsert({
      provider,
      name,
      credential,
      config,
    });
    cr.evict(account.id);
    return toPublic(account);
  }

  // runs

  async function trigger(name: string, payload?: unknown) {
    const flow = await flows.require(name);
    await flows.assertReady(flow);

    const run = await runs.create({
      status: flow.parent_flow ? 'blocked' : 'pending',
      trigger: 'manual',
      flow_id: flow.id,
      def: flow.def,
      payload: parsePayload(fr.get(flow.def), payload),
      scheduled_at: new Date(),
    });

    await runs.resolveBlocked([run]);
    signal.broadcast();

    return (await runs.getById(run.id))!;
  }

  async function listRuns(input: ListRunsRequest = {}) {
    const { flow, status, limit, before } = parse(
      listRunsSchema,
      input,
      'run query',
    );

    const flowId = flow ? (await flows.require(flow)).id : undefined;
    return runs.list({
      flow_id: flowId,
      status: status as RunStatus | undefined,
      limit,
      before,
    });
  }

  async function getRun(id: string) {
    const run = UUID.test(id) ? await runs.getById(id) : null;
    if (!run) throw new NotFoundError(`Run "${id}" not found`);

    const flow = run.flow_id ? await flows.getById(run.flow_id) : null;

    return {
      ...run,
      flow: flow?.name ?? null,
      steps: await runs.listSteps(run.id),
    };
  }

  async function retryRun(id: string) {
    await getRun(id);
    const run = await runs.requeue(id);
    signal.broadcast();
    return run;
  }

  return {
    listDefs,

    listFlows,
    getFlow,
    createFlow,
    updateFlow,
    enableFlow,
    disableFlow,
    bind,
    unbind,
    removeFlow,

    listAccounts,
    removeAccount,
    connectUrl,
    completeAuth,
    setAccount,

    trigger,
    listRuns,
    getRun,
    retryRun,
  };
}

export type Admin = ReturnType<typeof createAdmin>;
