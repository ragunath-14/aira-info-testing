-- =============================================================================
-- 0006_alerts_settings — alert acknowledgement state, operation records and
-- console settings.
--
-- Alertmanager remains the source of truth for whether an alert is firing. This
-- table only stores the human workflow layered on top: who owns it, when it was
-- acknowledged, and how it was resolved.
-- =============================================================================

CREATE TYPE alert_severity AS ENUM ('critical', 'warning', 'info');

CREATE TABLE alert_acknowledgements (
  fingerprint       TEXT PRIMARY KEY,
  alert_name        TEXT NOT NULL,
  severity          alert_severity NOT NULL,
  environment       environment,
  resource          TEXT,
  summary           TEXT,
  first_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  acknowledged_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  acknowledged_email CITEXT,
  acknowledged_at   TIMESTAMPTZ,
  note              TEXT,
  resolved_at       TIMESTAMPTZ,
  resolution_detail TEXT,
  labels            JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX alert_acknowledgements_ack_idx ON alert_acknowledgements (acknowledged_at DESC);
CREATE INDEX alert_acknowledgements_env_idx ON alert_acknowledgements (environment, severity);

CREATE TRIGGER alert_acknowledgements_updated_at BEFORE UPDATE ON alert_acknowledgements
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TYPE operation_status AS ENUM (
  'completed',
  'in_progress',
  'rejected',
  'failed',
  'awaiting_approval'
);

-- One row per attempted privileged operation, including rejected attempts.
-- Complements audit_events with provider-side correlation ids.
CREATE TABLE operation_records (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_key   TEXT NOT NULL,
  resource_kind   TEXT NOT NULL,
  resource_id     TEXT NOT NULL,
  resource_label  TEXT,
  environment     environment NOT NULL,
  requested_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  requested_email CITEXT NOT NULL,
  approved_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  status          operation_status NOT NULL,
  -- DigitalOcean action id, Proxmox UPID, CI run id, etc.
  provider_action_id TEXT,
  reason          TEXT,
  message         TEXT,
  audit_event_id  UUID,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ
);

CREATE INDEX operation_records_started_idx ON operation_records (started_at DESC);
CREATE INDEX operation_records_resource_idx ON operation_records (resource_kind, resource_id);

-- Operational policy only. Secrets are never stored here; the settings API
-- refuses keys that look like credentials.
CREATE TABLE console_settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  description TEXT,
  updated_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER console_settings_updated_at BEFORE UPDATE ON console_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
