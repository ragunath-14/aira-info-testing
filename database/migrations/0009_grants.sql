-- =============================================================================
-- 0009_grants — least-privilege database roles for the console itself.
--
-- The API connects as `airaos_console_app`, which can read and insert audit
-- events but cannot update or delete them, and cannot read stored credential
-- ciphertext columns it does not need. Migrations run as the owner role.
--
-- Adjust role names to match your provisioning if you do not use the defaults
-- from docker/compose. Idempotent: safe to re-run.
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'airaos_console_app') THEN
    -- No LOGIN password here: credentials are provisioned out of band.
    CREATE ROLE airaos_console_app NOLOGIN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'airaos_console_readonly') THEN
    CREATE ROLE airaos_console_readonly NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO airaos_console_app, airaos_console_readonly;

-- Application role: full DML on operational tables.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO airaos_console_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO airaos_console_app;

-- ...except the audit trail, which is append-and-read only (rule 6).
REVOKE UPDATE, DELETE, TRUNCATE ON audit_events FROM airaos_console_app;
GRANT SELECT, INSERT ON audit_events TO airaos_console_app;

-- Query history is likewise never rewritten after the fact.
REVOKE UPDATE, DELETE, TRUNCATE ON query_history FROM airaos_console_app;
GRANT SELECT, INSERT ON query_history TO airaos_console_app;

-- Read-only role for dashboards and break-glass inspection. Deliberately has
-- no access to the encrypted secret columns.
GRANT SELECT ON ALL TABLES IN SCHEMA public TO airaos_console_readonly;
REVOKE SELECT ON database_connections FROM airaos_console_readonly;
REVOKE SELECT ON providers FROM airaos_console_readonly;
REVOKE SELECT ON local_credentials FROM airaos_console_readonly;

-- Views exposing connection metadata without the credential columns.
CREATE OR REPLACE VIEW database_connections_public AS
SELECT
  id, name, environment, provider, host, port, database, username, ssl_mode,
  description, read_only_override, created_at, updated_at
FROM database_connections;

CREATE OR REPLACE VIEW providers_public AS
SELECT
  id, kind, name, settings, is_enabled, last_success_at, last_error_at,
  last_error_code, created_at, updated_at
FROM providers;

GRANT SELECT ON database_connections_public, providers_public
  TO airaos_console_app, airaos_console_readonly;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO airaos_console_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO airaos_console_readonly;
