import { z } from 'zod';
import type {
  FlowDefinition,
  FlowDefinitionInfo,
  FlowContext,
  Slots,
} from './flow.types';
import { FatalError } from '../../utils/error';

type EmptyObject = z.ZodObject<Record<never, never>, z.core.$strip>;

export function defineFlow<
  const S extends Slots = Record<string, never>,
  CS extends z.ZodType = EmptyObject,
  PS extends z.ZodType = EmptyObject,
>(
  def: Omit<FlowDefinition<S>, 'config' | 'payload' | 'run'> & {
    config?: CS;
    payload?: PS;
    run: (ctx: FlowContext<S, z.output<CS>, z.output<PS>>) => Promise<unknown>;
  },
): FlowDefinition<S, z.output<CS>, z.output<PS>> {
  return def as FlowDefinition<S, z.output<CS>, z.output<PS>>;
}

export function createFlowRegistry() {
  const defs = new Map<string, FlowDefinition<any, any, any>>();

  function register(def: FlowDefinition<any, any, any>): void {
    if (defs.has(def.name)) {
      throw new Error(`[FlowRegistry] Duplicate flow definition: ${def.name}`);
    }

    defs.set(def.name, def);
  }

  function registerAll(items: FlowDefinition<any, any, any>[]): void {
    for (const def of items) {
      register(def);
    }
  }

  function has(name: string): boolean {
    return defs.has(name);
  }

  function get(name: string): FlowDefinition {
    const def = defs.get(name);

    if (!def) {
      throw new FatalError(
        `[FlowRegistry] Flow definition not registered: ${name}`,
      );
    }

    return def;
  }

  function list(): FlowDefinitionInfo[] {
    return [...defs.values()].map((def) => ({
      name: def.name,
      description: def.description,
      slots: def.slots ?? {},
      config: def.config ? toJSONSchema(def.config) : undefined,
      payload: def.payload ? toJSONSchema(def.payload) : undefined,
    }));
  }

  return {
    register,
    registerAll,
    has,
    get,
    list,
  };
}

function toJSONSchema(schema: z.ZodType): unknown {
  try {
    return z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
  } catch {
    return undefined;
  }
}

export type FlowRegistry = ReturnType<typeof createFlowRegistry>;
