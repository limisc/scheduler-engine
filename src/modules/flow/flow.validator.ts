import type { Account } from '../account/account.types';
import type { FlowDefinition, Slot } from './flow.types';
import { z } from 'zod';
import { ValidationError } from '../../utils/error';

export function validateSlot(
  key: string,
  slot: Slot,
  account: Account | undefined,
): Account {
  if (!account) {
    throw new ValidationError(
      `Missing binding for slot "${key}" (requires provider: ${slot.provider})`,
    );
  }

  if (account.provider !== slot.provider) {
    throw new ValidationError(
      `Slot "${key}" requires provider "${slot.provider}", but bound account is "${account.provider}"`,
    );
  }

  const missing = getMissingConfig(account.config, slot.config);
  if (missing.length > 0) {
    throw new ValidationError(
      `Account "${account.name}" for slot "${key}" is missing config: ${missing.join(', ')}`,
    );
  }

  return account;
}

/** Throws unless every slot of `def` is bound to a suitable account. */
export function validateBindings(
  def: FlowDefinition,
  bound: Record<string, Account>,
): void {
  for (const [key, slot] of Object.entries(def.slots ?? {})) {
    validateSlot(key, slot, bound[key]);
  }
}

export function parseConfig(
  def: FlowDefinition,
  config: unknown,
): Record<string, unknown> {
  if (!def.config) return (config ?? {}) as Record<string, unknown>;
  return parse(def.config, config ?? {}, `config for "${def.name}"`);
}

export function parsePayload(
  def: FlowDefinition,
  payload: unknown,
): Record<string, unknown> {
  if (!def.payload) return (payload ?? {}) as Record<string, unknown>;
  return parse(def.payload, payload ?? {}, `payload for "${def.name}"`);
}

export function parse<T extends z.ZodType>(
  schema: T,
  value: unknown,
  label: string,
): z.output<T> {
  const result = schema.safeParse(value);

  if (!result.success) {
    throw new ValidationError(
      `Invalid ${label}: ${z.prettifyError(result.error)}`,
      { cause: result.error },
    );
  }

  return result.data;
}

function getMissingConfig(
  assigned: Record<string, unknown> | null | undefined,
  declared: readonly string[] | undefined,
): string[] {
  if (!declared || declared.length === 0) return [];
  if (!assigned) return [...declared];

  return declared.filter((key) => {
    const v = assigned[key];
    return v == null || v === '';
  });
}
