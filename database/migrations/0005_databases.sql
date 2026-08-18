-- =============================================================================
-- 0005_databases — managed database connection registry, write-mode windows and
-- query history (spec sections 17, 22, 24).
-- =============================================================================

CREATE TYPE database_provider AS ENUM (
  'digitalocean_managed',
  'proxmox_vm',
  'self_hosted',
  'other'
);

CREATE TYPE ssl_mode AS ENUM ('disable', 'require', 'verify-ca', 'verify-full');

CREATE TABLE database_connections (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL UNIQUE,
  environment  environment NOT NULL,
  provider     database_provider NOT NULL,
  host         TEXT NOT NULL,
  port         INTEGER NOT NULL DEFAULT 5432 CHECK (port BETWEEN 1 AND 65535),
  database     TEXT NOT NULL,
  username     TEXT NOT NULL,
  -- Envelope-encrypted password: { v, iv, tag, ciphertext }. Never selected by
  -- any read path that feeds an API response.
  password_cipher JSONB,
  -- Alternative: a reference resolved from an external secret manager.
  password_ref TEXT,
  ssl_mode     ssl_mode NOT NULL DEFAULT 'require',
  description  TEXT,
  -- NULL means "derive from environment": production is read-only by default.
  -- TRUE forces read-only; FALSE permits write mode where RBAC also allows it.
  read_only_override BOOLEAN,
  created_by   UUID REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT database_connections_secret_present
    CHECK (password_cipher IS NOT NULL OR password_ref IS NOT NULL),
  -- Production must always be encrypted in transit.
  CONSTRAINT database_connections_prod_tls
    CHECK (environment <> 'production' OR ssl_mode <> 'disable')
);

CREATE INDEX database_connections_env_idx ON database_connections (environment);

CREATE TRIGGER database_connections_updated_at BEFORE UPDATE ON database_connections
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A time-boxed permission to run non-READ statements against one connection.
-- Rows are never deleted; expiry is by timestamp so the audit trail is intact.
CREATE TABLE database_write_windows (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id UUID NOT NULL REFERENCES database_connections(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason        TEXT NOT NULL,
  activated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ,
  audit_event_id UUID,
  CONSTRAINT database_write_windows_valid_range CHECK (expires_at > activated_at)
);

CREATE INDEX database_write_windows_lookup_idx
  ON database_write_windows (connection_id, user_id, expires_at DESC);

CREATE TYPE sql_classification AS ENUM ('READ', 'WRITE', 'DDL', 'DESTRUCTIVE', 'UNKNOWN');

CREATE TABLE query_history (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  user_email    CITEXT NOT NULL,
  connection_id UUID REFERENCES database_connections(id) ON DELETE SET NULL,
  connection_name TEXT NOT NULL,
  environment   environment NOT NULL,
  -- SHA-256 of the normalised statement. Lets us group repeats without keeping
  -- literal values around.
  query_hash    TEXT NOT NULL,
  -- Literal-stripped, length-capped preview for the history UI.
  query_preview TEXT NOT NULL,
  -- Full text is retained only for statements that changed data, because those
  -- need to be reconstructable during an incident.
  query_text    TEXT,
  classification sql_classification NOT NULL,
  success       BOOLEAN NOT NULL,
  error_code    TEXT,
  duration_ms   INTEGER,
  rows_returned INTEGER,
  rows_affected INTEGER,
  truncated     BOOLEAN NOT NULL DEFAULT FALSE,
  request_id    TEXT,
  executed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX query_history_user_idx ON query_history (user_id, executed_at DESC);
CREATE INDEX query_history_conn_idx ON query_history (connection_id, executed_at DESC);
CREATE INDEX query_history_class_idx ON query_history (classification, executed_at DESC);
CREATE INDEX query_history_hash_idx ON query_history (query_hash);
