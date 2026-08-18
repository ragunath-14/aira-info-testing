-- =============================================================================
-- 0010_connections — the central Connection Manager (spec sections 3, 23).
--
-- Replaces the `providers` table created by 0003, which no code ever read. It is
-- dropped rather than migrated because it never held a row in any environment.
--
-- Design notes:
--
--  * `configuration` holds NON-SECRET settings only: URLs, ports, hosts, TLS
--    modes. Anything secret goes in `credential_cipher` as an AES-256-GCM
--    envelope bound to this row's id, or in `credential_ref` when an external
--    secret manager owns it (rule 7).
--  * `database_connections` is left alone. PostgreSQL targets carry write policy
--    no other connection type has (read-only override, write windows, query
--    history), so they keep their own table; the Connections UI lists both.
--  * There is deliberately no `ssh` type. Each system is reached over its own
--    native protocol (spec section 26).
-- =============================================================================

DROP VIEW IF EXISTS providers_public;
DROP TABLE IF EXISTS providers;

CREATE TYPE connection_type AS ENUM (
  'digitalocean',
  'proxmox',
  'postgres',
  'redis',
  'prometheus',
  'grafana'
);

CREATE TYPE connection_status AS ENUM (
  'connected',
  'degraded',
  'offline',
  -- A freshly imported connection that has not been probed yet. Never rendered
  -- as healthy.
  'not_tested'
);

CREATE TABLE connections (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name              TEXT NOT NULL,
  type              connection_type NOT NULL,
  environment       environment NOT NULL,
  description       TEXT,
  -- Non-secret settings; shape validated per type by @airaos/validation.
  configuration     JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Envelope-encrypted secret bundle: { v, iv, tag, ciphertext }.
  credential_cipher JSONB,
  -- Alternative when an external secret manager holds the value.
  credential_ref    TEXT,
  is_enabled        BOOLEAN NOT NULL DEFAULT TRUE,
  status            connection_status NOT NULL DEFAULT 'not_tested',
  last_checked_at   TIMESTAMPTZ,
  last_success_at   TIMESTAMPTZ,
  last_error_at     TIMESTAMPTZ,
  -- Sanitised message. Never contains credential material.
  last_error        TEXT,
  latency_ms        INTEGER,
  created_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- A connection must be usable. Prometheus and Grafana are commonly reachable
  -- without credentials on an internal network, so they may carry neither.
  CONSTRAINT connections_secret_present CHECK (
    credential_cipher IS NOT NULL
    OR credential_ref IS NOT NULL
    OR type IN ('prometheus', 'grafana')
  )
);

CREATE UNIQUE INDEX connections_name_idx ON connections (name);
CREATE INDEX connections_type_env_idx ON connections (type, environment);
CREATE INDEX connections_enabled_idx ON connections (is_enabled);

CREATE TRIGGER connections_updated_at BEFORE UPDATE ON connections
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Public projection: everything the UI needs, nothing that could leak a secret.
-- Read paths that feed an API response select from here.
CREATE OR REPLACE VIEW connections_public AS
SELECT
  id, name, type, environment, description, configuration, is_enabled, status,
  last_checked_at, last_success_at, last_error_at, last_error, latency_ms,
  created_by, created_at, updated_at,
  -- Lets the UI show whether a credential is stored without revealing it.
  (credential_cipher IS NOT NULL OR credential_ref IS NOT NULL) AS has_credential
FROM connections;

COMMENT ON TABLE connections IS
  'Central Connection Manager. Secrets live only in credential_cipher / credential_ref.';
COMMENT ON VIEW connections_public IS
  'Secret-free projection of connections. Use this for anything that reaches a client.';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'airaos_console_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON connections TO airaos_console_app;
    GRANT SELECT ON connections_public TO airaos_console_app;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'airaos_console_readonly') THEN
    -- The read-only role never sees the credential columns.
    GRANT SELECT ON connections_public TO airaos_console_readonly;
  END IF;
END
$$;
