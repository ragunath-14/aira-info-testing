-- =============================================================================
-- 0008_logs — log ingest buffer.
--
-- The console is not a log warehouse: Loki / the platform's log stack remains
-- the long-term store. This table holds a short retention window so the Logs
-- page works, and so deployment and operation logs stay attached to their
-- records. scripts/retention.ts trims it.
-- =============================================================================

CREATE TYPE log_level AS ENUM ('trace', 'debug', 'info', 'warn', 'error', 'fatal');

CREATE TYPE log_source_kind AS ENUM (
  'application',
  'container',
  'infrastructure',
  'deployment',
  'audit'
);

CREATE TABLE log_entries (
  id          BIGSERIAL PRIMARY KEY,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  level       log_level NOT NULL,
  kind        log_source_kind NOT NULL,
  environment environment NOT NULL,
  source      TEXT NOT NULL,
  -- Already passed through the redaction pass before insert.
  message     TEXT NOT NULL,
  fields      JSONB NOT NULL DEFAULT '{}'::jsonb,
  request_id  TEXT,
  deployment_id UUID REFERENCES deployments(id) ON DELETE CASCADE
);

CREATE INDEX log_entries_time_idx ON log_entries (occurred_at DESC);
CREATE INDEX log_entries_source_idx ON log_entries (source, occurred_at DESC);
CREATE INDEX log_entries_env_level_idx ON log_entries (environment, level, occurred_at DESC);
CREATE INDEX log_entries_deployment_idx ON log_entries (deployment_id)
  WHERE deployment_id IS NOT NULL;

-- Full-text search over the message body for the Logs page search box.
CREATE INDEX log_entries_message_trgm_idx ON log_entries
  USING gin (to_tsvector('simple', message));
