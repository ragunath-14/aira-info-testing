-- =============================================================================
-- 0004_applications_deployments — application registry, health history and
-- deployment records with a production approval gate.
-- =============================================================================

CREATE TYPE application_kind AS ENUM ('api', 'web', 'worker', 'service', 'cron');

CREATE TYPE health_state AS ENUM ('healthy', 'degraded', 'down', 'unknown');

CREATE TABLE applications (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key           TEXT NOT NULL,
  name          TEXT NOT NULL,
  kind          application_kind NOT NULL,
  environment   environment NOT NULL,
  host          TEXT,
  container_name TEXT,
  repository    TEXT,
  branch        TEXT,
  version       TEXT,
  commit_sha    TEXT,
  health_url    TEXT,
  port          INTEGER CHECK (port IS NULL OR (port BETWEEN 1 AND 65535)),
  depends_on    TEXT[] NOT NULL DEFAULT '{}',
  owner_team    TEXT,
  -- Restart / deploy controls are hidden entirely unless this is TRUE.
  operations_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One registry row per service per environment.
  UNIQUE (key, environment)
);

CREATE INDEX applications_env_idx ON applications (environment);

CREATE TRIGGER applications_updated_at BEFORE UPDATE ON applications
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Rolling health history. Trimmed by scripts/retention.ts; kept short because
-- Prometheus is the system of record for long-term series.
CREATE TABLE application_health_checks (
  id              BIGSERIAL PRIMARY KEY,
  application_id  UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  state           health_state NOT NULL,
  http_status     INTEGER,
  response_time_ms INTEGER,
  message         TEXT,
  dependencies    JSONB NOT NULL DEFAULT '[]'::jsonb,
  checked_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX application_health_checks_app_idx
  ON application_health_checks (application_id, checked_at DESC);

CREATE TYPE deployment_status AS ENUM (
  'pending',
  'awaiting_approval',
  'running',
  'succeeded',
  'failed',
  'rolled_back',
  'cancelled'
);

CREATE TABLE deployments (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  environment    environment NOT NULL,
  version        TEXT NOT NULL,
  commit_sha     TEXT NOT NULL,
  branch         TEXT,
  status         deployment_status NOT NULL DEFAULT 'pending',
  triggered_by   UUID NOT NULL REFERENCES users(id),
  -- Production deployments require a different user to approve; enforced in
  -- the service layer and asserted by the constraint below.
  approved_by    UUID REFERENCES users(id),
  approved_at    TIMESTAMPTZ,
  started_at     TIMESTAMPTZ,
  finished_at    TIMESTAMPTZ,
  ci_run_url     TEXT,
  rollback_of    UUID REFERENCES deployments(id),
  message        TEXT,
  logs           TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT deployments_approver_distinct CHECK (approved_by IS NULL OR approved_by <> triggered_by),
  CONSTRAINT deployments_finish_after_start CHECK (
    finished_at IS NULL OR started_at IS NULL OR finished_at >= started_at
  )
);

CREATE INDEX deployments_app_idx ON deployments (application_id, created_at DESC);
CREATE INDEX deployments_env_status_idx ON deployments (environment, status);

-- A production deployment may never be in flight without a recorded approver.
CREATE OR REPLACE FUNCTION deployments_production_gate() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.environment = 'production'
     AND NEW.status IN ('running', 'succeeded')
     AND NEW.approved_by IS NULL THEN
    RAISE EXCEPTION 'production deployment % requires a recorded approver', NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER deployments_production_gate_trg
  BEFORE INSERT OR UPDATE ON deployments
  FOR EACH ROW EXECUTE FUNCTION deployments_production_gate();
