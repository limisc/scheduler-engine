CREATE TABLE accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  provider text NOT NULL,
  name text NOT NULL,
  -- encrypted
  credential text NOT NULL,
  -- encrypted json
  config text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (provider, name)
);

-- flow instances; definitions live in code and are referenced by `def`
CREATE TABLE flows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  def text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,

  -- NULL means manual trigger only
  schedules jsonb,
  next_at timestamptz,

  config jsonb NOT NULL DEFAULT '{}'::jsonb,

  parent_flow uuid REFERENCES flows(id) ON DELETE SET NULL,
  freshness_seconds integer CHECK (freshness_seconds > 0),

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CHECK (parent_flow IS DISTINCT FROM id)
);

CREATE TABLE bindings (
  flow_id uuid NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  slot text NOT NULL,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,

  PRIMARY KEY (flow_id, slot)
);

CREATE TABLE runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL CHECK (
    status IN ('blocked', 'pending', 'running', 'completed', 'failed')
  ),
  trigger text NOT NULL CHECK (trigger IN ('schedule', 'manual')),
  attempt integer NOT NULL DEFAULT 1,

  flow_id uuid REFERENCES flows(id) ON DELETE SET NULL,
  def text NOT NULL,
  parent_run uuid REFERENCES runs(id) ON DELETE SET NULL,

  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  output jsonb,
  error text,

  -- logical time of the run, immutable
  scheduled_at timestamptz NOT NULL,
  -- when the run may be claimed, moved forward on retry
  available_at timestamptz NOT NULL,

  started_at timestamptz,
  heartbeat_at timestamptz,
  completed_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL CHECK (status IN ('running', 'completed', 'failed')),

  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  name text NOT NULL,
  attempt integer NOT NULL,

  output jsonb,
  error text,

  started_at timestamptz NOT NULL,
  completed_at timestamptz,

  UNIQUE (run_id, name)
);

-- listDue
CREATE INDEX idx_flows_due
  ON flows (next_at ASC NULLS FIRST)
  WHERE enabled AND schedules IS NOT NULL;

CREATE INDEX idx_flows_parent_flow
  ON flows (parent_flow)
  WHERE parent_flow IS NOT NULL;

CREATE INDEX idx_bindings_account_id
  ON bindings (account_id);

-- createBatch: a schedule occurrence is enqueued at most once
CREATE UNIQUE INDEX idx_runs_flow_schedule
  ON runs (flow_id, scheduled_at)
  WHERE trigger = 'schedule';

-- claim: an instance never runs concurrently
CREATE UNIQUE INDEX idx_runs_flow_running
  ON runs (flow_id)
  WHERE status = 'running';

-- claim
CREATE INDEX idx_runs_pending
  ON runs (available_at ASC)
  WHERE status = 'pending';

-- resolveBlocked
CREATE INDEX idx_runs_flow_lookup
  ON runs (flow_id, scheduled_at DESC, id DESC);

-- updateChildren, failChildren
CREATE INDEX idx_runs_parent_run
  ON runs (parent_run)
  WHERE status = 'blocked';

-- reap
CREATE INDEX idx_runs_heartbeat
  ON runs (heartbeat_at)
  WHERE status = 'running';

-- prune
CREATE INDEX idx_runs_completed_at
  ON runs (completed_at)
  WHERE status IN ('completed', 'failed');
