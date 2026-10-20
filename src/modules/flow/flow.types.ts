import type { z } from 'zod';
import type { Clients, Provider } from '../client/provider';
import type { Schedule } from '../../utils/time';
import type { Logger } from '../../utils/logger';
import type { Runner, RunTrigger } from '../run/run.types';

/** A flow instance (DB row). The definition it runs is `def`. */
export interface Flow {
  id: string;
  name: string;
  def: string;
  enabled: boolean;

  schedules: Schedule[] | null;
  next_at: Date | null;

  config: Record<string, unknown>;

  parent_flow: string | null;
  freshness_seconds: number | null;

  created_at: Date;
  updated_at: Date;
}

export interface CreateFlowInput {
  name: string;
  def: string;
  schedules?: Schedule[] | null;
  config?: Record<string, unknown>;
  /** Parent flow name. */
  parent?: string | null;
  freshness_seconds?: number | null;
  /** slot → account name */
  bindings?: Record<string, string>;
  enabled?: boolean;
}

export interface UpdateFlowInput {
  name?: string;
  schedules?: Schedule[] | null;
  config?: Record<string, unknown>;
  parent?: string | null;
  freshness_seconds?: number | null;
  enabled?: boolean;
}

export interface FlowPatch {
  name?: string;
  enabled?: boolean;
  schedules?: Schedule[] | null;
  next_at?: Date | null;
  config?: Record<string, unknown>;
  parent_flow?: string | null;
  freshness_seconds?: number | null;
}

export interface SyncInput {
  id: string;
  next_at: Date | null;
}

export interface Slot {
  provider: Provider;
  /** Keys that must be present in the bound account's config. */
  config?: readonly string[];
}

export type Slots = Record<string, Slot>;

export type FlowClients<S extends Slots> = {
  [K in keyof S]: Clients[S[K]['provider']];
};

export interface RunInfo {
  id: string;
  flow: string;
  attempt: number;
  trigger: RunTrigger;
  scheduledAt: Date;
}

export interface FlowContext<S extends Slots, C, P> {
  run: RunInfo;
  step: Runner['step'];
  clients: FlowClients<S>;
  config: C;
  payload: P;
  /** Aborted on shutdown or when the flow times out. */
  signal: AbortSignal;
  log: Logger;
}

export interface FlowDefinition<S extends Slots = Slots, C = any, P = any> {
  name: string;
  description?: string;
  slots?: S;
  /** Validates instance config. */
  config?: z.ZodType<C>;
  /** Validates manual trigger payloads. */
  payload?: z.ZodType<P>;
  /** Retries after the first attempt (default 2). */
  retries?: number;
  /** Per attempt, in ms (default 10 minutes). */
  timeout?: number;
  /** Missed occurrences to enqueue after downtime (default 'latest'). */
  catchUp?: 'latest' | 'all';
  run: (ctx: FlowContext<S, C, P>) => Promise<unknown>;
}

export interface FlowDefinitionInfo {
  name: string;
  description?: string;
  slots: Slots;
  config?: unknown;
  payload?: unknown;
}
