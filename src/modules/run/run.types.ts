export type RunStatus =
  | 'blocked'
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed';

export type RunTrigger = 'schedule' | 'manual';

export interface Run {
  id: string;
  status: RunStatus;
  trigger: RunTrigger;
  attempt: number;

  flow_id: string | null;
  def: string;
  parent_run: string | null;

  payload: Record<string, unknown>;
  output: unknown | null;
  error: string | null;

  scheduled_at: Date;
  available_at: Date;

  started_at: Date | null;
  heartbeat_at: Date | null;
  completed_at: Date | null;

  created_at: Date;
}

export type RunWithFlow = Run & { flow: string | null };

export interface CreateRunInput {
  status: 'blocked' | 'pending';
  trigger: RunTrigger;

  flow_id: string;
  def: string;

  payload?: Record<string, unknown>;

  scheduled_at: Date;
  available_at?: Date;
}

export interface UpdateRunInput {
  status?: RunStatus;
  attempt?: number;

  parent_run?: string | null;

  error?: string | null;

  available_at?: Date;
  started_at?: Date | null;
  heartbeat_at?: Date | null;
  completed_at?: Date | null;
}

export interface ListRunsInput {
  flow_id?: string;
  status?: RunStatus;
  limit?: number;
  before?: Date;
}

export interface Runner {
  /**
   * Runs `fn` once per run. The JSON output is persisted, so on retry or
   * crash recovery a completed step returns its stored output instead of
   * running again. Names must be unique within a run.
   */
  step<T>(name: string, fn: () => Promise<T> | T): Promise<T>;
}
