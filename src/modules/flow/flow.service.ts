import type { SQL } from 'bun';
import type { AccountService } from '../account/account.service';
import type { FlowRegistry } from './flow.registry';
import type {
  CreateFlowInput,
  Flow,
  FlowPatch,
  SyncInput,
  UpdateFlowInput,
} from './flow.types';
import { createFlowStore } from './flow.store';
import { createBindingStore } from './binding.store';
import { createRunStore } from '../run/run.store';
import {
  parse,
  parseConfig,
  validateBindings,
  validateSlot,
} from './flow.validator';
import { schedulesSchema } from '../../utils/time';
import { NotFoundError, ValidationError } from '../../utils/error';

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}$/;

export function createFlowService(
  sql: SQL,
  fr: FlowRegistry,
  accounts: AccountService,
) {
  const store = createFlowStore(sql);
  const bindings = createBindingStore(sql);

  async function require(name: string): Promise<Flow> {
    const flow = await store.getByName(name);
    if (!flow) throw new NotFoundError(`Flow "${name}" not found`);
    return flow;
  }

  async function create(input: CreateFlowInput): Promise<Flow> {
    assertName(input.name);

    if (!fr.has(input.def)) {
      throw new ValidationError(
        `Flow definition not registered: "${input.def}"`,
      );
    }

    const def = fr.get(input.def);

    if (await store.getByName(input.name)) {
      throw new ValidationError(`Flow "${input.name}" already exists`);
    }

    const parent = input.parent ? await require(input.parent) : null;
    if (input.freshness_seconds != null && !parent) {
      throw new ValidationError('freshness_seconds requires a parent flow');
    }

    const slots = def.slots ?? {};
    const bound = await Promise.all(
      Object.entries(input.bindings ?? {}).map(async ([slot, name]) => {
        const spec = slots[slot];
        if (!spec) {
          throw new ValidationError(
            `Flow definition "${def.name}" has no slot "${slot}"`,
          );
        }

        return { slot, account: await accounts.require(spec.provider, name) };
      }),
    );

    const schedules = parseSchedules(input.schedules);
    const config =
      input.config === undefined ? {} : parseConfig(def, input.config);

    if (input.enabled) {
      parseConfig(def, config);
      validateBindings(
        def,
        Object.fromEntries(bound.map((b) => [b.slot, b.account])),
      );
    }

    return sql.begin(async (tx) => {
      const flow = await createFlowStore(tx).create({
        name: input.name,
        def: input.def,
        enabled: input.enabled ?? false,
        schedules,
        config,
        parent_flow: parent?.id ?? null,
        freshness_seconds: input.freshness_seconds ?? null,
      });

      const b = createBindingStore(tx);
      for (const { slot, account } of bound) {
        await b.set(flow.id, slot, account.id);
      }

      return flow;
    });
  }

  async function update(name: string, input: UpdateFlowInput): Promise<Flow> {
    const current = await require(name);
    const patch: FlowPatch = {};

    if (input.name !== undefined && input.name !== current.name) {
      assertName(input.name);
      if (await store.getByName(input.name)) {
        throw new ValidationError(`Flow "${input.name}" already exists`);
      }
      patch.name = input.name;
    }

    if (input.schedules !== undefined) {
      patch.schedules = parseSchedules(input.schedules);
      patch.next_at = null;
    }

    if (input.config !== undefined) {
      const def = fr.get(current.def);
      patch.config = parseConfig(def, input.config);
    }

    if (input.parent !== undefined) {
      if (input.parent === null) {
        patch.parent_flow = null;
        patch.freshness_seconds = null;
      } else {
        const parent = await require(input.parent);
        if (await store.createsCycle(current.id, parent.id)) {
          throw new ValidationError(
            `Setting parent "${parent.name}" would create a cycle`,
          );
        }
        patch.parent_flow = parent.id;
      }
    }

    if (input.freshness_seconds !== undefined) {
      const parentFlow =
        patch.parent_flow !== undefined
          ? patch.parent_flow
          : current.parent_flow;

      if (input.freshness_seconds !== null && !parentFlow) {
        throw new ValidationError('freshness_seconds requires a parent flow');
      }
      patch.freshness_seconds = input.freshness_seconds;
    }

    if (input.enabled !== undefined && input.enabled !== current.enabled) {
      patch.enabled = input.enabled;
      patch.next_at = null;
    }

    const enabled = patch.enabled ?? current.enabled;
    if (enabled) {
      await assertReady({ ...current, ...patch } as Flow);
    }

    return (await store.update(current.id, patch))!;
  }

  async function bind(
    name: string,
    slot: string,
    accountName: string,
  ): Promise<void> {
    const flow = await require(name);
    const def = fr.get(flow.def);

    const spec = def.slots?.[slot];
    if (!spec) {
      throw new ValidationError(
        `Flow definition "${def.name}" has no slot "${slot}"`,
      );
    }

    const account = await accounts.require(spec.provider, accountName);
    validateSlot(slot, spec, account);

    await bindings.set(flow.id, slot, account.id);
  }

  async function unbind(name: string, slot: string): Promise<void> {
    const flow = await require(name);

    if (flow.enabled && fr.has(flow.def) && fr.get(flow.def).slots?.[slot]) {
      throw new ValidationError(
        `Disable "${name}" before removing its "${slot}" binding`,
      );
    }

    await bindings.remove(flow.id, slot);
  }

  async function remove(name: string): Promise<void> {
    const flow = await require(name);

    await sql.begin(async (tx) => {
      await createRunStore(tx).failQueued(
        flow.id,
        `Flow "${name}" was removed`,
      );
      await createFlowStore(tx).remove(flow.id);
    });
  }

  async function listBindings(name: string) {
    const flow = await require(name);
    return bindings.listByFlow(flow.id);
  }

  /** Throws unless the flow can run: def registered, config and bindings valid. */
  async function assertReady(flow: Flow): Promise<void> {
    if (!fr.has(flow.def)) {
      throw new ValidationError(
        `Flow definition not registered: "${flow.def}"`,
      );
    }

    const def = fr.get(flow.def);
    parseConfig(def, flow.config);

    validateBindings(def, await accounts.getIndexByFlowId(flow.id));
  }

  async function sync(inputs: SyncInput[]): Promise<void> {
    await store.sync(inputs);
  }

  return {
    ...store,
    require,
    create,
    update,
    bind,
    unbind,
    remove,
    listBindings,
    assertReady,
    sync,
  };
}

function assertName(name: string): void {
  if (!NAME_PATTERN.test(name)) {
    throw new ValidationError(
      `Invalid flow name "${name}": use lowercase letters, digits, ".", "_" or "-"`,
    );
  }
}

function parseSchedules(schedules: unknown) {
  if (schedules == null) return null;
  return parse(schedulesSchema, schedules, 'schedules');
}

export type FlowService = ReturnType<typeof createFlowService>;
