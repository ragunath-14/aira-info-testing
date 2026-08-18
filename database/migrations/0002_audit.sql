-- =============================================================================
-- 0002_audit — append-oriented audit trail (spec section 30).
--
-- Records are hash-chained: every row stores a HMAC over its own canonical
-- content plus the previous row's hash. Deleting or editing a row therefore
-- breaks verification, which /api/v1/audit/verify surfaces.
--
-- Ordinary application roles are granted INSERT and SELECT only; UPDATE and
-- DELETE are withheld at the grant level (see 0009_grants.sql).
-- =============================================================================

CREATE TYPE audit_result AS ENUM ('success', 'failure', 'denied');

CREATE TABLE audit_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Monotonic ordering for the hash chain. BIGSERIAL, never reused.
  sequence      BIGSERIAL UNIQUE,
  user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  -- Denormalised so audit history survives user deletion.
  user_email    CITEXT NOT NULL,
  user_roles    TEXT[] NOT NULL DEFAULT '{}',
  action        TEXT NOT NULL,
  resource_kind TEXT NOT NULL,
  resource_id   TEXT,
  resource_label TEXT,
  environment   environment,
  result        audit_result NOT NULL,
  error_code    TEXT,
  message       TEXT,
  ip_address    INET,
  user_agent    TEXT,
  request_id    TEXT NOT NULL,
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  previous_hash TEXT,
  record_hash   TEXT NOT NULL
);

CREATE INDEX audit_events_occurred_idx ON audit_events (occurred_at DESC);
CREATE INDEX audit_events_user_idx ON audit_events (user_id, occurred_at DESC);
CREATE INDEX audit_events_action_idx ON audit_events (action, occurred_at DESC);
CREATE INDEX audit_events_env_idx ON audit_events (environment, occurred_at DESC);
CREATE INDEX audit_events_resource_idx ON audit_events (resource_kind, resource_id);
CREATE INDEX audit_events_metadata_idx ON audit_events USING gin (metadata);

-- Belt-and-braces: block in-place mutation even for roles that hold UPDATE.
CREATE OR REPLACE FUNCTION audit_events_immutable() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only (attempted %)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();

CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();
